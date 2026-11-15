import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { startLocalLms } from './lms-local.js';
import { createLmsBackup, privateStorageDirectory, validateDb } from './lms-backup-storage.js';
import type { StorageOperator } from './lms-storage-operator.js';
import type { D1Database, MediaBucket, MediaObject } from '../src/lms/types.js';
type ObjectMeta = { key: string; size: number; etag: string; uploadedAt: number };
type InventoryBucket = Omit<MediaBucket, 'head'> & {
  head(key: string): Promise<(MediaObject & { uploaded: Date }) | null>;
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{
    objects: { key: string; size: number; etag: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
};
type PlanBody = {
  version: 1;
  id: string;
  backupId: string;
  instanceId: string;
  environment: 'local' | 'test';
  tenantId: string;
  createdBy: string;
  createdAt: number;
  cutoff: number;
  minAgeSeconds: number;
  orphans: ObjectMeta[];
  orphanTotal: number;
  expired: { id: string; expiresAt: number }[];
  expiredTotal: number;
  missing: { id: string; reason: string }[];
  protectedCount: number;
  unknownCount: number;
};
export type MaintenancePlan = PlanBody & { checksum: string };
const uuid = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function mediaId(key: string, tenantId: string) {
  const parts = key.split('/');
  if (
    parts.length !== 4 ||
    parts[0] !== 'media' ||
    parts[1] !== tenantId ||
    !uuid(parts[2]) ||
    !uuid(parts[3])
  )
    return null;
  return parts[2]!;
}
async function orphanStatus(db: D1Database, key: string, tenantId: string) {
  const id = mediaId(key, tenantId);
  if (!id) return 'unknown';
  if (await db.prepare('SELECT 1 FROM lms_media WHERE object_key=?').bind(key).first())
    return 'registered';
  if (await db.prepare('SELECT 1 FROM lms_media WHERE id=?').bind(id).first()) return 'orphan';
  for (const [table, column] of [
    ['lms_courses', 'draft_json'],
    ['lms_course_versions', 'spec_json'],
  ] as const)
    if (
      await db
        .prepare(
          'SELECT 1 FROM ' +
            table +
            ' WHERE (json_extract(' +
            column +
            ",'$.video.kind')='file' AND json_extract(" +
            column +
            ",'$.video.id')=?) OR EXISTS(SELECT 1 FROM json_each(" +
            column +
            ",'$.attachments') WHERE json_extract(value,'$.mediaId')=?) LIMIT 1",
        )
        .bind(id, id)
        .first()
    )
      return 'protected';
  return 'orphan';
}
async function pathFor(id: string) {
  if (!uuid(id)) throw new Error('Invalid maintenance plan identifier');
  return resolve(await privateStorageDirectory('.local/lms-maintenance'), id + '.json');
}
export async function readMaintenancePlan(test: boolean, id: string, actor: StorageOperator) {
  const path = await pathFor(id),
    info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Invalid maintenance plan file');
  const plan = JSON.parse(await readFile(path, 'utf8')) as MaintenancePlan,
    { checksum, ...body } = plan;
  if (
    plan.version !== 1 ||
    plan.id !== id ||
    !uuid(plan.instanceId) ||
    !uuid(plan.backupId) ||
    plan.environment !== (test ? 'test' : 'local') ||
    plan.tenantId !== actor.tenantId ||
    plan.createdBy !== actor.accountId ||
    checksum !== digest(body) ||
    !Number.isSafeInteger(plan.createdAt) ||
    !Number.isSafeInteger(plan.cutoff) ||
    plan.createdAt > Date.now() + 5000 ||
    plan.cutoff > plan.createdAt ||
    !Number.isSafeInteger(plan.minAgeSeconds) ||
    plan.minAgeSeconds < 0 ||
    plan.minAgeSeconds > 7 * 24 * 3600 ||
    plan.cutoff !== plan.createdAt - plan.minAgeSeconds * 1000 ||
    !Array.isArray(plan.orphans) ||
    plan.orphans.length > 500 ||
    !plan.orphans.every(
      (o) =>
        typeof o.key === 'string' &&
        mediaId(o.key, plan.tenantId) &&
        Number.isSafeInteger(o.size) &&
        o.size > 0 &&
        typeof o.etag === 'string' &&
        o.etag.length <= 128 &&
        Number.isSafeInteger(o.uploadedAt) &&
        o.uploadedAt <= plan.cutoff,
    ) ||
    !Array.isArray(plan.expired) ||
    plan.expired.length > 500 ||
    !plan.expired.every(
      (p) => uuid(p.id) && Number.isSafeInteger(p.expiresAt) && p.expiresAt <= plan.createdAt,
    ) ||
    !Array.isArray(plan.missing) ||
    new Set(plan.orphans.map((o) => o.key)).size !== plan.orphans.length ||
    new Set(plan.expired.map((p) => p.id)).size !== plan.expired.length ||
    ![plan.orphanTotal, plan.expiredTotal, plan.protectedCount, plan.unknownCount].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    plan.orphanTotal < plan.orphans.length ||
    plan.expiredTotal < plan.expired.length
  )
    throw new Error('Maintenance plan identity, scope or checksum mismatch');
  return plan;
}
export async function planLmsMaintenance(
  test: boolean,
  actor: StorageOperator,
  minAgeSeconds = 3600,
) {
  if (!Number.isSafeInteger(minAgeSeconds) || minAgeSeconds < 0 || minAgeSeconds > 7 * 24 * 3600)
    throw new Error('Invalid orphan retention age');
  await actor.assertFresh();
  const worker = await startLocalLms(test, 0);
  try {
    await validateDb(worker.db, worker.config, actor.tenantId);
    const bucket = (await worker.mf.getR2Bucket('LMS_MEDIA')) as unknown as InventoryBucket,
      now = Date.now(),
      cutoff = now - minAgeSeconds * 1000,
      orphans: ObjectMeta[] = [],
      missing: { id: string; reason: string }[] = [];
    const registered = (
      await worker.db
        .prepare('SELECT id,object_key,size FROM lms_media WHERE tenant_id=?')
        .bind(actor.tenantId)
        .all<{ id: string; object_key: string; size: number }>()
    ).results;
    for (const row of registered) {
      const actual = await bucket.head(row.object_key);
      if (!actual || actual.size !== row.size)
        missing.push({ id: row.id, reason: actual ? 'size-mismatch' : 'missing' });
    }
    let cursor: string | undefined,
      protectedCount = 0,
      unknownCount = 0;
    const seen = new Set<string>();
    do {
      const page = await bucket.list({
        prefix: 'media/' + actor.tenantId + '/',
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of page.objects) {
        const state = await orphanStatus(worker.db, object.key, actor.tenantId);
        if (state === 'protected') protectedCount++;
        if (state === 'unknown') unknownCount++;
        const uploadedAt = Number(object.uploaded);
        if (!Number.isSafeInteger(uploadedAt) || uploadedAt < 0)
          throw new Error('Invalid storage upload timestamp');
        if (state === 'orphan' && uploadedAt <= cutoff)
          orphans.push({ key: object.key, size: object.size, etag: object.etag, uploadedAt });
      }
      if (page.truncated) {
        if (!page.cursor || seen.has(page.cursor))
          throw new Error('Invalid storage inventory cursor');
        seen.add(page.cursor);
        cursor = page.cursor;
      } else cursor = undefined;
    } while (cursor);
    orphans.sort((a, b) => a.key.localeCompare(b.key));
    const expired = (
      await worker.db
        .prepare(
          'SELECT id,expires_at AS expiresAt FROM lms_question_imports WHERE tenant_id=? AND expires_at<=? ORDER BY expires_at,id LIMIT 501',
        )
        .bind(actor.tenantId, now)
        .all<{ id: string; expiresAt: number }>()
    ).results;
    const expiredTotal = Number(
      await worker.db
        .prepare('SELECT count(*) n FROM lms_question_imports WHERE tenant_id=? AND expires_at<=?')
        .bind(actor.tenantId, now)
        .first('n'),
    );
    const body: PlanBody = {
      version: 1,
      id: randomUUID(),
      backupId: randomUUID(),
      instanceId: worker.config.instanceId,
      environment: test ? 'test' : 'local',
      tenantId: actor.tenantId,
      createdBy: actor.accountId,
      createdAt: now,
      cutoff,
      minAgeSeconds,
      orphans: orphans.slice(0, 500),
      orphanTotal: orphans.length,
      expired: expired.slice(0, 500),
      expiredTotal,
      missing,
      protectedCount,
      unknownCount,
    };
    const plan = { ...body, checksum: digest(body) };
    await actor.assertFresh();
    await writeFile(await pathFor(plan.id), JSON.stringify(plan, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return plan;
  } finally {
    await worker.mf.dispose();
  }
}
function audit(
  db: D1Database,
  eventId: string,
  actor: StorageOperator,
  action: string,
  plan: MaintenancePlan,
  details: unknown,
) {
  return db
    .prepare(
      'INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,tenant_id,action,reason,request_id,details) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM aio_audit WHERE event_id=?)',
    )
    .bind(
      eventId,
      Date.now(),
      actor.accountId,
      actor.tenantId,
      action,
      'Apply reviewed local maintenance plan with a verified backup',
      plan.id,
      JSON.stringify(details),
      eventId,
    );
}
export async function applyLmsMaintenance(test: boolean, id: string, actor: StorageOperator) {
  await actor.assertFresh();
  const plan = await readMaintenancePlan(test, id, actor);
  if (plan.missing.length) throw new Error('Registered media needs recovery before cleanup');
  const backup = await createLmsBackup(test, actor, plan.backupId);
  assert.equal(backup.instanceId, plan.instanceId);
  const worker = await startLocalLms(test, 0);
  try {
    await validateDb(worker.db, worker.config, actor.tenantId);
    assert.equal(worker.config.instanceId, plan.instanceId);
    const db = worker.db,
      bucket = (await worker.mf.getR2Bucket('LMS_MEDIA')) as unknown as InventoryBucket,
      key = 'lms-maintenance-' + plan.id;
    const prior = await db
      .prepare('SELECT request_hash FROM aio_receipts WHERE actor_account_id=? AND command_key=?')
      .bind(actor.accountId, key)
      .first<{ request_hash: string }>();
    if (prior && prior.request_hash !== plan.checksum)
      throw new Error('Maintenance idempotency key was reused');
    const complete = await db
      .prepare(
        "SELECT details FROM aio_audit WHERE event_id=? AND action='storage.maintenance_completed'",
      )
      .bind(plan.id + ':complete')
      .first<{ details: string }>();
    if (complete) {
      assert.ok(prior);
      return JSON.parse(complete.details) as {
        planId: string;
        checksum: string;
        backupId: string;
        removedOrphans: number;
        expiredPreviews: number;
        completedAt: number;
      };
    }
    // Inspect every target before recording intent or deleting any object.
    for (const object of plan.orphans) {
      if ((await orphanStatus(db, object.key, actor.tenantId)) !== 'orphan')
        throw new Error('Orphan plan changed; no newly referenced media is removed');
      const current = await bucket.head(object.key);
      if (!current && !prior) throw new Error('Orphan plan changed before first application');
      if (
        current &&
        (current.etag !== object.etag ||
          current.size !== object.size ||
          Number(current.uploaded) !== object.uploadedAt)
      )
        throw new Error('Orphan contents changed');
    }
    const expiredIds = JSON.stringify(plan.expired.map((p) => p.id));
    const previews = (
      await db
        .prepare(
          'SELECT id,expires_at AS expiresAt,tenant_id FROM lms_question_imports WHERE id IN (SELECT value FROM json_each(?))',
        )
        .bind(expiredIds)
        .all<{ id: string; expiresAt: number; tenant_id: string }>()
    ).results;
    if (!prior && previews.length !== plan.expired.length)
      throw new Error('Import cleanup plan changed');
    if (
      previews.some(
        (p) =>
          p.tenant_id !== actor.tenantId ||
          p.expiresAt > plan.createdAt ||
          !plan.expired.some((old) => old.id === p.id && old.expiresAt === p.expiresAt),
      )
    )
      throw new Error('Import cleanup plan changed');
    await actor.assertFresh();
    if (!prior)
      await db.batch([
        db
          .prepare(
            'INSERT INTO aio_receipts(actor_account_id,command_key,request_hash,response) VALUES (?,?,?,?)',
          )
          .bind(
            actor.accountId,
            key,
            plan.checksum,
            JSON.stringify({ planId: plan.id, backupId: plan.backupId }),
          ),
        audit(db, plan.id + ':intent', actor, 'storage.maintenance_intent', plan, {
          planId: plan.id,
          checksum: plan.checksum,
          backupId: plan.backupId,
          objects: plan.orphans.length,
          previews: plan.expired.length,
        }),
      ]);
    for (const [index, object] of plan.orphans.entries()) {
      await actor.assertFresh();
      if ((await orphanStatus(db, object.key, actor.tenantId)) !== 'orphan')
        throw new Error('Object became referenced; cleanup stopped');
      const current = await bucket.head(object.key);
      if (current) {
        if (
          current.etag !== object.etag ||
          current.size !== object.size ||
          Number(current.uploaded) !== object.uploadedAt
        )
          throw new Error('Orphan changed');
        await bucket.delete(object.key);
      }
      assert.equal(await bucket.head(object.key), null);
      await db.batch([
        audit(db, plan.id + ':object:' + index, actor, 'storage.orphan_removed', plan, {
          planId: plan.id,
          checksum: plan.checksum,
          key: object.key,
          size: object.size,
        }),
      ]);
    }
    await actor.assertFresh();
    await db.batch([
      db
        .prepare(
          'DELETE FROM lms_question_imports WHERE tenant_id=? AND expires_at<=? AND id IN (SELECT value FROM json_each(?))',
        )
        .bind(actor.tenantId, plan.createdAt, expiredIds),
      audit(db, plan.id + ':previews', actor, 'storage.expired_previews_removed', plan, {
        planId: plan.id,
        checksum: plan.checksum,
        count: plan.expired.length,
      }),
    ]);
    assert.equal(
      await db
        .prepare(
          'SELECT count(*) n FROM lms_question_imports WHERE id IN (SELECT value FROM json_each(?))',
        )
        .bind(expiredIds)
        .first('n'),
      0,
    );
    const result = {
      planId: plan.id,
      checksum: plan.checksum,
      backupId: plan.backupId,
      removedOrphans: plan.orphans.length,
      expiredPreviews: plan.expired.length,
      completedAt: Date.now(),
    };
    await db.batch([
      audit(db, plan.id + ':complete', actor, 'storage.maintenance_completed', plan, result),
    ]);
    return result;
  } finally {
    await worker.mf.dispose();
  }
}
