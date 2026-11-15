import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Identity, Principal, Store } from '../store.js';
import { DirectoryService, directoryResources } from './directory.js';
import type { MutationContext } from './mutations.js';
import { registerGovernanceRoutes } from './governance-routes.js';
import { registerPersonnelRoutes } from './personnel-routes.js';
import { registerOrganizationImportRoutes } from './organization-import-routes.js';
import { registerMetadataRoutes } from './metadata-routes.js';
import { registerDirectoryTransferRoutes } from './configuration-transfer-routes.js';
import type { PersonnelWorkflowIntake } from './personnel-workflow-intakes.js';
import type { UploadScan } from '../upload-scan.js';

export type AuthResult = {
  identity: Identity;
  principal: Principal;
  sessionHash: string | undefined;
};
export type ManagementOptions = {
  store: Store;
  appCode: string;
  authenticate: (request: FastifyRequest) => Promise<AuthResult>;
  configurationTransfer?: { key: string; domain: string };
  personnelIntake?: PersonnelWorkflowIntake;
  organizationUploadScan?: UploadScan;
};
const uuid = { type: 'string', format: 'uuid' };
export function registerManagementRoutes(app: FastifyInstance, options: ManagementOptions) {
  registerGovernanceRoutes(app, options);
  registerPersonnelRoutes(app, options);
  registerOrganizationImportRoutes(app, options);
  registerMetadataRoutes(app, options);
  if (options.configurationTransfer)
    registerDirectoryTransferRoutes(
      app,
      options,
      options.configurationTransfer.key,
      options.configurationTransfer.domain,
    );
  const service = new DirectoryService(options.store);
  for (const [resource, spec] of Object.entries(directoryResources)) {
    const dataSchema = {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: Object.fromEntries(
        Object.entries(spec.fields).map(([name, value]) => [name, value.schema]),
      ),
    };
    app.get<{ Querystring: { tenantId: string; cursor?: string } }>(
      '/api/v1/manage/' + resource,
      {
        schema: {
          querystring: {
            type: 'object',
            properties: { tenantId: uuid, cursor: uuid },
            required: ['tenantId'],
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { principal } = await options.authenticate(request);
        return service.list(resource, principal, request.query.tenantId, request.query.cursor);
      },
    );
    for (const update of [false, true]) {
      app.route<{
        Params: { id: string };
        Body: {
          tenantId: string;
          reason: string;
          expectedRevision?: number;
          data: Record<string, unknown>;
        };
      }>({
        method: update ? 'PATCH' : 'POST',
        url: '/api/v1/manage/' + resource + (update ? '/:id' : ''),
        schema: {
          ...(update
            ? {
                params: {
                  type: 'object',
                  properties: { id: uuid },
                  required: ['id'],
                  additionalProperties: false,
                },
              }
            : {}),
          headers: {
            type: 'object',
            properties: {
              'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' },
            },
            required: ['idempotency-key'],
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['tenantId', 'reason', 'data', ...(update ? ['expectedRevision'] : [])],
            properties: {
              tenantId: uuid,
              reason: { type: 'string', minLength: 5, maxLength: 240, pattern: '\\S' },
              expectedRevision: { type: 'integer', minimum: 1 },
              data: { ...dataSchema, ...(!update ? { required: spec.required } : {}) },
            },
          },
        },
        handler: async (request) => {
          const auth = await options.authenticate(request);
          const context: MutationContext = {
            identity: auth.identity,
            appCode: options.appCode,
            tenantId: request.body.tenantId,
            reason: request.body.reason,
            requestId: request.id,
            idempotencyKey: request.headers['idempotency-key'] as string,
          };
          return service.save(
            resource,
            context,
            request.body.data,
            update ? request.params.id : undefined,
            request.body.expectedRevision,
          );
        },
      });
    }
  }
}
