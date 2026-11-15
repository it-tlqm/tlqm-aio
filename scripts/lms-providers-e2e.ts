import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp } from './local-totp.js';
import { recordedLmsVideo } from './lms-video-fixture.js';
import {
  youtubeSdkFixture,
  vimeoSdkFixture,
  providerFrameFixture,
} from './lms-provider-fixtures.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { CourseSpec, VideoSource } from '../src/lms/course-contracts.js';
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104';
const receipt = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(receipt.instanceId, runtime.instanceId);
const browser = await chromium.launch({ headless: true });
let app: Awaited<ReturnType<typeof createApp>> | undefined,
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
let stage = 'startup';
let currentPage: Page | undefined;
const checks: string[] = [];
async function login(user: { id: string; username: string; password: string }, mfa = false) {
  const context = await browser.newContext(),
    page = await context.newPage();
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
async function enter(page: Page, title: string) {
  await page.getByRole('tab', { name: 'Khóa học', exact: true }).click();
  await page.getByLabel('Tìm khóa học', { exact: true }).fill(title);
  await page.getByRole('button', { name: new RegExp(title + '$') }).click();
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
  const admin = await login(
      receipt.users.find((u) => u.role === 'publisher')!,
      true,
    ),
    learner = await login(runtime.users.find((u) => u.id === ids.learner)!);
  const write = async (action: string, data: unknown) => {
    const r = await admin.context.request.post(base + '/api/lms/commands', {
      headers: {
        origin: base,
        'x-csrf-token': admin.me.csrfToken,
        'idempotency-key': randomUUID(),
      },
      data: { action, data, reason: 'Provider contract fixture' },
    });
    assert.equal(r.status(), 200);
    return r.json();
  };
  const footage = await recordedLmsVideo(admin.page, 4000);
  const make = async (source: VideoSource) => {
    const spec: CourseSpec = {
      schemaVersion: 2,
      title: 'Provider ' + source.kind + ' ' + randomUUID().slice(0, 6),
      subtitle: 'Controlled provider conformance',
      series: 'Test',
      duration: source.kind === 'vimeo' ? 7 : 3,
      video: source,
      deadline: '',
      isMandatory: false,
      audienceUnits: [ids.unitA],
      checkpoints: [
        {
          id: 'cp',
          type: 'single',
          title: 'Điểm kiểm tra',
          time: 1,
          question: 'Đã xem mốc đầu?',
          options: ['Đã xem', 'Chưa xem'],
        },
      ],
      questions: [{ id: 'q', type: 'single', question: 'Nội dung kiểm thử?', options: ['A', 'B'] }],
      answerKey: {
        cp: { answer: 0, explanation: 'Fixture' },
        q: { answer: 0, explanation: 'Fixture' },
      },
      attachments: [],
    };
    const draft = await write('save-course', {
      code: 'provider-' + randomUUID().slice(0, 8),
      ownerUnitId: ids.unitA,
      expectedRevision: 0,
      spec,
    });
    const pub = await write('publish-course', { courseId: draft.id, expectedRevision: 1 });
    return { spec, draft, pub };
  };
  for (const kind of ['youtube', 'vimeo', 'gdrive', 'direct'] as const) {
    stage = 'Provider ' + kind;
    const source: VideoSource =
      kind === 'direct'
        ? { kind, url: 'https://media.example.com/fixture.webm' }
        : {
            kind,
            id:
              kind === 'youtube' ? 'M7lc1UVf-VE' : kind === 'vimeo' ? '12345678' : 'abc_DEF-123456',
          };
    const course = await make(source);
    const page = learner.page;
    currentPage = page;
    await page.goto(base + '/');
    await page.route('https://www.youtube.com/iframe_api', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: youtubeSdkFixture }),
    );
    await page.route('https://player.vimeo.com/api/player.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: vimeoSdkFixture }),
    );
    await page.route('https://www.youtube-nocookie.com/embed/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: providerFrameFixture }),
    );
    await page.route('https://player.vimeo.com/video/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: providerFrameFixture }),
    );
    await page.route('https://drive.google.com/file/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><body>Drive preview fixture</body></html>',
      }),
    );
    await page.route('https://media.example.com/fixture.webm', (route) =>
      route.fulfill({ contentType: 'video/webm', body: footage }),
    );
    let youtubeReferrer: string | undefined;
    page.on('request', (request) => {
      if (request.url().startsWith('https://www.youtube-nocookie.com/embed/'))
        youtubeReferrer = request.headers().referer;
    });
    await enter(page, course.spec.title);
    const cp = page.getByRole('region', { name: 'Câu hỏi tại điểm dừng', exact: true });
    if (kind === 'direct')
      await page.locator('video').evaluate(async (element) => {
        const video = element as HTMLVideoElement;
        video.muted = true;
        await video.play();
      });
    else if (kind === 'gdrive') {
      const denied = await learner.context.request.post(base + '/api/lms/commands', {
        headers: {
          origin: base,
          'x-csrf-token': learner.me.csrfToken,
          'idempotency-key': randomUUID(),
        },
        data: {
          action: 'progress',
          data: { versionId: course.pub.versionId, expectedRevision: 0, position: 1 },
          reason: 'Missing manual acknowledgement',
        },
      });
      assert.equal(denied.status(), 400);
      assert.equal((await denied.json()).error, 'LMS_MANUAL_CONFIRMATION_REQUIRED');
      await page.getByRole('button', { name: 'Tôi đã xem đến 1 giây', exact: true }).click();
    } else {
      await page.waitForFunction(() => 'aioProviderFixture' in window);
      await page.evaluate(() => {
        const fixture = (window as unknown as { aioProviderFixture: { emitInvalid: () => void } })
          .aioProviderFixture;
        fixture.emitInvalid();
      });
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(cp).toHaveCount(0);
      const untouched = await (
        await learner.context.request.get(
          base + '/api/lms/course?versionId=' + course.pub.versionId,
        )
      ).json();
      assert.equal(untouched.progress.watched, 0);
      assert.equal(untouched.progress.finished, false);
      await page
        .frameLocator('iframe')
        .getByRole('button', { name: 'Phát video kiểm thử' })
        .click();
    }
    await expect(cp).toBeVisible({ timeout: 12000 });
    if (kind === 'youtube') assert.equal(youtubeReferrer, base + '/');
    await cp.getByRole('radio', { name: 'Đã xem', exact: true }).check();
    await cp.getByRole('button', { name: 'Gửi câu trả lời', exact: true }).click();
    await page.getByRole('button', { name: 'Tiếp tục học', exact: true }).click();
    if (kind === 'gdrive')
      await page.getByRole('button', { name: 'Tôi đã xem hết video', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Làm bài kiểm tra', exact: true })).toBeEnabled({
      timeout: 12000,
    });
    const detail = await (
      await learner.context.request.get(base + '/api/lms/course?versionId=' + course.pub.versionId)
    ).json();
    assert.equal(detail.progress.finished, true);
    assert.deepEqual(detail.progress.answeredCheckpoints, ['cp']);
    if (kind === 'vimeo') assert.equal(detail.progress.position, course.spec.duration);
    const audit: { details: string } | null = await worker.db
      .prepare(
        "SELECT details FROM aio_audit WHERE action='learning.progress_saved' AND employee_id=? ORDER BY id DESC LIMIT 1",
      )
      .bind('legacy-lms-a')
      .first<{ details: string }>();
    assert.equal(
      JSON.parse(audit!.details).tracking,
      kind === 'gdrive' ? 'self-confirmed' : 'player-reported',
    );
    await page.getByRole('button', { name: 'Danh mục khóa học', exact: true }).click();
    await write('course-status', {
      courseId: course.draft.id,
      expectedRevision: course.pub.revision,
      status: 'archived',
    });
    await page.unrouteAll();
    checks.push(
      kind +
        ': checkpoint/continue/finish; ' +
        (kind === 'gdrive' ? 'explicit self-confirmation' : 'player-reported events') +
        (kind === 'direct'
          ? ' with real WebM via controlled HTTPS route'
          : ' with controlled provider fixture'),
    );
  }
  stage = 'SDK unavailable does not fabricate progress';
  const failure = await make({ kind: 'youtube', id: 'M7lc1UVf-VE' });
  await learner.page.goto(base + '/');
  await learner.page.route('https://www.youtube.com/iframe_api', (route) => route.abort('failed'));
  await enter(learner.page, failure.spec.title);
  await expect(learner.page.getByRole('alert')).toBeVisible({ timeout: 15000 });
  await expect(
    learner.page.getByRole('button', { name: 'Làm bài kiểm tra', exact: true }),
  ).toBeDisabled();
  const untouched = await (
    await learner.context.request.get(base + '/api/lms/course?versionId=' + failure.pub.versionId)
  ).json();
  assert.equal(untouched.progress.watched, 0);
  assert.equal(untouched.progress.finished, false);
  await write('course-status', {
    courseId: failure.draft.id,
    expectedRevision: failure.pub.revision,
    status: 'archived',
  });
  checks.push('SDK load failure remains visible and leaves progress unchanged');
  checks.push('Malformed YouTube and Vimeo callbacks leave the learner state unchanged');
  checks.push(
    'Vimeo saves the course limit after the last periodic save, before the provider ends',
  );
  await writeFile(
    '.local/evidence/lms-providers-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        mode: 'Controlled SDK/embed fixtures; not proof of live vendor video availability',
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: four video-source controller contracts, explicit Drive acknowledgement and SDK failure behavior.',
  );
} catch (error) {
  if (currentPage && !currentPage.isClosed() && new URL(currentPage.url()).origin === base) {
    console.error(
      JSON.stringify({
        alerts: await currentPage.getByRole('alert').allTextContents(),
        frames: currentPage.frames().map((frame) => {
          try {
            return new URL(frame.url()).origin;
          } catch {
            return 'empty';
          }
        }),
      }),
    );
    await currentPage.screenshot({
      path: '.local/evidence/lms-provider-failure.png',
      fullPage: true,
    });
  }
  if (error instanceof Error)
    console.error(
      error.stack?.match(/lms-providers-e2e\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable',
    );
  console.error(
    'LMS provider conformance failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await worker?.mf.dispose();
  if (app) {
    app.server.closeAllConnections();
    await app.close();
  }
}
