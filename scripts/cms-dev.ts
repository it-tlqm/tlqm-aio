import type { FastifyInstance } from 'fastify';
import { loadLocalConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const runtime = await loadLocalConfig();
const client = runtime.clients.find(
  (value) => value.code === 'aio-cms' && value.kind === 'application',
);
if (!client) throw new Error('Provision aio-cms before starting the CMS server.');
const app: FastifyInstance = await createApp({ runtime, client });
await app.listen({ host: '127.0.0.1', port: client.port });
console.log('AIO CMS ready: ' + client.baseUrl);
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
