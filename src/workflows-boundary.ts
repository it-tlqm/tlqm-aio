/** Foundation-owned BFF boundary; Workflows domain has no Identity/Forms DB access. */
import { createHmac } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppRuntime } from './config.js';
import type { Store } from './store.js';
import type { AuthResult } from './management/routes.js';
import { HttpError } from './security.js';
import { moduleDatabaseConnection, assertModuleReady } from './database/module-runtime.js';
import { workflowAllowed } from './workflows/access.js';
import type { WorkflowActor, WorkflowDirectory } from './workflows/access.js';
import { WorkflowsService } from './workflows/service.js';
import { registerWorkflowsRoutes } from './workflows/routes.js';
import { organizationResponsibility } from './organization-resolution.js';
import { workflowReferences } from './workflow-references-boundary.js';
import { moduleIntakeDestination } from './module-intake-boundary.js';
import { stagingFileScanner } from './staging-file-scan.js';
export async function registerWorkflowsBoundary(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  authenticate: (req: FastifyRequest) => Promise<AuthResult>,
  test: boolean,
) {
  const environment = test ? 'test' : runtime.mode;
  const pool = new pg.Pool({
    ...(await moduleDatabaseConnection(runtime, 'workflows', test)),
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on('error', () =>
    app.log.warn({ code: 'WORKFLOW_DATABASE_UNAVAILABLE' }, 'Workflows database unavailable'),
  );
  app.addHook('onClose', () => pool.end());
  const actor = async (request: FastifyRequest): Promise<WorkflowActor> => {
    const { principal } = await authenticate(request);
    return {
      appCode: 'aio-workflows',
      accountId: principal.accountId,
      personId: principal.personId,
      displayName: principal.displayName,
      tenantIds: (await store.memberships(principal.accountId, 'aio-workflows')).map(
        (row) => row.id as string,
      ),
      units: await store.activeUnits(principal.personId),
      permissions: principal.permissions.filter(
        (p) => p.managedAppCode === null || p.managedAppCode === 'aio-workflows',
      ),
    };
  };
  const directory = workflowDirectory(store);
  registerWorkflowsRoutes(app, {
    configurationTransfer: {
      key: runtime.encryptionKey,
      domain: runtime.instanceId + ':aio-workflows:' + environment,
    },
    service: new WorkflowsService(
      pool,
      directory,
      moduleIntakeDestination(runtime, store, test),
      createHmac('sha256', Buffer.from(runtime.encryptionKey, 'hex'))
        .update('aio-workflows:report-fields:' + runtime.instanceId + ':' + environment)
        .digest('hex'),
      runtime.mode === 'staging' ? stagingFileScanner(runtime.slot, runtime.scannerTls) : undefined,
    ),
    actor,
    async lookups(req, tenant, unitsOnly = false) {
      const a = await actor(req);
      if (!a.tenantIds.includes(tenant)) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      const all = (
        await store.pool.query(
          'SELECT u.id,u.name FROM org_units u JOIN legal_entities l ON l.id=u.legal_entity_id AND l.active WHERE u.tenant_id=$1 AND u.active ORDER BY u.name',
          [tenant],
        )
      ).rows as { id: string; name: string }[];
      const units = all.filter(
        (unit) =>
          a.units.some((own) => own.tenantId === tenant && own.orgUnitId === unit.id) ||
          a.permissions.some(
            (p) =>
              p.tenantId === tenant &&
              p.permission.startsWith('workflows:') &&
              (p.orgUnitId === null || p.orgUnitId === unit.id),
          ),
      );
      const managementUnits = units.filter((unit) =>
        ['workflows:design', 'workflows:publish', 'workflows:manage'].some((permission) =>
          workflowAllowed(a, tenant, permission as 'workflows:design', unit.id),
        ),
      );
      const accounts: { id: string; name: string; unitIds: string[] }[] = [];
      if (!unitsOnly && managementUnits.length) {
        const candidates = (
          await store.pool.query(
            'SELECT a.id FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active JOIN tenant_memberships m ON m.account_id=a.id AND m.active WHERE m.tenant_id=$1 AND a.active ORDER BY p.display_name LIMIT 200',
            [tenant],
          )
        ).rows as { id: string }[];
        for (const candidate of candidates) {
          const eligible: string[] = [];
          let name = '';
          for (const unit of managementUnits) {
            try {
              const user = await directory.assignee(tenant, unit.id, candidate.id);
              name = user.name;
              eligible.push(unit.id);
            } catch (error) {
              if (!(error instanceof HttpError && error.statusCode === 400)) throw error;
            }
          }
          if (eligible.length) accounts.push({ id: candidate.id, name, unitIds: eligible });
        }
      }
      return {
        units,
        ownUnits: a.units.filter((unit) => unit.tenantId === tenant).map((unit) => unit.orgUnitId),
        accounts,
      };
    },
  });
  return () => assertModuleReady(pool, runtime, 'workflows', test, 'WORKFLOW_DATABASE_NOT_READY');
}

export function workflowDirectory(store: Store): WorkflowDirectory {
  const directory: WorkflowDirectory = {
    async linkRecipient(tenant, accountId) {
      const person = (
        await store.pool.query<{ personId: string; displayName: string }>(
          `SELECT a.person_id AS "personId",p.display_name AS "displayName"
         FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active
         JOIN tenant_memberships m ON m.account_id=a.id AND m.tenant_id=$1 AND m.active
         JOIN tenants t ON t.id=m.tenant_id AND t.active
         JOIN application_grants g ON (g.account_id,g.tenant_id)=(m.account_id,m.tenant_id)
          AND g.app_code='aio-workflows' AND g.active AND (g.valid_until IS NULL OR g.valid_until>now())
         JOIN applications app ON app.code=g.app_code AND app.status='active'
         WHERE a.id=$2 AND a.active`,
          [tenant, accountId],
        )
      ).rows[0];
      if (!person) return null;
      const permissions = await store.applicationPermissions(accountId, 'aio-workflows');
      return {
        appCode: 'aio-workflows',
        accountId,
        ...person,
        tenantIds: [tenant],
        units: (await store.activeUnits(person.personId)).filter(
          (unit) => unit.tenantId === tenant,
        ),
        permissions: permissions.filter(
          (p) =>
            p.tenantId === tenant &&
            (p.managedAppCode === null || p.managedAppCode === 'aio-workflows'),
        ),
      };
    },
    references: (tenant, actor, query) => workflowReferences(store, tenant, actor, query),
    draftRecipients: (tenant, unit, search) =>
      directory.collaborators!(tenant, unit, { search }, 'workflows:start'),
    async collaborators(tenant, unit, query, permission = 'workflows:collaborate') {
      return (
        await store.pool.query<{ accountId: string; personId: string; name: string }>(
          `SELECT a.id AS "accountId",a.person_id AS "personId",p.display_name AS name
          FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active
          JOIN tenant_memberships m ON m.account_id=a.id AND m.tenant_id=$1 AND m.active
          JOIN tenants t ON t.id=m.tenant_id AND t.active
          JOIN application_grants g ON g.account_id=a.id AND g.tenant_id=m.tenant_id
           AND g.app_code='aio-workflows' AND g.active AND (g.valid_until IS NULL OR g.valid_until>now())
          JOIN applications app ON app.code=g.app_code AND app.status='active'
          WHERE a.active AND ($3::uuid IS NULL OR a.id=$3) AND strpos(lower(p.display_name),lower($4))>0
          AND EXISTS (
           SELECT 1 FROM role_bindings b
           JOIN app_roles r ON (r.tenant_id,r.app_code,r.code)=(b.tenant_id,b.app_code,b.role_code) AND r.active
           JOIN role_permissions rp ON (rp.tenant_id,rp.app_code,rp.role_code)=(r.tenant_id,r.app_code,r.code)
           JOIN permission_catalog pc ON (pc.app_code,pc.code)=(rp.app_code,rp.permission) AND pc.active
           WHERE b.account_id=a.id AND b.tenant_id=$1 AND b.app_code=g.app_code AND b.active
            AND b.valid_from<=now() AND (b.valid_until IS NULL OR b.valid_until>now())
            AND (b.org_unit_id IS NULL OR b.org_unit_id=$2)
            AND (b.managed_app_code IS NULL OR b.managed_app_code=g.app_code)
            AND rp.permission=$5
          )
          AND EXISTS (
           SELECT 1 FROM employments e JOIN assignments x ON (x.tenant_id,x.employment_id)=(e.tenant_id,e.id)
           JOIN positions pos ON (pos.tenant_id,pos.id)=(x.tenant_id,x.position_id) AND pos.active
           JOIN org_units u ON (u.tenant_id,u.id)=(pos.tenant_id,pos.org_unit_id) AND u.active
           JOIN legal_entities le ON (le.tenant_id,le.id)=(u.tenant_id,u.legal_entity_id) AND le.active
           WHERE e.tenant_id=$1 AND e.person_id=p.id AND u.id=$2
            AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now())
            AND x.valid_from<=now() AND (x.valid_until IS NULL OR x.valid_until>now())
          )
          ORDER BY lower(p.display_name),a.id LIMIT 30`,
          [tenant, unit, query.accountId ?? null, query.search ?? '', permission],
        )
      ).rows;
    },
    async responsible(tenant, unit, ownerPersonId, kind) {
      const target = await organizationResponsibility(store, tenant, unit, ownerPersonId, kind);
      const candidates: string[] = [];
      for (const account of target.accountIds) {
        try {
          await directory.assignee(tenant, unit, account);
          candidates.push(account);
        } catch (error) {
          if (!(error instanceof HttpError && error.statusCode === 400)) throw error;
        }
      }
      if (candidates.length !== 1)
        throw new HttpError(400, 'WORKFLOW_ORGANIZATION_ACCOUNT_AMBIGUOUS');
      return { accountId: candidates[0]!, personId: target.personId, basis: target.basis };
    },
    async validateUnit(tenant, unit) {
      if (
        !(
          await store.pool.query(
            'SELECT 1 FROM org_units u JOIN legal_entities e ON e.id=u.legal_entity_id AND e.active WHERE u.tenant_id=$1 AND u.id=$2 AND u.active',
            [tenant, unit],
          )
        ).rowCount
      )
        throw new HttpError(400, 'WORKFLOW_REFERENCE_DENIED');
    },
    async assignee(tenant, unit, accountId) {
      const row = (
        await store.pool.query(
          `SELECT a.person_id AS "personId",p.display_name AS name FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active JOIN tenant_memberships m ON m.account_id=a.id AND m.active JOIN tenants t ON t.id=m.tenant_id AND t.active JOIN application_grants g ON g.account_id=a.id AND g.tenant_id=m.tenant_id AND g.app_code='aio-workflows' AND g.active AND (g.valid_until IS NULL OR g.valid_until>now()) JOIN applications app ON app.code=g.app_code AND app.status='active' WHERE a.id=$1 AND a.active AND m.tenant_id=$2 AND EXISTS(SELECT 1 FROM role_bindings b JOIN app_roles r ON r.tenant_id=b.tenant_id AND r.app_code=b.app_code AND r.code=b.role_code AND r.active JOIN role_permissions rp ON rp.tenant_id=r.tenant_id AND rp.app_code=r.app_code AND rp.role_code=r.code JOIN permission_catalog pc ON pc.app_code=rp.app_code AND pc.code=rp.permission AND pc.active WHERE b.account_id=a.id AND b.tenant_id=$2 AND b.app_code='aio-workflows' AND b.active AND b.valid_from<=now() AND (b.valid_until IS NULL OR b.valid_until>now()) AND ($3::uuid IS NULL OR b.org_unit_id IS NULL OR b.org_unit_id=$3) AND (b.managed_app_code IS NULL OR b.managed_app_code='aio-workflows') AND rp.permission='workflows:act')`,
          [accountId, tenant, unit],
        )
      ).rows[0] as { personId: string; name: string } | undefined;
      if (!row) throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
      return row;
    },
  };
  return directory;
}
