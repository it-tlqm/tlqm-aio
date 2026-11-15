import type { Pool, PoolClient } from 'pg';
import { workflowAllowed } from './access.js';
import type { WorkflowActor } from './access.js';
import type { Run } from './service.js';
import type { HumanStep, WorkflowSpec } from './contracts.js';

export type Follower = {
  id: string;
  accountId: string;
  personId: string;
  name: string;
  revision: number;
  active: boolean;
};

export const followerColumns =
  'id,account_id AS "accountId",person_id AS "personId",display_name AS name,revision,active';

export function canFollowInUnit(actor: WorkflowActor, run: Run) {
  return (
    !run.source_context &&
    workflowAllowed(actor, run.tenant_id, 'workflows:collaborate', run.org_unit_id) &&
    actor.units.some(
      (unit) => unit.tenantId === run.tenant_id && unit.orgUnitId === run.org_unit_id,
    )
  );
}

export async function activeFollower(
  db: Pool | PoolClient,
  actor: WorkflowActor,
  run: Run,
  taskId?: string,
) {
  if (!canFollowInUnit(actor, run)) return null;
  return (
    (
      await db.query<Follower>(
        'SELECT ' +
          followerColumns +
          ' FROM workflow_run_followers WHERE tenant_id=$1 AND run_id=$2 AND account_id=$3 AND person_id=$4 AND task_id IS NOT DISTINCT FROM $5::uuid AND active',
        [run.tenant_id, run.id, actor.accountId, actor.personId, taskId ?? null],
      )
    ).rows[0] ?? null
  );
}

/** Superseded attempts stay in the audit trail. A follower grant never follows a replacement attempt. */
export const liveRelatedTask = `t.round=r.round AND r.status<>'cancelled' AND t.status<>'cancelled'
  AND NOT EXISTS(SELECT 1 FROM workflow_task_supersessions s
    WHERE (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id))`;

export async function relatedSteps(db: Pool | PoolClient, actor: WorkflowActor, run: Run) {
  if (!canFollowInUnit(actor, run)) return [];
  return (
    await db.query<{ id: string; label: string; round: number; attempt: number; nodeId: string }>(
      `SELECT t.id,t.label,t.round,t.attempt,t.node_id AS "nodeId" FROM workflow_run_followers f
     JOIN workflow_runs r ON (r.tenant_id,r.id)=(f.tenant_id,f.run_id)
     JOIN workflow_tasks t ON (t.tenant_id,t.run_id,t.id)=(f.tenant_id,f.run_id,f.task_id)
     WHERE f.tenant_id=$1 AND f.run_id=$2 AND f.account_id=$3 AND f.person_id=$4 AND f.active
     AND t.round=$5 AND ${liveRelatedTask} ORDER BY t.created_at DESC,t.id DESC`,
      [run.tenant_id, run.id, actor.accountId, actor.personId, run.round],
    )
  ).rows;
}

/** A follower reads the projected forms and task history without receiving routing configuration. */
export function followerSpec(spec: WorkflowSpec): WorkflowSpec {
  return {
    schemaVersion: spec.schemaVersion,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    input: spec.input,
    audienceUnits: [],
    positions: {},
    nodes: spec.nodes
      .filter((node): node is HumanStep => 'form' in node)
      .map(({ id, label, kind, form, inputFields }) => ({
        id,
        label,
        kind,
        form,
        ...(inputFields && { inputFields }),
        assignee: '',
        next: '',
        dueHours: 0,
      })),
  };
}
