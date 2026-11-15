import pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppRuntime } from './config.js';
import type { AuthResult } from './management/routes.js';
import type { Store } from './store.js';
import { HttpError } from './security.js';
import { cmsDatabaseUrl, loadCmsConfig } from './cms/database.js';
import { CmsService } from './cms/service.js';
import { registerCmsRoutes } from './cms/routes.js';
import type { CmsActor } from './cms/access.js';
import { CmsPublicationWorker } from './cms/publication-worker.js';

export async function registerCmsBoundary(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  authenticate: (request: FastifyRequest) => Promise<AuthResult>,
  test: boolean,
) {
  if (runtime.mode !== 'local') throw new Error('CMS staging runtime is not configured yet.');
  const pool = new pg.Pool({
    connectionString: cmsDatabaseUrl(await loadCmsConfig(runtime.instanceId), test),
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on('error', () =>
    app.log.warn({ code: 'CMS_DATABASE_UNAVAILABLE' }, 'CMS database unavailable'),
  );
  const actor = async (request: FastifyRequest): Promise<CmsActor> => {
    const { principal } = await authenticate(request);
    const memberships = await store.memberships(principal.accountId, 'aio-cms');
    return {
      appCode: 'aio-cms',
      accountId: principal.accountId,
      personId: principal.personId,
      tenantIds: memberships.map(({ id }) => id as string),
      permissions: principal.permissions.filter(
        (row) => row.managedAppCode === null || row.managedAppCode === 'aio-cms',
      ),
    };
  };
  registerCmsRoutes(app, { service: new CmsService(pool), actor });
  const worker = new CmsPublicationWorker(pool);
  let tick: Promise<unknown> | undefined;
  const runWorker = () => {
    tick ??= worker
      .runOnce()
      .catch(() => undefined)
      .finally(() => {
        tick = undefined;
      });
  };
  const timer = test ? undefined : setInterval(runWorker, 30000).unref();
  if (!test) app.addHook('onReady', async () => runWorker());
  app.addHook('onClose', async () => pool.end());
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await tick;
  });
  app.addHook('onReady', async () => {
    const row = (await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows[0];
    if (
      !row ||
      row.instance_id !== runtime.instanceId ||
      row.purpose !== (test ? 'tlqm-aio-cms-test' : 'tlqm-aio-cms-local')
    )
      throw new HttpError(503, 'CMS_DATABASE_NOT_READY');
  });
  return async () => {};
}
