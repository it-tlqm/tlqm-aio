import type { FastifyInstance } from 'fastify';
import type { ManagementOptions } from './routes.js';
import { PersonnelOperations } from './personnel-operations.js';
import type { PersonnelInput } from './personnel-operations.js';
const uuid = { type: 'string', format: 'uuid' };
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'effectiveAt', 'revokeBindingIds'],
  properties: {
    kind: { type: 'string', enum: ['onboard', 'transfer', 'offboard'] },
    effectiveAt: { type: 'string', format: 'date-time' },
    personId: uuid,
    employmentId: uuid,
    legalEntityId: uuid,
    positionId: uuid,
    displayName: { type: 'string', minLength: 1, maxLength: 160 },
    employeeCode: { type: 'string', pattern: '^[A-Za-z0-9_-]{2,48}$' },
    workflowIntakeId: uuid,
    revokeBindingIds: { type: 'array', maxItems: 500, uniqueItems: true, items: uuid },
  },
};
export function registerPersonnelRoutes(app: FastifyInstance, options: ManagementOptions) {
  if (options.appCode !== 'aio-foundation') return;
  const service = new PersonnelOperations(options.store, options.personnelIntake);
  if (options.personnelIntake) {
    const intake = options.personnelIntake;
    app.get<{ Querystring: { tenantId: string } }>(
      '/api/v1/manage/personnel/workflow-drafts',
      {
        schema: {
          querystring: {
            type: 'object',
            required: ['tenantId'],
            additionalProperties: false,
            properties: { tenantId: uuid },
          },
        },
      },
      async (request) =>
        intake.list((await options.authenticate(request)).principal, request.query.tenantId),
    );
  }
  for (const commit of [false, true])
    app.post<{
      Body: { tenantId: string; input: PersonnelInput; snapshot?: string; reason?: string };
    }>(
      '/api/v1/manage/personnel/' + (commit ? 'commit' : 'preview'),
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['tenantId', 'input', ...(commit ? ['snapshot', 'reason'] : [])],
            properties: {
              tenantId: uuid,
              input: inputSchema,
              snapshot: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              reason: { type: 'string', minLength: 5, maxLength: 240 },
            },
          },
          ...(commit
            ? {
                headers: {
                  type: 'object',
                  required: ['idempotency-key'],
                  properties: {
                    'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' },
                  },
                },
              }
            : {}),
        },
      },
      async (request) => {
        const auth = await options.authenticate(request),
          { tenantId, input, snapshot, reason } = request.body;
        return commit
          ? service.commit(
              {
                identity: auth.identity,
                appCode: options.appCode,
                tenantId,
                reason: reason!,
                requestId: request.id,
                idempotencyKey: request.headers['idempotency-key'] as string,
              },
              input,
              snapshot!,
            )
          : service.preview(auth.principal, tenantId, input);
      },
    );
}
