import { bffClients } from '../src/config.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { FastifyInstance } from 'fastify';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';

const runtime = await loadLocalConfig();
const testRuntime = { ...runtime, databaseUrl: testDatabaseUrl(runtime) };
const A = runtime.clients.find((client) => client.code === 'aio-foundation')!.baseUrl;
const browser = await chromium.launch({ headless: true });
const servers: FastifyInstance[] = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  (window as Window & { qaCsp?: string[] }).qaCsp = [];
  document.addEventListener('securitypolicyviolation', (event) =>
    (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective),
  );
});
const page = await context.newPage();
const run = randomUUID().slice(0, 8);
const reason = 'UI acceptance ' + run;
let stage = 'startup';
let csrf = '';
const scans: {
  screen: string;
  violations: { rule: string; impact: string | null; targets: unknown[] }[];
  incompleteRules: string[];
}[] = [];
const names = {
  entity: 'Pháp nhân UI ' + run,
  unit: 'Đơn vị UI ' + run,
  title: 'Chức danh UI ' + run,
  position: 'Vị trí UI ' + run,
  app: 'Ứng dụng UI ' + run,
  permission: 'Đọc tài liệu UI ' + run,
  role: 'Vai trò tài liệu UI ' + run,
};
const appCode = 'aio-ui-' + run;
async function scan(screen: string, targetPage = page) {
  // Inspect the settled UI, not the temporary opacity/aria state while a Radix dialog is entering.
  await targetPage.waitForFunction(
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
  await targetPage.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  assert.equal(new URL(targetPage.url()).origin, A);
  assert.notEqual(new URL(targetPage.url()).hash, '#identity-proof');
  assert.equal(
    await targetPage
      .locator('input[type="password"]')
      .evaluateAll((inputs) =>
        inputs.some((input) => (input as HTMLInputElement).value.length > 0),
      ),
    false,
  );
  const result = await new AxeBuilder({ page: targetPage })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const safe = result.violations.map((value) => ({
    rule: value.id,
    impact: value.impact ?? null,
    targets: value.nodes.map((node) =>
      node.target.map((selector) =>
        typeof selector === 'string'
          ? selector.replace(/\[value=[^\]]+\]/g, '[value=redacted]')
          : selector,
      ),
    ),
  }));
  if (safe.length) {
    const contrast = result.violations
      .filter((v) => v.id === 'color-contrast')
      .flatMap((v) =>
        v.nodes.map((node) => ({
          targets: node.target,
          checks: node.any.map((check) => ({ id: check.id, data: check.data })),
        })),
      );
    console.error('Contrast measurements: ' + JSON.stringify(contrast));
  }
  scans.push({
    screen,
    violations: safe,
    incompleteRules: result.incomplete.map((value) => value.id),
  });
  await mkdir('.local/evidence', { recursive: true });
  await writeFile(
    '.local/evidence/accessibility.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        scans,
      },
      null,
      2,
    ) + '\n',
  );
  if (safe.length)
    console.error('Accessibility issues: ' + JSON.stringify({ screen, violations: safe }));
  assert.equal(safe.length, 0, 'Accessibility violations on ' + screen);
}
async function nav(name: string) {
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function select(field: string, value: string) {
  await page
    .getByRole('dialog')
    .locator('#field-' + field)
    .click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
async function saveForm() {
  const dialog = page.getByRole('dialog');
  await dialog.locator('#change-reason').fill(reason);
  await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await page.waitForFunction(
    () =>
      !!document.querySelector('[role="alertdialog"]') ||
      !document.querySelector('[role="dialog"]'),
  );
  const confirmation = page.getByRole('alertdialog');
  if (await confirmation.isVisible())
    await confirmation.getByRole('button', { name: 'Xác nhận lưu', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function editByName(name: string) {
  await page.getByRole('textbox', { name: 'Tìm kiếm trong danh sách' }).fill(name);
  await page.getByRole('button', { name: 'Sửa ' + name, exact: true }).click();
}
async function archive(name: string) {
  await editByName(name);
  await page
    .getByRole('dialog')
    .getByRole('checkbox', { name: 'Đang hoạt động', exact: true })
    .uncheck();
  await saveForm();
}
async function login(username: string) {
  const user = runtime.users.find((user) => user.username === username)!;
  await page.goto(A + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (username === 'demo.admin') {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL(A + '/', { timeout: 15000 });
  await page.locator('[data-code="AUTHENTICATED"]').waitFor();
}
try {
  for (const client of bffClients(runtime)) {
    const server = await createApp({ runtime: testRuntime, client, test: true, logger: false });
    await server.listen({ host: '127.0.0.1', port: client.port });
    servers.push(server);
  }
  await page.goto(A + '/');
  await page.getByRole('link', { name: /Đăng nhập SSO/ }).waitFor();
  await scan('signed-out');
  await login('demo.admin');
  csrf = (await (await context.request.get(A + '/api/v1/me')).json()).csrfToken;
  await scan('application portal');
  await nav('Hồ sơ của tôi');
  await page.getByText('Quan hệ công tác', { exact: true }).waitFor();
  await scan('profile');
  stage = 'legal entity and position UI';
  await nav('Cơ cấu tổ chức');
  await page.getByRole('tab', { name: 'Pháp nhân', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm pháp nhân', exact: true }).click();
  await scan('legal entity dialog');
  await page
    .getByRole('dialog')
    .locator('#field-code')
    .fill('LE-' + run);
  await page.getByRole('dialog').locator('#field-name').fill(names.entity);
  await saveForm();
  await page.getByRole('tab', { name: 'Đơn vị / phòng ban', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm đơn vị', exact: true }).click();
  await select('legalEntityId', names.entity);
  await page
    .getByRole('dialog')
    .locator('#field-code')
    .fill('U-' + run);
  await page.getByRole('dialog').locator('#field-name').fill(names.unit);
  await saveForm();
  await page.getByRole('tab', { name: 'Chức danh', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm chức danh', exact: true }).click();
  await page
    .getByRole('dialog')
    .locator('#field-code')
    .fill('J-' + run);
  await page.getByRole('dialog').locator('#field-name').fill(names.title);
  await saveForm();
  await page.getByRole('tab', { name: 'Vị trí công tác', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm vị trí', exact: true }).click();
  await select('legalEntityId', names.entity);
  await select('orgUnitId', names.unit);
  await select('jobTitleId', names.title);
  await page.getByRole('dialog').locator('#field-name').fill(names.position);
  await saveForm();
  await scan('organization positions');
  stage = 'registry planned app and activation guard';
  await nav('Danh mục ứng dụng');
  await page.getByRole('button', { name: 'Thêm ứng dụng', exact: true }).click();
  await page.getByRole('dialog').locator('#field-code').fill(appCode);
  await page.getByRole('dialog').locator('#field-name').fill(names.app);
  await page.getByRole('dialog').locator('#field-launchUrl').fill('http://127.0.0.1:4188');
  await saveForm();
  await editByName(names.app);
  await select('status', 'Hoạt động');
  await page.getByRole('dialog').locator('#change-reason').fill(reason);
  await page.getByRole('dialog').getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  const confirmation = page.getByRole('alertdialog');
  await confirmation.waitFor();
  await scan('registry activation confirmation');
  await confirmation.getByRole('button', { name: 'Xác nhận lưu', exact: true }).click();
  await confirmation
    .getByText('Ứng dụng cần được cấu hình và xác minh SSO trước khi kích hoạt.', { exact: true })
    .waitFor();
  await scan('registry activation error');
  await confirmation.getByRole('button', { name: 'Quay lại biểu mẫu', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  await page.getByRole('dialog').getByRole('button', { name: 'Hủy', exact: true }).click();
  const registered = (
    await (
      await context.request.get(A + '/api/v1/manage/applications?tenantId=' + ids.tenantA)
    ).json()
  ).items.find((value: { code: string }) => value.code === appCode);
  assert.equal(registered.status, 'planned');
  stage = 'permission catalog and role UI';
  await nav('Vai trò & truy cập');
  await page.getByRole('combobox', { name: 'Chọn ứng dụng quản trị', exact: true }).click();
  await page.getByRole('option', { name: names.app, exact: true }).click();
  await page.getByRole('tab', { name: 'Danh mục quyền', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm quyền', exact: true }).click();
  await page.getByRole('dialog').locator('#field-code').fill('documents:read');
  await page.getByRole('dialog').locator('#field-name').fill(names.permission);
  await saveForm();
  await page.getByRole('tab', { name: 'Vai trò', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm vai trò', exact: true }).click();
  await page.getByRole('dialog').locator('#field-code').fill('documents-reader');
  await page.getByRole('dialog').locator('#field-name').fill(names.role);
  await page
    .getByRole('dialog')
    .getByRole('checkbox', { name: names.permission, exact: true })
    .check();
  await page.getByRole('dialog').locator('#change-reason').fill(reason);
  await page.getByRole('dialog').getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await confirmation.waitFor();
  await scan('role confirmation');
  await confirmation.getByRole('button', { name: 'Quay lại biểu mẫu', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  assert.equal(
    (
      await (
        await context.request.get(
          A + '/api/v1/manage/roles?tenantId=' + ids.tenantA + '&appCode=' + appCode,
        )
      ).json()
    ).items.length,
    0,
  );
  await saveForm();
  await scan('custom role list');
  await archive(names.role);
  await page.getByRole('tab', { name: 'Danh mục quyền', exact: true }).click();
  await archive(names.permission);
  stage = 'archive catalog fixture in dependency order';
  await nav('Danh mục ứng dụng');
  await editByName(names.app);
  await select('status', 'Tạm dừng');
  await saveForm();
  await nav('Cơ cấu tổ chức');
  await page.getByRole('tab', { name: 'Vị trí công tác', exact: true }).click();
  await archive(names.position);
  await page.getByRole('tab', { name: 'Chức danh', exact: true }).click();
  await archive(names.title);
  await page.getByRole('tab', { name: 'Đơn vị / phòng ban', exact: true }).click();
  await archive(names.unit);
  await page.getByRole('tab', { name: 'Pháp nhân', exact: true }).click();
  await archive(names.entity);
  await page
    .getByRole('textbox', { name: 'Tìm kiếm trong danh sách' })
    .fill('definitely-no-match-' + run);
  await page.getByText('Không có kết quả phù hợp.', { exact: true }).waitFor();
  await scan('directory empty filter');
  stage = 'audit list, filter and before-after details';
  await nav('Lịch sử quản trị');
  await page.getByRole('textbox', { name: 'Lọc lịch sử quản trị' }).fill(reason);
  const view = page.getByRole('button', { name: 'Xem', exact: true }).first();
  await view.waitFor();
  await scan('audit filtered list');
  await view.click();
  const auditDialog = page.getByRole('dialog', { name: 'Chi tiết thay đổi' });
  await auditDialog.waitFor();
  await scan('audit detail dialog');
  await auditDialog.getByRole('heading', { name: 'Trước thay đổi', exact: true }).waitFor();
  await auditDialog.getByRole('heading', { name: 'Sau thay đổi', exact: true }).waitFor();
  assert.ok(
    (await auditDialog.locator('pre').allTextContents()).some((value) => value.includes('active')),
  );
  await page.keyboard.press('Escape');
  await auditDialog.waitFor({ state: 'hidden' });
  assert.equal(await view.evaluate((element) => element === document.activeElement), true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '.local/evidence/admin-audit-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await scan('mobile audit list');
  await page.screenshot({
    path: '.local/evidence/admin-audit-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Mở menu', exact: true }).click();
  await scan('mobile navigation sheet');
  await page
    .getByRole('dialog', { name: 'Điều hướng TLQM AIO' })
    .getByRole('button', { name: 'Định danh & vòng đời', exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Tài khoản đích', exact: true }).waitFor();
  await scan('mobile identity management');
  const csp = await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp ?? []);
  assert.deepEqual(csp, []);
  stage = 'reader no-access UI';
  const logout = await context.request.post(A + '/auth/logout', {
    headers: { origin: A, 'x-csrf-token': csrf },
    data: { global: true },
  });
  assert.equal(logout.status(), 200);
  await page.goto((await logout.json()).redirectTo);
  if (await page.locator('#kc-logout').isVisible()) await page.locator('#kc-logout').click();
  await page.waitForURL(A + '/', { timeout: 15000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login('demo.learner');
  await nav('Danh mục ứng dụng');
  await page
    .getByText('Bạn chưa được cấp quyền thực hiện thao tác này.', { exact: true })
    .waitFor();
  await scan('reader registry denied');
  await nav('Định danh & vòng đời');
  await page
    .getByText('Bạn chưa được cấp quyền quản lý định danh trong không gian này.', { exact: true })
    .waitFor();
  await scan('reader identity denied');
  assert.equal(
    (await context.request.get(A + '/api/v1/audit?tenantId=' + ids.tenantB)).status(),
    403,
  );
  await writeFile(
    '.local/evidence/admin-ui.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans: scans.length,
        violations: scans.reduce((sum, scan) => sum + scan.violations.length, 0),
        checks: [
          'legal entity/unit/title/position UI create and archive',
          'planned registry UI and unprovisioned activation rejection',
          'custom permission/role UI with confirmation and cancel-before-write',
          'audit filtering and before/after dialog with focus restoration',
          'desktop/mobile and no-access states',
          'WCAG A/AA automated scans without exclusions or disabled rules',
          'strict CSP unchanged',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: remaining administration UI workflows, audit, no-access/mobile states and accessibility scans.',
  );
} catch (error) {
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error(
      'Admin UI numeric assertion: actual=' + error.actual + ' expected=' + error.expected,
    );
  console.error(
    'Admin UI E2E failed at: ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). No credentials, DOM HTML or response payloads logged.',
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await Promise.all(servers.map((server) => server.close()));
}
