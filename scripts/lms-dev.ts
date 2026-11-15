import { startLocalLms, migrateLms } from './lms-local.js';
import { localContainer } from './local-docker.js';
import { loadLocalConfig } from '../src/config.js';
import { lmsReminderRuntime } from './lms-reminders-runtime.js';
let worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
let reminders: Awaited<ReturnType<typeof lmsReminderRuntime>> | undefined;
let reminderTimer: ReturnType<typeof setInterval> | undefined;
try {
  if (
    !(await localContainer('keycloak')).running ||
    !(await localContainer('foundation-db')).running
  )
    throw new Error('Local dependencies required');
  worker = await startLocalLms(false);
  await migrateLms(worker.db, worker.config);
  reminders = await lmsReminderRuntime(await loadLocalConfig(), worker.db, worker.config);
  const remind = () =>
    void reminders
      ?.tick()
      .catch(() => console.error('Training reminders unavailable; retrying next tick.'));
  remind();
  reminderTimer = setInterval(remind, 30000);
  console.log(
    'LMS sandbox: http://127.0.0.1:4104 — run Foundation with npm run dev; Ctrl+C stops this Worker.',
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(reminderTimer);
    await reminders?.close();
    await worker?.mf.dispose();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
} catch {
  clearInterval(reminderTimer);
  await reminders?.close();
  await worker?.mf.dispose();
  console.error('LMS sandbox failed to start; verify isolated setup and free port 4104.');
  process.exitCode = 1;
}
