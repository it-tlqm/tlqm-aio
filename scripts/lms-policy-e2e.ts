import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { defaultLearningPolicy } from '../src/lms/learning-policy.js';
import { recordedLmsVideo } from './lms-video-fixture.js';
import { chromium, expect } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp } from './local-totp.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';

const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104';
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixtures.users.find((user) => user.role === name)!;
const browser = await chromium.launch({ headless: true });
let foundation: Awaited<ReturnType<typeof createApp>> | undefined,
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
let stage = 'startup';
let current: Page | undefined;
const scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
const checks: string[] = [];
async function login(user: { id: string; username: string; password: string }, mfa = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  await context.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(e.violatedDirective),
    );
  });
  current = page;
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
  const response = await context.request.get(base + '/api/v1/me');
  assert.equal(response.status(), 200);
  return { context, page, me: (await response.json()) as { csrfToken: string } };
}
async function send(
  user: { context: BrowserContext; me: { csrfToken: string } },
  action: string,
  data: unknown,
  expected = 200,
  key = randomUUID(),
) {
  const response = await user.context.request.post(base + '/api/lms/commands', {
    headers: { origin: base, 'x-csrf-token': user.me.csrfToken, 'idempotency-key': key },
    data: { action, data, reason: 'Nghiệm thu LMS chức năng giả lập' },
  });
  if (response.status() !== expected) {
    const body = await response.json().catch(() => ({}));
    console.error(
      'Course HTTP ' +
        response.status() +
        '/' +
        expected +
        (typeof body.error === 'string' && /^[A-Z0-9_]+$/.test(body.error) ? ' ' + body.error : ''),
    );
  }
  assert.equal(response.status(), expected);
  return await response.json();
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
      JSON.stringify(
        result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
      ),
    );
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp), []);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: '.local/evidence/lms-policy-' + screen + '.png', fullPage: true });
}
async function choose(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}
try {
  foundation = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((c) => c.code === 'aio-foundation')!,
    test: true,
    logger: false,
  });
  await foundation.listen({ host: '127.0.0.1', port: 4100 });
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  stage = 'Real SSO and local video fixture';
  const admin = await login(role('publisher'), true),
    learner = await login(runtime.users.find((u) => u.id === ids.learner)!);
  const footage = await recordedLmsVideo(admin.page),
    mediaId = randomUUID();
  const upload = await admin.context.request.post(base + '/api/lms/media', {
    headers: {
      origin: base,
      'content-type': 'video/webm',
      'x-csrf-token': admin.me.csrfToken,
      'idempotency-key': randomUUID(),
      'x-media-id': mediaId,
      'x-owner-unit-id': ids.unitA,
      'x-file-name': 'policy-fixture.webm',
      'x-file-size': String(footage.length),
      'x-file-sha256': createHash('sha256').update(footage).digest('hex'),
    },
    data: footage,
  });
  assert.equal(upload.status(), 200);
  assert.equal((await upload.json()).id, mediaId);
  const title = 'Chính sách đào tạo ' + randomUUID().slice(0, 6);
  const spec: CourseSpec = {
    schemaVersion: 1,
    title,
    subtitle: 'Cấu hình và nghiệm thu dữ liệu giả lập',
    series: 'Nền tảng TLQM',
    duration: 2,
    video: { kind: 'file', id: mediaId },
    deadline: '2026-12-31',
    isMandatory: true,
    audienceUnits: [ids.unitA],
    checkpoints: [],
    questions: [1, 2, 3].map((i) => ({
      id: 'q' + i,
      type: 'single',
      question: 'Câu kiểm tra ' + i,
      options: ['Đúng ' + i, 'Sai ' + i],
    })),
    answerKey: Object.fromEntries(
      [1, 2, 3].map((i) => ['q' + i, { answer: 0, explanation: 'Đáp án giả lập' }]),
    ),
    attachments: [],
  };
  const saved = await send(admin, 'save-course', {
    code: 'policy-' + randomUUID().slice(0, 8),
    ownerUnitId: ids.unitA,
    expectedRevision: 0,
    spec,
  });
  stage = 'Admin configures grading, attempts and learning requirements through UI';
  await admin.page.getByRole('tab', { name: 'Khóa học & nội dung', exact: true }).click();
  await admin.page.getByRole('textbox', { name: 'Tìm khóa học quản lý', exact: true }).fill(title);
  await admin.page.getByRole('button', { name: 'Thiết kế', exact: true }).click();
  await admin.page.getByRole('tab', { name: 'Chính sách học & thi', exact: true }).click();
  await admin.page.getByLabel('Điểm đạt (1–100)', { exact: true }).fill('60');
  await admin.page.getByLabel('Số lần nộp tối đa', { exact: true }).fill('2');
  await admin.page.getByLabel('Chờ giữa hai lần nộp (phút)', { exact: true }).fill('60');
  const checkbox = admin.page.getByRole('checkbox', {
    name: 'Hoàn thành video trước khi thi',
    exact: true,
  });
  await checkbox.focus();
  await admin.page.keyboard.press('Space');
  await expect(checkbox).not.toBeChecked();
  await choose(admin.page, 'Yêu cầu tại điểm dừng', 'Không bắt buộc điểm dừng');
  await scan(admin.page, 'settings-desktop');
  await admin.page.setViewportSize({ width: 390, height: 844 });
  await scan(admin.page, 'settings-mobile');
  await admin.page.setViewportSize({ width: 1440, height: 1000 });
  await admin.page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(admin.page.getByText('Đã lưu bản nháp khóa học.', { exact: true })).toBeVisible();
  await admin.page.getByRole('button', { name: 'Phát hành', exact: true }).click();
  await expect(
    admin.page.getByText('Đã phát hành phiên bản 1. Học viên được cấp có thể bắt đầu học.', {
      exact: true,
    }),
  ).toBeVisible();
  const managed = (
    await (await admin.context.request.get(base + '/api/lms/manage/courses')).json()
  ).items.find((c: { id: string }) => c.id === saved.id);
  assert.equal(managed.spec.schemaVersion, 3);
  assert.equal(managed.spec.policy.passScore, 60);
  assert.equal(managed.spec.policy.maxAttempts, 2);
  const prerequisiteVersionId = managed.versionId;
  const nextSpec = {
    ...spec,
    title: title + ' nâng cao',
    schemaVersion: 3 as const,
    policy: {
      ...defaultLearningPolicy,
      requireVideoCompletion: false,
      checkpointPolicy: 'none' as const,
      prerequisiteVersionIds: [],
    },
  };
  const next = await send(admin, 'save-course', {
    code: 'advanced-' + randomUUID().slice(0, 8),
    ownerUnitId: ids.unitA,
    expectedRevision: 0,
    spec: nextSpec,
  });
  await admin.page.getByRole('button', { name: 'Danh sách khóa học', exact: true }).click();
  await admin.page
    .getByRole('textbox', { name: 'Tìm khóa học quản lý', exact: true })
    .fill(nextSpec.title);
  await admin.page.getByRole('button', { name: 'Thiết kế', exact: true }).click();
  await admin.page.getByRole('tab', { name: 'Chính sách học & thi', exact: true }).click();
  await admin.page
    .getByRole('textbox', { name: 'Tìm khóa học tiên quyết', exact: true })
    .fill(title);
  await admin.page.getByRole('checkbox', { name: title + ' · phiên bản 1', exact: true }).check();
  await admin.page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(admin.page.getByText('Đã lưu bản nháp khóa học.', { exact: true })).toBeVisible();
  await admin.page.getByRole('button', { name: 'Phát hành', exact: true }).click();
  await expect(
    admin.page.getByText('Đã phát hành phiên bản 1. Học viên được cấp có thể bắt đầu học.', {
      exact: true,
    }),
  ).toBeVisible();
  const nextPublished = (
    await (await admin.context.request.get(base + '/api/lms/manage/courses')).json()
  ).items.find((c: { id: string }) => c.id === next.id);
  assert.deepEqual(nextPublished.spec.policy.prerequisiteVersionIds, [prerequisiteVersionId]);
  stage = 'Prerequisite enforced by content and command APIs';
  assert.equal(
    (
      await learner.context.request.get(
        base + '/api/lms/course?versionId=' + nextPublished.versionId,
      )
    ).status(),
    409,
  );
  await send(
    learner,
    'submit',
    { versionId: nextPublished.versionId, answers: { q1: 0, q2: 0, q3: 0 }, tabSwitchCount: 0 },
    409,
  );
  await learner.page.reload();
  await learner.page.getByRole('button', { name: 'Bắt đầu học: ' + title, exact: true }).click();
  await expect(
    learner.page.getByRole('button', { name: 'Làm bài kiểm tra', exact: true }),
  ).toBeEnabled();
  await scan(learner.page, 'learner-policy');
  await learner.page.getByRole('button', { name: 'Làm bài kiểm tra', exact: true }).click();
  for (const [index, answer] of [
    [1, 'Đúng 1'],
    [2, 'Đúng 2'],
    [3, 'Sai 3'],
  ] as const) {
    await learner.page.getByRole('radio', { name: answer, exact: true }).check();
  }
  await learner.page.getByRole('button', { name: 'Nộp bài kiểm tra', exact: true }).click();
  await learner.page
    .getByRole('dialog')
    .getByRole('button', { name: 'Xác nhận nộp bài', exact: true })
    .click();
  await expect(
    learner.page.getByRole('heading', { name: 'Kết quả bài kiểm tra', exact: true }),
  ).toBeVisible();
  await scan(learner.page, 'passing-result');
  await learner.page.setViewportSize({ width: 390, height: 844 });
  await scan(learner.page, 'passing-result-mobile');
  const history = (
    await (await learner.context.request.get(base + '/api/lms/history')).json()
  ).items.find((a: { versionId: string }) => a.versionId === prerequisiteVersionId);
  assert.equal(history.score, 67);
  assert.equal(history.passed, true);
  await send(learner, 'issue-certificate', { attemptId: history.id });
  await learner.page.getByRole('button', { name: 'Quay lại', exact: true }).click();
  await expect(
    learner.page.getByRole('button', { name: 'Làm bài kiểm tra', exact: true }),
  ).toBeDisabled();
  await expect(learner.page.getByText(/Có thể nộp tiếp từ/)).toBeVisible();
  await scan(learner.page, 'cooldown-mobile');

  await send(
    learner,
    'submit',
    { versionId: prerequisiteVersionId, answers: { q1: 0, q2: 0, q3: 0 }, tabSwitchCount: 0 },
    409,
  );
  assert.equal(
    (
      await learner.context.request.get(
        base + '/api/lms/course?versionId=' + nextPublished.versionId,
      )
    ).status(),
    200,
  );
  const report = await admin.context.request.get(base + '/api/lms/report?courseId=' + saved.id);
  assert.equal(report.status(), 200);
  assert.ok(
    (await report.json()).items.some((r: { cells: { state: string }[] }) =>
      r.cells.some((c) => c.state === 'passed'),
    ),
  );
  await send(
    learner,
    'save-course',
    {
      courseId: saved.id,
      code: managed.code,
      ownerUnitId: ids.unitA,
      expectedRevision: managed.revision,
      spec: managed.spec,
    },
    403,
  );
  await writeFile(
    '.local/evidence/lms-policy-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans,
        courseId: saved.id,
        checks: [
          'MFA admin configures policy through shadcn UI',
          'keyboard and 390px mobile',
          'real local video source',
          '67 points passes threshold 60 in results, certificate and report',
          'cooldown denied server-side',
          'prerequisite denies direct reads and submission until passing',
          'learner authoring remains forbidden',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS LMS configurable policy via real SSO; ' + scans.length + ' axe scans.');
} catch (error) {
  console.error(
    'LMS policy failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error('Numeric assertion ' + error.actual + '/' + error.expected);
  if (error instanceof Error)
    console.error(
      error.stack?.match(/lms-policy-e2e\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable',
    );
  if (
    current &&
    !current.isClosed() &&
    new URL(current.url()).origin === base &&
    new URL(current.url()).pathname === '/' &&
    !(await current.locator('input[type=password],#otp').count())
  )
    await current.screenshot({ path: '.local/evidence/lms-policy-failure.png', fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
  await worker?.mf.dispose();
  foundation?.server.closeAllConnections();
  await foundation?.close();
}
