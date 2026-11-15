import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { localContainer, stopLocalService, startLocalService } from './local-docker.js';
import { hash } from '../src/lms/security.js';
const runtime = await loadLocalConfig(),
  L = 'http://127.0.0.1:4104',
  A = 'http://127.0.0.1:4100';
let worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const browser = await chromium.launch({ headless: true });
let stage = 'preflight',
  idpStopped = false,
  dbStopped = false;
const progress = setInterval(() => console.log('LMS resilience: ' + stage), 30000);
let lmsLogout = '',
  foundationLogout = ''; // Signed proof only in memory, never an artifact/log.
const checks: string[] = [];
const proxy = createServer(async (req, res) => {
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url === '/auth/backchannel-logout')
      lmsLogout = new URLSearchParams(body.toString()).get('logout_token') ?? '';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers))
      if (value && key !== 'accept-encoding' && key !== 'connection' && key !== 'content-length')
        headers[key] = Array.isArray(value) ? value.join(',') : value;
    const response = await worker!.mf.dispatchFetch('http://' + req.headers.host + req.url, {
      method: req.method ?? 'GET',
      headers,
      ...(body.length ? { body } : {}),
      redirect: 'manual',
    });
    res.statusCode = response.status;
    for (const [key, value] of response.headers)
      if (!['set-cookie', 'content-length', 'transfer-encoding', 'content-encoding'].includes(key))
        res.setHeader(key, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('set-cookie', cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res
      .writeHead(503, { 'content-type': 'application/json' })
      .end('{"error":"TEST_PROXY_UNAVAILABLE"}');
  }
});
async function waitFor(check: () => Promise<boolean>, timeout = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Dependency readiness timeout');
}
async function startFoundation() {
  app = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((c) => c.code === 'aio-foundation')!,
    test: true,
    logger: false,
  });
  app.addHook('preHandler', async (request) => {
    if (
      request.url === '/auth/backchannel-logout' &&
      typeof (request.body as { logout_token?: unknown })?.logout_token === 'string'
    )
      foundationLogout = (request.body as { logout_token: string }).logout_token;
  });
  await app.listen({ host: '127.0.0.1', port: 4100 });
}
async function login() {
  const context = await browser.newContext(),
    page = await context.newPage(),
    user = runtime.users.find((u) => u.id === ids.learner)!;
  await page.goto(A + '/auth/login?reauth=1');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === A && url.pathname === '/');
  await page.goto(L + '/auth/login');
  await page.waitForURL((url) => url.origin === L && url.pathname === '/');
  assert.equal((await context.request.get(L + '/api/learning')).status(), 200);
  return context;
}
async function row(context: BrowserContext) {
  const cookie = (await context.cookies(L)).find((c) => c.name === 'aio_lms_session');
  assert.ok(cookie);
  const key = await hash(cookie.value);
  const value = await worker!.db
    .prepare('SELECT idle_expires_at,absolute_expires_at,revision FROM aio_sessions WHERE hash=?')
    .bind(key)
    .first();
  assert.ok(value);
  return { key, value };
}
async function noRenewal(context: BrowserContext, old: Awaited<ReturnType<typeof row>>) {
  assert.equal((await context.request.get(L + '/api/learning')).status(), 503);
  assert.deepEqual((await row(context)).value, old.value);
}
try {
  for (const service of ['keycloak', 'foundation-db'] as const)
    assert.equal((await localContainer(service)).running, true);
  await startFoundation();
  worker = await startLocalLms(true, 0);
  await migrateLms(worker.db, worker.config);
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(4104, '127.0.0.1', resolve);
  });
  stage = 'real signed logout and replay';
  const first = await login();
  const kc = await localKeycloakAdmin(runtime);
  await kc(
    '/users/' +
      (runtime.users.find((u) => u.id === ids.learner)!.subject ?? ids.learner) +
      '/logout',
    'POST',
  );
  await waitFor(async () => Boolean(lmsLogout && foundationLogout), 10000);
  assert.equal((await first.request.get(L + '/api/learning')).status(), 401);
  const signed = lmsLogout;
  const count = async () =>
    (await worker!.db
      .prepare("SELECT count(*) AS n FROM aio_audit WHERE action='session.backchannel_logout'")
      .first<{ n: number }>())!.n;
  const before = await count(),
    second = await login();
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await second.request.post(L + '/auth/backchannel-logout', {
          form: { logout_token: signed },
        })
      ).status(),
      200,
    );
  assert.equal(await count(), before);
  assert.equal((await second.request.get(L + '/api/learning')).status(), 200);
  assert.equal(
    (
      await second.request.post(L + '/auth/backchannel-logout', {
        form: { logout_token: foundationLogout },
      })
    ).status(),
    401,
  );
  const parts = signed.split('.');
  parts[2] = (parts[2]![0] === 'A' ? 'B' : 'A') + parts[2]!.slice(1);
  assert.equal(
    (
      await second.request.post(L + '/auth/backchannel-logout', {
        form: { logout_token: parts.join('.') },
      })
    ).status(),
    401,
  );
  checks.push(
    'Real Keycloak signed LMS logout; replay produces no duplicate audit or new-session revocation; wrong-client/tampered rejected',
  );
  stage = 'Foundation HTTP outage';
  let old = await row(second);
  app!.server.closeAllConnections();
  await app!.close();
  app = undefined;
  await noRenewal(second, old);
  await startFoundation();
  assert.equal((await second.request.get(L + '/api/learning')).status(), 200);
  checks.push(
    'Foundation HTTP outage fails closed without extending LMS session; recovery rechecks access',
  );
  stage = 'real PostgreSQL outage';
  old = await row(second);
  await stopLocalService('foundation-db');
  dbStopped = true;
  await noRenewal(second, old);
  await startLocalService('foundation-db');
  await waitFor(async () => (await second.request.get(A + '/health/ready')).ok());
  dbStopped = false;
  assert.equal((await second.request.get(L + '/api/learning')).status(), 200);
  checks.push('Foundation PostgreSQL outage/recovery via guarded local Docker');
  stage = 'IdP outage warm and cold JWKS';
  old = await row(second);
  await stopLocalService('keycloak');
  idpStopped = true;
  await noRenewal(second, old);
  await worker.mf.dispose();
  worker = await startLocalLms(true, 0);
  await noRenewal(second, old);
  await startLocalService('keycloak');
  await waitFor(
    async () =>
      (
        await fetch(runtime.issuer + '/.well-known/openid-configuration', {
          signal: AbortSignal.timeout(2000),
        })
      ).ok,
  );
  idpStopped = false;
  assert.equal((await second.request.get(L + '/api/learning')).status(), 200);
  checks.push(
    'IdP outage warm/cold Worker denies access without session renewal; recovery succeeds',
  );
  stage = 'D1 unavailable and recovery';
  old = await row(second);
  await worker.db.prepare('ALTER TABLE environment_marker RENAME TO rehearsal_marker').run();
  try {
    await noRenewal(second, old);
  } finally {
    await worker.db.prepare('ALTER TABLE rehearsal_marker RENAME TO environment_marker').run();
  }
  assert.equal((await second.request.get(L + '/api/learning')).status(), 200);
  checks.push(
    'Missing D1 marker simulates unavailable datastore; no authorization until marker restored',
  );
  stage = 'idle expiration';
  const expiry = await row(second);
  await worker.db
    .prepare('UPDATE aio_sessions SET idle_expires_at=? WHERE hash=?')
    .bind(Date.now() - 1, expiry.key)
    .run();
  assert.equal((await second.request.get(L + '/api/learning')).status(), 401);
  assert.equal(
    await worker.db.prepare('SELECT 1 FROM aio_sessions WHERE hash=?').bind(expiry.key).first(),
    null,
  );
  checks.push('Expired session deleted and cannot renew');
  await writeFile(
    '.local/evidence/lms-resilience.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), result: 'pass', checks }, null, 2) + '\n',
  );
  console.log(
    'PASS: LMS signed logout/replay, Foundation/DB/IdP outages, cold Worker recovery, D1 marker guard and idle expiration.',
  );
} catch (error) {
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error('LMS resilience numeric assertion ' + error.actual + '/' + error.expected);
  console.error('LMS resilience failed at ' + stage + '. Sensitive details omitted.');
  process.exitCode = 1;
} finally {
  clearInterval(progress);
  if (dbStopped)
    await startLocalService('foundation-db').catch(() => {
      console.error('Local PostgreSQL restart requires review.');
      process.exitCode = 1;
    });
  if (idpStopped)
    await startLocalService('keycloak').catch(() => {
      console.error('Local Keycloak restart requires review.');
      process.exitCode = 1;
    });
  await browser.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await worker?.mf.dispose();
  app?.server.closeAllConnections();
  await app?.close();
  lmsLogout = '';
  foundationLogout = '';
}
