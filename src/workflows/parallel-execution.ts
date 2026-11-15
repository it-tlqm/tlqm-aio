import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../security.js';
import type { HumanStep, WorkflowNode } from './contracts.js';
import type { ParallelSplit } from './execution-graph.js';

export type ExecutionScope = { tenant_id: string; id: string; round: number };
export type ExecutionCursor = { branchId: string | null; predecessors: string[] };
type Branch = { id: string; start: string; arrivals: string[] | null };
type SplitExecution = {
  id: string;
  split: string;
  join: string;
  parentBranchId: string | null;
  branches: Branch[];
};
type TerminalNode = Extract<WorkflowNode, { kind: 'end' }>;
type WorkEffect = { kind: 'task'; node: HumanStep; cursor: ExecutionCursor; traversed: string[] };
type ExecutionEffect =
  | WorkEffect
  | { kind: 'end'; node: TerminalNode; traversed: string[] }
  | { kind: 'open'; execution: SplitExecution; predecessors: string[] }
  | { kind: 'arrive'; executionId: string; branchId: string; predecessors: string[] }
  | { kind: 'join'; executionId: string; nodeId: string };

export async function activeBranch(db: Pool | PoolClient, run: ExecutionScope, branchId: string) {
  const result = await db.query<{
    execution_id: string;
    split_node_id: string;
    join_node_id: string;
    parent_branch_id: string | null;
    branch_count: number;
  }>(
    `SELECT e.id AS execution_id,e.split_node_id,e.join_node_id,e.parent_branch_id,e.branch_count
     FROM workflow_parallel_branches b JOIN workflow_parallel_executions e
      ON (e.tenant_id,e.run_id,e.round,e.id)=(b.tenant_id,b.run_id,b.round,b.execution_id)
     WHERE (b.tenant_id,b.run_id,b.round,b.id)=($1,$2,$3,$4)
      AND e.status='open' AND b.arrival_task_ids IS NULL`,
    [run.tenant_id, run.id, run.round, branchId],
  );
  return result.rows[0];
}

async function loadSplit(
  db: Pool | PoolClient,
  run: ExecutionScope,
  branchId: string,
): Promise<SplitExecution> {
  const group = await activeBranch(db, run, branchId);
  if (!group) throw new HttpError(409, 'WORKFLOW_TASK_CLOSED');
  const branches = (
    await db.query<Branch>(
      `SELECT id,start_node_id AS start,arrival_task_ids AS arrivals FROM workflow_parallel_branches
       WHERE (tenant_id,run_id,round,execution_id)=($1,$2,$3,$4) ORDER BY ordinal`,
      [run.tenant_id, run.id, run.round, group.execution_id],
    )
  ).rows;
  if (branches.length !== group.branch_count) throw new HttpError(409, 'WORKFLOW_PARALLEL_CHANGED');
  return {
    id: group.execution_id,
    split: group.split_node_id,
    join: group.join_node_id,
    parentBranchId: group.parent_branch_id,
    branches,
  };
}

function newSplit(node: ParallelSplit, parentBranchId: string | null): SplitExecution {
  return {
    id: randomUUID(),
    split: node.id,
    join: node.join,
    parentBranchId,
    branches: node.branches.map((start) => ({ id: randomUUID(), start, arrivals: null })),
  };
}

/** Builds the same list of transitions for preview and commit. Only commit persists it. */
export async function planExecution(
  db: Pool | PoolClient,
  run: ExecutionScope,
  from: string,
  cursor: ExecutionCursor,
  resolve: (from: string) => {
    step: Exclude<WorkflowNode, { kind: 'start' | 'condition' }>;
    traversed: string[];
  },
) {
  const effects: ExecutionEffect[] = [];
  const groupsByBranch = new Map<string, SplitExecution>();
  function remember(group: SplitExecution) {
    for (const branch of group.branches) groupsByBranch.set(branch.id, group);
  }
  async function visit(target: string, at: ExecutionCursor): Promise<void> {
    const { step, traversed } = resolve(target);
    if ('form' in step) {
      effects.push({ kind: 'task', node: step, cursor: at, traversed });
    } else if (step.kind === 'end') {
      if (at.branchId) throw new HttpError(409, 'WORKFLOW_PARALLEL_CHANGED');
      effects.push({ kind: 'end', node: step, traversed });
    } else if (step.kind === 'parallel') {
      const execution = newSplit(step, at.branchId);
      remember(execution);
      effects.push({ kind: 'open', execution, predecessors: at.predecessors });
      for (const branch of execution.branches)
        await visit(branch.start, { branchId: branch.id, predecessors: at.predecessors });
    } else {
      if (!at.branchId) throw new HttpError(409, 'WORKFLOW_PARALLEL_CHANGED');
      const execution = groupsByBranch.get(at.branchId) ?? (await loadSplit(db, run, at.branchId));
      remember(execution);
      const branch = execution.branches.find((item) => item.id === at.branchId);
      if (!branch || branch.arrivals !== null || execution.join !== step.id)
        throw new HttpError(409, 'WORKFLOW_PARALLEL_CHANGED');
      branch.arrivals = at.predecessors;
      effects.push({
        kind: 'arrive',
        executionId: execution.id,
        branchId: branch.id,
        predecessors: at.predecessors,
      });
      if (execution.branches.every((item) => item.arrivals !== null)) {
        effects.push({ kind: 'join', executionId: execution.id, nodeId: step.id });
        const predecessors = [...new Set(execution.branches.flatMap((item) => item.arrivals!))];
        await visit(step.next, { branchId: execution.parentBranchId, predecessors });
      }
    }
  }
  await visit(from, cursor);
  return effects;
}

export async function openSplit(
  db: PoolClient,
  run: ExecutionScope,
  execution: SplitExecution,
  predecessors: string[],
) {
  await db.query(
    `INSERT INTO workflow_parallel_executions(id,tenant_id,run_id,round,split_node_id,join_node_id,parent_branch_id,branch_count,opening_task_ids)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      execution.id,
      run.tenant_id,
      run.id,
      run.round,
      execution.split,
      execution.join,
      execution.parentBranchId,
      execution.branches.length,
      predecessors,
    ],
  );
  for (const [ordinal, branch] of execution.branches.entries())
    await db.query(
      `INSERT INTO workflow_parallel_branches(id,tenant_id,run_id,round,execution_id,ordinal,start_node_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [branch.id, run.tenant_id, run.id, run.round, execution.id, ordinal, branch.start],
    );
}

export async function arriveBranch(
  db: PoolClient,
  run: ExecutionScope,
  effect: Extract<ExecutionEffect, { kind: 'arrive' }>,
) {
  const updated = await db.query(
    `UPDATE workflow_parallel_branches SET arrival_task_ids=$6
     WHERE (tenant_id,run_id,round,id,execution_id)=($1,$2,$3,$4,$5) AND arrival_task_ids IS NULL`,
    [run.tenant_id, run.id, run.round, effect.branchId, effect.executionId, effect.predecessors],
  );
  if (updated.rowCount !== 1) throw new HttpError(409, 'WORKFLOW_PARALLEL_CHANGED');
}

export async function closeSplit(db: PoolClient, run: ExecutionScope, executionId: string) {
  const updated = await db.query(
    `UPDATE workflow_parallel_executions e SET status='joined'
     WHERE (e.tenant_id,e.run_id,e.round,e.id)=($1,$2,$3,$4) AND e.status='open'
      AND e.branch_count=(
       SELECT count(*) FROM workflow_parallel_branches b
       WHERE (b.tenant_id,b.run_id,b.round,b.execution_id)=(e.tenant_id,e.run_id,e.round,e.id)
        AND b.arrival_task_ids IS NOT NULL
      )`,
    [run.tenant_id, run.id, run.round, executionId],
  );
  if (updated.rowCount !== 1) throw new HttpError(409, 'WORKFLOW_PARALLEL_CHANGED');
}
