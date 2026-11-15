import type { FastifyInstance } from 'fastify';
import type { ManagementOptions } from './routes.js';
import { GovernanceService } from './governance.js';
import type {
  ApplicationInput,
  BindingInput,
  GrantInput,
  PermissionInput,
  RoleInput,
} from './governance.js';
import type { MutationContext } from './mutations.js';
import { HttpError } from '../security.js';

const uuid = { type: 'string', format: 'uuid' };
const code = { type: 'string', pattern: '^[a-z][a-z0-9-]{2,50}$' };
const text = { type: 'string', minLength: 1, maxLength: 160, pattern: '\\S' };
const permissionCode = {
  type: 'string',
  pattern: '^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$',
  maxLength: 100,
};
const date = { type: 'string', format: 'date-time' };
const nullableUuid = { anyOf: [uuid, { type: 'null' }] };
const nullableDate = { anyOf: [date, { type: 'null' }] };
type Body = {
  tenantId: string;
  reason: string;
  expectedRevision?: number;
  data: Record<string, unknown>;
};
type Query = { tenantId: string; appCode?: string };
type Definition = {
  properties: Record<string, unknown>;
  create: string[];
  update: string[];
  id: Record<string, unknown>;
};

const definitions: Record<string, Definition> = {
  applications: {
    properties: {
      code,
      name: text,
      description: { type: 'string', maxLength: 500 },
      launchUrl: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
      status: { enum: ['active', 'planned', 'disabled'] },
    },
    create: ['code', 'name'],
    update: [],
    id: code,
  },
  permissions: {
    properties: { appCode: code, code: permissionCode, name: text, active: { type: 'boolean' } },
    create: ['appCode', 'code', 'name'],
    update: ['appCode'],
    id: permissionCode,
  },
  roles: {
    properties: {
      appCode: code,
      code,
      name: text,
      permissions: { type: 'array', uniqueItems: true, maxItems: 100, items: permissionCode },
      active: { type: 'boolean' },
    },
    create: ['appCode', 'code', 'name', 'permissions'],
    update: ['appCode'],
    id: code,
  },
  bindings: {
    properties: {
      appCode: code,
      accountId: uuid,
      roleCode: code,
      orgUnitId: nullableUuid,
      managedAppCode: { anyOf: [code, { type: 'null' }] },
      active: { type: 'boolean' },
      validFrom: date,
      validUntil: nullableDate,
    },
    create: ['appCode', 'accountId', 'roleCode'],
    update: ['appCode'],
    id: uuid,
  },
  grants: {
    properties: {
      appCode: code,
      accountId: uuid,
      active: { type: 'boolean' },
      validUntil: nullableDate,
    },
    create: ['appCode', 'accountId', 'active'],
    update: ['appCode', 'accountId', 'active'],
    id: uuid,
  },
};
export function registerGovernanceRoutes(app: FastifyInstance, options: ManagementOptions) {
  const service = new GovernanceService(options.store);
  for (const [resource, definition] of Object.entries(definitions)) {
    app.get<{ Querystring: Query }>(
      '/api/v1/manage/' + resource,
      {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['tenantId', ...(resource === 'applications' ? [] : ['appCode'])],
            properties: { tenantId: uuid, appCode: code },
          },
        },
      },
      async (request) => {
        const { principal } = await options.authenticate(request);
        const { tenantId, appCode } = request.query;
        switch (resource) {
          case 'applications':
            return service.applications(principal, tenantId);
          case 'permissions':
            return service.catalog(principal, tenantId, appCode!);
          case 'roles':
            return service.roles(principal, tenantId, appCode!);
          case 'bindings':
            return service.bindings(principal, tenantId, appCode!);
          default:
            return service.grants(principal, tenantId, appCode!);
        }
      },
    );
    for (const update of [false, true]) {
      app.route<{ Params: { id: string }; Body: Body }>({
        method: update ? 'PATCH' : 'POST',
        url: '/api/v1/manage/' + resource + (update ? '/:id' : ''),
        schema: {
          ...(update
            ? {
                params: {
                  type: 'object',
                  properties: { id: definition.id },
                  required: ['id'],
                  additionalProperties: false,
                },
              }
            : {}),
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
            required: ['tenantId', 'reason', 'data', ...(update ? ['expectedRevision'] : [])],
            properties: {
              tenantId: uuid,
              reason: { type: 'string', minLength: 5, maxLength: 240, pattern: '\\S' },
              expectedRevision: { type: 'integer', minimum: 0 },
              data: {
                type: 'object',
                minProperties: 1,
                additionalProperties: false,
                required: update ? definition.update : definition.create,
                properties: definition.properties,
              },
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
          const id = update ? request.params.id : undefined;
          const { data, expectedRevision } = request.body;
          switch (resource) {
            case 'applications':
              return service.saveApplication(
                context,
                data as ApplicationInput,
                id,
                expectedRevision,
              );
            case 'permissions':
              return service.savePermission(context, data as PermissionInput, id, expectedRevision);
            case 'roles':
              return service.saveRole(context, data as RoleInput, id, expectedRevision);
            case 'bindings':
              return service.saveBinding(context, data as BindingInput, id, expectedRevision);
            default: {
              if (id && id !== data.accountId) throw new HttpError(400, 'GRANT_TARGET_MISMATCH');
              return service.saveGrant(context, data as GrantInput, expectedRevision);
            }
          }
        },
      });
    }
  }
}
