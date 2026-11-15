import type { FastifyInstance } from 'fastify';
import type { AppRuntime } from './config.js';
import type { Store } from './store.js';
import { HttpError } from './security.js';
import { OidcClient } from './oidc.js';
import type { PortalWorkQuery } from './portal-work-proof.js';
import { verifyPortalWorkProof } from './portal-work-proof.js';
import { bffSpan } from './bff-telemetry.js';
/** Source asks Foundation to recheck the original Portal session/token and LMS rights on every read. */
export function registerPortalWorkAccess(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  test: boolean,
) {
  const lms = runtime.clients.find(
      (c) => c.code === 'aio-lms-sandbox' && c.kind === 'external-application',
    ),
    portal = runtime.clients.find((c) => c.code === 'aio-foundation');
  if (!lms || !portal) return;
  let verifier: Promise<OidcClient> | undefined;
  const uuid = { type: 'string', format: 'uuid' };
  app.post<{ Body: PortalWorkQuery }>(
    '/api/v1/integrations/aio-lms-sandbox/portal-work-authorize',
    {
      bodyLimit: 4096,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['instanceId', 'environment', 'tenantId', 'sessionHash'],
          properties: {
            instanceId: uuid,
            environment: { type: 'string', enum: ['local', 'test', 'staging'] },
            tenantId: uuid,
            sessionHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            cursor: uuid,
          },
        },
      },
    },
    async (req) => {
      const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization ?? ''),
        proof = req.headers['x-aio-service-proof'],
        q = req.body;
      if (!match?.[1]) throw new HttpError(401, 'AUTHENTICATION_REQUIRED');
      if (
        q.instanceId !== runtime.instanceId ||
        q.environment !== (test ? 'test' : runtime.mode) ||
        typeof proof !== 'string' ||
        !(await verifyPortalWorkProof(lms.clientSecret, lms.code, match[1], q, 'authorize', proof))
      )
        throw new HttpError(403, 'INTEGRATION_SERVICE_PROOF_REQUIRED');
      bffSpan(req)?.acceptParent(req.headers.traceparent);
      verifier ??= OidcClient.create(runtime, portal).catch(() => {
        verifier = undefined;
        throw new HttpError(503, 'IDENTITY_UNAVAILABLE');
      });
      const identity = await (await verifier).access(match[1]),
        portalActor = await store.principal(identity, portal.code);
      if (
        !(
          await store.pool.query(
            'SELECT 1 FROM sessions WHERE hash=$1 AND app_code=$2 AND account_id=$3 AND issuer=$4 AND subject=$5 AND expires_at>now() AND absolute_expires_at>now()',
            [q.sessionHash, portal.code, portalActor.accountId, identity.issuer, identity.subject],
          )
        ).rowCount
      )
        throw new HttpError(401, 'SESSION_EXPIRED');
      const principal = await store.principal(identity, lms.code),
        tenantIds = (await store.memberships(principal.accountId, lms.code)).map((t) =>
          String(t.id),
        );
      if (
        !tenantIds.includes(q.tenantId) ||
        !(await store.memberships(portalActor.accountId, portal.code)).some(
          (t) => t.id === q.tenantId,
        )
      )
        throw new HttpError(403, 'PERMISSION_DENIED');
      const units = (await store.activeUnits(principal.personId)).filter((u) =>
          tenantIds.includes(u.tenantId),
        ),
        names = (
          await store.pool.query('SELECT id,name,code FROM org_units WHERE id=ANY($1::uuid[])', [
            units.map((u) => u.orgUnitId),
          ])
        ).rows;
      return {
        version: 1,
        appCode: lms.code,
        issuer: identity.issuer,
        subject: identity.subject,
        accountId: principal.accountId,
        personId: principal.personId,
        displayName: principal.displayName,
        tenantIds,
        units: units.map((u) => ({
          ...u,
          name: names.find((n) => n.id === u.orgUnitId)?.name ?? '',
          code: names.find((n) => n.id === u.orgUnitId)?.code ?? '',
        })),
        permissions: principal.permissions.filter(
          (p) => p.managedAppCode === null || p.managedAppCode === lms.code,
        ),
        authenticatedAt: identity.authenticatedAt,
        authenticationMethods: identity.authenticationMethods ?? [],
        maxAgeSeconds: 0,
      };
    },
  );
}
