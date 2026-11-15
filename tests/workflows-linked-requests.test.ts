import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
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
import type { HumanStep, WorkflowSpec } from '../src/workflows/contracts.js';
import type { WorkflowLinkInput, WorkflowLinkJob } from '../src/workflows/linked-requests.js';
import { registerWorkflowsRoutes } from '../src/workflows/routes.js';
import { WorkflowsService } from '../src/workflows/service.js';
import { WorkflowWorkCenter } from '../src/workflows/work-center.js';
import { workflowTemplate } from '../src/workflows/templates.js';

const runtime = await loadLocalConfig();
const config = await loadWorkflowsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 5 });
const owner = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true, true), max: 1 });
const tenant = randomUUID(),
  unit = randomUUID(),
  otherUnit = randomUUID();
const makeActor = (permissions: WorkflowPermission[], orgUnitId = unit): WorkflowActor => ({
  appCode: 'aio-workflows',
  accountId: randomUUID(),
  personId: randomUUID(),
  tenantIds: [tenant],
  units: [{ tenantId: tenant, orgUnitId }],
  permissions: permissions.map((permission) => ({ tenantId: tenant, orgUnitId, permission })),
});
const publisher = makeActor(['workflows:design', 'workflows:publish']);
const requester = makeActor(['workflows:start']);
const reviewer = makeActor(['workflows:act']);
const replacementReviewer = makeActor(['workflows:act']);
const manager = makeActor(['workflows:manage']);
const recipient = makeActor(['workflows:start', 'workflows:report']);
const outsider = makeActor(['workflows:publish'], otherUnit);
const authorized = new Map([requester, recipient].map((a) => [a.accountId, a]));
const service = new WorkflowsService(pool, {
  async linkRecipient(t, accountId) {
    const actor = t === tenant && authorized.get(accountId);
    return actor ? structuredClone(actor) : null;
  },
  async validateUnit(t, u) {
    if (t !== tenant || u !== unit) throw new HttpError(403, 'WORKFLOW_REFERENCE_DENIED');
  },
  async assignee(t, u, account) {
    const actor = [reviewer, replacementReviewer].find(({ accountId }) => accountId === account);
    if (t !== tenant || u !== unit || !actor)
      throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
    return { personId: actor.personId, name: 'Kế toán giả lập' };
  },
});
const context = (actor: WorkflowActor): WorkflowCommand => ({
  tenantId: tenant,
  actor: async () => structuredClone(actor),
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
  reason: 'Nghiệm thu liên kết giả lập',
});
const errorCode = (code: string) => (error: unknown) =>
  error instanceof HttpError && error.code === code;
const rawJobs = async (id: string) =>
  (
    await pool.query<WorkflowLinkJob>(
      'SELECT * FROM workflow_link_jobs WHERE (tenant_id,source_run_id)=($1,$2) ORDER BY rule_id',
      [tenant, id],
    )
  ).rows;

before(async () => {
  assert.deepEqual((await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-workflows-test' },
  ]);
});
after(async () => {
  await pool.end();
  await owner.end();
});

async function definition(name: string, target: boolean, customize?: (spec: WorkflowSpec) => void) {
  const spec = workflowTemplate('leave');
  spec.schemaVersion = 5;
  spec.name = name;
  spec.category = 'Tài chính';
  spec.audienceUnits = [unit];
  spec.input.schemaVersion = 2;
  spec.input.title = name;
  spec.input.sections[0]!.fields = [
    { id: 'purpose', type: 'longText', label: 'Nội dung', required: true },
    {
      id: target ? 'received' : 'amount',
      type: 'money',
      label: 'Số tiền (VND)',
      currency: 'VND',
      required: true,
    },
    { id: 'private_note', type: 'shortText', label: 'Ghi chú hạn chế', required: false },
    ...(target
      ? [
          {
            id: 'receipts',
            type: 'attachment' as const,
            label: 'Chứng từ quyết toán',
            required: true,
            attachments: { formats: ['txt' as const], maxFiles: 1, maxBytes: 2000 },
          },
        ]
      : [{ id: 'settle', type: 'boolean' as const, label: 'Cần quyết toán', required: true }]),
  ];
  spec.fieldReaders = { 'input.private_note': ['owner'] };
  for (const node of spec.nodes) if ('assignee' in node) node.assignee = reviewer.accountId;
  customize?.(spec);
  const code = 'link-' + randomUUID().slice(0, 8);
  const d = await service.saveDefinition(context(publisher), { code, orgUnitId: unit, spec });
  const v = await service.publish(context(publisher), d.id, d.revision);
  return { id: d.id, version: v.version, revision: v.definition.revision, code, spec };
}

async function setup() {
  const from = await definition('Đề nghị tạm ứng', false);
  const to = await definition('Quyết toán tạm ứng', true);
  const input: WorkflowLinkInput = {
    name: 'Chuẩn bị quyết toán',
    unitId: unit,
    sourceDefinitionId: from.id,
    sourceVersionId: from.version.id,
    targetDefinitionId: to.id,
    targetVersionId: to.version.id,
    mapping: [
      { from: 'purpose', to: 'purpose' },
      { from: 'amount', to: 'received' },
    ],
    predicate: { fieldId: 'settle', equals: true },
  };
  const start = (settle = true) =>
    service.start(context(requester), {
      definitionId: from.id,
      versionId: from.version.id,
      unitId: unit,
      title: 'Tạm ứng công tác giả lập',
      answers: {
        purpose: 'Đi công tác',
        amount: '1200000.25',
        settle,
        private_note: 'Dữ liệu giả lập hạn chế',
      },
    });
  const action = async (runId: string, action: 'approve' | 'reject' = 'approve') => {
    const task = (await service.detail(context(reviewer), runId)).tasks[0]!;
    const c = context(reviewer);
    return () => service.act(c, task.id, { expectedRevision: task.revision, action, answers: {} });
  };
  return { from, to, input, start, action };
}

test('Tạm ứng approved run and outbox commit once, concurrent workers create one editable settlement draft', async () => {
  const { from, to, input, start, action } = await setup();
  const c = context(publisher);
  const rule = await service.createLinkRule(c, input);
  assert.deepEqual(await service.createLinkRule(c, input), rule);
  await assert.rejects(
    service.createLinkRule(context(outsider), input),
    errorCode('WORKFLOW_PERMISSION_DENIED'),
  );
  await assert.rejects(
    service.createLinkRule(context(publisher), {
      ...input,
      sourceDefinitionId: to.id,
      sourceVersionId: to.version.id,
      targetDefinitionId: from.id,
      targetVersionId: from.version.id,
      mapping: [],
      predicate: { fieldId: 'purpose', equals: 'example' },
    }),
    errorCode('WORKFLOW_LINK_CYCLE'),
  );
  const run = await start();
  assert.deepEqual(await rawJobs(run.id), []);
  const approve = await action(run.id);
  assert.equal((await approve()).status, 'completed');
  assert.equal((await approve()).status, 'completed');
  assert.equal((await rawJobs(run.id)).length, 1);
  assert.equal((await rawJobs(run.id))[0]!.status, 'queued');
  const restarted = new WorkflowsService(pool, service.directory);
  await Promise.all([service.processLinkedDrafts(), restarted.processLinkedDrafts()]);
  const [job] = await rawJobs(run.id);
  assert.equal(job!.status, 'done');
  assert.equal(job!.attempts, 1);
  const draft = await service.requestDraft(context(requester), job!.target_request_id!);
  assert.equal(draft.request.version_id, to.version.id);
  assert.deepEqual(draft.request.answers, { purpose: 'Đi công tác', received: '1200000.25' });
  assert.equal(draft.linkedSource?.runId, run.id);
  assert.equal(draft.canSubmit, true);
  await assert.rejects(
    service.requestDraft(context(recipient), draft.request.id),
    errorCode('WORKFLOW_PERMISSION_DENIED'),
  );
  assert.deepEqual((await service.relatedRequests(context(recipient), run.id)).items, []);
  assert.deepEqual((await service.relatedRequests(context(requester), run.id)).items, [
    { title: draft.request.title, status: 'draft', requestId: draft.request.id },
  ]);
  await assert.rejects(
    service.submitRequest(context(requester), draft.request.id, draft.request.revision),
    (error) =>
      error instanceof FormValidationError &&
      error.issues.some((issue) => issue.path === 'answers.receipts'),
  );
  const file = await service.uploadAttachment(context(requester), 'request', draft.request.id, {
    fieldId: 'receipts',
    fileName: 'chung-tu.txt',
    content: Buffer.from('Chứng từ quyết toán giả lập').toString('base64'),
  });
  const edited = await service.saveRequest(
    context(requester),
    {
      definitionId: to.id,
      versionId: to.version.id,
      unitId: unit,
      title: draft.request.title,
      answers: { ...draft.request.answers, receipts: [file.id] },
    },
    draft.request.id,
    draft.request.revision,
  );
  const submitted = await service.submitRequest(context(requester), edited.id, edited.revision);
  assert.deepEqual((await service.relatedRequests(context(requester), run.id)).items, [
    { title: submitted.title, status: 'running', runId: submitted.id },
  ]);
  const skipped = await start(false);
  await (
    await action(skipped.id)
  )();
  const rejected = await start();
  await (
    await action(rejected.id, 'reject')
  )();
  await service.processLinkedDrafts();
  assert.equal((await rawJobs(skipped.id))[0]!.status, 'skipped');
  assert.deepEqual(await rawJobs(rejected.id), []);
});

test('Pinned target changes and missing source field permission stop the linked draft', async () => {
  const { to, input, start, action } = await setup();
  await service.createLinkRule(context(publisher), input);
  const restrictedRule = await service.createLinkRule(context(publisher), {
    ...input,
    recipientAccountId: recipient.accountId,
    mapping: [{ from: 'private_note', to: 'private_note' }],
  });
  const first = await start();
  await (
    await action(first.id)
  )();
  await service.processLinkedDrafts();
  const firstJobs = await rawJobs(first.id);
  assert.equal(firstJobs.length, 2);
  assert.equal(
    firstJobs.find((job) => job.status === 'blocked')?.error_code,
    'WORKFLOW_LINK_FIELD_DENIED',
  );
  assert.equal(firstJobs.filter((job) => job.status === 'done').length, 1);
  assert.deepEqual((await service.linkJobs(context(publisher), restrictedRule.id)).items, []);
  const restrictedJob = firstJobs.find((job) => job.rule_id === restrictedRule.id)!;
  await assert.rejects(
    service.retryLinkJob(context(publisher), restrictedJob.id, restrictedJob.attempts),
    errorCode('WORKFLOW_PERMISSION_DENIED'),
  );
  const second = await start();
  await (
    await action(second.id)
  )();
  const edited = await service.saveDefinition(
    context(publisher),
    {
      code: to.code,
      orgUnitId: unit,
      spec: { ...to.spec, name: 'Quyết toán phiên bản mới' },
    },
    to.id,
    to.revision,
  );
  await service.publish(context(publisher), to.id, edited.revision);
  await service.processLinkedDrafts();
  const changed = await rawJobs(second.id);
  assert.equal(changed.length, 2);
  assert(
    changed.every(
      (job) =>
        job.status === 'blocked' &&
        job.error_code === 'WORKFLOW_VERSION_STALE' &&
        !job.target_request_id,
    ),
  );
});

test('Rollback preserves source and draft atomicity, revocation stops execution and scoped retry records attempts', async () => {
  const { input, start, action } = await setup();
  const rule = await service.createLinkRule(context(publisher), input);
  const run = await start();
  const approve = await action(run.id);
  await owner.query(`CREATE FUNCTION workflows_link_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.tenant_id='${tenant}'::uuid AND
      ((NEW.action='run.completed' AND NEW.run_id='${run.id}'::uuid) OR NEW.action='request.automated_draft_created') THEN
      RAISE EXCEPTION 'Synthetic link audit failure'; END IF; RETURN NEW; END; $$`);
  try {
    await owner.query(`CREATE TRIGGER workflows_link_fixture_audit_failure BEFORE INSERT ON workflow_audit
      FOR EACH ROW EXECUTE FUNCTION workflows_link_fixture_audit_failure()`);
    await assert.rejects(approve);
    assert.equal((await service.detail(context(requester), run.id)).run.status, 'running');
    assert.deepEqual(await rawJobs(run.id), []);
    const draftFailure = await start();
    await (
      await action(draftFailure.id)
    )();
    const before = (await service.requestDrafts(context(requester))).items.length;
    await service.processLinkedDrafts();
    const [failed] = await rawJobs(draftFailure.id);
    assert.equal(failed!.status, 'retry');
    assert.equal(failed!.error_code, 'WORKFLOW_LINK_TEMPORARY_FAILURE');
    assert.equal(failed!.target_request_id, null);
    assert.equal((await service.requestDrafts(context(requester))).items.length, before);
  } finally {
    await owner.query(
      'DROP TRIGGER IF EXISTS workflows_link_fixture_audit_failure ON workflow_audit',
    );
    await owner.query('DROP FUNCTION workflows_link_fixture_audit_failure()');
  }
  await approve();
  authorized.delete(requester.accountId);
  try {
    await service.processLinkedDrafts();
    const [job] = await rawJobs(run.id);
    assert.equal(job!.status, 'blocked');
    assert.equal(job!.error_code, 'WORKFLOW_LINK_RECIPIENT_UNAVAILABLE');
    assert.equal(job!.target_request_id, null);
    await assert.rejects(
      service.retryLinkJob(context(outsider), job!.id, job!.attempts),
      errorCode('WORKFLOW_PERMISSION_DENIED'),
    );
    await assert.rejects(
      service.retryLinkJob(context(publisher), job!.id, 2),
      errorCode('REVISION_CONFLICT'),
    );
    await service.retryLinkJob(context(publisher), job!.id, 1);
  } finally {
    authorized.set(requester.accountId, requester);
  }
  await service.processLinkedDrafts();
  const completedJob = (await rawJobs(run.id))[0]!;
  const attempts = (await service.linkJobs(context(publisher), rule.id)).items.find(
    (item) => item.id === completedJob.id,
  );
  assert.equal(attempts.status, 'done');
  assert.deepEqual(
    attempts.history.map((entry: { status: string }) => entry.status),
    ['done', 'blocked'],
  );
  const app = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  try {
    registerWorkflowsRoutes(app, {
      service,
      actor: async () => publisher,
      lookups: async () => ({}),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/workflows/link-rules/' + rule.id + '/jobs?tenantId=' + tenant,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.json().items.find((item: { id: string }) => item.id === completedJob.id).history.length,
      2,
    );
    const disabled = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows/link-rules/' + rule.id + '/disable',
      headers: { 'idempotency-key': randomUUID() },
      payload: { tenantId: tenant, expectedRevision: 1, reason: 'Tắt quy tắc giả lập' },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().enabled, false);
  } finally {
    await app.close();
  }
  const later = await start();
  await (
    await action(later.id)
  )();
  assert.deepEqual(await rawJobs(later.id), []);
});

async function setupStepLink() {
  const from = await definition('Nguồn tạo nháp theo bước', false, (spec) => {
    const first = spec.nodes.find(
      (node): node is HumanStep => node.id === 'review' && node.kind === 'approval',
    )!;
    first.next = 'confirm';
    first.form = {
      schemaVersion: 2,
      title: 'Xác nhận chi phí',
      sections: [
        {
          id: 'confirmed',
          title: 'Số liệu',
          fields: [
            {
              id: 'approved_amount',
              type: 'money',
              label: 'Chi phí duyệt',
              currency: 'VND',
              required: true,
            },
            { id: 'step_ready', type: 'boolean', label: 'Đủ điều kiện', required: true },
            {
              id: 'private_note',
              type: 'shortText',
              label: 'Thông tin bước hạn chế',
              required: false,
            },
          ],
        },
      ],
    };
    spec.fieldReaders = { ...spec.fieldReaders, 'review.private_note': ['manager'] };
    spec.nodes.splice(2, 0, {
      id: 'confirm',
      label: 'Xác nhận sau duyệt',
      kind: 'task',
      assignee: reviewer.accountId,
      dueHours: 24,
      next: 'end',
      form: null,
      allowReturn: true,
      returnMode: 'previous',
    });
  });
  const to = await definition('Đích nhận theo bước', true);
  const input: WorkflowLinkInput = {
    name: 'Nháp theo bước',
    unitId: unit,
    sourceDefinitionId: from.id,
    sourceVersionId: from.version.id,
    targetDefinitionId: to.id,
    targetVersionId: to.version.id,
    sourceStepId: 'review',
    mapping: [
      { from: 'purpose', to: 'purpose' },
      { from: 'approved_amount', to: 'received', origin: 'step' },
    ],
    predicate: { fieldId: 'step_ready', equals: true, origin: 'step' },
  };
  const start = () =>
    service.start(context(requester), {
      definitionId: from.id,
      versionId: from.version.id,
      unitId: unit,
      title: 'Duyệt chi phí công tác',
      answers: {
        purpose: 'Đi công tác',
        amount: '123.00',
        settle: true,
        private_note: 'Thông tin đầu vào',
      },
    });
  async function action(
    runId: string,
    stepId: string,
    action: 'approve' | 'return' | 'complete',
    answers: Record<string, unknown> = {},
  ) {
    const task = (await service.detail(context(reviewer), runId)).tasks.find(
      (t) => t.node_id === stepId && t.status === 'pending',
    )!;
    assert(task);
    const c = context(reviewer);
    return {
      task,
      apply: () => service.act(c, task.id, { expectedRevision: task.revision, action, answers }),
    };
  }
  return { input, to, start, action };
}

test('A step link enqueues atomically, maps step and request fields, and replaces an invalidated attempt', async () => {
  const { input, to, start, action } = await setupStepLink();
  await assert.rejects(
    service.createLinkRule(context(publisher), { ...input, sourceStepId: 'end' }),
    errorCode('WORKFLOW_LINK_STEP_INVALID'),
  );
  const rule = await service.createLinkRule(context(publisher), input);
  const run = await start();
  const first = await action(run.id, 'review', 'approve', {
    approved_amount: '120.25',
    step_ready: true,
  });
  await owner.query(`CREATE FUNCTION workflows_step_link_test_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.run_id='${run.id}'::uuid AND NEW.action='task.approve' THEN RAISE EXCEPTION 'Synthetic step audit failure';
    END IF; RETURN NEW; END; $$`);
  try {
    await owner.query(`CREATE TRIGGER workflows_step_link_test_rollback BEFORE INSERT ON workflow_audit
      FOR EACH ROW EXECUTE FUNCTION workflows_step_link_test_rollback()`);
    await assert.rejects(first.apply());
    assert.deepEqual(await rawJobs(run.id), []);
  } finally {
    await owner.query('DROP TRIGGER IF EXISTS workflows_step_link_test_rollback ON workflow_audit');
    await owner.query('DROP FUNCTION workflows_step_link_test_rollback()');
  }
  assert.equal((await first.apply()).status, 'running');
  await first.apply();
  await Promise.all([
    service.processLinkedDrafts(),
    new WorkflowsService(pool, service.directory).processLinkedDrafts(),
  ]);
  const [job] = await rawJobs(run.id);
  assert.equal(job!.source_task_id, first.task.id);
  assert.equal(job!.rule_id, rule.id);
  assert.equal(job!.attempts, 1);
  const draft = await service.requestDraft(context(requester), job!.target_request_id!);
  assert.deepEqual(draft.request.answers, { purpose: 'Đi công tác', received: '120.25' });
  assert.equal(draft.linkedSource?.taskId, first.task.id);
  assert.equal(draft.canSubmit, true);
  const relations = (await service.relatedRequests(context(requester), run.id)).items;
  assert.equal(relations[0]?.sourceStep, 'Xem xét đề nghị');
  const rewind = await action(run.id, 'confirm', 'return');
  await rewind.apply();
  const invalid = await service.requestDraft(context(requester), draft.request.id);
  assert.equal(invalid.blockedReason, 'WORKFLOW_LINK_STEP_INACTIVE');
  assert.equal(invalid.canSubmit, false);
  assert.deepEqual(invalid.request.answers, {});
  await assert.rejects(
    service.submitRequest(context(requester), draft.request.id, draft.request.revision),
    errorCode('WORKFLOW_LINK_STEP_INACTIVE'),
  );
  await assert.rejects(
    service.saveRequest(
      context(requester),
      {
        definitionId: to.id,
        versionId: to.version.id,
        unitId: unit,
        title: draft.request.title,
        answers: {},
      },
      draft.request.id,
      draft.request.revision,
    ),
    errorCode('WORKFLOW_LINK_STEP_INACTIVE'),
  );
  await assert.rejects(
    service.uploadAttachment(context(requester), 'request', draft.request.id, {
      fieldId: 'receipts',
      fileName: 'test.txt',
      content: 'dGVzdA==',
    }),
    errorCode('WORKFLOW_LINK_STEP_INACTIVE'),
  );
  const replacement = await action(run.id, 'review', 'approve', {
    approved_amount: '130.00',
    step_ready: true,
  });
  await replacement.apply();
  await service.processLinkedDrafts();
  const jobs = await rawJobs(run.id);
  assert.equal(jobs.length, 2);
  assert.equal(
    jobs.find((item) => item.source_task_id === first.task.id)?.target_request_id,
    draft.request.id,
  );
  const next = jobs.find((item) => item.source_task_id === replacement.task.id)!;
  assert.notEqual(next.target_request_id, draft.request.id);
  assert.equal(
    (await service.requestDraft(context(requester), next.target_request_id!)).request.answers
      .received,
    '130.00',
  );
  await (await action(run.id, 'confirm', 'complete')).apply();
  assert.equal((await rawJobs(run.id)).length, 2);
});

test('Queued step jobs lose eligibility on return and protected step fields stay scoped', async () => {
  const { input, start, action } = await setupStepLink();
  const limited = await service.createLinkRule(context(publisher), {
    ...input,
    recipientAccountId: recipient.accountId,
    mapping: [{ from: 'private_note', to: 'private_note', origin: 'step' }],
  });
  const actorRule = await service.createLinkRule(context(publisher), {
    ...input,
    recipientIsStepActor: true,
  });
  const run = await start();
  await (
    await action(run.id, 'review', 'approve', {
      approved_amount: '120.00',
      step_ready: true,
      private_note: 'Ghi chú riêng',
    })
  ).apply();
  await service.processLinkedDrafts();
  const jobs = await rawJobs(run.id);
  assert.equal(
    jobs.find((job) => job.rule_id === limited.id)?.error_code,
    'WORKFLOW_LINK_FIELD_DENIED',
  );
  assert.equal(
    jobs.find((job) => job.rule_id === actorRule.id)?.error_code,
    'WORKFLOW_LINK_RECIPIENT_UNAVAILABLE',
  );
  assert.deepEqual((await service.linkJobs(context(publisher), limited.id)).items, []);
  const starter = {
    ...reviewer,
    permissions: [
      ...reviewer.permissions,
      { tenantId: tenant, orgUnitId: unit, permission: 'workflows:start' },
    ],
  };
  authorized.set(reviewer.accountId, starter);
  try {
    const second = await start();
    await (
      await action(second.id, 'review', 'approve', {
        approved_amount: '150.00',
        step_ready: true,
        private_note: 'Ghi chú riêng',
      })
    ).apply();
    await service.processLinkedDrafts();
    const owned = (await rawJobs(second.id)).find((job) => job.rule_id === actorRule.id)!;
    assert.equal(owned.status, 'done');
    assert.equal(
      (await service.requestDraft(context(starter), owned.target_request_id!)).request.answers
        .received,
      '150.00',
    );
    await assert.rejects(
      service.requestDraft(context(requester), owned.target_request_id!),
      errorCode('WORKFLOW_PERMISSION_DENIED'),
    );
    const third = await start();
    await (
      await action(third.id, 'review', 'approve', { approved_amount: '160.00', step_ready: true })
    ).apply();
    await (await action(third.id, 'confirm', 'return')).apply();
    await service.processLinkedDrafts();
    assert(
      (await rawJobs(third.id)).every(
        (job) => job.error_code === 'WORKFLOW_LINK_STEP_INACTIVE' && !job.target_request_id,
      ),
    );
  } finally {
    authorized.delete(reviewer.accountId);
  }
});

test('A linked draft rechecks source access while its recipient still owns the target draft', async () => {
  const { input, start, action } = await setupStepLink();
  await service.createLinkRule(context(publisher), {
    ...input,
    recipientAccountId: recipient.accountId,
  });
  const run = await start();
  await (
    await action(run.id, 'review', 'approve', { approved_amount: '250.00', step_ready: true })
  ).apply();
  await service.processLinkedDrafts();
  const [job] = await rawJobs(run.id);
  assert.equal(job!.status, 'done');
  const id = job!.target_request_id!;
  const active = await service.requestDraft(context(recipient), id);
  assert.equal(active.request.answers.received, '250.00');
  const changed = {
    ...recipient,
    permissions: recipient.permissions.filter((p) => p.permission !== 'workflows:report'),
  };
  const revoked = await service.requestDraft(context(changed), id);
  assert.equal(revoked.blockedReason, 'WORKFLOW_LINK_SOURCE_DENIED');
  assert.equal(revoked.canSubmit, false);
  assert.equal(revoked.linkedSource, undefined);
  assert.deepEqual(revoked.request.answers, {});
  await assert.rejects(
    service.submitRequest(context(changed), id, active.request.revision),
    errorCode('WORKFLOW_LINK_SOURCE_DENIED'),
  );
  await (await action(run.id, 'confirm', 'return')).apply();
  const inaccessible = await service.requestDraft(context(changed), id);
  assert.equal(inaccessible.blockedReason, 'WORKFLOW_LINK_SOURCE_DENIED');
  assert.deepEqual(inaccessible.request.answers, {});
  assert.equal(
    (await service.requestDraft(context(recipient), id)).blockedReason,
    'WORKFLOW_LINK_STEP_INACTIVE',
  );
});

test('Versioned print uses the viewer field scope and renders escaped document text', async () => {
  const { from, input, start } = await setup();
  const templateInput = {
    definitionId: from.id,
    versionId: from.version.id,
    unitId: unit,
    kind: 'print' as const,
    name: 'Phiếu công tác',
    heading: 'Phiếu {{run.title}}',
    body: 'Ghi chú {{input.private_note}}',
    fields: ['input.purpose', 'input.private_note', 'input.amount'],
  };
  await assert.rejects(
    service.createOutputTemplate(context(outsider), templateInput),
    errorCode('WORKFLOW_PERMISSION_DENIED'),
  );
  await assert.rejects(
    service.createOutputTemplate(context(publisher), {
      ...templateInput,
      body: '{{input.missing}}',
    }),
    errorCode('WORKFLOW_OUTPUT_INVALID'),
  );
  const print = await service.createOutputTemplate(context(publisher), templateInput);
  const run = await start();
  const ownerHtml = await service.printRun(context(requester), run.id, print.id);
  assert.match(ownerHtml, /Dữ liệu giả lập hạn chế/);
  const reviewerHtml = await service.printRun(context(reviewer), run.id, print.id);
  assert.doesNotMatch(reviewerHtml, /Dữ liệu giả lập hạn chế|Ghi chú hạn chế/);
  assert.match(reviewerHtml, /1200000.25 VND/);
  await assert.rejects(
    service.printRun(context(outsider), run.id, print.id),
    errorCode('WORKFLOW_PERMISSION_DENIED'),
  );
  const other = await service.start(context(requester), {
    definitionId: input.sourceDefinitionId,
    versionId: input.sourceVersionId,
    unitId: unit,
    title: 'Tiêu đề <b>giả lập</b>',
    answers: { purpose: 'Nội dung <b>công tác</b>', amount: '1.00', settle: true },
  });
  const escaped = await service.printRun(context(requester), other.id, print.id);
  assert.match(escaped, /&lt;b&gt;công tác&lt;\/b&gt;/);
  assert.doesNotMatch(escaped, /<b>/);
});

test('Local email is transactionally enqueued, scoped, retryable, and delivered once', async () => {
  const { from, start, action } = await setup();
  const hub = new WorkflowWorkCenter(service);
  const input = {
    definitionId: from.id,
    versionId: from.version.id,
    unitId: unit,
    kind: 'email' as const,
    event: 'approved' as const,
    stepId: 'review',
    name: 'Email phê duyệt',
    heading: 'Đã duyệt {{run.title}}',
    body: '{{event.kind}} · {{input.purpose}} · {{input.private_note}}',
    fields: [],
  };
  const template = await service.createOutputTemplate(context(publisher), input);
  const run = await start();
  assert.deepEqual((await service.outputJobs(context(publisher), template.id)).items, []);
  const approve = await action(run.id);
  await approve();
  await approve();
  const jobs = (await service.outputJobs(context(publisher), template.id)).items;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'queued');
  authorized.delete(requester.accountId);
  try {
    await hub.deliverOutputNotifications();
    const blocked = (await service.outputJobs(context(publisher), template.id)).items[0];
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.error_code, 'WORKFLOW_OUTPUT_RECIPIENT_DENIED');
    assert.deepEqual((await hub.outputMailbox(context(requester))).items, []);
    await assert.rejects(
      service.retryOutputJob(context(outsider), blocked.id, 1),
      errorCode('WORKFLOW_PERMISSION_DENIED'),
    );
    await service.retryOutputJob(context(publisher), blocked.id, 1);
  } finally {
    authorized.set(requester.accountId, requester);
  }
  await Promise.all([
    hub.deliverOutputNotifications(),
    new WorkflowWorkCenter(service).deliverOutputNotifications(),
  ]);
  const delivered = (await hub.outputMailbox(context(requester))).items.filter(
    (item) => item.runId === run.id,
  );
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!.body, /Đi công tác/);
  assert.deepEqual((await hub.outputMailbox(context(reviewer))).items, []);
  const after = (await service.outputJobs(context(publisher), template.id)).items[0];
  assert.equal(after.status, 'done');
  assert.equal(after.attempts, 2);
  assert.deepEqual(
    after.history.map((item: { status: string }) => item.status),
    ['done', 'blocked'],
  );
  const changed = { ...requester, permissions: [] };
  assert.deepEqual((await hub.outputMailbox(context(changed))).items, []);
});

test('Outputs respect supersession and the assignment on the effective attempt', async () => {
  const { input, start, action } = await setupStepLink();
  const hub = new WorkflowWorkCenter(service);
  const common = {
    definitionId: input.sourceDefinitionId,
    versionId: input.sourceVersionId,
    unitId: unit,
    heading: '{{run.title}}',
  };
  const email = await service.createOutputTemplate(context(publisher), {
    ...common,
    kind: 'email',
    name: 'Kết quả sau phê duyệt',
    event: 'approved',
    stepId: 'review',
    body: '{{step.review.approved_amount}} · {{step.review.private_note}}',
    fields: [],
  });
  const print = await service.createOutputTemplate(context(publisher), {
    ...common,
    kind: 'print',
    name: 'Kết quả hiệu lực',
    body: '',
    fields: ['step.review.approved_amount', 'step.review.private_note'],
  });
  const run = await start();
  const previous = await action(run.id, 'review', 'approve', {
    approved_amount: '120.00',
    step_ready: true,
    private_note: 'Ghi chú lượt trước',
  });
  await previous.apply();
  await hub.deliverOutputNotifications();
  const messages = async () =>
    (await hub.outputMailbox(context(requester))).items.filter(({ runId }) => runId === run.id);
  assert.deepEqual(
    (await messages()).map(({ body }) => body),
    ['120.00 VND · —'],
  );
  assert.match(await service.printRun(context(reviewer), run.id, print.id), /Ghi chú lượt trước/);

  await (await action(run.id, 'confirm', 'return')).apply();
  assert.deepEqual(await messages(), []);
  const next = await action(run.id, 'review', 'approve');
  assert.notEqual(next.task.id, previous.task.id);
  const reassigned = await service.reassign(context(manager), next.task.id, {
    accountId: replacementReviewer.accountId,
    expectedRevision: next.task.revision,
  });
  await service.act(context(replacementReviewer), next.task.id, {
    expectedRevision: reassigned.revision,
    action: 'approve',
    answers: { approved_amount: '130.00', step_ready: true, private_note: 'Ghi chú lượt thay thế' },
  });
  await hub.deliverOutputNotifications();
  assert.deepEqual(
    (await messages()).map(({ body }) => body),
    ['130.00 VND · —'],
  );
  const jobs = (await service.outputJobs(context(publisher), email.id)).items;
  assert.deepEqual(
    jobs.map(({ status, attempts }) => [status, attempts]),
    [
      ['done', 1],
      ['done', 1],
    ],
  );
  const oldViewer = await service.printRun(context(reviewer), run.id, print.id);
  assert.match(oldViewer, /130\.00 VND/);
  assert.doesNotMatch(oldViewer, /Thông tin bước hạn chế|Ghi chú lượt|120\.00 VND/);
  const effectiveViewer = await service.printRun(context(replacementReviewer), run.id, print.id);
  assert.match(effectiveViewer, /Ghi chú lượt thay thế/);
  assert.doesNotMatch(effectiveViewer, /Ghi chú lượt trước/);
});
