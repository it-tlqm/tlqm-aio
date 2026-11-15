import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthResult } from './routes.js';
import type { MutationContext } from './mutations.js';
import type { ProfileWorkflows } from './profile-workflows.js';
const uuid = { type: 'string', format: 'uuid' };
type Route = {
  Params: { id: string };
  Querystring: { tenantId: string; definitionId: string; unitId: string; versionId: string };
  Body: {
    tenantId: string;
    reason: string;
    expectedRevision: number;
    definitionId: string;
    versionId: string;
    unitId: string;
    answers: unknown;
    selections: unknown;
  };
};
export function registerProfileWorkflowRoutes(
  app: FastifyInstance,
  service: ProfileWorkflows,
  authenticate: (req: FastifyRequest) => Promise<AuthResult>,
  baseUrl: string,
) {
  const context = async (req: FastifyRequest<Route>): Promise<MutationContext> => ({
    identity: (await authenticate(req)).identity,
    appCode: 'aio-foundation',
    tenantId: req.method === 'GET' ? req.query.tenantId : req.body.tenantId,
    reason: req.method === 'GET' ? 'Xem liên kết đề xuất nhân sự' : req.body.reason,
    requestId: req.id,
    idempotencyKey: req.headers['idempotency-key'] as string,
  });
  const params = {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: uuid },
  };
  for (const kind of ['choices', 'selections', ':id'] as const) {
    app.get<Route>(
      '/api/v1/profile-workflows/' + kind,
      {
        schema: {
          ...(kind === ':id' ? { params } : {}),
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: [
              'tenantId',
              ...(kind === 'selections' ? ['definitionId', 'unitId', 'versionId'] : []),
            ],
            properties: {
              tenantId: uuid,
              ...(kind === 'selections'
                ? { definitionId: uuid, unitId: uuid, versionId: uuid }
                : {}),
            },
          },
        },
      },
      async (req) => {
        const c = await context(req);
        if (kind === 'choices') return service.choices(c);
        if (kind === 'selections')
          return service.selections(
            c,
            req.query.definitionId,
            req.query.unitId,
            req.query.versionId,
          );
        return { ...(await service.state(c, req.params.id)), baseUrl };
      },
    );
  }
  for (const kind of ['send', 'retry', 'apply'] as const) {
    const fields =
      kind === 'send'
        ? {
            expectedRevision: { type: 'integer', minimum: 1 },
            definitionId: uuid,
            versionId: uuid,
            unitId: uuid,
            answers: { type: 'object' },
            selections: { type: 'object' },
          }
        : kind === 'apply'
          ? { expectedRevision: { type: 'integer', minimum: 1 } }
          : {};
    app.post<Route>(
      '/api/v1/profile-workflows/:id/' + kind,
      {
        bodyLimit: 131072,
        schema: {
          params,
          headers: {
            type: 'object',
            required: ['idempotency-key'],
            properties: {
              'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' },
            },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['tenantId', 'reason', ...Object.keys(fields)],
            properties: {
              tenantId: uuid,
              reason: { type: 'string', minLength: 5, maxLength: 240 },
              ...fields,
            },
          },
        },
      },
      async (req) => {
        const c = await context(req);
        if (kind === 'send')
          return service.send(c, req.params.id, {
            expectedRevision: req.body.expectedRevision,
            definitionId: req.body.definitionId,
            versionId: req.body.versionId,
            unitId: req.body.unitId,
            answers: req.body.answers,
            selections: req.body.selections,
          });
        return kind === 'retry'
          ? service.retry(c, req.params.id)
          : service.apply(c, req.params.id, req.body.expectedRevision);
      },
    );
  }
}
