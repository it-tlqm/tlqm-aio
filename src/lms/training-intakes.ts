import {
  signTrainingIntake,
  trainingIntakeEnvelope,
  verifyTrainingIntake,
} from '../lms-intake-proof.js';
import type { TrainingIntakeEnvelope, TrainingIntakeReference } from '../lms-intake-proof.js';
import type { CourseActor } from './courses.js';
import { LmsError, lmsEnvironment } from './security.js';
import type { LmsConfig } from './security.js';
import type { D1Database } from './types.js';

const scope = `id=? AND tenant_id=? AND org_unit_id=? AND source_run_id=? AND source_version_id=?
  AND source_round=? AND recipient_account_id=? AND recipient_person_id=?`;
const keys = (ref: TrainingIntakeReference) =>
  [
    ref.id,
    ref.tenantId,
    ref.unitId,
    ref.runId,
    ref.versionId,
    ref.round,
    ref.accountId,
    ref.personId,
  ] as const;
const columns = `id,tenant_id AS tenantId,org_unit_id AS unitId,source_run_id AS runId,source_version_id AS versionId,
  source_round AS round,recipient_account_id AS accountId,recipient_person_id AS personId,batch_id AS batchId`;
type Row = Omit<TrainingIntakeReference, 'kind'> & { batchId: string | null };
type Draft = { id: string; unitId: string; title: string; summary?: string };

export async function trainingIntakeBackchannel(
  db: D1Database,
  config: LmsConfig,
  request: Request,
  raw: string,
) {
  const url = new URL(request.url);
  if (
    request.method !== 'POST' ||
    url.search ||
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    throw new LmsError(400, 'LMS_TRAINING_INTAKE_INVALID');
  const operation = url.pathname === '/api/integrations/workflow-intake' ? 'receive' : 'status';
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new LmsError(400, 'LMS_TRAINING_INTAKE_INVALID');
  }
  if (!trainingIntakeEnvelope(envelope)) throw new LmsError(400, 'LMS_TRAINING_INTAKE_INVALID');
  if (
    envelope.instanceId !== config.instanceId ||
    config.purpose !== 'tlqm-aio-lms-' + envelope.environment ||
    !(await verifyTrainingIntake(
      config.clientSecret,
      config.clientId,
      operation,
      envelope,
      request.headers.get('x-aio-service-proof') ?? '',
    ))
  )
    throw new LmsError(403, 'LMS_TRAINING_INTAKE_PROOF_REQUIRED');
  const ref = envelope.reference;
  if (operation === 'status') {
    const row = await db
      .prepare(
        `SELECT CASE WHEN batch_id IS NULL THEN 'draft' ELSE b.status END AS state
       FROM lms_training_intakes i LEFT JOIN lms_training_batches b ON (b.tenant_id,b.id)=(i.tenant_id,i.batch_id)
       WHERE i.id=? AND i.tenant_id=? AND i.org_unit_id=? AND i.source_run_id=? AND i.source_version_id=?
         AND i.source_round=? AND i.recipient_account_id=? AND i.recipient_person_id=?`,
      )
      .bind(...keys(ref))
      .first<{ state: 'draft' | 'active' | 'cancelled' }>();
    if (!row) throw new LmsError(404, 'LMS_TRAINING_INTAKE_NOT_FOUND');
    return { id: ref.id, state: row.state };
  }
  const eligible = `EXISTS(SELECT 1 FROM aio_account_links a JOIN employees e ON e.id=a.employee_id AND e.is_active=1
    JOIN aio_external_links x ON x.account_id=a.account_id AND x.issuer=? AND x.active=1
    WHERE (a.account_id,a.person_id,a.tenant_id)=(?,?,?) AND a.active=1 AND (e.credential_kind='sso-only' OR e.role='admin'))
    AND (SELECT enabled FROM aio_adapter_control WHERE id=1)=1`;
  const now = Date.now();
  const [, , exact, current] = await db.batch([
    db
      .prepare(
        `INSERT INTO lms_training_intakes(id,tenant_id,org_unit_id,source_run_id,source_version_id,source_round,
      recipient_account_id,recipient_person_id,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${eligible} ON CONFLICT DO NOTHING`,
      )
      .bind(...keys(ref), now, config.issuer, ref.accountId, ref.personId, ref.tenantId),
    db
      .prepare(
        `INSERT INTO aio_audit(event_id,occurred_at,subject_account_id,tenant_id,action,reason,request_id,details)
      SELECT ?,?,?,?,'training.workflow_intake_received','Approved Workflow request',?,?
      WHERE EXISTS(SELECT 1 FROM lms_training_intakes WHERE ${scope}) AND ${eligible}
      ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(
        'workflow-intake:' + ref.id,
        now,
        ref.accountId,
        ref.tenantId,
        ref.id,
        JSON.stringify({
          runId: ref.runId,
          versionId: ref.versionId,
          round: ref.round,
          unitId: ref.unitId,
        }),
        ...keys(ref),
        config.issuer,
        ref.accountId,
        ref.personId,
        ref.tenantId,
      ),
    db.prepare('SELECT id FROM lms_training_intakes WHERE ' + scope).bind(...keys(ref)),
    db
      .prepare('SELECT 1 AS eligible WHERE ' + eligible)
      .bind(config.issuer, ref.accountId, ref.personId, ref.tenantId),
  ]);
  if (!current?.results.length) throw new LmsError(403, 'LMS_TRAINING_INTAKE_RECIPIENT_DENIED');
  if (!exact?.results.length) throw new LmsError(409, 'LMS_TRAINING_INTAKE_CONFLICT');
  return { id: ref.id };
}

export async function fetchTrainingIntakeSource(
  config: LmsConfig,
  token: string,
  reference: TrainingIntakeReference,
): Promise<Draft> {
  const envelope: TrainingIntakeEnvelope = {
    instanceId: config.instanceId,
    environment: lmsEnvironment(config),
    reference,
  };
  let response: Response;
  try {
    response = await fetch(config.foundationUrl.replace(/\/authorize$/, '/training-intake'), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
        'x-aio-service-proof': await signTrainingIntake(
          config.clientSecret,
          config.clientId,
          'source',
          envelope,
          token,
        ),
      },
      body: JSON.stringify(envelope),
    });
  } catch {
    throw new LmsError(503, 'LMS_TRAINING_INTAKE_SOURCE_UNAVAILABLE');
  }
  if ([401, 403, 404, 409].includes(response.status)) {
    await response.body?.cancel();
    throw new LmsError(403, 'LMS_TRAINING_INTAKE_SOURCE_DENIED');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new LmsError(503, 'LMS_TRAINING_INTAKE_SOURCE_UNAVAILABLE');
  }
  const draft = (await response.json().catch(() => null)) as Draft | null;
  if (
    !draft ||
    draft.id !== reference.id ||
    draft.unitId !== reference.unitId ||
    typeof draft.title !== 'string' ||
    !draft.title.trim() ||
    draft.title.length > 500 ||
    (draft.summary !== undefined &&
      (typeof draft.summary !== 'string' || draft.summary.length > 4000))
  )
    throw new LmsError(503, 'LMS_TRAINING_INTAKE_SOURCE_UNAVAILABLE');
  return draft;
}

export class TrainingIntakeInbox {
  constructor(
    private db: D1Database,
    private source: (ref: TrainingIntakeReference) => Promise<Draft>,
  ) {}

  async list(actor: CourseActor) {
    const rows = (
      await this.db
        .prepare(
          `SELECT ${columns} FROM lms_training_intakes
      WHERE tenant_id=? AND recipient_account_id=? AND recipient_person_id=? AND batch_id IS NULL
      ORDER BY created_at DESC,id LIMIT 50`,
        )
        .bind(actor.link.tenant_id, actor.principal.accountId, actor.principal.personId)
        .all<Row>()
    ).results;
    const items: Draft[] = [];
    for (const { batchId: _, ...ref } of rows) {
      try {
        items.push(await this.source({ ...ref, kind: 'lms-training' }));
      } catch (error) {
        if (!(error instanceof LmsError) || error.code !== 'LMS_TRAINING_INTAKE_SOURCE_DENIED')
          throw error;
      }
    }
    return { items };
  }

  async reference(actor: CourseActor, id: string) {
    const row = await this.db
      .prepare(
        `SELECT ${columns} FROM lms_training_intakes
      WHERE id=? AND tenant_id=? AND recipient_account_id=? AND recipient_person_id=?`,
      )
      .bind(id, actor.link.tenant_id, actor.principal.accountId, actor.principal.personId)
      .first<Row>();
    if (!row) throw new LmsError(404, 'LMS_TRAINING_INTAKE_NOT_FOUND');
    return row;
  }

  async verifyPending({ batchId, ...ref }: Row) {
    if (batchId) throw new LmsError(409, 'LMS_TRAINING_INTAKE_APPLIED');
    await this.source({ ...ref, kind: 'lms-training' });
  }
}
