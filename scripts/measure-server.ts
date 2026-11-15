import { bffClients } from '../src/config.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

// A separate compiled API process keeps browser/test-runner memory out of API measurements.
const runtime = await loadLocalConfig();
const testRuntime = { ...runtime, databaseUrl: testDatabaseUrl(runtime) };
const servers: FastifyInstance[] = [];
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all(servers.map((server) => server.close()));
  process.exit(0);
}
try {
  for (const client of bffClients(runtime)) {
    const server = await createApp({ runtime: testRuntime, client, test: true, logger: false });
    await server.listen({ host: '127.0.0.1', port: client.port });
    servers.push(server);
  }
  process.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    const value = message as { kind?: string; id?: string };
    if (value.kind === 'metrics')
      process.send?.({
        kind: 'metrics',
        id: value.id,
        pid: process.pid,
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        uptime: process.uptime(),
      });
    if (value.kind === 'shutdown') void shutdown();
  });
  process.on('disconnect', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.send?.({
    kind: 'ready',
    pid: process.pid,
    argv: process.argv,
    node: process.version,
    clients: bffClients(runtime).map((client) => ({
      code: client.code,
      port: client.port,
      baseUrl: client.baseUrl,
    })),
  });
} catch {
  process.send?.({ kind: 'failed' });
  await Promise.all(servers.map((server) => server.close()));
  process.exitCode = 1;
}
