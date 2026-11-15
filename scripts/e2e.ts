import { bffClients } from '../src/config.js';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import type { BrowserContext, Page, Locator } from '@playwright/test';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { ids } from '../src/fixtures.js';
import { unseal, seal } from '../src/security.js';
import type { LoginTokens } from '../src/oidc.js';
import { OidcClient } from '../src/oidc.js';
import { hashToken } from '../src/security.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { nextFixtureOtp } from './local-totp.js';
import { recoverLocalAdministrator } from './recovery.js';
import { reserveTestRequests } from './e2e-request-budget.js';

const runtime = await loadLocalConfig();
const testRuntime = { ...runtime, databaseUrl: testDatabaseUrl(runtime) };
const pool = new pg.Pool({ connectionString: testRuntime.databaseUrl, max: 2 });
const servers: FastifyInstance[] = [];
const browser = await chromium.launch({ headless: true });
let qaPage: Page | undefined;
let stage = 'startup';
const measurements: Record<string, number> = {};
const A = 'http://127.0.0.1:4100',
  B = 'http://127.0.0.1:4101';
const integration = runtime.clients.find((client) => client.kind === 'integration-probe');
const context = () => browser.newContext();
async function saveDialog(page: Page, dialog: Locator) {
  await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await page.waitForFunction(
    () =>
      !!document.querySelector('[role="alertdialog"]') ||
      !document.querySelector('[role="dialog"]'),
  );
  const confirmation = page.getByRole('alertdialog', { name: 'Xác nhận thay đổi quyền truy cập' });
  if (await confirmation.isVisible())
    await confirmation.getByRole('button', { name: 'Xác nhận lưu', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function login(ctx: BrowserContext, username: string, base = A): Promise<Page> {
  const page = await ctx.newPage();
  const user = runtime.users.find((value) => value.username === username);
  assert.ok(user);
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (['demo.admin', 'demo.recovery-admin'].includes(username)) {
    await page.locator('#otp').waitFor();
    assert.equal(
      (await ctx.request.get(base + '/api/v1/me')).status(),
      401,
      'Password alone must not create an application session.',
    );
    await page.locator('#otp').fill('invalid-otp');
    await page.locator('#kc-login').click();
    await page.locator('#otp').waitFor();
    assert.equal(new URL(page.url()).origin, new URL(runtime.issuer).origin);
    assert.equal((await ctx.request.get(base + '/api/v1/me')).status(), 401);
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === base, { timeout: 15000 });
  return page;
}
async function getMe(ctx: BrowserContext, base = A) {
  const response = await ctx.request.get(base + '/api/v1/me');
  if (response.status() !== 200)
    console.log(
      'Session check: ' + response.status() + ' ' + String((await response.json()).error),
    );
  assert.equal(response.status(), 200);
  return response.json();
}
async function legacyGrant(
  ctx: BrowserContext,
  path: string,
  data: Record<string, unknown>,
  headers: Record<string, string> = {},
  expectedRevision?: number,
  key = randomUUID(),
) {
  const current = (
    await pool.query(
      'SELECT revision FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
      [data.accountId, data.tenantId, data.appCode],
    )
  ).rows[0];
  return ctx.request.post(A + '/api/v1/access/grants' + path, {
    headers: { ...headers, 'idempotency-key': key },
    data: { ...data, expectedRevision: expectedRevision ?? current?.revision ?? 0 },
  });
}
async function readAfterRateLimit(
  ctx: BrowserContext,
  url: string,
  headers?: Record<string, string>,
) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await ctx.request.get(url, headers ? { headers } : {});
    if (response.status() !== 429) return response;
    const seconds = Number(response.headers()['retry-after']);
    assert.ok(
      Number.isFinite(seconds) && seconds >= 0 && seconds <= 60,
      'Expected bounded Retry-After from the local rate limiter.',
    );
    const wait = seconds * 1000 + 100;
    assert.ok(Date.now() + wait <= deadline + 100, 'Rate limit did not recover within one window.');
    measurements.honoredRateLimitRetries = (measurements.honoredRateLimitRetries ?? 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
try {
  assert.ok(
    integration,
    'Run local:client to onboard an independent integration probe before E2E.',
  );
  const C = integration.baseUrl;
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
  for (const client of bffClients(runtime)) {
    const server = await createApp({ runtime: testRuntime, client, test: true, logger: false });
    server.addHook('onResponse', async (_request, reply) => {
      if (reply.statusCode === 429)
        measurements.rateLimitResponses = (measurements.rateLimitResponses ?? 0) + 1;
    });
    await server.listen({ host: '127.0.0.1', port: client.port });
    servers.push(server);
  }
  stage = 'unauthenticated';
  const stranger = await context();
  assert.equal((await stranger.request.get(A + '/api/v1/me')).status(), 401);
  assert.equal((await stranger.request.get(A + '/health/ready')).status(), 200);
  stage = 'login and SSO';
  const learner = await context();
  const page = await login(learner, 'demo.learner');
  const first = await getMe(learner);
  assert.equal(first.personId, ids.learner);
  assert.equal(first.assignments.length, 2);
  await page.goto(B + '/auth/login');
  await page.waitForURL(B + '/', { timeout: 15000 });
  const second = await getMe(learner, B);
  assert.equal(second.personId, first.personId);
  stage = 'third-client SSO and isolated permissions';
  await page.goto(C + '/auth/login');
  await page.waitForURL(C + '/', { timeout: 15000 });
  const third = await getMe(learner, C);
  assert.equal(third.personId, first.personId);
  assert.equal(third.appCode, integration.code);
  assert.deepEqual(
    third.permissions.map((p: { permission: string }) => p.permission),
    ['integration:read'],
  );
  assert.equal(
    (await learner.request.get(C + '/api/v1/directory?tenantId=' + ids.tenantA)).status(),
    403,
  );
  const deniedC = await context();
  const deniedCPage = await login(deniedC, 'demo.other', C);
  await deniedCPage.locator('[data-auth-error]').waitFor();
  assert.equal(
    await deniedCPage.locator('[data-auth-error]').getAttribute('data-auth-error'),
    'APPLICATION_ACCESS_DENIED',
  );
  await deniedC.close();
  const thirdCookie = (await learner.cookies()).find(
    (cookie) => cookie.name === 'aio_session_' + integration.code,
  )!;
  const thirdSession = (
    await pool.query('SELECT encrypted_payload FROM sessions WHERE hash=$1 AND app_code=$2', [
      hashToken(thirdCookie.value),
      integration.code,
    ])
  ).rows[0];
  const thirdTokens = unseal<LoginTokens>(
    thirdSession.encrypted_payload,
    runtime.encryptionKey,
    'session:' + integration.code,
  );
  await page.goto(A + '/');
  await page.locator('[data-code="AUTHENTICATED"]').waitFor();
  await mkdir('.local/evidence', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(() =>
      document.fonts.check('400 14px "Be Vietnam Pro"', 'Chuyên viên đào tạo'),
    ),
    true,
  );
  await page.screenshot({ path: '.local/evidence/foundation-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: '.local/evidence/foundation-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const cookies = await learner.cookies();
  assert.ok(cookies.find((value) => value.name === 'aio_session_aio-foundation')?.httpOnly);
  assert.ok(cookies.find((value) => value.name === 'aio_session_aio-probe')?.httpOnly);
  assert.notEqual(
    cookies.find((value) => value.name === 'aio_session_aio-foundation')?.value,
    cookies.find((value) => value.name === 'aio_session_aio-probe')?.value,
  );
  stage = 'tenant isolation';
  assert.equal(
    (await learner.request.get(A + '/api/v1/directory?tenantId=' + ids.tenantA)).status(),
    200,
  );
  assert.equal(
    (await learner.request.get(A + '/api/v1/directory?tenantId=' + ids.tenantB)).status(),
    403,
  );
  stage = 'real token expiry and serialized renewal';
  const renewalAdmin = await localKeycloakAdmin(runtime);
  const clientRecord = (
    (await (await renewalAdmin('/clients?clientId=aio-foundation')).json()) as {
      id: string;
      attributes: Record<string, string>;
      webOrigins: string[];
    }[]
  )[0]!;
  const renewal = await context();
  let renewalHash: string | undefined;
  try {
    // Keep this browser on a neutral local page: no background UI request may refresh the token early.
    await renewal.route(A + '/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>Local session test</p>' }),
    );
    try {
      await renewalAdmin('/clients/' + clientRecord.id, 'PUT', {
        attributes: { ...clientRecord.attributes, 'access.token.lifespan': '5' },
        webOrigins: clientRecord.webOrigins,
      });
      await login(renewal, 'demo.other');
    } finally {
      await renewalAdmin('/clients/' + clientRecord.id, 'PUT', {
        webOrigins: clientRecord.webOrigins,
        // Keycloak merges attributes; explicitly remove a temporary override when absent before.
        attributes: {
          ...clientRecord.attributes,
          'access.token.lifespan': clientRecord.attributes['access.token.lifespan'] ?? null,
        },
      });
    }
    const renewalCookie = (await renewal.cookies()).find(
      (value) => value.name === 'aio_session_aio-foundation',
    )!;
    renewalHash = hashToken(renewalCookie.value);
    const priorRow = (
      await pool.query('SELECT encrypted_payload,absolute_expires_at FROM sessions WHERE hash=$1', [
        renewalHash,
      ])
    ).rows[0];
    const priorTokens = unseal<LoginTokens>(
      priorRow.encrypted_payload,
      runtime.encryptionKey,
      'session:aio-foundation',
    );
    stage = 'short-lived token fixture';
    assert.ok(priorTokens.refreshToken);
    assert.ok(priorTokens.expiresAt <= Date.now() + 6000);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, priorTokens.expiresAt - Date.now() + 1000)),
    );
    assert.equal(
      (
        await renewal.request.get(A + '/api/v1/me', {
          headers: { authorization: 'Bearer ' + priorTokens.accessToken },
        })
      ).status(),
      401,
    );
    const renewalStarted = Date.now();
    const renewedResponses = await Promise.all(
      Array.from({ length: 3 }, () => renewal.request.get(A + '/api/v1/me')),
    );
    stage = 'renewal responses';
    if (renewedResponses.some((response) => response.status() !== 200))
      console.log(
        'Renewal responses: ' +
          JSON.stringify(
            await Promise.all(
              renewedResponses.map(async (response) => ({
                status: response.status(),
                error: (await response.json()).error,
              })),
            ),
          ),
      );
    assert.ok(renewedResponses.every((response) => response.status() === 200));
    measurements.threeConcurrentRenewalRequestsMs = Date.now() - renewalStarted;
    stage = 'renewed token and absolute deadline';
    const nextRow = (
      await pool.query('SELECT encrypted_payload,absolute_expires_at FROM sessions WHERE hash=$1', [
        renewalHash,
      ])
    ).rows[0];
    const nextTokens = unseal<LoginTokens>(
      nextRow.encrypted_payload,
      runtime.encryptionKey,
      'session:aio-foundation',
    );
    console.log(
      'Renewal verification: ' +
        JSON.stringify({
          changedAccess: nextTokens.accessToken !== priorTokens.accessToken,
          changedRefresh: nextTokens.refreshToken !== priorTokens.refreshToken,
          remainingMs: nextTokens.expiresAt - Date.now(),
          preservedMaximum:
            nextRow.absolute_expires_at.getTime() === priorRow.absolute_expires_at.getTime(),
        }),
    );
    assert.ok(nextTokens.accessToken !== priorTokens.accessToken);
    assert.ok(nextTokens.refreshToken !== priorTokens.refreshToken);
    assert.ok(nextTokens.expiresAt > Date.now() + 30_000);
    assert.equal(nextRow.absolute_expires_at.getTime(), priorRow.absolute_expires_at.getTime());
    assert.ok(
      (await renewal.cookies()).find((value) => value.name === renewalCookie.name)?.value ===
        renewalCookie.value,
    );
    const renewalClient = await OidcClient.create(
      runtime,
      runtime.clients.find((client) => client.code === 'aio-foundation')!,
    );
    await assert.rejects(() => renewalClient.refresh(priorTokens), { code: 'SESSION_REVOKED' });
    stage = 'invalid refresh fails closed';
    await pool.query('UPDATE sessions SET encrypted_payload=$2 WHERE hash=$1', [
      renewalHash,
      seal(
        { ...nextTokens, refreshToken: 'invalid-local-fixture', expiresAt: Date.now() - 1000 },
        runtime.encryptionKey,
        'session:aio-foundation',
      ),
    ]);
    assert.equal((await renewal.request.get(A + '/api/v1/me')).status(), 401);
    assert.equal(
      (await pool.query('SELECT 1 FROM sessions WHERE hash=$1', [renewalHash])).rowCount,
      0,
    );
  } finally {
    if (renewalHash) await pool.query('DELETE FROM sessions WHERE hash=$1', [renewalHash]);
    await renewal.close();
  }
  stage = 'browser idle and absolute expiry';
  for (const absolute of [false, true]) {
    const expired = await context();
    let expiredHash: string | undefined;
    try {
      await expired.route(A + '/', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<p>Local session test</p>' }),
      );
      await login(expired, 'demo.other');
      expiredHash = hashToken(
        (await expired.cookies()).find((value) => value.name === 'aio_session_aio-foundation')!
          .value,
      );
      await pool.query(
        absolute
          ? "UPDATE sessions SET expires_at=now()-interval '1 second',absolute_expires_at=now()-interval '1 second' WHERE hash=$1"
          : "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE hash=$1",
        [expiredHash],
      );
      const denied = await expired.request.get(A + '/api/v1/me');
      assert.equal(denied.status(), 401);
      assert.equal((await denied.json()).error, 'SESSION_EXPIRED');
    } finally {
      if (expiredHash) await pool.query('DELETE FROM sessions WHERE hash=$1', [expiredHash]);
      await expired.close();
    }
  }
  stage = 'cross-client tokens';
  const row = (
    await pool.query(
      "SELECT encrypted_payload FROM sessions WHERE account_id=$1 AND app_code='aio-foundation' ORDER BY expires_at DESC LIMIT 1",
      [ids.learner],
    )
  ).rows[0];
  const tokens = unseal<LoginTokens>(
    row.encrypted_payload,
    runtime.encryptionKey,
    'session:aio-foundation',
  );
  for (const target of [A, B])
    assert.equal(
      (
        await stranger.request.get(target + '/api/v1/me', {
          headers: { authorization: 'Bearer ' + thirdTokens.accessToken },
        })
      ).status(),
      401,
    );
  assert.equal(
    (
      await stranger.request.get(C + '/api/v1/me', {
        headers: { authorization: 'Bearer ' + tokens.accessToken },
      })
    ).status(),
    401,
  );
  assert.equal(
    (
      await stranger.request.get(C + '/api/v1/me', {
        headers: { authorization: 'Bearer ' + thirdTokens.idToken },
      })
    ).status(),
    401,
  );
  const forgedCookie = await context();
  const foundationCookie = cookies.find((cookie) => cookie.name === 'aio_session_aio-foundation')!;
  await forgedCookie.addCookies([{ ...foundationCookie, value: thirdCookie.value }]);
  assert.equal((await forgedCookie.request.get(A + '/api/v1/me')).status(), 401);
  await forgedCookie.close();
  const thirdOidc = await OidcClient.create(runtime, integration);
  const invalidCallback = new URL((await thirdOidc.begin()).url);
  invalidCallback.searchParams.set('redirect_uri', C + '/unregistered-callback');
  assert.equal((await stranger.request.get(invalidCallback.href)).status(), 400);
  assert.equal(
    (
      await learner.request.get(B + '/api/v1/me', {
        headers: { authorization: 'Bearer ' + tokens.accessToken },
      })
    ).status(),
    401,
  );
  stage = 'csrf and permission enforcement';
  const change = {
    accountId: ids.learner,
    tenantId: ids.tenantA,
    appCode: 'aio-probe',
    reason: 'E2E revocation check',
  };
  assert.equal((await legacyGrant(learner, '/revoke', change)).status(), 403);
  assert.equal(
    (
      await legacyGrant(learner, '/revoke', change, { origin: A, 'x-csrf-token': first.csrfToken })
    ).status(),
    403,
  );
  const admin = await context();
  const adminPage = await login(admin, 'demo.admin');
  qaPage = adminPage;
  const adminMe = await getMe(admin);
  const adminHeaders = { origin: A, 'x-csrf-token': adminMe.csrfToken };
  stage = 'MFA enforcement on an existing password-only session';
  try {
    await pool.query('UPDATE accounts SET mfa_required=true WHERE id=$1', [ids.learner]);
    const deniedMfa = await learner.request.get(A + '/api/v1/me');
    assert.equal(deniedMfa.status(), 403);
    assert.equal((await deniedMfa.json()).error, 'MFA_REQUIRED');
    assert.equal(
      (
        await learner.request.get(A + '/api/v1/me', {
          headers: { authorization: 'Bearer ' + tokens.accessToken, 'x-amr': 'pwd otp' },
        })
      ).status(),
      403,
    );
  } finally {
    await pool.query('UPDATE accounts SET mfa_required=false WHERE id=$1', [ids.learner]);
  }
  stage = 'shadcn form and keyboard UI';
  await adminPage.setViewportSize({ width: 1440, height: 1000 });
  await adminPage.evaluate(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective);
    });
  });
  await adminPage
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Cơ cấu tổ chức', exact: true })
    .click();
  await adminPage.getByRole('tab', { name: 'Chức danh', exact: true }).click();
  const createButton = adminPage.getByRole('button', { name: 'Thêm chức danh', exact: true });
  const buttonStyle = await createButton.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    width: element.getBoundingClientRect().width,
    background: getComputedStyle(element).backgroundColor,
    radius: getComputedStyle(element).borderRadius,
  }));
  assert.ok(buttonStyle.height >= 44 && buttonStyle.width >= 44);
  assert.equal(buttonStyle.background, 'rgb(8, 124, 60)');
  assert.equal(buttonStyle.radius, '10px');
  const bodyStyle = await adminPage.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    font: getComputedStyle(document.body).fontFamily,
  }));
  assert.equal(bodyStyle.background, 'rgb(245, 248, 250)');
  assert.ok(bodyStyle.font.includes('Be Vietnam Pro'));
  await createButton.click();
  const dialog = adminPage.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await dialog.getByText('Vui lòng nhập mã.', { exact: true }).waitFor();
  await adminPage.screenshot({ path: '.local/evidence/admin-form-invalid.png', fullPage: true });
  const uiCode = 'UI-' + randomUUID().slice(0, 8);
  await dialog.locator('#field-code').fill(uiCode);
  await dialog.locator('#field-name').fill('Chức danh qua giao diện shadcn');
  await dialog.locator('#change-reason').fill('Kiểm thử lưu từ giao diện');
  for (let index = 0; index < 12; index++) {
    await adminPage.keyboard.press('Tab');
    assert.equal(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      true,
    );
  }
  await saveDialog(adminPage, dialog);
  await adminPage.getByText('Đã lưu thay đổi và ghi nhận lịch sử.', { exact: true }).waitFor();
  assert.equal(await createButton.evaluate((element) => document.activeElement === element), true);
  await adminPage.getByRole('textbox', { name: 'Tìm kiếm trong danh sách' }).fill(uiCode);
  await adminPage.getByRole('cell', { name: uiCode, exact: true }).waitFor();
  await adminPage.screenshot({
    path: '.local/evidence/admin-directory-desktop.png',
    fullPage: true,
  });
  await adminPage
    .getByRole('button', { name: 'Sửa Chức danh qua giao diện shadcn', exact: true })
    .click();
  await dialog.getByRole('checkbox', { name: 'Đang hoạt động' }).uncheck();
  await dialog.locator('#change-reason').fill('Lưu trữ bản ghi kiểm thử giao diện');
  await saveDialog(adminPage, dialog);
  stage = 'shadcn relation and role editors';
  await adminPage.getByRole('tab', { name: 'Đơn vị / phòng ban', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Thêm đơn vị', exact: true }).click();
  await dialog.getByRole('combobox', { name: /Pháp nhân/ }).click();
  await adminPage.getByRole('option', { name: 'Pháp nhân giả lập A', exact: true }).click();
  const unitCode = 'UI-' + randomUUID().slice(0, 8);
  await dialog.locator('#field-code').fill(unitCode);
  await dialog.locator('#field-name').fill('Đơn vị qua giao diện');
  await dialog.locator('#change-reason').fill('Kiểm thử danh mục liên quan');
  await saveDialog(adminPage, dialog);
  await adminPage.getByRole('textbox', { name: 'Tìm kiếm trong danh sách' }).fill(unitCode);
  await adminPage.getByRole('cell', { name: unitCode, exact: true }).waitFor();
  await adminPage.getByRole('button', { name: 'Sửa Đơn vị qua giao diện', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Đang hoạt động' }).uncheck();
  await dialog.locator('#change-reason').fill('Lưu trữ đơn vị kiểm thử');
  await saveDialog(adminPage, dialog);
  await adminPage
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Vai trò & truy cập', exact: true })
    .click();
  await adminPage.getByRole('tab', { name: 'Vai trò', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Thêm vai trò', exact: true }).click();
  const uiRole = 'ui-reader-' + randomUUID().slice(0, 8);
  await dialog.locator('#field-code').fill(uiRole);
  await dialog.locator('#field-name').fill('Vai trò qua giao diện');
  await dialog.getByRole('checkbox', { name: 'Xem cơ cấu tổ chức', exact: true }).check();
  await dialog.locator('#change-reason').fill('Kiểm thử thiết kế vai trò');
  await adminPage.screenshot({ path: '.local/evidence/admin-role-editor.png', fullPage: true });
  await saveDialog(adminPage, dialog);
  await adminPage.getByRole('textbox', { name: 'Tìm kiếm trong danh sách' }).fill(uiRole);
  await adminPage.getByRole('cell', { name: uiRole, exact: true }).waitFor();
  await adminPage.getByRole('button', { name: 'Sửa Vai trò qua giao diện', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Đang hoạt động' }).uncheck();
  await dialog.locator('#change-reason').fill('Lưu trữ vai trò kiểm thử');
  await saveDialog(adminPage, dialog);
  await adminPage.setViewportSize({ width: 390, height: 844 });
  await adminPage.getByRole('button', { name: 'Mở menu', exact: true }).click();
  const mobileMenu = adminPage.getByRole('dialog', { name: 'Điều hướng TLQM AIO' });
  await mobileMenu.getByRole('button', { name: 'Hồ sơ của tôi', exact: true }).click();
  await mobileMenu.waitFor({ state: 'hidden' });
  await adminPage
    .getByText('Danh tính nội bộ dùng chung trong nền tảng.', { exact: true })
    .waitFor();
  assert.ok(
    await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  );
  await adminPage.screenshot({ path: '.local/evidence/admin-profile-mobile.png', fullPage: true });
  const cspViolations = await adminPage.evaluate(
    () => (window as Window & { qaCsp?: string[] }).qaCsp ?? [],
  );
  if (cspViolations.length)
    console.error(
      'UI CSP directives rejected: ' +
        [...new Set(cspViolations)].filter((value) => /^[a-z-]+$/.test(value)).join(','),
    );
  assert.deepEqual(cspViolations, []);
  stage = 'directory management API';
  const titleBody = {
    tenantId: ids.tenantA,
    reason: 'Kiểm thử HTTP quản trị',
    data: { code: 'HTTP-' + randomUUID().slice(0, 8), name: 'Chức danh từ E2E' },
  };
  const titleHeaders = { ...adminHeaders, 'idempotency-key': randomUUID() };
  const titleResponse = await admin.request.post(A + '/api/v1/manage/job-titles', {
    headers: titleHeaders,
    data: titleBody,
  });
  assert.equal(titleResponse.status(), 200);
  const title = await titleResponse.json();
  const repeated = await admin.request.post(A + '/api/v1/manage/job-titles', {
    headers: titleHeaders,
    data: titleBody,
  });
  assert.equal((await repeated.json()).id, title.id);
  assert.equal(
    (
      await admin.request.post(A + '/api/v1/manage/job-titles', {
        headers: adminHeaders,
        data: titleBody,
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await learner.request.post(A + '/api/v1/manage/job-titles', {
        headers: { origin: A, 'x-csrf-token': first.csrfToken, 'idempotency-key': randomUUID() },
        data: titleBody,
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await admin.request.post(A + '/api/v1/manage/job-titles', {
        headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
        data: { ...titleBody, tenantId: ids.tenantB },
      })
    ).status(),
    403,
  );
  const edited = await admin.request.patch(A + '/api/v1/manage/job-titles/' + title.id, {
    headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
    data: {
      tenantId: ids.tenantA,
      reason: 'Cập nhật bản ghi thử',
      expectedRevision: 1,
      data: { name: 'Đã cập nhật từ E2E' },
    },
  });
  assert.equal(edited.status(), 200);
  assert.equal((await edited.json()).revision, 2);
  assert.equal(
    (
      await admin.request.patch(A + '/api/v1/manage/job-titles/' + title.id, {
        headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
        data: {
          tenantId: ids.tenantA,
          reason: 'Thử ghi đè phiên bản cũ',
          expectedRevision: 1,
          data: { name: 'Stale write' },
        },
      })
    ).status(),
    409,
  );
  assert.equal(
    (
      await admin.request.patch(A + '/api/v1/manage/job-titles/' + title.id, {
        headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
        data: {
          tenantId: ids.tenantA,
          reason: 'Lưu trữ dữ liệu kiểm thử',
          expectedRevision: 2,
          data: { active: false },
        },
      })
    ).status(),
    200,
  );
  stage = 'role and registry HTTP management';
  const governanceWrite = (
    method: 'post' | 'patch',
    path: string,
    data: Record<string, unknown>,
    expectedRevision?: number,
  ) =>
    admin.request[method](A + '/api/v1/manage/' + path, {
      headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
      data: {
        tenantId: ids.tenantA,
        reason: 'Kiểm thử HTTP phân quyền',
        data,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      },
    });
  stage = 'third-client revocation, role scope and registry rollback';
  const getGrantC = async () =>
    (
      await (
        await admin.request.get(
          A + '/api/v1/manage/grants?tenantId=' + ids.tenantA + '&appCode=' + integration.code,
        )
      ).json()
    ).items.find((grant: { accountId: string }) => grant.accountId === ids.learner);
  const getAppC = async () =>
    (
      await (
        await admin.request.get(A + '/api/v1/manage/applications?tenantId=' + ids.tenantA)
      ).json()
    ).items.find((app: { code: string }) => app.code === integration.code);
  const getRoleC = async () =>
    (
      await (
        await admin.request.get(
          A + '/api/v1/manage/roles?tenantId=' + ids.tenantA + '&appCode=' + integration.code,
        )
      ).json()
    ).items.find((role: { code: string }) => role.code === 'integration-reader');
  try {
    const grant = await getGrantC();
    const revokeStart = Date.now();
    assert.equal(
      (
        await governanceWrite(
          'patch',
          'grants/' + ids.learner,
          { appCode: integration.code, accountId: ids.learner, active: false },
          grant.revision,
        )
      ).status(),
      200,
    );
    assert.equal((await learner.request.get(C + '/api/v1/me')).status(), 403);
    measurements.thirdClientRevocationMs = Date.now() - revokeStart;
    assert.ok(measurements.thirdClientRevocationMs < 60_000);
    for (const base of [A, B])
      assert.equal((await learner.request.get(base + '/api/v1/me')).status(), 200);
    assert.equal(
      (
        await governanceWrite(
          'patch',
          'grants/' + ids.learner,
          { appCode: integration.code, accountId: ids.learner, active: true },
          (await getGrantC()).revision,
        )
      ).status(),
      200,
    );
    const role = await getRoleC();
    assert.equal(
      (
        await governanceWrite(
          'patch',
          'roles/integration-reader',
          { appCode: integration.code, active: false },
          role.revision,
        )
      ).status(),
      200,
    );
    assert.deepEqual((await getMe(learner, C)).permissions, []);
    assert.equal(
      (await learner.request.get(B + '/api/v1/directory?tenantId=' + ids.tenantA)).status(),
      200,
    );
    assert.equal(
      (
        await governanceWrite(
          'patch',
          'applications/' + integration.code,
          { status: 'disabled' },
          (await getAppC()).revision,
        )
      ).status(),
      200,
    );
    assert.equal((await learner.request.get(C + '/api/v1/me')).status(), 403);
    assert.equal((await learner.request.get(A + '/api/v1/me')).status(), 200);
  } finally {
    const app = await getAppC();
    if (app.status !== 'active')
      assert.equal(
        (
          await governanceWrite(
            'patch',
            'applications/' + integration.code,
            { status: 'active' },
            app.revision,
          )
        ).status(),
        200,
      );
    const role = await getRoleC();
    if (!role.active)
      assert.equal(
        (
          await governanceWrite(
            'patch',
            'roles/integration-reader',
            { appCode: integration.code, active: true },
            role.revision,
          )
        ).status(),
        200,
      );
    const grant = await getGrantC();
    if (!grant.active)
      assert.equal(
        (
          await governanceWrite(
            'patch',
            'grants/' + ids.learner,
            { appCode: integration.code, accountId: ids.learner, active: true },
            grant.revision,
          )
        ).status(),
        200,
      );
  }
  assert.equal((await getMe(learner, C)).permissions[0].permission, 'integration:read');
  const onboardingEvents = await pool.query(
    "SELECT action FROM audit_events WHERE target_id=$1 AND action IN ('application.registered','application.provisioned','application.updated')",
    [integration.code],
  );
  for (const action of ['application.registered', 'application.provisioned', 'application.updated'])
    assert.ok(onboardingEvents.rows.some((event) => event.action === action));
  stage = 'role and registry HTTP management';
  const roleCode = 'e2e-' + randomUUID().slice(0, 8);
  const newRole = await governanceWrite('post', 'roles', {
    appCode: 'aio-foundation',
    code: roleCode,
    name: 'Đọc đơn vị được giao',
    permissions: ['directory:read'],
  });
  assert.equal(newRole.status(), 200);
  const defaultBindings = (
    await (
      await admin.request.get(
        A + '/api/v1/manage/bindings?tenantId=' + ids.tenantA + '&appCode=aio-foundation',
      )
    ).json()
  ).items;
  const defaultBinding = defaultBindings.find(
    (binding: { accountId: string; roleCode: string; active: boolean; orgUnitId: string | null }) =>
      binding.accountId === ids.learner &&
      binding.roleCode === 'reader' &&
      binding.active &&
      binding.orgUnitId === null,
  );
  assert.ok(defaultBinding);
  const scopedResponse = await governanceWrite('post', 'bindings', {
    appCode: 'aio-foundation',
    accountId: ids.learner,
    roleCode,
    orgUnitId: ids.unitA,
  });
  assert.equal(scopedResponse.status(), 200);
  const scopedBinding = await scopedResponse.json();
  let changedDefault = false;
  try {
    const disable = await governanceWrite(
      'patch',
      'bindings/' + defaultBinding.id,
      { appCode: 'aio-foundation', active: false },
      defaultBinding.revision,
    );
    assert.equal(disable.status(), 200);
    changedDefault = true;
    const scoped = await learner.request.get(A + '/api/v1/directory?tenantId=' + ids.tenantA);
    assert.equal(scoped.status(), 200);
    assert.deepEqual(
      (await scoped.json()).units.map((unit: { id: string }) => unit.id),
      [ids.unitA],
    );
    assert.equal(
      (
        await governanceWrite(
          'patch',
          'roles/' + roleCode,
          { appCode: 'aio-foundation', active: false },
          1,
        )
      ).status(),
      200,
    );
    assert.equal(
      (await learner.request.get(A + '/api/v1/directory?tenantId=' + ids.tenantA)).status(),
      403,
    );
    assert.equal(
      (
        await governanceWrite('post', 'bindings', {
          appCode: 'aio-foundation',
          accountId: ids.admin,
          roleCode: 'reader',
        })
      ).status(),
      403,
    );
  } finally {
    if (changedDefault) {
      const current = (
        await (
          await admin.request.get(
            A + '/api/v1/manage/bindings?tenantId=' + ids.tenantA + '&appCode=aio-foundation',
          )
        ).json()
      ).items.find((binding: { id: string }) => binding.id === defaultBinding.id);
      assert.equal(
        (
          await governanceWrite(
            'patch',
            'bindings/' + defaultBinding.id,
            { appCode: 'aio-foundation', active: true },
            current.revision,
          )
        ).status(),
        200,
      );
    }
    await governanceWrite(
      'patch',
      'bindings/' + scopedBinding.id,
      { appCode: 'aio-foundation', active: false },
      scopedBinding.revision,
    );
  }
  const registeredCode = 'e2e-app-' + randomUUID().slice(0, 8);
  const registered = await governanceWrite('post', 'applications', {
    code: registeredCode,
    name: 'Ứng dụng đăng ký từ giao diện API',
    launchUrl: 'http://127.0.0.1:4102',
  });
  assert.equal(registered.status(), 200);
  assert.equal((await registered.json()).status, 'planned');
  assert.equal(
    (
      await governanceWrite('patch', 'applications/' + registeredCode, { status: 'active' }, 1)
    ).status(),
    409,
  );
  assert.equal(
    (
      await governanceWrite('post', 'applications', {
        code: 'invalid-issuer',
        name: 'Không được cấp',
        issuer: 'https://example.com',
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await governanceWrite('patch', 'applications/' + registeredCode, { status: 'disabled' }, 1)
    ).status(),
    200,
  );
  stage = 'immediate revocation';
  const started = Date.now();
  try {
    const originalGrant = (
      await pool.query(
        'SELECT revision FROM application_grants WHERE app_code=$1 AND tenant_id=$2 AND account_id=$3',
        [change.appCode, change.tenantId, change.accountId],
      )
    ).rows[0];
    const auditBefore = (await pool.query('SELECT COALESCE(max(id),0) AS id FROM audit_events'))
      .rows[0].id;
    const legacyKey = randomUUID();
    const revoked = await legacyGrant(
      admin,
      '/revoke',
      change,
      adminHeaders,
      originalGrant.revision,
      legacyKey,
    );
    assert.equal(revoked.status(), 200);
    assert.equal((await revoked.json()).revision, originalGrant.revision + 1);
    assert.equal(
      (
        await legacyGrant(admin, '/revoke', change, adminHeaders, originalGrant.revision, legacyKey)
      ).status(),
      200,
    );
    const sharedReceipt = await admin.request.post(A + '/api/v1/manage/grants', {
      headers: { ...adminHeaders, 'idempotency-key': legacyKey },
      data: {
        tenantId: change.tenantId,
        reason: change.reason,
        expectedRevision: originalGrant.revision,
        data: { appCode: change.appCode, accountId: change.accountId, active: false },
      },
    });
    assert.equal(sharedReceipt.status(), 200);
    assert.equal((await sharedReceipt.json()).revision, originalGrant.revision + 1);
    assert.equal(
      (
        await legacyGrant(admin, '', change, adminHeaders, originalGrant.revision, legacyKey)
      ).status(),
      409,
    );
    assert.equal(
      (await legacyGrant(admin, '', change, adminHeaders, originalGrant.revision)).status(),
      409,
    );
    const revokedAudit = (
      await pool.query(
        "SELECT details FROM audit_events WHERE id>$1 AND action='access.revoked' AND target_id=$2",
        [auditBefore, change.appCode + ':' + change.accountId],
      )
    ).rows;
    assert.equal(revokedAudit.length, 1);
    assert.equal(revokedAudit[0].details.before.active, true);
    assert.equal(revokedAudit[0].details.after.active, false);
    assert.equal((await learner.request.get(B + '/api/v1/me')).status(), 403);
    measurements.grantRevocationMs = Date.now() - started;
    assert.ok(measurements.grantRevocationMs < 60_000);
    assert.equal((await learner.request.get(A + '/api/v1/me')).status(), 200);
    const audit = await admin.request.get(A + '/api/v1/audit?tenantId=' + ids.tenantA);
    assert.equal(audit.status(), 200);
    assert.ok(
      (await audit.json()).items.some(
        (event: { action: string }) => event.action === 'access.revoked',
      ),
    );
  } finally {
    assert.equal((await legacyGrant(admin, '', change, adminHeaders)).status(), 200);
  }
  stage = 'input and cross-tenant administration';
  assert.equal(
    (
      await admin.request.post(A + '/api/v1/access/grants', {
        headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
        data: change,
      })
    ).status(),
    400,
  );
  assert.equal(
    (await legacyGrant(admin, '', { ...change, role: 'super-admin' }, adminHeaders)).status(),
    400,
  );
  assert.equal(
    (
      await legacyGrant(
        admin,
        '',
        { ...change, tenantId: ids.tenantB, accountId: ids.other },
        adminHeaders,
      )
    ).status(),
    403,
  );
  stage = 'disabled and unassigned users';
  for (const [username, expected] of [
    ['demo.no-access', 'APPLICATION_ACCESS_DENIED'],
    ['demo.blocked', 'ACCOUNT_UNAVAILABLE'],
  ]) {
    const denied = await context();
    const deniedPage = await login(denied, username!);
    await deniedPage.locator('[data-auth-error]').waitFor();
    assert.equal(
      await deniedPage.locator('[data-auth-error]').getAttribute('data-auth-error'),
      expected,
    );
    assert.equal((await denied.request.get(A + '/api/v1/me')).status(), 401);
    await denied.close();
  }
  stage = 'IdP account disable';
  const other = await context();
  await login(other, 'demo.other');
  const keycloak = await localKeycloakAdmin(runtime);
  try {
    await keycloak('/users/' + ids.other, 'PUT', { enabled: false });
    assert.equal((await other.request.get(A + '/api/v1/me')).status(), 401);
  } finally {
    await keycloak('/users/' + ids.other, 'PUT', { enabled: true });
    await other.close();
  }
  stage = 'callback tampering and single use';
  const tx = await context();
  await tx.request.get(A + '/auth/login', { maxRedirects: 0 });
  const bad = await tx.request.get(A + '/auth/callback?code=invalid&state=invalid');
  assert.equal(bad.status(), 401);
  assert.equal(
    (await tx.request.get(A + '/auth/callback?code=invalid&state=invalid')).status(),
    401,
  );
  stage = 'missing and expired login transaction recovery';
  const recovery = await context();
  const recoveryPage = await recovery.newPage();
  const orphanCallback = A + '/auth/callback?code=orphan-fixture&state=orphan-fixture';
  for (const accept of ['application/json', 'text/html;q=0,application/json']) {
    const missing = await recovery.request.get(orphanCallback, {
      headers: { accept },
      maxRedirects: 0,
    });
    assert.equal(missing.status(), 401);
    assert.equal((await missing.json()).error, 'LOGIN_TRANSACTION_MISSING');
  }
  const htmlMissing = await recovery.request.get(orphanCallback, {
    headers: { accept: 'text/html' },
    maxRedirects: 0,
  });
  assert.equal(htmlMissing.status(), 303);
  assert.equal(htmlMissing.headers().location, '/#login-recovery');
  assert.equal(htmlMissing.headers()['cache-control'], 'no-store');
  await recoveryPage.goto(orphanCallback);
  await recoveryPage.waitForURL(A + '/#login-recovery');
  await recoveryPage.getByRole('heading', { name: 'Cần bắt đầu lại đăng nhập' }).waitFor();
  assert.equal((await recovery.request.get(A + '/api/v1/me')).status(), 401);
  assert.equal(
    (await recovery.cookies()).some((item) => item.name === 'aio_session_aio-foundation'),
    false,
  );
  await recoveryPage.getByRole('link', { name: 'Đăng nhập lại', exact: true }).click();
  await recoveryPage.locator('#username').waitFor();
  const pendingLogin = (await recovery.cookies()).find(
    (item) => item.name === 'aio_transaction_aio-foundation',
  );
  assert.ok(pendingLogin);
  // Simulate waiting past the five-minute DB deadline without disabling expiry.
  assert.equal(
    (
      await pool.query(
        "UPDATE login_transactions SET expires_at=now()-interval '1 second' WHERE hash=$1 AND app_code=$2",
        [hashToken(pendingLogin.value), 'aio-foundation'],
      )
    ).rowCount,
    1,
  );
  const recoveryUser = runtime.users.find((item) => item.username === 'demo.learner')!;
  await recoveryPage.locator('#username').fill(recoveryUser.username);
  await recoveryPage.locator('#password').fill(recoveryUser.password);
  await recoveryPage.locator('#kc-login').click();
  await recoveryPage.waitForURL(A + '/#login-recovery');
  await recoveryPage.getByRole('heading', { name: 'Cần bắt đầu lại đăng nhập' }).waitFor();
  assert.equal((await recovery.request.get(A + '/api/v1/me')).status(), 401);
  assert.equal(
    (await recovery.cookies()).some((item) => item.name === 'aio_session_aio-foundation'),
    false,
  );
  await recoveryPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await recoveryPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await recoveryPage.screenshot({
    path: '.local/evidence/login-recovery-mobile.png',
    fullPage: true,
  });
  // The completed IdP login can SSO into a genuinely new, state-bound transaction.
  await recoveryPage.getByRole('link', { name: 'Đăng nhập lại', exact: true }).click();
  await recoveryPage.waitForURL(A + '/', { timeout: 15000 });
  assert.equal((await getMe(recovery)).accountId, ids.learner);
  assert.equal((await recovery.request.get(orphanCallback)).status(), 401);
  assert.equal((await recovery.request.get(A + '/api/v1/me')).status(), 200);
  assert.equal(
    (
      await recovery.request.get(A + '/api/v1/me', {
        headers: { accept: 'text/html', authorization: 'Bearer invalid' },
        maxRedirects: 0,
      })
    ).status(),
    401,
  );
  await recovery.close();
  stage = 'local logout';
  assert.equal(
    (
      await learner.request.post(A + '/auth/logout', {
        headers: { origin: A, 'x-csrf-token': first.csrfToken },
        data: { global: false },
      })
    ).status(),
    200,
  );
  assert.equal((await learner.request.get(A + '/api/v1/me')).status(), 401);
  assert.equal((await learner.request.get(B + '/api/v1/me')).status(), 200);
  assert.equal((await learner.request.get(C + '/api/v1/me')).status(), 200);
  stage = 'global logout';
  await Promise.all([A, B, C].map((origin) => reserveTestRequests(learner, origin, 30)));
  await page.goto(A + '/auth/login');
  await page.waitForURL(A + '/', { timeout: 15000 });
  const activeA = (await learner.cookies()).find(
    (value) => value.name === 'aio_session_aio-foundation',
  );
  assert.ok(activeA);
  const meB = await getMe(learner, B);
  const logout = await learner.request.post(B + '/auth/logout', {
    headers: { origin: B, 'x-csrf-token': meB.csrfToken },
    data: { global: true },
  });
  assert.equal(logout.status(), 200);
  await page.goto((await logout.json()).redirectTo);
  const confirm = page.locator('#kc-logout');
  if (await confirm.isVisible()) await confirm.click();
  await page.waitForURL(B + '/', { timeout: 15000 });
  assert.equal((await learner.request.get(A + '/api/v1/me')).status(), 401);
  assert.equal((await learner.request.get(C + '/api/v1/me')).status(), 401);
  const sessionHash = hashToken(activeA.value);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await pool.query('SELECT 1 FROM sessions WHERE hash=$1', [sessionHash])).rowCount) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(
    (await pool.query('SELECT 1 FROM sessions WHERE hash=$1', [sessionHash])).rowCount,
    0,
    'Back-channel logout must remove the other client session.',
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM sessions WHERE hash=$1', [hashToken(thirdCookie.value)]))
      .rowCount,
    0,
    'Back-channel logout must also delete client C session.',
  );
  await page.goto(A + '/auth/login');
  await page.locator('#username').waitFor({ timeout: 15000 });
  stage = 'separate administrator MFA recovery';
  const recovered = await recoverLocalAdministrator(runtime, browser);
  stage = 'recovery invalidates prior BFF session';
  assert.equal((await readAfterRateLimit(admin, A + '/api/v1/me')).status(), 401);
  for (const proof of [recovered.recovery, recovered.restored]) {
    stage = 'recovery verified AMR';
    assert.ok(
      proof.authenticationMethods?.includes('pwd') && proof.authenticationMethods.includes('otp'),
    );
    stage = 'recovery restored API access';
    assert.equal(
      (
        await readAfterRateLimit(stranger, A + '/api/v1/me', {
          authorization: 'Bearer ' + proof.accessToken,
        })
      ).status(),
      200,
    );
  }
  const recoveryAudit = await pool.query(
    'SELECT action FROM audit_events WHERE request_id=$1 ORDER BY id',
    [recovered.recoveryId],
  );
  stage = 'recovery audit pair';
  assert.deepEqual(
    recoveryAudit.rows.map((row) => row.action),
    ['account.mfa_recovery_requested', 'account.mfa_recovery_completed'],
  );
  await writeFile(
    '.local/evidence/security-lifecycle.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        node: process.version,
        environment: 'isolated AIO local',
        testDatabase: 'aio_foundation_test',
        recoveryDatabases: ['aio_foundation', 'aio_foundation_test'],
        result: 'pass',
        measurements,
        checks: [
          'third client onboarded through versioned local manifest',
          'third-client SSO, tenant denial, token/cookie/audience isolation and backchannel logout',
          'independent app grant/role revocation and registry rollback with audit',
          'legacy and current grant routes share revision checks, idempotency receipts and atomic before/after audit',
          'password-only and incorrect OTP denied',
          'MFA required after privilege change',
          'separate recovery administrator verified',
          'primary sessions revoked and OTP reenrolled',
          'actual expired access token renewed',
          'old refresh token replay rejected',
          'idle and absolute expiry enforced',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: OIDC/SSO A/B/C, independent third-client contract/revocation/rollback, administrator MFA and recovery, real token expiry/renewal, invalid refresh and session deadlines, shadcn form CRUD and keyboard focus, desktop/mobile/font/CSP, tenant/audience/role scope, registry and revision guards, grants, audit, account disable, callback and logout.',
  );
} catch (error) {
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error('E2E numeric assertion: actual=' + error.actual + ' expected=' + error.expected);
  if (
    qaPage &&
    [A, B].includes(new URL(qaPage.url()).origin) &&
    new URL(qaPage.url()).pathname === '/'
  )
    await qaPage
      .screenshot({ path: '.local/evidence/ui-failure.png', fullPage: true })
      .catch(() => {});
  // Browser failure logs can contain form values or callback codes: report only the failing stage.
  console.error(
    'E2E failed at: ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). No credentials or tokens logged.',
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await Promise.all(servers.map((server) => server.close()));
  await pool.end();
}
