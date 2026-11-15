import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Page, APIResponse } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../src/app.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import type { FormsFixture } from './forms-fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { reminderRuntime } from './work-center-runtime.js';
type Row = Record<string, any>;
type Session = { context: BrowserContext; page: Page; csrf: string };
const runtime = await loadLocalConfig(),
  A = 'http://127.0.0.1:4100',
  W = 'http://127.0.0.1:4105',
  suffix = randomUUID().slice(0, 8),
  browser = await chromium.launch({ headless: true }),
  servers: FastifyInstance[] = [];
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixtures.users.find((u) => u.role === name)!;
let stage = 'preflight',
  admin: Session | undefined,
  current: Page | undefined,
  worker: Awaited<ReturnType<typeof reminderRuntime>> | undefined,
  definition: Row | undefined,
  policyBefore: Row | undefined;
const restoreGrants: {
    accountId: string;
    appCode: string;
    active: boolean;
    validUntil: string | null;
  }[] = [],
  scans: Row[] = [];
async function json(response: APIResponse, expected = 200) {
  const result = await response.json();
  if (response.status() !== expected)
    throw new Error('HTTP_' + response.status() + '_' + String(result.error ?? 'UNKNOWN'));
  return result;
}
async function login(
  base: string,
  user: { id: string; username: string; password: string },
  mfa = false,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  current = page;
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL(base + '/');
  const me = await json(await context.request.get(base + '/api/v1/me'));
  return { context, page, csrf: me.csrfToken };
}
async function write(s: Session, base: string, path: string, data: Row, csrf = s.csrf) {
  return s.context.request.post(base + path, {
    headers: { origin: base, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
    data: { tenantId: ids.tenantA, reason: 'Kiểm thử trung tâm công việc ' + suffix, ...data },
  });
}
async function grant(
  accountId: string,
  appCode: string,
  active: boolean,
  validUntil: string | null = null,
) {
  const list = await json(
      await admin!.context.request.get(
        A + '/api/v1/manage/grants?' + new URLSearchParams({ tenantId: ids.tenantA, appCode }),
      ),
    ),
    row = list.items.find((g: Row) => g.accountId === accountId);
  return json(
    await write(admin!, A, '/api/v1/manage/grants', {
      data: { accountId, appCode, active, validUntil },
      expectedRevision: row?.revision ?? 0,
    }),
  );
}
async function temporarilyGrant(accountId: string, appCode: string) {
  const list = await json(
      await admin!.context.request.get(
        A + '/api/v1/manage/grants?' + new URLSearchParams({ tenantId: ids.tenantA, appCode }),
      ),
    ),
    old = list.items.find((g: Row) => g.accountId === accountId);
  restoreGrants.push({
    accountId,
    appCode,
    active: old?.active ?? false,
    validUntil: old?.validUntil ?? null,
  });
  if (!old?.active) await grant(accountId, appCode, true);
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
}
async function loaded(page: Page) {
  await expect(page.getByRole('status', { name: 'Đang tải công việc' })).toHaveCount(0, {
    timeout: 20_000,
  });
}
async function hub(s: Session) {
  current = s.page;
  await s.page.goto(A + '/#work-center');
  await s.page.getByRole('heading', { name: 'Công việc & thông báo', exact: true }).waitFor();
  await loaded(s.page);
}
async function scan(page: Page, name: string) {
  current = page;
  assert.ok([A, W].includes(new URL(page.url()).origin));
  assert.equal(await page.locator('input[type=password]').count(), 0);
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
  await writeFile('.local/evidence/work-center-axe.json', JSON.stringify(scans, null, 2));
  assert.equal(result.violations.length, 0, 'axe ' + name);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'overflow ' + name,
  );
  await page.screenshot({ path: '.local/evidence/work-center-' + name + '.png', fullPage: true });
}
let coordinator: Session | undefined;
let policyTouched = false;
try {
  await mkdir('.local/evidence', { recursive: true });
  for (const code of ['aio-foundation', 'aio-workflows']) {
    const client = runtime.clients.find((c) => c.code === code)!;
    const app = await createApp({
      runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
      client,
      test: true,
      logger: false,
    });
    await app.listen({ host: '127.0.0.1', port: client.port });
    servers.push(app);
  }
  admin = await login(
    A,
    runtime.users.find((u) => u.id === ids.admin)!,
    true,
  );
  for (const user of [role('reviewer'), role('publisher'), role('designer')])
    await temporarilyGrant(user.id, 'aio-foundation');
  const handler = await login(A, role('reviewer')),
    requester = await login(
      A,
      runtime.users.find((u) => u.id === ids.learner)!,
    );
  coordinator = await login(A, role('publisher'), true);
  const designer = await login(W, role('designer'), true),
    publisher = await login(W, role('publisher'), true),
    sender = await login(
      W,
      runtime.users.find((u) => u.id === ids.learner)!,
    );
  stage = 'create real workflow and notification';
  const spec = workflowTemplate();
  spec.name = 'Trung tâm công việc ' + suffix;
  spec.audienceUnits = [ids.unitA];
  spec.positions = {};
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Bắt đầu', next: 'review' },
    {
      id: 'review',
      kind: 'approval',
      label: 'Xem xét đề nghị',
      assignee: role('reviewer').id,
      dueHours: 1,
      next: 'end',
      form: null,
    },
    { id: 'end', kind: 'end', label: 'Hoàn tất' },
  ];
  definition = await json(
    await write(designer, W, '/api/v1/workflows/definitions', {
      code: 'hub-' + suffix,
      orgUnitId: ids.unitA,
      spec,
    }),
  );
  const published = await json(
    await write(publisher, W, '/api/v1/workflows/definitions/' + definition!.id + '/publish', {
      expectedRevision: definition!.revision,
    }),
  );
  const started = await json(
    await write(sender, W, '/api/v1/workflows/runs', {
      definitionId: definition!.id,
      versionId: published.version.id,
      unitId: ids.unitA,
      title: 'Đề nghị trung tâm ' + suffix,
      answers: { purpose: 'Kiểm thử dữ liệu giả lập', amount: 50, needed_on: '2026-12-01' },
    }),
  );
  await hub(handler);
  await handler.page.getByLabel('Tìm công việc').fill(suffix);
  await handler.page.getByLabel('Tìm công việc').press('Enter');
  await loaded(handler.page);
  await expect(
    handler.page.getByRole('cell', { name: 'Đề nghị trung tâm ' + suffix, exact: false }),
  ).toBeVisible();
  await scan(handler.page, 'assigned-desktop');
  await handler.page.setViewportSize({ width: 390, height: 844 });
  await scan(handler.page, 'assigned-mobile');
  const region = handler.page.getByRole('region', { name: 'Danh sách công việc', exact: true });
  await region.press('ArrowRight');
  await expect(region).toBeFocused();
  await expect.poll(() => region.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
  await handler.page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'deep link survives first Workflows SSO';
  await handler.page.getByRole('link', { name: 'Mở hồ sơ', exact: true }).click();
  await handler.page.getByRole('link', { name: 'Đăng nhập SSO' }).click();
  await handler.page.waitForURL(W + '/#workflow-run/' + started.id);
  await handler.page.getByRole('button', { name: 'Tải lại lượt chạy' }).waitFor();
  stage = 'notification inbox and read state';
  await hub(handler);
  await handler.page.getByRole('tab', { name: 'Thông báo', exact: true }).click();
  await loaded(handler.page);
  const noticeCard = handler.page
    .locator('[data-slot="card"]')
    .filter({ has: handler.page.getByText('Đề nghị trung tâm ' + suffix, { exact: true }) });
  await expect(noticeCard).toContainText('Bạn có nhiệm vụ mới');
  const readState = handler.page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/work-center/notifications' &&
      response.request().method() === 'POST',
  );
  await noticeCard.getByRole('button', { name: 'Đã đọc', exact: true }).click();
  assert.equal((await readState).status(), 200);
  await loaded(handler.page);
  await expect(noticeCard.getByRole('button', { name: 'Chưa đọc', exact: true })).toBeVisible({
    timeout: 20000,
  });
  await scan(handler.page, 'notifications-desktop');
  stage = 'scoped manager dashboard and reminder configuration';
  await hub(coordinator);
  await coordinator.page.getByRole('tab', { name: 'Theo dõi đơn vị', exact: true }).click();
  await loaded(coordinator.page);
  await scan(coordinator.page, 'manager-desktop');
  await coordinator.page.getByRole('tab', { name: 'Cấu hình nhắc hạn', exact: true }).click();
  await loaded(coordinator.page);
  const policies = await json(
    await coordinator.context.request.get(
      A + '/api/v1/work-center/reminders?tenantId=' + ids.tenantA,
    ),
  );
  policyBefore = policies.items.find((p: Row) => p.org_unit_id === ids.unitA);
  const unitName = policies.units.find((u: Row) => u.id === ids.unitA).name;
  await select(coordinator.page, 'Chọn đơn vị cấu hình', unitName);
  await coordinator.page.getByLabel('Bật nhắc hạn cho đơn vị').check();
  await coordinator.page.getByLabel('Nhắc trước hạn (phút; 0 = tắt)').fill('120');
  await coordinator.page.getByLabel('Nhắc sau khi quá hạn (phút)').fill('1');
  await coordinator.page.getByLabel('Lý do thay đổi').fill('Nghiệm thu nhắc hạn ' + suffix);
  await scan(coordinator.page, 'reminder-config');
  await coordinator.page.getByRole('button', { name: 'Lưu cấu hình nhắc hạn' }).click();
  await loaded(coordinator.page);
  policyTouched = true;
  worker = await reminderRuntime(runtime, true);
  await Promise.all([worker.hub.remind(), worker.hub.remind()]);
  await worker.hub.remind();
  const notifications = await json(
    await handler.context.request.get(
      A + '/api/v1/work-center/notifications?tenantId=' + ids.tenantA,
    ),
  );
  assert.equal(
    notifications.items.filter((n: Row) => n.route.endsWith(started.id) && n.kind === 'due_soon')
      .length,
    1,
  );
  await handler.page.getByRole('button', { name: 'Tải lại trung tâm công việc' }).click();
  await loaded(handler.page);
  await handler.page.setViewportSize({ width: 390, height: 844 });
  await scan(handler.page, 'notifications-mobile');
  stage = 'source revocation removes work and unread counts';
  await temporarilyGrant(role('reviewer').id, 'aio-workflows');
  await grant(role('reviewer').id, 'aio-workflows', false);
  assert.equal(
    (
      await handler.context.request.get(
        A + '/api/v1/work-center/notifications?tenantId=' + ids.tenantA,
      )
    ).status(),
    403,
  );
  assert.equal(
    (
      await handler.context.request.get(A + '/api/v1/work-center/work?tenantId=' + ids.tenantA)
    ).status(),
    403,
  );
  await handler.page.getByRole('button', { name: 'Tải lại trung tâm công việc' }).click();
  await loaded(handler.page);
  await expect(handler.page.getByText('Đề nghị trung tâm ' + suffix, { exact: true })).toHaveCount(
    0,
  );
  await scan(handler.page, 'revoked-mobile');
  await grant(role('reviewer').id, 'aio-workflows', true);
  assert.equal(
    (
      await write(handler, A, '/api/v1/work-center/reminders', {
        unitId: ids.unitA,
        enabled: false,
        beforeMinutes: 60,
        overdueMinutes: 60,
        expectedRevision: 1,
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await handler.context.request.get(A + '/api/v1/work-center/work?tenantId=' + ids.tenantB)
    ).status(),
    403,
  );
  const handlerMe = await json(await handler.context.request.get(W + '/api/v1/me')),
    task = (
      await json(
        await sender.context.request.get(
          W + '/api/v1/workflows/runs/' + started.id + '?tenantId=' + ids.tenantA,
        ),
      )
    ).tasks.find((t: Row) => t.status === 'pending');
  await json(
    await write(
      { ...handler, csrf: handlerMe.csrfToken },
      W,
      '/api/v1/workflows/tasks/' + task.id + '/action',
      { expectedRevision: task.revision, action: 'approve', answers: {} },
    ),
  );
  await hub(requester);
  await requester.page.getByRole('tab', { name: 'Thông báo', exact: true }).click();
  await loaded(requester.page);
  await expect(
    requester.page
      .locator('[data-slot=card]')
      .filter({ has: requester.page.getByText('Đề nghị trung tâm ' + suffix, { exact: true }) })
      .getByText('Đề nghị đã hoàn thành', { exact: true }),
  ).toBeVisible();
  await scan(requester.page, 'completion-notification');
  stage = 'step mention opens the exact discussion from Portal';
  const membership = await json(
    await write(sender, W, '/api/v1/workflows/runs/' + started.id + '/followers', {
      accountId: role('designer').id,
      taskId: task.id,
    }),
  );
  const note = 'Trao đổi giả lập tại bước xem xét.';
  await json(
    await write(sender, W, '/api/v1/workflows/runs/' + started.id + '/discussion', {
      text: note,
      mentionIds: [membership.id],
      taskId: task.id,
    }),
  );
  await designer.page.goto(A + '/auth/login');
  await designer.page.waitForURL(A + '/');
  await hub(designer);
  await designer.page.getByRole('tab', { name: 'Thông báo', exact: true }).click();
  await loaded(designer.page);
  const stepMention = designer.page
    .locator('[data-slot=card]')
    .filter({ hasText: 'Bạn được nhắc tên trong hồ sơ' })
    .filter({ has: designer.page.getByText('Đề nghị trung tâm ' + suffix, { exact: true }) });
  await expect(stepMention).toBeVisible();
  await expect(stepMention).not.toContainText(note);
  await scan(designer.page, 'step-mention-portal');
  await stepMention.getByRole('link', { name: 'Mở hồ sơ', exact: true }).click();
  await designer.page.waitForURL(W + '/#workflow-run/' + started.id + '/' + task.id);
  await expect(designer.page.getByText(note, { exact: true })).toBeVisible();
  await json(
    await write(sender, W, '/api/v1/workflows/runs/' + started.id + '/followers/remove', {
      followerId: membership.id,
      expectedRevision: membership.revision,
      taskId: task.id,
    }),
  );
  const afterRevocation = await json(
    await designer.context.request.get(
      A + '/api/v1/work-center/notifications?tenantId=' + ids.tenantA,
    ),
  );
  assert.ok(
    !afterRevocation.items.some(
      (item: Row) => item.route.endsWith('/' + task.id) && item.kind === 'mentioned',
    ),
  );
  const saved = (
    await json(
      await designer.context.request.get(
        W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
      ),
    )
  ).items.find((d: Row) => d.id === definition!.id);
  await json(
    await write(publisher, W, '/api/v1/workflows/definitions/' + definition!.id + '/status', {
      expectedRevision: saved.revision,
      status: 'paused',
    }),
  );
  await writeFile(
    '.local/evidence/work-center-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans: scans.length,
        checks: [
          'real SSO deep link',
          'live source permission and tenant denial',
          'read/unread UI',
          'manager scope and configuration',
          'durable concurrent reminder deduplication',
          'completion notification',
          'step mention Portal deep link and live scope revocation',
        ],
        credentialsExposed: false,
      },
      null,
      2,
    ),
  );
  console.log('PASS: Work center live SSO/UI/security/reminders; ' + scans.length + ' axe scans.');
} catch (error) {
  if (
    current &&
    [A, W].includes(new URL(current.url()).origin) &&
    !(await current.locator('input[type=password]').count())
  ) {
    await current.screenshot({ path: '.local/evidence/work-center-failure.png', fullPage: true });
    console.error(
      'Application alerts: ' + (await current.getByRole('alert').allTextContents()).join(' | '),
    );
  }
  console.error(
    'Work center failed at ' +
      stage +
      '; ' +
      (error instanceof Error
        ? (error.message.startsWith('HTTP_') ? error.message : error.name) +
          ' ' +
          (error.stack?.match(/work-center-e2e\.ts:\d+:\d+/)?.[0] ?? '')
        : 'unknown') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await worker?.close();
  if (coordinator && policyTouched)
    try {
      const policies = await json(
          await coordinator.context.request.get(
            A + '/api/v1/work-center/reminders?tenantId=' + ids.tenantA,
          ),
        ),
        current = policies.items.find((p: Row) => p.org_unit_id === ids.unitA);
      if (current)
        await json(
          await write(coordinator, A, '/api/v1/work-center/reminders', {
            unitId: ids.unitA,
            enabled: policyBefore?.enabled ?? false,
            beforeMinutes: policyBefore?.before_minutes ?? 60,
            overdueMinutes: policyBefore?.overdue_minutes ?? 60,
            expectedRevision: current.revision,
          }),
        );
    } catch {
      console.error('Reminder policy restoration pending.');
      process.exitCode = 1;
    }
  if (admin)
    for (const g of restoreGrants.reverse())
      try {
        await grant(g.accountId, g.appCode, g.active, g.validUntil);
      } catch {
        console.error('Owned fixture grant restoration pending.');
        process.exitCode = 1;
      }
  await browser.close();
  for (const server of servers) {
    server.server.closeAllConnections();
    await server.close();
  }
}
