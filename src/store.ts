import type { Pool, PoolClient } from 'pg';
import { HttpError } from './security.js';

type Db = Pool | PoolClient;
export type Permission = { tenantId: string; permission: string; managedAppCode: string | null };
export type Principal = {
  accountId: string;
  personId: string;
  displayName: string;
  permissions: Permission[];
};
export type Identity = { issuer: string; subject: string };
export class Store {
  constructor(public pool: Pool) {}
  async principal(identity: Identity, app: string, db: Db = this.pool): Promise<Principal> {
    const result = await db.query(
      'SELECT a.id AS "accountId",p.id AS "personId",p.display_name AS "displayName" FROM external_identities i JOIN accounts a ON a.id=i.account_id JOIN persons p ON p.id=a.person_id WHERE i.issuer=$1 AND i.subject=$2 AND a.active AND p.active',
      [identity.issuer, identity.subject],
    );
    const row = result.rows[0] as Omit<Principal, 'permissions'> | undefined;
    if (!row) throw new HttpError(403, 'ACCOUNT_UNAVAILABLE');
    const grant = await db.query(
      "SELECT 1 FROM application_grants g JOIN applications app ON app.code=g.app_code JOIN tenant_memberships m ON m.account_id=g.account_id AND m.tenant_id=g.tenant_id JOIN tenants t ON t.id=g.tenant_id WHERE g.account_id=$1 AND g.app_code=$2 AND g.active AND m.active AND t.active AND app.status='active' AND (g.valid_until IS NULL OR g.valid_until>now())",
      [row.accountId, app],
    );
    if (!grant.rowCount) throw new HttpError(403, 'APPLICATION_ACCESS_DENIED');
    const permissions = await db.query<Permission>(
      'SELECT DISTINCT b.tenant_id AS "tenantId",p.permission,b.managed_app_code AS "managedAppCode" FROM role_bindings b JOIN role_permissions p ON p.app_code=b.app_code AND p.role_code=b.role_code JOIN application_grants g ON g.account_id=b.account_id AND g.app_code=b.app_code AND g.tenant_id=b.tenant_id JOIN tenant_memberships m ON m.account_id=b.account_id AND m.tenant_id=b.tenant_id JOIN tenants t ON t.id=b.tenant_id WHERE b.account_id=$1 AND b.app_code=$2 AND b.active AND g.active AND m.active AND t.active AND (b.valid_until IS NULL OR b.valid_until>now()) AND (g.valid_until IS NULL OR g.valid_until>now())',
      [row.accountId, app],
    );
    return { ...row, permissions: permissions.rows };
  }
  require(principal: Principal, permission: string, tenant: string, targetApp?: string): void {
    if (
      !principal.permissions.some(
        (p) =>
          p.tenantId === tenant &&
          p.permission === permission &&
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
  async assignments(personId: string) {
    return (
      await this.pool.query(
        'SELECT e.employee_code AS "employeeCode",a.tenant_id AS "tenantId",u.name AS "unitName",p.name AS "positionName",a.is_primary AS "isPrimary" FROM assignments a JOIN employments e ON e.id=a.employment_id JOIN positions p ON p.id=a.position_id JOIN org_units u ON u.id=p.org_unit_id WHERE e.person_id=$1 AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now()) AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now()) ORDER BY a.is_primary DESC',
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
  async changeGrant(
    identity: Identity,
    actorApp: string,
    change: { accountId: string; tenantId: string; appCode: string; reason: string },
    active: boolean,
    requestId: string,
  ) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // Serialize grant changes, including revalidation of the acting administrator.
      await db.query('SELECT pg_advisory_xact_lock(71092027)');
      const actor = await this.principal(identity, actorApp, db);
      this.require(actor, 'access:manage', change.tenantId, change.appCode);
      const target = await db.query(
        'SELECT 1 FROM tenant_memberships m JOIN accounts a ON a.id=m.account_id JOIN persons p ON p.id=a.person_id WHERE m.account_id=$1 AND m.tenant_id=$2 AND m.active AND a.active AND p.active',
        [change.accountId, change.tenantId],
      );
      if (!target.rowCount) throw new HttpError(404, 'TARGET_NOT_FOUND');
      const app = await db.query("SELECT 1 FROM applications WHERE code=$1 AND status='active'", [
        change.appCode,
      ]);
      if (!app.rowCount) throw new HttpError(400, 'APPLICATION_NOT_ACTIVE');
      await db.query(
        'INSERT INTO application_grants(account_id,tenant_id,app_code,active) VALUES ($1,$2,$3,$4) ON CONFLICT(account_id,tenant_id,app_code) DO UPDATE SET active=EXCLUDED.active,valid_until=NULL',
        [change.accountId, change.tenantId, change.appCode, active],
      );
      await this.audit(
        actor.accountId,
        change.accountId,
        change.tenantId,
        change.appCode,
        active ? 'access.granted' : 'access.revoked',
        change.reason,
        requestId,
        db,
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  async purgeExpired() {
    for (const table of ['login_transactions', 'sessions', 'logout_receipts']) {
      await this.pool.query('DELETE FROM ' + table + ' WHERE expires_at<now()');
    }
  }
}
