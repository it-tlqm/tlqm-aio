import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import * as XLSX from 'xlsx';
import { chromium, expect } from '@playwright/test';
import type { Page, BrowserContext, APIResponse } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp } from './local-totp.js';
import { hash, unseal } from '../src/lms/security.js';
import type { LmsTokens } from '../src/lms/oidc.js';
import { directoryProof } from '../src/integration-directory-proof.js';
import type { DirectoryQuery } from '../src/integration-directory-proof.js';
import { subjectProof } from '../src/integration-proof.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104',
  run = randomUUID().slice(0, 8);
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const browser = await chromium.launch({ headless: true }),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 2 });
let transportFailed = false;
pool.on('error', () => {
  transportFailed = true;
  console.error('Report E2E database unavailable; connection details omitted.');
  process.exitCode = 1;
});
let app: Awaited<ReturnType<typeof createApp>> | undefined,
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined,
  current: Page | undefined,
  stage = 'startup';
const restore: (() => Promise<void>)[] = [],
  scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
async function status(response: APIResponse, expected = 200) {
  if (response.status() !== expected) {
    const body = await response.json().catch(() => ({}));
    console.error(
      'Report API: ' +
        response.status() +
        '/' +
        expected +
        ' ' +
        (/^[A-Z0-9_]+$/.test(body.error ?? '') ? body.error : ''),
    );
  }
  assert.equal(response.status(), expected);
}
async function login(user: { id: string; username: string; password: string }, mfa = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  current = page;
  await page.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective),
    );
  });
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL(base + '/');
  await expect(
    page.getByRole('heading', { name: 'Khóa học dành cho bạn', exact: true }),
  ).toBeVisible();
  const me = await (await context.request.get(base + '/api/v1/me')).json();
  return { context, page, me };
}
async function scan(page: Page, screen: string) {
  current = page;
  assert.equal(new URL(page.url()).origin, base);
  assert.equal(await page.locator('input[type=password],#otp').count(), 0);
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
    violations: result.violations.map((issue) => issue.id),
    incomplete: result.incomplete.map((issue) => issue.id),
  });
  if (result.violations.length)
    console.error(
      JSON.stringify(
        result.violations.map((issue) => ({
          id: issue.id,
          targets: issue.nodes.map((node) => node.target),
        })),
      ),
    );
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp), []);
}
async function mutateFixture(sql: string, values: unknown[]) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(sql, values);
    await db.query(
      "INSERT INTO audit_events(actor_account_id,tenant_id,app_code,action,reason,request_id) VALUES ($1,$2,'aio-lms-sandbox','test.fixture_changed','Isolated report scope test and restoration',$3)",
      [ids.admin, ids.tenantA, randomUUID()],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
try {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  app = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((client) => client.code === 'aio-foundation')!,
    test: true,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 4100 });
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  const admin = await login(
      fixtures.users.find((user) => user.role === 'publisher')!,
      true,
    ),
    manager = await login(fixtures.users.find((user) => user.role === 'reviewer')!),
    learner = await login(runtime.users.find((user) => user.id === ids.learner)!),
    other = await login(fixtures.users.find((user) => user.role === 'respondent')!);
  const page = admin.page;
  current = page;
  stage = 'Directory service proof, scope and authoritative names';
  const refs = await (await admin.context.request.get(base + '/api/lms/lookups')).json(),
    unit = (await pool.query('SELECT name FROM org_units WHERE id=$1', [ids.unitA])).rows[0].name;
  assert.equal(refs.units.find((row: { id: string }) => row.id === ids.unitA).name, unit);
  assert.equal(learner.me.unit.name, unit);
  const cookie = (await manager.context.cookies(base)).find(
    (cookie) => cookie.name === 'aio_lms_session',
  )!;
  const session = await worker.db
    .prepare('SELECT encrypted_payload FROM aio_sessions WHERE hash=?')
    .bind(await hash(cookie.value))
    .first<{ encrypted_payload: string }>();
  assert.ok(session);
  const tokens = await unseal<LmsTokens>(
    worker.config,
    session.encrypted_payload,
    'session:' + (await hash(cookie.value)),
  );
  const query: DirectoryQuery = {
      kind: 'people',
      tenantId: ids.tenantA,
      accountIds: [ids.learner],
    },
    url = 'http://127.0.0.1:4100/api/v1/integrations/aio-lms-sandbox/directory';
  const signed = await directoryProof(
    worker.config.clientSecret,
    worker.config.clientId,
    tokens.accessToken,
    query,
  );
  await status(
    await manager.context.request.post(url, {
      headers: { authorization: 'Bearer ' + tokens.accessToken, 'x-aio-service-proof': signed },
      data: { ...query, orgUnitId: ids.unitC },
    }),
    403,
  );
  await status(
    await manager.context.request.post(url, {
      headers: {
        authorization: 'Bearer ' + tokens.accessToken,
        'x-aio-service-proof': await subjectProof(
          worker.config.clientSecret,
          worker.config.clientId,
          tokens.accessToken,
          [ids.learner],
        ),
      },
      data: query,
    }),
    403,
  );
  const directory = await manager.context.request.post(url, {
    headers: { authorization: 'Bearer ' + tokens.accessToken, 'x-aio-service-proof': signed },
    data: query,
  });
  await status(directory);
  const directoryBody = await directory.json();
  assert.equal(directoryBody.items.length, 1);
  assert.equal(directoryBody.items[0].displayName, learner.me.displayName);
  assert.deepEqual(
    directoryBody.items[0].units.map((row: { id: string }) => row.id),
    [ids.unitA],
  );
  assert.equal('email' in directoryBody.items[0], false);
  assert.equal('subject' in directoryBody.items[0], false);
  await status(await learner.context.request.get(base + '/api/lms/report'), 403);
  await status(
    await manager.context.request.get(base + '/api/lms/report?orgUnitId=' + ids.unitC),
    403,
  );
  async function command(who: typeof admin, action: string, data: unknown) {
    const response = await who.context.request.post(base + '/api/lms/commands', {
      headers: {
        origin: base,
        'content-type': 'application/json',
        'x-csrf-token': who.me.csrfToken,
        'idempotency-key': randomUUID(),
      },
      data: { action, data, reason: 'Nghiệm thu gradebook bằng dữ liệu giả lập' },
    });
    await status(response);
    return response.json();
  }
  const spec: CourseSpec = {
    schemaVersion: 1,
    title: 'Báo cáo bắt buộc ' + run,
    subtitle: 'G7 fixture',
    series: 'Gradebook',
    duration: 2,
    video: { kind: 'youtube', id: 'abcdefghijk' },
    deadline: '2000-01-01',
    isMandatory: true,
    audienceUnits: [ids.unitA],
    checkpoints: [],
    questions: [
      { id: 'q1', type: 'single', question: 'Một', options: ['A', 'B'] },
      { id: 'q2', type: 'multiple', question: 'Nhiều', options: ['A', 'B', 'C'] },
      { id: 'q3', type: 'text', question: 'Chữ', options: [] },
    ],
    answerKey: {
      q1: { answer: 1, explanation: '' },
      q2: { answer: [0, 2], explanation: '' },
      q3: { answer: 'SSO', explanation: '' },
    },
    attachments: [],
  };
  const draft = await command(admin, 'save-course', {
      code: 'report-' + run,
      ownerUnitId: ids.unitA,
      expectedRevision: 0,
      spec,
    }),
    published = await command(admin, 'publish-course', {
      courseId: draft.id,
      expectedRevision: draft.revision,
    });
  const optional = await command(admin, 'save-course', {
    code: 'optional-' + run,
    ownerUnitId: ids.unitA,
    expectedRevision: 0,
    spec: {
      ...spec,
      title: 'Tự chọn ' + run,
      isMandatory: false,
      audienceUnits: [ids.unitC],
      deadline: '',
    },
  });
  await command(admin, 'publish-course', {
    courseId: optional.id,
    expectedRevision: optional.revision,
  });
  await status(
    await manager.context.request.get(base + '/api/lms/report?courseId=' + optional.id),
    404,
  );
  for (const who of [learner, manager])
    await command(who, 'progress', {
      versionId: published.versionId,
      expectedRevision: 0,
      position: 2,
    });
  const first = await command(learner, 'submit', {
    versionId: published.versionId,
    answers: { q1: 0, q2: [1], q3: 'sai' },
    tabSwitchCount: 0,
  });
  assert.equal(first.score, 0);
  const passed = await command(learner, 'submit', {
    versionId: published.versionId,
    answers: { q1: 1, q2: [0, 2], q3: 'SSO' },
    tabSwitchCount: 0,
  });
  assert.equal(passed.score, 100);
  await command(manager, 'submit', {
    versionId: published.versionId,
    answers: { q1: 0, q2: [0, 2], q3: 'SSO' },
    tabSwitchCount: 0,
  });
  stage = 'gradebook exact metrics and scoped export';
  const reportUrl = base + '/api/lms/report?courseId=' + draft.id,
    report = await (await admin.context.request.get(reportUrl)).json();
  assert.equal(report.summary.withRequired, 3);
  assert.equal(report.summary.completed, 1);
  assert.equal(report.summary.pending, 2);
  assert.equal(report.summary.attempts, 3);
  assert.equal(report.summary.averageBestScore, 84);
  assert.equal(report.summary.overdue, 2);
  assert.equal(
    report.items.find((row: { employeeId: string }) => row.employeeId === learner.me.legacy.id)
      .name,
    learner.me.displayName,
  );
  assert.equal(JSON.stringify(report).includes('answerKey'), false);
  assert.equal(JSON.stringify(report).includes('correctAnswer'), false);
  const noRequired = await (
    await admin.context.request.get(base + '/api/lms/report?courseId=' + optional.id)
  ).json();
  assert.equal(noRequired.total, 1);
  assert.equal(noRequired.summary.completionRate, null);
  assert.equal(noRequired.summary.completed, 0);
  assert.equal(noRequired.items[0].employeeId, other.me.legacy.id);
  const managerExportKey = randomUUID(),
    exportBody = { filters: { courseId: draft.id }, reason: 'Xuất báo cáo đơn vị giả lập' };
  const exportFile = async (key: string, who = manager) =>
    who.context.request.post(base + '/api/lms/report-export', {
      headers: {
        origin: base,
        'content-type': 'application/json',
        'x-csrf-token': who.me.csrfToken,
        'idempotency-key': key,
      },
      data: exportBody,
    });
  const exported = await exportFile(managerExportKey);
  await status(exported);
  const bytes = await exported.body();
  const book = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['Tong_quan', 'Bang_diem', 'Chi_tiet', 'Don_vi']);
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Bang_diem!);
  assert.equal(rows.length, 3);
  assert.equal(JSON.stringify(rows).includes(other.me.displayName), false);
  await status(await exportFile(managerExportKey));
  stage = 'desktop mobile keyboard and real UI download';
  await page.getByRole('tab', { name: 'Bảng điểm & báo cáo', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Bảng điểm & báo cáo', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Khóa học', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Khóa học', exact: true }).click();
  await page.getByRole('option', { name: spec.title + ' · v1', exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(page.getByText('3 học viên · Trang 1/1', { exact: true })).toBeVisible();
  await scan(page, 'report-desktop');
  await page.screenshot({ path: '.local/evidence/lms-report-desktop.png', fullPage: true });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất báo cáo Excel', exact: true }).click();
  await (await pending).saveAs('.local/evidence/lms-report-ui.xlsx');
  assert.equal(
    XLSX.utils.sheet_to_json(
      XLSX.read(await readFile('.local/evidence/lms-report-ui.xlsx'), { type: 'buffer' }).Sheets
        .Bang_diem!,
    ).length,
    3,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await scan(page, 'report-mobile');
  await page.screenshot({ path: '.local/evidence/lms-report-mobile.png', fullPage: true });
  const learnerRow = page
    .getByRole('region', { name: 'Bảng điểm học viên', exact: true })
    .getByRole('row')
    .filter({ hasText: learner.me.displayName });
  await learnerRow.getByRole('button', { name: 'Chi tiết', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Chi tiết học tập', exact: true });
  await expect(dialog.getByText('100/100', { exact: true })).toBeVisible();
  await scan(page, 'report-detail-mobile');
  await page.screenshot({ path: '.local/evidence/lms-report-detail-mobile.png', fullPage: true });
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    assert.equal(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      true,
    );
  }
  await page.keyboard.press('Escape');
  await expect(learnerRow.getByRole('button', { name: 'Chi tiết', exact: true })).toBeFocused();
  await page.getByLabel('Tìm học viên hoặc mã', { exact: true }).fill('khong tim thay ' + run);
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  await expect(
    page.getByText('Không có học viên phù hợp trong phạm vi hiện hành.', { exact: true }),
  ).toBeVisible();
  await scan(page, 'report-filter-empty');
  await page.getByLabel('Tìm học viên hoặc mã', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  await expect(page.getByText('3 học viên · Trang 1/1', { exact: true })).toBeVisible();
  stage = 'new publication never inherits older pass';
  const next = await command(admin, 'publish-course', {
    courseId: draft.id,
    expectedRevision: published.revision,
  });
  const fresh = await (await admin.context.request.get(reportUrl)).json();
  assert.equal(fresh.summary.completed, 0);
  assert.equal(fresh.summary.attempts, 0);
  assert.equal(fresh.courses[0].versionId, next.versionId);
  await status(await exportFile(managerExportKey), 409);
  assert.equal(
    (await (await learner.context.request.get(base + '/api/lms/attempt?id=' + passed.id)).json())
      .score,
    100,
  );
  await page.getByRole('button', { name: 'Tải lại báo cáo', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Bảng điểm học viên', exact: true })
      .getByText('v2 · Bắt buộc', { exact: true }),
  ).toBeVisible();
  stage = 'current subject grant removal hides rows and detail';
  const oldGrant = (
    await pool.query(
      "SELECT active FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code='aio-lms-sandbox'",
      [ids.learner, ids.tenantA],
    )
  ).rows[0].active;
  const restoreGrant = () =>
    mutateFixture(
      "UPDATE application_grants SET active=$1,revision=revision+1 WHERE account_id=$2 AND tenant_id=$3 AND app_code='aio-lms-sandbox'",
      [oldGrant, ids.learner, ids.tenantA],
    );
  restore.push(restoreGrant);
  await mutateFixture(
    "UPDATE application_grants SET active=false,revision=revision+1 WHERE account_id=$1 AND tenant_id=$2 AND app_code='aio-lms-sandbox'",
    [ids.learner, ids.tenantA],
  );
  assert.equal((await (await admin.context.request.get(reportUrl)).json()).total, 2);
  await learnerRow.getByRole('button', { name: 'Chi tiết', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Bảng điểm học viên', exact: true })
      .getByRole('row')
      .filter({ hasText: learner.me.displayName }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await restoreGrant();
  restore.pop();
  stage = 'Directory capability revocation and setup preservation';
  const restorePermission = () =>
    mutateFixture(
      "INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,'aio-lms-sandbox','manager','directory:lookup') ON CONFLICT DO NOTHING",
      [ids.tenantA],
    );
  restore.push(restorePermission);
  await mutateFixture(
    "DELETE FROM role_permissions WHERE tenant_id=$1 AND app_code='aio-lms-sandbox' AND role_code='manager' AND permission='directory:lookup'",
    [ids.tenantA],
  );
  await status(await manager.context.request.get(reportUrl), 403);
  await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'scripts/lms-directory-setup.ts'],
    { windowsHide: true, timeout: 90000 },
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM role_permissions WHERE tenant_id=$1 AND app_code='aio-lms-sandbox' AND role_code='manager' AND permission='directory:lookup'",
        [ids.tenantA],
      )
    ).rowCount,
    0,
  );
  await restorePermission();
  restore.pop();
  await status(await manager.context.request.get(reportUrl));
  assert.equal(transportFailed, false);
  await writeFile(
    '.local/evidence/lms-reports-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans,
        courseId: draft.id,
        checks: [
          'SSO/MFA and app-bound Directory proof; no public subject/email leaks',
          'Authoritative names, unit scoping and learner report denial',
          'Exact gradebook best score/attempts/mandatory/optional/overdue definitions',
          'Actual XLSX four-sheet export, same-key retry and changed-data rejection',
          'New version resets current gradebook while old result survives',
          'Live target grant revocation clears row/detail; lookup permission removal persists across setup',
          'Desktop/mobile/keyboard/axe',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: gradebook, current Directory, scoped XLSX, revocation/version rules and ' +
      scans.length +
      ' axe scans.',
  );
} catch (error) {
  if (error instanceof Error)
    console.error(
      error.stack?.match(/lms-reports-e2e\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable',
    );
  console.error(
    'LMS report E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  if (
    current &&
    !current.isClosed() &&
    new URL(current.url()).origin === base &&
    new URL(current.url()).pathname === '/' &&
    !(await current.locator('input[type=password],#otp').count())
  )
    await current.screenshot({ path: '.local/evidence/lms-report-failure.png', fullPage: true });
  process.exitCode = 1;
} finally {
  for (const undo of restore.reverse())
    try {
      await undo();
    } catch {
      console.error('Report fixture restoration requires review.');
      process.exitCode = 1;
    }
  await browser.close();
  await worker?.mf.dispose();
  if (app) {
    app.server.closeAllConnections();
    await app.close();
  }
  await pool.end();
}
