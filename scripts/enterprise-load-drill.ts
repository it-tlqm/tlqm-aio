import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { loadKinds, runMixedLoad } from './enterprise-mixed-load.js';
import type { LoadSession } from './enterprise-mixed-load.js';

const root = await realpath('.');
const local = join(root, '.local');
await mkdir(local, { recursive: true });
assert.equal(await realpath(local), local);
const evidence = join(local, 'evidence');
await mkdir(evidence, { recursive: true });
assert.equal(await realpath(evidence), evidence);

const app = Fastify({ bodyLimit: 8192, logger: false });
const fixtures = new Map<string, { tenant: string; revision: number; completed: Set<string> }>();
let injectFailure = false;
let serverInFlight = 0;
let serverPeak = 0;
let effects = 0;
let replays = 0;
for (const kind of loadKinds) {
  app.route<{ Params: { tenant: string }; Body: { key?: string } }>({
    method: kind === 'write' ? 'POST' : 'GET',
    url: '/fixture/:tenant/' + kind,
    async handler(request, reply) {
      const id = request.headers['x-fixture-session'];
      const session = typeof id === 'string' ? fixtures.get(id) : undefined;
      if (!session || session.tenant !== request.params.tenant) return reply.code(403).send({});
      serverInFlight++;
      serverPeak = Math.max(serverPeak, serverInFlight);
      try {
        await delay(kind === 'report' ? 15 : 8);
        if (injectFailure && kind === 'report') return reply.code(503).send({});
        if (kind === 'transfer')
          return reply.type('application/octet-stream').send(Buffer.alloc(4096));
        if (kind === 'write') {
          const key = request.body?.key;
          if (!key) return reply.code(400).send({});
          if (!session.completed.has(key)) {
            session.completed.add(key);
            session.revision++;
            effects++;
          } else replays++;
        }
        return { revision: session.revision };
      } finally {
        serverInFlight--;
      }
    },
  });
}

try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const sessions: LoadSession[] = Array.from({ length: 100 }, (_, index) => {
    const tenant = index % 2 === 0 ? 'a' : 'b';
    const id = randomUUID();
    const key = randomUUID();
    fixtures.set(id, { tenant, revision: 0, completed: new Set() });
    return {
      id,
      tenant,
      actions: loadKinds.map((kind) => ({
        name: 'fixture-' + kind,
        kind,
        async run(signal) {
          const response = await fetch(base + '/fixture/' + tenant + '/' + kind, {
            signal,
            redirect: 'manual',
            headers: {
              'x-fixture-session': id,
              ...(kind === 'write' && { 'content-type': 'application/json' }),
            },
            ...(kind === 'write' && { method: 'POST', body: JSON.stringify({ key }) }),
          });
          return {
            status: response.status,
            expected: response.status === 200,
            bytes: (await response.arrayBuffer()).byteLength,
          };
        },
      })),
    };
  });
  const denied = await fetch(base + '/fixture/b/read', {
    headers: { 'x-fixture-session': sessions[0]!.id },
  });
  assert.equal(denied.status, 403);
  await denied.arrayBuffer();
  const workload = {
    durationMs: 2500,
    thinkMs: 70,
    timeoutMs: 2500,
    sampleMs: 250,
    sample: async () => ({ serverInFlight, serverPeak }),
  };
  const healthy = await runMixedLoad(sessions, workload);
  assert.equal(healthy.activeSessions, 100);
  assert.equal(healthy.unexpected, 0);
  assert.equal(healthy.sampleFailures, 0);
  assert.equal(healthy.meetsDuration, false);
  assert.equal(healthy.meetsThresholds, true);
  assert.ok(healthy.groups.transfer.bytes > 0 && healthy.peakInFlight > 1);
  assert.equal(effects, 100);
  assert.ok(replays > 0);
  injectFailure = true;
  const fault = await runMixedLoad(sessions, { ...workload, durationMs: 1200 });
  assert.ok(fault.errorRatio >= 0.01);
  assert.equal(fault.meetsThresholds, false);
  assert.equal(fault.groups.report.statuses['503'], fault.groups.report.requests);
  assert.equal(fault.unexpected, fault.groups.report.requests);
  const completedAt = new Date(),
    run = randomUUID();
  const implementation = await import('node:fs/promises').then(({ readFile }) =>
    readFile(join(root, 'scripts', 'enterprise-mixed-load.ts')),
  );
  const receipt = {
    status: 'pass',
    scope: 'load-generator-component',
    run,
    completedAt: completedAt.toISOString(),
    completedAtVietnam: completedAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    generatorSha256: createHash('sha256').update(implementation).digest('hex'),
    node: process.version,
    host: { logicalCpus: cpus().length, cpuModel: cpus()[0]?.model, totalMemoryBytes: totalmem() },
    crossTenantDenied: true,
    fixtureEffects: effects,
    fixtureReplays: replays,
    healthy,
    fault,
  };
  const path = join(evidence, 'enterprise-e3-load-drill-' + run + '.json');
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      path,
      sessions: healthy.activeSessions,
      requests: healthy.requests,
      unexpected: healthy.unexpected,
      faultUnexpected: fault.unexpected,
      healthyGroups: healthy.groups,
      completedAtVietnam: receipt.completedAtVietnam,
    }),
  );
} finally {
  await app.close();
}
