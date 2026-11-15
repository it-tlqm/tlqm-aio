import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect } from '@playwright/test';
import type { APIResponse, BrowserContext, Page } from '@playwright/test';
import { createApp } from '../src/app.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { purchaseColumns } from '../src/forms/business.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import type { FormsFixture } from './forms-fixtures.js';
import { localContainer } from './local-docker.js';
import { nextFixtureOtp } from './local-totp.js';
import { reminderRuntime } from './work-center-runtime.js';

const runtime = await loadLocalConfig();
const base = 'http://127.0.0.1:4105';
const routes = base + '/api/v1/workflows';
const tenant = '?tenantId=' + ids.tenantA;
const evidence = '.local/evidence/workflows-output-templates-';
const suffix = randomUUID().slice(0, 8);
const fixture = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixture.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixture.users.find((user) => user.role === name)!;
const browser = await chromium.launch({ headless: true });
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let worker: Awaited<ReturnType<typeof reminderRuntime>> | undefined;
let stage = 'preflight';
let current: Page | undefined;
const scans: { name: string; violations: string[]; incomplete: string[] }[] = [];

async function read(response: APIResponse, status = 200) {
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status(), status, /^[A-Z_]+$/.test(body.error ?? '') ? body.error : 'HTTP');
  return body;
}

async function login(user: { id: string; username: string; password: string }, mfa = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  current = page;
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === base && url.pathname === '/');
  return { context, page };
}

async function write(context: BrowserContext, path: string, data: Record<string, unknown>) {
  const me = await read(await context.request.get(base + '/api/v1/me'));
  return read(
    await context.request.post(routes + path, {
      headers: { origin: base, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() },
      data: { tenantId: ids.tenantA, reason: 'Kiểm chứng mẫu đầu ra giả lập', ...data },
    }),
  );
}

async function choose(page: Page, label: string, value: string) {
  const control = page.getByRole('combobox', { name: label, exact: true });
  await expect(control).toBeEnabled();
  await control.press('Space');
  await page.getByRole('option', { name: value, exact: true }).press('Enter');
  await expect(control).toHaveText(value);
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

async function scan(page: Page, name: string, fullPage = true) {
  assert.equal(new URL(page.url()).origin, base);
  assert.equal(await page.locator('input[type=password],#otp').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: evidence + name + '.png', fullPage, animations: 'disabled' });
  const audit = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    name,
    violations: audit.violations.map(({ id }) => id),
    incomplete: audit.incomplete.map(({ id }) => id),
  });
  await writeFile(evidence + 'axe.json', JSON.stringify(scans, null, 2));
  assert.deepEqual(
    audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
    [],
  );
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

try {
  await mkdir('.local/evidence', { recursive: true });
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  const client = runtime.clients.find(({ code }) => code === 'aio-workflows')!;
  app = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client,
    test: true,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: client.port });

  stage = 'SSO/MFA and workflow fixture';
  const designer = await login(role('designer'), true);
  const publisher = await login(role('publisher'), true);
  const reviewer = await login(role('reviewer'));
  const requester = await login(runtime.users.find(({ id }) => id === ids.learner)!);
  const name = 'Phiếu mua sắm ' + suffix;
  const code = 'output-' + suffix;
  const spec = workflowTemplate('leave');
  spec.schemaVersion = 5;
  spec.name = name;
  spec.audienceUnits = [ids.unitA];
  spec.input.schemaVersion = 2;
  spec.input.title = name;
  spec.input.sections[0]!.fields = [
    { id: 'purpose', label: 'Nội dung mua sắm', type: 'longText', required: true },
    { id: 'private_note', label: 'Ghi chú riêng', type: 'shortText', required: false },
    {
      id: 'items',
      label: 'Chi tiết mua sắm',
      type: 'table',
      required: true,
      currency: 'VND',
      columns: purchaseColumns(),
    },
  ];
  spec.fieldReaders = { 'input.private_note': ['owner'] };
  for (const node of spec.nodes) {
    if (node.kind === 'approval') {
      node.assignee = role('reviewer').id;
      node.inputFields = { purpose: 'read' };
    }
  }
  const draft = await write(designer.context, '/definitions', { code, orgUnitId: ids.unitA, spec });
  const first = await write(publisher.context, '/definitions/' + draft.id + '/publish', {
    expectedRevision: draft.revision,
  });
  const lookup = await read(
    await publisher.context.request.get(routes + '/lookups' + tenant + '&unitsOnly=true'),
  );
  const unit = lookup.units.find(({ id }: { id: string }) => id === ids.unitA);
  assert(unit);

  stage = 'create print template with keyboard';
  current = publisher.page;
  await current.goto(base + '/#workflows/automation');
  const outputTab = current.getByRole('tab', { name: 'Mẫu in và email', exact: true });
  await outputTab.press('Enter');
  await choose(current, 'Quy trình dùng mẫu', name + ' · v1');
  await choose(current, 'Đơn vị dùng mẫu', unit.name);
  const printName = 'Bản in ' + suffix;
  await current.getByLabel('Tên mẫu', { exact: true }).fill(printName);
  await current.getByLabel('Tiêu đề bản in', { exact: true }).fill('Phiếu');
  await current.getByRole('button', { name: 'Chèn vào tiêu đề' }).press('Enter');
  await choose(current, 'Trường chèn vào nội dung', 'Nội dung mua sắm');
  await current.getByRole('button', { name: 'Chèn vào nội dung' }).press('Enter');
  await expect(current.getByLabel('Nội dung mẫu')).toHaveValue('{{input.purpose}}');
  await current.getByRole('checkbox', { name: 'Chi tiết mua sắm', exact: true }).check();
  await current.getByRole('checkbox', { name: 'Ghi chú riêng', exact: true }).check();
  await current.getByLabel('Lý do áp dụng mẫu').fill('Áp dụng phiếu mua sắm giả lập');
  await scan(current, 'configuration-desktop');
  await current.getByRole('button', { name: 'Lưu mẫu', exact: true }).press('Enter');
  await expect(current.getByRole('status').filter({ hasText: 'Đã lưu mẫu.' })).toBeVisible();

  stage = 'create event email template at 390px';
  const emailName = 'Email duyệt ' + suffix;
  await current.setViewportSize({ width: 390, height: 844 });
  const tablist = current.getByRole('tablist', { name: 'Tự động hóa quy trình' });
  assert(
    await tablist.evaluate((element) =>
      [...element.querySelectorAll('[role=tab]')].every((tab) => {
        const bounds = tab.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth;
      }),
    ),
  );
  await choose(current, 'Loại mẫu', 'Mẫu email');
  await choose(current, 'Sự kiện gửi email', 'Phê duyệt bước');
  await choose(current, 'Bước áp dụng email', 'Xem xét đề nghị');
  await current.getByLabel('Tên mẫu', { exact: true }).fill(emailName);
  await current.getByLabel('Tiêu đề email', { exact: true }).fill('Đã duyệt');
  await current.getByRole('button', { name: 'Chèn vào tiêu đề' }).press('Enter');
  await choose(current, 'Trường chèn vào nội dung', 'Tên sự kiện');
  await current.getByRole('button', { name: 'Chèn vào nội dung' }).press('Enter');
  await choose(current, 'Trường chèn vào nội dung', 'Ghi chú riêng');
  await current.getByRole('button', { name: 'Chèn vào nội dung' }).press('Enter');
  await current.getByLabel('Lý do áp dụng mẫu').fill('Thông báo phê duyệt phiếu giả lập');
  await scan(current, 'configuration-mobile');
  await current.getByRole('button', { name: 'Lưu mẫu', exact: true }).press('Enter');
  await expect(current.getByRole('status').filter({ hasText: 'Đã lưu mẫu.' })).toBeVisible();
  const templates = (
    await read(await publisher.context.request.get(routes + '/output-templates' + tenant))
  ).items;
  const print = templates.find((item: { name: string }) => item.name === printName);
  const email = templates.find((item: { name: string }) => item.name === emailName);
  assert.equal(print.version_id, first.version.id);
  assert.equal(email.version_id, first.version.id);
  assert.equal(email.step_id, 'review');
  await read(await requester.context.request.get(routes + '/output-templates' + tenant), 403);

  stage = 'print old version with safe HTML and computed rows';
  const title = 'Đề nghị ' + suffix;
  const secret = 'Thông tin hạn chế ' + suffix;
  const answers = {
    purpose: 'Máy đo <b>giả lập</b>',
    private_note: secret,
    items: {
      rows: [
        { id: 'row_a', cells: { description: 'Máy đo', quantity: '2', unit_price: '100.50' } },
        { id: 'row_b', cells: { description: 'Phụ kiện', quantity: '3', unit_price: '10.25' } },
      ],
    },
  };
  const start = (versionId: string, runTitle: string) =>
    write(requester.context, '/runs', {
      definitionId: draft.id,
      versionId,
      unitId: ids.unitA,
      title: runTitle,
      answers,
    });
  const run = await start(first.version.id, title);
  const updated = await write(designer.context, '/definitions/' + draft.id, {
    code,
    orgUnitId: ids.unitA,
    expectedRevision: first.definition.revision,
    spec: { ...spec, name: name + ' cập nhật' },
  });
  const second = await write(publisher.context, '/definitions/' + draft.id + '/publish', {
    expectedRevision: updated.revision,
  });
  assert.equal(second.version.version, 2);
  const newer = await start(second.version.id, title + ' v2');
  const printPath = (id: string) =>
    routes + '/runs/' + id + '/print' + tenant + '&templateId=' + print.id;
  await read(await requester.context.request.get(printPath(newer.id)), 404);
  await read(await designer.context.request.get(printPath(run.id)), 403);

  current = requester.page;
  await current.goto(base + '/#workflow-run/' + run.id);
  await current.getByRole('tab', { name: 'Mẫu in', exact: true }).press('Enter');
  await current.getByRole('button', { name: 'Tải mẫu in' }).press('Enter');
  await expect(current.getByRole('combobox', { name: 'Chọn mẫu in' })).toHaveText(printName);
  const popup = current.waitForEvent('popup');
  await current.getByRole('link', { name: 'Xem bản in' }).press('Enter');
  const preview = await popup;
  await expect(preview.getByRole('heading', { name: 'Phiếu ' + title })).toBeVisible();
  await expect(preview.getByText('Máy đo <b>giả lập</b>', { exact: true })).toBeVisible();
  await expect(preview.locator('tbody tr')).toHaveCount(2);
  await expect(preview.locator('tfoot')).toContainText('231.75');
  await expect(preview.getByText(secret, { exact: true })).toBeVisible();
  await scan(preview, 'preview-desktop');
  await preview.setViewportSize({ width: 390, height: 844 });
  await expect(preview.getByRole('cell', { name: '100.50', exact: true })).toHaveCSS(
    'white-space',
    'nowrap',
  );
  await expect(preview.getByRole('rowheader', { name: 'Tổng', exact: true })).toBeVisible();
  await scan(preview, 'preview-mobile');
  await preview.close();
  const download = current.waitForEvent('download');
  await current.getByRole('link', { name: 'Tải bản in HTML' }).press('Enter');
  const file = await download;
  assert.equal(file.suggestedFilename(), 'ho-so-quy-trinh.html');
  const html = await readFile((await file.path())!, 'utf8');
  assert.match(html, /&lt;b&gt;giả lập&lt;\/b&gt;/);
  assert.match(html, /<tfoot>.*231\.75/);
  const response = await requester.context.request.get(printPath(run.id) + '&download=true');
  assert.equal(response.status(), 200);
  assert.equal(response.headers()['cache-control'], 'no-store');
  assert.equal(response.headers()['x-content-type-options'], 'nosniff');
  assert.equal(
    response.headers()['content-security-policy'],
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
  assert.equal(
    response.headers()['content-disposition'],
    'attachment; filename="ho-so-quy-trinh.html"',
  );
  assert.equal(await response.text(), html);
  const limited = await reviewer.context.request.get(printPath(run.id));
  assert.equal(limited.status(), 200);
  assert.doesNotMatch(await limited.text(), new RegExp(secret + '|Ghi chú riêng'));

  stage = 'approve in UI and deliver once';
  current = reviewer.page;
  await current.goto(base + '/#workflow-run/' + run.id);
  await current.getByRole('button', { name: 'Phê duyệt', exact: true }).press('Enter');
  const confirmation = current.getByRole('dialog');
  await confirmation.getByLabel('Ý kiến / lý do').fill('Đã kiểm tra hai dòng mua sắm');
  await confirmation.getByRole('button', { name: 'Xác nhận', exact: true }).press('Enter');
  await expect(confirmation).toHaveCount(0);
  const approved = await read(
    await requester.context.request.get(routes + '/runs/' + run.id + tenant),
  );
  assert.equal(approved.run.status, 'completed');
  worker = await reminderRuntime(runtime, true);
  await worker.tick();
  await worker.tick();
  const jobsPath = routes + '/output-templates/' + email.id + '/jobs' + tenant;
  const jobs = (await read(await publisher.context.request.get(jobsPath))).items;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'done');
  assert.equal(jobs[0].attempts, 1);
  assert.equal(jobs[0].history.length, 1);
  await read(await requester.context.request.get(jobsPath), 403);
  const mailboxPath = routes + '/output-mailbox' + tenant;
  const reviewerMail = (await read(await reviewer.context.request.get(mailboxPath))).items;
  assert.equal(reviewerMail.filter(({ runId }: { runId: string }) => runId === run.id).length, 0);

  stage = 'owner mailbox and operator history';
  current = requester.page;
  await current.setViewportSize({ width: 390, height: 844 });
  await current.goto(base + '/#workflows/mailbox');
  await current.getByRole('button', { name: 'Tải hộp thư' }).press('Enter');
  const message = current.getByRole('listitem').filter({ hasText: 'Đã duyệt ' + title });
  await expect(message).toHaveCount(1);
  await expect(message).toContainText('Phê duyệt bước ' + secret);
  await scan(current, 'mailbox-mobile');
  await message.getByRole('button', { name: 'Mở hồ sơ' }).press('Enter');
  await current.waitForURL((url) => url.hash === '#workflow-run/' + run.id);

  current = publisher.page;
  await current.setViewportSize({ width: 1440, height: 960 });
  await current.getByRole('button', { name: 'Tải lại mẫu' }).press('Enter');
  await expect(
    current.getByText('Đã ghi vào hộp thư · 1 lần xử lý', { exact: true }),
  ).toBeVisible();
  const history = current.getByText('Lịch sử xử lý', { exact: true });
  await history.press('Enter');
  await expect(history.locator('..')).toHaveAttribute('open', '');
  await current.getByText('Đã ghi vào hộp thư', { exact: false }).last().scrollIntoViewIfNeeded();
  await scan(current, 'history-desktop', false);
  await current.getByLabel('Lý do tắt hoặc thử lại').fill('Dừng mẫu sau khi nghiệm thu');
  await current.getByRole('button', { name: 'Tắt mẫu', exact: true }).press('Enter');
  await expect(current.getByRole('status').filter({ hasText: 'Đã tắt mẫu.' })).toBeVisible();
  const final = (await read(await publisher.context.request.get(jobsPath))).items;
  assert.deepEqual(final, jobs);
  const mail = (await read(await requester.context.request.get(mailboxPath))).items;
  assert.equal(mail.filter(({ runId }: { runId: string }) => runId === run.id).length, 1);

  stage = 'exact attempt mailbox link and revocation';
  await write(publisher.context, '/output-templates', {
    definitionId: draft.id,
    versionId: second.version.id,
    unitId: ids.unitA,
    kind: 'email',
    name: 'Nhắc theo bước ' + suffix,
    heading: 'Nhắc theo bước {{run.title}}',
    body: '{{input.purpose}} · {{input.private_note}}',
    fields: [],
    event: 'mentioned',
    stepId: 'review',
  });
  const newRunPath = '/runs/' + newer.id;
  const open = await read(await requester.context.request.get(routes + newRunPath + tenant));
  const attempt = open.tasks.find((item: { status: string }) => item.status === 'pending');
  assert(attempt);
  const follower = await write(requester.context, newRunPath + '/followers', {
    accountId: role('designer').id,
    taskId: attempt.id,
  });
  await write(requester.context, newRunPath + '/discussion', {
    text: 'Nhờ kiểm tra nội dung ở bước này ' + suffix,
    mentionIds: [follower.id],
    taskId: attempt.id,
  });
  await worker.tick();
  await read(await designer.context.request.get(routes + newRunPath + tenant), 403);
  await read(
    await designer.context.request.get(routes + newRunPath + '/print-templates' + tenant),
    403,
  );
  const scopedMail = (await read(await designer.context.request.get(mailboxPath))).items.find(
    ({ runId }: { runId: string }) => runId === newer.id,
  );
  assert.equal(scopedMail.taskId, attempt.id);
  assert.equal(scopedMail.body, 'Máy đo <b>giả lập</b> · —');
  current = designer.page;
  await current.setViewportSize({ width: 390, height: 844 });
  await current.goto(base + '/#workflows/mailbox');
  await current.getByRole('button', { name: 'Tải hộp thư' }).press('Enter');
  const scopedMessage = current.getByRole('listitem').filter({ hasText: scopedMail.subject });
  await expect(scopedMessage).toHaveCount(1);
  await scopedMessage.getByRole('button', { name: 'Mở hồ sơ' }).press('Enter');
  await current.waitForURL((url) => url.hash === '#workflow-run/' + newer.id + '/' + attempt.id);
  await expect(current.getByRole('tab', { name: 'Trao đổi', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(current.getByRole('tab', { name: 'Mẫu in', exact: true })).toHaveCount(0);
  await scan(current, 'scoped-record-mobile');
  await write(requester.context, newRunPath + '/followers/remove', {
    followerId: follower.id,
    taskId: attempt.id,
    expectedRevision: follower.revision,
  });
  const revoked = (await read(await designer.context.request.get(mailboxPath))).items;
  assert.equal(
    revoked.some(({ id }: { id: string }) => id === scopedMail.id),
    false,
  );
  await read(
    await designer.context.request.get(routes + newRunPath + tenant + '&taskId=' + attempt.id),
    403,
  );
  await writeFile(
    evidence + 'e2e.json',
    JSON.stringify(
      {
        finishedAt: new Date().toISOString(),
        timeZone: 'Asia/Ho_Chi_Minh',
        scans,
        checks: [
          'SSO/MFA',
          'keyboard template creation',
          'version rollover',
          'computed table print',
          'HTML escaping and download headers',
          'field and operator scope',
          'UI approval',
          'worker replay and recipient ownership',
          'disable preserves delivery history',
          'step-only mailbox opens exact attempt and withdraws after follower removal',
        ],
      },
      null,
      2,
    ),
  );
  console.log('Workflow output templates E2E passed with ' + scans.length + ' axe scans.');
} catch (error) {
  console.error('Workflow output template E2E failed at ' + stage + '.');
  console.error(error instanceof Error ? error.message : String(error));
  if (
    current &&
    !current.isClosed() &&
    new URL(current.url()).origin === base &&
    (await current.locator('input[type=password],#otp').count()) === 0
  )
    await current.screenshot({ path: evidence + 'failure.png' });
  process.exitCode = 1;
} finally {
  await worker?.close();
  await browser.close();
  app?.server.closeAllConnections();
  await app?.close();
}
