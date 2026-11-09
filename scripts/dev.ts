import { loadLocalConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const runtime = await loadLocalConfig();
const servers: FastifyInstance[] = [];
for (const client of runtime.clients) {
  const app = await createApp({ runtime, client });
  await app.listen({ host: '127.0.0.1', port: client.port });
  servers.push(app);
  console.log(client.name + ' ready: ' + client.baseUrl);
}
const shutdown = async () => {
  await Promise.all(servers.map((app) => app.close()));
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
