import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { trainingFixture } from './fixtures/lms-training.js';
import { TrainingReminders } from '../src/lms/training-reminders.js';
import { TrainingNotices } from '../src/lms/training-notices.js';
import { portalWorkProof, verifyPortalWorkProof } from '../src/portal-work-proof.js';
let f: Awaited<ReturnType<typeof trainingFixture>>,
  eligible = true;
before(async () => {
  f = await trainingFixture();
});
after(async () => {
  await f?.mf.dispose();
});
const audience = async (_tenant: string, ids: string[]) =>
  eligible
    ? ids
        .filter((id) => id === f.student.principal.accountId)
        .map((accountId) => ({
          accountId,
          personId: f.student.principal.personId,
          unitIds: [f.unit],
        }))
    : [];
async function policy(enabled = true) {
  const old = (await f.admin.policies()).items.find((p) => p.unit_id === f.unit);
  return f.admin.savePolicy(
    {
      unitId: f.unit,
      enabled,
      beforeMinutes: 60,
      overdueMinutes: 1,
      expectedRevision: old?.revision ?? 0,
    },
    f.command(),
  );
}
test('new enrollments notify once; native read state is revisioned and cannot cross learners', async () => {
  const { batch } = await f.makeBatch(),
    notice = (await f.learn.work()).notices.find((n) => n.batchId === batch.id)!;
  assert.equal(notice.kind, 'assigned');
  const c = f.command();
  const result = await f.learn.mark(notice.id, true, notice.revision, c);
  assert.deepEqual(await f.learn.mark(notice.id, true, notice.revision, c), result);
  await assert.rejects(() => f.learn.mark(notice.id, false, notice.revision, f.command()), {
    code: 'REVISION_CONFLICT',
  });
  await assert.rejects(
    () =>
      new TrainingNotices(f.db, async () => f.other, f.directory).mark(
        notice.id,
        true,
        notice.revision,
        f.command(),
      ),
    { code: 'LMS_TRAINING_NOTICE_UNAVAILABLE' },
  );
  assert.ok((await f.learn.work()).notices.find((n) => n.id === notice.id)!.readAt);
});
test('reminders default off, survive restart/concurrency and do not duplicate policy retries', async () => {
  const { batch } = await f.makeBatch();
  const worker = new TrainingReminders(f.db, audience);
  assert.equal((await worker.tick()).delivered, 0);
  await policy();
  const results = await Promise.all([worker.tick(), new TrainingReminders(f.db, audience).tick()]);
  assert.equal(
    results.reduce((s, r) => s + r.failedTenants, 0),
    0,
  );
  assert.equal(
    (await f.db
      .prepare(
        "SELECT count(*) AS n FROM lms_training_notifications WHERE batch_id=? AND kind='due_soon'",
      )
      .bind(batch.id)
      .first<{ n: number }>())!.n,
    1,
  );
  assert.equal((await worker.tick()).delivered, 0);
  const old = (await f.admin.policies()).items[0]!,
    c = f.command(),
    input = {
      unitId: f.unit,
      enabled: true,
      beforeMinutes: 60,
      overdueMinutes: 1,
      expectedRevision: old.revision,
    };
  const saved = await f.admin.savePolicy(input, c);
  assert.deepEqual(await f.admin.savePolicy(input, c), saved);
});
test('schedule revision retires old notices, cancellation hides work while retaining delivery history', async () => {
  const { batch, input } = await f.makeBatch();
  await new TrainingReminders(f.db, audience).tick();
  await f.admin.updateBatch(
    {
      id: batch.id,
      expectedRevision: 1,
      title: input.title,
      startsAt: input.startsAt,
      dueAt: Date.now() + 7200000,
      status: 'active',
    },
    f.command(),
  );
  const work = await f.learn.work(),
    notices = work.notices.filter((n) => n.batchId === batch.id);
  assert.deepEqual(
    notices.map((n) => n.kind),
    ['rescheduled'],
  );
  await f.admin.updateBatch(
    {
      id: batch.id,
      expectedRevision: 2,
      title: input.title,
      startsAt: input.startsAt,
      dueAt: Date.now() + 7200000,
      status: 'cancelled',
    },
    f.command(),
  );
  assert.equal(
    (await f.learn.work()).items.some((i) => i.id === batch.id),
    false,
  );
  assert.ok(
    (await f.db
      .prepare('SELECT count(*) AS n FROM lms_training_notifications WHERE batch_id=?')
      .bind(batch.id)
      .first<{ n: number }>())!.n >= 2,
  );
});
test('real passing completion removes reminders and worker respects live audience revocation', async () => {
  const { batch, course } = await f.makeBatch(Date.now() - 120000);
  eligible = false;
  try {
    await new TrainingReminders(f.db, audience).tick();
  } finally {
    eligible = true;
  }
  assert.equal(
    (await f.db
      .prepare(
        "SELECT count(*) AS n FROM lms_training_notifications WHERE batch_id=? AND kind='overdue'",
      )
      .bind(batch.id)
      .first<{ n: number }>())!.n,
    0,
  );
  await f.learn.submit(
    { versionId: course.versionId, answers: { q: 0 }, tabSwitchCount: 0 },
    f.command(),
  );
  await new TrainingReminders(f.db, audience).tick();
  assert.equal(
    (await f.learn.work()).items.some((i) => i.id === batch.id),
    false,
  );
});
test('reminder audit failures roll back deliveries and can retry; disabled policies hide previous alerts', async () => {
  const { batch } = await f.makeBatch(Date.now() - 120000);
  await f.db
    .prepare(
      "CREATE TRIGGER training_notice_test_audit BEFORE INSERT ON aio_audit WHEN NEW.action='training.reminders_delivered' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END",
    )
    .run();
  try {
    assert.equal((await new TrainingReminders(f.db, audience).tick()).failedTenants, 1);
    assert.equal(
      (await f.db
        .prepare(
          "SELECT count(*) AS n FROM lms_training_notifications WHERE batch_id=? AND kind='overdue'",
        )
        .bind(batch.id)
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.db.prepare('DROP TRIGGER training_notice_test_audit').run();
  }
  await new TrainingReminders(f.db, audience).tick();
  assert.ok(
    (await f.learn.work()).notices.some((n) => n.batchId === batch.id && n.kind === 'overdue'),
  );
  await policy(false);
  assert.equal(
    (await f.learn.work()).notices.some((n) => n.kind === 'overdue' || n.kind === 'due_soon'),
    false,
  );
});
test('delegated read actors never gain write authority or manufacture LMS sessions', async () => {
  const delegated = new TrainingNotices(
    f.db,
    async () => ({ ...f.administrator, sessionHash: null }),
    f.directory,
  );
  assert.equal((await delegated.work()).accountId, f.administrator.principal.accountId);
  await assert.rejects(
    async () =>
      delegated.savePolicy(
        {
          unitId: f.unit,
          enabled: true,
          beforeMinutes: 1,
          overdueMinutes: 1,
          expectedRevision: (await f.admin.policies()).items[0]!.revision,
        },
        f.command(),
      ),
    { code: 'LMS_PORTAL_READ_ONLY' },
  );
});
test('Portal feed proof binds token, session, tenant, environment and direction with short expiry', async () => {
  const q = {
      instanceId: f.config.instanceId,
      environment: 'test' as const,
      tenantId: f.tenant,
      sessionHash: 'a'.repeat(64),
    },
    token = 'synthetic-token-not-valid-for-login';
  const proof = await portalWorkProof(
    f.config.clientSecret,
    f.config.clientId,
    token,
    q,
    'request',
  );
  assert.equal(
    await verifyPortalWorkProof(
      f.config.clientSecret,
      f.config.clientId,
      token,
      q,
      'request',
      proof,
    ),
    true,
  );
  for (const changed of [
    { ...q, sessionHash: 'b'.repeat(64) },
    { ...q, tenantId: f.unit },
    { ...q, environment: 'local' as const },
  ])
    assert.equal(
      await verifyPortalWorkProof(
        f.config.clientSecret,
        f.config.clientId,
        token,
        changed,
        'request',
        proof,
      ),
      false,
    );
  assert.equal(
    await verifyPortalWorkProof(
      f.config.clientSecret,
      f.config.clientId,
      token + 'x',
      q,
      'request',
      proof,
    ),
    false,
  );
  assert.equal(
    await verifyPortalWorkProof(
      f.config.clientSecret,
      f.config.clientId,
      token,
      q,
      'authorize',
      proof,
    ),
    false,
  );
  assert.equal(
    await verifyPortalWorkProof(
      f.config.clientSecret,
      f.config.clientId,
      token,
      q,
      'request',
      await portalWorkProof(
        f.config.clientSecret,
        f.config.clientId,
        token,
        q,
        'request',
        Math.floor(Date.now() / 1000) - 60,
      ),
    ),
    false,
  );
});
