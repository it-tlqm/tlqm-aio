import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FormsService, AudienceInput } from './service.js';
import type { FormsActor, FormsCommandContext } from './access.js';

const uuid = { type: 'string', format: 'uuid' };
const revision = { type: 'integer', minimum: 1 };
const nullableUuid = { anyOf: [uuid, { type: 'null' }] };
type Route = {
  Params: { formId: string; id: string };
  Querystring: { tenantId: string; own?: string; after?: string };
  Body: Record<string, unknown> & { tenantId: string; reason: string; expectedRevision: number };
};
type Options = {
  service: FormsService;
  actor: (request: FastifyRequest) => Promise<FormsActor>;
  lookups: (request: FastifyRequest, tenantId: string) => Promise<unknown>;
};
export function registerFormsRoutes(app: FastifyInstance, options: Options) {
  const service = options.service;
  function readContext(req: FastifyRequest<Route>) {
    return { tenantId: req.query.tenantId, actor: () => options.actor(req) };
  }
  function commandContext(req: FastifyRequest<Route>): FormsCommandContext {
    return {
      tenantId: req.body.tenantId,
      reason: req.body.reason,
      requestId: req.id,
      idempotencyKey:
        typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : '',
      actor: () => options.actor(req),
    };
  }
  const query = {
    type: 'object',
    additionalProperties: false,
    required: ['tenantId'],
    properties: { tenantId: uuid },
  };
  const params = (path: string) => ({
    type: 'object',
    additionalProperties: false,
    required: [...path.matchAll(/:(\w+)/g)].map((match) => match[1]),
    properties: Object.fromEntries([...path.matchAll(/:(\w+)/g)].map((match) => [match[1], uuid])),
  });
  const reads: [string, (req: FastifyRequest<Route>) => Promise<unknown>][] = [
    ['', (req) => service.list(readContext(req))],
    ['/pages', (req) => service.listPage(readContext(req), req.query.after)],
    ['/lookups', (req) => options.lookups(req, req.query.tenantId)],
    ['/groups', (req) => service.groups(readContext(req))],
    ['/:formId', (req) => service.detail(readContext(req), req.params.formId)],
    ['/:formId/report', (req) => service.report(readContext(req), req.params.formId)],
    ['/:formId/audit', (req) => service.history(readContext(req), req.params.formId)],
    [
      '/:formId/submissions',
      (req) => service.submissions(readContext(req), req.params.formId, req.query.own === 'true'),
    ],
    [
      '/:formId/submissions/page',
      (req) =>
        service.submissionsPage(
          readContext(req),
          req.params.formId,
          req.query.own === 'true',
          req.query.after,
        ),
    ],
  ];
  for (const [path, handler] of reads)
    app.get<Route>(
      '/api/v1/forms' + path,
      {
        schema: {
          querystring:
            path.includes('/submissions') || path === '/pages'
              ? {
                  ...query,
                  properties: {
                    ...query.properties,
                    own: { type: 'string', enum: ['true', 'false'] },
                    ...(path.endsWith('/page') || path === '/pages' ? { after: uuid } : {}),
                  },
                }
              : query,
          ...(path.includes(':') ? { params: params(path) } : {}),
        },
      },
      handler,
    );
  function command(
    path: string,
    fields: Record<string, unknown>,
    handler: (req: FastifyRequest<Route>) => Promise<unknown>,
    requireRevision = true,
    method: 'POST' | 'PATCH' = 'POST',
  ) {
    app.route<Route>({
      method,
      url: '/api/v1/forms' + path,
      bodyLimit: 524288,
      schema: {
        ...(path.includes(':') ? { params: params(path) } : {}),
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'tenantId',
            'reason',
            ...Object.keys(fields),
            ...(requireRevision ? ['expectedRevision'] : []),
          ],
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            ...(requireRevision ? { expectedRevision: revision } : {}),
            ...fields,
          },
        },
      },
      handler,
    });
  }
  // Only this fixed envelope is compiled by Fastify. User form schemas are interpreted in FormsService.
  const formSchema = { type: 'object', additionalProperties: true };
  command(
    '',
    {
      code: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,50}$' },
      schema: formSchema,
      orgUnitId: nullableUuid,
      maxSubmissions: { type: 'integer', minimum: 1, maximum: 100 },
    },
    (req) =>
      service.create(
        commandContext(req),
        req.body as unknown as Parameters<FormsService['create']>[1],
      ),
    false,
  );
  command('/:formId/draft', { schema: formSchema }, (req) =>
    service.saveDraft(
      commandContext(req),
      req.params.formId,
      req.body.expectedRevision,
      req.body.schema,
    ),
  );
  command('/:formId/publish', {}, (req) =>
    service.publish(commandContext(req), req.params.formId, req.body.expectedRevision),
  );
  command(
    '/:formId/status',
    { status: { type: 'string', enum: ['open', 'closed', 'archived'] } },
    (req) =>
      service.setStatus(
        commandContext(req),
        req.params.formId,
        req.body.expectedRevision,
        req.body.status as 'open' | 'closed' | 'archived',
      ),
  );
  command('/:formId/versions/:id/close', {}, (req) =>
    service.closeVersion(
      commandContext(req),
      req.params.formId,
      req.params.id,
      req.body.expectedRevision,
    ),
  );
  command(
    '/:formId/audience',
    {
      audiences: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'targetId', 'opensAt', 'closesAt'],
          properties: {
            kind: { type: 'string', enum: ['account', 'unit', 'group'] },
            targetId: uuid,
            opensAt: { type: 'string', format: 'date-time' },
            closesAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          },
        },
      },
    },
    (req) =>
      service.setAudience(
        commandContext(req),
        req.params.formId,
        req.body.expectedRevision,
        req.body.audiences as AudienceInput[],
      ),
  );
  const groupFields = {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    orgUnitId: nullableUuid,
    accountIds: { type: 'array', maxItems: 200, uniqueItems: true, items: uuid },
    active: { type: 'boolean' },
  };
  command(
    '/groups',
    groupFields,
    (req) =>
      service.saveGroup(
        commandContext(req),
        req.body as unknown as Parameters<FormsService['saveGroup']>[1],
      ),
    false,
  );
  command(
    '/groups/:id',
    groupFields,
    (req) =>
      service.saveGroup(
        commandContext(req),
        req.body as unknown as Parameters<FormsService['saveGroup']>[1],
        req.params.id,
        req.body.expectedRevision,
      ),
    true,
    'PATCH',
  );
  const submissionFields = {
    versionId: uuid,
    orgUnitId: uuid,
    answers: { type: 'object', additionalProperties: true },
    submit: { type: 'boolean' },
  };
  command(
    '/:formId/submissions',
    submissionFields,
    (req) =>
      service.saveSubmission(
        commandContext(req),
        req.params.formId,
        req.body as unknown as Parameters<FormsService['saveSubmission']>[2],
      ),
    false,
  );
  command(
    '/:formId/submissions/:id',
    submissionFields,
    (req) =>
      service.saveSubmission(
        commandContext(req),
        req.params.formId,
        req.body as unknown as Parameters<FormsService['saveSubmission']>[2],
        req.params.id,
        req.body.expectedRevision,
      ),
    true,
    'PATCH',
  );
  command('/:formId/submissions/:id/cancel', {}, (req) =>
    service.cancelDraft(
      commandContext(req),
      req.params.formId,
      req.params.id,
      req.body.expectedRevision,
    ),
  );
  app.post<Route>(
    '/api/v1/forms/:formId/versions/:id/export',
    {
      schema: {
        params: params('/:formId/versions/:id/export'),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'reason'],
          properties: { tenantId: uuid, reason: { type: 'string', minLength: 5, maxLength: 240 } },
        },
      },
    },
    async (req, reply) => {
      const result = await service.export(commandContext(req), req.params.formId, req.params.id);
      return reply
        .header('content-disposition', 'attachment; filename="forms-v' + result.version + '.csv"')
        .type('text/csv; charset=utf-8')
        .send(result.csv);
    },
  );
}
