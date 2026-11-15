import { withStorageOperator } from './lms-storage-operator.js';
import { planLmsMaintenance, applyLmsMaintenance } from './lms-maintenance-storage.js';
const [environment, action, value] = process.argv.slice(2);
try {
  if (!['local', 'test'].includes(environment ?? '') || !['plan', 'apply'].includes(action ?? ''))
    throw new Error('Invalid arguments');
  await withStorageOperator(environment === 'test', async (actor) => {
    if (action === 'plan') {
      const plan = await planLmsMaintenance(
        environment === 'test',
        actor,
        value === undefined ? 3600 : Number(value),
      );
      console.log(
        'Maintenance plan ' +
          plan.id +
          ': ' +
          plan.orphans.length +
          '/' +
          plan.orphanTotal +
          ' orphan objects, ' +
          plan.expired.length +
          '/' +
          plan.expiredTotal +
          ' expired previews; ' +
          plan.missing.length +
          ' missing/mismatched registered media, ' +
          plan.protectedCount +
          ' recovery candidates protected, ' +
          plan.unknownCount +
          ' unexpected keys ignored.',
      );
    } else {
      if (!value) throw new Error('Plan identifier required');
      const result = await applyLmsMaintenance(environment === 'test', value, actor);
      console.log(
        'Maintenance ' +
          result.planId +
          ' complete: ' +
          result.removedOrphans +
          ' orphan objects and ' +
          result.expiredPreviews +
          ' expired previews removed; backup ' +
          result.backupId +
          '.',
      );
    }
  });
} catch {
  console.error(
    'LMS maintenance refused or incomplete. Use local|test plan [minAgeSeconds] or local|test apply planId. Rerun the same plan after resolving the cause; sensitive details omitted.',
  );
  process.exitCode = 1;
}
