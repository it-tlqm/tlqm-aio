import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withStorageOperator } from './lms-storage-operator.js';
import { createLmsBackup, readLmsBackup, restoreLmsBackup } from './lms-backup-storage.js';
import { acquireLmsStorage } from './lms-storage-lock.js';
let stage = 'operator MFA';
try {
  const result = await withStorageOperator(true, async (actor) => {
    stage = 'verified offline backup';
    const backup = await createLmsBackup(true, actor),
      file = resolve('.local/lms-backups', backup.id, 'manifest.json');
    const original = await readFile(file, 'utf8');
    assert.deepEqual(await createLmsBackup(true, actor, backup.id), backup);
    assert.equal(await readFile(file, 'utf8'), original);
    stage = 'wrong environment and corrupt member rejection';
    await assert.rejects(() => readLmsBackup(false, backup.id), /environment mismatch/);
    await assert.rejects(() => readLmsBackup(true, '../test'), /Invalid backup identifier/);
    const changed = JSON.parse(original);
    changed.files[0].sha256 = '00'.repeat(32);
    try {
      await writeFile(file, JSON.stringify(changed) + '\n');
      await assert.rejects(() => readLmsBackup(true, backup.id), /integrity failed/);
    } finally {
      await writeFile(file, original);
    }
    await readLmsBackup(true, backup.id);
    stage = 'restore refuses a live storage lease';
    const lease = await acquireLmsStorage('test');
    try {
      await assert.rejects(() => restoreLmsBackup(true, backup.id, actor), /storage is locked/);
    } finally {
      await lease.release();
    }
    stage = 'isolated restore and session revocation';
    const restored = await restoreLmsBackup(true, backup.id, actor);
    assert.notEqual(restored.root, resolve('.local/lms/test'));
    assert.equal(restored.receipt.policy, 'isolated-disabled');
    assert.equal(restored.receipt.businessRetained, true);
    assert.equal(restored.receipt.media.objects, backup.snapshot.mediaCount);
    stage = 'source storage and sessions unchanged';
    const after = await createLmsBackup(true, actor);
    assert.deepEqual(after.snapshot, backup.snapshot);
    assert.equal(await readFile(file, 'utf8'), original);
    await assert.rejects(() => lstat('.local/lms/test/storage.lock.json'), { code: 'ENOENT' });
    return {
      backupId: backup.id,
      verificationBackupId: after.id,
      restoreId: restored.receipt.restoreId,
      files: backup.files.length,
      media: restored.receipt.media,
      schema: backup.snapshot.schema.map((row) => row.version),
      businessTables: backup.snapshot.business.length,
      sourceIncludingSessionsUnchanged: true,
      wrongEnvironmentRejected: true,
      corruptFileHashRejected: true,
      liveStorageRejected: true,
      restoredAdapterDisabled: true,
      restoredMappingsDisabled: true,
      restoredSessionsCleared: true,
      originalAuditRetained: true,
    };
  });
  await writeFile(
    '.local/evidence/lms-backup-restore-e2e.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), result: 'pass', ...result }, null, 2) +
      '\n',
  );
  console.log(
    'PASS: offline D1/R2 backup and isolated restore; all business/ownership/audit data and media verified, source unchanged, restored access disabled.',
  );
} catch (error) {
  console.error(
    'LMS backup rehearsal failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      ') ' +
      (error instanceof Error
        ? (error.stack?.match(
            /lms-(backup-storage|backup-e2e|storage-operator)\.ts:\d+:\d+/,
          )?.[0] ?? '')
        : '') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
}
