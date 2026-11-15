import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import type { Page, BrowserContext, APIResponse } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../src/app.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { workflowDeadline } from '../src/workflows/calendar.js';
import type { WorkflowsService } from '../src/workflows/service.js';
import type { FormsFixture } from './forms-fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import { localContainer } from './local-docker.js';
type Group = Awaited<ReturnType<WorkflowsService['saveGroup']>>;
type Detail = Awaited<ReturnType<WorkflowsService['detail']>>;
const runtime = await loadLocalConfig(),
  W = 'http://127.0.0.1:4105';
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixtures.users.find((user) => user.role === name)!;
const browser = await chromium.launch({ headless: true });
let app: Awaited<ReturnType<typeof createApp>> | undefined, current: Page | undefined;
let stage = 'preflight';
const scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
async function status(response: APIResponse, expected: number) {
  if (response.status() !== expected) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    console.error(
      'Pool HTTP ' +
        response.status() +
        '/' +
        expected +
        (body.error && /^[A-Z0-9_]+$/.test(body.error) ? ' ' + body.error : ''),
    );
  }
  assert.equal(response.status(), expected);
}
async function login(user: { id: string; username: string; password: string }, mfa = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  current = page;
  await context.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective),
    );
  });
  await page.goto(W + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === W && url.pathname === '/');
  await status(await context.request.get(W + '/api/v1/me'), 200);
  return { context, page };
}
async function write(
  context: BrowserContext,
  path: string,
  data: Record<string, unknown>,
  badCsrf = false,
) {
  const me = await (await context.request.get(W + '/api/v1/me')).json();
  return context.request.post(W + '/api/v1/workflows' + path, {
    headers: {
      origin: W,
      'x-csrf-token': badCsrf ? 'wrong' : me.csrfToken,
      'idempotency-key': randomUUID(),
    },
    data: { ...data, tenantId: ids.tenantA, reason: 'Kiểm thử lựa chọn người xử lý' },
  });
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: label, exact: true })).toContainText(value);
}
async function confirm(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Ý kiến / lý do').fill('Nghiệm thu giao nhiệm vụ động');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function scan(page: Page, screen: string) {
  current = page;
  assert.equal(new URL(page.url()).origin, W);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== 'running' ||
            animation.effect?.getTiming().iterations === Infinity,
        ),
    undefined,
    { timeout: 5000 },
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    screen,
    violations: result.violations.map((v) => v.id),
    incomplete: result.incomplete.map((v) => v.id),
  });
  if (result.violations.length)
    console.error(
      JSON.stringify(
        result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
      ),
    );
  assert.deepEqual(
    result.violations.map((v) => v.id),
    [],
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp), []);
}
async function detail(context: BrowserContext, id: string) {
  const response = await context.request.get(
    W + '/api/v1/workflows/runs/' + id + '?tenantId=' + ids.tenantA,
  );
  await status(response, 200);
  return response.json() as Promise<Detail>;
}
async function openRun(page: Page, id: string) {
  current = page;
  if (page.url() === W + '/#workflow-run/' + id) await page.reload();
  else await page.goto(W + '/#workflow-run/' + id);
  await page.getByRole('button', { name: 'Tải lại lượt chạy' }).waitFor();
}
try {
  assert.equal((await localContainer('keycloak')).running, true);
  assert.equal((await localContainer('foundation-db')).running, true);
  app = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((c) => c.code === 'aio-workflows')!,
    test: true,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 4105 });
  stage = 'Real SSO and MFA';
  const coordinator = await login(role('publisher'), true),
    designer = await login(role('designer'), true),
    handler = await login(role('reviewer')),
    finance = await login(role('analyst')),
    requester = await login(runtime.users.find((u) => u.id === ids.learner)!);
  const groupName = 'Hội đồng ' + randomUUID().slice(0, 6),
    title = 'Duyệt hội đồng ' + randomUUID().slice(0, 6);
  let response = await write(coordinator.context, '/groups', {
    name: groupName,
    orgUnitId: ids.unitA,
    accountIds: [role('reviewer').id, role('analyst').id],
    active: true,
  });
  await status(response, 200);
  let group = (await response.json()) as Group;
  const spec = workflowTemplate('blank');
  spec.name = title;
  spec.audienceUnits = [ids.unitA];
  for (const node of spec.nodes)
    if (node.kind === 'approval' || node.kind === 'task') node.assignee = role('reviewer').id;
  response = await write(designer.context, '/definitions', {
    code: 'pool-' + randomUUID().slice(0, 8),
    orgUnitId: ids.unitA,
    spec,
  });
  await status(response, 200);
  const definition = await response.json();
  stage = 'Configure pool and minute SLA with shadcn controls';
  await designer.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await designer.page
    .locator('[data-slot="card"]')
    .filter({ has: designer.page.getByText(title, { exact: true }) })
    .getByRole('button', { name: 'Thiết kế', exact: true })
    .click();
  await select(designer.page, 'Bước đang cấu hình', 'Xem xét đề nghị');
  await select(designer.page, 'Cách giao nhiệm vụ', 'Nhiều người cùng phê duyệt');
  await select(designer.page, 'Nhóm phê duyệt', groupName);
  await select(designer.page, 'Điều kiện hoàn tất', 'Đủ số người đồng ý');
  await designer.page.getByLabel('Số người tối thiểu', { exact: true }).fill('2');
  await select(designer.page, 'Đơn vị thời hạn', 'Phút');
  await designer.page.getByLabel('Hạn xử lý (phút)', { exact: true }).fill('90');
  await designer.page.getByRole('checkbox', { name: 'Cho phép trả về', exact: true }).focus();
  await designer.page.keyboard.press('Space');
  await expect(
    designer.page.getByRole('checkbox', { name: 'Cho phép trả về', exact: true }),
  ).not.toBeChecked();
  await designer.page.getByRole('tab', { name: 'Thông tin & đối tượng', exact: true }).click();
  await designer.page
    .getByRole('checkbox', { name: 'Sử dụng lịch làm việc riêng', exact: true })
    .check();
  await designer.page.getByRole('button', { name: 'Thêm ngày nghỉ', exact: true }).click();
  await designer.page.getByLabel('Ngày nghỉ 1', { exact: true }).fill('2027-01-01');
  await scan(designer.page, 'calendar-desktop');
  await designer.page.evaluate(() => scrollTo(0, 0));
  await designer.page.screenshot({
    path: '.local/evidence/workflows-pool-calendar-desktop.png',
    fullPage: true,
  });
  await designer.page.setViewportSize({ width: 390, height: 844 });
  await scan(designer.page, 'calendar-mobile');
  await designer.page.evaluate(() => scrollTo(0, 0));
  await designer.page.screenshot({
    path: '.local/evidence/workflows-pool-calendar-mobile.png',
    fullPage: true,
  });
  await designer.page.setViewportSize({ width: 1440, height: 1000 });
  await designer.page.getByRole('tab', { name: 'Luồng xử lý', exact: true }).click();
  await select(designer.page, 'Bước đang cấu hình', 'Xem xét đề nghị');
  await select(designer.page, 'Cách tính thời hạn', 'Theo lịch làm việc');
  await scan(designer.page, 'pool-designer-desktop');
  await designer.page.evaluate(() => scrollTo(0, 0));
  await designer.page.screenshot({
    path: '.local/evidence/workflows-pool-designer-desktop.png',
    fullPage: true,
  });
  await designer.page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(
    designer.page.getByText('Đã lưu bản nháp. Lượt chạy cũ vẫn dùng phiên bản của chúng.', {
      exact: true,
    }),
  ).toBeVisible();
  const saved = (
    await (
      await designer.context.request.get(
        W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
      )
    ).json()
  ).items.find((d: { id: string }) => d.id === definition.id);
  assert.equal(saved.draft.schemaVersion, 4);
  const review = saved.draft.nodes.find((n: { kind: string }) => n.kind === 'approval');
  assert.equal(review.allowReturn, false);
  assert.equal(review.deadlineMinutes, 90);
  assert.equal(review.assigneeRule.quorum, 2);
  response = await write(coordinator.context, '/definitions/' + definition.id + '/publish', {
    expectedRevision: saved.revision,
  });
  await status(response, 200);
  const published = await response.json();
  stage = 'Requester submits via UI; all eligible voters receive task';
  await requester.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await requester.page
    .locator('[data-slot="card"]')
    .filter({ has: requester.page.getByText(title, { exact: true }) })
    .getByRole('button', { name: 'Khởi chạy', exact: true })
    .click();
  const dialog = requester.page.getByRole('dialog');
  await dialog.locator('#answer-purpose').fill('Mua thiết bị đào tạo giả lập');
  await dialog.locator('#answer-requested_on').fill('2026-11-11');
  await dialog.getByRole('button', { name: 'Gửi đề nghị', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const runId = new URL(requester.page.url()).hash.slice(14);
  let run = await detail(requester.context, runId),
    task = run.tasks.find((t) => t.status === 'pending')!;
  assert.equal(task.members.length, 2);
  assert.equal(
    new Date(task.due_at).toISOString(),
    workflowDeadline(new Date(task.created_at), 90, published.version.spec.calendar).toISOString(),
  );
  await openRun(handler.page, runId);
  await expect(handler.page.getByRole('button', { name: 'Phê duyệt', exact: true })).toBeVisible();
  await expect(handler.page.getByRole('button', { name: 'Trả về', exact: true })).toHaveCount(0);
  await scan(handler.page, 'pool-voter-desktop');
  await handler.page.evaluate(() => scrollTo(0, 0));
  await handler.page.screenshot({
    path: '.local/evidence/workflows-pool-voter-desktop.png',
    fullPage: true,
  });
  await handler.page.setViewportSize({ width: 390, height: 844 });
  await scan(handler.page, 'pool-voter-mobile');
  await handler.page.evaluate(() => scrollTo(0, 0));
  await handler.page.screenshot({
    path: '.local/evidence/workflows-pool-voter-mobile.png',
    fullPage: true,
  });
  stage = 'First vote persists without completing task';
  await handler.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await confirm(handler.page);
  run = await detail(handler.context, runId);
  assert.equal(run.canAct, false);
  assert.equal(run.run.status, 'running');
  assert.equal(
    run.tasks[0].members.filter((m: { action: string }) => m.action === 'approve').length,
    1,
  );
  await status(
    await write(handler.context, '/tasks/' + task.id + '/action', {
      expectedRevision: task.revision,
      action: 'approve',
      answers: {},
    }),
    409,
  );
  stage = 'Revoke remaining voter then restore live group explicitly';
  response = await write(coordinator.context, '/groups/' + group.id, {
    name: group.name,
    orgUnitId: ids.unitA,
    accountIds: [role('reviewer').id],
    active: true,
    expectedRevision: group.revision,
  });
  await status(response, 200);
  group = await response.json();
  await status(
    await finance.context.request.get(
      W + '/api/v1/workflows/runs/' + runId + '?tenantId=' + ids.tenantA,
    ),
    403,
  );
  await status(
    await write(finance.context, '/tasks/' + task.id + '/action', {
      expectedRevision: task.revision,
      action: 'approve',
      answers: {},
    }),
    403,
  );
  response = await write(coordinator.context, '/groups/' + group.id, {
    name: group.name,
    orgUnitId: ids.unitA,
    accountIds: [role('reviewer').id, role('analyst').id],
    active: true,
    expectedRevision: group.revision,
  });
  await status(response, 200);
  stage = 'Second vote completes once and history keeps both decisions';
  await openRun(finance.page, runId);
  await finance.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await confirm(finance.page);
  run = await detail(requester.context, runId);
  assert.equal(run.run.status, 'completed');
  assert.equal(
    run.tasks[0].members.filter((m: { action: string }) => m.action === 'approve').length,
    2,
  );
  await finance.page.getByRole('tab', { name: 'Lịch sử', exact: true }).click();
  await scan(finance.page, 'pool-history');
  await finance.page.evaluate(() => scrollTo(0, 0));
  await finance.page.screenshot({
    path: '.local/evidence/workflows-pool-history.png',
    fullPage: true,
  });
  await writeFile(
    '.local/evidence/workflows-pools-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans,
        runId,
        checks: [
          'real SSO/MFA designer and publisher',
          'UI v4 pool quorum, calendar, minute SLA and return policy',
          'keyboard checkbox and 390px responsive',
          'two separate voter decisions with live group revocation',
          'server duplicate vote prevention and immutable history',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: configurable pooled approvals and calendar via real SSO; ' +
      scans.length +
      ' axe scans.',
  );
} catch (error) {
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error('Numeric assertion ' + error.actual + '/' + error.expected);
  console.error(
    'Pools E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  if (
    current &&
    !current.isClosed() &&
    new URL(current.url()).origin === W &&
    new URL(current.url()).pathname === '/' &&
    (await current.locator('input[type=password]').count()) === 0
  )
    await current.screenshot({
      path: '.local/evidence/workflows-pools-failure.png',
      fullPage: true,
    });
  process.exitCode = 1;
} finally {
  await browser.close();
  app?.server.closeAllConnections();
  await app?.close();
}
