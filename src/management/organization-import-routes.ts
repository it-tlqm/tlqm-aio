import type { FastifyInstance } from 'fastify';
import type { ManagementOptions } from './routes.js';
import { OrganizationImport } from './organization-import.js';
import { organizationTemplate } from './organization-workbook.js';
import { HttpError } from '../security.js';

const importPermissions = ['directory:read', 'directory:manage', 'people:read', 'people:manage'];
export function registerOrganizationImportRoutes(app: FastifyInstance, options: ManagementOptions) {
  if (options.appCode !== 'aio-foundation') return;
  const service = new OrganizationImport(options.store);
  app.get<{ Querystring: { tenantId: string } }>(
    '/api/v1/manage/organization-import/template',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId'],
          additionalProperties: false,
          properties: { tenantId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { principal } = await options.authenticate(request);
      for (const permission of importPermissions)
        options.store.require(principal, permission, request.query.tenantId);
      return reply
        .header('content-disposition', 'attachment; filename="tlqm-co-cau-nhan-su.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(Buffer.from(organizationTemplate()));
    },
  );
  for (const commit of [false, true])
    app.post<{ Body: { tenantId: string; file: string; snapshot?: string; reason?: string } }>(
      '/api/v1/manage/organization-import/' + (commit ? 'commit' : 'preview'),
      {
        bodyLimit: 3 * 1024 * 1024,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['tenantId', 'file', ...(commit ? ['snapshot', 'reason'] : [])],
            properties: {
              tenantId: { type: 'string', format: 'uuid' },
              file: {
                type: 'string',
                maxLength: 2800000,
                minLength: 4,
                pattern: '^[A-Za-z0-9+/]+={0,2}$',
              },
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
          body = request.body;
        const context = {
          identity: auth.identity,
          appCode: options.appCode,
          tenantId: body.tenantId,
          requestId: request.id,
          idempotencyKey: request.headers['idempotency-key'] as string,
          reason: body.reason ?? 'Xem trước nhập cơ cấu tổ chức',
        };
        const bytes = Buffer.from(body.file, 'base64');
        if (options.organizationUploadScan) {
          for (const permission of importPermissions)
            options.store.require(auth.principal, permission, body.tenantId);
          const verdict = await options.organizationUploadScan(bytes).catch(() => {
            throw new HttpError(503, 'ORGANIZATION_WORKBOOK_SCANNER_UNAVAILABLE');
          });
          if (verdict !== 'clean') throw new HttpError(422, 'ORGANIZATION_WORKBOOK_QUARANTINED');
        }
        return commit
          ? service.commit(context, bytes, body.snapshot!)
          : service.preview(context, bytes);
      },
    );
}
