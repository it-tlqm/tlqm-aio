/** Portal adapter contract. Source permissions remain authoritative; no workflow SQL in IAM. */
import pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppRuntime } from './config.js';
import type { Store, Identity } from './store.js';
import type { AuthResult } from './management/routes.js';
import { moduleDatabaseConnection, assertModuleReady } from './database/module-runtime.js';
import { WorkflowsService } from './workflows/service.js';
import { WorkflowWorkCenter } from './workflows/work-center.js';
import type { WorkQuery } from './workflows/work-center.js';
import { workflowDirectory } from './workflows-boundary.js';
import type { WorkflowActor } from './workflows/access.js';
import { ProfileWorkflows } from './management/profile-workflows.js';
import { registerProfileWorkflowRoutes } from './management/profile-workflow-routes.js';
export async function workCenterActor(store: Store, identity: Identity): Promise<WorkflowActor> {
  const principal = await store.principal(identity, 'aio-workflows');
  return {
    appCode: 'aio-workflows',
    accountId: principal.accountId,
    personId: principal.personId,
    tenantIds: (await store.memberships(principal.accountId, 'aio-workflows')).map((r) =>
      String(r.id),
    ),
    units: await store.activeUnits(principal.personId),
    permissions: principal.permissions.filter(
      (p) => p.managedAppCode === null || p.managedAppCode === 'aio-workflows',
    ),
  };
}
export async function registerWorkCenter(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  authenticate: (req: FastifyRequest) => Promise<AuthResult>,
  test: boolean,
) {
  const pool = new pg.Pool({
    ...(await moduleDatabaseConnection(runtime, 'workflows', test)),
    max: 3,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
  });
  pool.on('error', () =>
    app.log.warn({ code: 'WORK_CENTER_UNAVAILABLE' }, 'Work center unavailable'),
  );
  app.addHook('onClose', () => pool.end());
  if (runtime.mode === 'staging')
    app.addHook('onReady', () =>
      assertModuleReady(pool, runtime, 'workflows', test, 'WORKFLOW_DATABASE_NOT_READY'),
    );
  const hub = new WorkflowWorkCenter(new WorkflowsService(pool, workflowDirectory(store)));
  registerProfileWorkflowRoutes(
    app,
    new ProfileWorkflows(store, hub.workflows, (identity) => workCenterActor(store, identity)),
    authenticate,
    runtime.clients.find((c) => c.code === 'aio-workflows')!.baseUrl,
  );
  const actor = async (req: FastifyRequest) =>
    workCenterActor(store, (await authenticate(req)).identity);
  const uuid = { type: 'string', format: 'uuid' },
    page = { type: 'string', pattern: '^(0|[1-9][0-9]{0,4}|100000)$' };
  type Query = {
    tenantId: string;
    page?: string;
    view?: WorkQuery['view'];
    search?: string;
    unitId?: string;
    assigneeId?: string;
    unread?: string;
  };
  const context = (req: FastifyRequest<{ Querystring: Query }>) => ({
    tenantId: req.query.tenantId,
    actor: () => actor(req),
  });
  const units = async (a: WorkflowActor, tenant: string, ids: string[]) => {
    const scopes = a.permissions
      .filter(
        (p) =>
          p.tenantId === tenant && ['workflows:manage', 'workflows:report'].includes(p.permission),
      )
      .map((p) => p.orgUnitId);
    return (
      await store.pool.query(
        'SELECT id,name FROM org_units WHERE tenant_id=$1 AND active AND ($2 OR id=ANY($3::uuid[])) ORDER BY name',
        [tenant, scopes.includes(null), [...ids, ...scopes.filter(Boolean)]],
      )
    ).rows;
  };
  app.get<{ Querystring: Query }>(
    '/api/v1/work-center/work',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: {
            tenantId: uuid,
            page,
            view: {
              type: 'string',
              enum: ['assigned', 'requested', 'returned', 'overdue', 'managed'],
              default: 'assigned',
            },
            search: { type: 'string', maxLength: 160 },
            unitId: uuid,
            assigneeId: uuid,
          },
        },
      },
    },
    async (req) => {
      const c = context(req),
        result = await hub.work(c, {
          ...req.query,
          page: Number(req.query.page ?? 0),
          view: req.query.view ?? 'assigned',
        }),
        a = await c.actor();
      return {
        ...result,
        source: {
          code: 'aio-workflows',
          name: 'Quy trình',
          baseUrl: runtime.clients.find((c) => c.code === 'aio-workflows')!.baseUrl,
        },
        units: await units(a, c.tenantId, result.units),
        canConfigure: a.permissions.some(
          (p) => p.tenantId === c.tenantId && p.permission === 'workflows:manage',
        ),
      };
    },
  );
  app.get<{ Querystring: Query }>(
    '/api/v1/work-center/notifications',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: uuid, page, unread: { type: 'string', enum: ['true', 'false'] } },
        },
      },
    },
    async (req) => ({
      ...(await hub.notifications(
        context(req),
        Number(req.query.page ?? 0),
        req.query.unread === 'true',
      )),
      source: {
        code: 'aio-workflows',
        name: 'Quy trình',
        baseUrl: runtime.clients.find((c) => c.code === 'aio-workflows')!.baseUrl,
      },
    }),
  );
  app.get<{ Querystring: Query }>(
    '/api/v1/work-center/reminders',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: uuid },
        },
      },
    },
    async (req) => {
      const c = context(req),
        a = await c.actor();
      return {
        ...(await hub.policies(c)),
        units: await units(
          { ...a, permissions: a.permissions.filter((p) => p.permission === 'workflows:manage') },
          c.tenantId,
          [],
        ),
      };
    },
  );
  type Body = {
    tenantId: string;
    reason: string;
    id?: string;
    read?: boolean;
    unitId?: string;
    enabled?: boolean;
    beforeMinutes?: number;
    overdueMinutes?: number;
    expectedRevision: number;
  };
  for (const kind of ['notifications', 'reminders'] as const) {
    const fields =
      kind === 'notifications'
        ? { id: uuid, read: { type: 'boolean' } }
        : {
            unitId: uuid,
            enabled: { type: 'boolean' },
            beforeMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
            overdueMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          };
    app.post<{ Body: Body }>(
      '/api/v1/work-center/' + kind,
      {
        schema: {
          headers: {
            type: 'object',
            required: ['idempotency-key'],
            properties: {
              'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' },
            },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['tenantId', 'reason', 'expectedRevision', ...Object.keys(fields)],
            properties: {
              tenantId: uuid,
              reason: { type: 'string', minLength: 5, maxLength: 240 },
              expectedRevision: { type: 'integer', minimum: kind === 'notifications' ? 1 : 0 },
              ...fields,
            },
          },
        },
      },
      async (req) => {
        const b = req.body,
          c = {
            tenantId: b.tenantId,
            actor: () => actor(req),
            reason: b.reason,
            requestId: req.id,
            idempotencyKey: req.headers['idempotency-key'] as string,
          };
        return kind === 'notifications'
          ? hub.mark(c, b.id!, b.read!, b.expectedRevision)
          : hub.savePolicy(c, {
              unitId: b.unitId!,
              enabled: b.enabled!,
              beforeMinutes: b.beforeMinutes!,
              overdueMinutes: b.overdueMinutes!,
              expectedRevision: b.expectedRevision,
            });
      },
    );
  }
  return hub.workflows;
}
