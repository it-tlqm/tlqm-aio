import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp } from './local-totp.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
import type { MediaBucket } from '../src/lms/types.js';
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104';
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixtures.users.find((u) => u.role === name)!;
const browser = await chromium.launch({ headless: true });
let app: Awaited<ReturnType<typeof createApp>> | undefined,
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
  return { context, page, me: (await response.json()) as { csrfToken: string } };
}
type User = Awaited<ReturnType<typeof login>>;
async function upload(
  user: User,
  body: Buffer,
  extra: Record<string, string> = {},
  expected = 200,
) {
  const response = await user.context.request.post(base + '/api/lms/media', {
    headers: {
      origin: base,
      'x-csrf-token': user.me.csrfToken,
      'content-type': 'video/mp4',
      'x-file-name': encodeURIComponent('Video thử nghiệm.mp4'),
      'x-file-size': String(body.length),
      'x-file-sha256': createHash('sha256').update(body).digest('hex'),
      'x-media-id': randomUUID(),
      'x-owner-unit-id': ids.unitA,
      'idempotency-key': randomUUID(),
      ...extra,
    },
    data: body,
  });
  if (response.status() !== expected) {
    const data = await response.json().catch(() => ({}));
    console.error(
      'Media status ' +
        response.status() +
        '/' +
        expected +
        ' ' +
        (typeof data.error === 'string' ? data.error : 'unknown'),
    );
  }
  assert.equal(response.status(), expected);
  return response.json();
}
async function command(user: User, action: string, data: unknown) {
  const r = await user.context.request.post(base + '/api/lms/commands', {
    headers: { origin: base, 'x-csrf-token': user.me.csrfToken, 'idempotency-key': randomUUID() },
    data: { action, data, reason: 'Nghiệm thu media giả lập' },
  });
  assert.equal(r.status(), 200);
  return r.json();
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
  stage = 'SSO accounts';
  const admin = await login(role('publisher'), true),
    learner = await login(runtime.users.find((u) => u.id === ids.learner)!),
    other = await login(role('respondent'));
  // Container fixture checks transport/integrity; test:lms-authoring decodes a real generated WebM.
  const bytes = Buffer.alloc(16384, 0x61);
  bytes.write('ftypisom', 4, 'ascii');
  const mediaId = randomUUID(),
    key = randomUUID(),
    headers = { 'x-media-id': mediaId, 'idempotency-key': key };
  stage = 'Streaming upload and idempotency';
  const media = await upload(admin, bytes, headers);
  assert.equal(media.id, mediaId);
  assert.deepEqual(await upload(admin, bytes, headers), media);
  const row = await worker.db
    .prepare('SELECT object_key,sha256,size FROM lms_media WHERE id=?')
    .bind(mediaId)
    .first<{ object_key: string; sha256: string; size: number }>();
  assert.ok(row);
  assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
  const bucket = (await worker.mf.getR2Bucket('LMS_MEDIA')) as unknown as MediaBucket & {
    list(options: { prefix: string }): Promise<{ objects: { key: string }[] }>;
  };
  assert.equal((await bucket.head(row.object_key))?.size, bytes.length);
  const objects = await bucket.list({ prefix: 'media/' + ids.tenantA + '/' + mediaId + '/' });
  assert.equal(objects.objects.length, 1);
  stage = 'Maximum 100 MB streamed upload';
  const largeId = randomUUID();
  try {
    const large = Buffer.alloc(100 * 1024 * 1024, 0x62);
    large.write('ftypisom', 4, 'ascii');
    const stored = await upload(admin, large, { 'x-media-id': largeId });
    assert.equal(stored.size, large.length);
    const check = await admin.context.request.get(base + '/api/lms/media/' + largeId, {
      headers: { range: 'bytes=-16' },
    });
    assert.equal(check.status(), 206);
    assert.deepEqual(await check.body(), large.subarray(large.length - 16));
    checks.push('Actual 100 MB upload streamed and verified by authenticated Range read');
  } finally {
    const largeRow = await worker.db
      .prepare('SELECT object_key FROM lms_media WHERE id=? AND tenant_id=?')
      .bind(largeId, ids.tenantA)
      .first<{ object_key: string }>();
    if (largeRow) {
      assert.ok(largeRow.object_key.startsWith('media/' + ids.tenantA + '/' + largeId + '/'));
      await bucket.delete(largeRow.object_key);
      await worker.db.batch([
        worker.db
          .prepare('DELETE FROM lms_media WHERE id=? AND tenant_id=?')
          .bind(largeId, ids.tenantA),
        worker.db
          .prepare(
            'INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,tenant_id,action,reason,request_id,details) VALUES (?,?,?,?,?,?,?,?)',
          )
          .bind(
            randomUUID(),
            Date.now(),
            role('publisher').id,
            ids.tenantA,
            'test.media_fixture_removed',
            'Remove isolated large transport fixture',
            randomUUID(),
            JSON.stringify({ mediaId: largeId }),
          ),
      ]);
    }
  }
  stage = 'Conflicting upload cannot overwrite committed media';
  const conflicting = Buffer.from(bytes);
  conflicting[100] = 0x63;
  await upload(admin, conflicting, headers, 409);
  await upload(admin, conflicting, { 'x-media-id': mediaId }, 409);
  assert.deepEqual(
    await (await admin.context.request.get(base + '/api/lms/media/' + mediaId)).body(),
    bytes,
  );
  stage = 'MIME size and permission negatives';
  await upload(learner, bytes, {}, 403);
  await upload(admin, Buffer.from('<html>not a video</html>'), {}, 415);
  await upload(admin, bytes, { 'x-file-size': String(bytes.length + 1) }, 400);
  await upload(admin, bytes, { 'x-file-size': String(bytes.length - 1) }, 400);
  await upload(admin, bytes, { 'x-file-sha256': '00'.repeat(32) }, 400);
  await upload(admin, bytes, { 'x-file-size': String(100 * 1024 * 1024 + 1) }, 413);
  await upload(admin, bytes, { 'x-csrf-token': 'wrong' }, 403);
  stage = 'Authenticated streaming and ranges';
  const mediaUrl = base + '/api/lms/media/' + mediaId;
  const full = await admin.context.request.get(mediaUrl);
  assert.equal(full.status(), 200);
  assert.deepEqual(await full.body(), bytes);
  assert.equal(full.headers()['cache-control'], 'no-store');
  const range = await admin.context.request.get(mediaUrl, { headers: { range: 'bytes=4-11' } });
  assert.equal(range.status(), 206);
  assert.equal(range.headers()['content-range'], 'bytes 4-11/' + bytes.length);
  assert.deepEqual(await range.body(), bytes.subarray(4, 12));
  stage = 'Authenticated suffix range';
  const suffix = await admin.context.request.get(mediaUrl, { headers: { range: 'bytes=-9' } });
  assert.equal(suffix.status(), 206);
  assert.deepEqual(await suffix.body(), bytes.subarray(bytes.length - 9));
  stage = 'Unsatisfiable range';
  const invalid = await admin.context.request.get(mediaUrl, {
    headers: { range: 'bytes=' + bytes.length + '-' },
  });
  assert.equal(invalid.status(), 416);
  assert.equal(invalid.headers()['content-range'], 'bytes */' + bytes.length);
  stage = 'Unpublished media learner denial';
  assert.equal((await learner.context.request.get(mediaUrl)).status(), 403);
  stage = 'Anonymous media denial';
  assert.equal((await fetch(mediaUrl)).status, 401);
  const spec: CourseSpec = {
    schemaVersion: 1,
    title: 'Video nghiệm thu',
    subtitle: 'Media quyền truy cập',
    series: 'Local',
    duration: 30,
    video: { kind: 'file', id: mediaId },
    deadline: '',
    isMandatory: true,
    audienceUnits: [ids.unitA],
    checkpoints: [],
    questions: [{ id: 'q', type: 'single', question: 'Câu hỏi?', options: ['A', 'B'] }],
    answerKey: { q: { answer: 0, explanation: 'Fixture' } },
    attachments: [],
  };
  stage = 'Media course creation';
  const saved = await command(admin, 'save-course', {
    code: 'media-' + randomUUID().slice(0, 8),
    ownerUnitId: ids.unitA,
    expectedRevision: 0,
    spec,
  });
  stage = 'Media course publication';
  const published = await command(admin, 'publish-course', {
    courseId: saved.id,
    expectedRevision: 1,
  });
  stage = 'Published media audience and HEAD';
  const scopedUrl = mediaUrl + '?versionId=' + published.versionId;
  assert.equal((await learner.context.request.get(scopedUrl)).status(), 200);
  assert.equal((await other.context.request.get(scopedUrl)).status(), 403);
  const head = await learner.context.request.head(scopedUrl);
  assert.equal(head.status(), 200);
  assert.equal(head.headers()['content-length'], String(bytes.length));
  checks.push(
    'Streamed storage with checksum, exact length and signature; retry one object/audit; admin and version audience guards; full/HEAD/Range/416',
  );
  stage = 'Storage failure rolls back registration';
  const brokenId = randomUUID();
  await worker.db
    .prepare(
      "CREATE TRIGGER media_test_audit_failure BEFORE INSERT ON aio_audit WHEN NEW.action='media.uploaded' BEGIN SELECT RAISE(ABORT,'MEDIA_AUDIT_FAILURE'); END",
    )
    .run();
  try {
    await upload(admin, bytes, { 'x-media-id': brokenId }, 503);
    assert.equal(
      await worker.db.prepare('SELECT id FROM lms_media WHERE id=?').bind(brokenId).first(),
      null,
    );
    assert.equal(
      (await bucket.list({ prefix: 'media/' + ids.tenantA + '/' + brokenId + '/' })).objects.length,
      0,
    );
  } finally {
    await worker.db.prepare('DROP TRIGGER media_test_audit_failure').run();
  }
  stage = 'Worker restart retains media';
  await worker.mf.dispose();
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  const after = await learner.context.request.get(scopedUrl);
  assert.equal(after.status(), 200);
  assert.deepEqual(await after.body(), bytes);
  stage = 'Archived course denies open media';
  await command(admin, 'course-status', {
    courseId: saved.id,
    expectedRevision: published.revision,
    status: 'archived',
  });
  assert.equal((await learner.context.request.get(scopedUrl)).status(), 403);
  checks.push(
    'Audit failure removes uncommitted object; Worker restart preserves bytes/session; archive denies media on existing session',
  );
  await writeFile(
    '.local/evidence/lms-media-e2e.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), result: 'pass', checks }, null, 2) + '\n',
  );
  console.log(
    'PASS: authenticated LMS media streaming, range, integrity, idempotency, rollback and local persistence.',
  );
} catch (error) {
  const location =
    error instanceof Error ? /lms-media-e2e\.ts:(\d+):(\d+)/.exec(error.stack ?? '') : null;
  console.error(
    'LMS media E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      ')' +
      (location ? ' at script line ' + location[1] : '') +
      '. Sensitive details omitted.',
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
