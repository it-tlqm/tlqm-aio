import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { Store } from '../src/store.js';
import { DirectoryMetadata } from '../src/management/metadata.js';
import type { MutationContext } from '../src/management/mutations.js';
import { directoryTransfer } from '../src/management/configuration-transfer.js';
import { workflowTransfer } from '../src/workflows/configuration-transfer.js';
import { LmsConfigurationTransfer } from '../src/lms/configuration-transfer.js';
import {
  boundedConfiguration,
  parseConfigurationPackage,
  makeConfigurationPackage,
  emptyReferenceOptions,
  signConfigurationReview,
  verifyConfigurationReview,
} from '../src/configuration-package.js';
import type { ConfigurationKind } from '../src/configuration-package.js';
import { ConfigurationTransfer } from '../src/configuration-transfer.js';
import { trainingFixture } from './fixtures/lms-training.js';
import { workflowConfigurationFixture } from './fixtures/workflow-configuration.js';
const runtime = await loadLocalConfig(),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 3 }),
  store = new Store(pool),
  metadata = new DirectoryMetadata(store);
const c = (subject: string = ids.admin): MutationContext => ({
  identity: {
    issuer: runtime.issuer,
    subject,
    authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ['pwd', 'otp'],
  },
  appCode: 'aio-foundation',
  tenantId: ids.tenantA,
  reason: 'Nhập cấu hình giả lập có đối chiếu',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
});
let original: unknown,
  lms: Awaited<ReturnType<typeof trainingFixture>>,
  wf: Awaited<ReturnType<typeof workflowConfigurationFixture>>;
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  original = (
    await metadata.configuration(
      await store.principal(c().identity, 'aio-foundation'),
      ids.tenantA,
      'people',
    )
  ).configuration!.draft;
  lms = await trainingFixture();
  wf = await workflowConfigurationFixture();
});
after(async () => {
  try {
    if (original) {
      const actor = await store.principal(c().identity, 'aio-foundation'),
        now = await metadata.configuration(actor, ids.tenantA, 'people');
      await metadata.saveConfiguration(
        c(),
        'people',
        original,
        Number(now.configuration!.revision),
      );
    }
  } finally {
    await pool.end();
    await lms?.mf.dispose();
    await wf?.pool.end();
  }
});
test('configuration package rejects foreign kind/version, oversized nesting and executable/prototype properties', () => {
  const pack = makeConfigurationPackage(
    'directory-people',
    'Hồ sơ',
    { schemaVersion: 1 },
    emptyReferenceOptions(),
  );
  assert.throws(() => parseConfigurationPackage({ ...pack, version: 2 }, 'directory-people'), {
    code: 'CONFIGURATION_PACKAGE_INVALID',
  });
  assert.throws(() => parseConfigurationPackage(pack, 'workflow'), {
    code: 'CONFIGURATION_PACKAGE_INVALID',
  });
  assert.throws(() => boundedConfiguration(JSON.parse('{"__proto__":{"polluted":true}}')), {
    code: 'CONFIGURATION_INVALID',
  });
  let deep: unknown = {};
  for (let i = 0; i < 22; i++) deep = { child: deep };
  assert.throws(() => boundedConfiguration(deep), { code: 'CONFIGURATION_TOO_LARGE' });
  assert.throws(() => boundedConfiguration({ text: 'x'.repeat(270000) }), {
    code: 'CONFIGURATION_TOO_LARGE',
  });
  assert.throws(() => boundedConfiguration({ run: () => true }), { code: 'CONFIGURATION_INVALID' });
});
test('signed review is bound to payload and environment; another authorized actor cannot reuse it', async () => {
  const payload = {
      kind: 'lms-path' as const,
      target: randomUUID(),
      tenantId: randomUUID(),
      accountId: randomUUID(),
      personId: randomUUID(),
      revision: 1,
      content: { title: 'A' },
      metadata: {},
    },
    secret = 'local-domain-test-key',
    review = await signConfigurationReview(secret, 'environment-a', payload);
  assert.deepEqual(await verifyConfigurationReview(secret, 'environment-a', review), payload);
  await assert.rejects(() => verifyConfigurationReview(secret, 'environment-b', review), {
    code: 'CONFIGURATION_REVIEW_INVALID',
  });
  await assert.rejects(
    () =>
      verifyConfigurationReview(secret, 'environment-a', {
        ...review,
        payload: { ...payload, content: { title: 'Changed' } },
      }),
    { code: 'CONFIGURATION_REVIEW_INVALID' },
  );
  let writes = 0;
  const transfer = new ConfigurationTransfer('lms-path', payload.target, secret, 'environment-a', {
    read: async () => ({ ...payload, accountId: randomUUID(), label: 'Test' }),
    normalize: (v) => v,
    options: async () => emptyReferenceOptions(),
    write: async () => {
      writes++;
      return {};
    },
  });
  await assert.rejects(() => transfer.apply(review), {
    code: 'CONFIGURATION_REVIEW_OWNER_MISMATCH',
  });
  assert.equal(writes, 0);
});
test('Directory import is preview-only until explicit apply, uses CAS/idempotency and preserves published schema', async () => {
  const command = c(),
    transfer = directoryTransfer(
      store,
      command,
      'directory-people',
      'current',
      runtime.encryptionKey,
      'test-directory-transfer',
    ),
    actor = await store.principal(command.identity, 'aio-foundation'),
    before = await metadata.configuration(actor, ids.tenantA, 'people'),
    pack = await transfer.export();
  (pack.content as any).schema.title = 'Hồ sơ nhập thử';
  const preview = await transfer.preview(pack, []);
  assert.ok(preview.changes.length);
  assert.equal(
    (await metadata.configuration(actor, ids.tenantA, 'people')).configuration!.revision,
    before.configuration!.revision,
  );
  const result = await transfer.apply(preview.review);
  assert.deepEqual(await transfer.apply(preview.review), result);
  const after = await metadata.configuration(actor, ids.tenantA, 'people');
  assert.equal(after.configuration!.currentVersion, before.configuration!.currentVersion);
  assert.equal(after.versions.length, before.versions.length);
  await assert.rejects(
    () =>
      directoryTransfer(
        store,
        c(),
        'directory-people',
        'current',
        runtime.encryptionKey,
        'test-directory-transfer',
      ).apply(preview.review),
    { code: 'REVISION_CONFLICT' },
  );
  const rollback = directoryTransfer(
    store,
    c(),
    'directory-people',
    'current',
    runtime.encryptionKey,
    'test-directory-transfer',
  );
  await rollback.apply((await rollback.preview(preview.backup, [])).review);
  assert.deepEqual(
    (await metadata.configuration(actor, ids.tenantA, 'people')).configuration!.draft,
    preview.backup.content,
  );
});
test('Directory rights and immutable field types remain enforced on imports for every resource', async () => {
  await assert.rejects(
    () =>
      directoryTransfer(
        store,
        c(ids.learner),
        'directory-people',
        'current',
        runtime.encryptionKey,
        'test-directory-transfer',
      ).export(),
    { code: 'PERMISSION_DENIED' },
  );
  for (const resource of ['org-units', 'job-titles', 'positions']) {
    const actor = await store.principal(c().identity, 'aio-foundation'),
      before = await metadata.configuration(actor, ids.tenantA, resource),
      initial = {
        schema: {
          schemaVersion: 1,
          title: 'Thông tin ' + resource,
          sections: [
            {
              id: 'general',
              title: 'Thông tin',
              fields: [
                {
                  id: 'note',
                  type: 'longText',
                  label: 'Ghi chú',
                  required: false,
                  maxLength: 2000,
                },
              ],
            },
          ],
        },
        selfView: [],
        selfEdit: [],
      };
    if (!before.configuration) await metadata.saveConfiguration(c(), resource, initial, 0);
    const transfer = directoryTransfer(
        store,
        c(),
        ('directory-' + resource) as ConfigurationKind,
        'current',
        runtime.encryptionKey,
        'test-directory-transfer',
      ),
      pack = await transfer.export();
    const restore = structuredClone(pack);
    (pack.content as any).schema.title += ' đã nhập';
    await transfer.apply((await transfer.preview(pack, [])).review);
    const reset = directoryTransfer(
      store,
      c(),
      ('directory-' + resource) as ConfigurationKind,
      'current',
      runtime.encryptionKey,
      'test-directory-transfer',
    );
    await reset.apply((await reset.preview(restore, [])).review);
    (pack.content as any).selfView = ['note'];
    await assert.rejects(() => transfer.preview(pack, []), {
      code: 'PROFILE_CONFIGURATION_INVALID',
    });
  }
  const transfer = directoryTransfer(
      store,
      c(),
      'directory-people',
      'current',
      runtime.encryptionKey,
      'test-directory-transfer',
    ),
    pack = await transfer.export();
  const field = (pack.content as any).schema.sections[0].fields[0];
  field.type = 'number';
  delete field.maxLength;
  delete field.minLength;
  await assert.rejects(() => transfer.preview(pack, []), { code: 'PROFILE_FIELD_TYPE_IMMUTABLE' });
});
test('workflow import requires explicit live reference mapping and never changes a published version or running task', async () => {
  const run = await wf.service.start(wf.c(), {
      definitionId: wf.published.definition.id,
      versionId: wf.published.version.id,
      unitId: wf.unit,
      title: 'Lượt giữ phiên bản',
      answers: { purpose: 'Nghiệp vụ giả lập', requested_on: '2026-11-11' },
    }),
    before = await wf.service.detail(wf.c(), run.id),
    command = wf.c(),
    transfer = workflowTransfer(
      wf.service,
      command,
      wf.published.definition.id,
      runtime.encryptionKey,
      'workflow-transfer',
      wf.lookups,
    ),
    pack = await transfer.export(),
    foreignUnit = randomUUID();
  (pack.content as any).name = 'Tên nhập mới';
  (pack.content as any).audienceUnits = [foreignUnit];
  await assert.rejects(() => transfer.preview(pack, []), {
    code: 'CONFIGURATION_REFERENCE_UNAVAILABLE',
  });
  const review = await transfer.preview(pack, [{ type: 'unit', from: foreignUnit, to: wf.unit }]);
  const result = await transfer.apply(review.review);
  assert.deepEqual(await transfer.apply(review.review), result);
  const after = await wf.service.detail(wf.c(), run.id);
  assert.deepEqual(after.version, before.version);
  assert.deepEqual(after.tasks, before.tasks);
  const noDesign = { ...wf.designer, permissions: [] };
  await assert.rejects(
    () =>
      workflowTransfer(
        wf.service,
        wf.c(noDesign),
        wf.published.definition.id,
        runtime.encryptionKey,
        'workflow-transfer',
        wf.lookups,
      ).apply(review.review),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
});
test('LMS course import protects answer keys, writes only draft and restores from the offered backup', async () => {
  const fixture = await lms.makeBatch(),
    source = new LmsConfigurationTransfer(
      lms.db,
      async () => lms.administrator,
      lms.directory,
      lms.config,
    ),
    courseId = fixture.course.id,
    transfer = source.service('lms-course', courseId, lms.command()),
    pack = await transfer.export(),
    published = await lms.learn.detail(fixture.course.versionId);
  assert.ok((pack.content as any).answerKey.q);
  (pack.content as any).title = 'Khóa nhập cấu hình';
  (pack.content as any).policy.passScore = 65;
  const preview = await transfer.preview(pack, []),
    result = await transfer.apply(preview.review);
  assert.deepEqual(await transfer.apply(preview.review), result);
  assert.deepEqual(await lms.learn.detail(fixture.course.versionId), published);
  await assert.rejects(
    () =>
      new LmsConfigurationTransfer(lms.db, async () => lms.student, lms.directory, lms.config)
        .service('lms-course', courseId, lms.command())
        .export(),
    { code: 'LMS_PERMISSION_DENIED' },
  );
  const rollback = source.service('lms-course', courseId, lms.command());
  await rollback.apply((await rollback.preview(preview.backup, [])).review);
  assert.deepEqual((await rollback.export()).content, preview.backup.content);
});
test('LMS path import retains enrollment/version history and rejects unresolved or cross-audience course versions', async () => {
  const fixture = await lms.makeBatch(),
    row = await lms.db
      .prepare('SELECT path_id FROM lms_learning_path_versions WHERE id=?')
      .bind(fixture.input.pathVersionId)
      .first<{ path_id: string }>(),
    service = new LmsConfigurationTransfer(
      lms.db,
      async () => lms.administrator,
      lms.directory,
      lms.config,
    ),
    transfer = service.service('lms-path', row!.path_id, lms.command()),
    pack = await transfer.export(),
    before = await lms.learn.batch(fixture.batch.id),
    unknown = randomUUID();
  (pack.content as any).title = 'Lộ trình nhập';
  (pack.content as any).courseVersionIds = [unknown];
  await assert.rejects(() => transfer.preview(pack, []), {
    code: 'CONFIGURATION_REFERENCE_UNAVAILABLE',
  });
  const preview = await transfer.preview(pack, [
    { type: 'courseVersion', from: unknown, to: fixture.course.versionId },
  ]);
  await transfer.apply(preview.review);
  assert.deepEqual(await lms.learn.batch(fixture.batch.id), before);
});
test('import uses the native atomic audit/receipt boundary and rejects modified review content', async () => {
  const fixture = await lms.makeBatch(),
    source = new LmsConfigurationTransfer(
      lms.db,
      async () => lms.administrator,
      lms.directory,
      lms.config,
    ),
    command = lms.command(),
    transfer = source.service('lms-course', fixture.course.id, command),
    pack = await transfer.export();
  (pack.content as any).title = 'Nhập có kiểm tra audit';
  const preview = await transfer.preview(pack, []);
  const tampered = structuredClone(preview.review);
  (tampered.payload.content as any).title = 'Nội dung thay ngoài xem trước';
  await assert.rejects(() => transfer.apply(tampered), { code: 'CONFIGURATION_REVIEW_INVALID' });
  const before = await lms.db
    .prepare('SELECT revision FROM lms_courses WHERE id=?')
    .bind(fixture.course.id)
    .first<{ revision: number }>();
  await lms.db
    .prepare(
      "CREATE TRIGGER config_import_audit_failure BEFORE INSERT ON aio_audit WHEN NEW.action='course.draft_saved' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END",
    )
    .run();
  try {
    await assert.rejects(() => transfer.apply(preview.review));
    assert.deepEqual(
      await lms.db
        .prepare('SELECT revision FROM lms_courses WHERE id=?')
        .bind(fixture.course.id)
        .first<{ revision: number }>(),
      before,
    );
  } finally {
    await lms.db.prepare('DROP TRIGGER config_import_audit_failure').run();
  }
  await transfer.apply(preview.review);
  assert.equal(
    (await transfer.export()).content &&
      (await lms.db
        .prepare('SELECT revision FROM lms_courses WHERE id=?')
        .bind(fixture.course.id)
        .first<{ revision: number }>())!.revision,
    before!.revision + 1,
  );
});
