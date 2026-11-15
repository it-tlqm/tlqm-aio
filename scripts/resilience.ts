import { bffClients } from '../src/config.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { decodeProtectedHeader } from 'jose';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { OidcClient } from '../src/oidc.js';
import type { LoginTokens } from '../src/oidc.js';
import { ids } from '../src/fixtures.js';
import { hashToken, unseal } from '../src/security.js';
import { nextFixtureOtp } from './local-totp.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { localContainer, stopLocalService, startLocalService } from './local-docker.js';

const runtime = await loadLocalConfig();
const testRuntime = { ...runtime, databaseUrl: testDatabaseUrl(runtime) };
const pool = new pg.Pool({
  connectionString: testRuntime.databaseUrl,
  max: 3,
  connectionTimeoutMillis: 1500,
});
pool.on('error', () => {});
const servers: FastifyInstance[] = [];
const browser = await chromium.launch({ headless: true });
const A = runtime.clients.find((c) => c.code === 'aio-foundation')!;
const B = runtime.clients.find((c) => c.code === 'aio-probe')!;
const C = runtime.clients.find((c) => c.kind === 'integration-probe')!;
const receivedLogout = new Map<string, string>();
const measurements: Record<string, number> = {};
let stage = 'preflight';
let dbStopped = false;
let idpStopped = false;
let rotationId = '';
let rotationChanged = false;
let originalSigningKid = '';
let realmId = '';
const rotationName =
  'aio-local-rotation-' + runtime.instanceId.slice(0, 8) + '-' + randomUUID().slice(0, 8);
const keyConfig = (active: boolean, priority: number) => ({
  priority: [String(priority)],
  enabled: ['true'],
  active: [String(active)],
  algorithm: ['RS256'],
  keySize: ['2048'],
});
async function waitFor(check: () => Promise<boolean>, description: string, maxMs = 90_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Local dependency did not recover: ' + description);
}
async function neutralContext() {
  const context = await browser.newContext();
  await context.route(
    (url) =>
      runtime.clients.some((c) => new URL(c.baseUrl).origin === url.origin) && url.pathname === '/',
    (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>Isolated resilience rehearsal</p>' }),
  );
  return context;
}
async function login(context: BrowserContext, username: string, base = A.baseUrl) {
  const user = runtime.users.find((u) => u.username === username)!;
  const page = await context.newPage();
  await page.goto(base + '/auth/login?reauth=1');
  if (await page.locator('#username').isVisible())
    await page.locator('#username').fill(user.username);
  else assert.ok((await page.locator('#kc-attempted-username').inputValue()) === user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (username === 'demo.admin') {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === base, { timeout: 15000 });
  if (new URL(page.url()).pathname !== '/') {
    const response = await page.locator('body').innerText();
    try {
      const code = JSON.parse(response).error;
      if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code))
        console.error('Resilience login response: ' + code);
    } catch {}
    throw new Error('Local callback did not complete.');
  }
  const response = await context.request.get(base + '/api/v1/me');
  assert.equal(response.status(), 200);
  return page;
}
async function session(context: BrowserContext, code: string) {
  const cookie = (await context.cookies()).find((c) => c.name === 'aio_session_' + code)!;
  assert.ok(cookie);
  const hash = hashToken(cookie.value);
  const row = (await pool.query('SELECT encrypted_payload FROM sessions WHERE hash=$1', [hash]))
    .rows[0];
  assert.ok(row);
  return {
    hash,
    tokens: unseal<LoginTokens>(row.encrypted_payload, runtime.encryptionKey, 'session:' + code),
  };
}
async function dependencyResponse(context: BrowserContext, url: string, code: string) {
  const response = await context.request.get(url);
  assert.equal(response.status(), 503);
  assert.equal((await response.json()).error, code);
}
type Keys = {
  active: Record<string, string>;
  keys: {
    kid: string;
    providerId: string;
    providerPriority: number;
    algorithm: string;
    status: string;
  }[];
};
try {
  assert.ok(C);
  for (const service of ['keycloak', 'foundation-db', 'identity-db'] as const)
    assert.equal((await localContainer(service)).running, true);
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
  const migrationsBefore = (
    await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
  ).rows;
  for (const client of bffClients(runtime)) {
    const app = await createApp({ runtime: testRuntime, client, test: true, logger: false });
    app.addHook('preHandler', async (request) => {
      if (
        request.url === '/auth/backchannel-logout' &&
        typeof (request.body as { logout_token?: unknown })?.logout_token === 'string'
      )
        receivedLogout.set(client.code, (request.body as { logout_token: string }).logout_token);
    });
    await app.listen({ host: '127.0.0.1', port: client.port });
    servers.push(app);
  }
  const admin = await neutralContext();
  const learner = await neutralContext();
  await login(admin, 'demo.admin');
  let learnerPage = await login(learner, 'demo.learner');
  const adminMe = await (await admin.request.get(A.baseUrl + '/api/v1/me')).json();
  const adminHeaders = { origin: A.baseUrl, 'x-csrf-token': adminMe.csrfToken };
  for (const client of [B, C]) {
    await learnerPage.goto(client.baseUrl + '/auth/login');
    await learnerPage.waitForURL(client.baseUrl + '/', { timeout: 15000 });
  }
  stage = 'signed back-channel logout and replay';
  let kc = await localKeycloakAdmin(runtime);
  const logoutStart = Date.now();
  await kc('/users/' + ids.learner + '/logout', 'POST');
  await waitFor(
    async () =>
      receivedLogout.has(A.code) && receivedLogout.has(B.code) && receivedLogout.has(C.code),
    'signed logout receipt',
    10_000,
  );
  for (const client of [A, B, C])
    assert.equal((await learner.request.get(client.baseUrl + '/api/v1/me')).status(), 401);
  measurements.backchannelRevocationMs = Date.now() - logoutStart;
  assert.ok(measurements.backchannelRevocationMs < 60_000);
  const logoutA = receivedLogout.get(A.code)!;
  const logoutAuditBefore = (
    await pool.query(
      "SELECT count(*)::int AS count FROM audit_events WHERE action='auth.backchannel_logout'",
    )
  ).rows[0].count;
  learnerPage = await login(learner, 'demo.learner');
  for (const client of [B, C]) {
    await learnerPage.goto(client.baseUrl + '/auth/login');
    await learnerPage.waitForURL(client.baseUrl + '/', { timeout: 15000 });
  }
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await learner.request.post(A.baseUrl + '/auth/backchannel-logout', {
          form: { logout_token: logoutA },
        })
      ).status(),
      204,
    );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE action='auth.backchannel_logout'",
      )
    ).rows[0].count,
    logoutAuditBefore,
  );
  for (const client of [A, B, C])
    assert.equal((await learner.request.get(client.baseUrl + '/api/v1/me')).status(), 200);
  assert.equal(
    (
      await learner.request.post(B.baseUrl + '/auth/backchannel-logout', {
        form: { logout_token: logoutA },
      })
    ).status(),
    401,
  );
  const parts = logoutA.split('.');
  parts[2] = (parts[2]![0] === 'A' ? 'B' : 'A') + parts[2]!.slice(1);
  assert.equal(
    (
      await learner.request.post(A.baseUrl + '/auth/backchannel-logout', {
        form: { logout_token: parts.join('.') },
      })
    ).status(),
    401,
  );
  stage = 'database outage';
  const titleCode = 'OUTAGE-' + randomUUID().slice(0, 8);
  const writeKey = randomUUID();
  const mutation = {
    tenantId: ids.tenantA,
    reason: 'Synthetic retry after database outage',
    data: { code: titleCode, name: 'Resilience fixture' },
  };
  const write = () =>
    admin.request.post(A.baseUrl + '/api/v1/manage/job-titles', {
      headers: { ...adminHeaders, 'idempotency-key': writeKey },
      data: mutation,
    });
  dbStopped = true;
  await stopLocalService('foundation-db');
  for (const client of [A, B, C]) {
    const live = await learner.request.get(client.baseUrl + '/health/live');
    assert.equal(live.status(), 200);
    assert.equal((await live.json()).service, client.code);
    await dependencyResponse(learner, client.baseUrl + '/health/ready', 'DATABASE_UNAVAILABLE');
    await dependencyResponse(learner, client.baseUrl + '/api/v1/me', 'DATABASE_UNAVAILABLE');
  }
  assert.equal((await write()).status(), 503);
  const dbRecoveryStart = Date.now();
  await startLocalService('foundation-db');
  await waitFor(async () => {
    const r = await learner.request.get(A.baseUrl + '/health/ready');
    return r.status() === 200;
  }, 'Foundation database');
  dbStopped = false;
  measurements.databaseRecoveryMs = Date.now() - dbRecoveryStart;
  assert.deepEqual(
    (await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows,
    migrationsBefore,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM job_titles WHERE code=$1', [titleCode])).rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM mutation_receipts WHERE idempotency_key=$1', [writeKey]))
      .rowCount,
    0,
  );
  const retry = await write();
  assert.equal(retry.status(), 200);
  const title = await retry.json();
  assert.equal((await write()).status(), 200);
  assert.equal(
    (await pool.query('SELECT 1 FROM job_titles WHERE code=$1', [titleCode])).rowCount,
    1,
  );
  const titleAudit = (
    await pool.query(
      "SELECT 1 FROM audit_events WHERE target_id=$1 AND action='job-titles.created'",
      [title.id],
    )
  ).rowCount;
  assert.equal(titleAudit, 1);
  assert.equal(
    (
      await admin.request.patch(A.baseUrl + '/api/v1/manage/job-titles/' + title.id, {
        headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
        data: {
          tenantId: ids.tenantA,
          reason: 'Archive synthetic resilience fixture',
          expectedRevision: title.revision,
          data: { active: false },
        },
      })
    ).status(),
    200,
  );
  for (const client of [A, B, C])
    assert.equal((await learner.request.get(client.baseUrl + '/api/v1/me')).status(), 200);
  stage = 'identity provider outage, including an uncached JWKS';
  const current = await session(learner, A.code);
  const cold = await OidcClient.create(runtime, A);
  idpStopped = true;
  await stopLocalService('keycloak');
  for (const client of [A, B, C])
    await dependencyResponse(learner, client.baseUrl + '/api/v1/me', 'IDENTITY_UNAVAILABLE');
  await assert.rejects(() => cold.access(current.tokens.accessToken), {
    statusCode: 503,
    code: 'IDENTITY_UNAVAILABLE',
  });
  assert.equal(
    (await pool.query('SELECT 1 FROM sessions WHERE hash=$1', [current.hash])).rowCount,
    1,
  );
  const idpRecoveryStart = Date.now();
  await startLocalService('keycloak');
  await waitFor(async () => {
    const r = await fetch(runtime.issuer + '/.well-known/openid-configuration', {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok && (await r.json()).issuer === runtime.issuer;
  }, 'Keycloak discovery');
  idpStopped = false;
  measurements.identityRecoveryMs = Date.now() - idpRecoveryStart;
  for (const client of [A, B, C])
    assert.equal((await learner.request.get(client.baseUrl + '/api/v1/me')).status(), 200);
  await cold.access(current.tokens.accessToken);
  stage = 'live signing key rotation';
  kc = await localKeycloakAdmin(runtime);
  const realm = (await (await kc('/')).json()) as { id: string; realm: string };
  assert.equal(realm.realm, 'aio-local');
  realmId = realm.id;
  let keys = (await (await kc('/keys')).json()) as Keys;
  await mkdir('.local/rotation-fixtures', { recursive: true });
  const receiptPath = '.local/rotation-fixtures/' + rotationName + '.json';
  // Generate a genuinely new key after the API verifiers have been warmed, not a previously cached fixture key.
  {
    const created = await kc('/components', 'POST', {
      name: rotationName,
      parentId: realmId,
      providerType: 'org.keycloak.keys.KeyProvider',
      providerId: 'rsa-generated',
      config: keyConfig(false, 0),
    });
    rotationId = created.headers.get('location')?.split('/').pop() ?? '';
    assert.ok(rotationId);
    await writeFile(
      receiptPath + '.next',
      JSON.stringify({
        instanceId: runtime.instanceId,
        realmId,
        componentId: rotationId,
        name: rotationName,
      }) + '\n',
      { mode: 0o600 },
    );
    await rename(receiptPath + '.next', receiptPath);
  }
  keys = (await (await kc('/keys')).json()) as Keys;
  originalSigningKid = keys.active.RS256!;
  assert.ok(originalSigningKid);
  const previous = await session(learner, A.code);
  assert.equal(decodeProtectedHeader(previous.tokens.accessToken).kid, originalSigningKid);
  const priority = Math.max(...keys.keys.map((key) => Number(key.providerPriority) || 0)) + 100;
  rotationChanged = true;
  await kc('/components/' + rotationId, 'PUT', {
    id: rotationId,
    name: rotationName,
    parentId: realmId,
    providerType: 'org.keycloak.keys.KeyProvider',
    providerId: 'rsa-generated',
    config: keyConfig(true, priority),
  });
  const switched = (await (await kc('/keys')).json()) as Keys;
  const nextKid = switched.active.RS256!;
  assert.ok(nextKid && nextKid !== originalSigningKid);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  stage = 'login with newly active signing key';
  const rotatedContext = await neutralContext();
  await login(rotatedContext, 'demo.learner');
  const rotated = await session(rotatedContext, A.code);
  assert.equal(decodeProtectedHeader(rotated.tokens.accessToken).kid, nextKid);
  assert.equal(
    (
      await learner.request.get(A.baseUrl + '/api/v1/me', {
        headers: { authorization: 'Bearer ' + previous.tokens.accessToken },
      })
    ).status(),
    200,
  );
  assert.equal((await rotatedContext.request.get(A.baseUrl + '/api/v1/me')).status(), 200);
  assert.equal(
    (
      await rotatedContext.request.get(B.baseUrl + '/api/v1/me', {
        headers: { authorization: 'Bearer ' + rotated.tokens.accessToken },
      })
    ).status(),
    401,
  );
  await kc('/components/' + rotationId, 'PUT', {
    id: rotationId,
    name: rotationName,
    parentId: realmId,
    providerType: 'org.keycloak.keys.KeyProvider',
    providerId: 'rsa-generated',
    config: keyConfig(false, 0),
  });
  rotationChanged = false;
  const restored = (await (await kc('/keys')).json()) as Keys;
  assert.equal(restored.active.RS256, originalSigningKid);
  assert.equal(
    (await rotatedContext.request.get(A.baseUrl + '/api/v1/me')).status(),
    200,
    'Passive public key must still verify tokens already issued.',
  );
  stage = 'MFA claims preserved on renewal';
  const adminSession = await session(admin, A.code);
  const oidc = await OidcClient.create(runtime, A);
  const refreshed = await oidc.refresh(adminSession.tokens);
  assert.ok(
    refreshed.authenticationMethods?.includes('pwd') &&
      refreshed.authenticationMethods.includes('otp'),
  );
  assert.equal(refreshed.authTime, adminSession.tokens.authTime);
  assert.equal(
    (
      await admin.request.get(A.baseUrl + '/api/v1/me', {
        headers: { authorization: 'Bearer ' + refreshed.accessToken },
      })
    ).status(),
    200,
  );
  await mkdir('.local/evidence', { recursive: true });
  await writeFile(
    '.local/evidence/resilience.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        environment: 'isolated tlqm-aio-local',
        testDatabase: 'aio_foundation_test',
        measurements,
        checks: [
          'real signed backchannel logout across A/B/C',
          'replay does not affect new sessions or duplicate audit',
          'wrong-client and tampered logout rejected',
          'database stop returns 503 while API stays live',
          'DB recovery preserves migration checksums and permits idempotent retry without ghost writes',
          'IdP stop denies warm and cold-JWKS authentication with 503',
          'IdP recovery retains existing sessions',
          'live RS256 signing key switch accepts old/new keys without restarting API',
          'rotation rollback retains new public key as passive',
          'MFA and auth_time remain verified after refresh',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: real IdP/DB outage and recovery, signed logout/replay, live key rotation/rollback and MFA renewal.',
  );
} catch (error) {
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error(
      'Resilience numeric assertion: actual=' + error.actual + ' expected=' + error.expected,
    );
  console.error(
    'Resilience rehearsal failed at: ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Secret output suppressed.',
  );
  process.exitCode = 1;
} finally {
  if (dbStopped)
    try {
      await startLocalService('foundation-db');
      await waitFor(async () => {
        const r = await pool.query('SELECT purpose FROM environment_marker');
        return r.rows[0]?.purpose === 'tlqm-aio-test';
      }, 'database cleanup');
    } catch {
      console.error('Local database restart requires review.');
      process.exitCode = 1;
    }
  if (idpStopped)
    try {
      await startLocalService('keycloak');
      await waitFor(async () => {
        const r = await fetch(runtime.issuer + '/.well-known/openid-configuration', {
          signal: AbortSignal.timeout(2000),
        });
        return r.ok;
      }, 'IdP cleanup');
    } catch {
      console.error('Local IdP restart requires review.');
      process.exitCode = 1;
    }
  if (rotationChanged && rotationId)
    try {
      const kc = await localKeycloakAdmin(runtime);
      await kc('/components/' + rotationId, 'PUT', {
        id: rotationId,
        name: rotationName,
        parentId: realmId,
        providerType: 'org.keycloak.keys.KeyProvider',
        providerId: 'rsa-generated',
        config: keyConfig(false, 0),
      });
    } catch {
      console.error('Owned rotation component rollback requires review.');
      process.exitCode = 1;
    }
  await browser.close();
  await Promise.all(servers.map((server) => server.close()));
  await pool.end();
}
