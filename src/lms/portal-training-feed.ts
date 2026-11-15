import { portalWorkProof, verifyPortalWorkProof } from '../portal-work-proof.js';
import type { PortalWorkQuery } from '../portal-work-proof.js';
import { LmsError, lmsEnvironment } from './security.js';
import type { LmsConfig } from './security.js';
import type { D1Database } from './types.js';
import type { LmsPrincipal } from './access.js';
import { requireLink } from './access.js';
import { TrainingNotices } from './training-notices.js';
import type { HttpSpan } from '../telemetry.js';
export async function portalTrainingFeed(
  db: D1Database,
  config: LmsConfig,
  request: Request,
  bodyText: string,
  span?: HttpSpan,
) {
  if (
    request.method !== 'POST' ||
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  let q: PortalWorkQuery;
  try {
    q = JSON.parse(bodyText) as PortalWorkQuery;
  } catch {
    throw new LmsError(400, 'INVALID_REQUEST');
  }
  const uuid = (v: unknown) =>
      typeof v === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
    environment = lmsEnvironment(config);
  if (
    !q ||
    typeof q !== 'object' ||
    Array.isArray(q) ||
    Object.keys(q).some(
      (k) => !['instanceId', 'environment', 'tenantId', 'sessionHash', 'cursor'].includes(k),
    ) ||
    q.instanceId !== config.instanceId ||
    q.environment !== environment ||
    !uuid(q.tenantId) ||
    typeof q.sessionHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(q.sessionHash) ||
    (q.cursor !== undefined && !uuid(q.cursor))
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(request.headers.get('authorization') ?? ''),
    proof = request.headers.get('x-aio-service-proof');
  if (
    !match?.[1] ||
    !proof ||
    !(await verifyPortalWorkProof(
      config.clientSecret,
      config.clientId,
      match[1],
      q,
      'request',
      proof,
    ))
  )
    throw new LmsError(403, 'INTEGRATION_SERVICE_PROOF_REQUIRED');
  span?.acceptParent(request.headers.get('traceparent'));
  let expected: { accountId: string; personId: string; subject: string } | undefined;
  const actor = async () => {
    let response: Response;
    try {
      response = await fetch(
        config.foundationUrl.replace(/\/authorize$/, '/portal-work-authorize'),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(span && { traceparent: span.header() }),
            authorization: 'Bearer ' + match[1],
            'x-aio-service-proof': await portalWorkProof(
              config.clientSecret,
              config.clientId,
              match[1]!,
              q,
              'authorize',
            ),
          },
          body: JSON.stringify(q),
          redirect: 'manual',
          signal: AbortSignal.timeout(6000),
        },
      );
    } catch {
      throw new LmsError(503, 'FOUNDATION_UNAVAILABLE');
    }
    if (!response.ok)
      throw new LmsError(
        response.status === 401 ? 401 : response.status === 403 ? 403 : 503,
        response.status === 401
          ? 'SESSION_REVOKED'
          : response.status === 403
            ? 'APPLICATION_ACCESS_DENIED'
            : 'FOUNDATION_UNAVAILABLE',
      );
    const p = (await response.json()) as LmsPrincipal;
    if (!p || typeof p !== 'object') throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
    if (
      p.version !== 1 ||
      p.appCode !== config.clientId ||
      p.issuer !== config.issuer ||
      typeof p.subject !== 'string' ||
      !uuid(p.accountId) ||
      !uuid(p.personId) ||
      typeof p.displayName !== 'string' ||
      !Array.isArray(p.tenantIds) ||
      !p.tenantIds.every(uuid) ||
      !Array.isArray(p.units) ||
      !p.units.every((u) => u && uuid(u.tenantId) && uuid(u.orgUnitId)) ||
      !Array.isArray(p.permissions) ||
      !p.permissions.every(
        (p) =>
          p &&
          uuid(p.tenantId) &&
          typeof p.permission === 'string' &&
          (p.orgUnitId === null || uuid(p.orgUnitId)),
      ) ||
      !Array.isArray(p.authenticationMethods) ||
      !p.authenticationMethods.every((v) => typeof v === 'string') ||
      !Number.isInteger(p.authenticatedAt) ||
      p.authenticatedAt < 0 ||
      p.maxAgeSeconds !== 0 ||
      !p.tenantIds.includes(q.tenantId)
    )
      throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
    if (
      expected &&
      (p.accountId !== expected.accountId ||
        p.personId !== expected.personId ||
        p.subject !== expected.subject)
    )
      throw new LmsError(401, 'SESSION_IDENTITY_CHANGED');
    expected = { accountId: p.accountId, personId: p.personId, subject: p.subject };
    const link = await requireLink(db, config, p);
    if (link.tenant_id !== q.tenantId) throw new LmsError(403, 'LMS_PERMISSION_DENIED');
    return { principal: p, link, sessionHash: null };
  };
  const denyDirectory = async (): Promise<never> => {
    throw new LmsError(403, 'LMS_PORTAL_READ_ONLY');
  };
  const service = new TrainingNotices(db, actor, { units: denyDirectory, people: denyDirectory }),
    result = await service.work();
  await actor(); // Recheck current Portal/session/source rights after aggregation.
  return { ...result, instanceId: config.instanceId, environment, maxAgeSeconds: 0 };
}
