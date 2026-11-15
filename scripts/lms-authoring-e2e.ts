import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp } from './local-totp.js';
import { recordedLmsVideo } from './lms-video-fixture.js';
import type { FormsFixture } from './forms-fixtures.js';
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104';
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const user = fixtures.users.find((u) => u.role === 'publisher')!;
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
  page = await context.newPage();
let app: Awaited<ReturnType<typeof createApp>> | undefined,
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
let stage = 'startup';
const scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
async function scan(screen: string) {
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
  await page.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective),
    );
  });
  stage = 'SSO and authoring tab';
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  await page.locator('#otp').fill(await nextFixtureOtp(user.id));
  await page.locator('#kc-login').click();
  await page.waitForURL(base + '/');
  await page.getByRole('tab', { name: 'Khóa học & nội dung', exact: true }).click();
  await page.getByRole('button', { name: 'Tạo khóa học', exact: true }).click();
  const title = 'Khóa học UI ' + randomUUID().slice(0, 6);
  await page.getByLabel('Tên khóa học', { exact: true }).fill(title);
  await page.getByLabel('Mô tả ngắn', { exact: true }).fill('Nghiệm thu upload và trình học local');
  const unitRefs = await (await page.request.get(base + '/api/lms/lookups')).json();
  const ownUnit = unitRefs.units.find((unit: { id: string }) => unit.id === unitRefs.ownUnitId);
  assert.ok(ownUnit);
  await page.getByRole('checkbox', { name: ownUnit.name, exact: true }).check();
  await scan('course-info');
  stage = 'Unsaved edit protection';
  await page.getByRole('button', { name: 'Danh sách khóa học', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Bỏ thay đổi chưa lưu?', exact: true }),
  ).toBeVisible();
  await scan('course-discard-dialog');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByLabel('Tên khóa học', { exact: true })).toHaveValue(title);
  await page.getByRole('tab', { name: 'Lịch sử của tôi', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Tiếp tục chỉnh sửa', exact: true })
    .click();
  await expect(page.getByLabel('Tên khóa học', { exact: true })).toHaveValue(title);
  stage = 'Real video upload';
  const footage = await recordedLmsVideo(page);
  await page.getByRole('tab', { name: 'Video & tài liệu', exact: true }).click();
  const upload = page.getByRole('group', { name: 'Tải video lên', exact: true });
  await upload
    .getByLabel('Tải video lên', { exact: true })
    .setInputFiles({ name: 'video-nghiem-thu.webm', mimeType: 'video/webm', buffer: footage });
  await upload.getByRole('button', { name: 'Tải file', exact: true }).click();
  await expect(upload.getByText('File đã lưu', { exact: true })).toBeVisible();
  const video = page.getByLabel('Xem trước video khóa học', { exact: true });
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThan(0);
  await video.evaluate(async (v) => {
    const media = v as HTMLVideoElement;
    media.muted = true;
    await media.play();
  });
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.2);
  await video.evaluate((v) => (v as HTMLVideoElement).pause());
  await page.getByLabel('Thời lượng (giây)', { exact: true }).fill('1.8');
  stage = 'Document upload';
  const documentUpload = page.getByRole('group', { name: 'Tải tài liệu lên', exact: true });
  await documentUpload.getByLabel('Tải tài liệu lên', { exact: true }).setInputFiles({
    name: 'tai-lieu.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% Local LMS fixture\n%%EOF'),
  });
  await documentUpload.getByRole('button', { name: 'Tải file', exact: true }).click();
  await expect(documentUpload.getByText('File đã lưu', { exact: true })).toBeVisible();
  await scan('course-media');
  await page.screenshot({
    path: '.local/evidence/lms-authoring-media.png',
    fullPage: true,
    animations: 'disabled',
  });
  stage = 'Checkpoint and quiz editor';
  await page.getByRole('tab', { name: /^Điểm dừng/ }).click();
  await page.getByRole('button', { name: 'Thêm điểm dừng', exact: true }).click();
  await page.getByLabel('Câu hỏi tại điểm dừng', { exact: true }).fill('Đâu là bước đầu tiên?');
  await page.getByLabel('Điểm dừng (giây)', { exact: true }).fill('0.5');
  await scan('course-checkpoint');
  await page.getByRole('tab', { name: /^Bài kiểm tra/ }).click();
  await page.getByRole('button', { name: 'Thêm câu hỏi', exact: true }).click();
  await page
    .getByLabel('Câu hỏi bài kiểm tra', { exact: true })
    .fill('Chọn đáp án đúng của bài học');
  await page
    .getByRole('checkbox', { name: 'Đáp án đúng 2 — Chọn đáp án đúng của bài học', exact: true })
    .check();
  await page.getByRole('button', { name: 'Thêm câu hỏi', exact: true }).click();
  await page.getByLabel('Câu hỏi bài kiểm tra', { exact: true }).last().fill('Từ khóa của bài học');
  await page.getByRole('combobox', { name: 'Loại câu hỏi', exact: true }).last().click();
  await page.getByRole('option', { name: 'Nhập đáp án', exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await page.getByLabel('Đáp án chuẩn', { exact: true }).fill('an toàn');
  await scan('course-quiz');
  await page.setViewportSize({ width: 390, height: 844 });
  await scan('course-quiz-mobile');
  await page.screenshot({
    path: '.local/evidence/lms-authoring-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'Save and publish UI';
  await expect(page.getByRole('button', { name: 'Phát hành', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(page.getByText('Đã lưu bản nháp khóa học.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Phát hành', exact: true }).click();
  await expect(
    page.getByText('Đã phát hành phiên bản 1. Học viên được cấp có thể bắt đầu học.', {
      exact: true,
    }),
  ).toBeVisible();
  const list = await (await page.request.get(base + '/api/lms/manage/courses')).json();
  const course = list.items.find((c: { spec: { title: string } }) => c.spec.title === title);
  assert.ok(course?.versionId);
  assert.equal(course.spec.questions.length, 2);
  assert.equal(course.spec.checkpoints[0].time, 0.5);
  assert.equal(course.spec.attachments.length, 1);
  assert.equal(course.spec.video.kind, 'file');
  await page.getByRole('tab', { name: 'Thông tin', exact: true }).click();
  await page.getByLabel('Tên khóa học', { exact: true }).fill(title + ' chưa lưu');
  await page.getByRole('button', { name: 'Danh sách khóa học', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Bỏ thay đổi', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('textbox', { name: 'Tìm khóa học quản lý', exact: true }).fill(title);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await scan('course-manager');
  await page.screenshot({
    path: '.local/evidence/lms-authoring-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Ngừng phát hành', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Ngừng phát hành', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('Đã ngừng', { exact: true })).toBeVisible();
  await writeFile(
    '.local/evidence/lms-authoring-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        checks: [
          'MFA admin creates course through UI',
          'Generated real WebM uploaded and decoded by Chromium',
          'PDF attachment persisted',
          'Checkpoint and single/text quiz edited',
          'Draft saved, published and archived through UI',
        ],
        scans,
        courseId: course.id,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: LMS authoring UI, real media playback, publication, archive and ' +
      scans.length +
      ' axe scans.',
  );
} catch (error) {
  if (error instanceof Error && /__name|is not defined|Cannot access/.test(error.message))
    console.error(error.message.split('\n')[0]);
  if (error instanceof Error)
    console.error(
      error.stack?.match(/lms-authoring-e2e\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable',
    );
  console.error(
    'LMS authoring failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  if (
    new URL(page.url()).origin === base &&
    new URL(page.url()).pathname === '/' &&
    !(await page.locator('input[type=password],#otp').count())
  )
    await page.screenshot({ path: '.local/evidence/lms-authoring-failure.png', fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
  await worker?.mf.dispose();
  if (app) {
    app.server.closeAllConnections();
    await app.close();
  }
}
