import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { FormValidationError } from '../src/forms/contracts.js';
import { HttpError } from '../src/security.js';
import type {
  WorkflowActor,
  WorkflowCommand,
  WorkflowPermission,
} from '../src/workflows/access.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { WorkflowsService } from '../src/workflows/service.js';
import {
  enqueueScheduledDrafts,
  nextScheduleOccurrence,
  parseSchedule,
  vietnamScheduleDate,
} from '../src/workflows/scheduled-requests.js';
import type { ScheduleTiming, WorkflowScheduleInput } from '../src/workflows/scheduled-requests.js';
import { workflowTemplate } from '../src/workflows/templates.js';

const runtime = await loadLocalConfig();
const config = await loadWorkflowsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 5 });
const owner = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true, true), max: 1 });
const tenant = randomUUID(),
  unit = randomUUID(),
  otherUnit = randomUUID(),
  otherTenant = randomUUID();
function actor(
  permissions: WorkflowPermission[],
  tenantId = tenant,
  orgUnitId = unit,
): WorkflowActor {
  return {
    appCode: 'aio-workflows',
    accountId: randomUUID(),
    personId: randomUUID(),
    displayName: 'Người thử lịch',
    tenantIds: [tenantId],
    units: [{ tenantId, orgUnitId }],
    permissions: permissions.map((permission) => ({ tenantId, orgUnitId, permission })),
  };
}
const publisher = actor(['workflows:design', 'workflows:publish']),
  recipient = actor(['workflows:start']),
  reviewer = actor(['workflows:act']),
  outside = actor(['workflows:publish'], tenant, otherUnit),
  unrelated = actor(['workflows:publish'], otherTenant),
  another = actor(['workflows:start']);
let recipientActive = true;
const service = new WorkflowsService(pool, {
  async linkRecipient(t, accountId) {
    return t === tenant && recipientActive && accountId === recipient.accountId
      ? structuredClone(recipient)
      : null;
  },
  async validateUnit(t, u) {
    if (t !== tenant || u !== unit) throw new HttpError(403, 'WORKFLOW_REFERENCE_DENIED');
  },
  async assignee(t, u, accountId) {
    if (t !== tenant || u !== unit || accountId !== reviewer.accountId)
      throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
    return { personId: reviewer.personId, name: 'Người duyệt lịch' };
  },
});
const context = (a: WorkflowActor): WorkflowCommand => ({
  tenantId: a.tenantIds[0]!,
  actor: async () => structuredClone(a),
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
  reason: 'Nghiệm thu tạo nháp theo lịch',
});
const errorCode = (code: string) => (error: unknown) =>
  error instanceof HttpError && error.code === code;

before(async () =>
  assert.deepEqual((await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-workflows-test' },
  ]),
);
after(async () => {
  await pool.end();
  await owner.end();
});

test('The Vietnam schedule keeps its local time and date anchor across month-end, leap years, and downtime', () => {
  const monthly: ScheduleTiming = {
    cadence: 'monthly',
    every: 1,
    startDate: '2028-01-31',
    endDate: '2028-03-31',
    localTime: '08:15',
  };
  assert.equal(
    nextScheduleOccurrence(monthly, new Date('2028-02-04T00:00:00Z'))?.toISOString(),
    '2028-02-29T01:15:00.000Z',
  );
  assert.equal(
    nextScheduleOccurrence(monthly, new Date('2028-02-29T01:15:00.001Z'))?.toISOString(),
    '2028-03-31T01:15:00.000Z',
  );
  assert.equal(nextScheduleOccurrence(monthly, new Date('2028-03-31T01:15:00.001Z')), null);
  const yearly = { ...monthly, cadence: 'yearly' as const, startDate: '2028-02-29', endDate: null };
  assert.equal(
    nextScheduleOccurrence(yearly, new Date('2029-01-01T00:00:00Z'))?.toISOString(),
    '2029-02-28T01:15:00.000Z',
  );
  const biweekly = {
    cadence: 'weekly' as const,
    every: 2,
    startDate: '2026-11-01',
    localTime: '01:00',
  };
  const next = nextScheduleOccurrence(biweekly, new Date('2026-11-14T17:00:00Z'))!;
  assert.equal(next.toISOString(), '2026-11-14T18:00:00.000Z');
  assert.equal(vietnamScheduleDate(next), '2026-11-15');
  assert.equal(nextScheduleOccurrence({ ...biweekly, cadence: 'once', every: 1 }, next), null);
});

async function fixture() {
  const spec = workflowTemplate('leave');
  spec.audienceUnits = [unit];
  spec.input.sections[0]!.fields[0]!.required = true;
  for (const node of spec.nodes) if ('assignee' in node) node.assignee = reviewer.accountId;
  const code = 'schedule-' + randomUUID().slice(0, 8);
  const d = await service.saveDefinition(context(publisher), { code, orgUnitId: unit, spec });
  const v = await service.publish(context(publisher), d.id, d.revision);
  const now = (await pool.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
  const date = (days: number) => vietnamScheduleDate(new Date(now.getTime() + days * 86400000));
  const payload: WorkflowScheduleInput = {
    title: 'Nháp tổng hợp lịch',
    definitionId: d.id,
    versionId: v.version.id,
    unitId: unit,
    recipientAccountId: recipient.accountId,
    cadence: 'daily',
    every: 1,
    startDate: date(1),
    localTime: '08:00',
  };
  const due = async (count = 1, template = payload) => {
    const id = randomUUID();
    const startDate = date(-count - 1),
      endDate = date(-2);
    const timing = { ...template, startDate, endDate };
    const next = nextScheduleOccurrence(timing, new Date(now.getTime() - (count + 2) * 86400000));
    assert(next);
    await owner.query(
      `INSERT INTO workflow_draft_schedules(id,tenant_id,org_unit_id,definition_id,version_id,
      title,recipient_account_id,recipient_person_id,cadence,every,start_date,end_date,local_time,next_run_at,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'daily',1,$9,$10,$11,$12,$13)`,
      [
        id,
        tenant,
        unit,
        d.id,
        template.versionId,
        template.title,
        recipient.accountId,
        recipient.personId,
        startDate,
        endDate,
        timing.localTime,
        next,
        publisher.accountId,
      ],
    );
    return id;
  };
  return { payload, d, v, due, code, spec };
}
const readJobs = async (id: string) =>
  (
    await pool.query(
      'SELECT id,status,attempts,error_code,target_request_id,scheduled_for FROM workflow_scheduled_draft_jobs WHERE (tenant_id,schedule_id)=($1,$2) ORDER BY scheduled_for',
      [tenant, id],
    )
  ).rows;

test('Publish scope, existing version, recipient membership, CAS and idempotency apply to a scheduled configuration', async () => {
  const { payload } = await fixture();
  assert.throws(
    () => parseSchedule({ ...payload, localTime: '24:01' }),
    errorCode('WORKFLOW_SCHEDULE_INVALID'),
  );
  await assert.rejects(
    service.createDraftSchedule(context(outside), payload),
    errorCode('WORKFLOW_PERMISSION_DENIED'),
  );
  await assert.rejects(
    service.createDraftSchedule(context(publisher), {
      ...payload,
      recipientAccountId: another.accountId,
    }),
    errorCode('WORKFLOW_SCHEDULE_RECIPIENT_UNAVAILABLE'),
  );
  const c = context(publisher);
  const created = await service.createDraftSchedule(c, payload);
  assert.deepEqual(await service.createDraftSchedule(c, payload), created);
  const row = (await service.draftSchedules(context(publisher))).items.find(
    (item) => item.id === created.id,
  );
  assert.equal(row.start_date, payload.startDate);
  assert.equal(row.version_id, payload.versionId);
  assert.deepEqual((await service.draftSchedules(context(outside))).items, []);
  await assert.rejects(
    service.draftScheduleJobs(context(unrelated), created.id),
    errorCode('WORKFLOW_NOT_FOUND'),
  );
  await assert.rejects(
    service.disableDraftSchedule(context(publisher), created.id, 9),
    errorCode('REVISION_CONFLICT'),
  );
  await service.disableDraftSchedule(context(publisher), created.id, 1);
  assert.equal(
    (await service.draftSchedules(context(publisher))).items.find((item) => item.id === created.id)
      .enabled,
    false,
  );
});

test('Missed occurrences survive a worker restart and concurrent processing creates one blank, privately owned draft per occurrence', async () => {
  const { payload, due } = await fixture();
  const id = await due(3);
  await enqueueScheduledDrafts(pool);
  assert.equal((await readJobs(id)).length, 3);
  assert((await readJobs(id)).every((job) => job.status === 'queued'));
  const restarted = new WorkflowsService(pool, service.directory);
  await Promise.all([service.processScheduledDrafts(), restarted.processScheduledDrafts()]);
  await restarted.processScheduledDrafts();
  const jobs = await readJobs(id);
  assert.equal(jobs.length, 3);
  assert(jobs.every((job) => job.status === 'done' && job.attempts === 1));
  assert.equal(new Set(jobs.map((job) => job.target_request_id)).size, 3);
  const requestId = jobs[0].target_request_id;
  const draft = await service.requestDraft(context(recipient), requestId);
  assert.equal(draft.request.version_id, payload.versionId);
  assert.deepEqual(draft.request.answers, {});
  assert.equal(
    draft.request.title,
    payload.title + ' · ' + vietnamScheduleDate(jobs[0].scheduled_for),
  );
  await assert.rejects(
    service.requestDraft(context(another), requestId),
    errorCode('WORKFLOW_PERMISSION_DENIED'),
  );
  await assert.rejects(
    service.submitRequest(context(recipient), requestId, draft.request.revision),
    FormValidationError,
  );
  const history = (await service.draftScheduleJobs(context(publisher), id)).items;
  assert(history.every((job) => job.history[0].status === 'done'));
  assert(history.every((job) => !Object.hasOwn(job, 'target_request_id')));
});

test('Scheduled jobs record revocation, disabled schedule and stale version, with scoped retry preserving attempt history', async () => {
  const { payload, due, v, code, spec } = await fixture();
  const revoked = await due();
  await enqueueScheduledDrafts(pool);
  recipientActive = false;
  try {
    await service.processScheduledDrafts();
  } finally {
    recipientActive = true;
  }
  const [failed] = await readJobs(revoked);
  assert.equal(failed.error_code, 'WORKFLOW_SCHEDULE_RECIPIENT_UNAVAILABLE');
  assert.equal(failed.target_request_id, null);
  await assert.rejects(
    service.retryDraftScheduleJob(context(outside), failed.id, 1),
    errorCode('WORKFLOW_PERMISSION_DENIED'),
  );
  await service.retryDraftScheduleJob(context(publisher), failed.id, 1);
  await service.processScheduledDrafts();
  assert.equal((await readJobs(revoked))[0].attempts, 2);
  assert.equal((await readJobs(revoked))[0].status, 'done');

  const disabled = await due(),
    stale = await due();
  await enqueueScheduledDrafts(pool);
  await service.disableDraftSchedule(context(publisher), disabled, 1);
  const edited = await service.saveDefinition(
    context(publisher),
    { code, orgUnitId: unit, spec: { ...spec, name: 'Lịch phiên bản mới' } },
    payload.definitionId,
    v.definition.revision,
  );
  await service.publish(context(publisher), payload.definitionId, edited.revision);
  await service.processScheduledDrafts();
  assert.equal((await readJobs(disabled))[0].error_code, 'WORKFLOW_SCHEDULE_DISABLED');
  assert.equal((await readJobs(stale))[0].error_code, 'WORKFLOW_VERSION_STALE');
});

test('A recipient revocation during execution rolls back both scheduled draft and audit', async () => {
  const { due } = await fixture();
  const id = await due();
  let checks = 0;
  const changed = new WorkflowsService(pool, {
    ...service.directory,
    async linkRecipient(t, accountId) {
      if (t !== tenant || accountId !== recipient.accountId) return null;
      return ++checks === 1 ? recipient : null;
    },
  });
  const before = (await service.requestDrafts(context(recipient))).items.length;
  await changed.processScheduledDrafts();
  const [job] = await readJobs(id);
  assert.equal(checks, 2);
  assert.equal(job.status, 'blocked');
  assert.equal(job.error_code, 'WORKFLOW_SCHEDULE_RECIPIENT_UNAVAILABLE');
  assert.equal(job.target_request_id, null);
  assert.equal((await service.requestDrafts(context(recipient))).items.length, before);
  const audit = await pool.query(
    "SELECT id FROM workflow_audit WHERE tenant_id=$1 AND action='request.scheduled_draft_created' AND details->>'jobId'=$2",
    [tenant, job.id],
  );
  assert.equal(audit.rowCount, 0);
});
