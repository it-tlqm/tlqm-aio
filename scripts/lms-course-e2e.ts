import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  const response = await context.request.get(base + '/api/v1/me');
  assert.equal(response.status(), 200);
  return { context, me: (await response.json()) as { csrfToken: string } };
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
try {
  const client = runtime.clients.find((c) => c.code === 'aio-foundation')!;
  foundation = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client,
    test: true,
    logger: false,
  });
  await foundation.listen({ host: '127.0.0.1', port: client.port });
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  assert.equal(
    (await worker.db
      .prepare('SELECT purpose FROM environment_marker WHERE id=1')
      .first<{ purpose: string }>())!.purpose,
    'tlqm-aio-lms-test',
  );
  const legacy = async () =>
    JSON.stringify(
      await Promise.all(
        ['employees', 'lessons', 'learning_progress', 'learning_attempts', 'learning_notes'].map(
          async (table) =>
            (await worker!.db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()).results,
        ),
      ),
    );
  const before = await legacy();
  stage = 'SSO admin learner and other unit';
  const admin = await login(role('publisher'), true),
    learner = await login(runtime.users.find((u) => u.id === ids.learner)!),
    other = await login(role('respondent'));
  const spec: CourseSpec = {
    schemaVersion: 1,
    title: 'Khóa học API ' + randomUUID().slice(0, 6),
    subtitle: 'Nghiệm thu API trên Worker thật',
    series: 'AIO',
    duration: 30,
    video: { kind: 'youtube', id: 'abcdefghijk' },
    deadline: '2026-12-01',
    isMandatory: true,
    audienceUnits: [ids.unitA],
    checkpoints: [
      {
        id: 'cp',
        type: 'single',
        title: 'Điểm dừng',
        time: 10,
        question: 'Chọn một?',
        options: ['A', 'B'],
      },
    ],
    questions: [{ id: 'q', type: 'single', question: 'Chọn đáp án đúng?', options: ['A', 'B'] }],
    answerKey: {
      cp: { answer: 0, explanation: 'Phản hồi điểm dừng' },
      q: { answer: 1, explanation: 'Phản hồi bài thi' },
    },
    attachments: [],
  };
  stage = 'Trusted command boundary and draft';
  const code = 'api-' + randomUUID().slice(0, 8),
    input = { code, ownerUnitId: ids.unitA, expectedRevision: 0, spec };
  await send(learner, 'save-course', input, 403);
  const missingCsrf = await admin.context.request.post(base + '/api/lms/commands', {
    data: { action: 'save-course', data: input, reason: 'Thiếu CSRF' },
  });
  assert.equal(missingCsrf.status(), 403);
  const key = randomUUID(),
    draft = await send(admin, 'save-course', input, 200, key);
  assert.deepEqual(await send(admin, 'save-course', input, 200, key), draft);
  const ownList = await learner.context.request.get(base + '/api/lms/courses');
  assert.equal(ownList.status(), 200);
  assert.equal(
    (await ownList.json()).items.some((row: { id: string }) => row.id === draft.id),
    false,
  );
  await send(admin, 'save-course', { ...input, courseId: draft.id, expectedRevision: 0 }, 409);
  stage = 'Publication and tenant/unit visibility';
  const published = await send(admin, 'publish-course', {
    courseId: draft.id,
    expectedRevision: draft.revision,
  });
  const detail = await learner.context.request.get(
    base + '/api/lms/course?versionId=' + published.versionId,
  );
  assert.equal(detail.status(), 200);
  assert.equal('answerKey' in (await detail.json()).spec, false);
  assert.equal(
    (
      await other.context.request.get(base + '/api/lms/course?versionId=' + published.versionId)
    ).status(),
    403,
  );
  assert.equal((await learner.context.request.get(base + '/api/lms/manage/courses')).status(), 403);
  checks.push(
    'Real SSO/MFA + learner/admin/unit scope, CSRF, draft isolation and immutable publication',
  );
  stage = 'Playback checkpoints and quiz snapshot';
  const versionId = published.versionId;
  await send(learner, 'submit', { versionId, answers: { q: 1 }, tabSwitchCount: 0 }, 409);
  await send(
    learner,
    'progress',
    { versionId, expectedRevision: 0, position: 30, userId: role('respondent').id },
    400,
  );
  const p = await send(learner, 'progress', { versionId, expectedRevision: 0, position: 30 });
  assert.equal(p.position, 10);
  assert.equal(p.finished, false);
  const checkpoint = await send(learner, 'checkpoint', {
    versionId,
    expectedRevision: p.revision,
    questionId: 'cp',
    answer: 0,
  });
  assert.equal(checkpoint.correct, true);
  await send(learner, 'progress', {
    versionId,
    expectedRevision: checkpoint.revision,
    position: 30,
  });
  const submitKey = randomUUID(),
    submit = { versionId, answers: { q: 1 }, tabSwitchCount: 0 };
  const result = await send(learner, 'submit', submit, 200, submitKey);
  assert.equal(result.score, 100);
  assert.deepEqual(await send(learner, 'submit', submit, 200, submitKey), result);
  const otherResult = await other.context.request.get(base + '/api/lms/attempt?id=' + result.id);
  assert.equal(otherResult.status(), 404);
  const note = await send(learner, 'create-note', {
    versionId,
    time: 12,
    content: 'Ghi chú riêng trong bài học',
  });
  await send(other, 'delete-note', { noteId: note.id }, 409);
  await send(learner, 'delete-note', { noteId: note.id });
  stage = 'Version change retains prior results';
  const nextSpec = {
    ...spec,
    title: 'Nội dung phiên bản sau',
    answerKey: { ...spec.answerKey, q: { answer: 0, explanation: 'Đáp án phiên bản sau' } },
  };
  const nextDraft = await send(admin, 'save-course', {
    ...input,
    courseId: draft.id,
    expectedRevision: published.revision,
    spec: nextSpec,
  });
  const nextVersion = await send(admin, 'publish-course', {
    courseId: draft.id,
    expectedRevision: nextDraft.revision,
  });
  const oldResult = await learner.context.request.get(base + '/api/lms/attempt?id=' + result.id);
  assert.equal(oldResult.status(), 200);
  const snapshot = await oldResult.json();
  assert.equal(snapshot.lessonTitle, spec.title);
  assert.equal(snapshot.review[0].correctAnswer, 1);
  await send(admin, 'course-status', {
    courseId: draft.id,
    expectedRevision: nextVersion.revision,
    status: 'archived',
  });
  await send(
    learner,
    'create-note',
    { versionId, time: 2, content: 'Không được ghi vào khóa ngừng' },
    403,
  );
  assert.equal(
    (await learner.context.request.get(base + '/api/lms/attempt?id=' + result.id)).status(),
    200,
  );
  assert.equal(await legacy(), before);
  checks.push(
    'Checkpoint gate, server grading, single attempt on retry, note ownership, version-pinned review and unchanged legacy rows',
  );
  await writeFile(
    '.local/evidence/lms-courses-e2e.json',
    JSON.stringify(
      { checkedAt: new Date().toISOString(), result: 'pass', checks, courseId: draft.id },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: functional LMS course API through real Worker SSO, permissions, progress, assessment and immutable history.',
  );
} catch (error) {
  console.error(
    'LMS course E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await worker?.mf.dispose();
  if (foundation) {
    foundation.server.closeAllConnections();
    await foundation.close();
  }
}
