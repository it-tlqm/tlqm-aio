import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { Log, LogLevel, Miniflare, Response as WorkerResponse } from 'miniflare';
import type { Request as WorkerRequest } from 'miniflare';
import type { AppRuntime } from '../src/config.js';
import type { Store } from '../src/store.js';
import { ids } from '../src/fixtures.js';
import type { D1Database } from '../src/lms/types.js';
import { validateLmsConfig } from '../src/lms/security.js';
import { stagingTarget } from '../src/staging-endpoints.js';
import type { PortalWorkQuery } from '../src/portal-work-proof.js';
import { lmsTelemetryBinding } from './staging-lms.js';
import {
  createStagingTelemetry,
  openTelemetryAlerts,
  writeTelemetryDashboard,
} from './staging-telemetry.js';

const [release, digest, ...extra] = process.argv.slice(2);
if (
  !release ||
  !/^[a-z0-9][a-z0-9-]{0,39}$/.test(release) ||
  !digest ||
  !/^[0-9a-f]{64}$/.test(digest) ||
  extra.length
)
  throw new Error('Use telemetry-drill.ts <release-name> <artifact-sha256>.');
const root = await realpath('.');
const artifact = join(root, '.local', 'releases', release, 'artifact');
assert.equal(
  spawnSync(process.execPath, ['scripts/release.mjs', 'verify', artifact, digest], {
    stdio: 'ignore',
    windowsHide: true,
  }).status,
  0,
);
const versioned = (path: string) => pathToFileURL(join(artifact, 'dist/src', path)).href;
const { registerTrainingWorkCenter } = (await import(
  versioned('training-work-center-boundary.js')
)) as typeof import('../src/training-work-center-boundary.js');
const { registerBffTelemetry, bffSpan } = (await import(
  versioned('bff-telemetry.js')
)) as typeof import('../src/bff-telemetry.js');
const { verifyPortalWorkProof } = (await import(
  versioned('portal-work-proof.js')
)) as typeof import('../src/portal-work-proof.js');
const { migrateLms } = (await import(
  versioned('lms/database.js')
)) as typeof import('../src/lms/database.js');

const run = randomUUID();
const local = join(root, '.local');
assert.equal(await realpath(local), local);
const parent = join(local, 'telemetry');
await mkdir(parent, { recursive: true });
assert.equal(await realpath(parent), parent);
const directory = join(parent, run);
await mkdir(directory, { mode: 0o700 });
const log = join(directory, 'observations.ndjson');
let clockOffset = 0;
const telemetry = await createStagingTelemetry(log, () => Date.now() + clockOffset);
const alertPath = join(directory, 'alerts.ndjson');
const alertLog = await openTelemetryAlerts(alertPath, telemetry);
const dashboard = join(directory, 'dashboard.html');

const slot = 'a';
const target = stagingTarget(slot);
const portalBase = 'https://127.0.0.1:' + target.foundation;
const config = validateLmsConfig({
  mode: 'staging',
  slot,
  instanceId: run,
  purpose: 'tlqm-aio-lms-staging',
  issuer: target.issuer,
  baseUrl: 'https://127.0.0.1:' + target.lms,
  foundationUrl: portalBase + '/api/v1/integrations/aio-lms-sandbox/authorize',
  clientId: 'aio-lms-sandbox',
  audience: 'aio-lms-sandbox-api',
  clientSecret: randomBytes(32).toString('hex'),
  encryptionKey: randomBytes(32).toString('hex'),
});
const route = '/api/v1/integrations/aio-lms-sandbox/portal-work-authorize';
const feed = '/api/v1/work-center/training?tenantId=' + ids.tenantA;
const marker = 'synthetic-private-fixture-marker';
const delegatedAccessToken = randomBytes(24).toString('hex');
const principal = {
  accountId: ids.learner,
  personId: ids.learner,
  displayName: marker,
  permissions: [],
};
const identity = { issuer: config.issuer, subject: randomUUID() };
let dependencyUnavailable = false;
const foundation = Fastify({ genReqId: () => randomUUID(), requestIdHeader: false });
const portal = Fastify({ genReqId: () => randomUUID(), requestIdHeader: false });
registerBffTelemetry(foundation, 'aio-foundation', telemetry.observe);
registerBffTelemetry(portal, 'aio-foundation', telemetry.observe);
foundation.post<{ Body: PortalWorkQuery }>(route, async (request, reply) => {
  const proof = request.headers['x-aio-service-proof'];
  if (
    request.headers.authorization !== 'Bearer ' + delegatedAccessToken ||
    typeof proof !== 'string' ||
    !(await verifyPortalWorkProof(
      config.clientSecret,
      config.clientId,
      delegatedAccessToken,
      request.body,
      'authorize',
      proof,
    ))
  )
    return reply.code(403).send({ error: 'FIXTURE_PROOF_REQUIRED' });
  bffSpan(request)?.acceptParent(request.headers.traceparent);
  if (dependencyUnavailable)
    return reply.code(503).send({ error: 'FIXTURE_DEPENDENCY_UNAVAILABLE' });
  return {
    version: 1,
    appCode: config.clientId,
    ...identity,
    ...principal,
    tenantIds: [ids.tenantA],
    units: [{ tenantId: ids.tenantA, orgUnitId: ids.unitA }],
    permissions: [{ tenantId: ids.tenantA, permission: 'lms:learn', orgUnitId: ids.unitA }],
    authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ['pwd', 'otp'],
    maxAgeSeconds: 0,
  };
});

const worker = new Miniflare({
  modules: true,
  scriptPath: join(artifact, 'dist/lms/worker.mjs'),
  compatibilityDate: '2026-07-30',
  host: '127.0.0.1',
  port: 0,
  cf: false,
  log: new Log(LogLevel.NONE),
  d1Databases: { LMS_DB: run },
  r2Buckets: { LMS_MEDIA: run + '-media' },
  bindings: { LMS_CONFIG: JSON.stringify(config) },
  serviceBindings: { AIO_TELEMETRY: lmsTelemetryBinding(telemetry.observe) },
  async outboundService(request: WorkerRequest) {
    if (
      request.method === 'GET' &&
      request.url === config.issuer + '/.well-known/openid-configuration'
    ) {
      const endpoint = config.issuer + '/protocol/openid-connect/';
      return WorkerResponse.json({
        issuer: config.issuer,
        authorization_endpoint: endpoint + 'auth',
        token_endpoint: endpoint + 'token',
        jwks_uri: endpoint + 'certs',
        introspection_endpoint: endpoint + 'token/introspect',
        end_session_endpoint: endpoint + 'logout',
      });
    }
    if (request.method !== 'POST' || request.url !== portalBase + route)
      return new WorkerResponse(null, { status: 403 });
    const headers = Object.fromEntries(
      ['authorization', 'content-type', 'x-aio-service-proof', 'traceparent'].flatMap((name) => {
        const value = request.headers.get(name);
        return value ? [[name, value]] : [];
      }),
    );
    const result = await foundation.inject({
      url: route,
      method: 'POST',
      headers,
      payload: await request.text(),
    });
    return new WorkerResponse(result.body, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  },
});

try {
  await worker.ready;
  const db = (await worker.getD1Database('LMS_DB')) as unknown as D1Database;
  await migrateLms(db, config);
  const employee = randomUUID(),
    stamp = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO employees(id,code,name,department,role,password_hash,credential_kind,created_at,updated_at)
      VALUES (?,'NV-TELEMETRY','Synthetic learner','AIO','learner',NULL,'sso-only',?,?)`,
      )
      .bind(employee, stamp, stamp),
    db
      .prepare(
        'INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(ids.learner, ids.learner, employee, ids.tenantA, ids.unitA, Date.now(), ids.admin),
    db
      .prepare(
        'INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES (?,?,?,?,?)',
      )
      .bind(identity.issuer, identity.subject, ids.learner, Date.now(), ids.admin),
  ]);
  const runtime = {
    mode: 'staging',
    instanceId: run,
    clients: [
      {
        code: config.clientId,
        baseUrl: config.baseUrl,
        clientSecret: config.clientSecret,
        kind: 'external-application',
      },
    ],
  } as AppRuntime;
  registerTrainingWorkCenter(
    portal,
    runtime,
    {} as Store,
    async () => ({
      identity,
      principal,
      sessionHash: randomBytes(32).toString('hex'),
      delegatedAccessToken,
    }),
    false,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.equal(input, config.baseUrl + '/api/integrations/portal-work');
    const result = await worker.dispatchFetch(input, {
      method: 'POST',
      headers: init?.headers as Record<string, string>,
      body: init?.body as string,
    });
    return new Response(await result.arrayBuffer(), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  portal.setErrorHandler((error: { statusCode?: number; code?: string }, _request, reply) =>
    reply.code(error.statusCode ?? 500).send({ error: error.code }),
  );
  const invoke = () =>
    portal.inject({
      method: 'GET',
      url: feed,
      headers: {
        traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01',
        'x-user-supplied': marker,
      },
    });
  try {
    assert.equal((await invoke()).statusCode, 200);
    for (let attempt = 0; !telemetry.report().completeTraces.length && attempt < 40; attempt++)
      await delay(50);
    const chain = telemetry.report().completeTraces[0];
    assert.ok(chain && chain.traceId !== 'a'.repeat(32));
    const unauthorized = await worker.dispatchFetch(
      config.baseUrl + '/api/integrations/portal-work',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          traceparent: '00-' + chain.traceId + '-' + 'b'.repeat(16) + '-01',
        },
        body: JSON.stringify({
          instanceId: run,
          environment: 'staging',
          tenantId: ids.tenantA,
          sessionHash: 'f'.repeat(64),
        }),
      },
    );
    assert.equal(unauthorized.status, 403);
    const unauthorizedId = unauthorized.headers.get('x-request-id');
    dependencyUnavailable = true;
    for (let i = 0; i < 100; i++) assert.equal((await invoke()).statusCode, 503);
    telemetry.observe({
      kind: 'queue',
      service: 'aio-workflows',
      queue: 'intake',
      at: Date.now(),
      due: 2,
      blocked: 1,
      oldestDueMs: 125000,
    });
    const fired = telemetry.report();
    assert.ok(fired.alerts.some(({ name }) => name === 'availability-budget-burn'));
    assert.ok(fired.alerts.some(({ name }) => name === 'queue-needs-attention'));
    await alertLog.tick();
    dependencyUnavailable = false;
    assert.equal((await invoke()).statusCode, 200);
    telemetry.observe({
      kind: 'queue',
      service: 'aio-workflows',
      queue: 'intake',
      at: Date.now(),
      due: 0,
      blocked: 0,
      oldestDueMs: 0,
    });
    assert.ok(!telemetry.report().alerts.some(({ name }) => name === 'queue-needs-attention'));
    await alertLog.tick();
    clockOffset = 61 * 60000;
    const afterWindow = telemetry.report();
    assert.ok(!afterWindow.alerts.some(({ name }) => name === 'availability-budget-burn'));
    assert.ok(afterWindow.alerts.some(({ name }) => name === 'queue-sample-stale'));
    await alertLog.tick();
    await alertLog.close();
    clockOffset = 0;
    await writeTelemetryDashboard(dashboard, fired);
    await worker.dispose();
    await telemetry.close();
    const lines = await readFile(log, 'utf8');
    const transitions = await readFile(alertPath, 'utf8');
    const states = transitions
      .trim()
      .split('\n')
      .map((line) => {
        const { name, state } = JSON.parse(line) as { name: string; state: string };
        return name + ':' + state;
      });
    for (const name of ['availability-budget-burn', 'queue-needs-attention']) {
      assert.equal(states.filter((state) => state === name + ':firing').length, 1);
      assert.equal(states.filter((state) => state === name + ':resolved').length, 1);
    }
    for (const privateValue of [
      marker,
      delegatedAccessToken,
      config.clientSecret,
      ids.tenantA,
      '/api/',
    ])
      assert.ok(!lines.includes(privateValue));
    assert.ok(
      lines
        .split('\n')
        .some((line) => line.includes(unauthorizedId!) && line.includes('"parentSpanId":null')),
    );
    assert.deepEqual(telemetry.report().log, { dropped: 0, failed: false });
    const now = new Date();
    const receipt = {
      status: 'pass',
      scope: 'telemetry-component',
      artifactDigest: digest,
      release,
      run,
      checkedAt: now.toISOString(),
      checkedAtVietnam: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      observationSha256: createHash('sha256').update(lines).digest('hex'),
      alertLogSha256: createHash('sha256').update(transitions).digest('hex'),
      correlatedSpans: chain.spans.length,
      unauthorizedParentIgnored: true,
      injectedDependencyErrors: 100,
      recovered: true,
      alarms: fired.alerts,
      agedWindowSimulated: true,
      queueSampleSimulated: true,
      identitySimulated: true,
    };
    await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify(receipt));
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  await Promise.allSettled([
    portal.close(),
    foundation.close(),
    worker.dispose(),
    alertLog.close(),
    telemetry.close(),
  ]);
}
