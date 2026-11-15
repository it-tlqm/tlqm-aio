import pg from 'pg';
import { applicationDatabaseUrl, assertLocalDatabase } from '../src/config.js';
import type { AppRuntime } from '../src/config.js';
import { Store } from '../src/store.js';
import { assertModuleReady, moduleDatabaseConnection } from '../src/database/module-runtime.js';
import { assertFoundationReady } from '../src/database/foundation-runtime.js';
import { assertStagingConfig, stagingDatabaseTls } from '../src/staging-config.js';
import { WorkflowsService } from '../src/workflows/service.js';
import { WorkflowWorkCenter } from '../src/workflows/work-center.js';
import { workflowDirectory } from '../src/workflows-boundary.js';
import { moduleIntakeDestination } from '../src/module-intake-boundary.js';
import { localContainer } from './local-docker.js';
import { observeDraftQueues } from '../src/workflows/automation-jobs.js';
export async function reminderRuntime(runtime: AppRuntime, test = false) {
  let foundationUrl: string;
  if (runtime.mode === 'local') {
    if (!(await localContainer('foundation-db')).running)
      throw new Error('Local database required');
    foundationUrl = applicationDatabaseUrl(runtime, test);
    assertLocalDatabase(foundationUrl, test);
  } else {
    assertStagingConfig(runtime);
    if (test) throw new Error('Select the staging worker database.');
    foundationUrl = runtime.databaseUrl;
  }
  const workflowConnection = await moduleDatabaseConnection(runtime, 'workflows', test);
  const foundation = new pg.Pool({
      connectionString: foundationUrl,
      ...(runtime.mode === 'staging' && { ssl: stagingDatabaseTls(runtime.databaseCa) }),
      max: 2,
    }),
    pool = new pg.Pool({
      ...workflowConnection,
      max: 2,
      statement_timeout: 10000,
    });
  try {
    foundation.on('error', () => console.error('Reminder Foundation connection unavailable.'));
    pool.on('error', () => console.error('Reminder source connection unavailable.'));
    await assertFoundationReady(foundation, runtime, test);
    await assertModuleReady(pool, runtime, 'workflows', test, 'WORKFLOW_DATABASE_NOT_READY');
  } catch (e) {
    await pool.end();
    await foundation.end();
    throw e;
  }
  const store = new Store(foundation);
  const service = new WorkflowsService(
    pool,
    workflowDirectory(store),
    moduleIntakeDestination(runtime, store, test),
  );
  const hub = new WorkflowWorkCenter(service);
  let running: Promise<unknown> | null = null;
  const tick = () =>
    running ??
    (running = Promise.allSettled([
      hub.remind(),
      service.processLinkedDrafts(),
      service.processScheduledDrafts(),
      hub.deliverOutputNotifications(),
      service.processModuleIntakes(),
    ])
      .then(([reminders, linkedDrafts, scheduledDrafts, email, intakes]) => {
        if (reminders.status === 'rejected' || reminders.value.failedTenants)
          throw new Error('Some reminder tenants failed; retry scheduled.');
        if (linkedDrafts.status === 'rejected') throw new Error('Linked draft worker failed.');
        if (scheduledDrafts.status === 'rejected')
          throw new Error('Scheduled draft worker failed.');
        if (email.status === 'rejected') throw new Error('Local email worker failed.');
        if (intakes.status === 'rejected') throw new Error('Module intake worker failed.');
        return {
          ...reminders.value,
          linkedDraftJobsProcessed: linkedDrafts.value,
          scheduledDrafts: scheduledDrafts.value,
          emailJobsProcessed: email.value,
          moduleIntakesProcessed: intakes.value,
        };
      })
      .finally(() => {
        running = null;
      }));
  return {
    hub,
    tick,
    processIntakes: () => service.processModuleIntakes(),
    queueState: () => observeDraftQueues(pool),
    async close() {
      if (running) await running.catch(() => {});
      await pool.end();
      await foundation.end();
    },
  };
}
