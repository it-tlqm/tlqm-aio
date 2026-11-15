import { startLocalLms } from './lms-local.js';
const environment = process.argv[2] ?? 'local';
let worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
try {
  if (!['local', 'test'].includes(environment)) throw new Error('Unknown environment');
  worker = await startLocalLms(environment === 'test', 0);
  const marker = await worker.db
    .prepare('SELECT instance_id,purpose FROM environment_marker WHERE id=1')
    .first<{ instance_id: string; purpose: string }>();
  if (marker?.instance_id !== worker.config.instanceId || marker?.purpose !== worker.config.purpose)
    throw new Error('Marker mismatch');
  console.log('LMS isolated ' + environment + ' — synthetic data only');
  console.table(
    (await worker.db.prepare('SELECT enabled,revision FROM aio_adapter_control').all()).results,
  );
  console.table(
    (
      await worker.db
        .prepare(
          'SELECT account_id,employee_id,org_unit_id,active,revision FROM aio_account_links ORDER BY employee_id',
        )
        .all()
    ).results,
  );
} catch {
  console.error('LMS status unavailable; configuration and credentials omitted.');
  process.exitCode = 1;
} finally {
  await worker?.mf.dispose();
}
