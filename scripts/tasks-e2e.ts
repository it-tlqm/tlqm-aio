import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect } from '@playwright/test';
import type { APIResponse, BrowserContext, Locator, Page } from '@playwright/test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { Store } from '../src/store.js';
import { tasksDirectory } from '../src/tasks-boundary.js';
import { loadTasksConfig, tasksDatabaseUrl } from '../src/tasks/database.js';
import type { ProjectItem, TaskDetail, TaskReport } from '../src/tasks/options.js';
import { TasksService } from '../src/tasks/service.js';
import { reserveTestRequests } from './e2e-request-budget.js';
import type { FormsFixture } from './forms-fixtures.js';
import { localContainer } from './local-docker.js';
import { nextFixtureOtp } from './local-totp.js';

const A = 'http://127.0.0.1:4100';
const T = 'http://127.0.0.1:4106';
const api = T + '/api/v1/tasks';
const evidence = '.local/evidence/tasks-';
const runtime = await loadLocalConfig();
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
function role(name: FormsFixture['role']) {
  const user = fixtures.users.find((entry) => entry.role === name);
  assert.ok(user);
  return user;
}

const foundation = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 3 });
const tasks = new pg.Pool({
  connectionString: tasksDatabaseUrl(await loadTasksConfig(runtime.instanceId), true),
  max: 2,
});
const worker = new TasksService(tasks, tasksDirectory(new Store(foundation)));
const servers: Awaited<ReturnType<typeof createApp>>[] = [];
const checks: string[] = [];
const scans: {
  screen: string;
  violations: string[];
  incomplete: { id: string; targets: unknown[] }[];
}[] = [];
const browser = await chromium.launch({ headless: true });
let stage = 'preflight';

async function status(response: APIResponse, code = 200, error?: string) {
  assert.equal(response.status(), code);
  if (error) assert.equal((await response.json()).error, error);
  return response;
}
async function read(context: BrowserContext, path: string, tenantId: string = ids.tenantA) {
  return context.request.get(api + path + '?' + new URLSearchParams({ tenantId }));
}
async function csrf(context: BrowserContext) {
  return (
    (await (await status(await context.request.get(T + '/api/v1/me'))).json()) as {
      csrfToken: string;
    }
  ).csrfToken;
}
async function denyWrite(
  context: BrowserContext,
  path: string,
  body: Record<string, unknown>,
  token: string,
  error: string,
) {
  await status(
    await context.request.post(api + path, {
      headers: { origin: T, 'x-csrf-token': token, 'idempotency-key': randomUUID() },
      data: { ...body, tenantId: ids.tenantA, reason: 'Kiểm quyền Công việc giả lập' },
    }),
    403,
    error,
  );
}
async function login(
  user: { id: string; username: string; password: string },
  base = T,
  mfa = false,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { tasksCsp: violations });
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(event.violatedDirective),
    );
  });
  const page = await context.newPage();
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === base && url.pathname === '/');
  const session = await context.request.get(base + '/api/v1/me');
  if (session.status() !== 200) {
    const runtimeResponse = await context.request.get(base + '/api/v1/runtime-info');
    const code = (await runtimeResponse.json().catch(() => ({}))).authError;
    if (typeof code === 'string' && /^[A-Z_]+$/.test(code))
      console.error('Login rejected: ' + code);
  }
  await status(session);
  return { context, page };
}
async function select(scope: Page | Locator, label: string, value: string) {
  const trigger = scope.getByRole('combobox', { name: label, exact: true });
  await trigger.click();
  const page = 'page' in scope ? scope.page() : scope;
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(trigger).toHaveText(value);
}
async function scan(page: Page, screen: string) {
  assert.equal(new URL(page.url()).origin, T);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    screen,
    violations: result.violations.map((entry) => entry.id),
    incomplete: result.incomplete.map((entry) => ({
      id: entry.id,
      targets: entry.nodes.map((node) => node.target),
    })),
  });
  if (result.violations.length)
    console.error(
      JSON.stringify(
        result.violations.map((entry) => ({
          id: entry.id,
          targets: entry.nodes.map((node) => node.target),
        })),
      ),
    );
  assert.deepEqual(
    result.violations.map((entry) => entry.id),
    [],
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'tasksCsp')), []);
  await page.screenshot({
    path: evidence + screen + '.png',
    fullPage: true,
    animations: 'disabled',
  });
}

try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  for (const [pool, purpose] of [
    [foundation, 'tlqm-aio-test'],
    [tasks, 'tlqm-aio-tasks-test'],
  ] as const) {
    const marker = await pool.query('SELECT purpose FROM environment_marker');
    assert.equal(marker.rowCount, 1);
    assert.equal(marker.rows[0].purpose, purpose);
  }
  assert.equal(
    (await tasks.query('SELECT instance_id FROM environment_marker')).rows[0].instance_id,
    runtime.instanceId,
  );
  for (const code of ['aio-foundation', 'aio-tasks']) {
    const client = runtime.clients.find((entry) => entry.code === code);
    assert.ok(client);
    const app = await createApp({
      runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
      client,
      test: true,
      logger: false,
    });
    servers.push(app);
    await app.listen({ host: '127.0.0.1', port: client.port });
  }
  await mkdir('.local/evidence', { recursive: true });
  const suffix = randomUUID().slice(0, 8);
  const projectName = 'Bàn giao thiết bị ' + suffix;
  const title = 'Kiểm kê thiết bị ' + suffix;
  const child = 'Đối chiếu mã tài sản ' + suffix;
  const discussion = 'Đã kiểm kê thiết bị và cập nhật danh sách bàn giao.';
  const overdueDay = new Date(Date.now() + 7 * 3600000 - 86400000).toISOString().slice(0, 10);
  const reviewer = role('reviewer');
  const analyst = role('analyst');
  const learner = runtime.users.find((user) => user.id === ids.learner);
  assert.ok(learner);

  stage = 'Portal card and cross-app SSO';
  const viewer = await login(learner, A);
  await viewer.page
    .locator('[data-slot=card]')
    .filter({ has: viewer.page.getByText('AIO Công việc', { exact: true }) })
    .getByRole('link', { name: 'Mở ứng dụng' })
    .click();
  await viewer.page.waitForURL((url) => url.origin === T && url.pathname === '/');
  await viewer.page.getByRole('link', { name: 'Đăng nhập SSO' }).click();
  await viewer.page.getByRole('heading', { name: 'Dự án', exact: true }).waitFor();
  await expect(viewer.page.locator('#username,#password,#otp')).toHaveCount(0);
  await status(await viewer.context.request.get(T + '/api/v1/me'));

  stage = 'Tasks manager MFA';
  const { page, context } = await login(role('publisher'), T, true);
  checks.push('Portal card and cross-app Tasks SSO; direct Tasks login with verified manager MFA');

  stage = 'Project and member forms';
  const lookups = (await (await status(await read(context, '/lookups'))).json()) as {
    units: { id: string; name: string }[];
  };
  const unit = lookups.units.find(({ id }) => id === ids.unitA);
  assert.ok(unit);
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  await select(dialog, 'Đơn vị quản lý', unit.name);
  await dialog.getByLabel('Tên dự án').fill(projectName);
  await dialog
    .getByLabel('Mô tả dự án')
    .fill('Bàn giao và đối chiếu thiết bị trong đơn vị giả lập.');
  await dialog.getByRole('button', { name: 'Lưu dự án' }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  const projectId = new URL(page.url()).hash.split('/').at(-1);
  assert.match(projectId ?? '', /^[a-f0-9-]{36}$/);
  const projectPath = '/projects/' + projectId;
  const projectUrl = T + '/#tasks/project/' + projectId;
  const project = (await (await status(await read(context, projectPath))).json()) as {
    project: ProjectItem;
  };
  assert.equal(project.project.unitId, ids.unitA);
  await page.getByRole('button', { name: 'Thành viên', exact: true }).click();
  for (const [member, label] of [
    [reviewer, 'Thành viên'],
    [analyst, 'Thành viên'],
    [learner, 'Người xem'],
  ] as const) {
    await page.getByRole('button', { name: 'Thêm thành viên' }).click();
    await select(dialog, 'Nhân sự', member.name);
    await select(dialog, 'Vai trò dự án', label);
    await dialog.getByRole('button', { name: 'Lưu thành viên' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Quyền của ' + member.name })).toBeVisible();
  }

  stage = 'Assignment, related person and subtask';
  await page.getByRole('button', { name: 'Danh sách', exact: true }).click();
  await page.getByRole('button', { name: 'Tạo công việc' }).click();
  await dialog.getByLabel('Tên công việc').fill(title);
  await dialog.getByLabel('Mô tả công việc').fill('Kiểm kê và chuẩn bị hồ sơ trước khi bàn giao.');
  await dialog.getByLabel('Hạn hoàn thành').fill(overdueDay);
  await select(dialog, 'Nhắc hạn', 'Trong ngày đến hạn');
  await select(dialog, 'Người thực hiện', reviewer.name);
  await dialog.getByRole('checkbox', { name: analyst.name }).check();
  await dialog.getByRole('button', { name: 'Lưu công việc' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const taskId = new URL(page.url()).hash.split('/').at(-1);
  assert.match(taskId ?? '', /^[a-f0-9-]{36}$/);
  const taskPath = '/items/' + taskId;
  const taskUrl = projectUrl + '/' + taskId;
  await dialog.getByRole('button', { name: 'Thêm việc con' }).click();
  await dialog.getByLabel('Tên công việc').fill(child);
  await dialog.getByRole('button', { name: 'Lưu công việc' }).click();
  await expect(dialog.getByRole('button', { name: child, exact: true })).toBeVisible();
  const detail = (await (await status(await read(context, taskPath))).json()) as TaskDetail;
  assert.equal(detail.item.assignee?.accountId, reviewer.id);
  assert.equal(detail.item.dueOn, overdueDay);
  assert.equal(detail.item.overdue, true);
  assert.deepEqual(
    detail.participants.map(({ accountId }) => accountId),
    [analyst.id],
  );
  assert.deepEqual(
    detail.children.map(({ parentId, title: name }) => [parentId, name]),
    [[taskId, child]],
  );
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  checks.push(
    'Project, project membership, assigned task, related person, Vietnam due date, subtask',
  );

  stage = 'Viewer, unit, tenant and CSRF denial';
  await reserveTestRequests(context, T);
  await viewer.page.goto(taskUrl);
  await expect(viewer.page.getByRole('dialog', { name: title })).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Cập nhật tiến độ' })).toHaveCount(0);
  await expect(viewer.page.getByRole('button', { name: 'Bàn giao', exact: true })).toHaveCount(0);
  await expect(viewer.page.getByRole('textbox', { name: 'Nội dung trao đổi' })).toHaveCount(0);
  await viewer.page.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(viewer.page.getByRole('heading', { name: projectName })).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Báo cáo', exact: true })).toHaveCount(0);
  await status(await read(viewer.context, projectPath + '/report'), 403, 'TASKS_PERMISSION_DENIED');
  const progress = { status: 'doing', progress: 30, expectedRevision: detail.item.revision };
  await denyWrite(
    viewer.context,
    taskPath + '/progress',
    progress,
    await csrf(viewer.context),
    'TASKS_PERMISSION_DENIED',
  );
  await denyWrite(context, taskPath + '/progress', progress, 'invalid-csrf', 'CSRF_REJECTED');
  const outside = await login(role('respondent'));
  await status(await read(outside.context, projectPath), 403, 'TASKS_PERMISSION_DENIED');
  await status(await read(outside.context, taskPath), 403, 'TASKS_PERMISSION_DENIED');
  await status(await read(context, taskPath, ids.tenantB), 403, 'TASKS_PERMISSION_DENIED');
  await viewer.context.close();
  await outside.context.close();
  checks.push(
    'Read-only viewer, scoped report denial, direct URL outside unit/tenant, mutation CSRF denial',
  );

  stage = 'Reminder, keyboard progress and discussion';
  const handler = await login(reviewer);
  await worker.runReminders();
  await worker.runReminders();
  const reminders = async (client: BrowserContext) =>
    (
      (await (await status(await read(client, '/reminders'))).json()) as {
        items: { taskId: string; kind: string }[];
      }
    ).items.filter((item) => item.taskId === taskId);
  assert.equal((await reminders(handler.context)).length, 1);
  await handler.page.getByRole('button', { name: 'Nhắc hạn', exact: true }).click();
  const reminder = handler.page.getByRole('button', { name: 'Mở ' + title, exact: true });
  await expect(reminder).toBeVisible();
  await reminder.focus();
  await handler.page.keyboard.press('Enter');
  const handling = handler.page.getByRole('dialog');
  await expect(handling.getByRole('heading', { name: title })).toBeVisible();
  const update = handling.getByRole('button', { name: 'Cập nhật tiến độ', exact: true });
  await update.focus();
  await handler.page.keyboard.press('Enter');
  const newStatus = handling.getByRole('combobox', { name: 'Trạng thái mới' });
  await newStatus.press('Enter');
  await expect(
    handler.page.getByRole('option', { name: 'Cần thực hiện', exact: true }),
  ).toBeFocused();
  await handler.page.keyboard.press('ArrowDown');
  await expect(
    handler.page.getByRole('option', { name: 'Đang thực hiện', exact: true }),
  ).toBeFocused();
  await handler.page.keyboard.press('Enter');
  await expect(newStatus).toHaveText('Đang thực hiện');
  await handler.page.keyboard.press('Tab');
  const percent = handling.getByLabel('Tiến độ (%)');
  await expect(percent).toBeFocused();
  await percent.fill('35');
  await handler.page.keyboard.press('Tab');
  await expect(handling.getByLabel('Lý do')).toBeFocused();
  await handler.page.keyboard.type('Cap nhat sau kiem ke');
  await handling.getByRole('button', { name: 'Lưu tiến độ' }).press('Enter');
  await expect(handling.getByText('35%', { exact: true })).toBeVisible();
  await handling.getByRole('textbox', { name: 'Nội dung trao đổi' }).fill(discussion);
  await handling.getByRole('button', { name: 'Gửi trao đổi' }).click();
  await expect(handling.getByText(discussion, { exact: true })).toBeVisible();
  checks.push('Deduplicated overdue reminder, keyboard open/status/progress, saved discussion');

  stage = 'Handoff and immediate loss of old scope';
  await reserveTestRequests(context, T);
  await handling.getByRole('button', { name: 'Bàn giao', exact: true }).click();
  await select(handling, 'Người nhận bàn giao', analyst.name);
  await handling.getByLabel('Lý do').fill('Bàn giao sau khi hoàn tất kiểm kê');
  await handling.getByRole('button', { name: 'Xác nhận bàn giao' }).click();
  await expect(
    handling.getByText('Bạn thiếu quyền trong phạm vi dự án hoặc công việc này.'),
  ).toBeVisible();
  await status(await read(handler.context, taskPath), 403, 'TASKS_PERMISSION_DENIED');
  assert.deepEqual(await reminders(handler.context), []);
  await handler.context.close();
  const receiver = await login(analyst);
  await worker.runReminders();
  assert.deepEqual(
    (await reminders(receiver.context)).map((item) => item.kind),
    ['overdue'],
  );
  await receiver.page.goto(taskUrl);
  const receiving = receiver.page.getByRole('dialog');
  await expect(receiving.getByText(discussion, { exact: true })).toBeVisible();
  await receiving.getByText('Lịch sử công việc', { exact: true }).click();
  await expect(
    receiving.getByText('Bàn giao sau khi hoàn tất kiểm kê', { exact: false }),
  ).toBeVisible();
  const reassigned = (await (
    await status(await read(receiver.context, taskPath))
  ).json()) as TaskDetail;
  assert.equal(reassigned.item.assignee?.accountId, analyst.id);
  assert.equal(reassigned.item.progress, 35);
  assert.deepEqual(reassigned.children, []);
  await receiver.page.setViewportSize({ width: 390, height: 844 });
  await scan(receiver.page, 'task-mobile');
  await receiver.page.keyboard.press('Escape');
  await expect(receiving).toBeHidden();
  const heading = receiver.page.getByRole('heading', { name: projectName, exact: true });
  await expect(heading).toBeFocused();
  const list = receiver.page.getByRole('region', { name: 'Danh sách công việc' });
  const taskButton = list.getByRole('button', { name: title, exact: true });
  await taskButton.press('Enter');
  await expect(receiving.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const firstAction = receiving.getByRole('button', { name: 'Cập nhật tiến độ', exact: true });
  const lastAction = receiving.getByRole('button', { name: 'Đóng', exact: true });
  await firstAction.focus();
  await receiver.page.keyboard.press('Shift+Tab');
  await expect(lastAction).toBeFocused();
  await receiver.page.keyboard.press('Tab');
  await expect(firstAction).toBeFocused();
  await receiver.page.keyboard.press('Escape');
  await expect(receiving).toBeHidden();
  await expect(taskButton).toBeFocused();
  checks.push(
    'New assignee sees discussion and handoff audit, prior assignee loses task and reminder in-session',
  );

  stage = 'Kanban, scoped report and revocation';
  await receiver.page.setViewportSize({ width: 1440, height: 980 });
  await receiver.page.getByRole('button', { name: 'Bảng Kanban' }).click();
  const board = receiver.page.getByRole('region', { name: 'Bảng công việc' });
  const doing = board.getByRole('region', { name: 'Đang thực hiện' });
  const done = board.getByRole('region', { name: 'Hoàn thành' });
  const card = doing.getByRole('listitem').filter({ hasText: title });
  await expect(card.getByText('35%', { exact: true })).toBeVisible();
  await expect(board.getByRole('button', { name: child, exact: true })).toHaveCount(0);
  await card.dragTo(done);
  await expect(done.getByRole('button', { name: title, exact: true })).toBeVisible();
  await scan(receiver.page, 'kanban-desktop');
  const analystReport = (await (
    await status(await read(receiver.context, projectPath + '/report'))
  ).json()) as TaskReport;
  const managerReport = (await (
    await status(await read(context, projectPath + '/report'))
  ).json()) as TaskReport;
  assert.equal(analystReport.total, 1);
  assert.deepEqual(analystReport.statuses, { todo: 0, doing: 0, done: 1 });
  assert.equal(analystReport.percentDone, 100);
  assert.equal(managerReport.total, 2);
  assert.deepEqual(await reminders(receiver.context), []);
  await receiver.page.getByRole('button', { name: 'Báo cáo', exact: true }).click();
  const report = receiver.page.getByRole('region', { name: 'Báo cáo dự án', exact: true });
  await expect(report.getByText('100%', { exact: true })).toBeVisible();
  await receiver.page.setViewportSize({ width: 390, height: 844 });
  const reportTable = report.getByRole('region', { name: 'Báo cáo theo người thực hiện' });
  await reportTable.scrollIntoViewIfNeeded();
  await reportTable.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(reportTable.getByRole('columnheader', { name: 'Quá hạn' })).toBeInViewport();
  await scan(receiver.page, 'report-mobile');
  await reportTable.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await page.getByRole('button', { name: 'Thành viên', exact: true }).click();
  await page.getByRole('button', { name: 'Quyền của ' + analyst.name }).click();
  await dialog.getByRole('checkbox', { name: 'Thành viên còn hiệu lực' }).uncheck();
  await dialog.getByRole('button', { name: 'Lưu thành viên' }).click();
  await expect(dialog).toBeHidden();
  await status(await read(receiver.context, projectPath), 403, 'TASKS_PERMISSION_DENIED');
  await status(await read(receiver.context, taskPath), 403, 'TASKS_PERMISSION_DENIED');
  await status(
    await read(receiver.context, projectPath + '/report'),
    403,
    'TASKS_PERMISSION_DENIED',
  );
  await receiver.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await expect(report).toBeHidden();
  await expect(
    receiver.page.getByText('Bạn thiếu quyền trong phạm vi dự án hoặc công việc này.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Lưu trữ dự án' }).click();
  await expect(page.getByText('Đã lưu trữ', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tạo công việc' })).toHaveCount(0);
  checks.push(
    'Kanban drag persists completion, scoped report differs from manager totals, live membership revocation and archive',
  );

  const time = new Date();
  const receipt = {
    timeUtc: time.toISOString(),
    timeVietnam: time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    checks,
    scans,
  };
  await writeFile(evidence + 'e2e.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    'PASS: Tasks local SSO/MFA, permissions, assignment, reminders, handoff, Kanban and reports; ' +
      scans.length +
      ' axe scans.',
  );
} catch (error) {
  const location =
    error instanceof Error && error.stack?.match(/scripts[\\/]tasks-e2e\.ts:\d+:\d+/)?.[0];
  console.error('Tasks E2E failed at ' + stage + (location ? ' (' + location + ')' : '') + '.');
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error('Numeric assertion: ' + error.actual + '/' + error.expected);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const app of servers) {
    app.server.closeAllConnections();
    await app.close();
  }
  await Promise.all([foundation.end(), tasks.end()]);
}
