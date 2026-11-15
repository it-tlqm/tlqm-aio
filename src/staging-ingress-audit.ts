import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { stagingTarget } from './staging-endpoints.js';
import type { StagingConfig } from './staging-config.js';

export type StagingIngressAction = 'auth.callback' | 'http.denied' | 'http.error' | 'edge.rejected';
export const stagingAuditDatabase = (slot: StagingConfig['slot']) => 'aio_audit_stage_' + slot;
export const stagingRequestId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type AuditConfig = { databaseUrl: string; instanceId: string };

export async function openStagingIngressAudit(
  path: string,
  spoolPath: string,
  runtime: StagingConfig,
  ca: Buffer,
) {
  return openStagingAuditWriter(
    JSON.parse(await readFile(path, 'utf8')) as AuditConfig,
    runtime,
    ca,
    'ingress',
    spoolPath,
  );
}

export async function openStagingAuditWriter(
  config: AuditConfig,
  runtime: StagingConfig,
  ca: Buffer,
  source: 'ingress' | 'workerd',
  spoolPath: string,
) {
  const target = stagingTarget(runtime.slot);
  const url = new URL(config.databaseUrl);
  if (
    config.instanceId !== runtime.instanceId ||
    url.protocol !== 'postgresql:' ||
    url.host !== '127.0.0.1:' + target.dbPort ||
    url.pathname !== '/' + stagingAuditDatabase(runtime.slot) ||
    url.username !== 'aio_audit_' + source ||
    !/^[0-9a-f]{64}$/.test(url.password) ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid staging ingress audit configuration.');
  const pool = new pg.Pool({
    connectionString: url.href,
    ssl: { ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    max: 2,
    connectionTimeoutMillis: 3000,
    query_timeout: 7500,
    statement_timeout: 5000,
  });
  let failures = 0;
  let deliveryBlocked = false;
  const signal = (blocked: boolean) => {
    if (blocked === deliveryBlocked) return;
    deliveryBlocked = blocked;
    console.log('AIO_AUDIT_DELIVERY ' + source + ' ' + (blocked ? 'firing' : 'resolved'));
  };
  pool.on('error', () => signal(true));
  let spool: DatabaseSync | undefined;
  try {
    const marker = await pool.query(
      'SELECT instance_id,purpose FROM audit_projection.environment_marker',
    );
    if (
      marker.rows.length !== 1 ||
      marker.rows[0].instance_id !== runtime.instanceId ||
      marker.rows[0].purpose !== 'tlqm-aio-audit-staging'
    )
      throw new Error('Wrong staging ingress audit instance.');
    spool = new DatabaseSync(spoolPath);
    spool.exec(`
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (id TEXT PRIMARY KEY CHECK(id='writer'), instance TEXT, source TEXT);
      CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY, at INTEGER, app TEXT, action TEXT, status INTEGER, request TEXT
      );
    `);
    spool
      .prepare("INSERT OR IGNORE INTO identity VALUES ('writer',?,?)")
      .run(runtime.instanceId, source);
    const identity = spool.prepare("SELECT instance,source FROM identity WHERE id='writer'").get();
    if (identity?.instance !== runtime.instanceId || identity.source !== source)
      throw new Error('Wrong staging audit spool identity.');
  } catch (error) {
    spool?.close();
    await pool.end();
    throw error;
  }
  const queued = spool.prepare('SELECT count(*) AS count FROM pending');
  const enqueue = spool.prepare('INSERT INTO pending VALUES (?,?,?,?,?,?)');
  const oldest = spool.prepare('SELECT * FROM pending ORDER BY rowid LIMIT 64');
  const delivered = spool.prepare('DELETE FROM pending WHERE id=?');
  const insert = `INSERT INTO audit_projection.infrastructure_events
    (source,source_id,occurred_at,app_code,action,http_status,request_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`;
  let drain: Promise<void> | undefined;
  let retryAt = 0;
  function flush(force = false) {
    if (drain || (!force && Date.now() < retryAt)) return drain;
    drain = Promise.resolve()
      .then(async () => {
        try {
          const events = oldest.all();
          if (!events.length) return;
          for (const event of events) {
            await pool.query(insert, [
              source,
              event.id,
              new Date(Number(event.at)),
              event.app,
              event.action,
              event.status,
              event.request,
            ]);
            delivered.run(event.id!);
          }
          signal(false);
        } catch {
          retryAt = Date.now() + 1000;
          signal(true);
        }
      })
      .finally(() => {
        drain = undefined;
      });
    return drain;
  }
  const timer = setInterval(() => void flush(), 500);
  timer.unref();
  void flush();
  return {
    async record(
      app: string,
      action: StagingIngressAction,
      status: number,
      requestId: string,
      occurredAt = Date.now(),
    ) {
      try {
        if (
          !stagingRequestId.test(requestId) ||
          !/^aio-[a-z0-9-]{1,59}$/.test(app) ||
          !Number.isSafeInteger(occurredAt) ||
          !Number.isInteger(status) ||
          status < 200 ||
          status > 599 ||
          !['auth.callback', 'http.denied', 'http.error', 'edge.rejected'].includes(action) ||
          Number(queued.get()?.count) >= 4096
        )
          throw new Error('Invalid audit event or full spool.');
        enqueue.run(randomUUID(), occurredAt, app, action, status, requestId);
        void flush();
        return true;
      } catch {
        failures++;
        console.error('Staging audit spool rejected an event for ' + source + '.');
        return false;
      }
    },
    failures: () => failures,
    blocked: () => deliveryBlocked,
    async close() {
      clearInterval(timer);
      try {
        await drain;
        await flush(true);
      } finally {
        spool.close();
        await pool.end();
      }
    },
  };
}
