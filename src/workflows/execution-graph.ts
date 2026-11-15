import type { HumanStep, WorkflowNode } from './contracts.js';

export type ParallelSplit = {
  id: string;
  label: string;
  kind: 'parallel';
  branches: string[];
  join: string;
};
export type ParallelJoin = { id: string; label: string; kind: 'join'; next: string };
type Lane = { split: string; join: string; branch: number };

export function nextSteps(node: WorkflowNode): string[] {
  if (node.kind === 'end') return [];
  if (node.kind === 'condition') return [node.yes, node.no];
  if (node.kind === 'parallel') return node.branches;
  return node.kind === 'approval' && node.rejectNext ? [node.next, node.rejectNext] : [node.next];
}

class ParallelGraphIssue extends Error {
  constructor(
    readonly nodeId: string,
    readonly code: string,
  ) {
    super(code);
  }
}

function parallelScopes(nodes: WorkflowNode[], startId: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const scopes = new Map<string, readonly Lane[]>();
  const splitsByJoin = new Map<string, ParallelSplit>();
  for (const node of nodes) {
    if (node.kind !== 'parallel') continue;
    if (byId.get(node.join)?.kind !== 'join' || splitsByJoin.has(node.join))
      throw new ParallelGraphIssue(node.id, 'PARALLEL_JOIN_INVALID');
    if (node.branches.includes(node.join))
      throw new ParallelGraphIssue(node.id, 'PARALLEL_BRANCH_EMPTY');
    splitsByJoin.set(node.join, node);
  }
  function visit(id: string, incoming: readonly Lane[]) {
    const node = byId.get(id);
    if (!node) throw new ParallelGraphIssue(id, 'UNKNOWN_TARGET');
    let scope = incoming;
    if (node.kind === 'join') {
      if (incoming.at(-1)?.join !== node.id)
        throw new ParallelGraphIssue(node.id, 'PARALLEL_JOIN_UNEXPECTED');
      scope = incoming.slice(0, -1);
    }
    const visited = scopes.get(id);
    if (visited) {
      if (visited.length !== scope.length || visited.some((lane, index) => lane !== scope[index]))
        throw new ParallelGraphIssue(id, 'PARALLEL_BRANCH_CROSSES');
      return;
    }
    scopes.set(id, scope);
    if (node.kind === 'end' && scope.length)
      throw new ParallelGraphIssue(id, 'PARALLEL_BRANCH_MISSES_JOIN');
    if (node.kind === 'parallel') {
      node.branches.forEach((target, branch) =>
        visit(target, [...scope, { split: node.id, join: node.join, branch }]),
      );
    } else {
      for (const next of nextSteps(node)) visit(next, scope);
    }
  }
  visit(startId, []);
  return { scopes, splitsByJoin };
}

export function parallelGraphIssue(nodes: WorkflowNode[], startId: string) {
  try {
    parallelScopes(nodes, startId);
    return null;
  } catch (error) {
    if (error instanceof ParallelGraphIssue) return error;
    throw error;
  }
}

/** A condition admits any incoming path, while a join requires one path from every lane. */
export function guaranteedHumanSteps(nodes: WorkflowNode[], targetId: string): HumanStep[] {
  const start = nodes.find((node) => node.kind === 'start');
  if (!start) return [];
  let parallel: ReturnType<typeof parallelScopes> | undefined;
  if (nodes.some((node) => node.kind === 'parallel' || node.kind === 'join')) {
    try {
      parallel = parallelScopes(nodes, start.id);
    } catch (error) {
      if (error instanceof ParallelGraphIssue) return [];
      throw error;
    }
  }
  const incoming = new Map<string, string[]>();
  for (const node of nodes)
    for (const target of new Set(nextSteps(node))) {
      const sources = incoming.get(target) ?? [];
      sources.push(node.id);
      incoming.set(target, sources);
    }
  const reachable = (blocked?: string) => {
    const memo = new Map<string, boolean>();
    function reached(id: string): boolean {
      if (id === blocked) return false;
      if (id === start!.id) return true;
      if (memo.has(id)) return memo.get(id)!;
      // A designer can ask for suggestions before a draft is fully connected.
      memo.set(id, false);
      const sources = incoming.get(id) ?? [];
      const split = parallel?.splitsByJoin.get(id);
      const result = split
        ? split.branches.every((_, branch) =>
            sources.some((source) => {
              const lane = parallel!.scopes.get(source)?.at(-1);
              return lane?.split === split.id && lane.branch === branch && reached(source);
            }),
          )
        : sources.some(reached);
      memo.set(id, result);
      return result;
    }
    return reached(targetId);
  };
  if (!reachable()) return [];
  return nodes.filter(
    (node): node is HumanStep =>
      (node.kind === 'approval' || node.kind === 'task') &&
      node.id !== targetId &&
      !reachable(node.id),
  );
}
