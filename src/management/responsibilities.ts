import type { PoolClient } from 'pg';
import { HttpError } from '../security.js';

export type ResponsibilityEdge = {
  id: string;
  from: string;
  to: string;
  start: number;
  end: number;
};
/** A cycle exists only if every edge is effective at the same instant. */
export function assertResponsibilityGraph(
  edges: ResponsibilityEdge[],
  candidate: ResponsibilityEdge,
) {
  const pending = [
    { node: candidate.to, start: candidate.start, end: candidate.end, path: new Set<string>() },
  ];
  let steps = 0;
  while (pending.length) {
    if (++steps > 100000) throw new HttpError(400, 'RESPONSIBILITY_GRAPH_TOO_COMPLEX');
    const state = pending.pop()!;
    if (state.node === candidate.from) throw new HttpError(400, 'RESPONSIBILITY_CYCLE');
    if (state.path.has(state.node)) continue;
    const path = new Set([...state.path, state.node]);
    for (const edge of edges) {
      if (edge.id === candidate.id || edge.from !== state.node) continue;
      const start = Math.max(state.start, edge.start),
        end = Math.min(state.end, edge.end);
      if (start < end) pending.push({ node: edge.to, start, end, path });
    }
  }
}
export const responsibilityTables = {
  'reporting-lines': {
    table: 'reporting_lines',
    target: 'manager_employment_id',
    key: 'managerEmploymentId',
  },
  'unit-leaders': { table: 'unit_leaders', target: null, key: null },
  'approval-substitutions': {
    table: 'approval_substitutions',
    target: 'substitute_employment_id',
    key: 'substituteEmploymentId',
  },
} as const;
export async function validateResponsibility(
  db: PoolClient,
  resource: string,
  tenant: string,
  value: Record<string, unknown>,
) {
  const spec = responsibilityTables[resource as keyof typeof responsibilityTables];
  if (!spec) return;
  const start = new Date(String(value.valid_from)).getTime(),
    end = value.valid_until ? new Date(String(value.valid_until)).getTime() : Infinity;
  if (!Number.isFinite(start) || !(end > start))
    throw new HttpError(400, 'RESPONSIBILITY_INVALID_PERIOD');
  // Archiving must remain possible after a linked employment has ended.
  if (value.active === false) return;
  const ids = [value.employment_id, ...(spec.target ? [value[spec.target]] : [])];
  const records = (
    await db.query(
      'SELECT e.*,p.active AS person_active FROM employments e JOIN persons p ON p.id=e.person_id WHERE e.tenant_id=$1 AND e.legal_entity_id=$2 AND e.id=ANY($3::uuid[])',
      [tenant, value.legal_entity_id, ids],
    )
  ).rows;
  if (
    records.length !== ids.length ||
    records.some(
      (e) =>
        !e.person_active ||
        start < new Date(e.valid_from).getTime() ||
        (e.valid_until && end > new Date(e.valid_until).getTime()),
    )
  )
    throw new HttpError(400, 'RESPONSIBILITY_EMPLOYMENT_INVALID');
  if (spec.target && records[0].person_id === records[1].person_id)
    throw new HttpError(400, 'RESPONSIBILITY_SELF_REFERENCE');
  if (!spec.target) {
    if (
      !(
        await db.query(
          'SELECT 1 FROM org_units u JOIN legal_entities l ON l.id=u.legal_entity_id AND l.active WHERE u.id=$1 AND u.tenant_id=$2 AND u.legal_entity_id=$3 AND u.active',
          [value.org_unit_id, tenant, value.legal_entity_id],
        )
      ).rowCount
    )
      throw new HttpError(400, 'INVALID_RELATION');
    return;
  }
  const edges = (
    await db.query('SELECT * FROM ' + spec.table + ' WHERE tenant_id=$1 AND active', [tenant])
  ).rows.map((r) => ({
    id: r.id,
    from: r.employment_id,
    to: r[spec.target!],
    start: new Date(r.valid_from).getTime(),
    end: r.valid_until ? new Date(r.valid_until).getTime() : Infinity,
  }));
  assertResponsibilityGraph(edges, {
    id: String(value.id ?? ''),
    from: String(value.employment_id),
    to: String(value[spec.target]),
    start,
    end,
  });
}
