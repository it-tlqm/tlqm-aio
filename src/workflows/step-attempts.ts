import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../security.js';
import type { Task } from './service.js';
import type { ExecutionScope } from './parallel-execution.js';

export type ExecutionTask = Task & { execution_order: string; due_at: Date | string };
type PriorAttempt = Pick<
  ExecutionTask,
  'id' | 'label' | 'node_id' | 'execution_order' | 'execution_branch_id'
>;

export async function priorAttempts(db: Pool | PoolClient, task: ExecutionTask, causal: boolean) {
  const ancestors = causal
    ? `WITH RECURSIVE ancestor(id) AS (
        SELECT $5::uuid UNION
        SELECT d.prerequisite_task_id FROM workflow_task_dependencies d JOIN ancestor a ON d.task_id=a.id
        WHERE (d.tenant_id,d.run_id,d.round)=($1,$2,$3)
       )`
    : '';
  return (
    await db.query<PriorAttempt>(
      `${ancestors}
       SELECT t.id,t.label,t.node_id,t.execution_order,t.execution_branch_id
       FROM workflow_tasks t
       WHERE t.tenant_id=$1 AND t.run_id=$2 AND t.round=$3 AND t.execution_order<$4::bigint
        AND t.status IN ('completed','rejected')
        ${causal ? 'AND t.id IN (SELECT id FROM ancestor)' : ''}
        AND NOT EXISTS (
         SELECT 1 FROM workflow_task_supersessions old
         WHERE (old.tenant_id,old.run_id,old.round,old.task_id)=(t.tenant_id,t.run_id,t.round,t.id)
        )
       ORDER BY t.execution_order DESC`,
      [task.tenant_id, task.run_id, task.round, task.execution_order, ...(causal ? [task.id] : [])],
    )
  ).rows;
}

export async function priorCursor(
  db: Pool | PoolClient,
  task: ExecutionTask,
  target: PriorAttempt,
) {
  const predecessors = (
    await db.query<{ prerequisite_task_id: string }>(
      `SELECT prerequisite_task_id FROM workflow_task_dependencies
       WHERE (tenant_id,run_id,round,task_id)=($1,$2,$3,$4)`,
      [task.tenant_id, task.run_id, task.round, target.id],
    )
  ).rows.map((row) => row.prerequisite_task_id);
  return { branchId: target.execution_branch_id ?? null, predecessors };
}

async function affectedAttempts(
  db: Pool | PoolClient,
  scope: readonly [string, string, number],
  target: PriorAttempt,
  causal: boolean,
) {
  const walk = causal
    ? `WITH RECURSIVE dependent(id) AS (
        SELECT $4::uuid UNION
        SELECT d.task_id FROM workflow_task_dependencies d JOIN dependent p ON d.prerequisite_task_id=p.id
        WHERE (d.tenant_id,d.run_id,d.round)=($1,$2,$3)
       )`
    : '';
  const range = causal ? 't.id IN (SELECT id FROM dependent)' : 't.execution_order >= $4::bigint';
  return (
    await db.query<{ id: string; status: string; decided: boolean }>(
      `${walk}
       SELECT t.id,t.status,(EXISTS (
        SELECT 1 FROM workflow_approval_votes v WHERE (v.tenant_id,v.task_id)=(t.tenant_id,t.id)
       ) OR EXISTS (
        SELECT 1 FROM workflow_task_results d WHERE (d.tenant_id,d.task_id)=(t.tenant_id,t.id)
       )) AS decided FROM workflow_tasks t
       WHERE (t.tenant_id,t.run_id,t.round)=($1,$2,$3) AND ${range}
        AND NOT EXISTS (
        SELECT 1 FROM workflow_task_supersessions s
        WHERE (s.tenant_id,s.run_id,s.round,s.task_id)=($1,$2,$3,t.id)
       )`,
      [...scope, causal ? target.id : target.execution_order],
    )
  ).rows;
}

export async function canRecallSubmission(db: Pool | PoolClient, run: ExecutionScope) {
  const result = await db.query<{ available: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM workflow_tasks t WHERE (t.tenant_id,t.run_id,t.round)=($1,$2,$3)
       AND t.status='pending'
     ) AND NOT EXISTS (
      SELECT 1 FROM workflow_tasks t WHERE (t.tenant_id,t.run_id,t.round)=($1,$2,$3)
       AND (EXISTS (SELECT 1 FROM workflow_task_results d WHERE (d.tenant_id,d.task_id)=(t.tenant_id,t.id))
        OR EXISTS (SELECT 1 FROM workflow_approval_votes v WHERE (v.tenant_id,v.task_id)=(t.tenant_id,t.id)))
     ) AS available`,
    [run.tenant_id, run.id, run.round],
  );
  return result.rows[0]!.available;
}

export async function recallableAttempts(
  db: Pool | PoolClient,
  run: ExecutionScope,
  source: ExecutionTask,
  causal: boolean,
) {
  if (source.round !== run.round || !['completed', 'rejected'].includes(source.status)) return null;
  const scope = [run.tenant_id, run.id, run.round] as const;
  const affected = await affectedAttempts(db, scope, source, causal);
  if (!affected.some((task) => task.id === source.id)) return null;
  const successors = affected.filter((task) => task.id !== source.id);
  if (
    (!successors.length && !source.execution_branch_id) ||
    successors.some((task) => task.status !== 'pending' || task.decided)
  )
    return null;
  return affected.map((task) => task.id);
}

async function replaceAttempts(
  db: PoolClient,
  scope: readonly [string, string, number],
  affected: string[],
  causeId: string,
  targetId: string | null,
  recallId: string | null,
) {
  await db.query(
    `UPDATE workflow_tasks SET status='cancelled',finished_at=now(),revision=revision+1
     WHERE (tenant_id,run_id,round)=($1,$2,$3) AND id=ANY($4::uuid[]) AND status='pending'`,
    [...scope, affected],
  );
  await db.query(
    `INSERT INTO workflow_task_supersessions(tenant_id,run_id,round,task_id,caused_by_task_id,target_task_id,recall_id)
     SELECT $1,$2,$3,unnest($4::uuid[]),$5,$6,$7`,
    [...scope, affected, causeId, targetId, recallId],
  );
  if (!targetId) return affected;
  await db.query(
    `UPDATE workflow_parallel_executions SET status='cancelled'
     WHERE (tenant_id,run_id,round)=($1,$2,$3) AND status<>'cancelled' AND opening_task_ids && $4::uuid[]`,
    [...scope, affected],
  );
  const reopened = (
    await db.query<{ execution_id: string }>(
      `UPDATE workflow_parallel_branches b SET arrival_task_ids=NULL
       FROM workflow_parallel_executions e
       WHERE (e.tenant_id,e.run_id,e.round,e.id)=(b.tenant_id,b.run_id,b.round,b.execution_id)
        AND (b.tenant_id,b.run_id,b.round)=($1,$2,$3) AND e.status<>'cancelled'
        AND b.arrival_task_ids && $4::uuid[] RETURNING b.execution_id`,
      [...scope, affected],
    )
  ).rows;
  if (reopened.length)
    await db.query(
      `UPDATE workflow_parallel_executions SET status='open'
       WHERE (tenant_id,run_id,round)=($1,$2,$3) AND id=ANY($4::uuid[]) AND status='joined'`,
      [...scope, reopened.map((row) => row.execution_id)],
    );
  return affected;
}

async function requireAttemptCapacity(db: PoolClient, scope: readonly [string, string, number]) {
  const returns = await db.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM workflow_task_supersessions
     WHERE tenant_id=$1 AND run_id=$2 AND round=$3 AND task_id=caused_by_task_id`,
    [...scope],
  );
  if (returns.rows[0]!.count >= 30) throw new HttpError(409, 'WORKFLOW_RETURN_LIMIT');
}

export async function supersedeRecall(
  db: PoolClient,
  source: ExecutionTask,
  affected: string[],
  causal: boolean,
  recallId: string,
) {
  const scope = [source.tenant_id, source.run_id, source.round] as const;
  await requireAttemptCapacity(db, scope);
  return replaceAttempts(db, scope, affected, source.id, causal ? source.id : null, recallId);
}

export async function supersedeAttempts(
  db: PoolClient,
  task: ExecutionTask,
  target: PriorAttempt,
  causal: boolean,
) {
  const scope = [task.tenant_id, task.run_id, task.round] as const;
  await requireAttemptCapacity(db, scope);
  if (causal) {
    const affected = (await affectedAttempts(db, scope, target, true)).map((row) => row.id);
    if (!affected.includes(task.id) || !affected.includes(target.id))
      throw new HttpError(409, 'WORKFLOW_RETURN_TARGET_CHANGED');
    return replaceAttempts(db, scope, affected, task.id, target.id, null);
  }
  return (
    await db.query<{ task_id: string }>(
      `INSERT INTO workflow_task_supersessions(tenant_id,run_id,round,task_id,caused_by_task_id)
       SELECT t.tenant_id,t.run_id,t.round,t.id,$4 FROM workflow_tasks t
       WHERE t.tenant_id=$1 AND t.run_id=$2 AND t.round=$3
        AND t.execution_order BETWEEN $5::bigint AND $6::bigint
        AND NOT EXISTS (
         SELECT 1 FROM workflow_task_supersessions old
         WHERE (old.tenant_id,old.run_id,old.round,old.task_id)=(t.tenant_id,t.run_id,t.round,t.id)
        )
       RETURNING task_id`,
      [
        task.tenant_id,
        task.run_id,
        task.round,
        task.id,
        target.execution_order,
        task.execution_order,
      ],
    )
  ).rows.map((row) => row.task_id);
}
