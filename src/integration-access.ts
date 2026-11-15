import type { FastifyInstance } from 'fastify';
import type { AppRuntime } from './config.js';
import type { Store } from './store.js';
import { HttpError } from './security.js';
import { OidcClient } from './oidc.js';
import { verifySubjectProof } from './integration-proof.js';
import { verifyDirectoryProof } from './integration-directory-proof.js';
import type { DirectoryQuery } from './integration-directory-proof.js';
import { integrationDirectory } from './integration-directory.js';
import { verifyIdentityProof } from './integration-identity-proof.js';
import type { IdentityQuery } from './integration-identity-proof.js';
import { integrationIdentity } from './integration-identity.js';
import {
  trainingIntakeEnvelope,
  trainingIntakeReferenceKey,
  verifyTrainingIntake,
} from './lms-intake-proof.js';
import type { WorkflowsService } from './workflows/service.js';

/** A distinct endpoint for external application tokens; /api/v1/me retains its own audience. */
export function registerIntegrationAccess(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  workflowSource?: Pick<WorkflowsService, 'moduleIntakeDraft'>,
  test = false,
) {
  const verifiers = new Map<string, Promise<OidcClient>>();
  async function authenticate(appCode: string, authorization: string | undefined) {
    const client = runtime.clients.find(
      (client) => client.code === appCode && client.kind === 'external-application',
    );
    if (!client) throw new HttpError(404, 'INTEGRATION_NOT_REGISTERED');
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization ?? '');
    if (!match?.[1]) throw new HttpError(401, 'AUTHENTICATION_REQUIRED');
    let verifier = verifiers.get(client.code);
    if (!verifier) {
      verifier = OidcClient.create(runtime, client).catch(() => {
        verifiers.delete(client.code);
        throw new HttpError(503, 'IDENTITY_UNAVAILABLE');
      });
      verifiers.set(client.code, verifier);
    }
    const identity = await (await verifier).access(match[1]);
    const principal = await store.principal(identity, client.code);
    return { client, identity, principal, token: match[1] };
  }
  if (workflowSource)
    app.post(
      '/api/v1/integrations/aio-lms-sandbox/training-intake',
      { bodyLimit: 4096 },
      async (request) => {
        const envelope = request.body;
        if (!trainingIntakeEnvelope(envelope))
          throw new HttpError(400, 'LMS_TRAINING_INTAKE_INVALID');
        const { client, identity, principal, token } = await authenticate(
          'aio-lms-sandbox',
          request.headers.authorization,
        );
        const proof = request.headers['x-aio-service-proof'];
        if (
          typeof proof !== 'string' ||
          envelope.instanceId !== runtime.instanceId ||
          envelope.environment !== (test ? 'test' : runtime.mode) ||
          !(await verifyTrainingIntake(
            client.clientSecret,
            client.clientId,
            'source',
            envelope,
            proof,
            token,
          ))
        )
          throw new HttpError(403, 'INTEGRATION_SERVICE_PROOF_REQUIRED');
        const ref = envelope.reference;
        store.require(
          {
            ...principal,
            permissions: principal.permissions.filter(
              (p) => p.managedAppCode === null || p.managedAppCode === client.code,
            ),
          },
          'lms:admin',
          ref.tenantId,
        );
        if (
          !identity.authenticationMethods?.includes('pwd') ||
          !identity.authenticationMethods.includes('otp')
        )
          throw new HttpError(403, 'MFA_REQUIRED');
        if (ref.accountId !== principal.accountId || ref.personId !== principal.personId)
          throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
        const draft = await workflowSource.moduleIntakeDraft(
          ref.tenantId,
          ref.id,
          principal.accountId,
          principal.personId,
          'lms-training',
        );
        if (
          draft.kind !== 'lms-training' ||
          JSON.stringify(trainingIntakeReferenceKey(ref)) !==
            JSON.stringify(trainingIntakeReferenceKey({ ...draft, kind: draft.kind }))
        )
          throw new HttpError(409, 'WORKFLOW_INTAKE_REFERENCE_CONFLICT');
        return {
          id: draft.id,
          unitId: draft.unitId,
          title: draft.values.title || draft.title,
          summary: draft.values.summary,
        };
      },
    );
  app.post<{ Params: { appCode: string }; Body: IdentityQuery }>(
    '/api/v1/integrations/:appCode/identity',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'accountId', 'orgUnitId'],
          properties: {
            tenantId: { type: 'string', format: 'uuid' },
            accountId: { type: 'string', format: 'uuid' },
            orgUnitId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const { client, identity, principal, token } = await authenticate(
        request.params.appCode,
        request.headers.authorization,
      );
      const proof = request.headers['x-aio-service-proof'];
      if (
        typeof proof !== 'string' ||
        !(await verifyIdentityProof(client.clientSecret, client.code, token, request.body, proof))
      )
        throw new HttpError(403, 'INTEGRATION_SERVICE_PROOF_REQUIRED');
      if (
        !identity.authenticationMethods?.includes('pwd') ||
        !identity.authenticationMethods.includes('otp')
      )
        throw new HttpError(403, 'MFA_REQUIRED');
      if (
        !(await store.memberships(principal.accountId, client.code)).some(
          (row) => row.id === request.body.tenantId,
        )
      )
        throw new HttpError(403, 'PERMISSION_DENIED');
      const target = await integrationIdentity(
        store,
        principal,
        client.code,
        runtime.issuer,
        request.body,
      );
      return {
        version: 1,
        appCode: client.code,
        subject: identity.subject,
        maxAgeSeconds: 0,
        target,
      };
    },
  );
  app.post<{ Params: { appCode: string }; Body: DirectoryQuery }>(
    '/api/v1/integrations/:appCode/directory',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'tenantId'],
          properties: {
            kind: { enum: ['units', 'people'] },
            tenantId: { type: 'string', format: 'uuid' },
            orgUnitId: { type: 'string', format: 'uuid' },
            cursor: { type: 'string', format: 'uuid' },
            search: { type: 'string', maxLength: 160 },
            accountIds: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              uniqueItems: true,
              items: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
    },
    async (request) => {
      const { client, identity, principal, token } = await authenticate(
        request.params.appCode,
        request.headers.authorization,
      );
      const proof = request.headers['x-aio-service-proof'];
      if (
        typeof proof !== 'string' ||
        !(await verifyDirectoryProof(client.clientSecret, client.code, token, request.body, proof))
      )
        throw new HttpError(403, 'INTEGRATION_SERVICE_PROOF_REQUIRED');
      const memberships = await store.memberships(principal.accountId, client.code);
      if (!memberships.some((row) => row.id === request.body.tenantId))
        throw new HttpError(403, 'PERMISSION_DENIED');
      const result = await integrationDirectory(store, principal, client.code, request.body);
      return {
        version: 1,
        appCode: client.code,
        subject: identity.subject,
        tenantId: request.body.tenantId,
        kind: request.body.kind,
        maxAgeSeconds: 0,
        ...result,
      };
    },
  );
  app.get<{ Params: { appCode: string } }>(
    '/api/v1/integrations/:appCode/authorize',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['appCode'],
          properties: {
            appCode: { type: 'string', pattern: '^aio-[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 51 },
          },
        },
      },
    },
    async (request) => {
      const { client, identity, principal } = await authenticate(
        request.params.appCode,
        request.headers.authorization,
      );
      const memberships = await store.memberships(principal.accountId, client.code);
      const tenantIds = memberships.map((item) => item.id as string);
      const units = (await store.activeUnits(principal.personId)).filter((unit) =>
        tenantIds.includes(unit.tenantId),
      );
      const ownUnits = await store.pool.query<{ id: string; name: string; code: string }>(
        'SELECT id,name,code FROM org_units WHERE id=ANY($1::uuid[])',
        [units.map((unit) => unit.orgUnitId)],
      );
      return {
        version: 1,
        appCode: client.code,
        issuer: identity.issuer,
        subject: identity.subject,
        accountId: principal.accountId,
        personId: principal.personId,
        displayName: principal.displayName,
        tenantIds,
        units: units.map((unit) => ({
          ...unit,
          name: ownUnits.rows.find((row) => row.id === unit.orgUnitId)?.name ?? '',
          code: ownUnits.rows.find((row) => row.id === unit.orgUnitId)?.code ?? '',
        })),
        permissions: principal.permissions.filter(
          (permission) =>
            permission.managedAppCode === null || permission.managedAppCode === client.code,
        ),
        authenticatedAt: identity.authenticatedAt ?? null,
        authenticationMethods: identity.authenticationMethods ?? [],
        checkedAt: new Date().toISOString(),
        maxAgeSeconds: 0,
      };
    },
  );
  app.post<{ Params: { appCode: string }; Body: { accountIds: string[] } }>(
    '/api/v1/integrations/:appCode/subjects',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['accountIds'],
          properties: {
            accountIds: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              uniqueItems: true,
              items: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
    },
    async (request) => {
      const { client, identity, principal, token } = await authenticate(
        request.params.appCode,
        request.headers.authorization,
      );
      const proof = request.headers['x-aio-service-proof'];
      if (
        typeof proof !== 'string' ||
        !(await verifySubjectProof(
          client.clientSecret,
          client.code,
          token,
          request.body.accountIds,
          proof,
        ))
      )
        throw new HttpError(403, 'INTEGRATION_SERVICE_PROOF_REQUIRED');
      const tenantIds = (await store.memberships(principal.accountId, client.code)).map(
        (row) => row.id as string,
      );
      // Generic Directory eligibility only. Application backend still enforces its business permissions.
      const subjects = await store.pool.query<{
        accountId: string;
        personId: string;
        tenantId: string;
      }>(
        `SELECT DISTINCT a.id AS "accountId",a.person_id AS "personId",m.tenant_id AS "tenantId" FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active JOIN tenant_memberships m ON m.account_id=a.id AND m.active JOIN tenants t ON t.id=m.tenant_id AND t.active JOIN application_grants g ON g.account_id=a.id AND g.tenant_id=m.tenant_id AND g.app_code=$2 AND g.active AND (g.valid_until IS NULL OR g.valid_until>now()) WHERE a.id=ANY($1::uuid[]) AND a.active AND m.tenant_id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM external_identities i WHERE i.account_id=a.id AND i.active)`,
        [request.body.accountIds, client.code, tenantIds],
      );
      const rows = [];
      for (const subject of subjects.rows)
        for (const unit of await store.activeUnits(subject.personId))
          if (unit.tenantId === subject.tenantId)
            rows.push({ ...subject, orgUnitId: unit.orgUnitId });
      return {
        version: 1,
        appCode: client.code,
        subject: identity.subject,
        subjects: rows,
        maxAgeSeconds: 0,
      };
    },
  );
}
