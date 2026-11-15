import type { Pool, PoolClient } from 'pg';
import { FormValidationError } from '../forms/contracts.js';
import { HttpError } from '../security.js';
import { queueKinds } from '../telemetry.js';
import type { QueueObservation } from '../telemetry.js';

type AutomationKind = 'link' | 'schedule' | 'email' | 'intake';
type AutomationJob = { id: string; tenant_id: string; attempts: number };
const tables = {
  link: {
    jobs: 'workflow_link_jobs',
    attempts: 'workflow_link_attempts',
    code: 'WORKFLOW_LINK',
    result: 'target_request_id',
  },
  schedule: {
    jobs: 'workflow_scheduled_draft_jobs',
    attempts: 'workflow_scheduled_draft_attempts',
    code: 'WORKFLOW_SCHEDULE',
    result: 'target_request_id',
  },
  email: {
    jobs: 'workflow_email_jobs',
    attempts: 'workflow_email_attempts',
    code: 'WORKFLOW_OUTPUT',
    result: 'delivery_id',
  },
  intake: {
    jobs: 'workflow_intake_jobs',
    attempts: 'workflow_intake_attempts',
    code: 'WORKFLOW_INTAKE',
    result: 'target_draft_id',
  },
} as const;

export async function observeDraftQueues(pool: Pool): Promise<QueueObservation[]> {
  const result = await pool.query<
    Pick<QueueObservation, 'queue' | 'due' | 'oldestDueMs' | 'blocked'>
  >(
    queueKinds
      .map(
        (kind) => `SELECT '${kind}' AS queue,
      count(*) FILTER (WHERE status IN ('queued','retry') AND next_attempt_at<=now())::int AS due,
      COALESCE(floor(EXTRACT(epoch FROM (now()-min(next_attempt_at)
        FILTER (WHERE status IN ('queued','retry') AND next_attempt_at<=now())))*1000),0)::float8 AS "oldestDueMs",
      count(*) FILTER (WHERE status='blocked')::int AS blocked FROM ${tables[kind].jobs}`,
      )
      .join(' UNION ALL '),
  );
  const at = Date.now();
  return result.rows.map((row) => ({ ...row, at, kind: 'queue', service: 'aio-workflows' }));
}

export async function inAutomationTransaction<T>(
  pool: Pool,
  tenant: string,
  apply: (db: PoolClient) => Promise<T>,
) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'aio-workflows:' + tenant,
    ]);
    const result = await apply(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function processDraftJobs<Job extends AutomationJob>(
  pool: Pool,
  kind: AutomationKind,
  create: (db: PoolClient, job: Job) => Promise<string | null>,
) {
  const { jobs, attempts, code, result: resultColumn } = tables[kind];
  const queued = (
    await pool.query<{ id: string; tenant_id: string }>(
      `SELECT id,tenant_id FROM ${jobs} WHERE status IN('queued','retry') AND next_attempt_at<=now()
     ORDER BY next_attempt_at,id LIMIT 20`,
    )
  ).rows;
  let processed = 0;
  for (const candidate of queued) {
    const applied = await inAutomationTransaction(pool, candidate.tenant_id, async (db) => {
      const job = (
        await db.query<Job>(
          `SELECT * FROM ${jobs} WHERE (tenant_id,id)=($1,$2)
         AND status IN('queued','retry') AND next_attempt_at<=now() FOR UPDATE`,
          [candidate.tenant_id, candidate.id],
        )
      ).rows[0];
      if (!job) return false;
      await db.query('SAVEPOINT automated_draft');
      let status: string,
        errorCode: string | null = null,
        requestId: string | null = null;
      try {
        requestId = await create(db, job);
        status = requestId ? 'done' : 'skipped';
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT automated_draft');
        const invalid = error instanceof FormValidationError;
        const transient = !invalid && (!(error instanceof HttpError) || error.statusCode >= 500);
        errorCode =
          error instanceof HttpError
            ? error.code
            : invalid
              ? kind === 'link'
                ? 'WORKFLOW_LINK_MAPPING_INVALID'
                : kind === 'schedule'
                  ? 'WORKFLOW_SCHEDULE_INPUT_INVALID'
                  : code + '_INVALID'
              : code + '_TEMPORARY_FAILURE';
        status = transient && job.attempts < 3 ? 'retry' : 'blocked';
      }
      const result = await db.query(
        `WITH changed AS (
           UPDATE ${jobs}
           SET status=$4,attempts=attempts+1,error_code=$5,${resultColumn}=$6,
             next_attempt_at=now()+$7::integer*interval '1 second',updated_at=now()
           WHERE (tenant_id,id,attempts)=($1,$2,$3) AND status IN('queued','retry') AND next_attempt_at<=now()
           RETURNING tenant_id,id,attempts,status,error_code
         )
         INSERT INTO ${attempts}(tenant_id,job_id,attempt,status,error_code)
         SELECT tenant_id,id,attempts,status,error_code FROM changed`,
        [
          job.tenant_id,
          job.id,
          job.attempts,
          status,
          errorCode,
          requestId,
          status === 'retry' ? 30 * 2 ** job.attempts : 0,
        ],
      );
      if (result.rowCount !== 1) throw new HttpError(409, code + '_JOB_CHANGED');
      return true;
    });
    if (applied) processed++;
  }
  return processed;
}
