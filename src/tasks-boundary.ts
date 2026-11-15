import pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppRuntime } from './config.js';
import type { Store } from './store.js';
import type { AuthResult } from './management/routes.js';
import { HttpError } from './security.js';
import { taskAllowed, taskDenied, taskUnitMember } from './tasks/access.js';
import type { TaskActor, TaskDirectory } from './tasks/access.js';
import { moduleDatabaseConnection, assertModuleReady } from './database/module-runtime.js';
import type { TaskPerson } from './tasks/options.js';
import { registerTasksRoutes } from './tasks/routes.js';
import { TasksService } from './tasks/service.js';

const appCode = 'aio-tasks' as const;
const eligibleAccounts = `SELECT a.id AS "accountId",a.person_id AS "personId",p.display_name AS name
  FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active
  JOIN tenant_memberships m ON (m.tenant_id,m.account_id)=($1,a.id) AND m.active
  JOIN tenants t ON t.id=m.tenant_id AND t.active
  JOIN application_grants g ON (g.tenant_id,g.account_id)=(m.tenant_id,a.id)
    AND g.app_code='aio-tasks' AND g.active AND (g.valid_until IS NULL OR g.valid_until>now())
  JOIN applications app ON app.code=g.app_code AND app.status='active'
  WHERE a.active`;

export function tasksDirectory(store: Store): TaskDirectory {
  return {
    async validateUnit(tenant, unit) {
      const { rowCount } = await store.pool.query(
        `SELECT 1 FROM org_units u JOIN legal_entities l ON (l.tenant_id,l.id)=(u.tenant_id,u.legal_entity_id) AND l.active
         WHERE (u.tenant_id,u.id)=($1,$2) AND u.active`,
        [tenant, unit],
      );
      if (!rowCount) throw new HttpError(400, 'TASKS_UNIT_UNAVAILABLE');
    },
    async actor(tenant, account) {
      const { rows } = await store.pool.query<TaskPerson>(eligibleAccounts + ' AND a.id=$2', [
        tenant,
        account,
      ]);
      const person = rows[0];
      if (!person) return null;
      const [units, permissions] = await Promise.all([
        store.activeUnits(person.personId),
        store.applicationPermissions(account, appCode),
      ]);
      return {
        ...person,
        appCode,
        tenantIds: [tenant],
        units: units.filter((row) => row.tenantId === tenant),
        permissions: permissions.filter(
          (row) =>
            row.tenantId === tenant &&
            (row.managedAppCode === null || row.managedAppCode === appCode),
        ),
      };
    },
    async search(tenant, unit, search) {
      const { rows } = await store.pool.query<TaskPerson>(
        eligibleAccounts +
          `
        AND ($3::text='' OR position(lower($3) in lower(p.display_name))>0)
        AND EXISTS (
          SELECT 1 FROM role_bindings b JOIN app_roles r ON (r.tenant_id,r.app_code,r.code)=(b.tenant_id,b.app_code,b.role_code) AND r.active
          JOIN role_permissions rp ON (rp.tenant_id,rp.app_code,rp.role_code)=(r.tenant_id,r.app_code,r.code)
          JOIN permission_catalog pc ON (pc.app_code,pc.code)=(rp.app_code,rp.permission) AND pc.active
          WHERE (b.tenant_id,b.app_code,b.account_id)=($1,g.app_code,a.id) AND b.active
            AND b.valid_from<=now() AND (b.valid_until IS NULL OR b.valid_until>now())
            AND (b.org_unit_id IS NULL OR b.org_unit_id=$2)
            AND (b.managed_app_code IS NULL OR b.managed_app_code=g.app_code)
            AND rp.permission IN('tasks:view','tasks:work')
        )
        AND EXISTS (
          SELECT 1 FROM employments e JOIN assignments x ON (x.tenant_id,x.employment_id)=(e.tenant_id,e.id)
          JOIN positions pos ON (pos.tenant_id,pos.id)=(x.tenant_id,x.position_id) AND pos.active
          JOIN org_units u ON (u.tenant_id,u.id)=(pos.tenant_id,pos.org_unit_id) AND u.active
          JOIN legal_entities le ON (le.tenant_id,le.id)=(u.tenant_id,u.legal_entity_id) AND le.active
          WHERE e.tenant_id=$1 AND e.person_id=p.id AND u.id=$2 AND e.valid_from<=now()
            AND (e.valid_until IS NULL OR e.valid_until>now()) AND x.valid_from<=now()
            AND (x.valid_until IS NULL OR x.valid_until>now())
        )
        ORDER BY lower(p.display_name),a.id LIMIT 40`,
        [tenant, unit, search],
      );
      return rows;
    },
  };
}

export async function registerTasksBoundary(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  authenticate: (req: FastifyRequest) => Promise<AuthResult>,
  test: boolean,
) {
  const pool = new pg.Pool({
    ...(await moduleDatabaseConnection(runtime, 'tasks', test)),
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on('error', () =>
    app.log.warn({ code: 'TASKS_DATABASE_UNAVAILABLE' }, 'Tasks database unavailable'),
  );
  const service = new TasksService(pool, tasksDirectory(store));
  const actor = async (request: FastifyRequest): Promise<TaskActor> => {
    const { principal } = await authenticate(request);
    const [memberships, units] = await Promise.all([
      store.memberships(principal.accountId, appCode),
      store.activeUnits(principal.personId),
    ]);
    return {
      appCode,
      accountId: principal.accountId,
      personId: principal.personId,
      name: principal.displayName,
      tenantIds: memberships.map(({ id }) => id as string),
      units,
      permissions: principal.permissions.filter(
        (row) => row.managedAppCode === null || row.managedAppCode === appCode,
      ),
    };
  };
  registerTasksRoutes(app, service, actor, async (context) => {
    const who = await context.actor(),
      tenant = context.tenantId;
    if (!who.tenantIds.includes(tenant)) throw taskDenied();
    const { rows } = await store.pool.query<{ id: string; name: string }>(
      `SELECT u.id,u.name FROM org_units u JOIN legal_entities l ON (l.tenant_id,l.id)=(u.tenant_id,u.legal_entity_id)
       WHERE u.tenant_id=$1 AND u.active AND l.active ORDER BY u.name,u.id`,
      [tenant],
    );
    return {
      units: rows.flatMap((unit) => {
        const canCreate = taskAllowed(who, tenant, unit.id, 'tasks:manage');
        return canCreate ||
          (taskUnitMember(who, tenant, unit.id) &&
            (taskAllowed(who, tenant, unit.id, 'tasks:view') ||
              taskAllowed(who, tenant, unit.id, 'tasks:work')))
          ? [{ ...unit, canCreate }]
          : [];
      }),
    };
  });
  const ready = () => assertModuleReady(pool, runtime, 'tasks', test, 'TASKS_DATABASE_NOT_READY');
  let tick: Promise<unknown> | undefined;
  const remind = () => {
    tick ??= ready()
      .then(() => service.runReminders())
      .catch(() =>
        app.log.warn({ code: 'TASKS_REMINDERS_UNAVAILABLE' }, 'Tasks reminders unavailable'),
      )
      .finally(() => {
        tick = undefined;
      });
  };
  const timer = test ? undefined : setInterval(remind, 30000).unref();
  if (!test)
    app.addHook('onReady', async () => {
      remind();
    });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await tick;
    await pool.end();
  });
  return ready;
}
