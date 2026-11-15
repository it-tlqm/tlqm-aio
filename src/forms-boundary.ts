/** Foundation-operated BFF boundary. Forms domain code has no access to the identity store. */
import pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal, Store } from './store.js';
import type { AuthResult } from './management/routes.js';
import type { AppRuntime } from './config.js';
import { HttpError } from './security.js';
import { moduleDatabaseConnection, assertModuleReady } from './database/module-runtime.js';
import { FormsService } from './forms/service.js';
import { registerFormsRoutes } from './forms/routes.js';
import type { FormsActor, FormsDirectory } from './forms/access.js';
import { hasFormsPermission } from './forms/access.js';

export async function formsActor(store: Store, principal: Principal): Promise<FormsActor> {
  const [memberships, units] = await Promise.all([
    store.memberships(principal.accountId, 'aio-forms'),
    store.activeUnits(principal.personId),
  ]);
  return {
    appCode: 'aio-forms',
    accountId: principal.accountId,
    personId: principal.personId,
    tenantIds: memberships.map((row) => String(row.id)),
    units,
    permissions: principal.permissions.filter(
      (item) => item.managedAppCode === null || item.managedAppCode === 'aio-forms',
    ),
  };
}

export async function formWorkActor(store: Store, auth: AuthResult, tenant: string) {
  if (
    !(await store.memberships(auth.principal.accountId, 'aio-foundation')).some(
      ({ id }) => id === tenant,
    )
  )
    throw new HttpError(403, 'PERMISSION_DENIED');
  const principal = await store.principal(auth.identity, 'aio-forms');
  if (
    principal.accountId !== auth.principal.accountId ||
    principal.personId !== auth.principal.personId
  )
    throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
  return formsActor(store, principal);
}

export function registerFormsWorkRoute(
  app: FastifyInstance,
  service: Pick<FormsService, 'assignedForms'>,
  actor: (request: FastifyRequest, tenant: string) => Promise<FormsActor>,
  baseUrl: string,
) {
  const uuid = { type: 'string', format: 'uuid' };
  app.get<{ Querystring: { tenantId: string; after?: string; search?: string } }>(
    '/api/v1/work-center/forms',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: uuid, after: uuid, search: { type: 'string', maxLength: 120 } },
        },
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { tenantId, after, search } = req.query;
      const result = await service.assignedForms(
        { tenantId, actor: () => actor(req, tenantId) },
        after,
        search,
      );
      return { ...result, source: { code: 'aio-forms', name: 'Biểu mẫu', baseUrl } };
    },
  );
}

export async function registerFormsWorkCenter(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  authenticate: (request: FastifyRequest) => Promise<AuthResult>,
  test: boolean,
) {
  const source = runtime.clients.find(
    ({ code, kind }) => code === 'aio-forms' && kind === 'application',
  );
  if (!source) return;
  const pool = new pg.Pool({
    ...(await moduleDatabaseConnection(runtime, 'forms', test)),
    max: 3,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on('error', () =>
    app.log.warn({ code: 'FORMS_DATABASE_UNAVAILABLE' }, 'Forms database connection lost'),
  );
  app.addHook('onClose', () => pool.end());
  if (runtime.mode === 'staging')
    app.addHook('onReady', () =>
      assertModuleReady(pool, runtime, 'forms', test, 'FORMS_DATABASE_NOT_READY'),
    );
  const service = new FormsService(pool, {
    validateTargets: async () => {
      throw new Error('Forms work center is read-only.');
    },
  });
  registerFormsWorkRoute(
    app,
    service,
    async (req, tenant) => formWorkActor(store, await authenticate(req), tenant),
    source.baseUrl,
  );
}

export async function registerFormsBoundary(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  authenticate: (req: FastifyRequest) => Promise<AuthResult>,
  test: boolean,
) {
  const pool = new pg.Pool({
    ...(await moduleDatabaseConnection(runtime, 'forms', test)),
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on('error', () =>
    app.log.warn({ code: 'FORMS_DATABASE_UNAVAILABLE' }, 'Forms database connection lost'),
  );
  app.addHook('onClose', () => pool.end());
  const actor = async (request: FastifyRequest): Promise<FormsActor> => {
    const { principal } = await authenticate(request);
    return formsActor(store, principal);
  };
  const directory: FormsDirectory = {
    async validateTargets(tenantId, unitScope, targets) {
      for (const target of targets) {
        if (target.kind === 'unit') {
          if (
            (unitScope && unitScope !== target.id) ||
            !(
              await store.pool.query(
                'SELECT 1 FROM org_units u JOIN legal_entities l ON l.id=u.legal_entity_id AND l.tenant_id=u.tenant_id AND l.active WHERE u.tenant_id=$1 AND u.id=$2 AND u.active',
                [tenantId, target.id],
              )
            ).rowCount
          )
            throw new HttpError(400, 'FORM_REFERENCE_DENIED');
        } else {
          const account = (
            await store.pool.query(
              'SELECT a.person_id FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active JOIN tenant_memberships m ON m.account_id=a.id AND m.active WHERE a.id=$1 AND m.tenant_id=$2 AND a.active',
              [target.id, tenantId],
            )
          ).rows[0];
          if (!account) throw new HttpError(400, 'FORM_REFERENCE_DENIED');
          if (unitScope) {
            const units = await store.activeUnits(account.person_id);
            if (!units.some((unit) => unit.tenantId === tenantId && unit.orgUnitId === unitScope))
              throw new HttpError(400, 'FORM_REFERENCE_DENIED');
          }
        }
      }
    },
  };
  const service = new FormsService(pool, directory);
  registerFormsRoutes(app, {
    service,
    actor,
    async lookups(req, tenantId) {
      const principal = await actor(req);
      if (!principal.tenantIds.includes(tenantId))
        throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
      const units = (
        await store.pool.query(
          'SELECT u.id,u.name FROM org_units u JOIN legal_entities l ON l.id=u.legal_entity_id AND l.tenant_id=u.tenant_id AND l.active WHERE u.tenant_id=$1 AND u.active ORDER BY u.name',
          [tenantId],
        )
      ).rows as { id: string; name: string }[];
      const available = units.filter(
        (unit) =>
          principal.units.some((own) => own.tenantId === tenantId && own.orgUnitId === unit.id) ||
          ['forms:design', 'forms:publish', 'forms:review', 'forms:analyze', 'forms:export'].some(
            (permission) =>
              hasFormsPermission(principal, tenantId, permission as 'forms:design', unit.id),
          ),
      );
      const publishUnits = units
        .filter((unit) => hasFormsPermission(principal, tenantId, 'forms:publish', unit.id))
        .map((unit) => unit.id);
      let accounts: { id: string; name: string }[] = [];
      if (publishUnits.length || hasFormsPermission(principal, tenantId, 'forms:publish', null)) {
        const rows = (
          await store.pool.query(
            'SELECT a.id,a.person_id,p.display_name AS name FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active JOIN tenant_memberships m ON m.account_id=a.id AND m.active WHERE m.tenant_id=$1 AND a.active ORDER BY p.display_name LIMIT 500',
            [tenantId],
          )
        ).rows as { id: string; person_id: string; name: string }[];
        for (const row of rows) {
          if (hasFormsPermission(principal, tenantId, 'forms:publish', null))
            accounts.push({ id: row.id, name: row.name });
          else {
            const memberUnits = await store.activeUnits(row.person_id);
            if (
              memberUnits.some(
                (unit) => unit.tenantId === tenantId && publishUnits.includes(unit.orgUnitId),
              )
            )
              accounts.push({ id: row.id, name: row.name });
          }
        }
      }
      return {
        units: available,
        ownUnits: principal.units
          .filter((unit) => unit.tenantId === tenantId)
          .map((unit) => unit.orgUnitId),
        accounts,
      };
    },
  });
  return () => assertModuleReady(pool, runtime, 'forms', test, 'FORMS_DATABASE_NOT_READY');
}
