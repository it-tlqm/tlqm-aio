import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { formsDatabaseUrl, loadFormsConfig } from '../src/forms/database.js';
import { FormsService } from '../src/forms/service.js';
import type { SubmissionRow } from '../src/forms/service.js';
import { HttpError } from '../src/security.js';
import type { FormsActor, FormsCommandContext, FormsPermission } from '../src/forms/access.js';

const runtime = await loadLocalConfig();
const config = await loadFormsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: formsDatabaseUrl(config, true), max: 5 });
const owner = new pg.Pool({ connectionString: formsDatabaseUrl(config, true, true), max: 1 });
const tenant = randomUUID(),
  tenantOther = randomUUID(),
  unitA = randomUUID(),
  unitB = randomUUID();
function actor(
  permissions: FormsPermission[],
  unit: string | null = null,
  accountId = randomUUID(),
): FormsActor {
  return {
    appCode: 'aio-forms',
    accountId,
    personId: randomUUID(),
    tenantIds: [tenant],
    units: [{ tenantId: tenant, orgUnitId: unit ?? unitA }],
    permissions: permissions.map((permission) => ({
      permission,
      tenantId: tenant,
      orgUnitId: unit,
    })),
  };
}
const designer = actor(['forms:design']);
const publisher = actor(['forms:publish']);
const respondentA = actor(['forms:respond'], unitA);
const respondentB = actor(['forms:respond'], unitB);
const outsider = actor(['forms:respond'], unitA);
const reviewer = actor(['forms:review'], unitA);
const members = new Map(
  [designer, publisher, respondentA, respondentB, outsider, reviewer].map((item) => [
    item.accountId,
    item,
  ]),
);
const service = new FormsService(pool, {
  async validateTargets(tenantId, scope, targets) {
    if (tenantId !== tenant) throw new HttpError(400, 'FORM_REFERENCE_DENIED');
    for (const target of targets) {
      if (target.kind === 'unit') {
        if (
          ![unitA, unitB].some((id) => id === target.id) ||
          (scope !== null && target.id !== scope)
        )
          throw new HttpError(400, 'FORM_REFERENCE_DENIED');
      } else {
        const member = members.get(target.id);
        if (!member || (scope && !member.units.some((unit) => unit.orgUnitId === scope)))
          throw new HttpError(400, 'FORM_REFERENCE_DENIED');
      }
    }
  },
});
const baseSchema = () => ({
  schemaVersion: 1,
  title: 'Khảo sát local',
  sections: [
    {
      id: 'main',
      title: 'Thông tin',
      fields: [{ id: 'detail', label: 'Nội dung', type: 'shortText', required: true }],
    },
  ],
});
function context(
  value: FormsActor,
  overrides: Partial<FormsCommandContext> = {},
): FormsCommandContext {
  return {
    tenantId: tenant,
    actor: async () => structuredClone(value),
    reason: 'Kiểm thử Forms giả lập',
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}
async function setup(maxSubmissions = 1) {
  const created = await service.create(context(designer), {
    code: 'test-' + randomUUID().slice(0, 8),
    schema: baseSchema(),
    orgUnitId: null,
    maxSubmissions,
  });
  const audience = await service.setAudience(
    context(publisher),
    created.id,
    created.revision,
    [respondentA, respondentB].map((person) => ({
      kind: 'account',
      targetId: person.accountId,
      opensAt: '2020-01-01T00:00:00Z',
      closesAt: null,
    })),
  );
  return service.publish(context(publisher), created.id, audience.form.revision);
}
function submit(versionId: string, unit = unitA, sent = true) {
  return { versionId, orgUnitId: unit, submit: sent, answers: { detail: 'Dữ liệu giả lập' } };
}
before(async () => {
  assert.deepEqual((await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-forms-test' },
  ]);
});
after(async () => {
  await pool.end();
  await owner.end();
});

test('Forms runtime is separate, cannot reach Identity, mutate migrations or rewrite published history', async () => {
  const dbRole = (
    await pool.query(
      "SELECT current_user AS role,has_database_privilege(current_user,'aio_foundation','CONNECT') AS identity_access,has_database_privilege(current_user,'aio_foundation_test','CONNECT') AS test_identity_access",
    )
  ).rows[0];
  assert.deepEqual(dbRole, {
    role: 'aio_forms_runtime',
    identity_access: false,
    test_identity_access: false,
  });
  for (const sql of [
    'CREATE TABLE forbidden_forms(id integer)',
    'DELETE FROM submissions WHERE false',
    'UPDATE schema_migrations SET checksum=checksum',
    'DELETE FROM form_audit WHERE false',
    'UPDATE form_versions SET checksum=checksum',
    'UPDATE form_receipts SET operation=operation',
  ])
    await assert.rejects(() => pool.query(sql), { code: '42501' });
  const { version } = await setup();
  await assert.rejects(
    () => owner.query('UPDATE form_versions SET schema=schema WHERE id=$1', [version.id]),
    { code: '42501' },
  );
});

test('Forms separates designer and publisher, idempotent mutations, current authorization and tenant boundaries', async () => {
  const request = context(designer),
    input = {
      code: 'test-' + randomUUID().slice(0, 8),
      schema: baseSchema(),
      orgUnitId: null,
      maxSubmissions: 1,
    };
  const created = await service.create(request, input);
  assert.deepEqual(await service.create(request, input), created);
  assert.equal(
    (await pool.query('SELECT 1 FROM form_audit WHERE request_id=$1', [request.requestId]))
      .rowCount,
    1,
  );
  await assert.rejects(() => service.create(request, { ...input, maxSubmissions: 2 }), {
    code: 'IDEMPOTENCY_KEY_REUSED',
  });
  await assert.rejects(() => service.publish(context(designer), created.id, created.revision), {
    code: 'FORMS_PERMISSION_DENIED',
  });
  await assert.rejects(
    () => service.saveDraft(context(publisher), created.id, created.revision, baseSchema()),
    { code: 'FORMS_PERMISSION_DENIED' },
  );
  await assert.rejects(
    () =>
      service.create({ ...request, actor: async () => ({ ...designer, permissions: [] }) }, input),
    { code: 'FORMS_PERMISSION_DENIED' },
  );
  await assert.rejects(
    () => service.detail(context(designer, { tenantId: tenantOther }), created.id),
    { code: 'FORMS_PERMISSION_DENIED' },
  );
  await assert.rejects(
    () =>
      service.detail(
        context({ ...designer, tenantIds: [tenantOther] }, { tenantId: tenantOther }),
        created.id,
      ),
    { code: 'FORM_NOT_FOUND' },
  );
});

test('Forms draft concurrency keeps one revision winner and rolls back when audit fails or access is revoked before commit', async () => {
  const { form } = await setup();
  const results = await Promise.allSettled([
    service.saveDraft(context(designer), form.id, form.revision, { ...baseSchema(), title: 'A' }),
    service.saveDraft(context(designer), form.id, form.revision, { ...baseSchema(), title: 'B' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && rejected.reason.code === 'REVISION_CONFLICT');
  const code = 'test-' + randomUUID().slice(0, 8);
  const badAudit = context(designer, { requestId: null as unknown as string });
  await assert.rejects(
    () =>
      service.create(badAudit, { code, schema: baseSchema(), orgUnitId: null, maxSubmissions: 1 }),
    { code: '23502' },
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM forms WHERE tenant_id=$1 AND code=$2', [tenant, code]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query('SELECT 1 FROM form_receipts WHERE idempotency_key=$1', [
        badAudit.idempotencyKey,
      ])
    ).rowCount,
    0,
  );
  let calls = 0;
  const revoked = context(designer, {
    actor: async () =>
      ++calls === 1 ? structuredClone(designer) : { ...designer, permissions: [] },
  });
  await assert.rejects(
    () =>
      service.create(revoked, { code, schema: baseSchema(), orgUnitId: null, maxSubmissions: 1 }),
    { code: 'FORMS_PERMISSION_DENIED' },
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM forms WHERE tenant_id=$1 AND code=$2', [tenant, code]))
      .rowCount,
    0,
  );
});

test('Forms audience, unit selection, hidden payload, idempotency and response limits are enforced server-side', async () => {
  const { form, version } = await setup();
  await assert.rejects(
    () => service.saveSubmission(context(outsider), form.id, submit(version.id)),
    { code: 'FORM_AUDIENCE_DENIED' },
  );
  await assert.rejects(
    () => service.saveSubmission(context(respondentA), form.id, submit(version.id, unitB)),
    { code: 'FORMS_PERMISSION_DENIED' },
  );
  await assert.rejects(
    () =>
      service.saveSubmission(context(respondentA), form.id, {
        ...submit(version.id),
        answers: { detail: 'OK', role: 'admin' },
      }),
    { code: 'FORM_VALIDATION_FAILED' },
  );
  const request = context(respondentA);
  const results = await Promise.all([
    service.saveSubmission(request, form.id, submit(version.id)),
    service.saveSubmission(request, form.id, submit(version.id)),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(
    (await pool.query('SELECT 1 FROM form_audit WHERE request_id=$1', [request.requestId]))
      .rowCount,
    1,
  );
  await assert.rejects(
    () => service.saveSubmission(context(respondentA), form.id, submit(version.id)),
    { code: 'FORM_SUBMISSION_LIMIT' },
  );
  await assert.rejects(
    () => pool.query("UPDATE submissions SET answers='{}' WHERE id=$1", [results[0].id]),
    { code: '23514' },
  );
});

test('Forms versions preserve v1 drafts/answers when v2 publishes; new drafts cannot select an outdated version', async () => {
  const { form, version: v1 } = await setup(3);
  const draft = await service.saveSubmission(
    context(respondentA),
    form.id,
    submit(v1.id, unitA, false),
  );
  const changed = baseSchema();
  changed.sections[0]!.fields[0]!.label = 'Nhãn v2';
  const v2draft = await service.saveDraft(context(designer), form.id, form.revision, changed);
  const { version: v2 } = await service.publish(context(publisher), form.id, v2draft.revision);
  assert.notEqual(v1.id, v2.id);
  assert.equal(v1.schema.sections[0]!.fields[0]!.label, 'Nội dung');
  assert.equal(v2.schema.sections[0]!.fields[0]!.label, 'Nhãn v2');
  const sent = await service.saveSubmission(
    context(respondentA),
    form.id,
    submit(v1.id),
    draft.id,
    draft.revision,
  );
  assert.equal(sent.version_id, v1.id);
  const history = (await service.submissions(
    context(respondentA),
    form.id,
    true,
  )) as (SubmissionRow & { version_schema: typeof v1.schema })[];
  assert.equal(history[0]!.version_schema.sections[0]!.fields[0]!.label, 'Nội dung');
  await assert.rejects(
    () => service.saveSubmission(context(respondentB), form.id, submit(v1.id, unitB)),
    { code: 'FORM_VERSION_STALE' },
  );
});

test('Forms version closure denies old draft submit; cancellation preserves history and permits a fresh draft', async () => {
  const { form, version: v1 } = await setup();
  const draft = await service.saveSubmission(
    context(respondentA),
    form.id,
    submit(v1.id, unitA, false),
  );
  const newDraft = await service.saveDraft(context(designer), form.id, form.revision, baseSchema());
  const { version: v2, form: changed } = await service.publish(
    context(publisher),
    form.id,
    newDraft.revision,
  );
  await service.closeVersion(context(publisher), form.id, v1.id, changed.revision);
  await assert.rejects(
    () =>
      service.saveSubmission(
        context(respondentA),
        form.id,
        submit(v1.id),
        draft.id,
        draft.revision,
      ),
    { code: 'FORM_VERSION_CLOSED' },
  );
  await assert.rejects(
    () => service.cancelDraft(context(respondentB), form.id, draft.id, draft.revision),
    { code: 'FORM_SUBMISSION_NOT_FOUND' },
  );
  const cancelled = await service.cancelDraft(
    context(respondentA),
    form.id,
    draft.id,
    draft.revision,
  );
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(
    () => pool.query("UPDATE submissions SET status='draft' WHERE id=$1", [draft.id]),
    { code: '23514' },
  );
  const newResponse = await service.saveSubmission(context(respondentA), form.id, submit(v2.id));
  assert.equal(newResponse.status, 'submitted');
  assert.equal((await service.submissions(context(respondentA), form.id, true)).length, 2);
});

test('Forms unit-scoped reviewer cannot read another unit, authors cannot read answers, close/archive retain history', async () => {
  const { form, version } = await setup();
  const a = await service.saveSubmission(context(respondentA), form.id, submit(version.id));
  await service.saveSubmission(context(respondentB), form.id, submit(version.id, unitB));
  assert.deepEqual(
    (await service.submissions(context(reviewer), form.id)).map((row) => row.id),
    [a.id],
  );
  await assert.rejects(() => service.submissions(context(designer), form.id), {
    code: 'FORMS_PERMISSION_DENIED',
  });
  const closed = await service.setStatus(context(publisher), form.id, form.revision, 'closed');
  await assert.rejects(
    () => service.saveSubmission(context(respondentA), form.id, submit(version.id)),
    { code: 'FORM_CLOSED' },
  );
  assert.equal((await service.submissions(context(reviewer), form.id)).length, 1);
  await service.setStatus(context(publisher), form.id, closed.revision, 'archived');
  assert.equal((await service.submissions(context(respondentA), form.id, true)).length, 1);
});

test('Forms group membership and audience windows are live; group changes cannot cross the group scope', async () => {
  const { form, version } = await setup();
  const group = await service.saveGroup(context(publisher), {
    name: 'Nhóm giả lập',
    orgUnitId: unitA,
    accountIds: [respondentA.accountId],
    active: true,
  });
  const assigned = await service.setAudience(context(publisher), form.id, form.revision, [
    { kind: 'group', targetId: group.id, opensAt: '2020-01-01T00:00:00Z', closesAt: null },
  ]);
  const draft = await service.saveSubmission(
    context(respondentA),
    form.id,
    submit(version.id, unitA, false),
  );
  await service.saveGroup(
    context(publisher),
    { name: 'Nhóm giả lập', orgUnitId: unitA, accountIds: [], active: true },
    group.id,
    group.revision,
  );
  await assert.rejects(
    () =>
      service.saveSubmission(
        context(respondentA),
        form.id,
        submit(version.id),
        draft.id,
        draft.revision,
      ),
    { code: 'FORM_AUDIENCE_DENIED' },
  );
  await assert.rejects(
    () =>
      service.saveGroup(context(publisher), {
        name: 'Sai phạm vi',
        orgUnitId: unitA,
        accountIds: [respondentB.accountId],
        active: true,
      }),
    { code: 'FORM_REFERENCE_DENIED' },
  );
  await service.setAudience(context(publisher), form.id, assigned.form.revision, [
    {
      kind: 'unit',
      targetId: unitA,
      opensAt: '2020-01-01T00:00:00Z',
      closesAt: '2020-02-01T00:00:00Z',
    },
  ]);
  await assert.rejects(
    () =>
      service.saveSubmission(
        context(respondentA),
        form.id,
        submit(version.id),
        draft.id,
        draft.revision,
      ),
    { code: 'FORM_AUDIENCE_DENIED' },
  );
});

test('Forms audit contains lifecycle/checksum metadata without copying submission answers', async () => {
  const { form, version } = await setup();
  const marker = 'PRIVATE-ANSWER-' + randomUUID();
  await service.saveSubmission(context(respondentA), form.id, {
    ...submit(version.id),
    answers: { detail: marker },
  });
  const events = (
    await pool.query(
      'SELECT action,details FROM form_audit WHERE tenant_id=$1 AND form_id=$2 ORDER BY id',
      [tenant, form.id],
    )
  ).rows;
  assert.ok(events.some((event) => event.action === 'form.published'));
  assert.ok(events.some((event) => event.action === 'form.submission.sent'));
  assert.ok(!JSON.stringify(events).includes(marker));
});

test('Forms reports and CSV filter current unit scopes; export audits metadata without caching answers', async () => {
  const { form, version } = await setup();
  await service.saveSubmission(context(respondentA), form.id, {
    ...submit(version.id),
    answers: { detail: '=1+2' },
  });
  await service.saveSubmission(context(respondentB), form.id, {
    ...submit(version.id, unitB),
    answers: { detail: 'UNIT-B-PRIVATE' },
  });
  const analyst = actor(['forms:analyze', 'forms:export'], unitA);
  const report = await service.report(context(analyst), form.id);
  assert.equal(report.total, 1);
  assert.deepEqual(report.byUnit, [{ orgUnitId: unitA, count: 1 }]);
  assert.ok(!JSON.stringify(report).includes('UNIT-B-PRIVATE'));
  await assert.rejects(() => service.report(context(reviewer), form.id), {
    code: 'FORMS_PERMISSION_DENIED',
  });
  await assert.rejects(() => service.export(context(reviewer), form.id, version.id), {
    code: 'FORMS_PERMISSION_DENIED',
  });
  const request = context(analyst);
  const file = await service.export(request, form.id, version.id);
  assert.equal(file.rows, 1);
  assert.ok(file.csv.includes('"text: =1+2"'));
  assert.ok(!file.csv.includes('UNIT-B-PRIVATE'));
  const audit = (
    await pool.query('SELECT action,details FROM form_audit WHERE request_id=$1', [
      request.requestId,
    ])
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'form.exported');
  assert.equal(audit[0].details.rows, 1);
  assert.ok(!JSON.stringify(audit).includes('=1+2'));
  assert.equal(
    (
      await pool.query('SELECT 1 FROM form_receipts WHERE idempotency_key=$1', [
        request.idempotencyKey,
      ])
    ).rowCount,
    0,
  );
  let calls = 0;
  await assert.rejects(
    () =>
      service.export(
        context(analyst, {
          actor: async () => (++calls === 1 ? analyst : { ...analyst, permissions: [] }),
        }),
        form.id,
        version.id,
      ),
    { code: 'FORMS_PERMISSION_DENIED' },
  );
});

test('Forms retained own history does not expose unassigned later versions or unpublished titles', async () => {
  const { form, version } = await setup(2);
  await service.saveSubmission(context(respondentA), form.id, submit(version.id));
  const next = await service.saveDraft(context(designer), form.id, form.revision, {
    ...baseSchema(),
    title: 'Unpublished title',
  });
  assert.equal((await service.detail(context(respondentA), form.id)).form.title, 'Khảo sát local');
  assert.equal((await service.detail(context(reviewer), form.id)).form.title, 'Khảo sát local');
  const changed = await service.publish(context(publisher), form.id, next.revision);
  await service.setAudience(context(publisher), form.id, changed.form.revision, []);
  const history = await service.detail(context(respondentA), form.id);
  assert.deepEqual(
    history.versions.map((version) => version.id),
    [version.id],
  );
  assert.deepEqual(history.responseUnits, []);
  assert.equal(history.form.title, 'Khảo sát local');
  assert.ok((await service.list(context(respondentA))).some((row) => row.id === form.id));
  await assert.rejects(
    () => service.saveSubmission(context(respondentA), form.id, submit(changed.version.id)),
    { code: 'FORM_AUDIENCE_DENIED' },
  );
  await assert.rejects(() => service.detail(context(respondentB), form.id), {
    code: 'FORM_AUDIENCE_DENIED',
  });
  await assert.rejects(
    () => service.detail(context({ ...respondentA, permissions: [] }), form.id),
    { code: 'FORM_AUDIENCE_DENIED' },
  );
});

test('Forms cursor pages remain tenant/scope filtered and do not lose equal-timestamp records', async () => {
  // Extra synthetic rows exercise pagination; the owner connection is guarded by the test marker.
  await owner.query(
    "INSERT INTO forms(id,tenant_id,code,title,owner_account_id,draft_schema) SELECT gen_random_uuid(),$1,'page-'||gen_random_uuid(),'Page fixture',$2,$3 FROM generate_series(1,102)",
    [tenant, designer.accountId, JSON.stringify(baseSchema())],
  );
  const first = await service.listPage(context(designer));
  assert.equal(first.items.length, 100);
  assert.ok(first.nextCursor);
  const second = await service.listPage(context(designer), first.nextCursor);
  assert.ok(second.items.length >= 2);
  assert.equal(
    new Set([...first.items, ...second.items].map((row) => row.id)).size,
    first.items.length + second.items.length,
  );
  assert.ok([...first.items, ...second.items].every((row) => row.tenant_id === tenant));
  const { form, version } = await setup(100);
  await owner.query(
    "INSERT INTO submissions(id,tenant_id,form_id,version_id,account_id,person_id,org_unit_id,status,answers,submitted_at) SELECT gen_random_uuid(),$1,$2,$3,$4,$5,$6,'submitted','{}',now() FROM generate_series(1,100)",
    [tenant, form.id, version.id, respondentA.accountId, respondentA.personId, unitA],
  );
  await service.saveSubmission(context(respondentB), form.id, submit(version.id, unitB));
  const scoped = await service.submissionsPage(context(reviewer), form.id);
  assert.equal(scoped.items.length, 100);
  assert.equal(scoped.nextCursor, null);
  assert.ok(scoped.items.every((row) => row.org_unit_id === unitA));
  const allReviewer = actor(['forms:review']);
  const allFirst = await service.submissionsPage(context(allReviewer), form.id);
  assert.ok(allFirst.nextCursor);
  const allSecond = await service.submissionsPage(
    context(allReviewer),
    form.id,
    false,
    allFirst.nextCursor,
  );
  assert.equal(allFirst.items.length + allSecond.items.length, 101);
  assert.equal(new Set([...allFirst.items, ...allSecond.items].map((row) => row.id)).size, 101);
  const own = await service.submissionsPage(context(respondentA), form.id, true);
  assert.equal(own.submittedCount, 100);
  assert.ok(own.items.every((row) => row.account_id === respondentA.accountId));
  await assert.rejects(
    () =>
      service.submissionsPage(
        context({ ...reviewer, tenantIds: [tenantOther] }, { tenantId: tenantOther }),
        form.id,
        false,
        allFirst.nextCursor!,
      ),
    { code: 'FORM_NOT_FOUND' },
  );
});
