import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WorkflowsService } from './service.js';
import type { WorkflowActor } from './access.js';
import { workflowTransfer } from './configuration-transfer.js';
import type { WorkflowConfigurationLookups } from './configuration-transfer.js';
type Route = {
  Params: { target: string };
  Body: {
    tenantId: string;
    reason: string;
    package?: unknown;
    mappings?: unknown;
    review?: unknown;
  };
};
export function registerWorkflowTransferRoutes(
  app: FastifyInstance,
  options: {
    service: WorkflowsService;
    actor: (req: FastifyRequest) => Promise<WorkflowActor>;
    lookups: (req: FastifyRequest, tenant: string) => Promise<unknown>;
  },
  key: string,
  domain: string,
) {
  for (const action of ['export', 'options', 'preview', 'apply'] as const) {
    const fields =
      action === 'preview'
        ? { package: { type: 'object' }, mappings: { type: 'array', maxItems: 1000 } }
        : action === 'apply'
          ? { review: { type: 'object' } }
          : {};
    app.post<Route>(
      '/api/v1/configuration-transfer/workflow/:target/' + action,
      {
        bodyLimit: 524288,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['target'],
            properties: { target: { type: 'string', format: 'uuid' } },
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
        const c = {
            tenantId: req.body.tenantId,
            actor: () => options.actor(req),
            reason: req.body.reason,
            requestId: req.id,
            idempotencyKey: req.headers['idempotency-key'] as string,
          },
          service = workflowTransfer(
            options.service,
            c,
            req.params.target,
            key,
            domain,
            async () => (await options.lookups(req, c.tenantId)) as WorkflowConfigurationLookups,
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
