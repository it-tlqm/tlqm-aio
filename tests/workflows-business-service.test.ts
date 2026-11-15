import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { WorkflowsService } from '../src/workflows/service.js';
import { parseWorkflow } from '../src/workflows/contracts.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { purchaseColumns } from '../src/forms/business.js';
import { FormValidationError } from '../src/forms/contracts.js';
import { HttpError } from '../src/security.js';
import type {
  WorkflowActor,
  WorkflowCommand,
  WorkflowPermission,
} from '../src/workflows/access.js';

const runtime = await loadLocalConfig(),
  config = await loadWorkflowsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 3 });
const owner = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true, true), max: 1 });
const tenant = randomUUID(),
  unit = randomUUID();
const actor = (permissions: WorkflowPermission[]): WorkflowActor => ({
  appCode: 'aio-workflows',
  accountId: randomUUID(),
  personId: randomUUID(),
  tenantIds: [tenant],
  units: [{ tenantId: tenant, orgUnitId: unit }],
  permissions: permissions.map((permission) => ({ tenantId: tenant, permission, orgUnitId: unit })),
});
const admin = actor(['workflows:design', 'workflows:publish', 'workflows:manage']),
  requester = actor(['workflows:start']),
  reviewer = actor(['workflows:act']),
  operator = actor(['workflows:act']),
  reporter = actor(['workflows:report']);
const candidates = new Map([reviewer, operator].map((a) => [a.accountId, a]));
const referencePerson = randomUUID();
let referenceName = 'Nhân sự trong hồ sơ',
  referenceAvailable = true,
  referenceCalls = 0,
  revokeAfterFirst = false;
const service = new WorkflowsService(pool, {
  async references(t, _actor, query) {
    referenceCalls++;
    const available = referenceAvailable && (!revokeAfterFirst || referenceCalls === 1);
    return {
      items:
        t === tenant &&
        query.unitId === unit &&
        available &&
        query.id === (query.kind === 'person' ? referencePerson : unit)
          ? [{ id: query.id, label: query.kind === 'person' ? referenceName : 'Đơn vị hồ sơ' }]
          : [],
      nextCursor: null,
    };
  },
  async validateUnit(t, u) {
    if (t !== tenant || u !== unit) throw new HttpError(403, 'WORKFLOW_REFERENCE_DENIED');
  },
  async assignee(t, u, id) {
    const a = candidates.get(id);
    if (t !== tenant || u !== unit || !a) throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
    return { personId: a.personId, name: 'Nghiệm thu W1' };
  },
});
const context = (a: WorkflowActor): WorkflowCommand => ({
  tenantId: tenant,
  actor: async () => structuredClone(a),
  reason: 'Nghiệm thu dữ liệu nghiệp vụ',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
});
before(async () =>
  assert.deepEqual((await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-workflows-test' },
  ]),
);
test('Reference snapshots survive renames, redact with fields and rollback when a reference becomes unavailable before commit', async () => {
  const spec = workflowTemplate();
  spec.schemaVersion = 5;
  spec.audienceUnits = [unit];
  spec.input.schemaVersion = 2;
  spec.input.sections[0]!.fields.push(
    { id: 'recipient', type: 'person', label: 'Người nhận', required: true },
    { id: 'department', type: 'orgUnit', label: 'Đơn vị nhận', required: true },
  );
  spec.fieldReaders = { 'input.recipient': ['review'] };
  for (const n of spec.nodes)
    if ('assignee' in n) {
      n.assignee = n.id === 'review' ? reviewer.accountId : operator.accountId;
      if (n.id === 'review')
        n.form = {
          schemaVersion: 2,
          title: 'Xác nhận',
          sections: [
            {
              id: 'review_data',
              title: 'Bàn giao',
              fields: [
                { id: 'confirmed_by', type: 'person', label: 'Nhân sự tiếp nhận', required: true },
              ],
            },
          ],
        };
    }
  const d = await service.saveDefinition(context(admin), {
    code: 'references-' + randomUUID().slice(0, 8),
    orgUnitId: unit,
    spec,
  });
  const v = await service.publish(context(admin), d.id, d.revision);
  const input = {
    definitionId: d.id,
    versionId: v.version.id,
    unitId: unit,
    title: 'Tham chiếu cơ cấu AIO',
    answers: {
      purpose: 'Thử nghiệm tham chiếu',
      amount: 1,
      needed_on: '2026-12-01',
      recipient: { id: referencePerson, label: 'Tên giả' },
      department: { id: unit, label: 'Đơn vị giả' },
    },
  };
  try {
    const draft = await service.saveRequest(context(requester), input);
    assert.deepEqual(draft.answers.recipient, { id: referencePerson, label: referenceName });
    referenceName = 'Tên sau cập nhật cơ cấu';
    const submit = context(requester);
    const run = await service.submitRequest(submit, draft.id, draft.revision);
    assert.deepEqual(run.inputs.recipient, { id: referencePerson, label: referenceName });
    referenceName = 'Tên thay đổi lần nữa';
    referenceAvailable = false;
    assert.deepEqual(
      (await service.submitRequest(submit, draft.id, draft.revision)).inputs,
      run.inputs,
    );
    assert.deepEqual((await service.detail(context(requester), run.id)).run.inputs, run.inputs);
    assert(
      !JSON.stringify(await service.detail(context(reporter), run.id)).includes(referencePerson),
    );
    const pending = (await service.detail(context(reviewer), run.id)).tasks.find(
      (t) => t.status === 'pending',
    )!;
    await assert.rejects(
      () =>
        service.act(context(reviewer), pending.id, {
          expectedRevision: pending.revision,
          action: 'approve',
          answers: { confirmed_by: { id: referencePerson, label: 'Tên giả' } },
        }),
      { code: 'FORM_VALIDATION_FAILED' },
    );
    referenceAvailable = true;
    const returnCommand = context(reviewer);
    await service.act(returnCommand, pending.id, {
      expectedRevision: pending.revision,
      action: 'return',
      answers: { confirmed_by: { id: referencePerson, label: 'Tên giả' } },
    });
    const returned = await service.detail(context(requester), run.id);
    assert.equal(returned.run.status, 'needs_revision');
    assert.deepEqual(returned.tasks.find((t) => t.id === pending.id)!.answers.confirmed_by, {
      id: referencePerson,
      label: referenceName,
    });
    referenceAvailable = false;
    await assert.rejects(
      () =>
        service.resubmit(context(requester), run.id, {
          expectedRevision: returned.run.revision,
          answers: input.answers,
        }),
      { code: 'FORM_VALIDATION_FAILED' },
    );
    referenceAvailable = true;
    const resubmitted = await service.resubmit(context(requester), run.id, {
      expectedRevision: returned.run.revision,
      answers: input.answers,
    });
    assert.equal(resubmitted.round, 2);
    assert.deepEqual(resubmitted.inputs.recipient, { id: referencePerson, label: referenceName });
    assert.deepEqual(
      (await service.detail(context(requester), run.id)).inputs.find((h: any) => h.round === 1)!
        .inputs.recipient,
      run.inputs.recipient,
    );
    const failing = context(requester);
    referenceCalls = 0;
    revokeAfterFirst = true;
    // One populated reference passes normalization, then disappears at the pre-commit check.
    const single = structuredClone(input);
    delete (single.answers as any).department;
    // The two-field request fails on the second resolution and must not leave a partial request/run/audit.
    await assert.rejects(() => service.saveRequest(failing, input), {
      code: 'FORM_VALIDATION_FAILED',
    });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM workflow_receipts WHERE tenant_id=$1 AND idempotency_key=$2',
          [tenant, failing.idempotencyKey],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM workflow_audit WHERE tenant_id=$1 AND request_id=$2',
          [tenant, failing.requestId],
        )
      ).rows[0].n,
      0,
    );
    referenceCalls = 0;
    const failingFinal = context(requester);
    await assert.rejects(() => service.saveRequest(failingFinal, single), {
      code: 'FORM_VALIDATION_FAILED',
    });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM workflow_request_history h JOIN workflow_requests q ON q.id=h.request_id AND q.tenant_id=h.tenant_id WHERE q.tenant_id=$1 AND q.definition_id=$2',
          [tenant, d.id],
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM workflow_audit WHERE tenant_id=$1 AND request_id=$2',
          [tenant, failingFinal.requestId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    referenceName = 'Nhân sự trong hồ sơ';
    referenceAvailable = true;
    referenceCalls = 0;
    revokeAfterFirst = false;
  }
});
after(async () => {
  await pool.end();
  await owner.end();
});

test('Workflow business fields are pinned, recalculated and redacted from details, history, decisions and idempotent retries', async () => {
  const spec = workflowTemplate();
  spec.schemaVersion = 5;
  spec.audienceUnits = [unit];
  spec.input.schemaVersion = 2;
  spec.input.sections[0]!.fields.push(
    {
      id: 'items',
      type: 'table',
      label: 'Hàng hóa',
      required: true,
      currency: 'VND',
      maxRows: 10,
      columns: purchaseColumns(),
    },
    { id: 'confidential', type: 'shortText', label: 'Ghi chú giới hạn', required: true },
  );
  spec.fieldReaders = {
    'input.confidential': ['review'],
    'input.items': ['review'],
    'review.internal_note': [],
  };
  for (const n of spec.nodes)
    if ('assignee' in n) {
      n.assignee = n.id === 'review' ? reviewer.accountId : operator.accountId;
      if (n.id === 'review') {
        n.inputFields = { confidential: 'required', items: 'read' };
        n.form = {
          schemaVersion: 1,
          title: 'Ý kiến',
          sections: [
            {
              id: 'note',
              title: 'Nội dung',
              fields: [
                {
                  id: 'internal_note',
                  type: 'shortText',
                  label: 'Ghi chú của người duyệt',
                  required: true,
                },
              ],
            },
          ],
        };
      }
    }
  const branch = spec.nodes.find((n) => n.kind === 'condition')!;
  branch.condition.rules = [
    { fieldCode: 'items__total_amount', operator: 'GREATER_THAN_OR_EQUAL', value: 100 },
  ];
  const draft = await service.saveDefinition(context(admin), {
    code: 'business-' + randomUUID().slice(0, 8),
    orgUnitId: unit,
    spec,
  });
  const published = await service.publish(context(admin), draft.id, draft.revision);
  const secret = 'restricted-' + randomUUID(),
    note = 'review-only-' + randomUUID();
  const run = await service.start(context(requester), {
    definitionId: draft.id,
    versionId: published.version.id,
    unitId: unit,
    title: 'Ba dòng mua sắm',
    answers: {
      purpose: 'Thử bảng chi tiết',
      amount: 1,
      needed_on: '2026-12-01',
      confidential: secret,
      items: {
        rows: [
          {
            id: 'a',
            cells: { description: 'A', quantity: '3', unit_price: '0.10', amount: '9000' },
          },
        ],
        totals: { amount: '9999999' },
      },
    },
  });
  assert.equal((run.inputs.items as any).totals.amount, '0.30');
  const before = await service.detail(context(reviewer), run.id);
  assert.equal(before.run.inputs.confidential, secret);
  for (const who of [admin, reporter]) {
    const view = await service.detail(context(who), run.id);
    assert.equal(view.run.inputs.confidential, undefined);
    assert.equal(view.run.inputs.items, undefined);
    assert(!JSON.stringify(view).includes(secret));
    assert(
      view.history.every(
        (event) => !('checksum' in event.details) && !('answerChecksum' in event.details),
      ),
    );
    assert(
      !view.version.spec.input.sections
        .flatMap((s) => s.fields)
        .some((f) => f.id === 'confidential'),
    );
  }
  const task = before.tasks.find((t) => t.status === 'pending')!;
  await assert.rejects(
    () =>
      service.act(context(reviewer), task.id, {
        expectedRevision: task.revision,
        action: 'approve',
        answers: { internal_note: note },
      }),
    (error) =>
      error instanceof FormValidationError &&
      error.issues.some(
        (issue) => issue.path === 'answers.input.confidential' && issue.code === 'REQUIRED_ANSWER',
      ),
  );
  const revised = 'revised-' + randomUUID();
  await assert.rejects(
    () =>
      service.act(context(reviewer), task.id, {
        expectedRevision: task.revision,
        action: 'approve',
        answers: {
          internal_note: note,
          'input.confidential': revised,
          'input.items': run.inputs.items,
        },
      }),
    FormValidationError,
  );
  await service.act(context(reviewer), task.id, {
    expectedRevision: task.revision,
    action: 'approve',
    answers: { internal_note: note, 'input.confidential': revised },
  });
  const ownerView = await service.detail(context(requester), run.id);
  assert.equal(ownerView.run.inputs.confidential, secret);
  assert.equal(
    ownerView.tasks.find((row) => row.id === task.id)?.answers['input.confidential'],
    revised,
  );
  assert(!JSON.stringify(await service.detail(context(reporter), run.id)).includes(revised));
  const operation = await service.detail(context(operator), run.id);
  assert(!JSON.stringify(operation).includes(secret));
  assert(!JSON.stringify(operation).includes(note));
  assert(!JSON.stringify(operation).includes(revised));
  assert.equal(operation.tasks.find((t) => t.status === 'pending')!.node_id, 'fulfil');
  assert(!JSON.stringify(await service.detail(context(requester), run.id)).includes(note));
  const final = operation.tasks.find((t) => t.status === 'pending')!,
    command = context(operator);
  const request = {
    expectedRevision: final.revision,
    action: 'complete' as const,
    answers: { result_note: 'Đã thực hiện' },
  };
  for (let i = 0; i < 2; i++) {
    const completed = await service.act(command, final.id, request);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.inputs.confidential, undefined);
    assert.equal(completed.inputs.items, undefined);
  }
  const db = (
    await pool.query('SELECT inputs FROM workflow_run_inputs WHERE tenant_id=$1 AND run_id=$2', [
      tenant,
      run.id,
    ])
  ).rows[0];
  assert.equal(db.inputs.confidential, secret);
  candidates.delete(reviewer.accountId);
  await assert.rejects(() => service.detail(context(reviewer), run.id), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
  candidates.set(reviewer.accountId, reviewer);
});

test('A branch reads results of guaranteed prior steps in its current round and excludes protected outputs', async () => {
  const spec = workflowTemplate();
  spec.schemaVersion = 5;
  spec.audienceUnits = [unit];
  for (const node of spec.nodes)
    if ('assignee' in node)
      node.assignee = node.id === 'review' ? reviewer.accountId : operator.accountId;
  const review = spec.nodes.find((node) => node.id === 'review')!;
  assert('form' in review);
  review.form = {
    schemaVersion: 2,
    title: 'Kết quả rà soát',
    sections: [
      {
        id: 'check',
        title: 'Rà soát',
        fields: [{ id: 'confirmed_at', type: 'time', label: 'Giờ xác nhận', required: true }],
      },
    ],
  };
  const branch = spec.nodes.find((node) => node.kind === 'condition')!;
  branch.condition.rules = [
    { fieldCode: 'step.review.confirmed_at', operator: 'GREATER_THAN_OR_EQUAL', value: '17:00' },
  ];
  assert.throws(() => parseWorkflow({ ...spec, fieldReaders: { 'review.confirmed_at': [] } }), {
    code: 'WORKFLOW_INVALID_DEFINITION',
  });
  const skipped = structuredClone(spec);
  skipped.nodes.find((node) => node.kind === 'start')!.next = 'budget';
  skipped.nodes.find((node) => node.kind === 'condition')!.no = 'review';
  const skippedReview = skipped.nodes.find((node) => node.id === 'review')!;
  assert('form' in skippedReview);
  skippedReview.next = 'fulfil';
  assert.throws(() => parseWorkflow(skipped), {
    issues: [{ path: 'nodes.2.condition', code: 'INVALID_BRANCH_CONDITION' }],
  });
  const draft = await service.saveDefinition(context(admin), {
    code: 'branch-result-' + randomUUID().slice(0, 8),
    orgUnitId: unit,
    spec,
  });
  const published = await service.publish(context(admin), draft.id, draft.revision);
  const initial = { purpose: 'Rà soát vật tư', amount: 100, needed_on: '2026-12-01' };
  const run = await service.start(context(requester), {
    definitionId: draft.id,
    versionId: published.version.id,
    unitId: unit,
    title: 'Điều phối cuối ngày',
    answers: initial,
  });
  const pending = async (a: WorkflowActor) =>
    (await service.detail(context(a), run.id)).tasks.find((task) => task.status === 'pending')!;
  const approve = async (at: string) => {
    const task = await pending(reviewer);
    assert.equal(task.node_id, 'review');
    return service.act(context(reviewer), task.id, {
      expectedRevision: task.revision,
      action: 'approve',
      answers: { confirmed_at: at },
    });
  };
  assert.equal((await approve('18:00')).current_step, 'director');
  const finance = await pending(operator);
  const returned = await service.act(context(operator), finance.id, {
    expectedRevision: finance.revision,
    action: 'return',
    answers: {},
  });
  assert.equal(returned.status, 'needs_revision');
  const sent = await service.resubmit(context(requester), run.id, {
    expectedRevision: returned.revision,
    answers: initial,
  });
  assert.equal(sent.round, 2);
  assert.equal((await approve('09:00')).current_step, 'fulfil');
  const history = await service.detail(context(requester), run.id);
  assert.deepEqual(
    history.tasks
      .filter((task) => task.node_id === 'review')
      .map((task) => task.answers.confirmed_at),
    ['18:00', '09:00'],
  );
});

async function draftFixture() {
  const spec = workflowTemplate('blank');
  spec.audienceUnits = [unit];
  for (const node of spec.nodes) if ('assignee' in node) node.assignee = reviewer.accountId;
  const definition = await service.saveDefinition(context(admin), {
    code: 'draft-' + randomUUID().slice(0, 8),
    orgUnitId: unit,
    spec,
  });
  const published = await service.publish(context(admin), definition.id, definition.revision);
  return {
    published,
    input: {
      definitionId: definition.id,
      versionId: published.version.id,
      unitId: unit,
      title: 'Hồ sơ lưu dở',
      answers: {},
      selections: {},
    },
  };
}
test('Request drafts persist incomplete input, enforce owner/revision and submit atomically once under concurrency', async () => {
  const { published, input } = await draftFixture(),
    command = context(requester);
  const draft = await service.saveRequest(command, input);
  assert.equal((await service.saveRequest(command, input)).id, draft.id);
  assert((await service.requestDrafts(context(requester))).items.some((x) => x.id === draft.id));
  await assert.rejects(() => service.requestDraft(context(admin), draft.id), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
  await assert.rejects(
    () => service.requestDraft(context({ ...requester, permissions: [] }), draft.id),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  await assert.rejects(() => service.submitRequest(context(requester), draft.id, draft.revision));
  assert.equal((await service.requestDraft(context(requester), draft.id)).request.status, 'draft');
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS count FROM workflow_runs WHERE definition_id=$1', [
        input.definitionId,
      ])
    ).rows[0].count,
    0,
  );
  const complete = {
    ...input,
    answers: { purpose: 'Hồ sơ đã nhập đủ', requested_on: '2026-12-01' },
  };
  const saved = await service.saveRequest(context(requester), complete, draft.id, draft.revision);
  await assert.rejects(
    () => service.saveRequest(context(requester), complete, draft.id, draft.revision),
    { code: 'REVISION_CONFLICT' },
  );
  const submit = context(requester);
  const attempts = await Promise.allSettled([
    service.submitRequest(submit, draft.id, saved.revision),
    service.submitRequest(context(requester), draft.id, saved.revision),
  ]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  const request = (await service.requestDraft(context(requester), draft.id)).request;
  assert.equal(request.status, 'submitted');
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS count FROM workflow_runs WHERE definition_id=$1', [
        input.definitionId,
      ])
    ).rows[0].count,
    1,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS count FROM workflow_request_history WHERE request_id=$1',
        [draft.id],
      )
    ).rows[0].count,
    3,
  );
  if (attempts[0]!.status === 'fulfilled') {
    const next = await service.saveDefinition(
      context(admin),
      { code: published.definition.code, orgUnitId: unit, spec: published.version.spec },
      published.definition.id,
      published.definition.revision,
    );
    await service.publish(context(admin), next.id, next.revision);
    assert.equal(
      (await service.submitRequest(submit, draft.id, saved.revision)).id,
      request.run_id,
    );
  }
});
test('Draft submission rolls back run, request history and receipt if audit fails; stale versions preserve the draft', async () => {
  const { input, published } = await draftFixture();
  const draft = await service.saveRequest(context(requester), {
    ...input,
    answers: { purpose: 'Kiểm tra rollback', requested_on: '2026-12-01' },
  });
  const command = context(requester);
  await owner.query(
    "CREATE FUNCTION workflow_w1_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='request.submitted' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$",
  );
  await owner.query(
    'CREATE TRIGGER workflow_w1_audit_failure BEFORE INSERT ON workflow_audit FOR EACH ROW EXECUTE FUNCTION workflow_w1_audit_failure()',
  );
  try {
    await assert.rejects(() => service.submitRequest(command, draft.id, draft.revision));
  } finally {
    await owner.query('DROP TRIGGER workflow_w1_audit_failure ON workflow_audit');
    await owner.query('DROP FUNCTION workflow_w1_audit_failure()');
  }
  assert.equal((await service.requestDraft(context(requester), draft.id)).request.status, 'draft');
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS count FROM workflow_runs WHERE definition_id=$1', [
        input.definitionId,
      ])
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await pool.query('SELECT 1 FROM workflow_receipts WHERE idempotency_key=$1', [
        command.idempotencyKey,
      ])
    ).rowCount,
    0,
  );
  const saved = await service.saveDefinition(
    context(admin),
    { code: published.definition.code, orgUnitId: unit, spec: published.version.spec },
    published.definition.id,
    published.definition.revision,
  );
  await service.publish(context(admin), saved.id, saved.revision);
  assert.equal((await service.requestDraft(context(requester), draft.id)).canSubmit, false);
  await assert.rejects(() => service.submitRequest(command, draft.id, draft.revision), {
    code: 'WORKFLOW_VERSION_STALE',
  });
  assert.equal(
    (await service.requestDraft(context(requester), draft.id)).request.answers.purpose,
    'Kiểm tra rollback',
  );
  await assert.rejects(
    () => pool.query('UPDATE workflow_request_history SET title=title WHERE false'),
    { code: '42501' },
  );
});
