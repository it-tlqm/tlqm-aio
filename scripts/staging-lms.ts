import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare, Log, LogLevel, Response } from 'miniflare';
import type { Request } from 'miniflare';
import { validateLmsConfig } from '../src/lms/security.js';
import type { D1Database } from '../src/lms/types.js';
import type { StagingConfig } from '../src/staging-config.js';
import { ids } from '../src/fixtures.js';
import { reportActors } from './staging-report-fixtures.js';
import { parseObservation } from '../src/telemetry.js';
import type { Observe } from '../src/telemetry.js';
import { stagingFileScanner } from '../src/staging-file-scan.js';
import { stagingRequestId } from '../src/staging-ingress-audit.js';
import type { openStagingAuditWriter, StagingIngressAction } from '../src/staging-ingress-audit.js';

function stageOutbound(issuer: URL, foundation: URL, ca: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const allowed =
      (url.origin === issuer.origin && url.pathname.startsWith(issuer.pathname + '/')) ||
      (url.origin === foundation.origin &&
        url.pathname.startsWith('/api/v1/integrations/aio-lms-sandbox/'));
    if (!allowed || !['GET', 'POST', 'HEAD'].includes(request.method))
      return new Response(null, { status: 403 });
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (body && body.byteLength > 1048576) return new Response(null, { status: 413 });
    const headers: Record<string, string> = {};
    for (const name of [
      'accept',
      'authorization',
      'content-type',
      'x-aio-service-proof',
      'traceparent',
    ]) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    if (body) headers['content-length'] = String(body.byteLength);
    return new Promise((resolve, reject) => {
      const upstream = httpsRequest(
        url,
        {
          ca,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          headers,
          method: request.method,
          signal: AbortSignal.timeout(12000),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4194304) res.destroy(new Error('Staging adapter response too large.'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            const status = res.statusCode ?? 502;
            const outputHeaders: Record<string, string> = {};
            for (const name of ['content-type', 'location', 'cache-control', 'retry-after']) {
              const value = res.headers[name];
              if (typeof value === 'string') outputHeaders[name] = value;
            }
            const noBody = [204, 205, 304].includes(status) || request.method === 'HEAD';
            resolve(
              new Response(noBody ? null : Buffer.concat(chunks), {
                status,
                headers: outputHeaders,
              }),
            );
          });
        },
      );
      upstream.on('error', reject);
      upstream.end(body);
    });
  };
}

export function lmsTelemetryBinding(observe: Observe) {
  return async (request: Request) => {
    if (request.method !== 'POST' || request.url !== 'https://telemetry.invalid/observations')
      return new Response(null, { status: 400 });
    const data = await request.text();
    if (data.length > 1024) return new Response(null, { status: 413 });
    let event;
    try {
      event = parseObservation(JSON.parse(data));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (event?.kind !== 'http' || event.service !== 'aio-lms-sandbox')
      return new Response(null, { status: 400 });
    observe(event);
    return new Response(null, { status: 204 });
  };
}

function lmsIngressAuditBinding(writer: Awaited<ReturnType<typeof openStagingAuditWriter>>) {
  return async (request: Request) => {
    if (request.method !== 'POST' || request.url !== 'https://audit.invalid/ingress')
      return new Response(null, { status: 400 });
    const data = await request.text();
    if (data.length > 256) return new Response(null, { status: 413 });
    let event: { action: StagingIngressAction; status: number; requestId: string; at: number };
    try {
      event = JSON.parse(data);
    } catch {
      return new Response(null, { status: 400 });
    }
    const { action, status, requestId, at } = event ?? {};
    if (
      !Number.isInteger(status) ||
      typeof requestId !== 'string' ||
      !stagingRequestId.test(requestId) ||
      !Number.isSafeInteger(at) ||
      Math.abs(Date.now() - at) > 30000 ||
      !(
        (action === 'http.denied' && (status === 401 || status === 403)) ||
        (action === 'http.error' && status >= 500 && status <= 599) ||
        (action === 'auth.callback' && status >= 200 && status < 400)
      )
    )
      return new Response(null, { status: 400 });
    const recorded = await writer.record('aio-lms-sandbox', action, status, requestId, at);
    return new Response(null, { status: recorded ? 204 : 503 });
  };
}

function lmsUploadScanBinding(runtime: StagingConfig) {
  const scan = stagingFileScanner(runtime.slot, runtime.scannerTls);
  return async (request: Request) => {
    if (
      request.method !== 'POST' ||
      request.url !== 'https://scanner.invalid/upload' ||
      !request.body
    )
      return new Response(null, { status: 400 });
    try {
      const result = await scan(request.body);
      return new Response(null, { status: result === 'clean' ? 204 : 422 });
    } catch {
      return new Response(null, { status: 503 });
    }
  };
}

export async function startStagingLms(
  runtime: StagingConfig,
  artifact: string,
  certPath: string,
  keyPath: string,
  identities: { id: string; subject: string; name: string; actor?: string }[],
  observe?: Observe,
  storage?: { path: string; encryptionKey: string; reopen?: boolean },
  audit?: Awaited<ReturnType<typeof openStagingAuditWriter>>,
  secrets?: { clientSecret: string; encryptionKey: string },
) {
  const client = runtime.clients.find((entry) => entry.code === 'aio-lms-sandbox');
  const foundation = runtime.clients.find((entry) => entry.code === 'aio-foundation');
  assert.ok(client && foundation);
  const config = validateLmsConfig({
    mode: 'staging',
    slot: runtime.slot,
    ...(runtime.namedHosts && { namedHosts: runtime.namedHosts }),
    purpose: 'tlqm-aio-lms-staging',
    instanceId: runtime.instanceId,
    issuer: runtime.issuer,
    clientId: client.clientId,
    clientSecret: secrets?.clientSecret ?? client.clientSecret,
    audience: client.audience,
    baseUrl: client.baseUrl,
    foundationUrl: foundation.baseUrl + '/api/v1/integrations/aio-lms-sandbox/authorize',
    encryptionKey:
      secrets?.encryptionKey ?? storage?.encryptionKey ?? randomBytes(32).toString('hex'),
  });
  const ca = await readFile(certPath, 'utf8');
  const worker = new Miniflare({
    modules: true,
    scriptPath: join(artifact, 'dist/lms/worker.mjs'),
    compatibilityDate: '2026-07-30',
    host: '127.0.0.1',
    port: client.port,
    https: true,
    httpsCertPath: certPath,
    httpsKeyPath: keyPath,
    cf: false,
    outboundService: stageOutbound(new URL(runtime.issuer), new URL(foundation.baseUrl), ca),
    d1Databases: { LMS_DB: config.instanceId },
    r2Buckets: { LMS_MEDIA: config.instanceId + '-media' },
    ...(storage && { d1Persist: join(storage.path, 'd1'), r2Persist: join(storage.path, 'r2') }),
    bindings: { LMS_CONFIG: JSON.stringify(config) },
    serviceBindings: {
      AIO_UPLOAD_SCAN: lmsUploadScanBinding(runtime),
      ...(observe && { AIO_TELEMETRY: lmsTelemetryBinding(observe) }),
      ...(audit && { AIO_INGRESS_AUDIT: lmsIngressAuditBinding(audit) }),
    },
    assets: {
      directory: join(artifact, 'frontend/dist'),
      binding: 'ASSETS',
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    },
    log: new Log(LogLevel.NONE),
  });
  try {
    await worker.ready;
    const db = (await worker.getD1Database('LMS_DB')) as unknown as D1Database;
    if (storage?.reopen) {
      assert.deepEqual(
        await db.prepare('SELECT instance_id,purpose FROM environment_marker').first(),
        { instance_id: config.instanceId, purpose: config.purpose },
      );
      const journal = await db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: string }>();
      return { worker, db, versions: journal.results.map(({ version }) => version) };
    }
    const migrations = (await import(
      pathToFileURL(join(artifact, 'dist/src/lms/database.js')).href
    )) as typeof import('../src/lms/database.js');
    await migrations.migrateLms(db, config);
    const now = new Date();
    const fixtures = [
      { accountId: ids.admin, unit: ids.unitA, role: 'learner' },
      { accountId: ids.learner, unit: ids.unitA, role: 'learner' },
      ...identities.flatMap((identity) =>
        identity.actor === 'operator' || identity.actor === 'outside'
          ? [
              {
                accountId: identity.id,
                unit: identity.actor === 'operator' ? ids.unitA : ids.unitC,
                role: 'learner',
              },
            ]
          : [],
      ),
      ...(identities.some(({ id }) => id === reportActors.reviewer.id)
        ? [
            { accountId: reportActors.reviewer.id, unit: ids.unitA, role: 'manager' },
            { accountId: reportActors.outside.id, unit: ids.unitC, role: 'learner' },
          ]
        : []),
    ];
    for (const { accountId, unit, role } of fixtures) {
      const user = identities.find((entry) => entry.id === accountId);
      assert.ok(user);
      const employee = randomUUID();
      await db.batch([
        db
          .prepare(
            "INSERT INTO employees(id,code,name,department,role,password_hash,credential_kind,created_at,updated_at) VALUES (?,?,?,?,?,NULL,'sso-only',?,?)",
          )
          .bind(
            employee,
            'NV-STAGE-' + accountId,
            user.name,
            unit === ids.unitA ? 'Đào tạo' : 'Chuyển đổi số',
            role,
            now.toISOString(),
            now.toISOString(),
          ),
        db
          .prepare(
            'INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by) VALUES (?,?,?,?,?,?,?)',
          )
          .bind(accountId, accountId, employee, ids.tenantA, unit, now.getTime(), ids.admin),
        db
          .prepare(
            'INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES (?,?,?,?,?)',
          )
          .bind(config.issuer, user.subject, accountId, now.getTime(), ids.admin),
      ]);
    }
    const journal = (
      await db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: string }>()
    ).results;
    return { worker, db, versions: journal.map(({ version }) => version) };
  } catch (error) {
    await worker.dispose();
    throw error;
  }
}
