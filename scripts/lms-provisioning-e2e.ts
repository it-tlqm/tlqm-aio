import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import type { Page, APIResponse } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp, fixtureTotp } from './local-totp.js';
import { localContainer } from './local-docker.js';
import { hash, unseal } from '../src/lms/security.js';
import type { LmsTokens } from '../src/lms/oidc.js';
import { identityProof } from '../src/integration-identity-proof.js';
import { directoryProof } from '../src/integration-directory-proof.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104',
  appCode = 'aio-lms-sandbox',
  run = randomUUID().slice(0, 8);
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const browser = await chromium.launch({ headless: true }),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 2 });
let completed = false;
let transportFailed = false;
pool.on('error', () => {
  transportFailed = true;
  process.exitCode = 1;
  console.error('Learner admin test database unavailable; sensitive details omitted.');
});
let app: Awaited<ReturnType<typeof createApp>> | undefined,
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined,
  stage = 'preflight',
  targetSubject: string | undefined,
  restoreProvisioning = false;
const target = {
  id: randomUUID(),
  personId: randomUUID(),
  employmentId: randomUUID(),
  assignmentId: randomUUID(),
  bindingId: randomUUID(),
  username: 'lms.qa.' + run,
  password: randomBytes(24).toString('base64url'),
  name: 'Học viên SSO nghiệm thu ' + run,
};
const scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
async function status(response: APIResponse, expected = 200) {
  if (response.status() !== expected) {
    const body = await response.json().catch(() => ({}));
    console.error(
      'Learner API status ' +
        response.status() +
        '/' +
        expected +
        ' ' +
        (/^[A-Z0-9_]+$/.test(body.error ?? '') ? body.error : ''),
    );
  }
  assert.equal(response.status(), expected);
}
async function login(
  user: { id: string; username: string; password: string },
  mfa = false,
  linked = true,
) {
  // auth_time has one-second precision. A fresh authentication must occur strictly
  // after the revocation boundary; never relax the server's <= rejection.
  if (linked && worker) {
    const boundary = await worker.db
      .prepare('SELECT auth_not_before FROM aio_account_links WHERE account_id=?')
      .bind(user.id)
      .first<number>('auth_not_before');
    if (boundary && Date.now() < (boundary + 1) * 1000)
      await new Promise((resolve) => setTimeout(resolve, (boundary + 1) * 1000 - Date.now() + 50));
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  await page.addInitScript(() => {
    (window as Window & { cspIssues?: string[] }).cspIssues = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { cspIssues?: string[] }).cspIssues?.push(event.violatedDirective),
    );
  });
  const callback = page.waitForResponse((response) =>
    response.url().startsWith(base + '/auth/callback'),
  );
  await page.goto(base + '/auth/login?reauth=1');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL(base + '/');
  const meResponse = await context.request.get(base + '/api/v1/me');
  if (linked && meResponse.status() !== 200) {
    const callbackHeaders = await (await callback).allHeaders();
    const errorCode = /aio_lms_auth_error=([A-Z_]+)/.exec(callbackHeaders['set-cookie'] ?? '')?.[1];
    if (
      errorCode &&
      [
        'REAUTHENTICATION_REQUIRED',
        'LMS_UNIT_MAPPING_STALE',
        'LMS_IDENTITY_NOT_LINKED',
        'APPLICATION_ACCESS_DENIED',
        'MFA_REQUIRED',
        'ACCOUNT_UNAVAILABLE',
      ].includes(errorCode)
    )
      console.error('SSO denial code: ' + errorCode);
  }
  if (linked) {
    await status(meResponse);
    await expect(
      page.getByRole('heading', { name: 'Khóa học dành cho bạn', exact: true }),
    ).toBeVisible();
  } else await status(meResponse, 401);
  return {
    context,
    page,
    me: (await meResponse.json()) as {
      csrfToken: string;
      legacy: { id: string };
      capabilities: Record<string, boolean>;
    },
  };
}
type User = Awaited<ReturnType<typeof login>>;
async function command(
  user: User,
  path: string,
  action: string,
  data: unknown,
  expected = 200,
  key = randomUUID(),
) {
  const response = await user.context.request.post(base + path, {
    headers: { origin: base, 'x-csrf-token': user.me.csrfToken, 'idempotency-key': key },
    data: { action, data, reason: 'Nghiệm thu học viên SSO giả lập' },
  });
  await status(response, expected);
  return response.json();
}
async function scan(page: Page, screen: string) {
  assert.equal(new URL(page.url()).origin, base);
  assert.equal(await page.locator('input[type=password],#otp').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    screen,
    violations: result.violations.map((i) => i.id),
    incomplete: result.incomplete.map((i) => i.id),
  });
  if (result.violations.length)
    console.error(
      JSON.stringify(
        result.violations.map((i) => ({ id: i.id, targets: i.nodes.map((n) => n.target) })),
      ),
    );
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(
    await page.evaluate(() => (window as Window & { cspIssues?: string[] }).cspIssues),
    [],
  );
  await page.screenshot({
    path: '.local/evidence/lms-provisioning-' + screen + '.png',
    fullPage: (await page.getByRole('dialog').count()) === 0,
  });
}
async function mutate(statements: { sql: string; values?: unknown[] }[]) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    for (const item of statements) await db.query(item.sql, item.values);
    await db.query(
      "INSERT INTO audit_events(actor_account_id,tenant_id,app_code,action,reason,request_id) VALUES ($1,$2,$3,'test.learner_fixture_changed','Isolated LMS provisioning acceptance and restoration',$4)",
      [ids.admin, ids.tenantA, appCode, randomUUID()],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
async function mapping() {
  const row = await worker!.db
    .prepare(
      'SELECT account_id,employee_id,org_unit_id,revision,active FROM aio_account_links WHERE account_id=?',
    )
    .bind(target.id)
    .first<{
      account_id: string;
      employee_id: string;
      org_unit_id: string;
      revision: number;
      active: number;
    }>();
  assert.ok(row);
  return row;
}
async function legacyDigest() {
  const data = await Promise.all(
    ['employees', 'learning_progress', 'learning_attempts', 'learning_notes'].map(async (table) => {
      const cols =
        table === 'employees'
          ? 'id,code,name,department,role,password_hash,must_change_password,is_active,created_at,updated_at'
          : '*';
      const where =
        table === 'employees' ? "id LIKE 'legacy-lms-%'" : "user_id LIKE 'legacy-lms-%'";
      return [
        table,
        (
          await worker!.db
            .prepare('SELECT ' + cols + ' FROM ' + table + ' WHERE ' + where + ' ORDER BY id')
            .all()
        ).results,
      ];
    }),
  );
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
try {
  assert.equal((await localContainer('keycloak')).running, true);
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  stage = 'owned synthetic IAM fixture';
  const idp = await localKeycloakAdmin(runtime);
  const created = await idp('/users', 'POST', {
    username: target.username,
    enabled: true,
    firstName: 'Học viên SSO',
    lastName: run,
    email: target.username + '@example.test',
    emailVerified: true,
    attributes: {
      'aio.local.instance': [runtime.instanceId],
      'aio.local.fixture': ['lms-provisioning-e2e'],
    },
    credentials: [{ type: 'password', value: target.password, temporary: false }],
  });
  targetSubject = created.headers.get('location')?.split('/').pop();
  assert.ok(targetSubject);
  const position = (
    await pool.query(
      'SELECT id FROM positions WHERE tenant_id=$1 AND org_unit_id=$2 AND active ORDER BY id LIMIT 1',
      [ids.tenantA, ids.unitA],
    )
  ).rows[0].id as string;
  await mutate([
    {
      sql: 'INSERT INTO persons(id,display_name,home_tenant_id) VALUES ($1,$2,$3)',
      values: [target.personId, target.name, ids.tenantA],
    },
    {
      sql: 'INSERT INTO accounts(id,person_id) VALUES ($1,$2)',
      values: [target.id, target.personId],
    },
    {
      sql: "INSERT INTO external_identities(issuer,subject,account_id,verified_at,verified_by,verification_method) VALUES ($1,$2,$3,now(),$4,'owned-local-e2e-fixture')",
      values: [runtime.issuer, targetSubject, target.id, ids.admin],
    },
    {
      sql: 'INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)',
      values: [target.id, ids.tenantA],
    },
    {
      sql: 'INSERT INTO employments(id,person_id,tenant_id,legal_entity_id,employee_code) VALUES ($1,$2,$3,$4,$5)',
      values: [target.employmentId, target.personId, ids.tenantA, ids.legalA, 'QA-' + run],
    },
    {
      sql: 'INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary) VALUES ($1,$2,$3,$4,$5,true)',
      values: [target.assignmentId, ids.tenantA, ids.legalA, target.employmentId, position],
    },
    {
      sql: 'INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,$3)',
      values: [target.id, ids.tenantA, appCode],
    },
    {
      sql: "INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code) VALUES ($1,$2,$3,$4,'learner')",
      values: [target.bindingId, target.id, ids.tenantA, appCode],
    },
  ]);
  app = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((c) => c.code === 'aio-foundation')!,
    test: true,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 4100 });
  worker = await startLocalLms(true);
  const before = await legacyDigest();
  stage = 'persisted test migration';
  await migrateLms(worker.db, worker.config);
  assert.equal(await legacyDigest(), before);
  assert.equal((await worker.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  stage = 'SSO access and no automatic learner creation';
  const admin = await login(
      fixtures.users.find((u) => u.role === 'publisher')!,
      true,
    ),
    manager = await login(fixtures.users.find((u) => u.role === 'reviewer')!);
  await login(target, false, false);
  assert.equal(
    await worker.db
      .prepare('SELECT 1 FROM aio_account_links WHERE account_id=?')
      .bind(target.id)
      .first(),
    null,
  );
  await status(await manager.context.request.get(base + '/api/lms/learners'), 403);
  await status(await manager.context.request.get(base + '/api/lms/learner-candidates'), 403);
  const page = admin.page;
  stage = 'confidential identity assertion proof and scope';
  const raw = (await admin.context.cookies()).find((c) => c.name === 'aio_lms_session')!.value,
    sessionHash = await hash(raw);
  const row = await worker.db
    .prepare('SELECT encrypted_payload FROM aio_sessions WHERE hash=?')
    .bind(sessionHash)
    .first<{ encrypted_payload: string }>();
  assert.ok(row);
  const tokens = await unseal<LmsTokens>(
    worker.config,
    row.encrypted_payload,
    'session:' + sessionHash,
  );
  const identityQuery = { tenantId: ids.tenantA, accountId: target.id, orgUnitId: ids.unitA };
  const identityEndpoint = 'http://127.0.0.1:4100/api/v1/integrations/' + appCode + '/identity';
  await status(
    await admin.context.request.post(identityEndpoint, {
      headers: { authorization: 'Bearer ' + tokens.accessToken },
      data: identityQuery,
    }),
    403,
  );
  await status(
    await admin.context.request.post(identityEndpoint, {
      headers: {
        authorization: 'Bearer ' + tokens.accessToken,
        'x-aio-service-proof': await directoryProof(
          worker.config.clientSecret,
          appCode,
          tokens.accessToken,
          { kind: 'people', tenantId: ids.tenantA, accountIds: [target.id] },
        ),
      },
      data: identityQuery,
    }),
    403,
  );
  const proof = await identityProof(
    worker.config.clientSecret,
    appCode,
    tokens.accessToken,
    identityQuery,
  );
  const verified = await admin.context.request.post(identityEndpoint, {
    headers: { authorization: 'Bearer ' + tokens.accessToken, 'x-aio-service-proof': proof },
    data: identityQuery,
  });
  await status(verified);
  assert.equal((await verified.json()).target.subject, targetSubject);
  await status(
    await admin.context.request.post(identityEndpoint, {
      headers: { authorization: 'Bearer ' + tokens.accessToken, 'x-aio-service-proof': proof },
      data: { ...identityQuery, orgUnitId: ids.unitC },
    }),
    403,
  );
  stage = 'learner UI onboarding desktop';
  await page.getByRole('tab', { name: 'Học viên & tài khoản', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Danh sách học viên', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Đang tải học viên…')).toHaveCount(0);
  await scan(page, 'desktop');
  await page.getByRole('button', { name: 'Thêm từ AIO', exact: true }).click();
  await page.getByLabel('Tên nhân sự', { exact: true }).fill(target.name);
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Chọn ' + target.name, exact: true }),
  ).toBeVisible();
  await scan(page, 'discovery');
  await page.getByRole('button', { name: 'Chọn ' + target.name, exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Thêm học viên', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Lý do thay đổi', { exact: true }).fill('Thêm học viên SSO nghiệm thu');
  await scan(page, 'provision-dialog');
  const saveResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/lms/learner-commands') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Thêm học viên', exact: true }).click();
  const saved = await saveResponse;
  assert.equal(saved.status(), 200);
  const responseBody = await saved.json(),
    savedRequest = saved.request();
  const retried = await admin.context.request.post(base + '/api/lms/learner-commands', {
    headers: {
      origin: base,
      'x-csrf-token': admin.me.csrfToken,
      'idempotency-key': savedRequest.headers()['idempotency-key']!,
    },
    data: savedRequest.postDataJSON(),
  });
  await status(retried);
  assert.deepEqual(await retried.json(), responseBody);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const linked = await mapping();
  assert.equal(linked.revision, 1);
  const credential = await worker.db
    .prepare('SELECT password_hash,must_change_password,credential_kind FROM employees WHERE id=?')
    .bind(linked.employee_id)
    .first();
  assert.deepEqual(credential, {
    password_hash: null,
    must_change_password: 0,
    credential_kind: 'sso-only',
  });
  const listResponse = await admin.context.request.get(base + '/api/lms/learners');
  await status(listResponse);
  const serialized = await listResponse.text();
  for (const forbidden of ['password_hash', 'issuer', 'subject', 'encrypted_payload'])
    assert.equal(serialized.includes('"' + forbidden + '"'), false);
  const candidateList = await admin.context.request.get(
    base + '/api/lms/learner-candidates?search=' + encodeURIComponent(target.name),
  );
  await status(candidateList);
  assert.equal((await candidateList.json()).items[0].alreadyLinked, true);
  const bad = await admin.context.request.post(base + '/api/lms/learner-commands', {
    headers: { origin: base, 'x-csrf-token': 'wrong', 'idempotency-key': randomUUID() },
    data: {
      action: 'disable',
      data: { accountId: target.id, orgUnitId: ids.unitA, expectedRevision: 1 },
      reason: 'Bad CSRF fixture',
    },
  });
  await status(bad, 403);
  await command(
    admin,
    '/api/lms/learner-commands',
    'disable',
    { accountId: target.id, orgUnitId: ids.unitA, expectedRevision: 1, subject: 'forged' },
    400,
  );
  stage = 'mobile and keyboard learner configuration';
  await page.setViewportSize({ width: 390, height: 844 });
  await scan(page, 'mobile');
  await page.getByRole('button', { name: 'Cấu hình ' + target.name, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scan(page, 'configuration-mobile');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Cấu hình ' + target.name, exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'new SSO learner can learn and retain graded history';
  let learner = await login(target);
  assert.equal(learner.me.legacy.id, linked.employee_id);
  await status(await learner.context.request.get(base + '/api/lms/learners'), 403);
  const spec: CourseSpec = {
    schemaVersion: 1,
    title: 'Kiểm tra hồ sơ SSO ' + run,
    subtitle: 'Nghiệm thu',
    series: 'SSO',
    duration: 1,
    video: { kind: 'youtube', id: 'abcdefghijk' },
    deadline: '',
    isMandatory: false,
    audienceUnits: [ids.unitA],
    checkpoints: [],
    questions: [{ id: 'q', type: 'single', question: 'Chọn đáp án', options: ['A', 'B'] }],
    answerKey: { q: { answer: 0, explanation: 'Fixture' } },
    attachments: [],
  };
  const course = await command(admin, '/api/lms/commands', 'save-course', {
    code: 'sso-' + run,
    ownerUnitId: ids.unitA,
    expectedRevision: 0,
    spec,
  });
  const version = await command(admin, '/api/lms/commands', 'publish-course', {
    courseId: course.id,
    expectedRevision: 1,
  });
  await command(learner, '/api/lms/commands', 'progress', {
    versionId: version.versionId,
    expectedRevision: 0,
    position: 1,
  });
  const attempt = await command(learner, '/api/lms/commands', 'submit', {
    versionId: version.versionId,
    answers: { q: 0 },
    tabSwitchCount: 0,
  });
  assert.equal(attempt.score, 100);
  await command(learner, '/api/lms/commands', 'create-note', {
    versionId: version.versionId,
    time: 0,
    content: 'Ghi chú được giữ',
  });
  const certificate = await command(learner, '/api/lms/commands', 'issue-certificate', {
    attemptId: attempt.id,
  });
  stage = 'disable and explicit enable revoke old sessions';
  await page.getByRole('button', { name: 'Cấu hình ' + target.name, exact: true }).click();
  await page
    .getByLabel('Lý do thay đổi', { exact: true })
    .fill('Khóa học viên để nghiệm thu thu hồi phiên');
  await page.getByRole('button', { name: 'Khóa học viên', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal((await mapping()).active, 0);
  await status(await learner.context.request.get(base + '/api/v1/me'), 401);
  await command(
    admin,
    '/api/lms/learner-commands',
    'enable',
    { accountId: target.id, orgUnitId: ids.unitA, expectedRevision: 1 },
    409,
  );
  await command(admin, '/api/lms/learner-commands', 'enable', {
    accountId: target.id,
    orgUnitId: ids.unitA,
    expectedRevision: 2,
  });
  await status(await learner.context.request.get(base + '/api/v1/me'), 401);
  learner = await login(target);
  assert.equal(learner.me.legacy.id, linked.employee_id);
  await status(await learner.context.request.get(base + '/api/lms/attempt?id=' + attempt.id));
  stage = 'live assignment move and explicit reconciliation';
  const otherPosition = (
    await pool.query(
      'SELECT id FROM positions WHERE tenant_id=$1 AND org_unit_id=$2 AND active ORDER BY id LIMIT 1',
      [ids.tenantA, ids.unitC],
    )
  ).rows[0].id;
  await mutate([
    {
      sql: 'UPDATE assignments SET position_id=$2,revision=revision+1 WHERE id=$1',
      values: [target.assignmentId, otherPosition],
    },
  ]);
  await status(await learner.context.request.get(base + '/api/v1/me'), 403);
  await command(admin, '/api/lms/learner-commands', 'reconcile', {
    accountId: target.id,
    orgUnitId: ids.unitC,
    expectedRevision: 3,
  });
  learner = await login(target);
  assert.equal(learner.me.legacy.id, linked.employee_id);
  await status(await learner.context.request.get(base + '/api/lms/attempt?id=' + attempt.id));
  await status(
    await learner.context.request.get(base + '/api/lms/certificate?code=' + certificate.code),
  );
  assert.equal(
    (
      await learner.context.request.get(base + '/api/lms/course?versionId=' + version.versionId)
    ).status(),
    403,
  );
  assert.equal(await legacyDigest(), before);
  stage = 'SSO-only administrator enrollment, fresh OTP and live IAM authority';
  await mutate([
    {
      sql: 'UPDATE role_bindings SET role_code=$2,revision=revision+1 WHERE id=$1',
      values: [target.bindingId, 'admin'],
    },
    {
      sql: 'UPDATE accounts SET mfa_required=true,revision=revision+1 WHERE id=$1',
      values: [target.id],
    },
    {
      sql: "INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,'aio-foundation')",
      values: [target.id, ids.tenantA],
    },
  ]);
  await status(await learner.context.request.get(base + '/api/v1/me'), 403);
  const setupIdp = await localKeycloakAdmin(runtime);
  const owned = (await (await setupIdp('/users/' + targetSubject)).json()) as {
    username: string;
    attributes: Record<string, string[]>;
  };
  assert.equal(owned.username, target.username);
  assert.equal(owned.attributes['aio.local.instance']?.[0], runtime.instanceId);
  assert.equal(owned.attributes['aio.local.fixture']?.[0], 'lms-provisioning-e2e');
  const mfaRole = await (await setupIdp('/roles/aio-mfa-required')).json();
  await setupIdp('/users/' + targetSubject + '/role-mappings/realm', 'POST', [mfaRole]);
  await setupIdp('/users/' + targetSubject, 'PUT', {
    requiredActions: ['CONFIGURE_TOTP', 'UPDATE_PASSWORD'],
  });
  const qaContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    qaPage = await qaContext.newPage(),
    newPassword = randomBytes(24).toString('base64url');
  await qaPage.addInitScript(() => {
    (window as Window & { cspIssues?: string[] }).cspIssues = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { cspIssues?: string[] }).cspIssues?.push(event.violatedDirective),
    );
  });
  let qaSecret = '',
    lastOtpStep = -1,
    configured = false,
    passwordChanged = false,
    executedOtp = false;
  const qaOtp = async () => {
    const step = Math.floor(Date.now() / 30000);
    if (step <= lastOtpStep)
      await new Promise((resolve) =>
        setTimeout(resolve, (lastOtpStep + 1) * 30000 - Date.now() + 250),
      );
    lastOtpStep = Math.floor(Date.now() / 30000);
    return fixtureTotp(qaSecret);
  };
  // These values belong only to the newly created QA identity. Never capture an enrollment screen.
  await qaPage.goto(base + '/auth/login?reauth=1');
  await qaPage.locator('#username').fill(target.username);
  await qaPage.locator('#password').fill(target.password);
  await qaPage.locator('#kc-login').click();
  for (let step = 0; step < 5 && new URL(qaPage.url()).origin !== base; step++) {
    await qaPage.waitForFunction(
      () =>
        location.pathname === '/auth/callback' ||
        document.querySelector('#totpSecret,#password-new,#otp') !== null,
    );
    if (await qaPage.locator('#totpSecret').count()) {
      assert.equal(configured, false);
      qaSecret = await qaPage.locator('#totpSecret').inputValue();
      await qaPage.locator('#totp').fill(await qaOtp());
      await qaPage.locator('#userLabel').fill('Owned LMS QA fixture');
      await qaPage.locator('#saveTOTPBtn').click();
      configured = true;
    } else if (await qaPage.locator('#password-new').isVisible()) {
      await qaPage.locator('#password-new').fill(newPassword);
      await qaPage.locator('#password-confirm').fill(newPassword);
      await qaPage.locator('form:has(#password-new) [type="submit"]').click();
      target.password = newPassword;
      passwordChanged = true;
    } else if (await qaPage.locator('#otp').isVisible()) {
      await qaPage.locator('#otp').fill(await qaOtp());
      await qaPage.locator('#kc-login').click();
      executedOtp = true;
    }
  }
  assert.equal(configured, true);
  assert.equal(passwordChanged, true);
  await qaPage.waitForURL(base + '/');
  const afterSetup = await qaContext.request.get(base + '/api/v1/me');
  await status(afterSetup, executedOtp ? 200 : 401);
  if (!executedOtp) {
    await expect(qaPage.locator('[data-auth-error="MFA_REQUIRED"]')).toBeVisible();
    await expect(qaPage.getByRole('link', { name: 'Đăng nhập SSO', exact: true })).toHaveAttribute(
      'href',
      '/auth/login?reauth=1',
    );
    await qaPage.getByRole('link', { name: 'Đăng nhập SSO', exact: true }).click();
  } else await qaPage.goto(base + '/auth/login?reauth=1');
  if (await qaPage.locator('#username').isVisible())
    await qaPage.locator('#username').fill(target.username);
  else assert.equal(await qaPage.locator('#kc-attempted-username').inputValue(), target.username);
  await qaPage.locator('#password').fill(target.password);
  await qaPage.locator('#kc-login').click();
  await qaPage.locator('#otp').fill(await qaOtp());
  await qaPage.locator('#kc-login').click();
  await qaPage.waitForURL(base + '/');
  const qaMe = await qaContext.request.get(base + '/api/v1/me');
  await status(qaMe);
  learner = { context: qaContext, page: qaPage, me: await qaMe.json() };
  assert.equal(learner.me.capabilities['lms:admin'], true);
  assert.equal(learner.me.legacy.id, linked.employee_id);
  assert.deepEqual(
    await worker.db
      .prepare('SELECT role,credential_kind FROM employees WHERE id=?')
      .bind(linked.employee_id)
      .first(),
    { role: 'learner', credential_kind: 'sso-only' },
  );
  await status(await qaContext.request.get(base + '/api/lms/manage/courses'));
  await status(await qaContext.request.get(base + '/api/lms/learners'));
  await command(
    learner,
    '/api/lms/learner-commands',
    'disable',
    { accountId: target.id, orgUnitId: ids.unitC, expectedRevision: 4 },
    403,
  );
  await expect(
    qaPage.getByRole('tab', { name: 'Học viên & tài khoản', exact: true }),
  ).toBeVisible();
  await qaPage.getByRole('tab', { name: 'Học viên & tài khoản', exact: true }).click();
  await expect(
    qaPage.getByRole('heading', { name: 'Danh sách học viên', exact: true }),
  ).toBeVisible();
  await expect(qaPage.getByText('Đang tải học viên…')).toHaveCount(0);
  await scan(qaPage, 'sso-only-admin');
  stage = 'SSO-only admin reaches personal Portal without Foundation management rights';
  await qaPage.goto('http://127.0.0.1:4100/auth/login');
  await qaPage.waitForURL('http://127.0.0.1:4100/');
  const portalMe = await qaContext.request.get('http://127.0.0.1:4100/api/v1/me');
  await status(portalMe);
  assert.equal((await portalMe.json()).permissions.length, 0);
  await status(
    await qaContext.request.get('http://127.0.0.1:4100/api/v1/directory?tenantId=' + ids.tenantA),
    403,
  );
  const portalApps = await qaContext.request.get('http://127.0.0.1:4100/api/v1/applications');
  await status(portalApps);
  const apps = (await portalApps.json()).items as { code: string }[];
  assert.ok(apps.some((item) => item.code === appCode));
  assert.ok(apps.every((item) => [appCode, 'aio-foundation'].includes(item.code)));
  stage = 'current target grant and provisioner revocation';
  await mutate([
    {
      sql: 'UPDATE application_grants SET active=false,revision=revision+1 WHERE account_id=$1',
      values: [target.id],
    },
  ]);
  await status(await learner.context.request.get(base + '/api/v1/me'), 403);
  await command(
    admin,
    '/api/lms/learner-commands',
    'enable',
    { accountId: target.id, orgUnitId: ids.unitC, expectedRevision: 4 },
    409,
  );
  await command(admin, '/api/lms/learner-commands', 'disable', {
    accountId: target.id,
    orgUnitId: ids.unitC,
    expectedRevision: 4,
  });
  await mutate([
    {
      sql: "DELETE FROM role_permissions WHERE tenant_id=$1 AND app_code=$2 AND role_code='admin' AND permission='identity:provision'",
      values: [ids.tenantA, appCode],
    },
  ]);
  restoreProvisioning = true;
  await status(await admin.context.request.get(base + '/api/lms/learners'), 403);
  const setup = await promisify(execFile)(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/lms-provisioning-setup.ts'],
    { cwd: process.cwd(), timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  assert.ok(setup.stdout.includes('provisioned'));
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM role_permissions WHERE tenant_id=$1 AND app_code=$2 AND role_code='admin' AND permission='identity:provision'",
        [ids.tenantA, appCode],
      )
    ).rowCount,
    0,
  );
  await page.getByRole('button', { name: 'Làm mới danh sách học viên', exact: true }).click();
  await expect(
    page.getByText('Bạn chưa được cấp quyền quản trị liên kết học viên với AIO.'),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Danh sách học viên đã liên kết', exact: true }),
  ).toHaveCount(0);
  assert.equal(transportFailed, false);
  completed = true;
} catch (error) {
  console.error(
    'Learner administration E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      ')' +
      (error instanceof Error
        ? ' ' + (error.stack?.match(/lms-provisioning-e2e\.ts:\d+:\d+/)?.[0] ?? '')
        : '') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  if (restoreProvisioning)
    await mutate([
      {
        sql: "INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,$2,'admin','identity:provision') ON CONFLICT DO NOTHING",
        values: [ids.tenantA, appCode],
      },
    ]).catch(() => {
      process.exitCode = 1;
      console.error('Provisioner fixture restoration failed.');
    });
  await mutate([
    {
      sql: 'UPDATE accounts SET active=false,revision=revision+1 WHERE id=$1',
      values: [target.id],
    },
    {
      sql: 'UPDATE application_grants SET active=false,revision=revision+1 WHERE account_id=$1',
      values: [target.id],
    },
    {
      sql: 'UPDATE role_bindings SET active=false,revision=revision+1 WHERE id=$1',
      values: [target.bindingId],
    },
  ]).catch(() => {
    process.exitCode = 1;
    console.error('Learner fixture retirement failed.');
  });
  if (targetSubject)
    await (
      await localKeycloakAdmin(runtime)
    )('/users/' + targetSubject, 'PUT', { enabled: false }).catch(() => {
      process.exitCode = 1;
      console.error('Owned local identity retirement failed.');
    });
  await browser.close();
  await worker?.mf.dispose();
  if (app) {
    app.server.closeAllConnections();
    await app.close();
  }
  await pool.end();
}

if (completed && !process.exitCode && !transportFailed) {
  await writeFile(
    '.local/evidence/lms-provisioning-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans,
        checks: [
          '006 test migration retained legacy credentials/history and valid foreign keys',
          'Real SSO unknown identity does not auto-create employee',
          'Confidential app-bound identity proof rejects missing, cross-purpose and tampered query',
          'UI discovery, explicit provision, stable retry, no password, MFA and CSRF',
          'New SSO learner progresses, grades, notes and certificate through current IAM',
          'Owned QA SSO-only admin completes password/OTP setup, performs a fresh OTP authentication and receives live IAM admin authority without legacy role mutation; self-mapping edits rejected',
          'Personal Portal access shows only granted apps, with no Foundation management permissions or Directory access',
          'Disable/enable invalidates old sessions; CAS and assignment reconciliation preserve employee/history',
          'Target and operator grant revocation; setup tombstone never restores revoked authority; stale UI cleared',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: LMS learner administration, real SSO provisioning, immutable history and current IAM; ' +
      scans.length +
      ' axe scans.',
  );
}
