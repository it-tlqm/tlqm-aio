import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp } from './local-totp.js';
import { recordedLmsVideo } from './lms-video-fixture.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104';
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const browser = await chromium.launch({ headless: true });
let app: Awaited<ReturnType<typeof createApp>> | undefined,
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
let stage = 'startup',
  current: Page | undefined;
const scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
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
  return {
    context,
    page,
    me: (await (await context.request.get(base + '/api/v1/me')).json()) as { csrfToken: string },
  };
}
async function scan(page: Page, screen: string) {
  current = page;
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
    violations: result.violations.map((v) => v.id),
    incomplete: result.incomplete.map((v) => v.id),
  });
  if (result.violations.length)
    console.error(
      JSON.stringify({
        screen,
        issues: result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
      }),
    );
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp), []);
}
try {
  const client = runtime.clients.find((c) => c.code === 'aio-foundation')!;
  app = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client,
    test: true,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 4100 });
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  stage = 'Demo script refuses the test marker before authentication or writes';
  const counters = async () =>
    Promise.all(
      ['aio_audit', 'aio_sessions', 'aio_login_transactions', 'lms_courses', 'lms_media'].map(
        (table) => worker!.db.prepare('SELECT COUNT(*) AS n FROM ' + table).first(),
      ),
    );
  const beforeDemo = await counters();
  await assert.rejects(
    () =>
      promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/lms-demo.ts'], {
        timeout: 20000,
      }),
    (error) => {
      const result = error as Error & { code: number; stderr: string };
      return (
        result.code === 1 &&
        result.stderr.includes('LMS demo stopped at local marker (AssertionError)')
      );
    },
  );
  assert.deepEqual(await counters(), beforeDemo);
  stage = 'MFA author and real video';
  const admin = await login(
    fixtures.users.find((u) => u.role === 'publisher')!,
    true,
  );
  const video = await recordedLmsVideo(admin.page, 5000),
    mediaId = randomUUID();
  const upload = await admin.context.request.post(base + '/api/lms/media', {
    headers: {
      origin: base,
      'x-csrf-token': admin.me.csrfToken,
      'content-type': 'video/webm',
      'x-file-name': 'learning.webm',
      'x-file-size': String(video.length),
      'x-file-sha256': createHash('sha256').update(video).digest('hex'),
      'x-media-id': mediaId,
      'x-owner-unit-id': ids.unitA,
      'idempotency-key': randomUUID(),
    },
    data: video,
  });
  assert.equal(upload.status(), 200);
  const spec: CourseSpec = {
    schemaVersion: 2,
    title: 'Học thực hành ' + randomUUID().slice(0, 6),
    subtitle: 'Video, điểm dừng và bài thi giả lập',
    series: 'Đào tạo AIO',
    duration: 4.8,
    video: { kind: 'file', id: mediaId },
    deadline: '',
    isMandatory: true,
    audienceUnits: [ids.unitA],
    checkpoints: [
      {
        id: 'cp',
        type: 'single',
        title: 'Kiểm tra trong bài',
        time: 1,
        question: 'Bước đầu tiên là gì?',
        options: ['Đối chiếu thông tin', 'Bỏ kiểm tra'],
      },
    ],
    questions: [
      {
        id: 'q1',
        type: 'single',
        question: 'Chọn một đáp án',
        options: ['Đáp án chưa đúng', 'Đáp án chính xác'],
      },
      {
        id: 'q2',
        type: 'multiple',
        question: 'Chọn hai đáp án',
        options: ['Mục A', 'Mục B', 'Mục C'],
      },
      { id: 'q3', type: 'text', question: 'Từ khóa của bài học', options: [] },
    ],
    answerKey: {
      cp: { answer: 0, explanation: 'Cần đối chiếu trước khi xử lý.' },
      q1: { answer: 1, explanation: 'Đây là đáp án đúng.' },
      q2: { answer: [0, 2], explanation: 'Cần cả A và C.' },
      q3: { answer: 'an toàn', explanation: 'Nguyên tắc an toàn.' },
    },
    attachments: [],
  };
  const write = async (action: string, data: unknown) => {
    const r = await admin.context.request.post(base + '/api/lms/commands', {
      headers: {
        origin: base,
        'x-csrf-token': admin.me.csrfToken,
        'idempotency-key': randomUUID(),
      },
      data: { action, data, reason: 'Nghiệm thu luồng học giả lập' },
    });
    assert.equal(r.status(), 200);
    return r.json();
  };
  const code = 'learner-' + randomUUID().slice(0, 8),
    draft = await write('save-course', { code, ownerUnitId: ids.unitA, expectedRevision: 0, spec }),
    published = await write('publish-course', {
      courseId: draft.id,
      expectedRevision: draft.revision,
    });
  stage = 'Assigned catalogue and scope';
  const learner = await login(runtime.users.find((u) => u.id === ids.learner)!),
    page = learner.page;
  current = page;
  await page.getByLabel('Tìm khóa học', { exact: true }).fill(spec.title);
  await expect(page.getByRole('button', { name: new RegExp(spec.title + '$') })).toBeVisible();
  await scan(page, 'learner-catalogue');
  await page.screenshot({ path: '.local/evidence/lms-catalogue-desktop.png', fullPage: true });
  const other = await login(fixtures.users.find((u) => u.role === 'respondent')!);
  await other.page.getByLabel('Tìm khóa học', { exact: true }).fill(spec.title);
  await expect(other.page.getByRole('button', { name: new RegExp(spec.title + '$') })).toHaveCount(
    0,
  );
  await other.context.close();
  current = page;
  stage = 'Playback checkpoint and note';
  await page.getByRole('button', { name: new RegExp(spec.title + '$') }).click();
  await expect(page.getByRole('button', { name: 'Làm bài kiểm tra', exact: true })).toBeDisabled();
  const player = page.getByLabel('Video bài học: ' + spec.title, { exact: true });
  await player.evaluate(async (element) => {
    const video = element as HTMLVideoElement;
    video.muted = true;
    await video.play();
  });
  const checkpoint = page.getByRole('region', { name: 'Câu hỏi tại điểm dừng', exact: true });
  await expect(checkpoint).toBeVisible();
  await expect
    .poll(() => player.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(true);
  await page.getByLabel(/^Ghi chú tại/).fill('Ghi nhớ mốc đầu tiên');
  await page.getByRole('button', { name: 'Thêm ghi chú', exact: true }).click();
  await expect(page.getByText('Ghi nhớ mốc đầu tiên', { exact: true })).toBeVisible();
  await scan(page, 'learner-checkpoint');
  await page.setViewportSize({ width: 390, height: 844 });
  await scan(page, 'learner-checkpoint-mobile');
  await page.screenshot({ path: '.local/evidence/lms-player-mobile.png', fullPage: true });
  stage = 'Resume after reload';
  await page.reload();
  await page.getByLabel('Tìm khóa học', { exact: true }).fill(spec.title);
  await page.getByRole('button', { name: new RegExp(spec.title + '$') }).click();
  await expect(checkpoint).toBeVisible();
  await expect(page.getByText('Ghi nhớ mốc đầu tiên', { exact: true })).toBeVisible();
  const resumed = await (
    await learner.context.request.get(base + '/api/lms/course?versionId=' + published.versionId)
  ).json();
  assert.equal(resumed.progress.position, 1);
  assert.equal(resumed.notes.length, 1);
  await checkpoint.getByRole('radio', { name: 'Đối chiếu thông tin', exact: true }).check();
  await checkpoint.getByRole('button', { name: 'Gửi câu trả lời', exact: true }).click();
  await expect(checkpoint.getByText(/Câu trả lời đúng/)).toBeVisible();
  await page.getByRole('button', { name: 'Tiếp tục học', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Làm bài kiểm tra', exact: true })).toBeEnabled({
    timeout: 12000,
  });
  await page.getByRole('button', { name: 'Xóa ghi chú Ghi nhớ mốc đầu tiên', exact: true }).click();
  await expect(page.getByText('Ghi nhớ mốc đầu tiên', { exact: true })).toHaveCount(0);
  async function answerQuiz(correct: boolean) {
    await page.getByRole('button', { name: 'Làm bài kiểm tra', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Nộp bài kiểm tra', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('radio', { name: correct ? 'Đáp án chính xác' : 'Đáp án chưa đúng', exact: true })
      .check();
    await page.getByRole('checkbox', { name: 'Mục A', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Mục C', exact: true }).check();
    await page.getByLabel('Câu trả lời', { exact: true }).fill(' AN   TOÀN ');
  }
  async function submitQuiz() {
    await page.getByRole('button', { name: 'Nộp bài kiểm tra', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Xác nhận nộp bài', exact: true })
      .click();
  }
  stage = 'Three question types, grading and review';
  await answerQuiz(false);
  await scan(page, 'learner-quiz-mobile');
  await page.screenshot({ path: '.local/evidence/lms-quiz-mobile.png', fullPage: true });
  await page.getByRole('tab', { name: 'Kết quả học tập', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Tiếp tục chỉnh sửa', exact: true })
    .click();
  await expect(page.getByLabel('Câu trả lời', { exact: true })).toHaveValue(' AN   TOÀN ');
  await submitQuiz();
  await expect(page.getByText('Chưa đạt · Cần từ 80 điểm', { exact: true })).toBeVisible();
  await scan(page, 'learner-result');
  await page.getByRole('button', { name: 'Quay lại', exact: true }).click();
  await answerQuiz(true);
  await submitQuiz();
  await expect(page.getByText('Đạt yêu cầu', { exact: true })).toBeVisible();
  stage = 'Intentional retake and network retry are distinct';
  await page.getByRole('button', { name: 'Quay lại', exact: true }).click();
  await answerQuiz(true);
  let drop = true;
  const keys: string[] = [];
  await page.route('**/api/lms/commands', async (route) => {
    const body = route.request().postDataJSON() as { action: string };
    if (body.action === 'submit') {
      keys.push(route.request().headers()['idempotency-key']!);
      if (drop) {
        drop = false;
        const committed = await route.fetch();
        assert.equal(committed.status(), 200);
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });
  await submitQuiz();
  await expect(page.getByRole('alert')).toBeVisible();
  await submitQuiz();
  await expect(page.getByText('Đạt yêu cầu', { exact: true })).toBeVisible();
  await page.unroute('**/api/lms/commands');
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  const history = await (await learner.context.request.get(base + '/api/lms/history')).json();
  const attempts = history.items.filter(
    (row: { versionId: string }) => row.versionId === published.versionId,
  );
  assert.equal(attempts.length, 3);
  assert.equal(attempts.filter((row: { score: number }) => row.score === 100).length, 2);
  stage = 'History version snapshot and live access';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('tab', { name: 'Kết quả học tập', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: spec.title })
    .first()
    .getByRole('button', { name: 'Xem bài làm', exact: true })
    .click();
  await expect(page.getByText(spec.title, { exact: true })).toBeVisible();
  await scan(page, 'learner-history-detail');
  await page.screenshot({ path: '.local/evidence/lms-result-desktop.png', fullPage: true });
  stage = 'Certificate issuance, download, print and authorized lookup';
  const failedAttempt = attempts.find((row: { score: number }) => row.score < 80)!;
  const rejected = await learner.context.request.post(base + '/api/lms/commands', {
    headers: {
      origin: base,
      'x-csrf-token': learner.me.csrfToken,
      'idempotency-key': randomUUID(),
    },
    data: {
      action: 'issue-certificate',
      data: { attemptId: failedAttempt.id },
      reason: 'Nghiệm thu chứng nhận giả lập',
    },
  });
  assert.equal(rejected.status(), 409);
  assert.equal((await rejected.json()).error, 'LMS_CERTIFICATE_NOT_ELIGIBLE');
  await page.getByRole('button', { name: 'Chứng nhận', exact: true }).click();
  const certificateDialog = page.getByRole('dialog', { name: 'Chứng nhận học tập', exact: true });
  await expect(
    certificateDialog.getByRole('article', { name: 'Nội dung chứng nhận' }),
  ).toBeVisible();
  const certificateCode = (await certificateDialog
    .getByText(/^TLQM-[0-9A-F-]{36}$/)
    .textContent())!.trim();
  const certificateUrl = base + '/api/lms/certificate?code=' + certificateCode;
  const certificate = await (await learner.context.request.get(certificateUrl)).json();
  assert.equal(certificate.courseTitle, spec.title);
  assert.equal(certificate.score, 100);
  assert.equal(
    certificate.completedAt,
    attempts.find((row: { id: string }) => row.id === certificate.id)!.createdAt,
  );
  assert.equal('review' in certificate, false);
  await scan(page, 'certificate-desktop');
  await page.screenshot({ path: '.local/evidence/lms-certificate-desktop.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await certificateDialog.getByRole('button', { name: 'Tải ảnh PNG', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs('.local/evidence/lms-certificate-download.png');
  const metadata = await sharp('.local/evidence/lms-certificate-download.png').metadata();
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 1132);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#lms-main')).toBeHidden();
  await expect(
    certificateDialog.getByRole('button', { name: 'Tải ảnh PNG', exact: true }),
  ).toBeHidden();
  await expect(certificateDialog.getByRole('article')).toBeVisible();
  const printable = await certificateDialog.getByRole('article').boundingBox();
  if (!printable || printable.x < 0 || printable.y < 0)
    console.error(
      'Print geometry: ' +
        JSON.stringify(
          await certificateDialog.evaluate((element) => {
            const s = getComputedStyle(element),
              r = element.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              position: s.position,
              translate: s.translate,
              transform: s.transform,
              padding: s.padding,
            };
          }),
        ),
    );
  assert.ok(printable && printable.x >= 0 && printable.y >= 0 && printable.width > 500);
  await page.pdf({
    path: '.local/evidence/lms-certificate-print.pdf',
    format: 'A4',
    printBackground: true,
  });
  await page.screenshot({ path: '.local/evidence/lms-certificate-print.png', fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 390, height: 844 });
  await scan(page, 'certificate-mobile');
  await page.screenshot({ path: '.local/evidence/lms-certificate-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Chứng nhận', exact: true })).toBeFocused();
  const peer = await login(fixtures.users.find((user) => user.role === 'respondent')!);
  assert.equal((await peer.context.request.get(certificateUrl)).status(), 404);
  assert.equal(
    (await peer.context.request.get(base + '/api/lms/ranking?orgUnitId=' + ids.unitA)).status(),
    403,
  );
  await peer.context.close();
  const reviewer = await login(fixtures.users.find((user) => user.role === 'reviewer')!);
  assert.equal((await reviewer.context.request.get(certificateUrl)).status(), 200);
  await reviewer.context.close();
  assert.equal((await admin.context.request.get(certificateUrl)).status(), 200);
  current = page;
  stage = 'Scoped ranking and certificate lookup UI';
  await page.getByRole('tab', { name: 'Thành tích', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Xếp hạng trong đơn vị', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Hạng của bạn:/)).toBeVisible();
  await scan(page, 'ranking-mobile');
  await page.screenshot({ path: '.local/evidence/lms-ranking-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await scan(page, 'ranking-desktop');
  await page.screenshot({ path: '.local/evidence/lms-ranking-desktop.png', fullPage: true });
  await page.getByLabel('Mã chứng nhận', { exact: true }).fill(certificateCode);
  await page.getByRole('button', { name: 'Tra cứu chứng nhận', exact: true }).click();
  await expect(certificateDialog.getByText(spec.title, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const nextSpec = {
    ...spec,
    title: spec.title + ' mới',
    answerKey: { ...spec.answerKey, q1: { answer: 0, explanation: 'Phiên bản mới' } },
  };
  const nextDraft = await write('save-course', {
    courseId: draft.id,
    code,
    ownerUnitId: ids.unitA,
    expectedRevision: published.revision,
    spec: nextSpec,
  });
  const nextVersion = await write('publish-course', {
    courseId: draft.id,
    expectedRevision: nextDraft.revision,
  });
  assert.deepEqual(await (await learner.context.request.get(certificateUrl)).json(), certificate);
  await page.getByRole('tab', { name: 'Khóa học', exact: true }).click();
  await page.getByLabel('Tìm khóa học', { exact: true }).fill(nextSpec.title);
  await page.getByRole('button', { name: new RegExp(nextSpec.title + '$') }).click();
  await expect(page.getByRole('button', { name: 'Lưu tiến độ', exact: true })).toBeEnabled();
  await write('course-status', {
    courseId: draft.id,
    expectedRevision: nextVersion.revision,
    status: 'archived',
  });
  await page.getByRole('button', { name: 'Lưu tiến độ', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: nextSpec.title, exact: true })).toHaveCount(0);
  assert.deepEqual(await (await learner.context.request.get(certificateUrl)).json(), certificate);
  stage = 'Grant revocation removes certificate and ranking access on existing sessions';
  await page.getByRole('tab', { name: 'Thành tích', exact: true }).click();
  await page.getByLabel('Mã chứng nhận', { exact: true }).fill(certificateCode);
  await page.getByRole('button', { name: 'Tra cứu chứng nhận', exact: true }).click();
  await expect(certificateDialog.getByText(spec.title, { exact: true })).toBeVisible();
  const pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime) });
  let revocationPoolFailed = false;
  pool.on('error', () => {
    revocationPoolFailed = true;
    console.error('Learner E2E database connection lost; details omitted.');
    process.exitCode = 1;
  });
  async function grant(active: boolean) {
    await pool.query(
      "WITH changed AS (UPDATE application_grants SET active=$1,revision=revision+1 WHERE account_id=$2 AND tenant_id=$3 AND app_code='aio-lms-sandbox' RETURNING account_id) INSERT INTO audit_events(actor_account_id,subject_account_id,tenant_id,app_code,action,reason,request_id) SELECT $2,account_id,$3,'aio-lms-sandbox','test.fixture_changed','Certificate live grant test and restoration',$4 FROM changed",
      [active, ids.learner, ids.tenantA, randomUUID()],
    );
  }
  const priorGrant = (
    await pool.query(
      "SELECT active FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code='aio-lms-sandbox'",
      [ids.learner, ids.tenantA],
    )
  ).rows[0].active;
  try {
    await grant(false);
    assert.equal((await learner.context.request.get(certificateUrl)).status(), 403);
    // The first denied request revokes the opaque session. Later reads must reject
    // the now-missing session rather than keeping it alive with stale authorization.
    const revokedRanking = await learner.context.request.get(base + '/api/lms/ranking');
    assert.equal(revokedRanking.status(), 401);
    assert.equal((await revokedRanking.json()).error, 'SESSION_EXPIRED');
    assert.equal((await admin.context.request.get(certificateUrl)).status(), 404);
    const rank = await (await admin.context.request.get(base + '/api/lms/ranking')).json();
    assert.equal(
      rank.items.some((row: { code: string }) => row.code === certificate.employeeCode),
      false,
    );
    await certificateDialog.getByRole('button', { name: 'Tải ảnh PNG', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Nội dung chứng nhận' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toBeVisible();
  } finally {
    await grant(priorGrant);
    await pool.end();
  }
  assert.equal(revocationPoolFailed, false, 'Database transport failed during revocation test');
  await writeFile(
    '.local/evidence/lms-learner-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        checks: [
          'Assigned catalogue default and unit isolation',
          'Real native playback stops at checkpoint',
          'Resume at saved checkpoint with note; note ownership actions',
          'Single/multiple/text quiz graded on server; immutable history',
          'Three explicit attempts; network retry creates no duplicate',
          'Archive on existing session clears player/content on next action',
          'Demo script rejected test marker before any login or mutation',
          'Passing attempt certificate, immutable after republish/archive, authorized verification, PNG and print output',
          'Unit ranking and real grant revocation deny reads/download on existing sessions',
        ],
        scans,
        courseId: draft.id,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: LMS learner catalogue, real player, resume, checkpoint, notes, quiz, retry, history and ' +
      scans.length +
      ' axe scans.',
  );
} catch (error) {
  if (error instanceof Error)
    console.error(
      error.stack?.match(/lms-learner-e2e\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable',
    );
  console.error(
    'LMS learner E2E failed at ' +
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
    await current.screenshot({ path: '.local/evidence/lms-learner-failure.png', fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
  await worker?.mf.dispose();
  if (app) {
    app.server.closeAllConnections();
    await app.close();
  }
}
