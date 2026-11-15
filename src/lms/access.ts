import { LmsError } from './security.js';
import type { LmsConfig } from './security.js';
import type { D1Database } from './types.js';
import { subjectProof } from '../integration-proof.js';

export async function subjectUnits(
  config: LmsConfig,
  token: string,
  subject: string,
  accountIds: string[],
) {
  if (!accountIds.length) return [];
  const rows: { accountId: string; personId: string; tenantId: string; orgUnitId: string }[] = [];
  const ids = [...new Set(accountIds)];
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    let response: Response;
    try {
      response = await fetch(config.foundationUrl.replace(/\/authorize$/, '/subjects'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + token,
          'x-aio-service-proof': await subjectProof(
            config.clientSecret,
            config.clientId,
            token,
            batch,
          ),
        },
        body: JSON.stringify({ accountIds: batch }),
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new LmsError(503, 'FOUNDATION_UNAVAILABLE');
    }
    if (!response.ok)
      throw new LmsError(
        response.status === 401 || response.status === 403 ? response.status : 503,
        response.status === 401 ? 'SESSION_REVOKED' : 'FOUNDATION_UNAVAILABLE',
      );
    const body = (await response.json()) as {
      version: number;
      appCode: string;
      subject: string;
      subjects: typeof rows;
      maxAgeSeconds: number;
    };
    if (
      body.version !== 1 ||
      body.appCode !== config.clientId ||
      body.subject !== subject ||
      body.maxAgeSeconds !== 0 ||
      !Array.isArray(body.subjects) ||
      !body.subjects.every(
        (row) =>
          row &&
          batch.includes(row.accountId) &&
          typeof row.personId === 'string' &&
          typeof row.tenantId === 'string' &&
          typeof row.orgUnitId === 'string',
      )
    )
      throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
    rows.push(...body.subjects);
  }
  return rows;
}

export type LmsPrincipal = {
  version: 1;
  appCode: string;
  issuer: string;
  subject: string;
  accountId: string;
  personId: string;
  displayName: string;
  tenantIds: string[];
  units: { tenantId: string; orgUnitId: string; name?: string; code?: string }[];
  permissions: { tenantId: string; permission: string; orgUnitId: string | null }[];
  authenticatedAt: number;
  authenticationMethods: string[];
  maxAgeSeconds: 0;
};
export type LmsLink = {
  account_id: string;
  person_id: string;
  employee_id: string;
  tenant_id: string;
  org_unit_id: string;
  active: number;
  auth_not_before: number;
  name: string;
  code: string;
  department: string;
  role: 'learner' | 'admin' | 'manager';
  credential_kind?: 'legacy-retained' | 'sso-only';
};
export async function authorize(
  config: LmsConfig,
  token: string,
  subject: string,
): Promise<LmsPrincipal> {
  let response: Response;
  try {
    response = await fetch(config.foundationUrl, {
      headers: { authorization: 'Bearer ' + token },
      // workerd supports manual/follow; reject 3xx below without forwarding a bearer token.
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    throw new LmsError(503, 'FOUNDATION_UNAVAILABLE');
  }
  if (response.status === 401) throw new LmsError(401, 'SESSION_REVOKED');
  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new LmsError(
      403,
      ['MFA_REQUIRED', 'REAUTHENTICATION_REQUIRED', 'ACCOUNT_UNAVAILABLE'].includes(
        body.error ?? '',
      )
        ? body.error!
        : 'APPLICATION_ACCESS_DENIED',
    );
  }
  if (!response.ok) throw new LmsError(503, 'FOUNDATION_UNAVAILABLE');
  const principal = (await response.json()) as LmsPrincipal;
  if (
    principal.version !== 1 ||
    principal.appCode !== config.clientId ||
    principal.issuer !== config.issuer ||
    principal.subject !== subject ||
    typeof principal.accountId !== 'string' ||
    typeof principal.personId !== 'string' ||
    !Array.isArray(principal.tenantIds) ||
    !principal.tenantIds.every((value) => typeof value === 'string') ||
    !Array.isArray(principal.permissions) ||
    !principal.permissions.every(
      (entry) =>
        entry &&
        typeof entry.tenantId === 'string' &&
        typeof entry.permission === 'string' &&
        (entry.orgUnitId === null || typeof entry.orgUnitId === 'string'),
    ) ||
    !Array.isArray(principal.units) ||
    !principal.units.every(
      (entry) => entry && typeof entry.tenantId === 'string' && typeof entry.orgUnitId === 'string',
    ) ||
    !Number.isInteger(principal.authenticatedAt) ||
    principal.authenticatedAt < 0 ||
    !Array.isArray(principal.authenticationMethods) ||
    !principal.authenticationMethods.every((value) => typeof value === 'string') ||
    principal.maxAgeSeconds !== 0
  )
    throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
  return principal;
}
export async function requireLink(
  db: D1Database,
  config: LmsConfig,
  principal: LmsPrincipal,
): Promise<LmsLink> {
  const row = await db
    .prepare(
      'SELECT a.*,e.name,e.code,e.department,e.role,e.credential_kind FROM aio_external_links i JOIN aio_account_links a ON a.account_id=i.account_id JOIN employees e ON e.id=a.employee_id WHERE i.issuer=? AND i.subject=? AND i.active=1 AND a.active=1 AND e.is_active=1',
    )
    .bind(config.issuer, principal.subject)
    .first<LmsLink>();
  if (
    !row ||
    row.account_id !== principal.accountId ||
    row.person_id !== principal.personId ||
    !principal.tenantIds.includes(row.tenant_id)
  )
    throw new LmsError(403, 'LMS_IDENTITY_NOT_LINKED');
  if (principal.authenticatedAt <= row.auth_not_before)
    throw new LmsError(403, 'REAUTHENTICATION_REQUIRED');
  if (
    !principal.units.some(
      (unit) => unit.tenantId === row.tenant_id && unit.orgUnitId === row.org_unit_id,
    )
  )
    throw new LmsError(403, 'LMS_UNIT_MAPPING_STALE');
  if (!['learner', 'admin', 'manager'].includes(row.role))
    throw new LmsError(403, 'LMS_LEGACY_ROLE_INVALID');
  return row;
}
export function allowed(
  principal: LmsPrincipal,
  permission: string,
  tenantId: string,
  unitId?: string,
) {
  return (
    principal.tenantIds.includes(tenantId) &&
    principal.permissions.some(
      (entry) =>
        entry.permission === permission &&
        entry.tenantId === tenantId &&
        (entry.orgUnitId === null || entry.orgUnitId === unitId),
    )
  );
}
export function requirePermission(
  principal: LmsPrincipal,
  link: LmsLink,
  permission: 'lms:learn' | 'lms:review' | 'lms:admin',
) {
  const legacyAllows =
    link.credential_kind === 'sso-only'
      ? true
      : permission === 'lms:admin'
        ? link.role === 'admin'
        : permission === 'lms:review'
          ? ['admin', 'manager'].includes(link.role)
          : true;
  if (
    !legacyAllows ||
    !allowed(
      principal,
      permission,
      link.tenant_id,
      permission === 'lms:admin' ? undefined : link.org_unit_id,
    )
  )
    throw new LmsError(403, 'LMS_PERMISSION_DENIED');
  if (
    permission === 'lms:admin' &&
    (!principal.authenticationMethods.includes('pwd') ||
      !principal.authenticationMethods.includes('otp'))
  )
    throw new LmsError(403, 'MFA_REQUIRED');
}
