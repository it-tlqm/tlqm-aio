import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { ids } from '../src/fixtures.js';
import { unseal } from '../src/security.js';
import type { LoginTokens } from '../src/oidc.js';
import { hashToken } from '../src/security.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { mkdir } from 'node:fs/promises';

const runtime = await loadLocalConfig();
const testRuntime = { ...runtime, databaseUrl: testDatabaseUrl(runtime) };
const pool = new pg.Pool({ connectionString: testRuntime.databaseUrl, max: 2 });
const servers: FastifyInstance[] = [];
const browser = await chromium.launch({ headless: true });
let stage = 'startup';
const A = 'http://127.0.0.1:4100',
  B = 'http://127.0.0.1:4101';
const context = () => browser.newContext();
async function login(ctx: BrowserContext, username: string, base = A): Promise<Page> {
  const page = await ctx.newPage();
  const user = runtime.users.find((value) => value.username === username);
  assert.ok(user);
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
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
try {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
  for (const client of runtime.clients) {
    const server = await createApp({ runtime: testRuntime, client, test: true, logger: false });
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
  await page.goto(A + '/');
  await page.locator('[data-code="AUTHENTICATED"]').waitFor();
  await mkdir('.local/evidence', { recursive: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: '.local/evidence/foundation-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.local/evidence/foundation-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
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
  assert.equal(
    (await learner.request.post(A + '/api/v1/access/grants/revoke', { data: change })).status(),
    403,
  );
  assert.equal(
    (
      await learner.request.post(A + '/api/v1/access/grants/revoke', {
        headers: { origin: A, 'x-csrf-token': first.csrfToken },
        data: change,
      })
    ).status(),
    403,
  );
  const admin = await context();
  await login(admin, 'demo.admin');
  const adminMe = await getMe(admin);
  const adminHeaders = { origin: A, 'x-csrf-token': adminMe.csrfToken };
  stage = 'immediate revocation';
  const started = Date.now();
  try {
    assert.equal(
      (
        await admin.request.post(A + '/api/v1/access/grants/revoke', {
          headers: adminHeaders,
          data: change,
        })
      ).status(),
      200,
    );
    assert.equal((await learner.request.get(B + '/api/v1/me')).status(), 403);
    assert.ok(Date.now() - started < 60_000);
    assert.equal((await learner.request.get(A + '/api/v1/me')).status(), 200);
    const audit = await admin.request.get(A + '/api/v1/audit?tenantId=' + ids.tenantA);
    assert.equal(audit.status(), 200);
    assert.ok(
      (await audit.json()).items.some(
        (event: { action: string }) => event.action === 'access.revoked',
      ),
    );
  } finally {
    await admin.request.post(A + '/api/v1/access/grants', { headers: adminHeaders, data: change });
  }
  stage = 'input and cross-tenant administration';
  assert.equal(
    (
      await admin.request.post(A + '/api/v1/access/grants', {
        headers: adminHeaders,
        data: { ...change, role: 'super-admin' },
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await admin.request.post(A + '/api/v1/access/grants', {
        headers: adminHeaders,
        data: { ...change, tenantId: ids.tenantB, accountId: ids.other },
      })
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
    const body = JSON.parse(await deniedPage.locator('body').innerText());
    assert.equal(body.error, expected);
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
  stage = 'global logout';
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
  await page.goto(A + '/auth/login');
  await page.locator('#username').waitFor({ timeout: 15000 });
  console.log(
    'PASS: OIDC login, two-client SSO, tenant/audience isolation, CSRF, grant/revoke, audit, disabled/no-grant users, IdP disable, callback rejection, local/global and back-channel logout.',
  );
} catch (error) {
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
