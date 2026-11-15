import pg from 'pg';
import type { LocalConfig } from '../src/config.js';
import { applicationDatabaseUrl, assertLocalDatabase } from '../src/config.js';
import { Store } from '../src/store.js';
import { notificationAudience } from '../src/notification-audience.js';
import { TrainingReminders } from '../src/lms/training-reminders.js';
import type { D1Database } from '../src/lms/types.js';
import type { LmsConfig } from '../src/lms/security.js';
import { localContainer } from './local-docker.js';
/** The local orchestrator owns Foundation credentials; the Worker receives no PostgreSQL credentials. */
export async function lmsReminderRuntime(runtime: LocalConfig, db: D1Database, config: LmsConfig) {
  if (!(await localContainer('foundation-db')).running || config.instanceId !== runtime.instanceId)
    throw new Error('Isolated local reminder runtime required');
  const test = config.purpose === 'tlqm-aio-lms-test',
    url = applicationDatabaseUrl(runtime, test);
  assertLocalDatabase(url, test);
  const pool = new pg.Pool({
    connectionString: url,
    max: 2,
    statement_timeout: 10000,
    connectionTimeoutMillis: 3000,
  });
  pool.on('error', () => console.error('Training reminder directory unavailable.'));
  try {
    if (
      (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose !==
      (test ? 'tlqm-aio-test' : 'tlqm-aio-local')
    )
      throw new Error('Invalid Foundation marker');
    const marker = await db
      .prepare('SELECT instance_id,purpose FROM environment_marker WHERE id=1')
      .first<{ instance_id: string; purpose: string }>();
    if (marker?.instance_id !== runtime.instanceId || marker?.purpose !== config.purpose)
      throw new Error('Invalid LMS marker');
  } catch (e) {
    await pool.end();
    throw e;
  }
  const store = new Store(pool),
    worker = new TrainingReminders(db, (tenant, accounts) =>
      notificationAudience(store, config.clientId, 'lms:learn', tenant, accounts, runtime.issuer),
    );
  let running: Promise<unknown> | null = null;
  return {
    worker,
    tick: () =>
      running ??
      (running = worker
        .tick()
        .then((r) => {
          if (r.failedTenants) throw new Error('Some training reminder tenants failed');
          return r;
        })
        .finally(() => {
          running = null;
        })),
    async close() {
      if (running) await running.catch(() => {});
      await pool.end();
    },
  };
}
