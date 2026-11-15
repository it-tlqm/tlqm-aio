import { withStorageOperator } from './lms-storage-operator.js';
import { createLmsBackup, restoreLmsBackup } from './lms-backup-storage.js';
const [environment, action, id] = process.argv.slice(2);
try {
  if (
    !['local', 'test'].includes(environment ?? '') ||
    !['create', 'restore'].includes(action ?? '') ||
    (action === 'restore' && !id)
  )
    throw new Error('Invalid arguments');
  await withStorageOperator(environment === 'test', async (actor) => {
    if (action === 'create') {
      const backup = await createLmsBackup(environment === 'test', actor, id);
      console.log(
        'Verified LMS backup ' +
          backup.id +
          ' created in .local/lms-backups; ' +
          backup.files.length +
          ' files. Credentials/configuration are not exported.',
      );
    } else {
      const restored = await restoreLmsBackup(environment === 'test', id!, actor);
      console.log(
        'Verified isolated restore ' +
          restored.receipt.restoreId +
          ' in .local/lms-restores. Adapter/mappings disabled; old sessions removed; source storage retained.',
      );
    }
  });
} catch {
  console.error(
    'LMS backup/restore refused or failed. Usage: lms:backup -- local|test create [backupId] | local|test restore backupId. Sensitive details omitted.',
  );
  process.exitCode = 1;
}
