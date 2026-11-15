import type { Pool, PoolClient } from 'pg';
import { HttpError } from './security.js';
import { managementPermissions } from './policy.js';

type Db = Pool | PoolClient;
export type Permission = {
  tenantId: string;
  permission: string;
  managedAppCode: string | null;
  orgUnitId: string | null;
};
export type Principal = {
  accountId: string;
  personId: string;
  displayName: string;
  permissions: Permission[];
};
export type Identity = {
  issuer: string;
  subject: string;
  authenticationMethods?: string[];
  authenticatedAt?: number;
};
export class Store {
  constructor(public pool: Pool) {}
  async principal(identity: Identity, app: string, db: Db = this.pool): Promise<Principal> {
    const result = await db.query(
      'SELECT a.id AS "accountId",p.id AS "personId",p.display_name AS "displayName",a.mfa_required AS "mfaRequired",a.auth_not_before::double precision AS "authNotBefore" FROM external_identities i JOIN accounts a ON a.id=i.account_id JOIN persons p ON p.id=a.person_id WHERE i.issuer=$1 AND i.subject=$2 AND i.active AND a.active AND p.active',
      [identity.issuer, identity.subject],
    );
    const row = result.rows[0] as
      | (Omit<Principal, 'permissions'> & { mfaRequired: boolean; authNotBefore: number })
      | undefined;
    if (!row) throw new HttpError(403, 'ACCOUNT_UNAVAILABLE');
    if (
      row.authNotBefore > 0 &&
      (!Number.isInteger(identity.authenticatedAt) ||
        identity.authenticatedAt! <= row.authNotBefore)
    )
      throw new HttpError(403, 'REAUTHENTICATION_REQUIRED');
    const grant = await db.query(
      "SELECT 1 FROM application_grants g JOIN applications app ON app.code=g.app_code JOIN tenant_memberships m ON m.account_id=g.account_id AND m.tenant_id=g.tenant_id JOIN tenants t ON t.id=g.tenant_id WHERE g.account_id=$1 AND g.app_code=$2 AND g.active AND m.active AND t.active AND app.status='active' AND (g.valid_until IS NULL OR g.valid_until>now())",
      [row.accountId, app],
    );
    if (!grant.rowCount) throw new HttpError(403, 'APPLICATION_ACCESS_DENIED');
    const permissions = await this.applicationPermissions(row.accountId, app, db);
    const requiresMfa =
      row.mfaRequired || permissions.some((value) => managementPermissions.has(value.permission));
    if (
      requiresMfa &&
      (!identity.authenticationMethods?.includes('pwd') ||
        !identity.authenticationMethods.includes('otp'))
    )
      throw new HttpError(403, 'MFA_REQUIRED');
    const { mfaRequired: _mfaRequired, authNotBefore: _authNotBefore, ...person } = row;
    return { ...person, permissions };
  }
  async applicationPermissions(accountId: string, app: string, db: Db = this.pool) {
    return (
      await db.query<Permission>(
        'SELECT DISTINCT b.tenant_id AS "tenantId",p.permission,b.managed_app_code AS "managedAppCode",b.org_unit_id AS "orgUnitId" FROM role_bindings b JOIN app_roles r ON r.tenant_id=b.tenant_id AND r.app_code=b.app_code AND r.code=b.role_code JOIN role_permissions p ON p.tenant_id=b.tenant_id AND p.app_code=b.app_code AND p.role_code=b.role_code JOIN permission_catalog c ON c.app_code=p.app_code AND c.code=p.permission JOIN application_grants g ON g.account_id=b.account_id AND g.app_code=b.app_code AND g.tenant_id=b.tenant_id JOIN tenant_memberships m ON m.account_id=b.account_id AND m.tenant_id=b.tenant_id JOIN tenants t ON t.id=b.tenant_id WHERE b.account_id=$1 AND b.app_code=$2 AND b.active AND r.active AND c.active AND g.active AND m.active AND t.active AND b.valid_from<=now() AND (b.valid_until IS NULL OR b.valid_until>now()) AND (g.valid_until IS NULL OR g.valid_until>now())',
        [accountId, app],
      )
    ).rows;
  }
  require(
    principal: Principal,
    permission: string,
    tenant: string,
    targetApp?: string,
    orgUnitId?: string,
  ): void {
    if (
      !principal.permissions.some(
        (p) =>
          p.tenantId === tenant &&
          p.permission === permission &&
          (p.orgUnitId === null || (orgUnitId !== undefined && p.orgUnitId === orgUnitId)) &&
          (targetApp === undefined || p.managedAppCode === targetApp),
      )
    )
      throw new HttpError(403, 'PERMISSION_DENIED');
  }
  async applications(accountId: string) {
    const result = await this.pool.query(
      'SELECT DISTINCT app.code,app.name,app.launch_url AS "launchUrl" FROM applications app JOIN application_grants g ON g.app_code=app.code JOIN tenant_memberships m ON m.account_id=g.account_id AND m.tenant_id=g.tenant_id JOIN tenants t ON t.id=g.tenant_id WHERE g.account_id=$1 AND g.active AND m.active AND t.active AND app.status=\'active\' AND (g.valid_until IS NULL OR g.valid_until>now()) ORDER BY app.code',
      [accountId],
    );
    return result.rows;
  }
  async memberships(accountId: string, appCode: string) {
    return (
      await this.pool.query(
        'SELECT t.id,t.code,t.name FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id JOIN application_grants g ON g.account_id=m.account_id AND g.tenant_id=m.tenant_id WHERE m.account_id=$1 AND g.app_code=$2 AND m.active AND t.active AND g.active AND (g.valid_until IS NULL OR g.valid_until>now()) ORDER BY t.code',
        [accountId, appCode],
      )
    ).rows;
  }
  async assignments(personId: string) {
    return (
      await this.pool.query(
        'SELECT e.employee_code AS "employeeCode",a.tenant_id AS "tenantId",u.name AS "unitName",p.name AS "positionName",a.is_primary AS "isPrimary" FROM assignments a JOIN employments e ON e.id=a.employment_id JOIN positions p ON p.id=a.position_id JOIN org_units u ON u.id=p.org_unit_id WHERE e.person_id=$1 AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now()) AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now()) ORDER BY a.is_primary DESC',
        [personId],
      )
    ).rows;
  }
  async activeUnits(personId: string) {
    return (
      await this.pool.query<{ tenantId: string; orgUnitId: string }>(
        `SELECT DISTINCT a.tenant_id AS "tenantId",p.org_unit_id AS "orgUnitId"
      FROM assignments a JOIN employments e ON e.id=a.employment_id AND e.tenant_id=a.tenant_id
      JOIN positions p ON p.id=a.position_id AND p.tenant_id=a.tenant_id AND p.active
      JOIN org_units u ON u.id=p.org_unit_id AND u.tenant_id=p.tenant_id AND u.active
      JOIN legal_entities l ON l.id=u.legal_entity_id AND l.tenant_id=u.tenant_id AND l.active
      WHERE e.person_id=$1 AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now())
        AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now())`,
        [personId],
      )
    ).rows;
  }
  async audit(
    actor: string | null,
    subject: string | null,
    tenant: string | null,
    app: string,
    action: string,
    reason: string | null,
    requestId: string,
    db: Db = this.pool,
  ) {
    await db.query(
      'INSERT INTO audit_events(actor_account_id,subject_account_id,tenant_id,app_code,action,reason,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [actor, subject, tenant, app, action, reason, requestId],
    );
  }
  async purgeExpired() {
    for (const table of ['login_transactions', 'sessions', 'logout_receipts', 'identity_proofs']) {
      await this.pool.query('DELETE FROM ' + table + ' WHERE expires_at<now()');
    }
  }
}
