import pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppRuntime } from './config.js';
import { assertModuleReady, moduleDatabaseConnection } from './database/module-runtime.js';
import type { AuthResult } from './management/routes.js';
import { HttpError } from './security.js';
import type { Identity, Principal, Store } from './store.js';
import { tasksDirectory } from './tasks-boundary.js';
import { taskDenied } from './tasks/access.js';
import type { TaskActor } from './tasks/access.js';
import { TasksService } from './tasks/service.js';

export async function taskWorkActor(
  store: Store,
  identity: Identity,
  portal: Principal,
  tenant: string,
): Promise<TaskActor> {
  if (
    !(await store.memberships(portal.accountId, 'aio-foundation')).some(({ id }) => id === tenant)
  )
    throw new HttpError(403, 'PERMISSION_DENIED');
  const principal = await store.principal(identity, 'aio-tasks');
  if (principal.accountId !== portal.accountId || principal.personId !== portal.personId)
    throw taskDenied();
  const [memberships, units] = await Promise.all([
    store.memberships(principal.accountId, 'aio-tasks'),
    store.activeUnits(principal.personId),
  ]);
  if (!memberships.some(({ id }) => id === tenant)) throw taskDenied();
  return {
    appCode: 'aio-tasks',
    accountId: principal.accountId,
    personId: principal.personId,
    name: principal.displayName,
    tenantIds: [tenant],
    units,
    permissions: principal.permissions.filter(
      (p) => p.managedAppCode === null || p.managedAppCode === 'aio-tasks',
    ),
  };
}

export function registerTasksWorkRoutes(
  app: FastifyInstance,
  service: Pick<TasksService, 'assignedWork' | 'reminders'>,
  actor: (request: FastifyRequest, tenant: string) => Promise<TaskActor>,
  baseUrl: string,
) {
  const uuid = { type: 'string', format: 'uuid' };
  const source = { code: 'aio-tasks', name: 'Công việc', baseUrl };
  for (const kind of ['assigned', 'reminders'] as const) {
    app.get<{ Querystring: { tenantId: string; after?: string; search?: string } }>(
      '/api/v1/work-center/tasks/' + kind,
      {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['tenantId'],
            properties: {
              tenantId: uuid,
              ...(kind === 'assigned' && {
                after: uuid,
                search: { type: 'string', maxLength: 120 },
              }),
            },
          },
        },
      },
      async (request, reply) => {
        reply.header('cache-control', 'private, no-store');
        const { tenantId, ...filters } = request.query;
        const context = { tenantId, actor: () => actor(request, tenantId) };
        const result =
          kind === 'assigned'
            ? await service.assignedWork(context, filters)
            : await service.reminders(context);
        return { ...result, source };
      },
    );
  }
}

export async function registerTasksWorkCenter(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  authenticate: (request: FastifyRequest) => Promise<AuthResult>,
  test: boolean,
) {
  const source = runtime.clients.find(
    ({ code, kind }) => code === 'aio-tasks' && kind === 'application',
  );
  if (!source) return;
  const pool = new pg.Pool({
    ...(await moduleDatabaseConnection(runtime, 'tasks', test)),
    max: 3,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on('error', () =>
    app.log.warn({ code: 'TASKS_WORK_SOURCE_UNAVAILABLE' }, 'Tasks work source unavailable'),
  );
  app.addHook('onClose', () => pool.end());
  if (runtime.mode === 'staging')
    app.addHook('onReady', () =>
      assertModuleReady(pool, runtime, 'tasks', test, 'TASKS_DATABASE_NOT_READY'),
    );
  registerTasksWorkRoutes(
    app,
    new TasksService(pool, tasksDirectory(store)),
    async (request, tenant) => {
      const auth = await authenticate(request);
      return taskWorkActor(store, auth.identity, auth.principal, tenant);
    },
    source.baseUrl,
  );
}
