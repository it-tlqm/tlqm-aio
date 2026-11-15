import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import type { Page, BrowserContext, APIResponse } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../src/app.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { businessPurchaseTemplate, workflowTemplate } from '../src/workflows/templates.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { reserveTestRequests } from './e2e-request-budget.js';
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
      'Assignment HTTP ' +
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
  idempotencyKey: string = randomUUID(),
) {
  const me = await (await context.request.get(W + '/api/v1/me')).json();
  return context.request.post(W + '/api/v1/workflows' + path, {
    headers: {
      origin: W,
      'x-csrf-token': badCsrf ? 'wrong' : me.csrfToken,
      'idempotency-key': idempotencyKey,
    },
    data: { ...data, tenantId: ids.tenantA, reason: 'Kiểm thử lựa chọn người xử lý' },
  });
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
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
  stage = 'MFA management and group creation';
  const coordinator = await login(role('publisher'), true),
    designer = await login(role('designer'), true),
    handler = await login(role('reviewer')),
    finance = await login(role('analyst')),
    requester = await login(runtime.users.find((user) => user.id === ids.learner)!);
  const groupName = 'Tổ xử lý ' + randomUUID().slice(0, 6),
    title = 'Luồng phân công ' + randomUUID().slice(0, 6);
  await coordinator.page.getByRole('button', { name: 'Nhóm xử lý', exact: true }).click();
  await coordinator.page.getByRole('button', { name: 'Tạo nhóm xử lý', exact: true }).click();
  let dialog = coordinator.page.getByRole('dialog');
  await dialog.getByLabel('Tên nhóm').fill(groupName);
  const lookups = await (
    await coordinator.context.request.get(W + '/api/v1/workflows/lookups?tenantId=' + ids.tenantA)
  ).json();
  await select(
    coordinator.page,
    'Phạm vi nhóm',
    lookups.units.find((unit: { id: string }) => unit.id === ids.unitA).name,
  );
  await dialog.getByLabel(role('reviewer').name, { exact: true }).check();
  await dialog.getByLabel(role('analyst').name, { exact: true }).check();
  await dialog.getByLabel('Lý do thay đổi nhóm').fill('Lập tổ xử lý giả lập');
  await scan(coordinator.page, 'group-dialog');
  await dialog.getByRole('button', { name: 'Lưu nhóm', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  let group = (
    (
      await (
        await coordinator.context.request.get(
          W + '/api/v1/workflows/groups?tenantId=' + ids.tenantA,
        )
      ).json()
    ).items as Group[]
  ).find((g) => g.name === groupName)!;
  assert.ok(group);
  await status(
    await requester.context.request.get(W + '/api/v1/workflows/groups?tenantId=' + ids.tenantA),
    403,
  );
  await status(
    await write(designer.context, '/groups', {
      name: 'Không cấp quyền',
      orgUnitId: ids.unitA,
      accountIds: [],
      active: true,
    }),
    403,
  );
  await status(
    await write(
      coordinator.context,
      '/groups',
      { name: 'CSRF', orgUnitId: ids.unitA, accountIds: [], active: true },
      true,
    ),
    403,
  );
  stage = 'Designer selects group and guaranteed prior actor';
  const spec = workflowTemplate();
  spec.name = title;
  spec.audienceUnits = [ids.unitA];
  for (const node of spec.nodes)
    if (node.kind === 'approval' || node.kind === 'task') node.assignee = role('analyst').id;
  const created = await write(designer.context, '/definitions', {
    code: 'select-' + randomUUID().slice(0, 8),
    orgUnitId: ids.unitA,
    spec,
  });
  await status(created, 200);
  const definition = await created.json();
  await designer.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await designer.page
    .locator('[data-slot="card"]')
    .filter({ has: designer.page.getByText(title, { exact: true }) })
    .getByRole('button', { name: 'Thiết kế', exact: true })
    .click();
  await select(designer.page, 'Bước đang cấu hình', 'Trưởng bộ phận xem xét');
  await select(designer.page, 'Cách giao nhiệm vụ', 'Chọn người trong nhóm');
  await select(designer.page, 'Nhóm xử lý', groupName);
  const assigneeOption = designer.page.getByRole('checkbox', {
    name: 'Người đang được giao bước',
    exact: true,
  });
  await assigneeOption.press('Space');
  await expect(assigneeOption).toBeChecked();
  await designer.page
    .getByRole('checkbox', { name: 'Người đã chuyển hồ sơ đến bước', exact: true })
    .check();
  await scan(designer.page, 'delegated-reassignment-designer');
  await designer.page.screenshot({
    path: '.local/evidence/workflows-delegated-reassignment-designer.png',
    fullPage: true,
  });
  await select(designer.page, 'Bước đang cấu hình', 'Thực hiện mua sắm');
  await select(designer.page, 'Cách giao nhiệm vụ', 'Người đã xử lý bước trước');
  await select(designer.page, 'Lấy người từ bước', 'Trưởng bộ phận xem xét');
  await scan(designer.page, 'assignment-designer');
  await designer.page.screenshot({
    path: '.local/evidence/workflows-assignment-designer.png',
    fullPage: true,
  });
  await designer.page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(
    designer.page.getByText('Đã lưu bản nháp. Lượt chạy cũ vẫn dùng phiên bản của chúng.', {
      exact: true,
    }),
  ).toBeVisible();
  const saved = (
    (
      await (
        await designer.context.request.get(
          W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
        )
      ).json()
    ).items as { id: string; revision: number; draft: typeof spec }[]
  ).find((d) => d.id === definition.id)!;
  assert.equal(saved.draft.schemaVersion, 5);
  const configured = saved.draft.nodes.find((node) => node.id === 'review');
  assert(configured && 'reassignRoles' in configured);
  assert.deepEqual(configured.reassignRoles, ['assignee', 'sender']);
  await status(
    await write(coordinator.context, '/definitions/' + definition.id + '/publish', {
      expectedRevision: saved.revision,
    }),
    200,
  );
  stage = 'Requester chooses eligible member';
  await requester.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await requester.page
    .locator('[data-slot="card"]')
    .filter({ has: requester.page.getByText(title, { exact: true }) })
    .getByRole('button', { name: 'Khởi chạy' })
    .click();
  dialog = requester.page.getByRole('dialog');
  await dialog.locator('#answer-purpose').fill('Nội dung giả lập');
  await dialog.locator('#answer-amount').fill('100');
  await dialog.locator('#answer-needed_on').fill('2026-12-01');
  await expect(dialog.getByRole('button', { name: 'Gửi đề nghị' })).toBeDisabled();
  await select(requester.page, 'Người nhận — Trưởng bộ phận xem xét', role('reviewer').name);
  await scan(requester.page, 'request-selection');
  await dialog.getByRole('button', { name: 'Gửi đề nghị' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const runId = new URL(requester.page.url()).hash.slice(14);
  let run = await detail(requester.context, runId),
    task = run.tasks.find((t) => t.status === 'pending')!;
  assert.equal(task.assignee_account_id, role('reviewer').id);
  assert.equal(task.assignment_group_id, group.id);
  stage = 'Delegated reassignment by current assignee and original sender';
  await openRun(handler.page, runId);
  await handler.page.getByRole('button', { name: 'Phân công lại', exact: true }).click();
  await select(handler.page, 'Người nhận nhiệm vụ', role('analyst').name);
  await handler.page.setViewportSize({ width: 390, height: 844 });
  await scan(handler.page, 'delegated-reassignment-mobile');
  await handler.page.screenshot({
    path: '.local/evidence/workflows-delegated-reassignment-mobile.png',
    fullPage: true,
  });
  await handler.page.getByRole('dialog').getByRole('button', { name: 'Tiếp tục' }).click();
  await confirm(handler.page);
  await expect(handler.page).toHaveURL(W + '/#workflows/inbox');
  const forwarded = await detail(requester.context, runId);
  assert.equal(
    forwarded.tasks.find((task) => task.status === 'pending')?.assignee_account_id,
    role('analyst').id,
  );
  await openRun(requester.page, runId);
  await requester.page.getByRole('button', { name: 'Phân công lại', exact: true }).click();
  await select(requester.page, 'Người nhận nhiệm vụ', role('reviewer').name);
  await requester.page.getByRole('dialog').getByRole('button', { name: 'Tiếp tục' }).click();
  await confirm(requester.page);
  run = await detail(requester.context, runId);
  task = run.tasks.find((t) => t.status === 'pending')!;
  assert.equal(task.assignee_account_id, role('reviewer').id);
  stage = 'Remove member while task open';
  await coordinator.page
    .locator('[data-slot="card"]')
    .filter({ has: coordinator.page.getByText(groupName, { exact: true }) })
    .getByRole('button', { name: 'Sửa nhóm' })
    .click();
  dialog = coordinator.page.getByRole('dialog');
  await dialog.getByLabel(role('reviewer').name, { exact: true }).uncheck();
  await dialog.getByLabel('Lý do thay đổi nhóm').fill('Thu hồi thành viên đang được giao');
  await dialog.getByRole('button', { name: 'Lưu nhóm' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const inbox = await handler.context.request.get(
    W + '/api/v1/workflows/runs?tenantId=' + ids.tenantA + '&view=inbox',
  );
  await status(inbox, 200);
  assert.equal(
    (await inbox.json()).items.some((row: { id: string }) => row.id === runId),
    false,
  );
  await status(
    await handler.context.request.get(
      W + '/api/v1/workflows/runs/' + runId + '?tenantId=' + ids.tenantA,
    ),
    403,
  );
  await status(
    await write(handler.context, '/tasks/' + task.id + '/action', {
      expectedRevision: task.revision,
      action: 'approve',
      answers: {},
    }),
    403,
  );
  await status(
    await write(coordinator.context, '/tasks/' + task.id + '/reassign', {
      expectedRevision: task.revision,
      accountId: role('reviewer').id,
    }),
    403,
  );
  stage = 'Reassign within group and follow actual previous actor';
  await openRun(coordinator.page, runId);
  await coordinator.page.getByRole('button', { name: 'Phân công lại', exact: true }).click();
  await select(coordinator.page, 'Người nhận nhiệm vụ', role('analyst').name);
  await coordinator.page.getByRole('dialog').getByRole('button', { name: 'Tiếp tục' }).click();
  await confirm(coordinator.page);
  await openRun(finance.page, runId);
  await finance.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await confirm(finance.page);
  run = await detail(requester.context, runId);
  task = run.tasks.find((t) => t.status === 'pending')!;
  assert.equal(task.node_id, 'fulfil');
  assert.equal(task.assignee_account_id, role('analyst').id);
  assert.equal(run.selections[0].choices.review, role('reviewer').id);
  stage = 'Return and select again';
  await finance.page.getByRole('button', { name: 'Trả về', exact: true }).click();
  await confirm(finance.page);
  await requester.page.getByRole('button', { name: 'Tải lại lượt chạy' }).click();
  await expect(
    requester.page.getByRole('combobox', { name: 'Người nhận — Trưởng bộ phận xem xét' }),
  ).toContainText('Chọn người nhận');
  await expect(requester.page.getByRole('button', { name: 'Gửi lại đề nghị' })).toBeDisabled();
  await select(requester.page, 'Người nhận — Trưởng bộ phận xem xét', role('analyst').name);
  await requester.page.setViewportSize({ width: 390, height: 844 });
  await scan(requester.page, 'resubmit-mobile');
  await requester.page.screenshot({
    path: '.local/evidence/workflows-assignment-mobile.png',
    fullPage: true,
  });
  await requester.page.getByRole('button', { name: 'Gửi lại đề nghị' }).click();
  await confirm(requester.page);
  run = await detail(requester.context, runId);
  assert.equal(run.selections.length, 2);
  assert.equal(run.selections[1].choices.review, role('analyst').id);
  assert.equal(run.run.round, 2);
  stage = 'Group disable/enable cannot restore removed member';
  group = (
    (
      await (
        await coordinator.context.request.get(
          W + '/api/v1/workflows/groups?tenantId=' + ids.tenantA,
        )
      ).json()
    ).items as Group[]
  ).find((g) => g.id === group.id)!;
  const disabled = await write(coordinator.context, '/groups/' + group.id, {
    name: group.name,
    orgUnitId: group.org_unit_id,
    accountIds: group.account_ids,
    active: false,
    expectedRevision: group.revision,
  });
  await status(disabled, 200);
  const closed = await disabled.json();
  task = run.tasks.find((t) => t.status === 'pending')!;
  await status(
    await write(finance.context, '/tasks/' + task.id + '/action', {
      expectedRevision: task.revision,
      action: 'approve',
      answers: {},
    }),
    403,
  );
  const reopened = await write(coordinator.context, '/groups/' + group.id, {
    name: group.name,
    orgUnitId: group.org_unit_id,
    accountIds: group.account_ids,
    active: true,
    expectedRevision: closed.revision,
  });
  await status(reopened, 200);
  assert.equal((await reopened.json()).account_ids.includes(role('reviewer').id), false);
  await openRun(finance.page, runId);
  await finance.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await confirm(finance.page);
  await finance.page.locator('#answer-result_note').fill('Đã hoàn tất lượt chạy động');
  await finance.page.getByRole('button', { name: 'Hoàn tất bước' }).click();
  await confirm(finance.page);
  assert.equal((await detail(requester.context, runId)).run.status, 'completed');
  stage = 'Configure a rejection destination and select the next recipient at handoff';
  const handoffSpec = workflowTemplate('blank');
  handoffSpec.name = 'Bàn giao để đối soát ' + randomUUID().slice(0, 6);
  handoffSpec.audienceUnits = [ids.unitA];
  handoffSpec.schemaVersion = 2;
  const review = handoffSpec.nodes.find((node) => node.id === 'review');
  assert(review?.kind === 'approval');
  review.assignee = role('reviewer').id;
  handoffSpec.nodes.push({
    id: 'correction',
    kind: 'task',
    label: 'Đối soát hồ sơ',
    next: 'end',
    assignee: '',
    dueHours: 24,
    form: null,
    assigneeRule: { kind: 'group', groupId: group.id },
  });
  const handoffResponse = await write(designer.context, '/definitions', {
    code: 'handoff-' + randomUUID().slice(0, 8),
    orgUnitId: ids.unitA,
    spec: handoffSpec,
  });
  await status(handoffResponse, 200);
  const handoffDefinition = await handoffResponse.json();
  current = designer.page;
  await designer.page.goto(W + '/');
  await designer.page.reload();
  await designer.page
    .locator('[data-slot="card"]')
    .filter({ has: designer.page.getByText(handoffSpec.name, { exact: true }) })
    .getByRole('button', { name: 'Thiết kế', exact: true })
    .click();
  await select(designer.page, 'Bước đang cấu hình', review.label);
  await select(designer.page, 'Khi từ chối', 'Đối soát hồ sơ');
  await select(designer.page, 'Bước đang cấu hình', 'Đối soát hồ sơ');
  await select(designer.page, 'Thời điểm chọn người', 'Khi bàn giao đến bước');
  await scan(designer.page, 'handoff-designer');
  await designer.page.screenshot({
    path: '.local/evidence/workflows-action-handoff-desktop.png',
    fullPage: true,
  });
  await select(designer.page, 'Khi trả về', 'Người xử lý chọn bước');
  await scan(designer.page, 'return-designer');
  await designer.page.screenshot({
    path: '.local/evidence/workflows-prior-return-desktop.png',
    fullPage: true,
  });
  await designer.page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(
    designer.page.getByText('Đã lưu bản nháp. Lượt chạy cũ vẫn dùng phiên bản của chúng.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  const handoffPublishedResponse = await write(
    coordinator.context,
    '/definitions/' + handoffDefinition.id + '/publish',
    { expectedRevision: handoffDefinition.revision + 1 },
  );
  await status(handoffPublishedResponse, 200);
  const handoffPublished = await handoffPublishedResponse.json();
  assert.equal(
    handoffPublished.version.spec.nodes.find((n: { id: string }) => n.id === 'correction')
      .returnMode,
    'choose',
  );
  const handoffInput = {
    definitionId: handoffDefinition.id,
    versionId: handoffPublished.version.id,
    unitId: ids.unitA,
    title: handoffSpec.name,
    answers: { purpose: 'Kiểm chứng bàn giao', requested_on: '2026-12-01' },
  };
  const createdRun = await write(requester.context, '/runs', handoffInput);
  await status(createdRun, 200);
  const handoffRunId = (await createdRun.json()).id;
  await openRun(handler.page, handoffRunId);
  await handler.page.getByRole('button', { name: 'Từ chối', exact: true }).click();
  dialog = handler.page.getByRole('dialog');
  await dialog.getByLabel('Ý kiến / lý do').fill('Chuyển hồ sơ để đối soát');
  await expect(dialog.getByRole('button', { name: 'Xác nhận', exact: true })).toBeDisabled();
  const recipient = dialog.getByRole('combobox', { name: 'Người nhận bàn giao' });
  await recipient.focus();
  await handler.page.keyboard.press('Enter');
  const option = handler.page.getByRole('option', { name: role('analyst').name, exact: true });
  await expect(option).toBeVisible();
  await handler.page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(recipient).toBeFocused();
  await handler.page.keyboard.press('Enter');
  await expect(option).toBeVisible();
  await handler.page.keyboard.press('Home');
  const options = handler.page.getByRole('option');
  await expect(options.first()).toBeFocused();
  for (
    let index = 0;
    index < (await options.count()) &&
    !(await option.evaluate((item) => item === document.activeElement));
    index++
  )
    await handler.page.keyboard.press('ArrowDown');
  await expect(option).toBeFocused();
  await handler.page.keyboard.press('Enter');
  await expect(recipient).toHaveText(role('analyst').name);
  await expect(recipient).toBeFocused();
  await scan(handler.page, 'handoff-mobile');
  await handler.page.screenshot({
    path: '.local/evidence/workflows-action-handoff-mobile.png',
  });
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const handed = await detail(requester.context, handoffRunId);
  assert.equal(handed.tasks.find((item) => item.node_id === 'review')?.status, 'rejected');
  assert.equal(
    handed.tasks.find((item) => item.status === 'pending')?.assignee_account_id,
    role('analyst').id,
  );
  await openRun(finance.page, handoffRunId);
  await finance.page.getByRole('button', { name: 'Hoàn tất bước', exact: true }).click();
  await confirm(finance.page);
  assert.equal((await detail(requester.context, handoffRunId)).run.status, 'completed');
  stage = 'Return to a previously handled step and complete a new attempt through the mobile UI';
  const needsCorrection = await write(requester.context, '/runs', {
    ...handoffInput,
    title: 'Mua sắm cần đối soát ' + randomUUID().slice(0, 6),
  });
  await status(needsCorrection, 200);
  const rewindRunId = (await needsCorrection.json()).id;
  await openRun(handler.page, rewindRunId);
  await handler.page.getByRole('button', { name: 'Từ chối', exact: true }).click();
  await select(handler.page, 'Người nhận bàn giao', role('analyst').name);
  await confirm(handler.page);
  const beforeReturn = await detail(requester.context, rewindRunId);
  const correction = beforeReturn.tasks.find((task) => task.status === 'pending')!;
  const reviewed = beforeReturn.tasks.find((task) => task.node_id === review.id)!;
  const foreignReview = handed.tasks.find((task) => task.node_id === review.id)!;
  await status(
    await write(finance.context, '/tasks/' + correction.id + '/action', {
      action: 'return',
      expectedRevision: correction.revision,
      answers: {},
      returnTarget: foreignReview.id,
    }),
    409,
  );
  await finance.page.setViewportSize({ width: 390, height: 844 });
  await openRun(finance.page, rewindRunId);
  await finance.page.getByRole('button', { name: 'Trả về', exact: true }).click();
  dialog = finance.page.getByRole('dialog');
  await dialog.getByLabel('Ý kiến / lý do').fill('Cần rà soát lại đề nghị mua sắm');
  const confirmReturn = dialog.getByRole('button', { name: 'Xác nhận', exact: true });
  await expect(confirmReturn).toBeDisabled();
  const returnPicker = dialog.getByRole('combobox', { name: 'Trả về', exact: true });
  await returnPicker.focus();
  await finance.page.keyboard.press('Enter');
  const previousOption = finance.page.getByRole('option', { name: review.label, exact: true });
  await expect(previousOption).toBeVisible();
  await finance.page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(returnPicker).toBeFocused();
  await finance.page.keyboard.press('Enter');
  await expect(previousOption).toBeVisible();
  await finance.page.keyboard.press('Home');
  await expect(finance.page.getByRole('option').first()).toBeFocused();
  await finance.page.keyboard.press('ArrowDown');
  await expect(previousOption).toBeFocused();
  await finance.page.keyboard.press('Enter');
  await expect(returnPicker).toBeFocused();
  await expect(confirmReturn).toBeEnabled();
  await scan(finance.page, 'return-mobile');
  await finance.page.screenshot({ path: '.local/evidence/workflows-prior-return-mobile.png' });
  await confirmReturn.click();
  await dialog.waitFor({ state: 'hidden' });
  const replayed = await detail(requester.context, rewindRunId);
  assert.ok(replayed.tasks.every((task) => !Object.hasOwn(task, 'execution_order')));
  const replacement = replayed.tasks.find((task) => task.status === 'pending')!;
  assert.equal(replacement.node_id, review.id);
  assert.equal(replacement.round, 1);
  assert.equal(replacement.attempt, 2);
  assert.equal(
    replayed.tasks.find((task) => task.id === reviewed.id)?.superseded_by_task_id,
    correction.id,
  );
  await openRun(handler.page, rewindRunId);
  await handler.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await confirm(handler.page);
  assert.equal((await detail(requester.context, rewindRunId)).run.status, 'completed');
  stage = 'Design a split and join, choose recipients, and complete independently assigned tasks';
  await reserveTestRequests(coordinator.context, W, 120);
  const parallelGroupResponse = await write(coordinator.context, '/groups', {
    name: 'Tổ song song ' + randomUUID().slice(0, 6),
    orgUnitId: ids.unitA,
    active: true,
    accountIds: [role('reviewer').id, role('analyst').id],
  });
  await status(parallelGroupResponse, 200);
  const parallelGroup = (await parallelGroupResponse.json()) as Group;
  const parallelSpec = workflowTemplate('blank');
  parallelSpec.schemaVersion = 5;
  parallelSpec.name = 'Mua sắm song song ' + randomUUID().slice(0, 6);
  parallelSpec.audienceUnits = [ids.unitA];
  const purchase = businessPurchaseTemplate();
  parallelSpec.input = purchase.input;
  parallelSpec.input.title = parallelSpec.name;
  const budget = purchase.nodes.find((node) => node.kind === 'condition');
  const purchaseStart = parallelSpec.nodes.find((node) => node.kind === 'start');
  assert(budget?.kind === 'condition' && purchaseStart?.kind === 'start');
  purchaseStart.next = budget.id;
  parallelSpec.nodes.push(
    { ...budget, yes: 'review', no: 'local_review' },
    {
      id: 'local_review',
      kind: 'approval',
      label: 'Duyệt mua sắm tại đơn vị',
      assignee: role('analyst').id,
      dueHours: 24,
      next: 'end',
      form: null,
    },
  );
  const parallelReview = parallelSpec.nodes.find((node) => node.id === 'review');
  assert(parallelReview?.kind === 'approval');
  parallelReview.assignee = role('reviewer').id;
  const branchRule = {
    kind: 'group',
    groupId: parallelGroup.id,
    selectionTiming: 'handoff',
  } as const;
  parallelSpec.nodes.push(
    {
      id: 'technical',
      kind: 'task',
      label: 'Kiểm tra kỹ thuật',
      next: '',
      assignee: '',
      assigneeRule: branchRule,
      dueHours: 24,
      form: null,
    },
    {
      id: 'financial',
      kind: 'task',
      label: 'Đối soát tài chính',
      next: '',
      assignee: '',
      assigneeRule: branchRule,
      dueHours: 24,
      form: null,
    },
    {
      id: 'finish',
      kind: 'task',
      label: 'Chốt đề nghị',
      next: 'end',
      assignee: role('analyst').id,
      dueHours: 24,
      form: null,
    },
  );
  const parallelDraft = await write(designer.context, '/definitions', {
    code: 'split-' + randomUUID().slice(0, 8),
    orgUnitId: ids.unitA,
    spec: parallelSpec,
  });
  await status(parallelDraft, 200);
  const parallelDefinition = await parallelDraft.json();
  current = designer.page;
  await designer.page.goto(W + '/');
  await designer.page.reload();
  await designer.page
    .locator('[data-slot="card"]')
    .filter({ has: designer.page.getByText(parallelSpec.name, { exact: true }) })
    .getByRole('button', { name: 'Thiết kế', exact: true })
    .click();
  await designer.page.getByRole('button', { name: 'Song song', exact: true }).click();
  await select(designer.page, 'Bước đầu nhánh 1', 'Kiểm tra kỹ thuật');
  await select(designer.page, 'Bước đầu nhánh 2', 'Đối soát tài chính');
  await select(designer.page, 'Bước đang cấu hình', parallelReview.label);
  await select(designer.page, 'Chuyển đến', 'Xử lý song song');
  for (const label of ['Kiểm tra kỹ thuật', 'Đối soát tài chính']) {
    await select(designer.page, 'Bước đang cấu hình', label);
    await select(designer.page, 'Chuyển đến', 'Hợp các nhánh');
  }
  await select(designer.page, 'Bước đang cấu hình', 'Hợp các nhánh');
  await select(designer.page, 'Chuyển đến', 'Chốt đề nghị');
  await designer.page.getByRole('button', { name: 'Tự sắp xếp sơ đồ' }).click();
  await select(designer.page, 'Bước đang cấu hình', 'Xử lý song song');
  await scan(designer.page, 'parallel-designer');
  await designer.page.screenshot({
    path: '.local/evidence/workflows-parallel-desktop.png',
    fullPage: true,
  });
  await designer.page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(
    designer.page.getByText('Đã lưu bản nháp. Lượt chạy cũ vẫn dùng phiên bản của chúng.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  const parallelPublished = await write(
    coordinator.context,
    '/definitions/' + parallelDefinition.id + '/publish',
    {
      expectedRevision: parallelDefinition.revision + 1,
    },
  );
  await status(parallelPublished, 200);
  const publishedParallel = await parallelPublished.json();
  await reserveTestRequests(requester.context, W, 100);
  const purchaseAnswers = (unitPrice: string) => ({
    purpose: 'Nghiệm thu mua sắm',
    needed_on: '2026-12-01',
    items: {
      rows: [
        {
          id: 'a',
          cells: { description: 'Thiết bị giả lập', quantity: '1', unit_price: unitPrice },
        },
      ],
    },
  });
  const target = {
    definitionId: parallelDefinition.id,
    versionId: publishedParallel.version.id,
    unitId: ids.unitA,
  };
  await status(
    await write(requester.context, '/runs', {
      ...target,
      title: 'Thiếu bảng hàng',
      answers: { purpose: 'Đề nghị thiếu dữ liệu', needed_on: '2026-12-01' },
    }),
    400,
  );
  const lowPurchase = await write(requester.context, '/runs', {
    ...target,
    title: 'Mua sắm theo hạn mức đơn vị',
    answers: purchaseAnswers('100000'),
  });
  await status(lowPurchase, 200);
  const lowRecord = await detail(requester.context, (await lowPurchase.json()).id);
  assert.equal(lowRecord.tasks.find((task) => task.status === 'pending')?.node_id, 'local_review');

  current = requester.page;
  await current.setViewportSize({ width: 1440, height: 1000 });
  await current.getByRole('button', { name: 'Quy trình', exact: true }).press('Enter');
  const purchaseCard = current
    .locator('[data-slot="card"]')
    .filter({ has: current.getByText(parallelSpec.name, { exact: true }) });
  await purchaseCard.getByRole('button', { name: 'Khởi chạy', exact: true }).press('Enter');
  const form = current.getByRole('dialog', { name: 'Khởi chạy quy trình' });
  await form.getByLabel('Tiêu đề lượt chạy').fill(parallelSpec.name);
  await form.locator('#answer-purpose').fill('Mua thiết bị giả lập');
  await form.locator('#answer-needed_on').fill('2026-12-01');
  await form.getByRole('button', { name: 'Thêm dòng', exact: true }).press('Enter');
  await form
    .getByRole('textbox', { name: 'Chi tiết mua sắm · Hàng hóa / nội dung · Dòng 1', exact: true })
    .fill('Thiết bị giả lập');
  await form
    .getByRole('textbox', { name: 'Chi tiết mua sắm · Số lượng · Dòng 1', exact: true })
    .fill('1');
  await form
    .getByRole('textbox', { name: 'Chi tiết mua sắm · Đơn giá · Dòng 1', exact: true })
    .fill('12000000');
  await scan(current, 'purchase-lines-desktop');
  await current.screenshot({ path: '.local/evidence/workflows-product-purchase-lines.png' });
  await form.getByRole('button', { name: 'Gửi đề nghị', exact: true }).press('Enter');
  await form.waitFor({ state: 'hidden' });
  await current.waitForURL((url) => /^#workflow-run\/[a-f0-9-]{36}$/i.test(url.hash));
  const parallelRunId = new URL(current.url()).hash.slice(14);
  assert.match(parallelRunId, /^[a-f0-9-]{36}$/);
  const initialPurchase = await detail(requester.context, parallelRunId);
  assert.equal(initialPurchase.tasks.find((task) => task.status === 'pending')?.node_id, 'review');
  const totalOf = (answers: Detail['run']['inputs']) =>
    (answers.items as { totals: Record<string, string> }).totals.amount;
  assert.equal(totalOf(initialPurchase.run.inputs), '12000000.00');
  await status(
    await requester.context.request.get(
      W + '/api/v1/workflows/runs/' + parallelRunId + '?tenantId=' + ids.tenantB,
    ),
    403,
  );
  await openRun(handler.page, parallelRunId);
  await handler.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  dialog = handler.page.getByRole('dialog');
  await dialog.getByLabel('Ý kiến / lý do').fill('Giao đối soát theo chuyên môn');
  const confirmSplit = dialog.getByRole('button', { name: 'Xác nhận', exact: true });
  await expect(confirmSplit).toBeDisabled();
  await select(handler.page, 'Người nhận · Kiểm tra kỹ thuật', role('reviewer').name);
  await expect(confirmSplit).toBeDisabled();
  await select(handler.page, 'Người nhận · Đối soát tài chính', role('analyst').name);
  await confirmSplit.click();
  await dialog.waitFor({ state: 'hidden' });
  const split = await detail(requester.context, parallelRunId);
  const openTasks = split.tasks.filter((task) => task.status === 'pending');
  assert.deepEqual(openTasks.map((task) => task.node_id).sort(), ['financial', 'technical']);
  const financeTask = openTasks.find((task) => task.node_id === 'financial')!;
  await openRun(finance.page, parallelRunId + '/' + financeTask.id);
  await expect(finance.page.getByRole('combobox', { name: 'Nhiệm vụ đang mở' })).toHaveText(
    'Đối soát tài chính',
  );
  await finance.page.getByRole('tab', { name: 'Sơ đồ tiến độ', exact: true }).press('Enter');
  const progress = finance.page.getByRole('tabpanel', { name: 'Sơ đồ tiến độ' });
  await expect(
    progress.getByRole('listitem').filter({ hasText: 'Kiểm tra kỹ thuật' }),
  ).toBeVisible();
  await expect(
    progress.getByRole('listitem').filter({ hasText: 'Đối soát tài chính' }),
  ).toBeVisible();
  await scan(finance.page, 'parallel-progress-mobile');
  await finance.page.getByRole('tab', { name: 'Thông tin & xử lý', exact: true }).press('Enter');
  const taskPicker = finance.page.getByRole('combobox', { name: 'Nhiệm vụ đang mở' });
  await taskPicker.focus();
  await finance.page.keyboard.press('Enter');
  await expect(finance.page.getByRole('option', { name: 'Kiểm tra kỹ thuật' })).toBeVisible();
  await finance.page.keyboard.press('Escape');
  await expect(taskPicker).toBeFocused();
  await scan(finance.page, 'parallel-mobile');
  await taskPicker.scrollIntoViewIfNeeded();
  await finance.page.screenshot({ path: '.local/evidence/workflows-parallel-mobile.png' });
  stage = 'Rollback financial decision on a synthetic audit failure';
  await reserveTestRequests(finance.context, W, 100);
  const workflowConfig = await loadWorkflowsConfig(runtime.instanceId);
  const owner = new pg.Pool({
    connectionString: workflowsDatabaseUrl(workflowConfig, true, true),
    max: 1,
  });
  const fault = 'test_purchase_audit_' + randomUUID().replaceAll('-', '');
  try {
    assert.deepEqual(
      (await owner.query('SELECT instance_id,purpose FROM environment_marker')).rows,
      [{ instance_id: runtime.instanceId, purpose: 'tlqm-aio-workflows-test' }],
    );
    await owner.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.run_id='${parallelRunId}' AND NEW.action='task.complete'
        THEN RAISE EXCEPTION 'Synthetic purchase audit failure'; END IF; RETURN NEW; END $$`);
    await owner.query(
      `CREATE TRIGGER ${fault} BEFORE INSERT ON workflow_audit FOR EACH ROW EXECUTE FUNCTION ${fault}()`,
    );
    try {
      await status(
        await write(finance.context, '/tasks/' + financeTask.id + '/action', {
          expectedRevision: financeTask.revision,
          action: 'complete',
          answers: {},
        }),
        500,
      );
      const rolledBack = await detail(requester.context, parallelRunId);
      assert.equal(rolledBack.tasks.find(({ id }) => id === financeTask.id)?.status, 'pending');
      assert.equal(rolledBack.tasks.filter(({ node_id }) => node_id === 'finish').length, 0);
    } finally {
      await owner.query(`DROP TRIGGER ${fault} ON workflow_audit`);
      await owner.query(`DROP FUNCTION ${fault}()`);
    }
  } finally {
    await owner.end();
  }
  stage = 'Complete financial branch before technical branch';
  await finance.page.getByRole('button', { name: 'Hoàn tất bước', exact: true }).click();
  await confirm(finance.page);
  const waiting = await detail(requester.context, parallelRunId);
  assert.equal(waiting.tasks.find((task) => task.status === 'pending')?.node_id, 'technical');
  assert.ok(!waiting.tasks.some((task) => task.node_id === 'finish'));
  stage = 'Technical requests more information and a second purchase round joins once';
  await reserveTestRequests(handler.context, W, 100);
  await openRun(handler.page, parallelRunId);
  await handler.page.getByRole('button', { name: 'Trả về', exact: true }).press('Enter');
  await confirm(handler.page);
  const returnedPurchase = await detail(requester.context, parallelRunId);
  assert.equal(returnedPurchase.run.status, 'needs_revision');
  assert.equal(returnedPurchase.tasks.find(({ id }) => id === financeTask.id)?.status, 'completed');
  await openRun(requester.page, parallelRunId);
  await requester.page.locator('#answer-purpose').fill('Bổ sung mô tả thiết bị giả lập');
  await requester.page
    .getByRole('textbox', { name: 'Chi tiết mua sắm · Đơn giá · Dòng 1', exact: true })
    .fill('13000000');
  const resubmitPurchase = requester.page.getByRole('button', {
    name: 'Gửi lại đề nghị',
    exact: true,
  });
  await expect(resubmitPurchase).toBeEnabled();
  await resubmitPurchase.press('Enter');
  await confirm(requester.page);
  const resent = await detail(requester.context, parallelRunId);
  assert.equal(resent.run.round, 2);
  assert.equal(totalOf(resent.run.inputs), '13000000.00');
  assert.equal(totalOf(resent.inputs.find((item) => item.round === 1)!.inputs), '12000000.00');
  await openRun(handler.page, parallelRunId);
  const approvePurchase = handler.page.getByRole('button', { name: 'Phê duyệt', exact: true });
  await expect(approvePurchase).toBeEnabled();
  await approvePurchase.press('Enter');
  await select(handler.page, 'Người nhận · Kiểm tra kỹ thuật', role('reviewer').name);
  await select(handler.page, 'Người nhận · Đối soát tài chính', role('analyst').name);
  await confirm(handler.page);
  const restarted = await detail(requester.context, parallelRunId);
  const technical = restarted.tasks.find(
    (task) => task.round === 2 && task.node_id === 'technical',
  )!;
  const financial = restarted.tasks.find(
    (task) => task.round === 2 && task.node_id === 'financial',
  )!;
  const key = randomUUID();
  const complete = (session: BrowserContext, task: Detail['tasks'][number], commandKey?: string) =>
    write(
      session,
      '/tasks/' + task.id + '/action',
      { expectedRevision: task.revision, action: 'complete', answers: {} },
      false,
      commandKey,
    );
  const concurrent = await Promise.all([
    complete(handler.context, technical, key),
    complete(finance.context, financial),
  ]);
  for (const response of concurrent) await status(response, 200);
  await status(await complete(handler.context, technical, key), 200);
  const joined = await detail(requester.context, parallelRunId);
  assert.equal(joined.tasks.filter((task) => task.node_id === 'finish').length, 1);
  assert.equal(joined.history.filter((event) => event.action === 'run.parallel_joined').length, 1);
  stage = 'Reopen the same run without its old task link and complete the new final task';
  await openRun(finance.page, parallelRunId);
  await finance.page.getByRole('button', { name: 'Hoàn tất bước', exact: true }).click();
  await confirm(finance.page);
  assert.equal((await detail(requester.context, parallelRunId)).run.status, 'completed');
  stage = 'Recall the submission before any decision and submit a revised round';
  await reserveTestRequests(requester.context, W, 100);
  const recallStart = await write(requester.context, '/runs', {
    definitionId: parallelDefinition.id,
    versionId: publishedParallel.version.id,
    unitId: ids.unitA,
    title: 'Thu hồi đề nghị mua sắm ' + randomUUID().slice(0, 6),
    answers: purchaseAnswers('12000000'),
  });
  await status(recallStart, 200);
  const recallRunId = (await recallStart.json()).id;
  await requester.page.setViewportSize({ width: 1440, height: 1000 });
  await openRun(requester.page, recallRunId);
  await requester.page.getByRole('button', { name: 'Thu hồi hồ sơ', exact: true }).click();
  dialog = requester.page.getByRole('dialog');
  await dialog.getByLabel('Ý kiến / lý do').fill('Bổ sung dữ liệu mua sắm trước khi duyệt');
  await scan(requester.page, 'recall-submission-desktop');
  await requester.page.screenshot({ path: '.local/evidence/workflows-recall-desktop.png' });
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const recalled = await detail(requester.context, recallRunId);
  assert.equal(recalled.run.status, 'needs_revision');
  assert.equal(recalled.tasks[0].status, 'cancelled');
  await requester.page.getByRole('button', { name: 'Gửi lại đề nghị', exact: true }).click();
  await confirm(requester.page);
  assert.equal((await detail(requester.context, recallRunId)).run.round, 2);

  stage = 'Recall a completed branch while the other branch is waiting';
  await openRun(handler.page, recallRunId);
  await handler.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await select(handler.page, 'Người nhận · Kiểm tra kỹ thuật', role('reviewer').name);
  await select(handler.page, 'Người nhận · Đối soát tài chính', role('analyst').name);
  await confirm(handler.page);
  await handler.page.getByRole('button', { name: 'Hoàn tất bước', exact: true }).click();
  await confirm(handler.page);
  const recallBranch = handler.page.getByRole('button', {
    name: 'Thu hồi bước Kiểm tra kỹ thuật',
    exact: true,
  });
  await recallBranch.focus();
  await handler.page.keyboard.press('Enter');
  dialog = handler.page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Ý kiến / lý do').fill('Cần sửa phần kiểm tra kỹ thuật');
  await scan(handler.page, 'recall-branch-mobile');
  await handler.page.screenshot({ path: '.local/evidence/workflows-recall-mobile.png' });
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const afterRecall = await detail(requester.context, recallRunId);
  assert.equal(
    afterRecall.tasks.find((task) => task.node_id === 'technical' && task.status === 'pending')
      ?.attempt,
    2,
  );
  assert.equal(afterRecall.tasks.find((task) => task.node_id === 'financial')?.status, 'pending');
  assert.equal(afterRecall.tasks.filter((task) => task.node_id === 'financial').length, 1);
  await handler.page.getByRole('button', { name: 'Hoàn tất bước', exact: true }).click();
  await confirm(handler.page);
  await openRun(finance.page, recallRunId);
  await finance.page.getByRole('button', { name: 'Hoàn tất bước', exact: true }).click();
  await confirm(finance.page);
  await finance.page.getByRole('button', { name: 'Hoàn tất bước', exact: true }).click();
  await confirm(finance.page);
  assert.equal((await detail(requester.context, recallRunId)).run.status, 'completed');
  stage = 'Publish next purchase edition and keep earlier run snapshots';
  await reserveTestRequests(coordinator.context, W, 80);
  const v2Spec = structuredClone(publishedParallel.version.spec);
  v2Spec.name += ' v2';
  const newDraft = await write(designer.context, '/definitions/' + parallelDefinition.id, {
    code: parallelDefinition.code,
    orgUnitId: ids.unitA,
    spec: v2Spec,
    expectedRevision: publishedParallel.definition.revision,
  });
  await status(newDraft, 200);
  const newer = await write(
    coordinator.context,
    '/definitions/' + parallelDefinition.id + '/publish',
    {
      expectedRevision: (await newDraft.json()).revision,
    },
  );
  await status(newer, 200);
  assert.equal((await newer.json()).version.version, 2);
  assert.equal(
    (await detail(requester.context, parallelRunId)).run.version_id,
    publishedParallel.version.id,
  );
  assert.equal(
    (await detail(requester.context, recallRunId)).run.version_id,
    publishedParallel.version.id,
  );
  await status(
    await write(requester.context, '/runs', {
      ...target,
      title: 'Phiên bản đã thay',
      answers: purchaseAnswers('12000000'),
    }),
    409,
  );
  await writeFile(
    '.local/evidence/workflows-assignments-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checkedAtVietnam: new Date(Date.now() + 7 * 3600000).toISOString().replace('Z', '+07:00'),
        result: 'pass',
        checks: [
          'MFA group administration and scoped candidate picker',
          'designer persists v2 group and guaranteed previous-actor policy',
          'group membership revocation removes inbox/detail/action access',
          'manual reassignment cannot escape group',
          'configured assignee and sender reassignment with current membership and recipient scope',
          'previous step uses actual completing actor after reassignment',
          'returned run requires a fresh eligible choice and keeps prior round snapshot',
          'group reactivation does not restore removed members',
          'designer saves rejection destination and handoff timing, mobile recipient picker supports Escape and keyboard selection',
          'designer publishes a selectable return destination, rejects a cross-run task id, mobile keyboard selects an effective prior attempt and preserves the old decision',
          'designer publishes a split and join, handoff selects two recipients, mobile opens the exact assigned task, and the final task opens after both branches',
          'requester recalls an unanswered submission, sends a fresh round, and branch sender recalls with keyboard before join without affecting the sibling task',
          'purchase line totals select approval level, financial audit failure rolls back, technical returns to requester, round snapshots survive and concurrent tasks join once',
          'desktop/mobile accessibility and CSP',
        ],
        scans,
        runId,
        groupId: group.id,
        handoffRunId,
        rewindRunId,
        parallelRunId,
        recallRunId,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: dynamic workflow groups, runtime selection, live revocation, constrained reassignment, previous actor and round snapshots; ' +
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
    'Assignment E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      ') ' +
      (error instanceof Error
        ? (error.stack?.match(/workflows-assignments-e2e\.ts:\d+:\d+/)?.[0] ?? '')
        : '') +
      '. Sensitive details omitted.',
  );
  if (
    current &&
    !current.isClosed() &&
    new URL(current.url()).origin === W &&
    new URL(current.url()).pathname === '/' &&
    (await current.locator('input[type=password]').count()) === 0
  )
    await current.screenshot({
      path: '.local/evidence/workflows-assignment-failure.png',
      fullPage: true,
    });
  process.exitCode = 1;
} finally {
  await browser.close();
  app?.server.closeAllConnections();
  await app?.close();
}
