import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagementOptions } from './routes.js';
import { DirectoryMetadata, metadataResources } from './metadata.js';
import type { MutationContext } from './mutations.js';
const uuid = { type: 'string', format: 'uuid' },
  revision = { type: 'integer', minimum: 0 },
  resource = { type: 'string', enum: [...metadataResources] };
type Route = {
  Params: { resource: string; id: string };
  Querystring: { tenantId: string; cursor?: string };
  Body: {
    tenantId: string;
    reason: string;
    expectedRevision: number;
    schemaVersion: number;
    configuration: unknown;
    answers: unknown;
    patch: unknown;
    decision: 'approved' | 'rejected' | 'withdrawn';
  };
};
export function registerMetadataRoutes(app: FastifyInstance, options: ManagementOptions) {
  if (options.appCode !== 'aio-foundation') return;
  const service = new DirectoryMetadata(options.store);
  const query = {
    type: 'object',
    required: ['tenantId'],
    additionalProperties: false,
    properties: { tenantId: uuid },
  };
  const context = async (req: FastifyRequest<Route>): Promise<MutationContext> => ({
    identity: (await options.authenticate(req)).identity,
    appCode: options.appCode,
    tenantId: req.body.tenantId,
    reason: req.body.reason,
    requestId: req.id,
    idempotencyKey: req.headers['idempotency-key'] as string,
  });
  for (const [path, handler] of [
    [
      '/api/v1/directory-config/:resource',
      async (req: FastifyRequest<Route>) =>
        service.configuration(
          (await options.authenticate(req)).principal,
          req.query.tenantId,
          req.params.resource,
        ),
    ],
    [
      '/api/v1/directory-metadata/:resource/:id',
      async (req: FastifyRequest<Route>) =>
        service.record(
          (await options.authenticate(req)).principal,
          req.query.tenantId,
          req.params.resource,
          req.params.id,
        ),
    ],
    [
      '/api/v1/directory-metadata/:resource/:id/history',
      async (req: FastifyRequest<Route>) =>
        service.history(
          (await options.authenticate(req)).principal,
          req.query.tenantId,
          req.params.resource,
          req.params.id,
          req.query.cursor,
        ),
    ],
    [
      '/api/v1/profile/me',
      async (req: FastifyRequest<Route>) => {
        const actor = (await options.authenticate(req)).principal;
        return service.record(actor, req.query.tenantId, 'people', actor.personId, true);
      },
    ],
    [
      '/api/v1/profile/proposals',
      async (req: FastifyRequest<Route>) =>
        service.proposals(
          (await options.authenticate(req)).principal,
          req.query.tenantId,
          true,
          req.query.cursor,
        ),
    ],
    [
      '/api/v1/manage/profile-proposals',
      async (req: FastifyRequest<Route>) =>
        service.proposals(
          (await options.authenticate(req)).principal,
          req.query.tenantId,
          false,
          req.query.cursor,
        ),
    ],
  ] as const)
    app.get<Route>(
      path,
      {
        schema: {
          querystring: {
            ...query,
            properties: {
              ...query.properties,
              ...(path.endsWith('/history')
                ? { cursor: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } }
                : path.endsWith('profile-proposals') || path.endsWith('/profile/proposals')
                  ? { cursor: uuid }
                  : {}),
            },
          },
          ...(path.includes(':resource')
            ? {
                params: {
                  type: 'object',
                  required: path.includes(':id') ? ['resource', 'id'] : ['resource'],
                  additionalProperties: false,
                  properties: { resource, ...(path.includes(':id') ? { id: uuid } : {}) },
                },
              }
            : {}),
        },
      },
      handler,
    );
  const write = (
    path: string,
    fields: Record<string, unknown>,
    handler: (req: FastifyRequest<Route>) => Promise<unknown>,
  ) =>
    app.post<Route>(
      path,
      {
        bodyLimit: 131072,
        schema: {
          headers: {
            type: 'object',
            required: ['idempotency-key'],
            properties: {
              'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' },
            },
          },
          ...(path.includes(':')
            ? {
                params: {
                  type: 'object',
                  required: [
                    ...(path.includes(':resource') ? ['resource'] : []),
                    ...(path.includes(':id') ? ['id'] : []),
                  ],
                  additionalProperties: false,
                  properties: {
                    ...(path.includes(':resource') ? { resource } : {}),
                    ...(path.includes(':id') ? { id: uuid } : {}),
                  },
                },
              }
            : {}),
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
      handler,
    );
  write(
    '/api/v1/directory-config/:resource',
    { configuration: { type: 'object' }, expectedRevision: revision },
    async (req) =>
      service.saveConfiguration(
        await context(req),
        req.params.resource,
        req.body.configuration,
        req.body.expectedRevision,
      ),
  );
  write(
    '/api/v1/directory-config/:resource/publish',
    { expectedRevision: { type: 'integer', minimum: 1 } },
    async (req) =>
      service.publish(await context(req), req.params.resource, req.body.expectedRevision),
  );
  write(
    '/api/v1/directory-metadata/:resource/:id',
    {
      answers: { type: 'object' },
      expectedRevision: revision,
      schemaVersion: { type: 'integer', minimum: 1 },
    },
    async (req) =>
      service.save(
        await context(req),
        req.params.resource,
        req.params.id,
        req.body.answers,
        req.body.expectedRevision,
        req.body.schemaVersion,
      ),
  );
  write(
    '/api/v1/profile/proposals',
    {
      patch: { type: 'object' },
      expectedRevision: revision,
      schemaVersion: { type: 'integer', minimum: 1 },
    },
    async (req) =>
      service.propose(
        await context(req),
        req.body.patch,
        req.body.expectedRevision,
        req.body.schemaVersion,
      ),
  );
  write(
    '/api/v1/profile/proposals/:id/review',
    {
      decision: { type: 'string', enum: ['approved', 'rejected', 'withdrawn'] },
      expectedRevision: { type: 'integer', minimum: 1 },
    },
    async (req) =>
      service.review(
        await context(req),
        req.params.id,
        req.body.decision,
        req.body.expectedRevision,
      ),
  );
}
