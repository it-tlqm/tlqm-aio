import type { Store, Principal } from './store.js';
import { HttpError } from './security.js';
import { integrationDirectory } from './integration-directory.js';
import type { DirectoryPerson } from './integration-directory-proof.js';
import type { IdentityQuery, IntegrationIdentity } from './integration-identity-proof.js';
/** Verified target assertion for confidential adapters; never accepted from browser fields. */
export async function integrationIdentity(
  store: Store,
  actor: Principal,
  appCode: string,
  issuer: string,
  query: IdentityQuery,
): Promise<IntegrationIdentity> {
  if (
    !actor.permissions.some(
      (p) =>
        p.tenantId === query.tenantId &&
        p.permission === 'identity:provision' &&
        p.orgUnitId === null &&
        (p.managedAppCode === null || p.managedAppCode === appCode),
    )
  )
    throw new HttpError(403, 'PERMISSION_DENIED');
  const people = await integrationDirectory(store, actor, appCode, {
    kind: 'people',
    tenantId: query.tenantId,
    orgUnitId: query.orgUnitId,
    accountIds: [query.accountId],
  });
  const target = people.items[0] as DirectoryPerson | undefined;
  if (!target) throw new HttpError(404, 'IDENTITY_TARGET_UNAVAILABLE');
  const identities = await store.pool.query<{ issuer: string; subject: string }>(
    'SELECT issuer,subject FROM external_identities WHERE account_id=$1 AND issuer=$2 AND active ORDER BY subject LIMIT 2',
    [query.accountId, issuer],
  );
  if (identities.rows.length !== 1) throw new HttpError(409, 'IDENTITY_TARGET_AMBIGUOUS');
  return {
    ...query,
    personId: target.personId,
    displayName: target.displayName,
    unitName: target.units.find((u) => u.id === query.orgUnitId)!.name,
    ...identities.rows[0]!,
  };
}
