import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Principal, Store } from '../store.js';
import { HttpError } from '../security.js';
import { foundationPermissions, managementPermissions } from '../policy.js';
import { camelRow } from './directory.js';
import { auditMutation, mutate } from './mutations.js';
import type { MutationContext } from './mutations.js';

type Db = Pool | PoolClient;
export type RoleInput = {
  appCode: string;
  code?: string;
  name?: string;
  permissions?: string[];
  active?: boolean;
};
export type PermissionInput = { appCode: string; code?: string; name?: string; active?: boolean };
export type BindingInput = {
  appCode: string;
  accountId?: string;
  roleCode?: string;
  orgUnitId?: string | null;
  managedAppCode?: string | null;
  active?: boolean;
  validFrom?: string;
  validUntil?: string | null;
};
export type ApplicationInput = {
  code?: string;
  name?: string;
  description?: string;
  launchUrl?: string | null;
  status?: 'active' | 'planned' | 'disabled';
};
export type GrantInput = {
  appCode: string;
  accountId: string;
  active: boolean;
  validUntil?: string | null;
};
function revision(row: Record<string, unknown> | undefined, expected: number | undefined) {
  if (!row) throw new HttpError(404, 'RECORD_NOT_FOUND');
  if (!Number.isInteger(expected) || row.revision !== expected)
    throw new HttpError(409, 'REVISION_CONFLICT');
  return row;
}
function localLaunchUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'INVALID_LOCAL_URL');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    Number(url.port) < 4100 ||
    Number(url.port) > 4199 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new HttpError(400, 'INVALID_LOCAL_URL');
  return url.origin;
}
export class GovernanceService {
  constructor(private store: Store) {}
  async assertApp(db: Db, actor: Principal, tenantId: string, appCode: string, permission: string) {
    this.store.require(actor, permission, tenantId);
    const explicit = actor.permissions.some(
      (p) =>
        p.tenantId === tenantId &&
        p.permission === permission &&
        p.orgUnitId === null &&
        p.managedAppCode === appCode,
    );
    if (!explicit) {
      const delegation = await db.query(
        'SELECT 1 FROM application_delegations WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 AND active',
        [actor.accountId, tenantId, appCode],
      );
      if (!delegation.rowCount) throw new HttpError(403, 'APPLICATION_DELEGATION_DENIED');
    }
    const app = (await db.query('SELECT * FROM applications WHERE code=$1', [appCode])).rows[0];
    if (!app) throw new HttpError(404, 'APPLICATION_NOT_FOUND');
    return app;
  }
  private ceiling(
    actor: Principal,
    tenantId: string,
    permissions: string[],
    unit: string | null = null,
  ) {
    for (const permission of permissions) {
      if (
        permission === 'identity:provision' &&
        !['identity:link', 'directory:read', 'people:read'].every((required) =>
          actor.permissions.some(
            (value) =>
              value.tenantId === tenantId &&
              value.permission === required &&
              value.orgUnitId === null,
          ),
        )
      )
        throw new HttpError(403, 'PERMISSION_CEILING_EXCEEDED');
      if (
        permission === 'directory:lookup' &&
        !['directory:read', 'people:read'].every((required) =>
          actor.permissions.some(
            (value) =>
              value.tenantId === tenantId &&
              value.permission === required &&
              (value.orgUnitId === null || value.orgUnitId === unit),
          ),
        )
      )
        throw new HttpError(403, 'PERMISSION_CEILING_EXCEEDED');
      if (
        Object.hasOwn(foundationPermissions, permission) &&
        !actor.permissions.some(
          (p) =>
            p.tenantId === tenantId &&
            p.permission === permission &&
            (p.orgUnitId === null || (unit !== null && p.orgUnitId === unit)),
        )
      )
        throw new HttpError(403, 'PERMISSION_CEILING_EXCEEDED');
    }
    if (unit && permissions.some((permission) => managementPermissions.has(permission)))
      throw new HttpError(400, 'MANAGEMENT_ROLE_REQUIRES_TENANT_SCOPE');
  }
  async applications(actor: Principal, tenantId: string) {
    this.store.require(actor, 'applications:manage', tenantId);
    const records = (
      await this.store.pool.query(
        'SELECT * FROM applications WHERE owner_tenant_id=$1 ORDER BY code',
        [tenantId],
      )
    ).rows;
    return { items: records.map(camelRow) };
  }
  async saveApplication(
    context: MutationContext,
    data: ApplicationInput,
    code?: string,
    expectedRevision?: number,
  ) {
    const permission = code ? 'applications:manage' : 'applications:create';
    return mutate(
      this.store,
      context,
      permission,
      code ? 'application.update' : 'application.create',
      { code: code ?? null, expectedRevision: expectedRevision ?? null, data },
      async (db, actor) => {
        const before = code
          ? revision(
              (
                await db.query(
                  'SELECT * FROM applications WHERE code=$1 AND owner_tenant_id=$2 FOR UPDATE',
                  [code, context.tenantId],
                )
              ).rows[0],
              expectedRevision,
            )
          : null;
        if (!code && (!data.code || !data.name)) throw new HttpError(400, 'MISSING_REQUIRED_FIELD');
        const appCode = code ?? data.code!;
        if (code && data.code && data.code !== code)
          throw new HttpError(400, 'IMMUTABLE_APPLICATION_CODE');
        const name = data.name ?? before?.name;
        const description = data.description ?? before?.description ?? '';
        const launchUrl =
          data.launchUrl === undefined
            ? (before?.launch_url ?? null)
            : localLaunchUrl(data.launchUrl);
        const status = data.status ?? before?.status ?? 'planned';
        const urlChanged = before && launchUrl !== before.launch_url;
        if (before?.protected && (urlChanged || status !== before.status))
          throw new HttpError(403, 'PROTECTED_APPLICATION');
        if (status === 'active' && (!before?.provisioned_at || urlChanged))
          throw new HttpError(409, 'APPLICATION_PROVISIONING_REQUIRED');
        let row;
        if (before) {
          row = (
            await db.query(
              'UPDATE applications SET name=$3,description=$4,launch_url=$5,status=$6,revision=revision+1,provisioned_at=CASE WHEN $7 THEN NULL ELSE provisioned_at END,oidc_client_id=CASE WHEN $7 THEN NULL ELSE oidc_client_id END,oidc_audience=CASE WHEN $7 THEN NULL ELSE oidc_audience END WHERE code=$1 AND owner_tenant_id=$2 RETURNING *',
              [
                appCode,
                context.tenantId,
                name,
                description,
                launchUrl,
                status,
                Boolean(urlChanged),
              ],
            )
          ).rows[0];
        } else {
          row = (
            await db.query(
              'INSERT INTO applications(code,name,description,launch_url,status,owner_tenant_id,protected) VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING *',
              [appCode, name, description, launchUrl, status, context.tenantId],
            )
          ).rows[0];
          await db.query(
            'INSERT INTO application_delegations(account_id,tenant_id,app_code,created_by) VALUES ($1,$2,$3,$1)',
            [actor.accountId, context.tenantId, appCode],
          );
        }
        await auditMutation(
          db,
          context,
          actor,
          code ? 'application.updated' : 'application.registered',
          'application',
          appCode,
          before,
          row,
        );
        return camelRow(row);
      },
      code
        ? async (db, actor) => {
            await this.assertApp(db, actor, context.tenantId, code, 'applications:manage');
          }
        : undefined,
    );
  }
  async catalog(actor: Principal, tenantId: string, appCode: string) {
    await this.assertApp(this.store.pool, actor, tenantId, appCode, 'roles:read');
    return {
      items: (
        await this.store.pool.query(
          'SELECT * FROM permission_catalog WHERE app_code=$1 ORDER BY code',
          [appCode],
        )
      ).rows.map(camelRow),
    };
  }
  async savePermission(
    context: MutationContext,
    data: PermissionInput,
    code?: string,
    expectedRevision?: number,
  ) {
    return mutate(
      this.store,
      context,
      'roles:manage',
      code ? 'permission.update' : 'permission.create',
      { code: code ?? null, expectedRevision: expectedRevision ?? null, data },
      async (db, actor) => {
        const before = code
          ? revision(
              (
                await db.query(
                  'SELECT * FROM permission_catalog WHERE app_code=$1 AND code=$2 FOR UPDATE',
                  [data.appCode, code],
                )
              ).rows[0],
              expectedRevision,
            )
          : null;
        if (before?.protected) throw new HttpError(403, 'PROTECTED_PERMISSION');
        const permissionCode = code ?? data.code;
        if (
          permissionCode &&
          ['directory:lookup', 'identity:provision'].includes(permissionCode) &&
          (data.active ?? before?.active ?? true)
        )
          this.ceiling(actor, context.tenantId, [permissionCode]);
        if (!permissionCode || (!before && !data.name))
          throw new HttpError(400, 'MISSING_REQUIRED_FIELD');
        if (code && data.code && data.code !== code)
          throw new HttpError(400, 'IMMUTABLE_PERMISSION_CODE');
        if (!before && Object.hasOwn(foundationPermissions, permissionCode))
          throw new HttpError(403, 'RESERVED_PERMISSION_CODE');
        const row = before
          ? (
              await db.query(
                'UPDATE permission_catalog SET name=$3,active=$4,revision=revision+1 WHERE app_code=$1 AND code=$2 RETURNING *',
                [
                  data.appCode,
                  permissionCode,
                  data.name ?? before.name,
                  data.active ?? before.active,
                ],
              )
            ).rows[0]
          : (
              await db.query(
                'INSERT INTO permission_catalog(app_code,code,name,active,protected) VALUES ($1,$2,$3,$4,false) RETURNING *',
                [data.appCode, permissionCode, data.name, data.active ?? true],
              )
            ).rows[0];
        await auditMutation(
          db,
          context,
          actor,
          code ? 'permission.updated' : 'permission.created',
          'permission',
          data.appCode + ':' + permissionCode,
          before,
          row,
        );
        return camelRow(row);
      },
      async (db, actor) => {
        const app = await this.assertApp(db, actor, context.tenantId, data.appCode, 'roles:manage');
        if (app.owner_tenant_id !== context.tenantId)
          throw new HttpError(403, 'APPLICATION_OWNER_REQUIRED');
      },
    );
  }
  async roles(actor: Principal, tenantId: string, appCode: string) {
    await this.assertApp(this.store.pool, actor, tenantId, appCode, 'roles:read');
    const rows = (
      await this.store.pool.query(
        "SELECT r.*,COALESCE((SELECT json_agg(p.permission ORDER BY p.permission) FROM role_permissions p WHERE p.tenant_id=r.tenant_id AND p.app_code=r.app_code AND p.role_code=r.code),'[]'::json) AS permissions,(SELECT count(*)::integer FROM role_bindings b WHERE b.tenant_id=r.tenant_id AND b.app_code=r.app_code AND b.role_code=r.code AND b.active) AS binding_count FROM app_roles r WHERE r.tenant_id=$1 AND r.app_code=$2 ORDER BY r.code",
        [tenantId, appCode],
      )
    ).rows;
    return { items: rows.map(camelRow) };
  }
  async saveRole(
    context: MutationContext,
    data: RoleInput,
    code?: string,
    expectedRevision?: number,
  ): Promise<Record<string, unknown> & { permissions: string[] }> {
    return mutate(
      this.store,
      context,
      'roles:manage',
      code ? 'role.update' : 'role.create',
      { code: code ?? null, expectedRevision: expectedRevision ?? null, data },
      async (db, actor) => {
        const before = code
          ? revision(
              (
                await db.query(
                  'SELECT * FROM app_roles WHERE tenant_id=$1 AND app_code=$2 AND code=$3 FOR UPDATE',
                  [context.tenantId, data.appCode, code],
                )
              ).rows[0],
              expectedRevision,
            )
          : null;
        if (before?.protected) throw new HttpError(403, 'PROTECTED_ROLE');
        const roleCode = code ?? data.code;
        if (!roleCode || (!before && (!data.name || !data.permissions)))
          throw new HttpError(400, 'MISSING_REQUIRED_FIELD');
        if (
          (code && data.code && data.code !== code) ||
          (!before && ['reader', 'access-admin'].includes(roleCode))
        )
          throw new HttpError(403, 'RESERVED_ROLE_CODE');
        const previous = (
          await db.query<{ permission: string }>(
            'SELECT permission FROM role_permissions WHERE tenant_id=$1 AND app_code=$2 AND role_code=$3 ORDER BY permission',
            [context.tenantId, data.appCode, roleCode],
          )
        ).rows.map((row) => row.permission);
        const permissions = [...new Set(data.permissions ?? previous)].sort();
        const active = data.active ?? before?.active ?? true;
        const catalog = await db.query(
          'SELECT code FROM permission_catalog WHERE app_code=$1 AND code=ANY($2::text[]) AND (active OR $3)',
          [data.appCode, permissions, !active],
        );
        if (catalog.rowCount !== permissions.length) throw new HttpError(400, 'INVALID_PERMISSION');
        this.ceiling(actor, context.tenantId, [...new Set([...previous, ...permissions])]);
        if (
          before &&
          (permissions.some((value) => !previous.includes(value)) || (!before.active && active))
        ) {
          const self = await db.query(
            'SELECT 1 FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 AND role_code=$4 AND active',
            [actor.accountId, context.tenantId, data.appCode, roleCode],
          );
          if (self.rowCount) throw new HttpError(403, 'SELF_ESCALATION_FORBIDDEN');
        }
        const row = before
          ? (
              await db.query(
                'UPDATE app_roles SET name=$4,active=$5,revision=revision+1 WHERE tenant_id=$1 AND app_code=$2 AND code=$3 RETURNING *',
                [context.tenantId, data.appCode, roleCode, data.name ?? before.name, active],
              )
            ).rows[0]
          : (
              await db.query(
                'INSERT INTO app_roles(tenant_id,app_code,code,name,active,protected) VALUES ($1,$2,$3,$4,$5,false) RETURNING *',
                [context.tenantId, data.appCode, roleCode, data.name, active],
              )
            ).rows[0];
        await db.query(
          'DELETE FROM role_permissions WHERE tenant_id=$1 AND app_code=$2 AND role_code=$3',
          [context.tenantId, data.appCode, roleCode],
        );
        for (const permission of permissions)
          await db.query(
            'INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,$2,$3,$4)',
            [context.tenantId, data.appCode, roleCode, permission],
          );
        if (active && permissions.some((permission) => managementPermissions.has(permission))) {
          const affected = await db.query<{ id: string }>(
            'UPDATE accounts a SET mfa_required=true,revision=revision+1 WHERE NOT a.mfa_required AND EXISTS(SELECT 1 FROM role_bindings b WHERE b.account_id=a.id AND b.tenant_id=$1 AND b.app_code=$2 AND b.role_code=$3 AND b.active) RETURNING a.id',
            [context.tenantId, data.appCode, roleCode],
          );
          for (const account of affected.rows)
            await auditMutation(
              db,
              context,
              actor,
              'account.mfa_required',
              'account',
              account.id,
              { mfaRequired: false },
              { mfaRequired: true },
              account.id,
            );
        }
        await auditMutation(
          db,
          context,
          actor,
          code ? 'role.updated' : 'role.created',
          'role',
          data.appCode + ':' + roleCode,
          before ? { ...before, permissions: previous } : null,
          { ...row, permissions },
        );
        return { ...camelRow(row), permissions };
      },
      async (db, actor) => {
        await this.assertApp(db, actor, context.tenantId, data.appCode, 'roles:manage');
      },
    );
  }
  async bindings(actor: Principal, tenantId: string, appCode: string) {
    await this.assertApp(this.store.pool, actor, tenantId, appCode, 'roles:read');
    return {
      items: (
        await this.store.pool.query(
          'SELECT b.*,p.display_name,a.is_protected FROM role_bindings b JOIN accounts a ON a.id=b.account_id JOIN persons p ON p.id=a.person_id WHERE b.tenant_id=$1 AND b.app_code=$2 ORDER BY p.display_name,b.id',
          [tenantId, appCode],
        )
      ).rows.map(camelRow),
    };
  }
  async saveBinding(
    context: MutationContext,
    data: BindingInput,
    id?: string,
    expectedRevision?: number,
  ) {
    return mutate(
      this.store,
      context,
      'roles:manage',
      id ? 'binding.update' : 'binding.create',
      { id: id ?? null, expectedRevision: expectedRevision ?? null, data },
      async (db, actor) => {
        const before = id
          ? revision(
              (
                await db.query(
                  'SELECT * FROM role_bindings WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
                  [id, context.tenantId],
                )
              ).rows[0],
              expectedRevision,
            )
          : null;
        if (
          before &&
          (before.app_code !== data.appCode ||
            (data.accountId && data.accountId !== before.account_id))
        )
          throw new HttpError(400, 'IMMUTABLE_RELATION');
        const accountId = data.accountId ?? (before?.account_id as string | undefined);
        if (!accountId) throw new HttpError(400, 'MISSING_REQUIRED_FIELD');
        if (accountId === actor.accountId) throw new HttpError(403, 'SELF_ASSIGNMENT_FORBIDDEN');
        const target = (
          await db.query(
            'SELECT a.*,p.active AS person_active,m.active AS membership_active FROM accounts a JOIN persons p ON p.id=a.person_id JOIN tenant_memberships m ON m.account_id=a.id WHERE a.id=$1 AND m.tenant_id=$2',
            [accountId, context.tenantId],
          )
        ).rows[0];
        if (!target) throw new HttpError(404, 'TARGET_NOT_FOUND');
        if (target.is_protected) throw new HttpError(403, 'PROTECTED_ACCOUNT');
        const active = data.active ?? before?.active ?? true;
        if (active && (!target.active || !target.person_active || !target.membership_active))
          throw new HttpError(403, 'ACCOUNT_UNAVAILABLE');
        const roleCode = data.roleCode ?? before?.role_code;
        const role = (
          await db.query('SELECT * FROM app_roles WHERE tenant_id=$1 AND app_code=$2 AND code=$3', [
            context.tenantId,
            data.appCode,
            roleCode,
          ])
        ).rows[0];
        if (!role || (active && !role.active)) throw new HttpError(400, 'ROLE_NOT_ACTIVE');
        const permissions = (
          await db.query<{ permission: string }>(
            'SELECT permission FROM role_permissions WHERE tenant_id=$1 AND app_code=$2 AND role_code=$3',
            [context.tenantId, data.appCode, roleCode],
          )
        ).rows.map((row) => row.permission);
        const unit: string | null =
          data.orgUnitId === undefined
            ? ((before?.org_unit_id as string | null | undefined) ?? null)
            : data.orgUnitId;
        const managed: string | null =
          data.managedAppCode === undefined
            ? ((before?.managed_app_code as string | null | undefined) ?? null)
            : data.managedAppCode;
        if (
          unit &&
          !(
            await db.query('SELECT 1 FROM org_units WHERE id=$1 AND tenant_id=$2 AND active', [
              unit,
              context.tenantId,
            ])
          ).rowCount
        )
          throw new HttpError(400, 'INVALID_RELATION');
        this.ceiling(actor, context.tenantId, permissions, unit);
        if (managed) await this.assertApp(db, actor, context.tenantId, managed, 'roles:manage');
        const validFrom = data.validFrom ?? before?.valid_from ?? new Date().toISOString();
        const validUntil =
          data.validUntil === undefined ? (before?.valid_until ?? null) : data.validUntil;
        const values = [
          id ?? randomUUID(),
          context.tenantId,
          data.appCode,
          accountId,
          roleCode,
          unit,
          managed,
          active,
          validFrom,
          validUntil,
        ];
        const row = before
          ? (
              await db.query(
                'UPDATE role_bindings SET role_code=$5,org_unit_id=$6,managed_app_code=$7,active=$8,valid_from=$9,valid_until=$10,revision=revision+1 WHERE id=$1 AND tenant_id=$2 AND app_code=$3 AND account_id=$4 RETURNING *',
                values,
              )
            ).rows[0]
          : (
              await db.query(
                'INSERT INTO role_bindings(id,tenant_id,app_code,account_id,role_code,org_unit_id,managed_app_code,active,valid_from,valid_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
                values,
              )
            ).rows[0];
        if (
          active &&
          permissions.some((permission) => managementPermissions.has(permission)) &&
          !target.mfa_required
        ) {
          await db.query('UPDATE accounts SET mfa_required=true,revision=revision+1 WHERE id=$1', [
            accountId,
          ]);
          await auditMutation(
            db,
            context,
            actor,
            'account.mfa_required',
            'account',
            accountId,
            { mfaRequired: false },
            { mfaRequired: true },
            accountId,
          );
        }
        await auditMutation(
          db,
          context,
          actor,
          id ? 'binding.updated' : 'binding.created',
          'role-binding',
          String(row.id),
          before,
          row,
          accountId,
        );
        return camelRow(row);
      },
      async (db, actor) => {
        await this.assertApp(db, actor, context.tenantId, data.appCode, 'roles:manage');
      },
    );
  }
  async grants(actor: Principal, tenantId: string, appCode: string) {
    await this.assertApp(this.store.pool, actor, tenantId, appCode, 'access:manage');
    return {
      items: (
        await this.store.pool.query(
          'SELECT g.*,p.display_name,a.is_protected,a.active AS account_active FROM application_grants g JOIN accounts a ON a.id=g.account_id JOIN persons p ON p.id=a.person_id WHERE g.tenant_id=$1 AND g.app_code=$2 ORDER BY p.display_name',
          [tenantId, appCode],
        )
      ).rows.map(camelRow),
    };
  }
  async saveGrant(context: MutationContext, data: GrantInput, expectedRevision?: number) {
    return mutate(
      this.store,
      context,
      'access:manage',
      'grant.save',
      { data, expectedRevision: expectedRevision ?? null },
      async (db, actor) => {
        if (data.accountId === actor.accountId)
          throw new HttpError(403, 'SELF_ASSIGNMENT_FORBIDDEN');
        const target = (
          await db.query(
            'SELECT a.*,p.active AS person_active,m.active AS membership_active FROM accounts a JOIN persons p ON p.id=a.person_id JOIN tenant_memberships m ON m.account_id=a.id WHERE a.id=$1 AND m.tenant_id=$2',
            [data.accountId, context.tenantId],
          )
        ).rows[0];
        if (!target) throw new HttpError(404, 'TARGET_NOT_FOUND');
        if (target.is_protected) throw new HttpError(403, 'PROTECTED_ACCOUNT');
        if (data.active && (!target.active || !target.person_active || !target.membership_active))
          throw new HttpError(403, 'ACCOUNT_UNAVAILABLE');
        const application = (
          await db.query('SELECT status FROM applications WHERE code=$1', [data.appCode])
        ).rows[0];
        if (data.active && application?.status !== 'active')
          throw new HttpError(409, 'APPLICATION_NOT_ACTIVE');
        const before = (
          await db.query(
            'SELECT * FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 FOR UPDATE',
            [data.accountId, context.tenantId, data.appCode],
          )
        ).rows[0];
        if (before) revision(before, expectedRevision);
        else if (expectedRevision !== undefined && expectedRevision !== 0)
          throw new HttpError(409, 'REVISION_CONFLICT');
        const validUntil =
          data.validUntil === undefined ? (before?.valid_until ?? null) : data.validUntil;
        const row = before
          ? (
              await db.query(
                'UPDATE application_grants SET active=$4,valid_until=$5,revision=revision+1 WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 RETURNING *',
                [data.accountId, context.tenantId, data.appCode, data.active, validUntil],
              )
            ).rows[0]
          : (
              await db.query(
                'INSERT INTO application_grants(account_id,tenant_id,app_code,active,valid_until) VALUES ($1,$2,$3,$4,$5) RETURNING *',
                [data.accountId, context.tenantId, data.appCode, data.active, validUntil],
              )
            ).rows[0];
        await auditMutation(
          db,
          context,
          actor,
          data.active ? 'access.granted' : 'access.revoked',
          'application-grant',
          data.appCode + ':' + data.accountId,
          before ?? null,
          row,
          data.accountId,
        );
        return camelRow(row);
      },
      async (db, actor) => {
        await this.assertApp(db, actor, context.tenantId, data.appCode, 'access:manage');
      },
    );
  }
}
