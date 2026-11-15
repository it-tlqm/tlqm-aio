import type { PoolClient } from 'pg';
import { HttpError } from '../security.js';
import type { WorkflowActor, WorkflowCommand } from './access.js';
export async function poolVote(
  db: PoolClient,
  c: WorkflowCommand,
  actor: WorkflowActor,
  task: { id: string; approval_policy: { required: number } },
  action: string,
  answers: unknown,
) {
  if (
    (
      await db.query(
        'SELECT 1 FROM workflow_approval_votes WHERE tenant_id=$1 AND task_id=$2 AND (account_id=$3 OR person_id=$4)',
        [c.tenantId, task.id, actor.accountId, actor.personId],
      )
    ).rowCount
  )
    throw new HttpError(409, 'WORKFLOW_ALREADY_VOTED');
  await db.query(
    'INSERT INTO workflow_approval_votes(tenant_id,task_id,account_id,person_id,action,answers,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      c.tenantId,
      task.id,
      actor.accountId,
      actor.personId,
      action,
      JSON.stringify(answers),
      c.reason,
    ],
  );
  const approved = (
    await db.query(
      "SELECT count(*)::integer AS count FROM workflow_approval_votes WHERE tenant_id=$1 AND task_id=$2 AND action='approve'",
      [c.tenantId, task.id],
    )
  ).rows[0].count;
  return { approved, complete: action !== 'approve' || approved >= task.approval_policy.required };
}
