import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { withStorageOperator } from './lms-storage-operator.js';
import { startLocalLms } from './lms-local.js';
import { createLmsBackup, verifyStoredMedia } from './lms-backup-storage.js';
import {
  planLmsMaintenance,
  readMaintenancePlan,
  applyLmsMaintenance,
} from './lms-maintenance-storage.js';
import type { D1Database, MediaBucket } from '../src/lms/types.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
import { ids } from '../src/fixtures.js';
type FixtureBucket = Omit<MediaBucket, 'put'> & {
  put(
    key: string,
    value: Uint8Array,
    options: { httpMetadata: { contentType: string }; sha256: string },
  ): Promise<unknown>;
};
let stage = 'operator MFA',
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined,
  faultInstalled = false,
  seeded = false;
const run = randomUUID(),
  registeredId = randomUUID(),
  protectedId = randomUUID(),
  courseId = randomUUID(),
  lateId = randomUUID(),
  expiredId = randomUUID(),
  rollbackPreviewId = randomUUID(),
  validId = randomUUID();
const key = (id: string) => 'media/' + ids.tenantA + '/' + id + '/' + randomUUID();
const registeredKey = key(registeredId),
  duplicateKey = key(registeredId),
  orphanKey = key(randomUUID()),
  protectedKey = key(protectedId),
  lateKey = key(lateId),
  unknownKey = 'media/' + ids.tenantA + '/unexpected-' + run;
const fixtureKeys = [registeredKey, duplicateKey, orphanKey, protectedKey, lateKey, unknownKey];
const bytes = Buffer.alloc(48, 0x61);
bytes.write('ftypisom', 4);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const fingerprint = async (db: D1Database) => {
  const tables = [
      'employees',
      'lessons',
      'learning_progress',
      'learning_attempts',
      'learning_notes',
      'lms_courses',
      'lms_course_versions',
      'lms_progress',
      'lms_attempts',
      'lms_notes',
      'lms_certificates',
      'lms_question_bank',
      'lms_question_versions',
      'lms_course_receipts',
    ],
    sum = createHash('sha256');
  for (const table of tables)
    sum.update(
      JSON.stringify([
        table,
        (await db.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2').all()).results,
      ]),
    );
  return sum.digest('hex');
};
let before: string | undefined, receipt: unknown;
try {
  receipt = await withStorageOperator(true, async (actor) => {
    stage = 'isolated maintenance fixtures';
    worker = await startLocalLms(true, 0);
    before = await fingerprint(worker.db);
    const bucket = (await worker.mf.getR2Bucket('LMS_MEDIA')) as unknown as FixtureBucket;
    seeded = true;
    for (const objectKey of fixtureKeys)
      await bucket.put(objectKey, bytes, { httpMetadata: { contentType: 'video/mp4' }, sha256 });
    const spec: CourseSpec = {
      schemaVersion: 1,
      title: 'Maintenance protection fixture',
      subtitle: 'Synthetic',
      series: 'Fixture',
      duration: 1,
      video: { kind: 'file', id: protectedId },
      deadline: '',
      isMandatory: false,
      audienceUnits: [ids.unitA],
      checkpoints: [],
      questions: [{ id: 'q', type: 'single', question: 'Fixture?', options: ['A', 'B'] }],
      answerKey: { q: { answer: 0, explanation: 'Synthetic' } },
      attachments: [],
    };
    await worker.db.batch([
      worker.db
        .prepare(
          "INSERT INTO lms_media(id,tenant_id,owner_unit_id,kind,object_key,name,mime_type,size,sha256,created_by,created_at) VALUES (?,?,?,'video',?,'Maintenance fixture','video/mp4',?,?,?,?)",
        )
        .bind(
          registeredId,
          ids.tenantA,
          ids.unitA,
          registeredKey,
          bytes.length,
          sha256,
          actor.accountId,
          Date.now(),
        ),
      worker.db
        .prepare(
          'INSERT INTO lms_courses(id,tenant_id,owner_unit_id,code,draft_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind(
          courseId,
          ids.tenantA,
          ids.unitA,
          'maintenance-' + run,
          JSON.stringify(spec),
          actor.accountId,
          Date.now(),
          Date.now(),
        ),
      ...[
        { id: expiredId, expires: 1 },
        { id: validId, expires: Date.now() + 86400000 },
      ].map((p) =>
        worker!.db
          .prepare(
            "INSERT INTO lms_question_imports(id,tenant_id,actor_account_id,kind,source_name,digest,snapshot_json,created_at,expires_at) VALUES (?,?,?,'quiz',?,?,'{}',0,?)",
          )
          .bind(p.id, ids.tenantA, actor.accountId, 'maintenance-' + run, sha256, p.expires),
      ),
      worker.db
        .prepare(
          "INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,tenant_id,action,reason,request_id,details) VALUES (?,?,?,?, 'test.maintenance_fixture_created','Create owned isolated maintenance fixtures',?,?)",
        )
        .bind(randomUUID(), Date.now(), actor.accountId, ids.tenantA, run, JSON.stringify({ run })),
    ]);
    await worker.mf.dispose();
    worker = undefined;
    stage = 'reviewed plan, retention, scope and protected references';
    const retained = await planLmsMaintenance(true, actor);
    assert.equal(
      retained.orphans.some((o) => fixtureKeys.includes(o.key)),
      false,
    );
    const plan = await planLmsMaintenance(true, actor, 0);
    for (const objectKey of [orphanKey, duplicateKey, lateKey])
      assert.ok(plan.orphans.some((o) => o.key === objectKey));
    assert.ok(plan.protectedCount >= 1);
    assert.ok(plan.unknownCount >= 1);
    assert.equal(plan.missing.length, 0);
    assert.ok(plan.expired.some((p) => p.id === expiredId));
    assert.equal(
      plan.expired.some((p) => p.id === validId),
      false,
    );
    const planFile = '.local/lms-maintenance/' + plan.id + '.json',
      original = await readFile(planFile, 'utf8'),
      tampered = JSON.parse(original);
    tampered.tenantId = ids.tenantB;
    const { checksum: ignored, ...tamperedBody } = tampered;
    void ignored;
    tampered.checksum = createHash('sha256').update(JSON.stringify(tamperedBody)).digest('hex');
    try {
      await writeFile(planFile, JSON.stringify(tampered));
      await assert.rejects(
        () => readMaintenancePlan(true, plan.id, actor),
        /scope or checksum mismatch/,
      );
    } finally {
      await writeFile(planFile, original);
    }
    await assert.rejects(
      () => readMaintenancePlan(false, plan.id, actor),
      /scope or checksum mismatch/,
    );
    await assert.rejects(
      () =>
        applyLmsMaintenance(true, plan.id, {
          ...actor,
          assertFresh: async () => {
            throw new Error('Denied operator fixture');
          },
        }),
      /Denied operator fixture/,
    );
    stage = 'durable intent before irreversible orphan delete and resumable audit failure';
    await createLmsBackup(true, actor, plan.backupId);
    worker = await startLocalLms(true, 0);
    assert.equal(
      await worker.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='maintenance_test_audit_failure'")
        .first(),
      null,
    );
    await worker.db
      .prepare(
        "CREATE TRIGGER maintenance_test_audit_failure BEFORE INSERT ON aio_audit WHEN NEW.action='storage.orphan_removed' BEGIN SELECT RAISE(ABORT,'MAINTENANCE_TEST_AUDIT_FAILURE'); END",
      )
      .run();
    faultInstalled = true;
    await worker.mf.dispose();
    worker = undefined;
    await assert.rejects(() => applyLmsMaintenance(true, plan.id, actor));
    worker = await startLocalLms(true, 0);
    assert.ok(
      await worker.db
        .prepare('SELECT 1 FROM aio_receipts WHERE actor_account_id=? AND command_key=?')
        .bind(actor.accountId, 'lms-maintenance-' + plan.id)
        .first(),
    );
    assert.equal(
      await worker.db
        .prepare('SELECT 1 FROM aio_audit WHERE event_id=?')
        .bind(plan.id + ':complete')
        .first(),
      null,
    );
    assert.ok(
      await worker.db
        .prepare('SELECT 1 FROM lms_question_imports WHERE id=?')
        .bind(expiredId)
        .first(),
    );
    await worker.db.prepare('DROP TRIGGER maintenance_test_audit_failure').run();
    faultInstalled = false;
    await worker.mf.dispose();
    worker = undefined;
    const applied = await applyLmsMaintenance(true, plan.id, actor);
    assert.deepEqual(await applyLmsMaintenance(true, plan.id, actor), applied);
    worker = await startLocalLms(true, 0);
    const checked = (await worker.mf.getR2Bucket('LMS_MEDIA')) as unknown as FixtureBucket;
    for (const objectKey of [orphanKey, duplicateKey, lateKey])
      assert.equal(await checked.head(objectKey), null);
    for (const objectKey of [registeredKey, protectedKey, unknownKey])
      assert.ok(await checked.head(objectKey));
    assert.equal(
      await worker.db
        .prepare('SELECT 1 FROM lms_question_imports WHERE id=?')
        .bind(expiredId)
        .first(),
      null,
    );
    assert.ok(
      await worker.db
        .prepare('SELECT 1 FROM lms_question_imports WHERE id=?')
        .bind(validId)
        .first(),
    );
    assert.equal(
      await worker.db
        .prepare(
          "SELECT count(*) n FROM aio_audit WHERE action='storage.maintenance_completed' AND request_id=?",
        )
        .bind(plan.id)
        .first('n'),
      1,
    );
    await verifyStoredMedia(worker.db, checked as unknown as MediaBucket);
    stage = 'expired preview deletion rolls back with failed audit';
    await worker.db
      .prepare(
        "INSERT INTO lms_question_imports(id,tenant_id,actor_account_id,kind,source_name,digest,snapshot_json,created_at,expires_at) VALUES (?,?,?,'quiz',?,?,'{}',0,1)",
      )
      .bind(rollbackPreviewId, ids.tenantA, actor.accountId, 'maintenance-' + run, sha256)
      .run();
    await worker.mf.dispose();
    worker = undefined;
    const previewPlan = await planLmsMaintenance(true, actor, 0);
    assert.ok(previewPlan.expired.some((p) => p.id === rollbackPreviewId));
    await createLmsBackup(true, actor, previewPlan.backupId);
    worker = await startLocalLms(true, 0);
    await worker.db
      .prepare(
        "CREATE TRIGGER maintenance_test_audit_failure BEFORE INSERT ON aio_audit WHEN NEW.action='storage.expired_previews_removed' BEGIN SELECT RAISE(ABORT,'MAINTENANCE_PREVIEW_AUDIT_FAILURE'); END",
      )
      .run();
    faultInstalled = true;
    await worker.mf.dispose();
    worker = undefined;
    await assert.rejects(() => applyLmsMaintenance(true, previewPlan.id, actor));
    worker = await startLocalLms(true, 0);
    assert.ok(
      await worker.db
        .prepare('SELECT 1 FROM lms_question_imports WHERE id=?')
        .bind(rollbackPreviewId)
        .first(),
    );
    await worker.db.prepare('DROP TRIGGER maintenance_test_audit_failure').run();
    faultInstalled = false;
    await worker.mf.dispose();
    worker = undefined;
    await applyLmsMaintenance(true, previewPlan.id, actor);
    worker = await startLocalLms(true, 0);
    assert.equal(
      await worker.db
        .prepare('SELECT 1 FROM lms_question_imports WHERE id=?')
        .bind(rollbackPreviewId)
        .first(),
      null,
    );
    const afterPreview = (await worker.mf.getR2Bucket('LMS_MEDIA')) as unknown as FixtureBucket;
    // A plan loses authority over a key that gets registered before apply.
    await afterPreview.put(lateKey, bytes, { httpMetadata: { contentType: 'video/mp4' }, sha256 });
    await worker.mf.dispose();
    worker = undefined;
    const stale = await planLmsMaintenance(true, actor, 0);
    assert.ok(stale.orphans.some((o) => o.key === lateKey));
    worker = await startLocalLms(true, 0);
    await worker.db
      .prepare(
        "INSERT INTO lms_media(id,tenant_id,owner_unit_id,kind,object_key,name,mime_type,size,sha256,created_by,created_at) VALUES (?,?,?,'video',?,'Late registered fixture','video/mp4',?,?,?,?)",
      )
      .bind(
        lateId,
        ids.tenantA,
        ids.unitA,
        lateKey,
        bytes.length,
        sha256,
        actor.accountId,
        Date.now(),
      )
      .run();
    await worker.mf.dispose();
    worker = undefined;
    stage = 'newly registered media is protected from stale plan';
    await assert.rejects(
      () => applyLmsMaintenance(true, stale.id, actor),
      /newly referenced media/,
    );
    worker = await startLocalLms(true, 0);
    assert.ok(
      await ((await worker.mf.getR2Bucket('LMS_MEDIA')) as unknown as FixtureBucket).head(lateKey),
    );
    await worker.mf.dispose();
    worker = undefined;
    return {
      planId: plan.id,
      backupId: plan.backupId,
      removedOrphans: applied.removedOrphans,
      expiredPreviews: applied.expiredPreviews,
      retentionRespected: true,
      scopeRejected: true,
      registeredMediaRetained: true,
      unregisteredReferencedMediaProtected: true,
      unknownKeysProtected: true,
      validPreviewRetained: true,
      intentSurvivedAuditFailure: true,
      retryDidNotDuplicateAudit: true,
      previewDeleteAndAuditAtomic: true,
      stalePlanCannotDeleteRegisteredMedia: true,
    };
  });
} catch (error) {
  console.error(
    'LMS maintenance E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      ') ' +
      (error instanceof Error
        ? (error.stack?.match(
            /lms-(maintenance-storage|maintenance-e2e|storage-operator|backup-storage)\.ts:\d+:\d+/,
          )?.[0] ?? '')
        : '') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  try {
    await worker?.mf.dispose();
    worker = undefined;
    if (seeded) {
      worker = await startLocalLms(true, 0);
      if (faultInstalled)
        await worker.db.prepare('DROP TRIGGER maintenance_test_audit_failure').run();
      await worker.db.batch([
        worker.db
          .prepare(
            'DELETE FROM lms_question_imports WHERE tenant_id=? AND source_name=? AND id IN (?,?,?)',
          )
          .bind(ids.tenantA, 'maintenance-' + run, expiredId, validId, rollbackPreviewId),
        worker.db
          .prepare('DELETE FROM lms_courses WHERE id=? AND code=? AND published_version_id IS NULL')
          .bind(courseId, 'maintenance-' + run),
        worker.db
          .prepare('DELETE FROM lms_media WHERE (id=? AND object_key=?) OR (id=? AND object_key=?)')
          .bind(registeredId, registeredKey, lateId, lateKey),
        worker.db
          .prepare(
            "INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,tenant_id,action,reason,request_id,details) VALUES (?,?,?,?, 'test.maintenance_fixture_removed','Remove only owned maintenance fixtures',?,?)",
          )
          .bind(randomUUID(), Date.now(), ids.admin, ids.tenantA, run, JSON.stringify({ run })),
      ]);
      const bucket = (await worker.mf.getR2Bucket('LMS_MEDIA')) as unknown as FixtureBucket;
      for (const objectKey of fixtureKeys) await bucket.delete(objectKey);
      assert.equal(await fingerprint(worker.db), before);
    }
  } catch {
    process.exitCode = 1;
    console.error('Maintenance fixture cleanup/preservation failed; review required.');
  } finally {
    await worker?.mf.dispose();
  }
}
if (receipt && !process.exitCode) {
  await writeFile(
    '.local/evidence/lms-maintenance-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        ...(receipt as Record<string, unknown>),
        learningBankAndCourseHistoryPreserved: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: backed-up orphan reconciliation, expired preview cleanup, protected references, scope, durable audit intent and retry; business history preserved.',
  );
}
