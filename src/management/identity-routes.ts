import type { FastifyInstance } from 'fastify';
import type { ManagementOptions } from './routes.js';
import type { IdentityService } from './identities.js';
import type { MutationContext } from './mutations.js';

const uuid = { type: 'string', format: 'uuid' };
const proofCode = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const revision = { type: 'integer', minimum: 1 };
const query = {
  type: 'object',
  required: ['tenantId', 'accountId'],
  additionalProperties: false,
  properties: { tenantId: uuid, accountId: uuid },
};
const writeHeaders = {
  type: 'object',
  required: ['idempotency-key'],
  properties: { 'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' } },
};
type Body = {
  tenantId: string;
  reason: string;
  accountId?: string;
  proofCode?: string;
  expectedSubject?: string;
  expectedAccountRevision?: number;
  expectedRevision?: number;
};
export function registerIdentityRoutes(
  app: FastifyInstance,
  options: ManagementOptions,
  service: IdentityService,
) {
  if (options.appCode !== 'aio-foundation') return;
  app.get<{ Querystring: { tenantId: string; cursor?: string } }>(
    '/api/v1/manage/identity-targets',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            cursor: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$' },
          },
        },
      },
    },
    async (request) => {
      const { principal } = await options.authenticate(request);
      return service.targets(principal, request.query.tenantId, request.query.cursor);
    },
  );
  app.get<{ Querystring: { tenantId: string; accountId: string } }>(
    '/api/v1/manage/identities',
    { schema: { querystring: query } },
    async (request) => {
      const { principal } = await options.authenticate(request);
      return service.list(principal, request.query.tenantId, request.query.accountId);
    },
  );
  app.post<{ Body: { tenantId: string; accountId: string; proofCode: string } }>(
    '/api/v1/manage/identities/preview',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['tenantId', 'accountId', 'proofCode'],
          additionalProperties: false,
          properties: { tenantId: uuid, accountId: uuid, proofCode },
        },
      },
    },
    async (request) => {
      const { principal } = await options.authenticate(request);
      return service.preview(
        principal,
        request.body.tenantId,
        request.body.accountId,
        request.body.proofCode,
      );
    },
  );
  const routes = [
    {
      path: '/api/v1/manage/identities/link',
      required: ['accountId', 'proofCode', 'expectedSubject', 'expectedAccountRevision'],
      properties: {
        accountId: uuid,
        proofCode,
        expectedSubject: { type: 'string', minLength: 1, maxLength: 255 },
        expectedAccountRevision: revision,
      },
    },
    {
      path: '/api/v1/manage/identities/:id/revoke',
      required: ['expectedRevision'],
      properties: { expectedRevision: revision },
    },
    {
      path: '/api/v1/manage/accounts/:id/offboard',
      required: ['expectedRevision'],
      properties: { expectedRevision: revision },
    },
  ];
  for (const route of routes)
    app.post<{ Params: { id: string }; Body: Body }>(
      route.path,
      {
        schema: {
          headers: writeHeaders,
          ...(route.path.includes(':id')
            ? {
                params: {
                  type: 'object',
                  required: ['id'],
                  additionalProperties: false,
                  properties: { id: uuid },
                },
              }
            : {}),
          body: {
            type: 'object',
            required: ['tenantId', 'reason', ...route.required],
            additionalProperties: false,
            properties: {
              tenantId: uuid,
              reason: { type: 'string', minLength: 5, maxLength: 240 },
              ...route.properties,
            },
          },
        },
      },
      async (request) => {
        const { identity } = await options.authenticate(request);
        const context: MutationContext = {
          identity,
          appCode: options.appCode,
          tenantId: request.body.tenantId,
          reason: request.body.reason,
          requestId: request.id,
          idempotencyKey: request.headers['idempotency-key'] as string,
        };
        if (route.path.endsWith('/link'))
          return service.link(context, {
            accountId: request.body.accountId!,
            proofCode: request.body.proofCode!,
            expectedSubject: request.body.expectedSubject!,
            expectedAccountRevision: request.body.expectedAccountRevision!,
          });
        if (route.path.endsWith('/revoke'))
          return service.revoke(context, request.params.id, request.body.expectedRevision!);
        return service.offboard(context, request.params.id, request.body.expectedRevision!);
      },
    );
}
