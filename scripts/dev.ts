import { bffClients } from '../src/config.js';
import { loadLocalConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { reminderRuntime } from './work-center-runtime.js';

const runtime = await loadLocalConfig();
const servers: FastifyInstance[] = [];
for (const client of bffClients(runtime)) {
  const app = await createApp({ runtime, client });
  await app.listen({ host: '127.0.0.1', port: client.port });
  servers.push(app);
  console.log(client.name + ' ready: ' + client.baseUrl);
}
const reminders = runtime.clients.some((c) => c.code === 'aio-workflows')
  ? await reminderRuntime(runtime)
  : null;
const remind = () =>
  void reminders
    ?.tick()
    .catch(() => console.error('Local Workflows background worker failed; retrying next tick.'));
remind();
const reminderTimer = setInterval(remind, 30000);
const shutdown = async () => {
  clearInterval(reminderTimer);
  await reminders?.close();
  await Promise.all(servers.map((app) => app.close()));
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
