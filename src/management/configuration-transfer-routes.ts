import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagementOptions } from './routes.js';
import { directoryTransfer } from './configuration-transfer.js';
import type { ConfigurationKind } from '../configuration-package.js';
type Route = {
  Params: {
    kind: ConfigurationKind;
    target: string;
    action: 'export' | 'options' | 'preview' | 'apply';
  };
  Body: {
    tenantId: string;
    reason: string;
    package?: unknown;
    mappings?: unknown;
    review?: unknown;
  };
};
export function registerDirectoryTransferRoutes(
  app: FastifyInstance,
  options: ManagementOptions,
  key: string,
  domain: string,
) {
  if (options.appCode !== 'aio-foundation') return;
  for (const action of ['export', 'options', 'preview', 'apply'] as const) {
    const fields =
      action === 'preview'
        ? { package: { type: 'object' }, mappings: { type: 'array', maxItems: 1000 } }
        : action === 'apply'
          ? { review: { type: 'object' } }
          : {};
    app.post<Route>(
      '/api/v1/configuration-transfer/:kind/:target/' + action,
      {
        bodyLimit: 524288,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'target'],
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'directory-people',
                  'directory-org-units',
                  'directory-job-titles',
                  'directory-positions',
                ],
              },
              target: { type: 'string', const: 'current' },
            },
          },
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
              tenantId: { type: 'string', format: 'uuid' },
              reason: { type: 'string', minLength: 5, maxLength: 240 },
              ...fields,
            },
          },
        },
      },
      async (req: FastifyRequest<Route>) => {
        const auth = await options.authenticate(req),
          c = {
            identity: auth.identity,
            appCode: options.appCode,
            tenantId: req.body.tenantId,
            reason: req.body.reason,
            requestId: req.id,
            idempotencyKey: req.headers['idempotency-key'] as string,
          },
          service = directoryTransfer(
            options.store,
            c,
            req.params.kind,
            req.params.target,
            key,
            domain,
          );
        return action === 'export'
          ? service.export()
          : action === 'options'
            ? service.options()
            : action === 'preview'
              ? service.preview(req.body.package, req.body.mappings)
              : service.apply(req.body.review);
      },
    );
  }
}
