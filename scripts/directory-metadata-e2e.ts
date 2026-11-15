import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { Page, APIResponse } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
type Row = Record<string, any>;
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4100',
  suffix = randomUUID().slice(0, 8),
  browser = await chromium.launch({ headless: true });
let server: Awaited<ReturnType<typeof createApp>> | undefined,
  current: Page | undefined,
  stage = 'startup',
  admin: Awaited<ReturnType<typeof login>> | undefined,
  original: Row | undefined;
const scans: Row[] = [];
async function json(response: APIResponse, expected = 200) {
  const body = await response.json();
  if (response.status() !== expected)
    throw new Error('HTTP_' + response.status() + '_' + String(body.error ?? 'UNKNOWN'));
  return body;
}
async function login(id: string, mfa = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage(),
    user = runtime.users.find((u) => u.id === id)!;
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
  return { context, page, me };
}
async function scan(page: Page, name: string) {
  current = page;
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
  assert.equal(new URL(page.url()).origin, base);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    name,
    violations: axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    incomplete: axe.incomplete.map((v) => v.id),
  });
  await writeFile('.local/evidence/directory-metadata-axe.json', JSON.stringify(scans, null, 2));
  assert.equal(axe.violations.length, 0, 'axe ' + name);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'overflow ' + name,
  );
  await page.screenshot({
    path: '.local/evidence/directory-metadata-' + name + '.png',
    fullPage: (await page.getByRole('dialog').count()) === 0,
  });
}
async function post(path: string, data: Row) {
  return json(
    await admin!.context.request.post(base + path, {
      headers: {
        origin: base,
        'x-csrf-token': admin!.me.csrfToken,
        'idempotency-key': randomUUID(),
      },
      data: { tenantId: ids.tenantA, reason: 'Nghiệm thu cấu hình hồ sơ ' + suffix, ...data },
    }),
  );
}
try {
  await mkdir('.local/evidence', { recursive: true });
  server = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((c) => c.code === 'aio-foundation')!,
    test: true,
    logger: false,
  });
  await server.listen({ host: '127.0.0.1', port: 4100 });
  admin = await login(ids.admin, true);
  const employee = await login(ids.learner);
  original = (
    await json(
      await admin.context.request.get(
        base + '/api/v1/directory-config/people?tenantId=' + ids.tenantA,
      ),
    )
  ).configuration;
  stage = 'designer publication';
  const page = admin.page;
  current = page;
  await page.goto(base + '/#people');
  await page.getByRole('tab', { name: 'Thông tin mở rộng', exact: true }).click();
  await page.getByRole('tab', { name: 'Thiết kế trường & bố cục', exact: true }).click();
  await page.getByLabel('Lý do thay đổi cấu hình').fill('Bổ sung trường hồ sơ ' + suffix);
  await page.getByRole('button', { name: 'Thêm câu hỏi', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nhãn câu hỏi').fill('Kỹ năng ' + suffix);
  await dialog.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('Nhân viên được xem Kỹ năng ' + suffix, { exact: true }).check();
  await page.getByLabel('Được đề xuất sửa Kỹ năng ' + suffix, { exact: true }).check();
  await scan(page, 'configuration-desktop');
  await page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Đã lưu bản nháp');
  await page.getByLabel('Lý do thay đổi cấu hình').fill('Phát hành trường hồ sơ ' + suffix);
  await page.getByRole('button', { name: 'Phát hành bản nháp đã lưu' }).click();
  await expect(page.getByRole('status')).toContainText('Đã phát hành');
  stage = 'employee self proposal';
  current = employee.page;
  await employee.page.goto(base + '/#profile');
  const field = employee.page.getByLabel('Kỹ năng ' + suffix, { exact: true });
  await expect(field).toBeVisible();
  await expect(employee.page.getByLabel('Ghi chú nội bộ HR', { exact: true })).toHaveCount(0);
  if (await employee.page.getByLabel('Văn phòng', { exact: true }).count())
    await expect(employee.page.getByLabel('Văn phòng', { exact: true })).toBeDisabled();
  await field.fill('Nghiệp vụ thử nghiệm ' + suffix);
  await employee.page.getByLabel('Lý do đề xuất cập nhật').fill('Đề xuất kỹ năng ' + suffix);
  await scan(employee.page, 'self-desktop');
  await employee.page.setViewportSize({ width: 390, height: 844 });
  await scan(employee.page, 'self-mobile');
  await employee.page.getByRole('button', { name: 'Gửi HR duyệt', exact: true }).click();
  await expect(employee.page.getByRole('status')).toContainText('Đã gửi đề xuất');
  const self = await json(
    await employee.context.request.get(base + '/api/v1/profile/me?tenantId=' + ids.tenantA),
  );
  assert.equal(Object.values(self.answers).includes('Nghiệp vụ thử nghiệm ' + suffix), false);
  const proposals = await json(
      await employee.context.request.get(
        base + '/api/v1/profile/proposals?tenantId=' + ids.tenantA,
      ),
    ),
    proposal = proposals.items.find((p: Row) => p.reason === 'Đề xuất kỹ năng ' + suffix);
  assert.ok(proposal);
  assert.equal(JSON.stringify(proposals).includes('hr_note'), false);
  stage = 'HR decision and immutable history';
  current = page;
  await page.getByRole('tab', { name: 'Duyệt đề xuất nhân viên', exact: true }).click();
  const card = page
    .locator('[data-slot=card]')
    .filter({ has: page.getByText('Đề xuất kỹ năng ' + suffix, { exact: true }) });
  await expect(card).toContainText('Kỹ năng ' + suffix);
  await scan(page, 'review-queue');
  await card.getByRole('button', { name: 'Duyệt cập nhật', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Phản hồi gửi nhân viên')
    .fill('Đã đối soát kỹ năng ' + suffix);
  await scan(page, 'review-confirmation');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Xác nhận đề xuất', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card).toContainText('Đã duyệt');
  await employee.page.reload();
  await expect(employee.page.getByLabel('Kỹ năng ' + suffix, { exact: true })).toHaveValue(
    'Nghiệp vụ thử nghiệm ' + suffix,
  );
  await scan(employee.page, 'self-approved-mobile');
  const history = await json(
    await admin.context.request.get(
      base +
        '/api/v1/directory-metadata/people/' +
        employee.me.personId +
        '/history?tenantId=' +
        ids.tenantA,
    ),
  );
  assert.ok(
    history.items.some((h: Row) =>
      Object.values(h.answers).includes('Nghiệp vụ thử nghiệm ' + suffix),
    ),
  );
  const denied = await employee.context.request.post(base + '/api/v1/profile/proposals', {
    headers: {
      origin: base,
      'x-csrf-token': employee.me.csrfToken,
      'idempotency-key': randomUUID(),
    },
    data: {
      tenantId: ids.tenantA,
      reason: 'Thử sửa trường HR trái phép',
      patch: { hr_note: 'Không được ghi' },
      expectedRevision: 0,
      schemaVersion: self.schemaVersion,
    },
  });
  assert.equal(denied.status(), 403);
  await writeFile(
    '.local/evidence/directory-metadata-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans: scans.length,
        checks: [
          'real MFA designer publish',
          'employee hidden/readonly fields',
          'proposal before/after HR approval',
          'versioned history',
          'backend field denial',
        ],
        credentialsExposed: false,
      },
      null,
      2,
    ),
  );
  console.log('PASS directory metadata/self-service UI, ' + scans.length + ' axe scans.');
} catch (error) {
  if (
    current &&
    new URL(current.url()).origin === base &&
    !(await current.locator('input[type=password]').count())
  ) {
    await current.screenshot({
      path: '.local/evidence/directory-metadata-failure.png',
      fullPage: true,
    });
    console.error(
      'Application alerts: ' + (await current.getByRole('alert').allTextContents()).join(' | '),
    );
  }
  console.error(
    'Metadata E2E failed at ' +
      stage +
      '; ' +
      (error instanceof Error
        ? (error.message.startsWith('HTTP_') ? error.message : error.name) +
          ' ' +
          (error.stack?.match(/directory-metadata-e2e\.ts:\d+:\d+/)?.[0] ?? '')
        : 'unknown') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  if (admin && original)
    try {
      const current = (
        await json(
          await admin.context.request.get(
            base + '/api/v1/directory-config/people?tenantId=' + ids.tenantA,
          ),
        )
      ).configuration;
      const restored = await post('/api/v1/directory-config/people', {
        configuration: original.draft,
        expectedRevision: current.revision,
      });
      await post('/api/v1/directory-config/people/publish', {
        expectedRevision: restored.revision,
      });
    } catch {
      console.error('Synthetic configuration restoration pending.');
      process.exitCode = 1;
    }
  await browser.close();
  if (server) {
    server.server.closeAllConnections();
    await server.close();
  }
}
