import { loadLocalConfig } from '../src/config.js';
import { reminderRuntime } from './work-center-runtime.js';
const worker = await reminderRuntime(await loadLocalConfig());
const once = process.argv.includes('--once');
const tick = () =>
  worker
    .tick()
    .then((result) => console.log('Work center reminder tick completed', result))
    .catch(() => {
      console.error('Work center reminder tick failed; check local services and worker status.');
      if (once) process.exitCode = 1;
    });
await tick();
if (once) await worker.close();
else {
  const timer = setInterval(() => void tick(), 30000);
  const stop = async () => {
    clearInterval(timer);
    await worker.close();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}
