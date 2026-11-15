import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import type { StagingConfig } from '../src/staging-config.js';
import { ids } from '../src/fixtures.js';
import type { seedRecoveryFixtures } from './enterprise-recovery-fixtures.js';

type Fixture = Awaited<ReturnType<typeof seedRecoveryFixtures>>;
type Databases = { foundation: Pool; forms: Pool; workflows: Pool; tasks: Pool };

export async function probeReleaseComponents(
  artifact: string,
  db: Databases,
  fixture: Fixture,
  wrongInstance?: string,
) {
  const load = (file: string) => pathToFileURL(join(artifact, 'dist/src', file)).href;
  const { assertFoundationReady } = (await import(
    load('database/foundation-runtime.js')
  )) as typeof import('../src/database/foundation-runtime.js');
  const { assertModuleReady } = (await import(
    load('database/module-runtime.js')
  )) as typeof import('../src/database/module-runtime.js');
  // Only readiness contract inputs are used here. The full staging runner starts TLS and Keycloak.
  const runtime = {
    mode: 'staging',
    slot: 'a',
    instanceId: wrongInstance ?? fixture.instance,
  } as StagingConfig;
  if (wrongInstance) {
    await assert.rejects(() => assertFoundationReady(db.foundation, runtime, false), {
      code: 'DATABASE_NOT_READY',
    });
    for (const module of ['forms', 'workflows', 'tasks'] as const) {
      const code = module.toUpperCase() + '_DATABASE_NOT_READY';
      await assert.rejects(() => assertModuleReady(db[module], runtime, module, false, code), {
        code,
      });
    }
    return;
  }
  await assertFoundationReady(db.foundation, runtime, false);
  for (const module of ['forms', 'workflows', 'tasks'] as const)
    await assertModuleReady(
      db[module],
      runtime,
      module,
      false,
      module.toUpperCase() + '_DATABASE_NOT_READY',
    );
  const { Store } = (await import(load('store.js'))) as typeof import('../src/store.js');
  const { FormsService } = (await import(
    load('forms/service.js')
  )) as typeof import('../src/forms/service.js');
  const { WorkflowsService } = (await import(
    load('workflows/service.js')
  )) as typeof import('../src/workflows/service.js');
  const { TasksService } = (await import(
    load('tasks/service.js')
  )) as typeof import('../src/tasks/service.js');
  const store = new Store(db.foundation);
  const identity = {
    issuer: 'https://127.0.0.1:4518/realms/aio-staging-a',
    subject: fixture.actor,
  };
  const principal = await store.principal(identity, 'aio-foundation');
  assert.equal(principal.accountId, fixture.actor);
  const units = await store.activeUnits(principal.personId);
  const tenantId = fixture.tenant;
  const actor = {
    accountId: principal.accountId,
    personId: principal.personId,
    name: principal.displayName,
    tenantIds: [tenantId],
    units,
  };
  const permissions = (permission: string) => [{ tenantId, orgUnitId: ids.unitA, permission }];
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected external lookup in storage compatibility probe.');
  };
  const forms = new FormsService(db.forms, { validateTargets: unexpected });
  const submissions = await forms.submissionsPage(
    {
      tenantId,
      actor: async () => ({
        ...actor,
        appCode: 'aio-forms',
        permissions: permissions('forms:respond'),
      }),
    },
    fixture.form,
    true,
  );
  const submission = submissions.items.find(({ id }) => id === fixture.submission);
  assert.equal(submission?.version_id, fixture.formVersion);
  const workflows = new WorkflowsService(db.workflows, {
    validateUnit: unexpected,
    assignee: unexpected,
  });
  const run = await workflows.detail(
    {
      tenantId,
      actor: async () => ({
        ...actor,
        appCode: 'aio-workflows',
        permissions: permissions('workflows:start'),
      }),
    },
    fixture.workflow,
  );
  assert.equal(run.run.version_id, fixture.version);
  const tasks = new TasksService(db.tasks, {
    validateUnit: unexpected,
    search: unexpected,
    actor: unexpected,
  });
  const project = await tasks.projectDetails(
    {
      tenantId,
      actor: async () => ({
        ...actor,
        appCode: 'aio-tasks',
        permissions: permissions('tasks:work'),
      }),
    },
    fixture.project,
  );
  assert.equal(project.project.id, fixture.project);
  return {
    foundation: principal.accountId,
    forms: submission?.version_id,
    workflows: run.run.version_id,
    tasks: project.project.id,
  };
}
