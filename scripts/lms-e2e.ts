import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { APIResponse, BrowserContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { localContainer } from './local-docker.js';
import { nextFixtureOtp } from './local-totp.js';
import { hash, unseal, seal } from '../src/lms/security.js';
import type { LmsTokens, LmsTransaction } from '../src/lms/oidc.js';
import { controlLms } from '../src/lms/lifecycle.js';
import type { FormsFixture } from './forms-fixtures.js';
import { clientLoginProof } from './client-login-proof.js';
import { subjectProof } from '../src/integration-proof.js';

const runtime = await loadLocalConfig();
const A = 'http://127.0.0.1:4100',
  F = 'http://127.0.0.1:4103',
  L = 'http://127.0.0.1:4104';
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const role = (value: FormsFixture['role']) => fixtures.users.find((u) => u.role === value)!;
const learner = runtime.users.find((u) => u.id === ids.learner)!;
let stage = 'preflight';
const servers: Awaited<ReturnType<typeof createApp>>[] = [];
let worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
const browser = await chromium.launch({ headless: true });
const pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 2 });
let poolUnavailable = false;
pool.on('error', () => {
  poolUnavailable = true;
  console.error('LMS E2E database connection lost; connection details omitted.');
  process.exitCode = 1;
});
const restore: (() => Promise<void>)[] = [];
const checks: string[] = [];
const scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
let currentPage: Page | undefined;
async function status(response: APIResponse, expected: number) {
  if (response.status() !== expected) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    console.error(
      'LMS HTTP: ' +
        response.status() +
        '/' +
        expected +
        (body.error && /^[A-Z0-9_]{1,80}$/.test(body.error) ? ' ' + body.error : ''),
    );
  }
  assert.equal(response.status(), expected);
}
async function login(
  user: { id: string; username: string; password: string },
  base = L,
  mfa = false,
  expected = 200,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  currentPage = page;
  page.on('pageerror', (error) =>
    console.error(
      'UI exception: ' +
        error.message.replace(/[A-Za-z0-9_+\/=.-]{24,}/g, '[redacted]').slice(0, 180),
    ),
  );
  await context.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective),
    );
  });
  await page.goto(base + '/auth/login?reauth=1');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === base && url.pathname === '/', { timeout: 20000 });
  await status(await context.request.get(base + '/api/v1/me'), expected);
  if (expected === 200 && base === L) {
    await page.getByRole('tab', { name: 'Lịch sử của tôi', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Bài học đã tham gia', exact: true }),
    ).toBeVisible();
  }
  return { context, page };
}
async function sso(page: Page, base: string) {
  await page.goto(base + '/auth/login');
  await page.waitForURL((url) => url.origin === base && url.pathname === '/', { timeout: 15000 });
  assert.equal(await page.locator('#username,#password,#otp').count(), 0);
  await status(await page.context().request.get(base + '/api/v1/me'), 200);
  if (base === L) await page.getByRole('tab', { name: 'Lịch sử của tôi', exact: true }).click();
}
async function scan(page: Page, screen: string) {
  assert.equal(new URL(page.url()).origin, L);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getTiming().iterations === Infinity,
      ),
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
      JSON.stringify({
        screen,
        violations: result.violations.map((issue) => ({
          id: issue.id,
          targets: issue.nodes.map((node) => node.target),
        })),
      }),
    );
  assert.deepEqual(
    result.violations.map((v) => v.id),
    [],
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'Page overflow on ' + screen,
  );
  const design = await page.evaluate(() => ({
    font: getComputedStyle(document.body).fontFamily,
    loaded: document.fonts.check('16px "Be Vietnam Pro"'),
    canvas: getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
    cta: getComputedStyle(document.documentElement).getPropertyValue('--action-primary').trim(),
  }));
  assert.match(design.font, /Be Vietnam Pro/);
  assert.equal(design.loaded, true);
  assert.equal(design.canvas.toUpperCase(), '#F5F8FA');
  assert.equal(design.cta.toUpperCase(), '#087C3C');
  for (const element of await page.getByRole('button').all()) {
    const bounds = await element.boundingBox();
    if (bounds) assert.ok(bounds.height >= 44 && bounds.width >= 44, 'Touch target on ' + screen);
  }
  assert.deepEqual(await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp), []);
}
async function session(context: BrowserContext) {
  const cookie = (await context.cookies(L)).find((c) => c.name === 'aio_lms_session');
  assert.ok(cookie);
  assert.ok(cookie.httpOnly);
  assert.equal(cookie.sameSite, 'Lax');
  assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/);
  const key = await hash(cookie.value);
  const row = await worker!.db
    .prepare(
      'SELECT encrypted_payload,idle_expires_at,absolute_expires_at,revision FROM aio_sessions WHERE hash=?',
    )
    .bind(key)
    .first<{
      encrypted_payload: string;
      idle_expires_at: number;
      absolute_expires_at: number;
      revision: number;
    }>();
  assert.ok(row);
  const tokens = await unseal<LmsTokens>(worker!.config, row.encrypted_payload, 'session:' + key);
  return { key, row, tokens };
}
async function fixtureChange(
  table: string,
  column: string,
  value: unknown,
  where: string,
  params: unknown[],
) {
  // Identifiers come only from the fixed calls in this script, never from request/user input.
  const before = await pool.query(
    'SELECT ' + column + ' AS value FROM ' + table + ' WHERE ' + where,
    params,
  );
  assert.equal(before.rowCount, 1);
  const change = async (next: unknown) => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(
        'UPDATE ' +
          table +
          ' SET ' +
          column +
          '=$1 WHERE ' +
          where.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) + 1)),
        [next, ...params],
      );
      await db.query(
        "INSERT INTO audit_events(actor_account_id,tenant_id,app_code,action,reason,request_id) VALUES ($1,$2,'aio-lms-sandbox','test.fixture_changed','Isolated LMS E2E fixture and restoration',$3)",
        [ids.admin, ids.tenantA, randomUUID()],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  };
  const undo = async () => change(before.rows[0].value);
  restore.push(undo);
  await change(value);
  return undo;
}
try {
  assert.equal((await localContainer('keycloak')).running, true);
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  for (const code of ['aio-foundation', 'aio-forms']) {
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
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  const history = async () =>
    Promise.all(
      ['employees', 'learning_progress', 'learning_attempts', 'learning_notes', 'lessons'].map(
        async (table) => ({
          table,
          rows: (await worker!.db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()).results,
        }),
      ),
    );
  const beforeHistory = JSON.stringify(await history()); // Includes synthetic hashes in memory only.
  stage = 'Portal and Forms → Worker SSO';
  const first = await login(learner, A);
  stage = 'Forms SSO';
  await sso(first.page, F);
  stage = 'Worker SSO';
  await sso(first.page, L);
  stage = 'learning payload';
  const response = await first.context.request.get(L + '/api/learning');
  await status(response, 200);
  const data = await response.json();
  assert.equal(data.employeeId, 'legacy-lms-a');
  assert.equal(data.attempts[0].score, 80);
  assert.equal(data.progress[0].position, 120);
  assert.equal(data.notes[0].content, 'Ghi chú học tập giả lập 0');
  assert.equal(data.progress[0].lesson_id, 'lesson-local');
  assert.equal(data.progress[0].series, 'AIO local');
  assert.equal(data.progress[0].deadline, '30/11/2026');
  assert.equal(data.attempts[0].title, data.progress[0].title);
  assert.equal(data.notes[0].title, data.progress[0].title);
  assert.ok(
    data.progress.every(
      (row: Record<string, unknown>) =>
        !('answer_key_json' in row) && !('questions_json' in row) && !('video_url' in row),
    ),
  );
  assert.ok(
    data.attempts.every(
      (row: Record<string, unknown>) => !('answers' in row) && !('snapshot' in row),
    ),
  );
  stage = 'learner UI';
  await expect(first.page.getByRole('heading', { name: 'Bài học đã tham gia' })).toBeVisible();
  stage = 'learner desktop accessibility';
  await scan(first.page, 'learner-desktop');
  await first.page.screenshot({ path: '.local/evidence/lms-learner-desktop.png', fullPage: true });
  await first.page.setViewportSize({ width: 390, height: 844 });
  await scan(first.page, 'learner-mobile');
  await first.page.screenshot({ path: '.local/evidence/lms-learner-mobile.png', fullPage: true });
  // A fresh navigation starts keyboard traversal at the skip link. The login helper
  // now clicks the legacy tab; focus after that click is intentionally on the tab.
  await first.page.goto(L + '/');
  await expect(first.page.getByRole('heading', { name: 'Khóa học dành cho bạn' })).toBeVisible();
  await first.page.keyboard.press('Tab');
  await expect(first.page.getByRole('link', { name: 'Đến nội dung chính' })).toBeFocused();
  await first.page.keyboard.press('Enter');
  await expect(first.page.locator('#lms-main')).toBeFocused();
  await first.page.getByRole('tab', { name: 'Lịch sử của tôi', exact: true }).click();
  await expect(first.page.getByRole('heading', { name: 'Bài học đã tham gia' })).toBeVisible();
  stage = 'LMS lesson search, status and detail';
  const lessonSearch = first.page.getByRole('textbox', { name: 'Tìm bài học', exact: true });
  await lessonSearch.fill('quy trinh');
  await expect(
    first.page.getByRole('heading', { name: data.progress[0].title, exact: true }),
  ).toBeVisible();
  await lessonSearch.fill('khong-co-bai-hoc');
  await expect(first.page.getByText('Không có bài học phù hợp', { exact: true })).toBeVisible();
  await scan(first.page, 'learner-filter-empty');
  await first.page.getByRole('button', { name: 'Xóa bộ lọc', exact: true }).click();
  await first.page.getByRole('combobox', { name: 'Trạng thái học tập', exact: true }).click();
  await first.page.getByRole('option', { name: 'Đã hoàn thành', exact: true }).click();
  await expect(first.page.getByRole('listbox')).toBeHidden();
  await expect(first.page.getByText('Không có bài học phù hợp', { exact: true })).toBeVisible();
  await first.page.getByRole('button', { name: 'Xóa bộ lọc', exact: true }).click();
  const detailButton = first.page.getByRole('button', {
    name: 'Xem chi tiết ' + data.progress[0].title,
    exact: true,
  });
  await detailButton.click();
  const detailDialog = first.page.getByRole('dialog', {
    name: data.progress[0].title,
    exact: true,
  });
  await expect(detailDialog.getByText(data.notes[0].content, { exact: true })).toBeVisible();
  await expect(detailDialog.getByRole('progressbar')).toHaveAttribute('value', '50');
  await scan(first.page, 'learner-detail-mobile');
  await first.page.screenshot({ path: '.local/evidence/lms-lesson-detail-mobile.png' });
  for (let index = 0; index < 5; index++) {
    await first.page.keyboard.press('Tab');
    assert.ok(await detailDialog.evaluate((element) => element.contains(document.activeElement)));
  }
  await first.page.keyboard.press('Escape');
  await expect(detailDialog).toBeHidden();
  await expect(detailButton).toBeFocused();
  await first.page.setViewportSize({ width: 1440, height: 1000 });
  checks.push(
    'Portal/Forms/Worker SSO, retained legacy IDs/progress/scores/notes, desktop/mobile UI',
  );
  stage = 'Gateway token and session boundaries';
  const current = await session(first.context),
    gateway = A + '/api/v1/integrations/aio-lms-sandbox/authorize';
  await status(await first.context.request.get(gateway), 401);
  await status(
    await first.context.request.get(gateway, {
      headers: { authorization: 'Bearer ' + current.tokens.accessToken },
    }),
    200,
  );
  await status(
    await first.context.request.get(A + '/api/v1/me', {
      headers: { authorization: 'Bearer ' + current.tokens.accessToken },
    }),
    401,
  );
  await status(
    await first.context.request.get(gateway, {
      headers: { authorization: 'Bearer ' + current.tokens.idToken },
    }),
    401,
  );
  stage = 'Fresh Portal token proof';
  const portalProof = await clientLoginProof(
    browser,
    runtime,
    runtime.clients.find((c) => c.code === 'aio-foundation')!,
    learner,
    false,
  );
  await status(
    await first.context.request.get(gateway, {
      headers: { authorization: 'Bearer ' + portalProof.accessToken },
    }),
    401,
  );
  await status(
    await first.context.request.get(A + '/api/v1/integrations/aio-probe/authorize', {
      headers: { authorization: 'Bearer ' + current.tokens.accessToken },
    }),
    404,
  );
  await status(await first.context.request.get(L + '/api/learning?userId=legacy-lms-c'), 403);
  await status(await first.context.request.get(L + '/api/admin'), 403);
  await status(await first.context.request.get(L + '/api/review'), 403);
  await status(
    await first.context.request.post(L + '/auth/logout', { data: { global: false } }),
    403,
  );
  stage = 'CSRF session retrieval';
  const meResponse = await first.context.request.get(L + '/api/v1/me');
  await status(meResponse, 200);
  const me = await meResponse.json();
  assert.equal(typeof me.csrfToken, 'string');
  await status(
    await first.context.request.post(L + '/auth/logout', {
      data: { global: false },
      headers: { origin: 'http://example.test', 'x-csrf-token': me.csrfToken },
    }),
    403,
  );
  await status(
    await first.context.request.post(L + '/api/auth/change-password', {
      data: {},
      headers: { origin: L, 'x-csrf-token': me.csrfToken },
    }),
    403,
  );
  checks.push(
    'Cookie-only/wrong audience/ID token rejected at gateway; learner isolation and CSRF',
  );
  stage = 'Server-only subject eligibility boundary';
  const idsToCheck = [learner.id, role('respondent').id, ids.other];
  const subjectUrl = gateway.replace('/authorize', '/subjects');
  await status(
    await first.context.request.post(subjectUrl, {
      data: { accountIds: idsToCheck },
      headers: { authorization: 'Bearer ' + current.tokens.accessToken },
    }),
    403,
  );
  const serviceProof = await subjectProof(
    worker.config.clientSecret,
    worker.config.clientId,
    current.tokens.accessToken,
    idsToCheck,
  );
  const eligible = await first.context.request.post(subjectUrl, {
    data: { accountIds: idsToCheck },
    headers: {
      authorization: 'Bearer ' + current.tokens.accessToken,
      'x-aio-service-proof': serviceProof,
    },
  });
  await status(eligible, 200);
  assert.ok(
    (await eligible.json()).subjects.every(
      (row: { tenantId: string; accountId: string }) =>
        row.tenantId === ids.tenantA && row.accountId !== ids.other,
    ),
  );
  await status(
    await first.context.request.post(subjectUrl, {
      data: { accountIds: [ids.other] },
      headers: {
        authorization: 'Bearer ' + current.tokens.accessToken,
        'x-aio-service-proof': serviceProof,
      },
    }),
    403,
  );
  checks.push(
    'Subject eligibility requires server proof, rejects altered IDs and excludes another tenant',
  );
  stage = 'Callback state and replay';
  let callback = '';
  const replayContext = await browser.newContext(),
    replayPage = await replayContext.newPage();
  replayPage.on('request', (request) => {
    if (request.url().startsWith(L + '/auth/callback?')) callback = request.url();
  });
  await replayPage.goto(L + '/auth/login');
  const wrongState = await replayContext.request.get(L + '/auth/callback?state=wrong&code=wrong');
  await status(wrongState, 401);
  const htmlWrongState = await replayContext.request.get(
    L + '/auth/callback?state=wrong&code=wrong',
    {
      headers: { accept: 'text/html' },
      maxRedirects: 0,
    },
  );
  await status(htmlWrongState, 401);
  assert.equal((await htmlWrongState.json()).error, 'OIDC_CALLBACK_REJECTED');
  await replayPage.locator('#username').fill(learner.username);
  await replayPage.locator('#password').fill(learner.password);
  await replayPage.locator('#kc-login').click();
  await replayPage.waitForURL((url) => url.origin === L && url.pathname === '/');
  assert.ok(callback);
  await status(await replayContext.request.get(callback), 400);
  const replaySession = (await replayContext.cookies(L)).find(
    (cookie) => cookie.name === 'aio_lms_session',
  )!;
  await replayPage.goto(callback);
  await replayPage.waitForURL(L + '/#login-recovery');
  await expect(
    replayPage.getByRole('heading', { name: 'Cần bắt đầu lại đăng nhập' }),
  ).toBeVisible();
  await status(await replayContext.request.get(L + '/api/v1/me'), 200);
  assert.equal(
    (await replayContext.cookies(L)).find((cookie) => cookie.name === 'aio_lms_session')?.value,
    replaySession.value,
  );
  callback = '';
  await replayContext.close();
  checks.push(
    'State rejection and one-use callback; HTML replay recovery preserves the existing session',
  );
  stage = 'Missing and expired LMS transaction recovery';
  const recovery = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const recoveryPage = await recovery.newPage();
  currentPage = recoveryPage;
  await recoveryPage.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective),
    );
  });
  const orphan = L + '/auth/callback?code=orphan-fixture&state=orphan-fixture';
  for (const accept of ['application/json', '*/*', 'text/html;q=0,application/json']) {
    const response = await recovery.request.get(orphan, { headers: { accept }, maxRedirects: 0 });
    await status(response, 400);
    assert.equal((await response.json()).error, 'LOGIN_TRANSACTION_INVALID');
    assert.equal(response.headers().location, undefined);
  }
  const missingHtml = await recovery.request.get(orphan, {
    headers: { accept: 'text/html' },
    maxRedirects: 0,
  });
  assert.equal(missingHtml.status(), 303);
  assert.equal(missingHtml.headers().location, '/#login-recovery');
  assert.equal(missingHtml.headers()['cache-control'], 'no-store');
  assert.equal(missingHtml.headers()['referrer-policy'], 'no-referrer');
  await recoveryPage.goto(orphan);
  await recoveryPage.waitForURL(L + '/#login-recovery');
  await expect(
    recoveryPage.getByRole('link', { name: 'Đăng nhập lại', exact: true }),
  ).toHaveAttribute('href', '/auth/login');
  await status(await recovery.request.get(L + '/api/v1/me'), 401);
  let loginStarts = 0;
  const authorizations: URL[] = [];
  recoveryPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === L && url.pathname === '/auth/login') loginStarts++;
    if (
      url.origin === new URL(runtime.issuer).origin &&
      url.pathname.endsWith('/protocol/openid-connect/auth')
    )
      authorizations.push(url);
  });
  await recoveryPage.getByRole('link', { name: 'Đăng nhập lại', exact: true }).click();
  await recoveryPage.locator('#username').waitFor();
  const pendingCookie = (await recovery.cookies(L)).find(
    (cookie) => cookie.name === 'aio_lms_transaction',
  );
  assert.ok(pendingCookie);
  const expiredKey = await hash(pendingCookie.value);
  const pending = await worker.db
    .prepare('SELECT expires_at FROM aio_login_transactions WHERE hash=?')
    .bind(expiredKey)
    .first<{ expires_at: number }>();
  assert.ok(pending && pending.expires_at > Date.now());
  await worker.db
    .prepare('UPDATE aio_login_transactions SET expires_at=? WHERE hash=?')
    .bind(Date.now() - 1, expiredKey)
    .run();
  const expiredJson = await recovery.request.get(orphan, {
    headers: { accept: 'application/json' },
    maxRedirects: 0,
  });
  await status(expiredJson, 400);
  assert.equal((await expiredJson.json()).error, 'LOGIN_TRANSACTION_INVALID');
  await recoveryPage.locator('#username').fill(learner.username);
  await recoveryPage.locator('#password').fill(learner.password);
  await recoveryPage.locator('#kc-login').click();
  await recoveryPage.waitForURL(L + '/#login-recovery');
  await expect(
    recoveryPage.getByRole('heading', { name: 'Cần bắt đầu lại đăng nhập' }),
  ).toBeVisible();
  await status(await recovery.request.get(L + '/api/v1/me'), 401);
  assert.equal(
    (await recovery.cookies(L)).some((cookie) => cookie.name === 'aio_lms_session'),
    false,
  );
  await recoveryPage.reload();
  await scan(recoveryPage, 'expired-login-recovery-mobile');
  assert.equal(recoveryPage.url(), L + '/#login-recovery');
  assert.equal(loginStarts, 1, 'Recovery does not automatically loop through SSO');
  await recoveryPage.screenshot({
    path: '.local/evidence/lms-login-recovery-mobile.png',
    fullPage: true,
  });
  await recoveryPage.getByRole('link', { name: 'Đăng nhập lại', exact: true }).click();
  await recoveryPage.waitForURL(L + '/');
  assert.equal(loginStarts, 2);
  assert.equal(authorizations.length, 2);
  for (const name of ['state', 'nonce', 'code_challenge']) {
    assert.ok(authorizations[0]!.searchParams.get(name));
    assert.notEqual(
      authorizations[0]!.searchParams.get(name),
      authorizations[1]!.searchParams.get(name),
    );
  }
  await status(await recovery.request.get(L + '/api/v1/me'), 200);
  await expect(
    recoveryPage.getByRole('heading', { name: 'Khóa học dành cho bạn', exact: true }),
  ).toBeVisible();
  assert.equal(
    await worker.db
      .prepare('SELECT 1 FROM aio_login_transactions WHERE hash=?')
      .bind(expiredKey)
      .first(),
    null,
  );
  await recovery.close();
  checks.push(
    'Missing/expired callback HTML → explicit fresh SSO with new state/nonce/PKCE; JSON remains 400; no redirect loop or session before recovery',
  );
  stage = 'Worker PKCE and nonce negatives';
  for (const field of ['verifier', 'nonce'] as const) {
    const negative = await browser.newContext(),
      page = await negative.newPage();
    await page.goto(L + '/auth/login');
    const transactionCookie = (await negative.cookies(L)).find(
      (cookie) => cookie.name === 'aio_lms_transaction',
    );
    assert.ok(transactionCookie);
    const key = await hash(transactionCookie.value),
      row = await worker.db
        .prepare('SELECT encrypted_payload FROM aio_login_transactions WHERE hash=?')
        .bind(key)
        .first<{ encrypted_payload: string }>();
    assert.ok(row);
    const transaction = await unseal<LmsTransaction>(
      worker.config,
      row.encrypted_payload,
      'transaction:' + key,
    );
    transaction[field] = 'a'.repeat(43);
    await worker.db
      .prepare('UPDATE aio_login_transactions SET encrypted_payload=? WHERE hash=?')
      .bind(await seal(worker.config, transaction, 'transaction:' + key), key)
      .run();
    const callback = page.waitForResponse((response) =>
      response.url().startsWith(L + '/auth/callback?'),
    );
    void callback.catch(() => {});
    await page.locator('#username').fill(learner.username);
    await page.locator('#password').fill(learner.password);
    await page.locator('#kc-login').click();
    assert.equal((await callback).status(), 401);
    assert.equal(
      (await negative.cookies(L)).some((cookie) => cookie.name === 'aio_lms_session'),
      false,
    );
    assert.equal(
      await worker.db
        .prepare('SELECT 1 FROM aio_login_transactions WHERE hash=?')
        .bind(key)
        .first(),
      null,
    );
    await negative.close();
  }
  checks.push(
    'Real Worker code exchange rejects wrong PKCE verifier and nonce without session creation',
  );
  stage = 'Manager unit scope and MFA admin UI';
  const manager = await login(role('reviewer'));
  const admin = await login(role('publisher'), L, true);
  await manager.page.getByRole('tab', { name: 'Lịch sử đơn vị' }).click();
  await expect(manager.page.getByRole('cell', { name: 'legacy-lms-a', exact: true })).toBeVisible();
  await scan(manager.page, 'manager');
  const reviewerSearch = manager.page.getByRole('textbox', {
    name: 'Tìm học viên hoặc bài học',
    exact: true,
  });
  await reviewerSearch.fill('LMS-DEMO-0');
  await expect(manager.page.getByRole('cell', { name: 'legacy-lms-a', exact: true })).toBeVisible();
  await expect(
    manager.page.getByRole('cell', { name: 'legacy-lms-manager', exact: true }),
  ).toHaveCount(0);
  await reviewerSearch.fill('khong-co-hoc-vien');
  await expect(manager.page.getByText('Không có học viên phù hợp', { exact: true })).toBeVisible();
  await manager.page.getByRole('button', { name: 'Xóa bộ lọc', exact: true }).click();
  const reviewed = await (await manager.context.request.get(L + '/api/review')).json();
  assert.ok(reviewed.items.length > 0);
  assert.ok(reviewed.items.every((r: { org_unit_id: string }) => r.org_unit_id === ids.unitA));
  assert.ok(
    reviewed.items.every(
      (row: { title: string; duration: number }) =>
        row.title === data.progress[0].title && row.duration === 600,
    ),
  );
  await status(await manager.context.request.get(L + '/api/review?orgUnitId=' + ids.unitC), 403);
  await status(await manager.context.request.get(L + '/api/admin'), 403);
  await admin.page.getByRole('tab', { name: 'Lịch sử quản trị' }).click();
  await expect(admin.page.getByRole('cell', { name: 'legacy-lms-c', exact: true })).toBeVisible();
  await scan(admin.page, 'admin');
  await admin.page.screenshot({ path: '.local/evidence/lms-admin-desktop.png', fullPage: true });
  await admin.page
    .getByRole('combobox', { name: 'Phòng ban trong hồ sơ LMS', exact: true })
    .click();
  await admin.page.getByRole('option', { name: 'Legacy department C', exact: true }).click();
  await expect(admin.page.getByRole('listbox')).toBeHidden();
  await expect(admin.page.getByRole('cell', { name: 'legacy-lms-c', exact: true })).toBeVisible();
  await expect(admin.page.getByRole('cell', { name: 'legacy-lms-a', exact: true })).toHaveCount(0);
  await admin.page.setViewportSize({ width: 390, height: 844 });
  stage = 'Admin mobile accessibility';
  await scan(admin.page, 'admin-mobile-filtered');
  const reportRegion = admin.page.getByRole('region', {
    name: 'Bảng tiến độ học viên, cuộn ngang để xem thêm cột',
  });
  await reportRegion.focus();
  await admin.page.keyboard.press('ArrowRight');
  await expect
    .poll(() => reportRegion.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await reportRegion.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await admin.page.screenshot({ path: '.local/evidence/lms-admin-mobile.png', fullPage: true });
  await admin.page
    .getByRole('combobox', { name: 'Phòng ban trong hồ sơ LMS', exact: true })
    .click();
  await admin.page.getByRole('option', { name: 'Tất cả phòng ban', exact: true }).click();
  await expect(admin.page.getByRole('listbox')).toBeHidden();
  await admin.page.setViewportSize({ width: 1440, height: 1000 });
  checks.push(
    'LMS lesson metadata whitelist, accent-insensitive search, status/department filters, lesson detail and keyboard focus',
  );
  stage = 'Multi-lesson isolation and report pagination';
  const temporaryLessons = Array.from({ length: 8 }, (_, index) => ({
    id: 'ui-lms-' + randomUUID(),
    title: 'Bài học bổ sung kiểm thử ' + (index + 1),
  }));
  const cleanupLessons = async () => {
    for (const lesson of temporaryLessons) {
      await worker!.db.batch([
        worker!.db.prepare('DELETE FROM learning_notes WHERE id=?').bind('note-' + lesson.id),
        worker!.db.prepare('DELETE FROM learning_attempts WHERE id=?').bind('attempt-' + lesson.id),
        worker!.db
          .prepare('DELETE FROM learning_progress WHERE id=?')
          .bind('progress-' + lesson.id),
        worker!.db.prepare('DELETE FROM lessons WHERE id=?').bind(lesson.id),
      ]);
    }
  };
  restore.push(cleanupLessons);
  for (const [index, lesson] of temporaryLessons.entries()) {
    await worker.db.batch([
      worker.db
        .prepare(
          'INSERT INTO lessons SELECT ?,?,subtitle,series,target_dept,deadline,is_mandatory,duration,video_url,poster_url,checkpoints_json,questions_json,answer_key_json,status,?,created_at,updated_at FROM lessons WHERE id=?',
        )
        .bind(lesson.id, lesson.title, index + 2, 'lesson-local'),
      worker.db
        .prepare(
          'INSERT INTO learning_progress(id,user_id,lesson_id,position,watched,answers,finished,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind(
          'progress-' + lesson.id,
          'legacy-lms-a',
          lesson.id,
          0,
          index === 0 ? 600 : 0,
          '{}',
          index === 0 ? 1 : 0,
          new Date().toISOString(),
        ),
      worker.db
        .prepare(
          'INSERT INTO learning_notes(id,user_id,lesson_id,time,content,created_at) VALUES (?,?,?,?,?,?)',
        )
        .bind(
          'note-' + lesson.id,
          'legacy-lms-a',
          lesson.id,
          0,
          'Ghi chú riêng bài bổ sung ' + (index + 1),
          new Date().toISOString(),
        ),
    ]);
  }
  await first.page.getByRole('button', { name: 'Tải lại dữ liệu', exact: true }).click();
  const firstExtra = temporaryLessons[0]!;
  const extraDetailButton = first.page.getByRole('button', {
    name: 'Xem chi tiết ' + firstExtra.title,
    exact: true,
  });
  await extraDetailButton.click();
  const extraDetail = first.page.getByRole('dialog', { name: firstExtra.title, exact: true });
  await expect(extraDetail.getByText('Ghi chú riêng bài bổ sung 1', { exact: true })).toBeVisible();
  await expect(extraDetail.getByText(data.notes[0].content, { exact: true })).toHaveCount(0);
  await expect(extraDetail.getByText('Ghi chú riêng bài bổ sung 2', { exact: true })).toHaveCount(
    0,
  );
  await expect(extraDetail.getByText('Chưa có kết quả kiểm tra.', { exact: true })).toBeVisible();
  await expect(extraDetail.getByRole('progressbar')).toHaveAttribute('value', '100');
  await first.page.keyboard.press('Escape');
  await expect(extraDetail).toBeHidden();
  await first.page.getByRole('combobox', { name: 'Trạng thái học tập', exact: true }).click();
  await first.page.getByRole('option', { name: 'Đã hoàn thành', exact: true }).click();
  await expect(first.page.getByRole('listbox')).toBeHidden();
  await expect(extraDetailButton).toBeVisible();
  await expect(
    first.page.getByRole('button', { name: 'Xem chi tiết ' + data.progress[0].title, exact: true }),
  ).toHaveCount(0);
  await admin.page.getByRole('button', { name: 'Tải lại dữ liệu', exact: true }).click();
  await expect(admin.page.getByRole('table').getByRole('row')).toHaveCount(11);
  await admin.page.getByRole('button', { name: 'Trang học viên sau', exact: true }).click();
  await expect(admin.page.getByRole('table').getByRole('row')).toHaveCount(3);
  await expect(
    admin.page.getByRole('button', { name: 'Trang học viên sau', exact: true }),
  ).toBeDisabled();
  await admin.page
    .getByRole('textbox', { name: 'Tìm học viên hoặc bài học', exact: true })
    .fill('LMS-DEMO-1');
  await expect(admin.page.getByRole('cell', { name: 'legacy-lms-c', exact: true })).toBeVisible();
  await expect(
    admin.page.getByRole('button', { name: 'Trang học viên trước', exact: true }),
  ).toBeDisabled();
  await cleanupLessons();
  assert.equal(JSON.stringify(await history()), beforeHistory);
  checks.push(
    'Lesson details isolate notes/results; completed filter; 12-row pagination resets on search; temporary data restored',
  );
  checks.push('Manager unit scope; MFA + AIO permission + legacy admin intersection');
  stage = 'Complete legacy pagination beyond 500 rows and current permission on each page';
  const pageFixture = 'page-' + randomUUID(),
    pageLesson = pageFixture + '-lesson',
    pageTitle = 'Bài học sau mốc 500 · ' + pageFixture.slice(0, 13),
    pageRows = Array.from(
      { length: 521 },
      (_, index) => pageFixture + '-' + String(index).padStart(4, '0'),
    );
  const cleanupPages = async () => {
    await worker!.db.batch([
      worker!.db
        .prepare('DELETE FROM learning_progress WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(pageRows)),
      worker!.db.prepare('DELETE FROM lessons WHERE id=?').bind(pageLesson),
      worker!.db
        .prepare(
          "INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,tenant_id,action,reason,request_id,details) VALUES (?,?,?,?, 'test.pagination_fixture_removed','Remove owned pagination fixtures',?,?)",
        )
        .bind(
          randomUUID(),
          Date.now(),
          ids.admin,
          ids.tenantA,
          randomUUID(),
          JSON.stringify({ fixture: pageFixture }),
        ),
    ]);
  };
  restore.push(cleanupPages);
  await worker.db.batch([
    worker.db
      .prepare(
        'INSERT INTO lessons SELECT ?,?,subtitle,series,target_dept,deadline,is_mandatory,duration,video_url,poster_url,checkpoints_json,questions_json,answer_key_json,status,9999,created_at,updated_at FROM lessons WHERE id=?',
      )
      .bind(pageLesson, pageTitle, 'lesson-local'),
    worker.db
      .prepare(
        "INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,tenant_id,action,reason,request_id,details) VALUES (?,?,?,?, 'test.pagination_fixture_created','Create isolated pagination fixtures',?,?)",
      )
      .bind(
        randomUUID(),
        Date.now(),
        ids.admin,
        ids.tenantA,
        randomUUID(),
        JSON.stringify({ fixture: pageFixture, rows: pageRows.length }),
      ),
  ]);
  for (let offset = 0; offset < pageRows.length; offset += 100)
    await worker.db.batch(
      pageRows
        .slice(offset, offset + 100)
        .map((id, index) =>
          worker!.db
            .prepare(
              'INSERT INTO learning_progress(id,user_id,lesson_id,position,watched,answers,finished,updated_at) VALUES (?,?,?,0,0,?,0,?)',
            )
            .bind(
              id,
              offset + index < 501 ? 'legacy-lms-a' : 'legacy-lms-c',
              offset + index === 500 ? pageLesson : 'lesson-local',
              '{}',
              new Date().toISOString(),
            ),
        ),
    );
  const firstPagedResponse = await manager.context.request.get(L + '/api/review');
  await status(firstPagedResponse, 200);
  const firstPaged = await firstPagedResponse.json();
  assert.ok(firstPaged.nextCursor);
  const collected: { progress_id: string | null; org_unit_id: string; title: string }[] = [];
  let pageCursor: string | undefined;
  const visited = new Set<string>();
  do {
    const response: APIResponse = await manager.context.request.get(
      L + '/api/review' + (pageCursor ? '?cursor=' + encodeURIComponent(pageCursor) : ''),
    );
    await status(response, 200);
    const body = await response.json();
    assert.ok(body.items.length <= 100);
    collected.push(...body.items);
    pageCursor = body.nextCursor ?? undefined;
    if (pageCursor) {
      assert.equal(visited.has(pageCursor), false);
      visited.add(pageCursor);
    }
  } while (pageCursor);
  assert.equal(collected.filter((row) => row.progress_id?.startsWith(pageFixture)).length, 501);
  assert.equal(
    new Set(collected.filter((row) => row.progress_id).map((row) => row.progress_id)).size,
    collected.filter((row) => row.progress_id).length,
  );
  assert.ok(collected.every((row) => row.org_unit_id === ids.unitA));
  assert.ok(collected.some((row) => row.title === pageTitle));
  await status(await manager.context.request.get(L + '/api/review?cursor=invalid'), 400);
  const undoPagingPermission = await fixtureChange(
    'permission_catalog',
    'active',
    false,
    "app_code=$1 AND code='lms:review'",
    ['aio-lms-sandbox'],
  );
  await status(
    await manager.context.request.get(
      L + '/api/review?cursor=' + encodeURIComponent(firstPaged.nextCursor),
    ),
    403,
  );
  await manager.page.getByRole('button', { name: 'Tải lại dữ liệu', exact: true }).click();
  await expect(manager.page.getByRole('table')).toHaveCount(0);
  await undoPagingPermission();
  await admin.page.getByRole('button', { name: 'Tải lại dữ liệu', exact: true }).click();
  const fullSearch = admin.page.getByRole('textbox', {
    name: 'Tìm học viên hoặc bài học',
    exact: true,
  });
  await expect(fullSearch).toBeVisible();
  await fullSearch.fill(pageTitle);
  await expect(admin.page.getByRole('cell', { name: pageTitle, exact: true })).toBeVisible();
  await scan(admin.page, 'admin-over-500');
  await admin.page.screenshot({ path: '.local/evidence/lms-legacy-over-500.png', fullPage: true });
  await cleanupPages();
  assert.equal(JSON.stringify(await history()), beforeHistory);
  checks.push(
    '521-row fixture: 501 in-scope progress rows traverse all pages; no duplicate IDs, cross-unit data or stale later-page permission; UI finds record beyond 500; cleanup retained original history',
  );
  stage = 'Actual Worker refresh concurrency';
  const rotating = await session(first.context);
  const deadline = rotating.row.absolute_expires_at;
  await worker.db
    .prepare('UPDATE aio_sessions SET encrypted_payload=? WHERE hash=?')
    .bind(
      await seal(worker.config, { ...rotating.tokens, expiresAt: 0 }, 'session:' + rotating.key),
      rotating.key,
    )
    .run();
  const renewed = await Promise.all(
    Array.from({ length: 6 }, () => first.context.request.get(L + '/api/learning')),
  );
  for (const r of renewed) await status(r, 200);
  const after = await session(first.context);
  assert.equal(after.row.revision, rotating.row.revision + 1);
  assert.equal(after.row.absolute_expires_at, deadline);
  assert.notEqual(after.tokens.refreshToken, rotating.tokens.refreshToken);
  checks.push(
    'Six concurrent requests rotate a real refresh token once and retain absolute deadline',
  );
  stage = 'No grant, unknown mapping, disabled account';
  for (const user of [
    runtime.users.find((u) => u.id === ids.noAccess)!,
    runtime.users.find((u) => u.id === ids.blocked)!,
  ]) {
    const denied = await login(user, L, false, 401);
    await expect(denied.page.locator('[data-auth-error]')).toBeVisible();
    await denied.context.close();
  }
  const analyst = role('analyst');
  await pool.query(
    "WITH created AS (INSERT INTO application_grants(account_id,tenant_id,app_code,active) VALUES ($1,$2,'aio-lms-sandbox',false) ON CONFLICT(account_id,tenant_id,app_code) DO NOTHING RETURNING account_id) INSERT INTO audit_events(actor_account_id,subject_account_id,tenant_id,app_code,action,reason,request_id) SELECT $3,account_id,$2,'aio-lms-sandbox','test.fixture_created','Unmapped identity fixture initially denied',$4 FROM created",
    [analyst.id, ids.tenantA, ids.admin, randomUUID()],
  );
  const undoUnmapped = await fixtureChange(
    'application_grants',
    'active',
    true,
    "account_id=$1 AND app_code='aio-lms-sandbox'",
    [analyst.id],
  );
  const unmap = await login(analyst, L, false, 401);
  await expect(unmap.page.locator('[data-auth-error="LMS_IDENTITY_NOT_LINKED"]')).toBeVisible();
  await scan(unmap.page, 'unmapped-denial');
  await unmap.context.close();
  await undoUnmapped();
  checks.push('No-grant/blocked/unmapped denied without employee creation');
  stage = 'Live reviewer role enforcement';
  const undoRole = await fixtureChange(
    'role_bindings',
    'active',
    false,
    "account_id=$1 AND app_code='aio-lms-sandbox'",
    [role('reviewer').id],
  );
  await status(await manager.context.request.get(L + '/api/review'), 403);
  await undoRole();
  await status(await manager.context.request.get(L + '/api/review'), 200);
  const assignment = (
    await pool.query(
      'SELECT a.id FROM assignments a JOIN employments e ON e.id=a.employment_id JOIN accounts ac ON ac.person_id=e.person_id WHERE ac.id=$1 LIMIT 1',
      [role('respondent').id],
    )
  ).rows[0];
  assert.ok(assignment);
  const second = await login(role('respondent'));
  stage = 'Live learner unit enforcement';
  const undoUnit = await fixtureChange(
    'assignments',
    'valid_until',
    new Date(Date.now() - 1000),
    'id=$1',
    [assignment.id],
  );
  await status(await second.context.request.get(L + '/api/learning'), 403);
  assert.ok(
    (await (await admin.context.request.get(L + '/api/admin')).json()).items.every(
      (row: { id: string }) => row.id !== 'legacy-lms-c',
    ),
  );
  await undoUnit();
  await status(await second.context.request.get(L + '/api/learning'), 401);
  const accountSession = await login(role('respondent'));
  stage = 'Live learner account enforcement';
  const undoAccount = await fixtureChange('accounts', 'active', false, 'id=$1', [
    role('respondent').id,
  ]);
  await status(await accountSession.context.request.get(L + '/api/learning'), 403);
  assert.ok(
    (await (await admin.context.request.get(L + '/api/admin')).json()).items.every(
      (row: { id: string }) => row.id !== 'legacy-lms-c',
    ),
  );
  await undoAccount();
  await status(await accountSession.context.request.get(L + '/api/learning'), 401);
  stage = 'Live application enforcement';
  const undoApp = await fixtureChange('applications', 'status', 'disabled', 'code=$1', [
    'aio-lms-sandbox',
  ]);
  await status(await first.context.request.get(L + '/api/learning'), 403);
  await undoApp();
  const finalLearner = await login(learner);
  stage = 'Live learner grant enforcement';
  const undoGrant = await fixtureChange(
    'application_grants',
    'active',
    false,
    "account_id=$1 AND app_code='aio-lms-sandbox'",
    [learner.id],
  );
  const revokedAt = Date.now();
  await status(await finalLearner.context.request.get(L + '/api/learning'), 403);
  const revokeMs = Date.now() - revokedAt;
  await finalLearner.page.getByRole('button', { name: 'Tải lại dữ liệu' }).click();
  await expect(finalLearner.page.getByRole('alert')).toBeVisible();
  assert.equal(await finalLearner.page.getByText('Ghi chú học tập giả lập 0').count(), 0);
  checks.push(
    'Live role/unit/app/grant changes enforced; stale UI data cleared; revoke ' + revokeMs + ' ms',
  );
  stage = 'Adapter rollback while grant revoked';
  const control = await worker.db
    .prepare('SELECT revision FROM aio_adapter_control WHERE id=1')
    .first<{ revision: number }>();
  const actor = { accountId: ids.admin, tenantId: ids.tenantA };
  const cmd = {
    target: 'adapter' as const,
    enabled: false,
    expectedRevision: control!.revision,
    reason: 'Isolated sandbox rollback rehearsal',
    commandKey: randomUUID(),
  };
  // Trusted fixture harness calls the same atomic operator service; CLI verifies MFA separately.
  const disabled = await controlLms(worker.db, actor, cmd);
  const enable = async () => {
    const row = await worker!.db
      .prepare('SELECT enabled,revision FROM aio_adapter_control WHERE id=1')
      .first<{ enabled: number; revision: number }>();
    if (row!.enabled === 0)
      await controlLms(worker!.db, actor, {
        ...cmd,
        enabled: true,
        expectedRevision: row!.revision,
        commandKey: randomUUID(),
      });
  };
  restore.push(enable);
  await status(await admin.context.request.get(L + '/api/admin'), 503);
  await status(await finalLearner.context.request.get(L + '/auth/login', { maxRedirects: 0 }), 503);
  await controlLms(worker.db, actor, {
    ...cmd,
    enabled: true,
    expectedRevision: disabled.revision,
    commandKey: randomUUID(),
  });
  await status(await admin.context.request.get(L + '/api/admin'), 401);
  assert.equal(
    (
      await pool.query(
        "SELECT active FROM application_grants WHERE account_id=$1 AND app_code='aio-lms-sandbox'",
        [learner.id],
      )
    ).rows[0].active,
    false,
  );
  assert.equal(JSON.stringify(await history()), beforeHistory);
  await undoGrant();
  checks.push(
    'Adapter disable clears sessions; enable never restores revoked grants; all legacy rows byte-equivalent',
  );
  assert.equal(poolUnavailable, false, 'Database transport failed during the suite');
  await writeFile(
    '.local/evidence/lms-e2e.json',
    JSON.stringify(
      { checkedAt: new Date().toISOString(), result: 'pass', checks, scans },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: actual Worker SSO, roles/scopes, refresh concurrency, rollback, legacy preservation; ' +
      scans.length +
      ' axe scans.',
  );
} catch (error) {
  if (error instanceof Error)
    console.error(error.stack?.match(/lms-e2e\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable');
  if (error instanceof Error && error.message.startsWith('Local identity proof failed at '))
    console.error(error.message);
  if (
    currentPage &&
    !currentPage.isClosed() &&
    new URL(currentPage.url()).origin === L &&
    new URL(currentPage.url()).pathname === '/' &&
    (await currentPage.locator('input[type=password]').count()) === 0
  ) {
    console.error(
      'LMS UI headings: ' + JSON.stringify(await currentPage.locator('h1,h2,h3').allTextContents()),
    );
    await currentPage.screenshot({ path: '.local/evidence/lms-failure.png', fullPage: true });
  }
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error('Numeric assertion: ' + error.actual + '/' + error.expected);
  console.error(
    'LMS E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  for (const undo of restore.reverse())
    try {
      await undo();
    } catch {
      console.error('LMS test fixture restoration requires review.');
      process.exitCode = 1;
    }
  await browser.close();
  await worker?.mf.dispose();
  for (const server of servers) await server.close();
  await pool.end();
}
