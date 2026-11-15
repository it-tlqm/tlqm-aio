import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { WorkflowsService } from '../src/workflows/service.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { HttpError } from '../src/security.js';
import type {
  WorkflowActor,
  WorkflowCommand,
  WorkflowPermission,
} from '../src/workflows/access.js';
const runtime = await loadLocalConfig(),
  config = await loadWorkflowsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 5 }),
  owner = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true, true), max: 1 });
const tenant = randomUUID(),
  otherTenant = randomUUID(),
  unitA = randomUUID(),
  unitC = randomUUID();
function actor(permissions: WorkflowPermission[], unit: string | null = unitA): WorkflowActor {
  return {
    appCode: 'aio-workflows',
    accountId: randomUUID(),
    personId: randomUUID(),
    tenantIds: [tenant],
    units: [{ tenantId: tenant, orgUnitId: unit ?? unitA }],
    permissions: permissions.map((permission) => ({
      tenantId: tenant,
      permission,
      orgUnitId: unit,
    })),
  };
}
const designer = actor(['workflows:design'], null),
  publisher = actor(['workflows:publish'], null),
  requester = actor(['workflows:start']),
  secondRequester = actor(['workflows:start'], unitC),
  handler = actor(['workflows:act']),
  finance = actor(['workflows:act'], null),
  manager = actor(['workflows:manage', 'workflows:report']),
  outsider = actor(['workflows:act'], unitC);
const candidates = new Map([handler, finance, requester].map((value) => [value.accountId, value]));
const service = new WorkflowsService(pool, {
  async validateUnit(t, unit) {
    if (t !== tenant || ![unitA, unitC].some((id) => id === unit))
      throw new HttpError(400, 'WORKFLOW_REFERENCE_DENIED');
  },
  async assignee(t, unit, id) {
    const value = candidates.get(id);
    if (
      t !== tenant ||
      !value ||
      !value.permissions.some(
        (p) => p.permission === 'workflows:act' && (p.orgUnitId === null || p.orgUnitId === unit),
      )
    )
      throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
    return { personId: value.personId, name: 'Người xử lý giả lập' };
  },
});
const context = (
  actor: WorkflowActor,
  overrides: Partial<WorkflowCommand> = {},
): WorkflowCommand => ({
  tenantId: tenant,
  actor: async () => structuredClone(actor),
  reason: 'Kiểm thử quy trình giả lập',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
  ...overrides,
});
const answers = (amount = 100) => ({ purpose: 'Dữ liệu giả lập', amount, needed_on: '2026-12-01' });
async function setup(unit = unitA) {
  const spec = workflowTemplate();
  spec.audienceUnits = [unit];
  for (const node of spec.nodes)
    if (node.kind === 'approval' || node.kind === 'task')
      node.assignee =
        node.id === 'review' && unit === unitA ? handler.accountId : finance.accountId;
  const definition = await service.saveDefinition(context(designer), {
    code: 'wf-' + randomUUID().slice(0, 8),
    orgUnitId: unit,
    spec,
  });
  return service.publish(context(publisher), definition.id, definition.revision);
}
async function start(set: Awaited<ReturnType<typeof setup>>, amount = 100, who = requester) {
  return service.start(context(who), {
    definitionId: set.definition.id,
    versionId: set.version.id,
    unitId: who.units[0]!.orgUnitId,
    title: 'Đề nghị giả lập',
    answers: answers(amount),
  });
}
const task = async (runId: string) => {
  const detail = await service.detail(context(requester), runId);
  return detail.tasks.find((row: { status: string }) => row.status === 'pending')!;
};
before(async () => {
  assert.deepEqual((await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-workflows-test' },
  ]);
});
after(async () => {
  await pool.end();
  await owner.end();
});
test('Workflow library batches version reads without exposing drafts or changing pinned latest versions and unit scope', async () => {
  const first = await setup(),
    other = await setup(unitC);
  const changed = structuredClone(first.version.spec);
  changed.name = 'Tên bản nháp chưa phát hành';
  const draft = await service.saveDefinition(
    context(designer),
    { code: first.definition.code, orgUnitId: unitA, spec: changed },
    first.definition.id,
    first.definition.revision,
  );
  const forRequester = (await service.definitions(context(requester))).items;
  const entry = forRequester.find((d) => d.id === first.definition.id)!;
  assert.equal(entry.draft, null);
  assert.equal(entry.name, first.version.spec.name);
  assert.equal(entry.version!.id, first.version.id);
  assert(!forRequester.some((d) => d.id === other.definition.id));
  const forDesigner = (await service.definitions(context(designer))).items.find(
    (d) => d.id === draft.id,
  )!;
  assert.equal(forDesigner.draft!.name, changed.name);
  assert.equal(forDesigner.version!.id, first.version.id);
  const second = await service.publish(context(publisher), draft.id, draft.revision);
  const updated = (await service.definitions(context(requester))).items.find(
    (d) => d.id === draft.id,
  )!;
  assert.equal(updated.version!.version, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(updated.version)), second.version);
  await assert.rejects(() => service.definitions(context(requester, { tenantId: otherTenant })), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
});
test('Workflows owner/runtime is isolated from Identity and Forms, with immutable version/audit/input histories', async () => {
  for (const database of ['aio_foundation', 'aio_foundation_test', 'aio_forms', 'aio_forms_test'])
    assert.equal(
      (
        await pool.query("SELECT has_database_privilege(current_user,$1,'CONNECT') AS allowed", [
          database,
        ])
      ).rows[0].allowed,
      false,
    );
  for (const sql of [
    'UPDATE workflow_versions SET checksum=checksum',
    'UPDATE workflow_run_inputs SET round=round',
    'DELETE FROM workflow_audit WHERE false',
    'UPDATE workflow_task_results SET action=action',
    'CREATE TABLE forbidden(id integer)',
  ])
    await assert.rejects(() => pool.query(sql), { code: '42501' });
  const set = await setup();
  await assert.rejects(
    () => owner.query('UPDATE workflow_versions SET spec=spec WHERE id=$1', [set.version.id]),
    { code: '42501' },
  );
});
test('Workflow version pinning, branch thresholds and step-specific form validation preserve published runs', async () => {
  const set = await setup(),
    low = await start(set),
    high = await start(set, 20000000);
  const draft = structuredClone(set.version.spec);
  draft.name = 'Phiên bản sau';
  draft.nodes.find((n) => n.kind === 'condition')!.condition.rules = [
    { fieldCode: 'amount', operator: 'GREATER_THAN_OR_EQUAL', value: 1 },
  ];
  const saved = await service.saveDefinition(
    context(designer),
    { code: set.definition.code, orgUnitId: unitA, spec: draft },
    set.definition.id,
    set.definition.revision,
  );
  await service.publish(context(publisher), saved.id, saved.revision);
  for (const run of [low, high]) {
    const pending = await task(run.id);
    await service.act(context(handler), pending.id, {
      expectedRevision: pending.revision,
      action: 'approve',
      answers: {},
    });
  }
  assert.equal((await task(low.id)).node_id, 'fulfil');
  assert.equal((await task(high.id)).node_id, 'director');
  const pending = await task(low.id);
  await assert.rejects(
    () =>
      service.act(context(finance), pending.id, {
        expectedRevision: pending.revision,
        action: 'complete',
        answers: {},
      }),
    { code: 'FORM_VALIDATION_FAILED' },
  );
  const completed = await service.act(context(finance), pending.id, {
    expectedRevision: pending.revision,
    action: 'complete',
    answers: { result_note: 'Đã hoàn tất giả lập' },
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.version_id, set.version.id);
  await assert.rejects(() => start(set), { code: 'WORKFLOW_VERSION_STALE' });
});
test('Workflows enforce app permission, assignee, unit/tenant and same-person self-approval boundaries', async () => {
  const set = await setup(),
    run = await start(set),
    pending = await task(run.id);
  await assert.rejects(
    () =>
      service.act(context(outsider), pending.id, {
        expectedRevision: 1,
        action: 'approve',
        answers: {},
      }),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  await assert.rejects(
    () =>
      service.act(context(finance), pending.id, {
        expectedRevision: 1,
        action: 'approve',
        answers: {},
      }),
    { code: 'WORKFLOW_NOT_ASSIGNED' },
  );
  await assert.rejects(() => service.detail(context(designer), run.id), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
  await assert.rejects(
    () =>
      service.detail(
        context({ ...requester, tenantIds: [otherTenant] }, { tenantId: otherTenant }),
        run.id,
      ),
    { code: 'WORKFLOW_NOT_FOUND' },
  );
  const savePerson = handler.personId;
  handler.personId = requester.personId;
  try {
    await assert.rejects(
      () =>
        service.act(context(handler), pending.id, {
          expectedRevision: 1,
          action: 'approve',
          answers: {},
        }),
      { code: 'WORKFLOW_SELF_APPROVAL' },
    );
  } finally {
    handler.personId = savePerson;
  }
  const other = await setup(unitC),
    otherRun = await start(other, 100, secondRequester);
  await assert.rejects(() => service.detail(context(manager), otherRun.id), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
  assert.equal(
    (await service.runs(context(handler), 'inbox')).items.some((row) => row.id === otherRun.id),
    false,
  );
  assert.equal(
    (await service.runs(context(requester), 'mine')).items.some((row) => row.id === otherRun.id),
    false,
  );
});
test('Workflow task commands are idempotent, serialized and cannot reuse a revoked permission snapshot', async () => {
  const run = await start(await setup()),
    pending = await task(run.id),
    request = context(handler),
    input = { expectedRevision: pending.revision, action: 'approve' as const, answers: {} };
  const results = await Promise.all([
    service.act(request, pending.id, input),
    service.act(request, pending.id, input),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer AS n FROM workflow_task_results WHERE task_id=$1',
        [pending.id],
      )
    ).rows[0].n,
    1,
  );
  const revoked = { ...handler, permissions: [] };
  await assert.rejects(
    () => service.act({ ...request, actor: async () => revoked }, pending.id, input),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  const second = await start(await setup()),
    next = await task(second.id);
  const races = await Promise.allSettled(
    ['approve', 'reject'].map((action) =>
      service.act(context(handler), next.id, {
        expectedRevision: next.revision,
        action: action as 'approve' | 'reject',
        answers: {},
      }),
    ),
  );
  assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1);
  const third = await start(await setup()),
    last = await task(third.id);
  let calls = 0;
  await assert.rejects(
    () =>
      service.act(
        context(handler, { actor: async () => (++calls === 1 ? handler : revoked) }),
        last.id,
        { expectedRevision: last.revision, action: 'approve', answers: {} },
      ),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  assert.equal((await task(third.id)).id, last.id);
});
test('Workflow return/resubmit creates a new round and retains snapshots, decisions and paused version contract', async () => {
  const set = await setup(),
    run = await start(set),
    pending = await task(run.id);
  const returned = await service.act(context(handler), pending.id, {
    expectedRevision: pending.revision,
    action: 'return',
    answers: {},
  });
  assert.equal(returned.status, 'needs_revision');
  await service.setStatus(context(publisher), set.definition.id, set.definition.revision, 'paused');
  await assert.rejects(() => start(set), { code: 'WORKFLOW_VERSION_STALE' });
  const resent = await service.resubmit(context(requester), run.id, {
    expectedRevision: returned.revision,
    answers: answers(20000000),
  });
  assert.equal(resent.round, 2);
  assert.equal(resent.version_id, set.version.id);
  const detail = await service.detail(context(requester), run.id);
  assert.equal(detail.inputs.length, 2);
  assert.equal(detail.inputs[0].inputs.amount, 100);
  assert.equal(detail.inputs[1].inputs.amount, 20000000);
  assert.ok(detail.tasks.some((row) => row.status === 'returned'));
  const current = await task(run.id);
  await assert.rejects(
    () =>
      service.act(context(handler), pending.id, {
        expectedRevision: pending.revision,
        action: 'approve',
        answers: {},
      }),
    { code: 'REVISION_CONFLICT' },
  );
  await service.act(context(handler), current.id, {
    expectedRevision: current.revision,
    action: 'reject',
    answers: {},
  });
  assert.equal((await service.detail(context(requester), run.id)).run.status, 'rejected');
});
test('Workflow reassignment and cancellation preserve history and remove former assignee authority', async () => {
  const run = await start(await setup()),
    pending = await task(run.id);
  const updated = await service.reassign(context(manager), pending.id, {
    expectedRevision: pending.revision,
    accountId: finance.accountId,
  });
  await assert.rejects(
    () =>
      service.act(context(handler), pending.id, {
        expectedRevision: updated.revision,
        action: 'approve',
        answers: {},
      }),
    { code: 'WORKFLOW_NOT_ASSIGNED' },
  );
  const result = await service.act(context(finance), pending.id, {
    expectedRevision: updated.revision,
    action: 'approve',
    answers: {},
  });
  const current = await task(run.id);
  const cancelled = await service.cancel(context(requester), run.id, result.revision);
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(
    () =>
      service.act(context(finance), current.id, {
        expectedRevision: current.revision,
        action: 'complete',
        answers: { result_note: 'Không được ghi' },
      }),
    { code: 'REVISION_CONFLICT' },
  );
  const detail = await service.detail(context(requester), run.id);
  assert.ok(detail.history.some((row) => row.action === 'task.reassigned'));
  assert.ok(detail.history.some((row) => row.action === 'run.cancelled'));
});
test('Workflow audit failure rolls back both decision and transition with no ghost next task', async () => {
  const run = await start(await setup()),
    pending = await task(run.id);
  const request = context(handler);
  await owner.query(
    `CREATE FUNCTION workflow_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${request.requestId}' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END; $$`,
  );
  await owner.query(
    'CREATE TRIGGER workflow_test_audit_failure BEFORE INSERT ON workflow_audit FOR EACH ROW EXECUTE FUNCTION workflow_test_audit_failure()',
  );
  try {
    await assert.rejects(() =>
      service.act(request, pending.id, {
        expectedRevision: pending.revision,
        action: 'approve',
        answers: {},
      }),
    );
  } finally {
    await owner.query('DROP TRIGGER workflow_test_audit_failure ON workflow_audit');
    await owner.query('DROP FUNCTION workflow_test_audit_failure()');
  }
  assert.equal((await task(run.id)).id, pending.id);
  assert.equal(
    (await pool.query('SELECT 1 FROM workflow_task_results WHERE task_id=$1', [pending.id]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query('SELECT 1 FROM workflow_receipts WHERE idempotency_key=$1', [
        request.idempotencyKey,
      ])
    ).rowCount,
    0,
  );
});

test('Version comparison and restore preserve published history and use current publishing controls', async () => {
  const original = await setup();
  const run = await start(original);
  const revised = structuredClone(original.version.spec);
  revised.name = 'Quy trình sau chỉnh sửa';
  revised.input.sections[0]!.fields.push({
    id: 'reference',
    label: 'Số chứng từ',
    type: 'shortText',
    required: false,
  });
  const reviewer = revised.nodes.find((node) => node.id === 'review');
  assert(reviewer?.kind === 'approval');
  reviewer.dueHours = 12;
  const draft = await service.saveDefinition(
    context(designer),
    { code: original.definition.code, orgUnitId: unitA, spec: revised },
    original.definition.id,
    original.definition.revision,
  );
  const second = await service.publish(context(publisher), draft.id, draft.revision);
  const history = await service.versionHistory(context(designer), draft.id);
  assert.equal(history.canPublish, false);
  assert.deepEqual(
    history.items.map(({ version }) => version),
    [2, 1],
  );
  const diff = await service.versionComparison(
    context(designer),
    draft.id,
    original.version.id,
    second.version.id,
  );
  assert.deepEqual(
    diff.changes.map(({ key, kind }) => [key, kind]),
    [
      ['name', 'changed'],
      ['steps/review', 'changed'],
      ['input/fields/reference', 'added'],
    ],
  );
  await assert.rejects(
    service.versionHistory(context(requester), draft.id),
    (error) => error instanceof HttpError && error.code === 'WORKFLOW_PERMISSION_DENIED',
  );
  await assert.rejects(
    service.versionHistory(context(actor(['workflows:design'], unitC)), draft.id),
    (error) => error instanceof HttpError && error.code === 'WORKFLOW_PERMISSION_DENIED',
  );
  const other = await setup(unitC);
  await assert.rejects(
    service.versionComparison(context(designer), draft.id, other.version.id, second.version.id),
    (error) => error instanceof HttpError && error.code === 'WORKFLOW_NOT_FOUND',
  );
  await assert.rejects(
    service.versionHistory(context(designer, { tenantId: otherTenant }), draft.id),
    (error) => error instanceof HttpError && error.code === 'WORKFLOW_PERMISSION_DENIED',
  );
  await assert.rejects(
    service.restoreVersion(
      context(designer),
      draft.id,
      second.definition.revision,
      original.version.id,
    ),
    (error) => error instanceof HttpError && error.code === 'WORKFLOW_PERMISSION_DENIED',
  );
  await assert.rejects(
    service.restoreVersion(context(publisher), draft.id, draft.revision, original.version.id),
    (error) => error instanceof HttpError && error.code === 'REVISION_CONFLICT',
  );
  await assert.rejects(
    service.restoreVersion(
      context(publisher),
      draft.id,
      second.definition.revision,
      second.version.id,
    ),
    (error) => error instanceof HttpError && error.code === 'WORKFLOW_VERSION_CURRENT',
  );
  candidates.delete(handler.accountId);
  try {
    await assert.rejects(
      service.restoreVersion(
        context(publisher),
        draft.id,
        second.definition.revision,
        original.version.id,
      ),
      (error) => error instanceof HttpError && error.code === 'WORKFLOW_ASSIGNEE_UNAVAILABLE',
    );
  } finally {
    candidates.set(handler.accountId, handler);
  }
  const command = context(publisher);
  const restored = await service.restoreVersion(
    command,
    draft.id,
    second.definition.revision,
    original.version.id,
  );
  assert.equal(restored.version.version, 3);
  assert.equal(restored.version.checksum, original.version.checksum);
  assert.notEqual(restored.version.id, original.version.id);
  assert.equal(restored.definition.draft.name, revised.name);
  assert.deepEqual(
    await service.restoreVersion(
      command,
      draft.id,
      second.definition.revision,
      original.version.id,
    ),
    restored,
  );
  const same = await service.versionComparison(
    context(publisher),
    draft.id,
    original.version.id,
    restored.version.id,
  );
  assert.deepEqual(same.changes, []);
  assert.equal(
    (await service.detail(context(requester), run.id)).run.version_id,
    original.version.id,
  );
  assert.equal((await start(restored)).version_id, restored.version.id);
  const audit = await pool.query(
    "SELECT details FROM workflow_audit WHERE tenant_id=$1 AND definition_id=$2 AND action='definition.restored'",
    [tenant, draft.id],
  );
  assert.deepEqual(
    audit.rows.map(({ details }) => details),
    [
      {
        version: 3,
        checksum: original.version.checksum,
        sourceVersion: 1,
        sourceVersionId: original.version.id,
      },
    ],
  );
});
