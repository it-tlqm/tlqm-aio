import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl, assertLocalDatabase } from '../src/config.js';
import { Store } from '../src/store.js';
import type { Identity } from '../src/store.js';
import { ids } from '../src/fixtures.js';
import { DirectoryMetadata } from '../src/management/metadata.js';
import type { DirectoryConfiguration } from '../src/management/metadata.js';
import { ProfileWorkflows } from '../src/management/profile-workflows.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { WorkflowsService } from '../src/workflows/service.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import type { WorkflowSpec } from '../src/workflows/contracts.js';
import type {
  WorkflowActor,
  WorkflowCommand,
  WorkflowPermission,
} from '../src/workflows/access.js';
import type { MutationContext } from '../src/management/mutations.js';
import { HttpError } from '../src/security.js';
const runtime = await loadLocalConfig(),
  wfConfig = await loadWorkflowsConfig(runtime.instanceId),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 4 }),
  store = new Store(pool),
  metadata = new DirectoryMetadata(store),
  wfPool = new pg.Pool({ connectionString: workflowsDatabaseUrl(wfConfig, true), max: 4 }),
  wfOwner = new pg.Pool({ connectionString: workflowsDatabaseUrl(wfConfig, true, true), max: 1 });
const c = (subject: string = ids.admin, tenantId: string = ids.tenantA): MutationContext => ({
  identity: {
    issuer: runtime.issuer,
    subject,
    authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ['pwd', 'otp'],
  },
  appCode: 'aio-foundation',
  tenantId,
  reason: 'Kiểm thử liên kết hồ sơ giả lập',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
});
const admin = await store.principal(c().identity, 'aio-foundation'),
  learner = await store.principal(c(ids.learner).identity, 'aio-foundation');
const foundationOwnerUrl = new URL(runtime.databaseUrl);
foundationOwnerUrl.pathname = '/aio_foundation_test';
assertLocalDatabase(foundationOwnerUrl.href, true);
const foundationOwner = new pg.Pool({ connectionString: foundationOwnerUrl.href, max: 1 });
function actor(
  accountId: string,
  personId: string,
  permissions: WorkflowPermission[],
): WorkflowActor {
  return {
    appCode: 'aio-workflows',
    accountId,
    personId,
    tenantIds: [ids.tenantA],
    units: [{ tenantId: ids.tenantA, orgUnitId: ids.unitA }],
    permissions: permissions.map((permission) => ({
      tenantId: ids.tenantA,
      orgUnitId: null,
      permission,
    })),
  };
}
const requester = actor(admin.accountId, admin.personId, [
    'workflows:design',
    'workflows:publish',
    'workflows:start',
    'workflows:manage',
    'workflows:report',
  ]),
  reviewer = actor(randomUUID(), randomUUID(), ['workflows:act']),
  selfReviewer = actor(learner.accountId, learner.personId, ['workflows:act']);
let revoked = false;
const directory = {
  async validateUnit(tenant: string, unit: string) {
    if (tenant !== ids.tenantA || unit !== ids.unitA)
      throw new HttpError(400, 'WORKFLOW_REFERENCE_DENIED');
  },
  async assignee(tenant: string, unit: string | null, id: string) {
    const a = [reviewer, selfReviewer].find((a) => a.accountId === id);
    if (tenant !== ids.tenantA || (unit !== null && unit !== ids.unitA) || !a)
      throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
    return { personId: a.personId, name: a === reviewer ? 'Người duyệt độc lập' : 'Chủ hồ sơ' };
  },
};
const workflows = new WorkflowsService(wfPool, directory),
  bridge = new ProfileWorkflows(store, workflows, async (identity: Identity) => {
    if (revoked || identity.subject !== ids.admin)
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    return structuredClone(requester);
  });
const wc = (a = requester): WorkflowCommand => ({
  tenantId: ids.tenantA,
  actor: async () => structuredClone(a),
  reason: 'Kiểm thử quy trình hồ sơ',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
});
let original: DirectoryConfiguration, configuration: DirectoryConfiguration;
async function publish(config: DirectoryConfiguration) {
  const current = await metadata.configuration(admin, ids.tenantA, 'people');
  const draft = await metadata.saveConfiguration(
    c(),
    'people',
    config,
    Number(current.configuration?.revision ?? 0),
  );
  await metadata.publish(c(), 'people', Number(draft.revision));
}
async function closePending() {
  for (const p of (await metadata.proposals(learner, ids.tenantA, true)).items as Record<
    string,
    unknown
  >[])
    if (p.status === 'pending')
      await metadata.review(c(ids.learner), String(p.id), 'withdrawn', Number(p.revision));
}
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  assert.equal(
    (await wfPool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-workflows-test',
  );
  original = (
    await pool.query(
      "SELECT v.configuration FROM directory_schema_versions v JOIN directory_configurations c ON c.tenant_id=v.tenant_id AND c.resource=v.resource AND c.current_version=v.version WHERE v.tenant_id=$1 AND v.resource='people'",
      [ids.tenantA],
    )
  ).rows[0].configuration;
  configuration = structuredClone(original);
  if (!configuration.schema.sections.some((s) => s.fields.some((f) => f.id === 'bridge_value')))
    configuration.schema.sections[0]!.fields.push({
      id: 'bridge_value',
      type: 'shortText',
      label: 'Nơi làm việc đề xuất',
      required: false,
      maxLength: 100,
    });
  configuration.selfView = [...new Set([...configuration.selfView, 'bridge_value'])];
  configuration.selfEdit = [...new Set([...configuration.selfEdit, 'bridge_value'])];
  await closePending();
  await publish(configuration);
});
after(async () => {
  try {
    await closePending();
    if (original) await publish(original);
  } finally {
    await pool.end();
    await wfPool.end();
    await wfOwner.end();
    await foundationOwner.end();
  }
});
async function proposal() {
  await closePending();
  const record = await metadata.record(learner, ids.tenantA, 'people', learner.personId, true);
  return metadata.propose(
    c(ids.learner),
    { bridge_value: 'Cao Bằng ' + randomUUID().slice(0, 6) },
    record.revision,
    record.schemaVersion,
  );
}
async function template(who = reviewer, skip = false, redirectReject = false) {
  const spec = workflowTemplate('blank');
  spec.audienceUnits = [ids.unitA];
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Gửi hồ sơ', next: skip ? 'condition' : 'review' },
    {
      id: 'review',
      kind: 'approval',
      label: 'Duyệt thay đổi hồ sơ',
      assignee: who.accountId,
      dueHours: 24,
      next: 'end',
      form: null,
      ...(redirectReject && { rejectNext: 'review_again' }),
    },
    { id: 'end', kind: 'end', label: 'Hoàn thành' },
  ];
  if (redirectReject) {
    spec.schemaVersion = 5;
    spec.nodes.push({
      id: 'review_again',
      kind: 'approval',
      label: 'Duyệt sau khi chuyển hướng',
      assignee: reviewer.accountId,
      dueHours: 24,
      next: 'end',
      form: null,
    });
  }
  if (skip)
    spec.nodes.push({
      id: 'condition',
      kind: 'condition',
      label: 'Nhánh xét duyệt',
      condition: {
        schemaVersion: 1,
        logicalOperator: 'AND',
        rules: [{ fieldCode: 'purpose', operator: 'EQUALS', value: 'Phải duyệt' }],
      },
      yes: 'review',
      no: 'end',
    });
  return publishWorkflow(spec);
}
async function publishWorkflow(spec: WorkflowSpec) {
  const saved = await workflows.saveDefinition(wc(), {
    code: 'profile-' + randomUUID().slice(0, 8),
    orgUnitId: ids.unitA,
    spec,
  });
  return workflows.publish(wc(), saved.id, saved.revision);
}
async function send(
  p: Awaited<ReturnType<typeof proposal>>,
  t?: Awaited<ReturnType<typeof template>>,
) {
  t ??= await template();
  const command = c(),
    input = {
      expectedRevision: 1,
      definitionId: t.definition.id,
      versionId: t.version.id,
      unitId: ids.unitA,
      answers: { purpose: 'Xét cập nhật thông tin', requested_on: '2026-11-11' },
      selections: {},
    };
  return { result: await bridge.send(command, p.id, input), command, input };
}
async function approve(id: string) {
  const pending = (await workflows.detail(wc(), id)).tasks.find((t) => t.status === 'pending')!;
  return workflows.act(wc(reviewer), pending.id, {
    expectedRevision: pending.revision,
    action: 'approve',
    answers: {},
  });
}
test('profile dispatch is retryable, pins before/after values and cannot bypass independent workflow approval', async () => {
  const p = await proposal(),
    before = await metadata.record(admin, ids.tenantA, 'people', learner.personId),
    sent = await send(p);
  assert.deepEqual(await bridge.send(sent.command, p.id, sent.input), sent.result);
  assert.deepEqual(await bridge.retry(c(), p.id), sent.result);
  const link = (await bridge.link(c(), p.id))!,
    run = await workflows.sourceRun(wc(), link.source);
  assert.equal(run?.source_context?.changes[0]?.label, 'Nơi làm việc đề xuất');
  assert.equal(
    (
      await wfPool.query(
        "SELECT count(*)::integer AS count FROM workflow_runs WHERE tenant_id=$1 AND source_context->>'id'=$2",
        [ids.tenantA, link.id],
      )
    ).rows[0].count,
    1,
  );
  await assert.rejects(() => metadata.review(c(), p.id, 'approved', 1), {
    code: 'PROFILE_WORKFLOW_REQUIRED',
  });
  await assert.rejects(() => bridge.apply(c(), p.id, 1), { code: 'PROFILE_WORKFLOW_NOT_APPROVED' });
  await approve(sent.result.runId);
  assert.equal(
    (await metadata.record(admin, ids.tenantA, 'people', learner.personId)).revision,
    before.revision,
  );
  const apply = c(),
    result = await bridge.apply(apply, p.id, 1);
  assert.deepEqual(await bridge.apply(apply, p.id, 1), result);
  assert.equal(result.status, 'approved');
  assert.equal(
    (await metadata.record(admin, ids.tenantA, 'people', learner.personId)).revision,
    before.revision + 1,
  );
  assert.ok((await bridge.link(c(), p.id))!.applied_at);
});
test('profile owners cannot route/apply their own changes and source subject cannot be assigned to approve', async () => {
  const p = await proposal(),
    sent = await send(p),
    detail = await workflows.detail(wc(), sent.result.runId),
    task = detail.tasks.find((t) => t.status === 'pending')!;
  await assert.rejects(() => bridge.apply(c(ids.learner), p.id, 1), { code: 'PERMISSION_DENIED' });
  await assert.rejects(() => bridge.state(c(ids.other, ids.tenantB), p.id), {
    code: 'PERMISSION_DENIED',
  });
  await assert.rejects(
    () =>
      workflows.reassign(wc(), task.id, {
        expectedRevision: task.revision,
        accountId: learner.accountId,
      }),
    { code: 'WORKFLOW_SELF_APPROVAL' },
  );
  const bad = await proposal(),
    t = await template(selfReviewer);
  await assert.rejects(() => send(bad, t), { code: 'WORKFLOW_SOURCE_SELF_APPROVAL' });
  assert.equal((await bridge.state(c(), bad.id)).run, null);
});
test('A profile rejection remains a veto when a later approval completes the workflow', async () => {
  const p = await proposal();
  const record = await metadata.record(admin, ids.tenantA, 'people', learner.personId);
  const sent = await send(p, await template(reviewer, false, true));
  const task = (await workflows.detail(wc(), sent.result.runId)).tasks.find(
    (item) => item.status === 'pending',
  )!;
  const redirected = await workflows.act(wc(reviewer), task.id, {
    expectedRevision: task.revision,
    action: 'reject',
    answers: {},
  });
  assert.equal(redirected.current_step, 'review_again');
  assert.equal((await approve(sent.result.runId)).status, 'completed');
  const link = (await bridge.link(c(), p.id))!;
  assert.equal((await workflows.sourceRun(wc(), link.source))?.approvalCount, 0);
  await assert.rejects(() => bridge.apply(c(), p.id, 1), { code: 'PROFILE_WORKFLOW_NOT_APPROVED' });
  assert.equal(
    (await metadata.record(admin, ids.tenantA, 'people', learner.personId)).revision,
    record.revision,
  );
});
test('A superseded approval cannot apply a linked profile when the new route skips approval', async () => {
  const spec = workflowTemplate('blank');
  spec.schemaVersion = 5;
  spec.audienceUnits = [ids.unitA];
  const human = { assignee: reviewer.accountId, dueHours: 24, form: null };
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Gửi', next: 'triage' },
    {
      ...human,
      id: 'triage',
      kind: 'task',
      label: 'Soát đề nghị',
      next: 'branch',
      form: {
        schemaVersion: 1,
        title: 'Soát đề nghị',
        sections: [
          {
            id: 'choice',
            title: 'Soát đề nghị',
            fields: [
              { id: 'needs_review', label: 'Cần xét duyệt', type: 'boolean', required: true },
            ],
          },
        ],
      },
    },
    {
      id: 'branch',
      kind: 'condition',
      label: 'Cần duyệt?',
      yes: 'review',
      no: 'end',
      condition: {
        schemaVersion: 1,
        logicalOperator: 'AND',
        rules: [{ fieldCode: 'step.triage.needs_review', operator: 'EQUALS', value: true }],
      },
    },
    { ...human, id: 'review', kind: 'approval', label: 'Duyệt', next: 'verify' },
    { ...human, id: 'verify', kind: 'task', label: 'Đối soát', next: 'end', returnMode: 'choose' },
    { id: 'end', kind: 'end', label: 'Kết thúc' },
  ];
  const p = await proposal();
  const sent = await send(p, await publishWorkflow(spec));
  const runId = sent.result.runId;
  const pending = async () =>
    (await workflows.detail(wc(), runId)).tasks.find((t) => t.status === 'pending')!;
  const triage = await pending();
  await workflows.act(wc(reviewer), triage.id, {
    expectedRevision: triage.revision,
    action: 'complete',
    answers: { needs_review: true },
  });
  await approve(runId);
  const verify = await pending();
  await workflows.act(wc(reviewer), verify.id, {
    expectedRevision: verify.revision,
    action: 'return',
    returnTarget: triage.id,
    answers: {},
  });
  const replay = await pending();
  assert.equal(replay.attempt, 2);
  const result = await workflows.act(wc(reviewer), replay.id, {
    expectedRevision: replay.revision,
    action: 'complete',
    answers: { needs_review: false },
  });
  assert.equal(result.status, 'completed');
  const link = (await bridge.link(c(), p.id))!;
  assert.equal((await workflows.sourceRun(wc(), link.source))?.approvalCount, 0);
  await assert.rejects(() => bridge.apply(c(), p.id, 1), { code: 'PROFILE_WORKFLOW_NOT_APPROVED' });
});
test('linked snapshots/inputs are immutable and current source access is rechecked on retry and apply', async () => {
  const p = await proposal(),
    sent = await send(p),
    link = (await bridge.link(c(), p.id))!;
  await assert.rejects(
    () => workflows.sourceRun(wc(), { ...link.source, checksum: '0'.repeat(64) }),
    { code: 'PROFILE_WORKFLOW_MISMATCH' },
  );
  await assert.rejects(
    () =>
      wfOwner.query(
        "UPDATE workflow_runs SET source_context=jsonb_set(source_context,'{subjectName}','\"Changed\"') WHERE id=$1",
        [sent.result.runId],
      ),
    { code: '23514' },
  );
  await approve(sent.result.runId);
  revoked = true;
  try {
    await assert.rejects(() => bridge.apply(c(), p.id, 1), { code: 'WORKFLOW_PERMISSION_DENIED' });
    await assert.rejects(() => bridge.retry(c(), p.id), { code: 'WORKFLOW_PERMISSION_DENIED' });
  } finally {
    revoked = false;
  }
  assert.equal(
    (await metadata.record(admin, ids.tenantA, 'people', learner.personId)).revision,
    (await pool.query('SELECT base_revision FROM directory_profile_proposals WHERE id=$1', [p.id]))
      .rows[0].base_revision,
  );
});
test('completed paths with no actual approval cannot apply profile changes', async () => {
  const p = await proposal(),
    sent = await send(p, await template(reviewer, true));
  const state = await bridge.state(c(), p.id);
  assert.equal(state.run?.status, 'completed');
  assert.equal(state.canApply, false);
  await assert.rejects(() => bridge.apply(c(), p.id, 1), { code: 'PROFILE_WORKFLOW_NOT_APPROVED' });
  assert.ok(sent.result.runId);
});
test('record and schema conflicts after workflow approval prevent applying obsolete proposals', async () => {
  const p = await proposal(),
    sent = await send(p);
  await approve(sent.result.runId);
  const current = await metadata.record(admin, ids.tenantA, 'people', learner.personId);
  await metadata.save(
    c(),
    'people',
    learner.personId,
    { ...current.answers, bridge_value: 'HR đã cập nhật' },
    current.revision,
    current.schemaVersion,
  );
  await assert.rejects(() => bridge.apply(c(), p.id, 1), { code: 'REVISION_CONFLICT' });
  const second = await proposal(),
    next = await send(second);
  await approve(next.result.runId);
  await publish(configuration);
  await assert.rejects(() => bridge.apply(c(), second.id, 1), { code: 'PROFILE_SCHEMA_CHANGED' });
});
test('source failure rolls back workflow creation while prepared link retries exactly once after recovery', async () => {
  const p = await proposal(),
    t = await template();
  await wfOwner.query(
    "CREATE FUNCTION profile_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='run.started' AND NEW.details ? 'checksum' THEN RAISE EXCEPTION 'simulated audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER profile_test_audit_failure BEFORE INSERT ON workflow_audit FOR EACH ROW EXECUTE FUNCTION profile_test_audit_failure()",
  );
  try {
    await assert.rejects(() => send(p, t));
    assert.equal((await bridge.state(c(), p.id)).run, null);
  } finally {
    await wfOwner.query(
      'DROP TRIGGER profile_test_audit_failure ON workflow_audit; DROP FUNCTION profile_test_audit_failure()',
    );
  }
  const result = await bridge.retry(c(), p.id);
  assert.ok(result.runId);
  assert.deepEqual(await bridge.retry(c(), p.id), result);
  await metadata.review(c(ids.learner), p.id, 'withdrawn', 1);
  await approve(result.runId);
  assert.equal((await bridge.state(c(), p.id)).canApply, false);
  await assert.rejects(() => bridge.apply(c(), p.id, 1), { code: 'REVISION_CONFLICT' });
});

test('HR audit failure rolls back metadata, proposal, application link and receipt together', async () => {
  const p = await proposal(),
    sent = await send(p);
  await approve(sent.result.runId);
  const before = await metadata.record(admin, ids.tenantA, 'people', learner.personId),
    apply = c();
  await foundationOwner.query(
    "CREATE FUNCTION profile_apply_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='profile.approved' THEN RAISE EXCEPTION 'simulated profile audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER profile_apply_test_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION profile_apply_test_failure()",
  );
  try {
    await assert.rejects(() => bridge.apply(apply, p.id, 1));
    assert.equal(
      (await metadata.record(admin, ids.tenantA, 'people', learner.personId)).revision,
      before.revision,
    );
    assert.equal((await bridge.link(c(), p.id))!.applied_at, null);
    assert.equal(
      (await pool.query('SELECT status FROM directory_profile_proposals WHERE id=$1', [p.id]))
        .rows[0].status,
      'pending',
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM mutation_receipts WHERE idempotency_key=$1', [
          apply.idempotencyKey,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await foundationOwner.query(
      'DROP TRIGGER profile_apply_test_failure ON audit_events; DROP FUNCTION profile_apply_test_failure()',
    );
  }
  assert.equal((await bridge.apply(apply, p.id, 1)).status, 'approved');
  assert.equal(
    (await metadata.record(admin, ids.tenantA, 'people', learner.personId)).revision,
    before.revision + 1,
  );
});
