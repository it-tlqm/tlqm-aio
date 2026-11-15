import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import type { APIResponse } from '@playwright/test';
import { loadLocalConfig } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104';
let stage = 'local marker';
const browser = await chromium.launch({ headless: true });
try {
  const health = await fetch(base + '/health/ready');
  assert.equal(health.status, 200);
  const marker = (await health.json()) as {
    service: string;
    environment: string;
    instanceId: string;
  };
  assert.equal(marker.service, 'aio-lms-sandbox');
  assert.equal(marker.environment, 'tlqm-aio-lms-local');
  assert.equal(marker.instanceId, runtime.instanceId);
  const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
    instanceId: string;
    users: FormsFixture[];
  };
  assert.equal(fixtures.instanceId, runtime.instanceId);
  const user = fixtures.users.find((user) => user.role === 'publisher')!;
  const context = await browser.newContext(),
    page = await context.newPage();
  stage = 'SSO MFA operator';
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  await page.locator('#otp').fill(await nextFixtureOtp(user.id));
  await page.locator('#kc-login').click();
  await page.waitForURL(base + '/');
  await expect(
    page.getByRole('heading', { name: 'Khóa học dành cho bạn', exact: true }),
  ).toBeVisible();
  const me = (await (await context.request.get(base + '/api/v1/me')).json()) as {
    csrfToken: string;
    capabilities: Record<string, boolean>;
  };
  assert.equal(me.capabilities['lms:admin'], true);
  const code = 'aio-lms-demo-01';
  stage = 'existing demo check';
  let cursor: string | null = null,
    existing = false;
  const seen = new Set<string>();
  do {
    const listResponse: APIResponse = await context.request.get(
      base + '/api/lms/manage/courses' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert.equal(listResponse.status(), 200);
    const body = (await listResponse.json()) as {
      items: { code: string }[];
      nextCursor?: string | null;
    };
    existing = body.items.some((item) => item.code === code);
    cursor = body.nextCursor ?? null;
    if (cursor) {
      assert.equal(seen.has(cursor), false);
      seen.add(cursor);
    }
  } while (!existing && cursor);
  if (existing) {
    console.log('LMS demo course already exists; draft, publication and learner data preserved.');
  } else {
    stage = 'generated demonstration video';
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const draw = canvas.getContext('2d')!,
        stream = canvas.captureStream(10),
        recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }),
        parts: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) parts.push(event.data);
      };
      const stop = new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () => reject(new Error('Demo recorder failed'));
      });
      let frame = 0;
      draw.fillStyle = '#223873';
      draw.fillRect(0, 0, 640, 360);
      recorder.start(100);
      const timer = setInterval(() => {
        const seconds = frame++ / 10;
        draw.fillStyle = '#223873';
        draw.fillRect(0, 0, 640, 360);
        draw.fillStyle = '#0A9444';
        draw.fillRect(0, 0, 640, 8);
        draw.fillStyle = '#FFFFFF';
        draw.font = 'bold 34px "Be Vietnam Pro", Arial';
        draw.fillText('TLQM AIO · Học thử', 38, 76);
        draw.font = '23px "Be Vietnam Pro", Arial';
        draw.fillText(
          seconds < 2.5
            ? '1. Đăng nhập bằng tài khoản SSO'
            : seconds < 5
              ? '2. Xem video và trả lời điểm dừng'
              : '3. Nộp bài, xem điểm và lời giải',
          38,
          180,
        );
        draw.font = '18px "Be Vietnam Pro", Arial';
        draw.fillStyle = '#E3E8EF';
        draw.fillText('Nội dung giả lập để dùng thử chức năng', 38, 300);
      }, 100);
      await new Promise((resolve) => setTimeout(resolve, 8000));
      clearInterval(timer);
      recorder.stop();
      await stop;
      stream.getTracks().forEach((track) => track.stop());
      return Array.from(
        new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer()),
      );
    });
    const video = Buffer.from(bytes),
      mediaId = randomUUID();
    stage = 'upload local video';
    const uploaded = await context.request.post(base + '/api/lms/media', {
      headers: {
        origin: base,
        'x-csrf-token': me.csrfToken,
        'idempotency-key': randomUUID(),
        'content-type': 'video/webm',
        'x-file-name': 'lam-quen-aio.webm',
        'x-file-size': String(video.length),
        'x-file-sha256': createHash('sha256').update(video).digest('hex'),
        'x-media-id': mediaId,
        'x-owner-unit-id': ids.unitA,
      },
      data: video,
    });
    assert.equal(uploaded.status(), 200);
    const spec: CourseSpec = {
      schemaVersion: 2,
      title: 'Làm quen TLQM AIO — bài học thử',
      subtitle: 'Thử video, điểm dừng, ghi chú và ba dạng câu hỏi. Đây là dữ liệu giả lập.',
      series: 'Hướng dẫn dùng thử',
      duration: 7.8,
      video: { kind: 'file', id: mediaId },
      deadline: '',
      isMandatory: false,
      audienceUnits: [ids.unitA],
      checkpoints: [
        {
          id: 'cp-login',
          type: 'single',
          time: 2,
          title: 'Đăng nhập',
          question: 'Tài khoản dùng để đăng nhập AIO là gì?',
          options: ['Tài khoản SSO', 'Một mật khẩu riêng cho từng bài học'],
        },
        {
          id: 'cp-learning',
          type: 'single',
          time: 5,
          title: 'Điểm dừng',
          question: 'Khi video đến điểm dừng, bạn cần làm gì?',
          options: ['Trả lời câu hỏi rồi tiếp tục', 'Bỏ qua câu hỏi'],
        },
      ],
      questions: [
        {
          id: 'quiz-version',
          type: 'single',
          question: 'Kết quả bài thi được lưu theo nội dung nào?',
          options: ['Phiên bản khóa học tại thời điểm làm bài', 'Luôn đổi theo đáp án mới nhất'],
        },
        {
          id: 'quiz-review',
          type: 'multiple',
          question: 'Bạn có thể xem lại những gì sau khi nộp bài?',
          options: ['Điểm số', 'Câu hỏi và lời giải', 'Mật khẩu người khác'],
        },
        {
          id: 'quiz-sso',
          type: 'text',
          question: 'Nhập tên viết tắt của cơ chế đăng nhập chung (ba chữ cái).',
          options: [],
        },
      ],
      answerKey: {
        'cp-login': { answer: 0, explanation: 'AIO sử dụng SSO cho các ứng dụng được cấp.' },
        'cp-learning': {
          answer: 0,
          explanation: 'Hệ thống lưu câu trả lời trước khi mở phần tiếp theo.',
        },
        'quiz-version': { answer: 0, explanation: 'Bài làm giữ snapshot của phiên bản đã học.' },
        'quiz-review': {
          answer: [0, 1],
          explanation: 'Mật khẩu và thông tin đăng nhập không được công khai trong bài học.',
        },
        'quiz-sso': { answer: 'SSO', explanation: 'SSO là đăng nhập một lần.' },
      },
      attachments: [],
    };
    const command = async (action: string, data: unknown) => {
      const response = await context.request.post(base + '/api/lms/commands', {
        headers: { origin: base, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() },
        data: { action, data, reason: 'Tạo khóa học giả lập dùng thử AIO local' },
      });
      assert.equal(response.status(), 200);
      return response.json();
    };
    stage = 'create and publish demo';
    const draft = await command('save-course', {
      code,
      ownerUnitId: ids.unitA,
      expectedRevision: 0,
      spec,
    });
    const published = await command('publish-course', {
      courseId: draft.id,
      expectedRevision: draft.revision,
    });
    await writeFile(
      '.local/lms-course-demo.json',
      JSON.stringify(
        {
          instanceId: runtime.instanceId,
          createdAt: new Date().toISOString(),
          courseId: draft.id,
          versionId: published.versionId,
          mediaId,
          code,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('Created local demo: Làm quen TLQM AIO — bài học thử.');
  }
} catch (error) {
  console.error(
    'LMS demo stopped at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). No credentials logged.',
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
