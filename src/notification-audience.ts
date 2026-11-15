import type { Store } from './store.js';
/** Foundation-owned background eligibility, not an authenticated user or a permission grant. */
export async function notificationAudience(
  store: Store,
  appCode: string,
  permission: string,
  tenantId: string,
  accountIds: string[],
  issuer: string,
) {
  if (!accountIds.length) return [];
  if (accountIds.length > 1000) throw new Error('Notification audience exceeds bounded batch');
  const rows = (
    await store.pool.query<{ accountId: string; personId: string }>(
      `SELECT DISTINCT a.id AS "accountId",a.person_id AS "personId" FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active
    JOIN tenant_memberships m ON m.account_id=a.id AND m.tenant_id=$1 AND m.active JOIN tenants t ON t.id=m.tenant_id AND t.active
    JOIN application_grants g ON g.account_id=a.id AND g.tenant_id=m.tenant_id AND g.app_code=$2 AND g.active AND (g.valid_until IS NULL OR g.valid_until>now())
    JOIN applications app ON app.code=g.app_code AND app.status='active'
    WHERE a.active AND a.id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM external_identities x WHERE x.account_id=a.id AND x.issuer=$4 AND x.active)`,
      [tenantId, appCode, accountIds, issuer],
    )
  ).rows;
  const result: { accountId: string; personId: string; unitIds: string[] }[] = [];
  for (const row of rows) {
    const permissions = (
      await store.pool.query<{ unit: string | null }>(
        `SELECT DISTINCT b.org_unit_id AS unit FROM role_bindings b JOIN app_roles r ON r.tenant_id=b.tenant_id AND r.app_code=b.app_code AND r.code=b.role_code AND r.active JOIN role_permissions rp ON rp.tenant_id=r.tenant_id AND rp.app_code=r.app_code AND rp.role_code=r.code JOIN permission_catalog pc ON pc.app_code=rp.app_code AND pc.code=rp.permission AND pc.active WHERE b.tenant_id=$1 AND b.app_code=$2 AND b.account_id=$3 AND b.active AND b.valid_from<=now() AND (b.valid_until IS NULL OR b.valid_until>now()) AND (b.managed_app_code IS NULL OR b.managed_app_code=$2) AND rp.permission=$4`,
        [tenantId, appCode, row.accountId, permission],
      )
    ).rows;
    const units = (await store.activeUnits(row.personId)).filter(
      (u) =>
        u.tenantId === tenantId &&
        permissions.some((p) => p.unit === null || p.unit === u.orgUnitId),
    );
    if (units.length) result.push({ ...row, unitIds: units.map((u) => u.orgUnitId) });
  }
  return result;
}
