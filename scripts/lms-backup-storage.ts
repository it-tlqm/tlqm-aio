import assert from 'node:assert/strict';
import { mkdir, lstat, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { build } from 'esbuild';
import { startLocalLms, localLmsConfig } from './lms-local.js';
import { acquireLmsStorage } from './lms-storage-lock.js';
import type { StorageOperator } from './lms-storage-operator.js';
import type { D1Database, MediaBucket } from '../src/lms/types.js';
import type { LmsConfig } from '../src/lms/security.js';
import { hash } from '../src/lms/security.js';
import { lmsMigrations } from '../src/lms/migrations.js';

const uuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const businessTables = [
  'employees',
  'lessons',
  'learning_progress',
  'learning_attempts',
  'learning_notes',
  'lms_courses',
  'lms_course_versions',
  'lms_media',
  'lms_progress',
  'lms_attempts',
  'lms_notes',
  'lms_certificates',
  'lms_question_bank',
  'lms_question_versions',
  'lms_question_imports',
  'lms_course_receipts',
  'lms_learning_paths',
  'lms_learning_path_versions',
  'lms_training_batches',
  'lms_training_enrollments',
  'lms_training_intakes',
  'aio_receipts',
  'aio_external_links',
];
type FileEntry = { path: string; size: number; sha256: string };
type Snapshot = {
  operationalHash: string;
  business: { table: string; rows: number; sha256: string }[];
  ownershipHash: string;
  audit: { maxId: number; count: number; sha256: string };
  mediaCount: number;
  schema: { version: string; checksum: string }[];
};
export type LmsBackup = {
  version: 1;
  id: string;
  environment: 'local' | 'test';
  instanceId: string;
  tenantId: string;
  createdBy: string;
  createdAt: string;
  state: 'complete';
  files: FileEntry[];
  snapshot: Snapshot;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fileHash(path: string) {
  const result = createHash('sha256');
  for await (const part of createReadStream(path)) result.update(part);
  return result.digest('hex');
}
export async function privateStorageDirectory(path: string) {
  const base = resolve('.local'),
    target = resolve(path),
    within = relative(base, target);
  if (within.startsWith('..') || isAbsolute(within))
    throw new Error('Storage target is outside the isolated workspace.');
  let current = base;
  for (const part of ['', ...within.split(/[\\/]/).filter(Boolean)]) {
    if (part) current = resolve(current, part);
    await mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Linked storage directories are refused.');
  }
  return target;
}
function contained(root: string, path: string) {
  const destination = resolve(root, path),
    within = relative(root, destination);
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error('Invalid backup member path.');
  return destination;
}
async function tree(root: string, directory = root): Promise<FileEntry[]> {
  const output: FileEntry[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = contained(root, relative(root, resolve(directory, name))),
      info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Linked backup members are refused.');
    if (info.isDirectory()) output.push(...(await tree(root, path)));
    else if (info.isFile())
      output.push({
        path: relative(root, path).replaceAll('\\', '/'),
        size: info.size,
        sha256: await fileHash(path),
      });
    else throw new Error('Unsupported backup member.');
  }
  return output;
}
export async function validateDb(db: D1Database, config: LmsConfig, tenantId: string) {
  assert.deepEqual(
    (await db.prepare('SELECT instance_id,purpose FROM environment_marker').all()).results,
    [{ instance_id: config.instanceId, purpose: config.purpose }],
  );
  const schema = (
    await db
      .prepare('SELECT version,checksum FROM schema_migrations ORDER BY version')
      .all<{ version: string; checksum: string }>()
  ).results;
  assert.deepEqual(
    schema,
    await Promise.all(
      lmsMigrations.map(async (m) => ({
        version: m.version,
        checksum: await hash(JSON.stringify(m.statements)),
      })),
    ),
  );
  for (const table of [
    'aio_account_links',
    'lms_courses',
    'lms_media',
    'lms_question_bank',
    'lms_question_imports',
    'lms_certificates',
    'lms_learning_paths',
    'lms_learning_path_versions',
    'lms_training_batches',
    'lms_training_enrollments',
    'lms_training_intakes',
  ])
    assert.equal(
      await db
        .prepare('SELECT count(*) n FROM ' + table + ' WHERE tenant_id<>?')
        .bind(tenantId)
        .first<number>('n'),
      0,
      'Storage includes an unauthorized tenant',
    );
  assert.equal(
    await db
      .prepare(
        'SELECT count(*) n FROM employees e WHERE NOT EXISTS(SELECT 1 FROM aio_account_links a WHERE a.employee_id=e.id AND a.tenant_id=?)',
      )
      .bind(tenantId)
      .first<number>('n'),
    0,
    'Unmapped employee ownership requires explicit review',
  );
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  return schema;
}
export async function snapshotLmsStorage(
  db: D1Database,
  config: LmsConfig,
  tenantId: string,
): Promise<Snapshot> {
  const schema = await validateDb(db, config, tenantId),
    business = [];
  for (const table of businessTables) {
    const rows = (await db.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2').all()).results;
    business.push({ table, rows: rows.length, sha256: digest(rows) });
  }
  const ownership = (
    await db
      .prepare(
        'SELECT account_id,person_id,employee_id,tenant_id,org_unit_id FROM aio_account_links ORDER BY account_id',
      )
      .all()
  ).results;
  const audit = (await db.prepare('SELECT * FROM aio_audit ORDER BY id').all()).results;
  const operational = [];
  for (const table of [
    'aio_account_links',
    'aio_adapter_control',
    'aio_sessions',
    'aio_login_transactions',
    'aio_logout_receipts',
    'sessions',
  ])
    operational.push([
      table,
      (await db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()).results,
    ]);
  return {
    operationalHash: digest(operational),
    business,
    ownershipHash: digest(ownership),
    audit: { maxId: Number(audit.at(-1)?.id ?? 0), count: audit.length, sha256: digest(audit) },
    mediaCount: Number(await db.prepare('SELECT count(*) n FROM lms_media').first('n')),
    schema,
  };
}
export async function verifyStoredMedia(db: D1Database, bucket: MediaBucket) {
  const rows = (
    await db
      .prepare('SELECT object_key,size,sha256 FROM lms_media ORDER BY id')
      .all<{ object_key: string; size: number; sha256: string }>()
  ).results;
  let bytes = 0;
  for (const row of rows) {
    const object = await bucket.get(row.object_key);
    assert.ok(object?.body, 'Registered media is missing');
    assert.equal(object.size, row.size);
    const stream = object.body.getReader(),
      sum = createHash('sha256');
    let read = 0;
    for (;;) {
      const part = await stream.read();
      if (part.done) break;
      read += part.value.byteLength;
      sum.update(part.value);
    }
    assert.equal(read, row.size);
    assert.equal(sum.digest('hex'), row.sha256);
    bytes += read;
  }
  return { objects: rows.length, bytes };
}
async function backupRoot(id: string) {
  if (!uuid(id)) throw new Error('Invalid backup identifier.');
  return resolve(await privateStorageDirectory('.local/lms-backups'), id);
}

// Call only while the source Worker is closed and the caller holds exclusive storage access.
export async function copyLmsStorage(source: string, destination: string, expected?: FileEntry[]) {
  assert.equal(await privateStorageDirectory(source), source);
  assert.equal(await privateStorageDirectory(destination), destination);
  const files: FileEntry[] = [];
  for (const name of ['d1', 'r2']) {
    const directory = resolve(source, name);
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Invalid storage directory.');
    for (const entry of await tree(directory))
      files.push({ ...entry, path: name + '/' + entry.path });
  }
  assert.ok(
    files.some(({ path }) => path.startsWith('d1/')),
    'Backup has no D1 data.',
  );
  if (expected) {
    const ordered = (entries: FileEntry[]) =>
      [...entries].sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(ordered(files), ordered(expected));
  }
  for (const entry of files) {
    const target = contained(destination, entry.path);
    await privateStorageDirectory(dirname(target));
    await copyFile(contained(source, entry.path), target, constants.COPYFILE_EXCL);
    assert.equal(await fileHash(target), entry.sha256);
  }
  return files;
}

// The caller owns the fresh restore, and must verify the archive before applying this policy.
export async function quarantineLmsRestore(
  db: D1Database,
  accountId: string,
  tenantId: string,
  restoreId: string,
  backupId: string,
  sourceEnvironment: string,
  mediaCount: number,
) {
  await db.batch([
    db
      .prepare(
        'UPDATE aio_adapter_control SET enabled=0,revision=revision+1,last_operation_id=? WHERE id=1',
      )
      .bind(restoreId),
    db
      .prepare(
        'UPDATE aio_account_links SET active=0,auth_not_before=max(auth_not_before,unixepoch()),revision=revision+1,last_operation_id=?',
      )
      .bind(restoreId),
    db.prepare('DELETE FROM aio_sessions'),
    db.prepare('DELETE FROM aio_login_transactions'),
    db.prepare('DELETE FROM sessions'),
    db
      .prepare(
        `INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,tenant_id,action,reason,request_id,details)
       VALUES (?,?,?,?,'storage.restored_isolated','Restore verified backup with all mappings and old sessions disabled',?,?)`,
      )
      .bind(
        restoreId,
        Date.now(),
        accountId,
        tenantId,
        restoreId,
        JSON.stringify({ backupId, sourceEnvironment, mediaCount }),
      ),
  ]);
}
export async function readLmsBackup(test: boolean, id: string) {
  const root = await backupRoot(id),
    config = await localLmsConfig(test),
    info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error('Unidentified backup directory.');
  const manifestPath = resolve(root, 'manifest.json'),
    manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile())
    throw new Error('Invalid backup manifest.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as LmsBackup;
  if (
    manifest.version !== 1 ||
    manifest.state !== 'complete' ||
    manifest.id !== id ||
    manifest.environment !== (test ? 'test' : 'local') ||
    manifest.instanceId !== config.instanceId ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw new Error('Backup identity or environment mismatch.');
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (
      !/^((d1)|(r2))\//.test(entry.path) ||
      entry.path.split(/[\\/]/).some((p) => p === '..' || p === '') ||
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    )
      throw new Error('Invalid backup member.');
    seen.add(entry.path);
    const path = contained(root, entry.path);
    let parent = dirname(path);
    while (parent !== root) {
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error('Linked backup member parent.');
      parent = dirname(parent);
    }
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.size !== entry.size ||
      (await fileHash(path)) !== entry.sha256
    )
      throw new Error('Backup file integrity failed.');
  }
  if (!manifest.files.some((f) => f.path.startsWith('d1/')))
    throw new Error('Backup has no D1 data.');
  return { root, manifest, config };
}
export async function createLmsBackup(
  test: boolean,
  actor: StorageOperator,
  id: string = randomUUID(),
) {
  await actor.assertFresh();
  const root = await backupRoot(id);
  try {
    await lstat(root);
    const prior = await readLmsBackup(test, id);
    assert.equal(prior.manifest.createdBy, actor.accountId);
    assert.equal(prior.manifest.tenantId, actor.tenantId);
    return prior.manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const worker = await startLocalLms(test, 0, { keepLockAfterDispose: true });
  try {
    const data = await snapshotLmsStorage(worker.db, worker.config, actor.tenantId);
    await verifyStoredMedia(
      worker.db,
      (await worker.mf.getR2Bucket('LMS_MEDIA')) as unknown as MediaBucket,
    );
    await actor.assertFresh();
    await worker.mf.dispose();
    await mkdir(root, { mode: 0o700 }); // Unique output only; never overwrite a partial or completed backup.
    const files = await copyLmsStorage(worker.target, root);
    await actor.assertFresh();
    const manifest: LmsBackup = {
      version: 1,
      id,
      environment: test ? 'test' : 'local',
      instanceId: worker.config.instanceId,
      tenantId: actor.tenantId,
      createdBy: actor.accountId,
      createdAt: new Date().toISOString(),
      state: 'complete',
      files,
      snapshot: data,
    };
    await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return manifest;
  } finally {
    await worker.mf.dispose();
    await worker.releaseStorage();
  }
}
export async function restoreLmsBackup(test: boolean, id: string, actor: StorageOperator) {
  await actor.assertFresh();
  const { root: source, manifest, config } = await readLmsBackup(test, id);
  assert.equal(manifest.tenantId, actor.tenantId);
  const lease = await acquireLmsStorage(test ? 'test' : 'local'),
    restoreId = randomUUID();
  let mf: Miniflare | undefined;
  try {
    const parent = await privateStorageDirectory('.local/lms-restores'),
      root = resolve(parent, restoreId);
    await mkdir(root, { mode: 0o700 });
    for (const entry of manifest.files) {
      const destination = contained(root, entry.path);
      await privateStorageDirectory(dirname(destination));
      await copyFile(contained(source, entry.path), destination, constants.COPYFILE_EXCL);
      assert.equal(await fileHash(destination), entry.sha256);
    }
    await build({
      entryPoints: ['src/lms/worker.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2023',
      outfile: resolve(root, 'worker.mjs'),
      logLevel: 'silent',
    });
    mf = new Miniflare({
      modules: true,
      scriptPath: resolve(root, 'worker.mjs'),
      compatibilityDate: '2026-07-30',
      host: '127.0.0.1',
      port: 0,
      d1Databases: { LMS_DB: config.instanceId },
      d1Persist: resolve(root, 'd1'),
      r2Buckets: { LMS_MEDIA: config.instanceId + '-media' },
      r2Persist: resolve(root, 'r2'),
      bindings: { LMS_CONFIG: JSON.stringify(config) },
      assets: {
        directory: resolve('frontend/dist'),
        binding: 'ASSETS',
        routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      },
      log: new Log(LogLevel.NONE),
    });
    await mf.ready;
    const db = (await mf.getD1Database('LMS_DB')) as unknown as D1Database;
    assert.deepEqual(await snapshotLmsStorage(db, config, actor.tenantId), manifest.snapshot);
    const media = await verifyStoredMedia(
      db,
      (await mf.getR2Bucket('LMS_MEDIA')) as unknown as MediaBucket,
    );
    await actor.assertFresh();
    await quarantineLmsRestore(
      db,
      actor.accountId,
      actor.tenantId,
      restoreId,
      id,
      manifest.environment,
      media.objects,
    );
    const after = await snapshotLmsStorage(db, config, actor.tenantId);
    assert.deepEqual(after.business, manifest.snapshot.business);
    assert.equal(after.ownershipHash, manifest.snapshot.ownershipHash);
    const oldAudit = (
      await db
        .prepare('SELECT * FROM aio_audit WHERE id<=? ORDER BY id')
        .bind(manifest.snapshot.audit.maxId)
        .all()
    ).results;
    assert.equal(oldAudit.length, manifest.snapshot.audit.count);
    assert.equal(digest(oldAudit), manifest.snapshot.audit.sha256);
    assert.equal(
      await db.prepare('SELECT count(*) n FROM aio_account_links WHERE active<>0').first('n'),
      0,
    );
    for (const table of ['aio_sessions', 'aio_login_transactions', 'sessions'])
      assert.equal(await db.prepare('SELECT count(*) n FROM ' + table).first('n'), 0);
    const denied = await mf.dispatchFetch(config.baseUrl + '/api/v1/me');
    assert.equal(denied.status, 503);
    assert.equal(((await denied.json()) as { error: string }).error, 'LMS_ADAPTER_DISABLED');
    const receipt = {
      version: 1,
      restoreId,
      backupId: id,
      sourceEnvironment: manifest.environment,
      instanceId: config.instanceId,
      createdAt: new Date().toISOString(),
      createdBy: actor.accountId,
      policy: 'isolated-disabled',
      businessRetained: true,
      ownershipRetained: true,
      originalAuditRetained: true,
      sessionsCleared: true,
      media,
    };
    await mf.dispose();
    mf = undefined;
    await writeFile(resolve(root, 'restore.json'), JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return { root, receipt };
  } finally {
    await mf?.dispose();
    await lease.release();
  }
}
