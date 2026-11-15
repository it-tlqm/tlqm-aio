import { access, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server as HttpsServer } from 'node:https';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { bffClients } from '../src/config.js';
import { loadStagingConfig } from '../src/staging-config.js';
import { loadStagingScannerTls } from '../src/staging-file-scan.js';
import { openStagingIngressAudit, stagingRequestId } from '../src/staging-ingress-audit.js';
import { reminderRuntime } from './work-center-runtime.js';
import type { Observe } from '../src/telemetry.js';

// Staging runner collects only the typed, prefixed JSON records from stdout.
const observe: Observe | undefined =
  process.env.AIO_STAGING_TELEMETRY === '1'
    ? (event) => {
        if (!process.stdout.writableNeedDrain)
          process.stdout.write('AIO_TELEMETRY ' + JSON.stringify(event) + '\n');
      }
    : undefined;

const args = process.argv.slice(2);
const intakeOnce = args[0] === '--workflow-intake-once';
if (intakeOnce) args.shift();
const [slot, config, certPath, keyPath, auditPath, ...extra] = args;
if (
  (slot !== 'a' && slot !== 'b') ||
  !config ||
  !certPath ||
  (intakeOnce ? keyPath !== undefined : !keyPath) ||
  extra.length
)
  throw new Error(
    'Usage: staging.js <a|b> <runtime.json> <cert.pem> <key.pem> [ingress-audit.json] or staging.js --workflow-intake-once <a|b> <runtime-grant.json> <cert.pem>',
  );

const apps: FastifyInstance[] = [];
const edges: HttpsServer[] = [];
let reminders: Awaited<ReturnType<typeof reminderRuntime>> | undefined;
let reminderTimer: ReturnType<typeof setInterval> | undefined;
let queueSample: Promise<void> | undefined;
let ingressAudit: Awaited<ReturnType<typeof openStagingIngressAudit>> | undefined;
async function close() {
  clearInterval(reminderTimer);
  await queueSample;
  await reminders?.close();
  for (const edge of edges) {
    edge.closeAllConnections();
    await new Promise<void>((resolve) => edge.close(() => resolve()));
  }
  await Promise.all(apps.map((app) => app.close()));
  await ingressAudit?.close();
}
async function startWeb(
  runtime: Awaited<ReturnType<typeof loadStagingConfig>>,
  cert: Buffer,
  key: Buffer,
) {
  if (auditPath) {
    const spoolPath = process.env.AIO_STAGING_AUDIT_SPOOL;
    if (!spoolPath) throw new Error('Missing staging ingress audit spool.');
    ingressAudit = await openStagingIngressAudit(auditPath, spoolPath, runtime, cert);
  }
  for (const client of bffClients(runtime)) {
    const app = await createApp({
      runtime,
      client,
      logger: false,
      stagingTls: { cert, key },
      ...(observe && { observe }),
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback upstream.');
    const publicHost = new URL(client.baseUrl).host;
    const edge = createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => {
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
      const idpBackchannel =
        req.headers.host === 'host.docker.internal:' + client.port &&
        req.method === 'POST' &&
        req.url === '/auth/backchannel-logout';
      let rejectedAtEdge = false;
      let auditRequestId = '';
      if (ingressAudit) {
        const callback = req.url?.split('?', 1)[0] === '/auth/callback';
        res.once('finish', () => {
          const status = res.statusCode;
          const action = rejectedAtEdge
            ? 'edge.rejected'
            : status >= 500
              ? 'http.error'
              : status === 401 || status === 403
                ? 'http.denied'
                : callback
                  ? 'auth.callback'
                  : undefined;
          if (action) ingressAudit?.record(client.code, action, status, auditRequestId);
        });
      }
      if (
        (req.headers.host !== publicHost && !idpBackchannel) ||
        !req.url?.startsWith('/') ||
        req.url.startsWith('//')
      ) {
        rejectedAtEdge = true;
        if (ingressAudit) res.setHeader('x-request-id', (auditRequestId = randomUUID()));
        res.writeHead(400).end();
        return;
      }
      const headers = { ...req.headers };
      const hopHeaders = [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
      ];
      for (const header of [
        ...hopHeaders,
        ...(headers.connection ?? '')
          .toLowerCase()
          .split(',')
          .map((part) => part.trim()),
      ])
        delete headers[header];
      for (const header of Object.keys(headers))
        if (header === 'forwarded' || header.startsWith('x-forwarded-')) delete headers[header];
      headers.host = publicHost;
      headers['x-aio-ingress-key'] = runtime.ingressKey;
      headers['x-forwarded-proto'] = 'https';
      const upstream = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          ca: cert,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          path: req.url,
          method: req.method,
          headers,
          timeout: 15000,
        },
        (response) => {
          for (const header of [
            ...hopHeaders,
            ...(response.headers.connection ?? '')
              .toLowerCase()
              .split(',')
              .map((part) => part.trim()),
          ])
            delete response.headers[header];
          if (ingressAudit) {
            const id = response.headers['x-request-id'];
            auditRequestId =
              typeof id === 'string' && stagingRequestId.test(id) ? id : randomUUID();
            response.headers['x-request-id'] = auditRequestId;
          }
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (res.headersSent) res.destroy();
        else {
          if (ingressAudit) res.setHeader('x-request-id', (auditRequestId = randomUUID()));
          res.writeHead(502).end();
        }
      });
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });
      req.pipe(upstream);
    });
    edges.push(edge);
    await new Promise<void>((resolve, reject) => {
      edge.once('error', reject);
      edge.listen(client.port, '127.0.0.1', resolve);
    });
  }
  if (runtime.moduleDatabases) {
    reminders = await reminderRuntime(runtime);
    const tick = () => {
      if (observe && !queueSample) {
        queueSample = reminders
          ?.queueState()
          .then((events) => events.forEach(observe))
          .catch(() => console.error('Staging queue telemetry sample failed.'))
          .finally(() => {
            queueSample = undefined;
          });
      }
      if (process.env.AIO_STAGING_MANUAL_WORKFLOW !== '1')
        void reminders
          ?.tick()
          .catch(() => console.error('Staging Workflows background tick failed.'));
    };
    tick();
    reminderTimer = setInterval(tick, 30000).unref();
  }
  console.log('Staging ' + slot + ' listening.');
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function waitForIntakeStart() {
  const deadline = Date.now() + 35000;
  console.log('AIO_WORKFLOW_INTAKE_READY');
  while (Date.now() < deadline) {
    try {
      await access('/stage/intake/start');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await delay(100);
    }
  }
  throw new Error('Timed out waiting for the staging intake start signal.');
}

try {
  const cert = await readFile(certPath);
  const runtime = await loadStagingConfig(config, slot, cert);
  runtime.databaseCa = cert;
  if (intakeOnce) {
    reminders = await reminderRuntime(runtime);
    await waitForIntakeStart();
    console.log('AIO_WORKFLOW_INTAKE_PROCESSED ' + (await reminders.processIntakes()));
    await close();
  } else {
    if (runtime.moduleDatabases)
      runtime.scannerTls = await loadStagingScannerTls(process.env.AIO_STAGING_SCANNER_TLS_DIR);
    await startWeb(runtime, cert, await readFile(keyPath!));
  }
} catch (error) {
  await close();
  console.error(
    'Staging startup failed (' + (error instanceof Error ? error.name : 'unknown') + ').',
  );
  process.exitCode = 1;
}
