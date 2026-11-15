import type { Store, Principal } from './store.js';
import { HttpError } from './security.js';
import type {
  DirectoryQuery,
  DirectoryUnit,
  DirectoryPerson,
} from './integration-directory-proof.js';
/** Generic, application-bound Directory projections; no learning or business-role semantics. */
export async function integrationDirectory(
  store: Store,
  actor: Principal,
  appCode: string,
  query: DirectoryQuery,
) {
  const permission = actor.permissions.filter(
    (item) =>
      item.tenantId === query.tenantId &&
      item.permission === 'directory:lookup' &&
      (item.managedAppCode === null || item.managedAppCode === appCode),
  );
  if (!permission.length) throw new HttpError(403, 'PERMISSION_DENIED');
  const units = permission.some((item) => item.orgUnitId === null)
    ? null
    : permission.map((item) => item.orgUnitId!);
  if (query.orgUnitId && units && !units.includes(query.orgUnitId))
    throw new HttpError(403, 'PERMISSION_DENIED');
  const scope = query.orgUnitId ? [query.orgUnitId] : units;
  if (query.kind === 'units') {
    const result = await store.pool.query<DirectoryUnit>(
      'SELECT u.id,u.code,u.name,u.legal_entity_id AS "legalEntityId",l.name AS "legalEntityName" FROM org_units u JOIN legal_entities l ON l.id=u.legal_entity_id AND l.tenant_id=u.tenant_id AND l.active WHERE u.tenant_id=$1 AND u.active AND ($2::uuid[] IS NULL OR u.id=ANY($2)) AND ($3::uuid IS NULL OR u.id>$3) ORDER BY u.id LIMIT 101',
      [query.tenantId, scope, query.cursor ?? null],
    );
    return {
      items: result.rows.slice(0, 100),
      nextCursor: result.rows.length > 100 ? result.rows[99]!.id : null,
    };
  }
  const result = await store.pool.query<{
    accountId: string;
    personId: string;
    displayName: string;
  }>(
    `SELECT DISTINCT a.id AS "accountId",a.person_id AS "personId",p.display_name AS "displayName" FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active JOIN tenant_memberships m ON m.account_id=a.id AND m.tenant_id=$1 AND m.active JOIN tenants t ON t.id=m.tenant_id AND t.active JOIN application_grants g ON g.account_id=a.id AND g.tenant_id=m.tenant_id AND g.app_code=$2 AND g.active AND (g.valid_until IS NULL OR g.valid_until>now()) WHERE a.active AND ($3::uuid[] IS NULL OR a.id=ANY($3)) AND ($4::uuid IS NULL OR a.id>$4) AND strpos(lower(p.display_name),lower($5))>0 AND EXISTS(SELECT 1 FROM external_identities x WHERE x.account_id=a.id AND x.active) AND EXISTS(SELECT 1 FROM employments e JOIN assignments s ON s.employment_id=e.id AND s.tenant_id=e.tenant_id JOIN positions pos ON pos.id=s.position_id AND pos.tenant_id=s.tenant_id AND pos.active JOIN org_units u ON u.id=pos.org_unit_id AND u.tenant_id=pos.tenant_id AND u.active JOIN legal_entities l ON l.id=u.legal_entity_id AND l.tenant_id=u.tenant_id AND l.active WHERE e.person_id=a.person_id AND e.tenant_id=$1 AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now()) AND s.valid_from<=now() AND (s.valid_until IS NULL OR s.valid_until>now()) AND ($6::uuid[] IS NULL OR u.id=ANY($6))) ORDER BY a.id LIMIT 101`,
    [
      query.tenantId,
      appCode,
      query.accountIds ?? null,
      query.cursor ?? null,
      query.search ?? '',
      scope,
    ],
  );
  const items: DirectoryPerson[] = [];
  for (const person of result.rows.slice(0, 100)) {
    const current = await store.pool.query<{ id: string; name: string; employeeCodes: string[] }>(
      `SELECT u.id,u.name,array_agg(DISTINCT e.employee_code ORDER BY e.employee_code) AS "employeeCodes" FROM employments e JOIN assignments a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id JOIN positions p ON p.id=a.position_id AND p.tenant_id=a.tenant_id AND p.active JOIN org_units u ON u.id=p.org_unit_id AND u.tenant_id=p.tenant_id AND u.active JOIN legal_entities l ON l.id=u.legal_entity_id AND l.tenant_id=u.tenant_id AND l.active WHERE e.person_id=$1 AND e.tenant_id=$2 AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now()) AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now()) AND ($3::uuid[] IS NULL OR u.id=ANY($3)) GROUP BY u.id,u.name ORDER BY u.id`,
      [person.personId, query.tenantId, scope],
    );
    if (current.rows.length) items.push({ ...person, units: current.rows });
  }
  return { items, nextCursor: result.rows.length > 100 ? result.rows[99]!.accountId : null };
}
