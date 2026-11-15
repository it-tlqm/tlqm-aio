import { bffClients } from '../src/config.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { nextFixtureOtp } from './local-totp.js';
import { ids } from '../src/fixtures.js';
import { hashToken, unseal } from '../src/security.js';
import { OidcClient } from '../src/oidc.js';
import type { LoginTokens } from '../src/oidc.js';

const runtime = await loadLocalConfig();
const testRuntime = { ...runtime, databaseUrl: testDatabaseUrl(runtime) };
const pool = new pg.Pool({ connectionString: testRuntime.databaseUrl, max: 3 });
const servers: FastifyInstance[] = [];
const browser = await chromium.launch({ headless: true });
const A = runtime.clients.find((client) => client.code === 'aio-foundation')!.baseUrl;
const B = runtime.clients.find((client) => client.code === 'aio-probe')!.baseUrl;
const admin = await browser.newContext();
const userContext = await browser.newContext();
const adminPage = await admin.newPage();
const userPage = await userContext.newPage();
const failedHttp: { path: string; status: number }[] = [];
for (const page of [adminPage, userPage])
  page.on('response', (response) => {
    const address = new URL(response.url());
    if ([A, B].includes(address.origin) && response.status() >= 400)
      failedHttp.push({ path: address.pathname, status: response.status() });
  });
const runId = randomUUID();
const user = {
  username: 'demo.link-' + runId.slice(0, 8),
  password: randomBytes(32).toString('hex'),
  subject: '',
};
const displayName = 'Nhân sự liên kết ' + runId.slice(0, 8);
let stage = 'startup';
let accountId = '';
let personId = '';
let csrf = '';
let employmentId = '';
const measurements: Record<string, number> = {};
async function reserveUiRequests(base = A) {
  const deadline = Date.now() + 65_000;
  for (;;) {
    const response = await admin.request.get(base + '/health/ready');
    assert.ok([200, 429].includes(response.status()));
    const remaining = Number(response.headers()['x-ratelimit-remaining']);
    if (response.status() === 200 && Number.isFinite(remaining) && remaining >= 60) return;
    const seconds = Number(
      response.headers()['retry-after'] ?? response.headers()['x-ratelimit-reset'],
    );
    assert.ok(Number.isFinite(seconds) && seconds >= 0 && seconds <= 60);
    assert.ok(Date.now() + seconds * 1000 + 150 <= deadline);
    measurements.honoredRateLimitWindowWaits = (measurements.honoredRateLimitWindowWaits ?? 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 150));
  }
}
async function password(page: Page, username: string, value: string) {
  if (await page.locator('#username').isVisible()) await page.locator('#username').fill(username);
  else assert.ok((await page.locator('#kc-attempted-username').inputValue()) === username);
  await page.locator('#password').fill(value);
  await page.locator('#kc-login').click();
}
async function signInUser(force = false, base = A) {
  await reserveUiRequests(base);
  await userPage.goto(base + '/auth/login' + (force ? '?reauth=1' : ''));
  if (await userPage.locator('#password').isVisible())
    await password(userPage, user.username, user.password);
  await userPage.waitForURL((url) => url.origin === base, { timeout: 15000 });
}
async function freshProof() {
  await reserveUiRequests();
  await userPage.goto(A + '/auth/identity-proof');
  await password(userPage, user.username, user.password);
  await userPage.waitForURL(A + '/#identity-proof', { timeout: 15000 });
  await userPage.getByText('Xác minh tài khoản SSO', { exact: true }).waitFor();
  const response = await userContext.request.get(A + '/api/v1/identity-proof');
  assert.equal(response.status(), 200);
  const value = await response.json();
  assert.ok(typeof value.code === 'string' && value.code.length === 43);
  assert.equal(value.subject, user.subject);
  assert.equal(
    await userPage.locator('#identity-verification-code').getAttribute('type'),
    'password',
  );
  return value as { code: string; subject: string; issuer: string };
}
async function nav(name: string) {
  await reserveUiRequests();
  await adminPage.setViewportSize({ width: 1440, height: 1000 });
  await adminPage
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function select(field: string, choice: string | RegExp) {
  await adminPage
    .getByRole('dialog')
    .locator('#field-' + field)
    .click();
  await adminPage.getByRole('option', { name: choice, exact: typeof choice === 'string' }).click();
}
async function saveForm() {
  const dialog = adminPage.getByRole('dialog');
  await dialog.locator('#change-reason').fill('Kiểm thử vòng đời nhân sự qua giao diện');
  await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await adminPage.waitForFunction(
    () =>
      !!document.querySelector('[role="alertdialog"]') ||
      !document.querySelector('[role="dialog"]'),
  );
  const confirmation = adminPage.getByRole('alertdialog', {
    name: 'Xác nhận thay đổi quyền truy cập',
  });
  if (await confirmation.isVisible())
    await confirmation.getByRole('button', { name: 'Xác nhận lưu', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function targetUi() {
  await nav('Định danh & vòng đời');
  await adminPage.getByRole('combobox', { name: 'Tài khoản đích', exact: true }).click();
  await adminPage.getByRole('option', { name: new RegExp(displayName) }).click();
  await adminPage.getByRole('listbox').waitFor({ state: 'hidden' });
}
async function confirmAction(button: string) {
  await adminPage
    .locator('#identity-reason')
    .fill('Kiểm thử ' + button.toLowerCase() + ' cho dữ liệu giả lập');
  await adminPage
    .getByRole('button', {
      name: button === 'Thu hồi liên kết' ? button + ' ' + user.subject : button,
      exact: true,
    })
    .click();
  const confirm = adminPage.getByRole('alertdialog');
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Xác nhận thay đổi', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await adminPage
    .getByRole('status')
    .getByText('Đã cập nhật và ghi nhận lịch sử.', { exact: true })
    .waitFor();
}
async function adminWrite(
  path: string,
  data: unknown,
  method: 'post' | 'patch' = 'post',
  idempotency = randomUUID(),
) {
  const options = {
    headers: { origin: A, 'x-csrf-token': csrf, 'idempotency-key': idempotency },
    data,
  };
  let response = await admin.request[method](A + path, options);
  if (response.status() === 429) {
    const seconds = Number(response.headers()['retry-after']);
    assert.ok(Number.isFinite(seconds) && seconds >= 0 && seconds <= 60);
    measurements.honoredRateLimitRetries = (measurements.honoredRateLimitRetries ?? 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 150));
    response = await admin.request[method](A + path, options);
  }
  return response;
}
async function account() {
  return (await pool.query('SELECT * FROM accounts WHERE id=$1', [accountId])).rows[0];
}
async function waitFreshBoundary() {
  const boundary = Number((await account()).auth_not_before);
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, (boundary + 1) * 1000 - Date.now() + 100)),
  );
}
async function tokensFor(context: BrowserContext, appCode: string) {
  const cookie = (await context.cookies()).find(
    (cookie) => cookie.name === 'aio_session_' + appCode,
  );
  assert.ok(cookie);
  const row = (
    await pool.query('SELECT encrypted_payload FROM sessions WHERE hash=$1 AND app_code=$2', [
      hashToken(cookie.value),
      appCode,
    ])
  ).rows[0];
  assert.ok(row);
  return unseal<LoginTokens>(row.encrypted_payload, runtime.encryptionKey, 'session:' + appCode);
}
try {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
  for (const client of bffClients(runtime)) {
    const server = await createApp({ runtime: testRuntime, client, test: true, logger: false });
    server.addHook('onResponse', async (_req, reply) => {
      if (reply.statusCode === 429)
        measurements.rateLimitResponses = (measurements.rateLimitResponses ?? 0) + 1;
    });
    await server.listen({ host: '127.0.0.1', port: client.port });
    servers.push(server);
  }
  const keycloak = await localKeycloakAdmin(runtime);
  await mkdir('.local/identity-fixtures', { recursive: true });
  const fixturePath = '.local/identity-fixtures/' + runId + '.json';
  await writeFile(fixturePath, JSON.stringify(user) + '\n', { flag: 'wx', mode: 0o600 });
  const created = await keycloak('/users', 'POST', {
    username: user.username,
    enabled: true,
    firstName: 'Synthetic',
    lastName: 'Identity',
    email: user.username + '@example.test',
    emailVerified: true,
    credentials: [{ type: 'password', value: user.password, temporary: false }],
  });
  user.subject = created.headers.get('location')?.split('/').pop() ?? '';
  assert.ok(/^[0-9a-f-]{36}$/.test(user.subject));
  await writeFile(fixturePath, JSON.stringify(user) + '\n', { mode: 0o600 });
  stage = 'unlinked identity proof';
  await signInUser();
  await userPage.locator('[data-auth-error="ACCOUNT_UNAVAILABLE"]').waitFor();
  assert.equal((await userContext.request.get(A + '/api/v1/me')).status(), 401);
  const initialProof = await freshProof();
  assert.equal((await userContext.request.get(A + '/api/v1/me')).status(), 401);
  stage = 'administrator MFA';
  const adminUser = runtime.users.find((user) => user.id === ids.admin)!;
  await adminPage.goto(A + '/auth/login');
  await password(adminPage, adminUser.username, adminUser.password);
  await adminPage.locator('#otp').fill(await nextFixtureOtp(ids.admin));
  await adminPage.locator('#kc-login').click();
  await adminPage.waitForURL(A + '/', { timeout: 15000 });
  const me = await admin.request.get(A + '/api/v1/me');
  assert.equal(me.status(), 200);
  csrf = (await me.json()).csrfToken;
  await adminPage.locator('[data-code="AUTHENTICATED"]').waitFor();
  stage = 'create person and account UI';
  await nav('Nhân sự & tài khoản');
  const directoryStart = Date.now();
  await expect(
    adminPage.getByRole('heading', { name: 'Danh bạ nhân sự', exact: true }),
  ).toBeVisible({ timeout: 45000 });
  measurements.personnelDirectoryMs = Date.now() - directoryStart;
  await adminPage.getByRole('button', { name: 'Thêm hồ sơ', exact: true }).click();
  await adminPage.getByRole('dialog').locator('#field-displayName').fill(displayName);
  const personResponse = adminPage.waitForResponse(
    (response) =>
      response.url() === A + '/api/v1/manage/people' && response.request().method() === 'POST',
  );
  await saveForm();
  const createdResponse = await personResponse;
  assert.equal(createdResponse.status(), 200);
  const createdPerson = await createdResponse.json();
  assert.equal(createdPerson.displayName, displayName);
  assert.match(createdPerson.id, /^[a-f0-9-]{36}$/);
  personId = createdPerson.id;
  await expect(adminPage.getByRole('dialog')).toBeHidden();
  await expect(adminPage.getByRole('status', { name: 'Đang tải cơ cấu và nhân sự' })).toBeHidden({
    timeout: 45000,
  });
  const search = adminPage.getByRole('textbox', { name: 'Tìm nhân sự', exact: true });
  await search.fill(displayName, { timeout: 45000 });
  const profile = adminPage.getByRole('button', { name: 'Xem hồ sơ ' + displayName, exact: true });
  await expect(profile).toBeVisible({ timeout: 45000 });
  await profile.click();
  await adminPage
    .getByRole('region', { name: 'Tài khoản của nhân sự' })
    .getByRole('button', { name: 'Thêm tài khoản', exact: true })
    .click();
  await expect(adminPage.locator('#field-personId')).toContainText(displayName);
  const accountResponse = adminPage.waitForResponse(
    (response) =>
      response.url() === A + '/api/v1/manage/accounts' && response.request().method() === 'POST',
  );
  await saveForm();
  const linkedAccount = await accountResponse;
  assert.equal(linkedAccount.status(), 200);
  const savedAccount = await linkedAccount.json();
  assert.equal(savedAccount.personId, personId);
  assert.match(savedAccount.id, /^[a-f0-9-]{36}$/);
  accountId = savedAccount.id;
  stage = 'link authorization and explicit subject checks';
  const input = { tenantId: ids.tenantA, accountId, proofCode: initialProof.code };
  assert.equal(
    (await admin.request.post(A + '/api/v1/manage/identities/preview', { data: input })).status(),
    403,
  );
  assert.equal(
    (
      await adminWrite('/api/v1/manage/identities/preview', { ...input, tenantId: ids.tenantB })
    ).status(),
    403,
  );
  assert.equal(
    (
      await adminWrite('/api/v1/manage/identities/link', {
        ...input,
        reason: 'Reject incorrect subject',
        expectedSubject: 'incorrect-subject',
        expectedAccountRevision: 1,
      })
    ).status(),
    409,
  );
  stage = 'identity linking confirmation UI';
  await targetUi();
  await adminPage.locator('#identity-proof-input').fill(initialProof.code);
  await adminPage.getByRole('button', { name: 'Kiểm tra mã xác minh', exact: true }).click();
  const linkButton = adminPage.getByRole('button', { name: 'Liên kết định danh', exact: true });
  await linkButton.waitFor();
  await linkButton.click();
  await adminPage.getByText('Nhập lý do thay đổi, tối thiểu 5 ký tự.', { exact: true }).waitFor();
  await adminPage
    .locator('#identity-reason')
    .fill('Đã đối chiếu tài khoản SSO và hồ sơ nhân sự giả lập');
  await linkButton.click();
  const confirmation = adminPage.getByRole('alertdialog');
  await confirmation.waitFor();
  for (let i = 0; i < 8; i++) {
    await adminPage.keyboard.press('Tab');
    assert.equal(
      await confirmation.evaluate((element) => element.contains(document.activeElement)),
      true,
    );
  }
  await confirmation.getByRole('button', { name: 'Hủy', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  assert.equal(await linkButton.evaluate((element) => element === document.activeElement), true);
  await linkButton.click();
  await confirmation.waitFor();
  await mkdir('.local/evidence', { recursive: true });
  // Only the administrator confirmation is captured; proof fields remain masked and IdP pages are never captured.
  await adminPage.screenshot({
    path: '.local/evidence/identity-link-confirmation.png',
    animations: 'disabled',
    fullPage: true,
  });
  await confirmation.getByRole('button', { name: 'Xác nhận thay đổi', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  await adminPage.getByRole('status').waitFor();
  assert.equal(
    (
      await pool.query(
        'SELECT account_id FROM external_identities WHERE issuer=$1 AND subject=$2',
        [runtime.issuer, user.subject],
      )
    ).rows[0].account_id,
    accountId,
  );
  assert.equal(
    (
      await adminWrite('/api/v1/manage/identities/link', {
        ...input,
        reason: 'Reject proof replay',
        expectedSubject: user.subject,
        expectedAccountRevision: (await account()).revision,
      })
    ).status(),
    400,
  );
  await signInUser();
  await userPage.locator('[data-auth-error="APPLICATION_ACCESS_DENIED"]').waitFor();
  stage = 'grant and role UI';
  await nav('Vai trò & truy cập');
  for (const appName of ['AIO Foundation', 'SSO client B']) {
    await adminPage.getByRole('combobox', { name: 'Chọn ứng dụng quản trị', exact: true }).click();
    await adminPage.getByRole('option', { name: appName, exact: true }).click();
    await adminPage.getByRole('tab', { name: 'Cấp truy cập ứng dụng', exact: true }).click();
    await adminPage.getByRole('button', { name: 'Thêm quyền truy cập', exact: true }).click();
    await select('accountId', displayName);
    await saveForm();
  }
  await adminPage.getByRole('combobox', { name: 'Chọn ứng dụng quản trị', exact: true }).click();
  await adminPage.getByRole('option', { name: 'AIO Foundation', exact: true }).click();
  await adminPage.getByRole('tab', { name: 'Gán vai trò', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Thêm phân công vai trò', exact: true }).click();
  await select('accountId', displayName);
  await select('roleCode', 'Đọc danh mục');
  await saveForm();
  stage = 'employment and concurrent assignment UI';
  await nav('Nhân sự & tài khoản');
  await adminPage.getByRole('tab', { name: 'Quan hệ công tác', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Thêm quan hệ công tác', exact: true }).click();
  await select('personId', displayName);
  await select('legalEntityId', 'Pháp nhân giả lập A');
  const employeeCode = 'LINK-' + runId.slice(0, 8);
  await adminPage.getByRole('dialog').locator('#field-employeeCode').fill(employeeCode);
  const date = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 16);
  await adminPage.getByRole('dialog').locator('#field-validFrom').fill(date(-30));
  await saveForm();
  employmentId = (await pool.query('SELECT id FROM employments WHERE person_id=$1', [personId]))
    .rows[0].id;
  await adminPage.getByRole('tab', { name: 'Bổ nhiệm / kiêm nhiệm', exact: true }).click();
  for (const [unit, primary, days] of [
    ['Đào tạo', true, -20],
    ['Chuyển đổi số', false, -10],
  ] as const) {
    await adminPage.getByRole('button', { name: 'Thêm bổ nhiệm', exact: true }).click();
    await select('legalEntityId', 'Pháp nhân giả lập A');
    await select('employmentId', new RegExp(employeeCode));
    await select('positionId', 'Vị trí thử nghiệm · ' + unit);
    if (primary)
      await adminPage
        .getByRole('dialog')
        .getByRole('checkbox', { name: 'Vị trí chính', exact: true })
        .check();
    await adminPage.getByRole('dialog').locator('#field-validFrom').fill(date(days));
    await saveForm();
  }
  const assignments = (
    await pool.query('SELECT * FROM assignments WHERE employment_id=$1 ORDER BY is_primary DESC', [
      employmentId,
    ])
  ).rows;
  assert.equal(assignments.length, 2);
  assert.equal(assignments.filter((row) => row.is_primary).length, 1);
  const badAssignment = {
    tenantId: ids.tenantA,
    reason: 'Reject overlapping primary assignment',
    data: {
      legalEntityId: ids.legalA,
      employmentId,
      positionId: assignments[0].position_id,
      isPrimary: true,
      validFrom: new Date(Date.now() - 86400_000).toISOString(),
    },
  };
  assert.equal((await adminWrite('/api/v1/manage/assignments', badAssignment)).status(), 409);
  assert.equal(
    (
      await adminWrite('/api/v1/manage/assignments', {
        ...badAssignment,
        data: { ...badAssignment.data, legalEntityId: ids.legalB },
      })
    ).status(),
    400,
  );
  await signInUser(true);
  assert.equal((await userContext.request.get(A + '/api/v1/me')).status(), 200);
  const linkedMe = await (await userContext.request.get(A + '/api/v1/me')).json();
  assert.equal(linkedMe.assignments.length, 2);
  await userPage.goto(B + '/auth/login');
  await userPage.waitForURL(B + '/', { timeout: 15000 });
  assert.equal((await userContext.request.get(B + '/api/v1/me')).status(), 200);
  assert.equal(
    (
      await userContext.request.get(A + '/api/v1/manage/identity-targets?tenantId=' + ids.tenantA)
    ).status(),
    403,
  );
  const oldTokens = await tokensFor(userContext, 'aio-foundation');
  stage = 'disable and reactivate without reviving old sessions';
  await targetUi();
  await adminPage.locator('#identity-reason').fill('Tạm khóa tài khoản giả lập');
  await adminPage.getByRole('button', { name: 'Khóa tài khoản', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Hủy', exact: true }).click();
  assert.equal((await userContext.request.get(A + '/api/v1/me')).status(), 200);
  const disabledStart = Date.now();
  await confirmAction('Khóa tài khoản');
  for (const base of [A, B])
    assert.equal((await userContext.request.get(base + '/api/v1/me')).status(), 401);
  measurements.disableSessionsMs = Date.now() - disabledStart;
  await confirmAction('Mở lại tài khoản');
  assert.equal((await userContext.request.get(A + '/api/v1/me')).status(), 401);
  const oldBearer = await userContext.request.get(A + '/api/v1/me', {
    headers: { authorization: 'Bearer ' + oldTokens.accessToken },
  });
  assert.equal(oldBearer.status(), 403);
  assert.equal((await oldBearer.json()).error, 'REAUTHENTICATION_REQUIRED');
  const oidc = await OidcClient.create(
    runtime,
    runtime.clients.find((client) => client.code === 'aio-foundation')!,
  );
  const renewedOld = await oidc.refresh(oldTokens);
  assert.equal(
    (
      await userContext.request.get(A + '/api/v1/me', {
        headers: { authorization: 'Bearer ' + renewedOld.accessToken },
      })
    ).status(),
    403,
  );
  await waitFreshBoundary();
  await signInUser(true);
  assert.equal((await userContext.request.get(A + '/api/v1/me')).status(), 200);
  stage = 'revoke and reverify identity with immutable ownership';
  await confirmAction('Thu hồi liên kết');
  assert.equal((await userContext.request.get(A + '/api/v1/me')).status(), 401);
  await waitFreshBoundary();
  const nextProof = await freshProof();
  await adminPage.locator('#identity-proof-input').fill(nextProof.code);
  await adminPage.getByRole('button', { name: 'Kiểm tra mã xác minh', exact: true }).click();
  await linkButton.waitFor();
  await confirmAction('Liên kết định danh');
  await signInUser(true);
  assert.equal((await userContext.request.get(A + '/api/v1/me')).status(), 200);
  stage = 'end assignments and employment while preserving history';
  await nav('Nhân sự & tài khoản');
  await adminPage.getByRole('tab', { name: 'Bổ nhiệm / kiêm nhiệm', exact: true }).click();
  for (const assignment of assignments) {
    stage = 'end assignment via UI';
    await adminPage.getByRole('textbox', { name: 'Tìm kiếm trong danh sách' }).fill(assignment.id);
    await adminPage.getByRole('button', { name: 'Sửa ' + assignment.id, exact: true }).click();
    await adminPage.getByRole('dialog').locator('#field-validUntil').fill(date(-1));
    await saveForm();
  }
  await adminPage.getByRole('tab', { name: 'Quan hệ công tác', exact: true }).click();
  stage = 'end employment via UI';
  await adminPage.getByRole('textbox', { name: 'Tìm kiếm trong danh sách' }).fill(employeeCode);
  await adminPage.getByRole('button', { name: 'Sửa ' + displayName, exact: true }).click();
  await adminPage.getByRole('dialog').locator('#field-validUntil').fill(date(0));
  await saveForm();
  const history = (
    await pool.query('SELECT valid_until FROM assignments WHERE employment_id=$1', [employmentId])
  ).rows;
  assert.equal(history.length, 2);
  assert.ok(history.every((row) => row.valid_until));
  assert.equal(
    (await (await userContext.request.get(A + '/api/v1/me')).json()).assignments.length,
    0,
  );
  stage = 'offboarding confirmation and no implicit regrant';
  await userPage.goto(B + '/auth/login');
  await userPage.waitForURL(B + '/', { timeout: 15000 });
  await targetUi();
  await confirmAction('Khóa và thu hồi toàn bộ quyền');
  for (const base of [A, B])
    assert.equal((await userContext.request.get(base + '/api/v1/me')).status(), 401);
  await adminPage.screenshot({
    path: '.local/evidence/identity-offboarded-desktop.png',
    fullPage: true,
  });
  await adminPage.setViewportSize({ width: 390, height: 844 });
  assert.ok(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await adminPage.screenshot({
    path: '.local/evidence/identity-offboarded-mobile.png',
    fullPage: true,
  });
  await confirmAction('Mở lại tài khoản');
  await waitFreshBoundary();
  await signInUser(true);
  await userPage.locator('[data-auth-error="APPLICATION_ACCESS_DENIED"]').waitFor();
  assert.equal(
    (
      await pool.query('SELECT 1 FROM application_grants WHERE account_id=$1 AND active', [
        accountId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM role_bindings WHERE account_id=$1 AND active', [accountId]))
      .rowCount,
    0,
  );
  const audit = (
    await pool.query('SELECT action,details FROM audit_events WHERE subject_account_id=$1', [
      accountId,
    ])
  ).rows;
  for (const action of ['identity.linked', 'identity.revoked', 'account.offboarded'])
    assert.ok(audit.some((row) => row.action === action));
  assert.ok(!JSON.stringify(audit).includes(initialProof.code));
  assert.ok(!JSON.stringify(audit).includes(user.password));
  assert.ok(measurements.disableSessionsMs! < 60_000);
  await writeFile(
    '.local/evidence/identity-lifecycle.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        environment: 'aio_foundation_test',
        measurements,
        checks: [
          'fresh OIDC proof with explicit administrator subject confirmation',
          'person/account/grant/binding/employment/assignments created through shadcn UI',
          'proof replay/cross-tenant/CSRF rejected',
          'account disable revokes A/B sessions',
          'reactivation rejects old access token and refreshed old authentication',
          'identity revocation/reverification preserves immutable ownership',
          'employment history retained',
          'offboarding revokes grants/bindings and reopening does not restore them',
          'confirmation keyboard focus and 1440/390 layouts',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: verified identity linking and lifecycle, UI personnel/grants/bindings/assignments, immutable ownership, session revocation and offboarding with audit.',
  );
} catch (error) {
  if (error instanceof Error)
    console.error(
      error.stack?.match(/identity-e2e\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable',
    );
  console.error(
    'Identity E2E request limits: ' +
      JSON.stringify({
        rateLimitResponses: measurements.rateLimitResponses ?? 0,
        honoredRetries: measurements.honoredRateLimitRetries ?? 0,
      }),
  );
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error(
      'Identity E2E numeric assertion: actual=' + error.actual + ' expected=' + error.expected,
    );
  console.error(
    'Identity E2E failed at: ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      ') ' +
      (error instanceof Error ? (error.stack?.match(/identity-e2e\.ts:\d+:\d+/)?.[0] ?? '') : '') +
      '. Secrets and browser URLs omitted.',
  );
  console.error('Identity HTTP diagnostics: ' + JSON.stringify(failedHttp.slice(-12)));
  if (
    stage === 'create person and account UI' &&
    new URL(adminPage.url()).origin === A &&
    !(await adminPage.locator('input[type=password],#otp').count())
  ) {
    console.error(
      'Identity directory state: ' +
        JSON.stringify({
          loading: await adminPage
            .getByRole('status', { name: 'Đang tải cơ cấu và nhân sự' })
            .count(),
          directory: await adminPage
            .getByRole('heading', { name: 'Danh bạ nhân sự', exact: true })
            .count(),
          create: await adminPage.getByRole('button', { name: 'Thêm hồ sơ', exact: true }).count(),
        }),
    );
    await adminPage.screenshot({ path: '.local/evidence/identity-directory-failure.png' });
  }
  process.exitCode = 1;
} finally {
  if (accountId) {
    try {
      const current = await account();
      if (current.active) {
        const response = await adminWrite(
          '/api/v1/manage/accounts/' + accountId,
          {
            tenantId: ids.tenantA,
            reason: 'Close synthetic identity test account',
            expectedRevision: current.revision,
            data: { active: false },
          },
          'patch',
        );
        if (response.status() !== 200) throw new Error('Cleanup rejected');
      }
    } catch {
      console.error('Synthetic account cleanup needs review; no credentials logged.');
      process.exitCode = 1;
    }
  }
  if (user.subject)
    try {
      const admin = await localKeycloakAdmin(runtime);
      await admin('/users/' + user.subject, 'PUT', { enabled: false });
    } catch {
      console.error('Synthetic IdP cleanup needs review.');
      process.exitCode = 1;
    }
  await browser.close();
  await Promise.all(servers.map((server) => server.close()));
  await pool.end();
}
