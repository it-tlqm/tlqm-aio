import type { Pool } from 'pg';
import type { OperationItem, OperationKind, OperationQuery } from './operations-options.js';

const sources = {
  link: {
    join: `FROM workflow_link_jobs j JOIN workflow_link_rules c ON (c.tenant_id,c.id)=(j.tenant_id,j.rule_id)
    JOIN workflow_definitions target ON (target.tenant_id,target.id)=(c.tenant_id,c.target_definition_id)`,
    definition: 'c.source_definition_id',
    version: 'c.source_version_id',
    targetUnit: 'target.org_unit_id',
    run: 'j.source_run_id',
    task: 'j.source_task_id',
    attempts: 'workflow_link_attempts',
  },
  schedule: {
    join: `FROM workflow_scheduled_draft_jobs j JOIN workflow_draft_schedules c ON (c.tenant_id,c.id)=(j.tenant_id,j.schedule_id)`,
    definition: 'c.definition_id',
    version: 'c.version_id',
    run: 'NULL::uuid',
    attempts: 'workflow_scheduled_draft_attempts',
  },
  email: {
    join: `FROM workflow_email_jobs j JOIN workflow_output_templates c ON (c.tenant_id,c.id)=(j.tenant_id,j.template_id)
    JOIN workflow_notifications n ON (n.tenant_id,n.id)=(j.tenant_id,j.notification_id)`,
    definition: 'c.definition_id',
    version: 'c.version_id',
    run: 'n.run_id',
    attempts: 'workflow_email_attempts',
  },
  intake: {
    join: `FROM workflow_intake_jobs j JOIN workflow_intake_rules c ON (c.tenant_id,c.id)=(j.tenant_id,j.rule_id)`,
    definition: 'c.definition_id',
    version: 'c.version_id',
    run: 'j.source_run_id',
    attempts: 'workflow_intake_attempts',
  },
} satisfies Record<
  OperationKind,
  {
    join: string;
    definition: string;
    version: string;
    run: string;
    attempts: string;
    task?: string;
    targetUnit?: string;
  }
>;

export type OperationRow = Omit<
  OperationItem,
  'canRetry' | 'history' | 'nextAttemptAt' | 'updatedAt'
> & {
  enabled: boolean;
  sourceTaskId: string | null;
  versionId: string;
  nextAttemptAt: Date | null;
  updatedAt: Date;
};

export async function operationRows(
  pool: Pool,
  tenant: string,
  scopes: (string | null)[],
  query: OperationQuery,
  cursor: string | null,
  exact = false,
) {
  const s = sources[query.kind];
  const overdue = `(j.status IN ('queued','retry') AND j.next_attempt_at<=now()-interval '120 seconds')`;
  const { rows } = await pool.query<OperationRow>(
    `WITH eligible AS (
    SELECT j.id,c.id AS "configurationId",c.org_unit_id AS "unitId",d.name AS "workflowName",v.version,
      j.status,j.attempts,j.error_code AS "errorCode",j.updated_at AS "updatedAt",j.created_at,
      CASE WHEN j.status IN ('queued','retry') THEN j.next_attempt_at END AS "nextAttemptAt",
      ${overdue} AS overdue,c.enabled,${s.run} AS "runId",${'task' in s ? s.task : 'NULL::uuid'} AS "sourceTaskId",v.id AS "versionId"
    ${s.join}
    JOIN workflow_definitions d ON (d.tenant_id,d.id)=(j.tenant_id,${s.definition})
    JOIN workflow_versions v ON (v.tenant_id,v.definition_id,v.id)=(d.tenant_id,d.id,${s.version})
    WHERE j.tenant_id=$1 AND ($2::boolean OR (c.org_unit_id=ANY($3::uuid[]) AND d.org_unit_id=ANY($3::uuid[])
      ${'targetUnit' in s ? `AND ${s.targetUnit}=ANY($3::uuid[])` : ''}))
      AND ($4::uuid IS NULL OR ${s.run}=$4)
      AND CASE $5::text WHEN 'attention' THEN j.status='blocked' OR ${overdue}
        WHEN 'active' THEN j.status IN ('queued','retry') ELSE j.status IN ('done','skipped') END
  ) SELECT * FROM eligible e WHERE CASE WHEN $7 THEN e.id=$6 ELSE
    ($6::uuid IS NULL OR (e.created_at,e.id)<(SELECT created_at,id FROM eligible WHERE id=$6)) END
  ORDER BY e.created_at DESC,e.id DESC LIMIT 51`,
    [
      tenant,
      scopes.includes(null),
      scopes.filter(Boolean),
      query.runId ?? null,
      query.view,
      cursor,
      exact,
    ],
  );
  return rows;
}

export async function operationHistory(
  pool: Pool,
  tenant: string,
  kind: OperationKind,
  ids: string[],
) {
  if (!ids.length) return new Map<string, OperationItem['history']>();
  const { rows } = await pool.query<{ id: string; entries: OperationItem['history'] }>(
    `SELECT jobs.id, history.entries
    FROM unnest($2::uuid[]) AS jobs(id) CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('attempt',a.attempt,'status',a.status,'errorCode',a.error_code,'recordedAt',a.recorded_at)
        ORDER BY a.attempt DESC) AS entries FROM (
        SELECT attempt,status,error_code,recorded_at FROM ${sources[kind].attempts}
        WHERE (tenant_id,job_id)=($1,jobs.id) ORDER BY attempt DESC LIMIT 10
      ) a
    ) history`,
    [tenant, ids],
  );
  return new Map(rows.map(({ id, entries }) => [id, entries ?? []]));
}
