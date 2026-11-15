import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import type { Page, APIResponse } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../src/app.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp } from './local-totp.js';
import type { FormsFixture } from './forms-fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { defaultLearningPolicy } from '../src/lms/learning-policy.js';
import type { ConfigurationPackage } from '../src/configuration-package.js';
type Row = Record<string, any>;
const runtime = await loadLocalConfig(),
  A = 'http://127.0.0.1:4100',
  W = 'http://127.0.0.1:4105',
  L = 'http://127.0.0.1:4104',
  suffix = randomUUID().slice(0, 8),
  browser = await chromium.launch({ headless: true }),
  servers: FastifyInstance[] = [],
  scans: Row[] = [];
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixtures.users.find((u) => u.role === name)!;
let current: Page | undefined,
  stage = 'startup',
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined,
  admin: Awaited<ReturnType<typeof login>> | undefined,
  author: Awaited<ReturnType<typeof login>> | undefined,
  publisher: Awaited<ReturnType<typeof login>> | undefined,
  original: Row | undefined,
  definitionId: string | undefined,
  courseId: string | undefined;
async function json(r: APIResponse, expected = 200) {
  const b = await r.json();
  if (r.status() !== expected)
    throw new Error(
      'HTTP_' + r.status() + '_' + (/^[A-Z0-9_]+$/.test(b.error ?? '') ? b.error : 'UNEXPECTED'),
    );
  return b as Row;
}
async function login(
  base: string,
  user: { id: string; username: string; password: string },
  mfa = false,
) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    }),
    page = await context.newPage();
  current = page;
  await context.addInitScript(() => {
    (window as Window & { csp?: string[] }).csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as Window & { csp?: string[] }).csp?.push(e.violatedDirective),
    );
  });
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL(base + '/');
  return { context, page, me: await json(await context.request.get(base + '/api/v1/me')) };
}
type Session = Awaited<ReturnType<typeof login>>;
async function write(s: Session, base: string, path: string, data: Row, expected = 200) {
  return json(
    await s.context.request.post(base + path, {
      headers: { origin: base, 'x-csrf-token': s.me.csrfToken, 'idempotency-key': randomUUID() },
      data: {
        ...(base === L ? {} : { tenantId: ids.tenantA }),
        reason: 'Nghiệm thu cấu hình ' + suffix,
        ...data,
      },
    }),
    expected,
  );
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}
async function scan(page: Page, name: string) {
  current = page;
  assert.ok([A, W, L].includes(new URL(page.url()).origin));
  assert.equal(await page.locator('input[type=password],#otp').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    name,
    violations: result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    incomplete: result.incomplete.map((v) => v.id),
  });
  await writeFile(
    '.local/evidence/configuration-transfer-axe.json',
    JSON.stringify(scans, null, 2),
  );
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => (window as Window & { csp?: string[] }).csp), []);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: '.local/evidence/configuration-transfer-' + name + '.png',
    fullPage: (await page.getByRole('dialog').count()) === 0,
  });
}
async function exportUi(page: Page, name: string) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất cấu hình', exact: true }).click();
  const file = await download,
    path = '.local/evidence/configuration-' + name + '.json';
  await file.saveAs(path);
  const pack = JSON.parse(await readFile(path, 'utf8')) as ConfigurationPackage;
  assert.equal(pack.format, 'tlqm-aio-configuration');
  assert.equal(pack.version, 1);
  return pack;
}
async function upload(page: Page, pack: ConfigurationPackage) {
  await page.getByRole('button', { name: 'Nhập cấu hình', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tệp cấu hình JSON', { exact: true }).setInputFiles({
    name: 'configuration.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(pack)),
  });
  return dialog;
}
async function apply(page: Page, name: string) {
  const started = performance.now();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Lý do nhập cấu hình', { exact: true })
    .fill('Đã kiểm tra cấu hình ' + suffix);
  if ((page.viewportSize()?.width ?? 1440) < 500) {
    await dialog
      .getByRole('button', { name: 'Ghi bản nháp đã đối chiếu', exact: true })
      .scrollIntoViewIfNeeded();
    await scan(page, name + '-apply-mobile');
  }
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Ghi bản nháp đã đối chiếu', exact: true }).click();
  const backup = await download;
  assert.ok(backup.suggestedFilename().includes('truoc-khi-nhap'));
  const path = '.local/evidence/configuration-' + name + '-backup.json';
  await backup.saveAs(path);
  // The backup download starts before the mutation and live lookup refresh finish.
  // Wait for the actual success state, then retain the dialog/data assertions.
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Đã nhập cấu hình vào bản nháp. Kiểm tra trước khi phát hành.' })
      .first(),
  ).toBeVisible({ timeout: 30000 });
  await expect(dialog).toHaveCount(0);
  console.log(
    'Configuration apply completed: ' +
      name +
      ' in ' +
      Math.round(performance.now() - started) +
      'ms.',
  );
  return JSON.parse(await readFile(path, 'utf8')) as ConfigurationPackage;
}
try {
  for (const code of ['aio-foundation', 'aio-workflows']) {
    const client = runtime.clients.find((c) => c.code === code)!,
      app = await createApp({
        runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
        client,
        test: true,
        logger: false,
      });
    await app.listen({ host: '127.0.0.1', port: client.port });
    servers.push(app);
  }
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  admin = await login(
    A,
    runtime.users.find((u) => u.id === ids.admin)!,
    true,
  );
  author = await login(L, role('publisher'), true);
  const page = await author.context.newPage();
  await page.goto(W + '/auth/login');
  await page.waitForURL(W + '/');
  publisher = {
    ...author,
    page,
    me: await json(await author.context.request.get(W + '/api/v1/me')),
  };
  const designer = await login(W, role('designer'), true),
    learner = await login(
      L,
      runtime.users.find((u) => u.id === ids.learner)!,
    );
  stage = 'Directory export, file validation, preview and draft-only apply';
  current = admin.page;
  original = (
    await json(
      await admin.context.request.get(
        A + '/api/v1/directory-config/people?tenantId=' + ids.tenantA,
      ),
    )
  ).configuration;
  await admin.page.goto(A + '/#people');
  await admin.page.getByRole('tab', { name: 'Thông tin mở rộng', exact: true }).click();
  await admin.page.getByRole('tab', { name: 'Thiết kế trường & bố cục', exact: true }).click();
  const directoryPack = await exportUi(admin.page, 'directory-source'),
    directoryTitle = 'Hồ sơ nhập ' + suffix;
  (directoryPack.content as any).schema.title = directoryTitle;
  let dialog = await upload(admin.page, directoryPack);
  await admin.page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    admin.page.getByRole('button', { name: 'Nhập cấu hình', exact: true }),
  ).toBeFocused();
  dialog = await upload(admin.page, directoryPack);
  await dialog.getByRole('button', { name: 'Xem trước khác biệt', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Khác biệt cấu hình' })).toContainText(
    directoryTitle,
  );
  await scan(admin.page, 'directory-preview');
  await admin.page.setViewportSize({ width: 390, height: 844 });
  await dialog
    .getByRole('button', { name: 'Ghi bản nháp đã đối chiếu', exact: true })
    .scrollIntoViewIfNeeded();
  await scan(admin.page, 'directory-mobile');
  const before = await json(
    await admin.context.request.get(A + '/api/v1/directory-config/people?tenantId=' + ids.tenantA),
  );
  assert.equal(before.configuration.revision, original!.revision);
  const directoryBackup = await apply(admin.page, 'directory');
  await expect(admin.page.getByLabel('Tên biểu mẫu', { exact: true })).toHaveValue(directoryTitle);
  const changed = await json(
    await admin.context.request.get(A + '/api/v1/directory-config/people?tenantId=' + ids.tenantA),
  );
  assert.equal(changed.configuration.currentVersion, original!.currentVersion);
  const rollback = await write(
    admin,
    A,
    '/api/v1/configuration-transfer/directory-people/current/preview',
    { package: directoryBackup, mappings: [] },
  );
  await write(admin, A, '/api/v1/configuration-transfer/directory-people/current/apply', {
    review: rollback.review,
  });
  stage = 'Workflow file with a foreign unit needs explicit mapping';
  const spec = workflowTemplate('blank');
  spec.name = 'Quy trình cấu hình ' + suffix;
  spec.schemaVersion = 5;
  spec.audienceUnits = [ids.unitA];
  spec.input.schemaVersion = 2;
  spec.input.sections[0]!.fields.push(
    { id: 'pickup_time', type: 'time', label: 'Giờ nhận', required: false },
    {
      id: 'delivery',
      type: 'singleChoice',
      label: 'Cách nhận',
      required: false,
      options: [
        { id: 'courier', label: 'Giao tận nơi' },
        { id: 'office', label: 'Nhận tại kho' },
      ],
      optionRules: [
        {
          when: {
            mode: 'all',
            rules: [],
            groups: [
              { mode: 'any', rules: [{ fieldId: 'pickup_time', operator: 'gte', value: '16:00' }] },
            ],
          },
          optionIds: ['courier'],
        },
      ],
    },
  );
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Gửi', next: 'review' },
    {
      id: 'review',
      kind: 'approval',
      label: 'Duyệt',
      assignee: role('reviewer').id,
      dueHours: 24,
      next: 'end',
      form: null,
    },
    { id: 'end', kind: 'end', label: 'Hoàn thành' },
  ];
  const draft = await write(designer, W, '/api/v1/workflows/definitions', {
    code: 'config-' + suffix,
    orgUnitId: ids.unitA,
    spec,
  });
  definitionId = draft.id;
  const published = await write(
    publisher,
    W,
    '/api/v1/workflows/definitions/' + definitionId + '/publish',
    { expectedRevision: draft.revision },
  );
  await designer.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await designer.page
    .locator('[data-slot=card]')
    .filter({ has: designer.page.getByText(spec.name, { exact: true }) })
    .getByRole('button', { name: 'Thiết kế', exact: true })
    .click();
  const workflowPack = await exportUi(designer.page, 'workflow-source'),
    foreign = randomUUID();
  (workflowPack.content as any).name = 'Quy trình đã nhập ' + suffix;
  (workflowPack.content as any).audienceUnits = [foreign];
  workflowPack.references = workflowPack.references.filter((r) => r.type !== 'unit');
  workflowPack.references.push({ type: 'unit', id: foreign, label: 'Đơn vị từ hệ khác' });
  dialog = await upload(designer.page, workflowPack);
  await expect(
    dialog.getByRole('button', { name: 'Xem trước khác biệt', exact: true }),
  ).toBeDisabled();
  const search = dialog.getByLabel('Tìm đối tượng thay thế 1', { exact: true });
  if (await search.count()) await search.fill('Đào tạo');
  await select(designer.page, 'Đích cho Đơn vị từ hệ khác', 'Đào tạo');
  await scan(designer.page, 'reference-mapping');
  const previewStarted = Date.now();
  const workflowPreview = designer.page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.origin === W &&
        url.pathname === '/api/v1/configuration-transfer/workflow/' + definitionId + '/preview' &&
        response.request().method() === 'POST'
      );
    },
    { timeout: 30000 },
  );
  await dialog.getByRole('button', { name: 'Xem trước khác biệt', exact: true }).click();
  assert.equal((await workflowPreview).status(), 200);
  await expect(dialog.getByRole('region', { name: 'Khác biệt cấu hình' })).toContainText(
    'Quy trình đã nhập ' + suffix,
    { timeout: 10000 },
  );
  console.log('Workflow preview completed in ' + (Date.now() - previewStarted) + 'ms.');
  await scan(designer.page, 'workflow-preview');
  await designer.page.setViewportSize({ width: 390, height: 844 });
  await scan(designer.page, 'workflow-mobile');
  await apply(designer.page, 'workflow');
  await designer.page.getByRole('tab', { name: 'Thông tin & đối tượng', exact: true }).click();
  await expect(designer.page.getByLabel('Tên quy trình', { exact: true })).toHaveValue(
    'Quy trình đã nhập ' + suffix,
  );
  const definition = (
    await json(
      await designer.context.request.get(
        W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
      ),
    )
  ).items.find((d: Row) => d.id === definitionId);
  assert.deepEqual(definition.version, published.version);
  assert.equal(definition.draft.schemaVersion, 5);
  assert.deepEqual(definition.draft.input, published.version.spec.input);
  stage = 'LMS course configuration and private answer keys';
  const courseTitle = 'Khóa cấu hình ' + suffix,
    course = await write(author, L, '/api/lms/commands', {
      action: 'save-course',
      data: {
        code: 'config-' + suffix,
        ownerUnitId: ids.unitA,
        expectedRevision: 0,
        spec: {
          schemaVersion: 3,
          title: courseTitle,
          subtitle: 'Dữ liệu kiểm thử',
          series: 'TLQM',
          duration: 10,
          video: { kind: 'youtube', id: 'abcdefghijk' },
          deadline: '',
          isMandatory: true,
          audienceUnits: [ids.unitA],
          checkpoints: [],
          questions: [
            { id: 'q', type: 'single', question: 'Nghiệp vụ giả lập?', options: ['Đúng', 'Sai'] },
          ],
          answerKey: { q: { answer: 0, explanation: 'Đã kiểm tra' } },
          attachments: [],
          policy: {
            ...defaultLearningPolicy,
            requireVideoCompletion: false,
            checkpointPolicy: 'none',
          },
        },
      },
    });
  courseId = course.id;
  const version = await write(author, L, '/api/lms/commands', {
    action: 'publish-course',
    data: { courseId, expectedRevision: course.revision },
  });
  await author.page.getByRole('tab', { name: 'Khóa học & nội dung', exact: true }).click();
  await author.page
    .getByRole('textbox', { name: 'Tìm khóa học quản lý', exact: true })
    .fill(courseTitle);
  await author.page.getByRole('button', { name: 'Thiết kế', exact: true }).click();
  const coursePack = await exportUi(author.page, 'course-source');
  assert.ok((coursePack.content as any).answerKey.q);
  (coursePack.content as any).title = 'Khóa đã nhập ' + suffix;
  (coursePack.content as any).policy.passScore = 65;
  dialog = await upload(author.page, coursePack);
  await dialog.getByRole('button', { name: 'Xem trước khác biệt', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Khác biệt cấu hình' })).toBeVisible();
  await scan(author.page, 'course-preview');
  await author.page.setViewportSize({ width: 390, height: 844 });
  await scan(author.page, 'course-mobile');
  await apply(author.page, 'course');
  await expect(author.page.getByLabel('Tên khóa học', { exact: true })).toHaveValue(
    'Khóa đã nhập ' + suffix,
  );
  const publicCourse = await json(
    await learner.context.request.get(L + '/api/lms/course?versionId=' + version.versionId),
  );
  assert.equal(publicCourse.spec.title, courseTitle);
  assert.equal(publicCourse.spec.policy.passScore, 80);
  assert.equal('answerKey' in publicCourse.spec, false);
  await write(
    learner,
    L,
    '/api/lms/config-transfer',
    { kind: 'lms-course', target: courseId, action: 'export' },
    403,
  );
  stage = 'LMS path configuration through the same UI';
  const pathTitle = 'Lộ trình cấu hình ' + suffix,
    path = await write(author, L, '/api/lms/training-commands', {
      action: 'save-path',
      data: {
        expectedRevision: 0,
        spec: {
          schemaVersion: 1,
          title: pathTitle,
          description: 'Cấu hình giả lập',
          audienceUnits: [ids.unitA],
          courseVersionIds: [version.versionId],
        },
      },
    });
  const pathVersion = await write(author, L, '/api/lms/training-commands', {
    action: 'publish-path',
    data: { id: path.id, expectedRevision: path.revision },
  });
  await author.page.getByRole('tab', { name: 'Quản lý đào tạo', exact: true }).click();
  await author.page.getByRole('button', { name: 'Quản lý lộ trình', exact: true }).click();
  await author.page
    .locator('[data-slot=card]')
    .filter({ has: author.page.getByText(pathTitle, { exact: true }) })
    .getByRole('button', { name: 'Thiết kế lộ trình', exact: true })
    .click();
  const pathPack = await exportUi(author.page, 'path-source');
  (pathPack.content as any).title = 'Lộ trình đã nhập ' + suffix;
  dialog = await upload(author.page, pathPack);
  await dialog.getByRole('button', { name: 'Xem trước khác biệt', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Khác biệt cấu hình' })).toBeVisible();
  await scan(author.page, 'path-mobile');
  await apply(author.page, 'path');
  await expect(author.page.getByLabel('Tên lộ trình', { exact: true })).toHaveValue(
    'Lộ trình đã nhập ' + suffix,
  );
  const finalPath = (
    await json(await author.context.request.get(L + '/api/lms/training-paths'))
  ).items.find((p: Row) => p.id === path.id);
  assert.equal(finalPath.versionId, pathVersion.versionId);
  assert.equal(finalPath.published.title, pathTitle);
  stage = 'tampered review and CSRF denial';
  const review = await write(author, L, '/api/lms/config-transfer', {
    kind: 'lms-path',
    target: path.id,
    action: 'preview',
    package: pathPack,
    mappings: [],
  });
  review.review.payload.content.title = 'Không qua xem trước';
  await write(
    author,
    L,
    '/api/lms/config-transfer',
    { kind: 'lms-path', target: path.id, action: 'apply', review: review.review },
    403,
  );
  const noCsrf = await author.context.request.post(L + '/api/lms/config-transfer', {
    headers: { 'idempotency-key': randomUUID() },
    data: { kind: 'lms-path', target: path.id, action: 'export', reason: 'Thiếu CSRF' },
  });
  assert.equal(noCsrf.status(), 403);
  await writeFile(
    '.local/evidence/configuration-transfer-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans,
        checks: [
          'real SSO/MFA exports',
          'keyboard dialog focus',
          'explicit reference mapping',
          'desktop/mobile diffs and downloaded backups',
          'draft-only Directory/Workflow/LMS changes',
          'restore Directory backup',
          'learner answer-key export denied',
          'tampered review and CSRF denied',
        ],
        credentialsExposed: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS configuration file export/preview/mapping/import/rollback via real SSO; ' +
      scans.length +
      ' axe scans.',
  );
} catch (e) {
  if (
    current &&
    [A, W, L].includes(new URL(current.url()).origin) &&
    !(await current.locator('input[type=password],#otp').count())
  )
    await current.screenshot({
      path: '.local/evidence/configuration-transfer-failure.png',
      fullPage: true,
    });
  console.error(
    'Configuration transfer failed at ' +
      stage +
      '; ' +
      (e instanceof Error
        ? (e.message.startsWith('HTTP_') ? e.message : e.name) +
          ' ' +
          (e.stack?.match(/configuration-transfer-e2e\.ts:\d+:\d+/)?.[0] ?? '')
        : 'unknown') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  if (admin && original)
    try {
      const now = await json(
        await admin.context.request.get(
          A + '/api/v1/directory-config/people?tenantId=' + ids.tenantA,
        ),
      );
      await write(admin, A, '/api/v1/directory-config/people', {
        configuration: original.draft,
        expectedRevision: now.configuration.revision,
      });
    } catch {
      console.error('Configuration fixture restoration pending.');
      process.exitCode = 1;
    }
  if (publisher && definitionId)
    try {
      const d = (
        await json(
          await publisher.context.request.get(
            W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
          ),
        )
      ).items.find((d: Row) => d.id === definitionId);
      if (d?.status === 'published')
        await write(publisher, W, '/api/v1/workflows/definitions/' + definitionId + '/status', {
          expectedRevision: d.revision,
          status: 'paused',
        });
    } catch {
      console.error('Configuration workflow fixture pause pending.');
      process.exitCode = 1;
    }
  if (author && courseId)
    try {
      const c = (
        await json(await author.context.request.get(L + '/api/lms/manage/courses'))
      ).items.find((c: Row) => c.id === courseId);
      if (c?.status === 'active')
        await write(author, L, '/api/lms/commands', {
          action: 'course-status',
          data: { courseId, expectedRevision: c.revision, status: 'archived' },
        });
    } catch {
      console.error('Configuration course fixture archive pending.');
      process.exitCode = 1;
    }
  await browser.close();
  await worker?.mf.dispose();
  for (const app of servers) {
    app.server.closeAllConnections();
    await app.close();
  }
}
