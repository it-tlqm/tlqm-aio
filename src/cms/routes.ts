import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CmsService } from './service.js';
import type { CmsActor, CmsCommand, CmsContext } from './access.js';

type Options = {
  service: CmsService;
  actor: (request: FastifyRequest) => Promise<CmsActor>;
};
type RequestShape = {
  Params: { id: string };
  Querystring: {
    tenantId: string;
    websiteId?: string;
    path?: string;
    locale?: string;
    websiteCode?: string;
    contentTypeCode?: string;
    code?: string;
  };
  Body: Record<string, unknown> & { tenantId: string; reason: string; expectedRevision?: number };
};
type Request = FastifyRequest<RequestShape>;
const uuid = { type: 'string', format: 'uuid' };
const commandHeaders = {
  type: 'object',
  required: ['idempotency-key'],
  properties: { 'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' } },
};
const readContext = (request: Request, actor: () => Promise<CmsActor>): CmsContext => ({
  tenantId: request.query.tenantId,
  actor,
});
const commandContext = (request: Request, actor: () => Promise<CmsActor>): CmsCommand => ({
  tenantId: request.body.tenantId,
  actor,
  reason: request.body.reason,
  requestId: request.id,
  idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
});

export function registerCmsRoutes(app: FastifyInstance, options: Options) {
  app.get<RequestShape>(
    '/api/v1/cms/websites',
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
    (request) => options.service.websites(readContext(request, () => options.actor(request))),
  );

  app.post<RequestShape>(
    '/api/v1/cms/websites',
    {
      schema: {
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'code', 'name', 'defaultLocale', 'locales'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            code: { type: 'string' },
            name: { type: 'string' },
            defaultLocale: { type: 'string' },
            locales: { type: 'array' },
          },
        },
      },
    },
    (request) =>
      options.service.createWebsite(
        commandContext(request, () => options.actor(request)),
        request.body,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/websites/:id/status',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision', 'status'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: ['draft', 'active', 'disabled'] },
          },
        },
      },
    },
    (request) =>
      options.service.setWebsiteStatus(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        request.body.expectedRevision!,
        request.body.status as 'draft' | 'active' | 'disabled',
      ),
  );

  app.get<RequestShape>(
    '/api/v1/cms/domains',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId'],
          additionalProperties: false,
          properties: { tenantId: uuid, websiteId: uuid },
        },
      },
    },
    (request) =>
      options.service.domains(
        readContext(request, () => options.actor(request)),
        request.query.websiteId,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/domains',
    {
      schema: {
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'websiteId', 'host', 'environment'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            websiteId: uuid,
            host: { type: 'string' },
            environment: { type: 'string' },
          },
        },
      },
    },
    (request) =>
      options.service.addDomain(
        commandContext(request, () => options.actor(request)),
        request.body,
      ),
  );

  app.get<RequestShape>(
    '/api/v1/cms/pages',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId', 'websiteId'],
          additionalProperties: false,
          properties: { tenantId: uuid, websiteId: uuid },
        },
      },
    },
    (request) =>
      options.service.pages(
        readContext(request, () => options.actor(request)),
        request.query.websiteId!,
      ),
  );

  app.get<RequestShape>(
    '/api/v1/cms/pages/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        querystring: {
          type: 'object',
          required: ['tenantId'],
          additionalProperties: false,
          properties: { tenantId: uuid },
        },
      },
    },
    (request) =>
      options.service.pageDetail(
        readContext(request, () => options.actor(request)),
        request.params.id,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/pages',
    {
      schema: {
        headers: commandHeaders,
        body: {
          type: 'object',
          required: [
            'tenantId',
            'reason',
            'websiteId',
            'code',
            'path',
            'kind',
            'locale',
            'document',
          ],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            websiteId: uuid,
            code: { type: 'string' },
            path: { type: 'string' },
            kind: { type: 'string' },
            locale: { type: 'string' },
            document: { type: 'object' },
          },
        },
      },
    },
    (request) =>
      options.service.createPage(
        commandContext(request, () => options.actor(request)),
        request.body as never,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/pages/:id/draft',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision', 'locale', 'document'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
            locale: { type: 'string' },
            document: { type: 'object' },
          },
        },
      },
    },
    (request) =>
      options.service.saveDraft(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        request.body.expectedRevision!,
        String(request.body.locale),
        request.body.document,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/pages/:id/publish',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision', 'locale'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
            locale: { type: 'string' },
          },
        },
      },
    },
    (request) =>
      options.service.publish(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        request.body.expectedRevision!,
        String(request.body.locale),
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/pages/:id/review',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision', 'locale'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
            locale: { type: 'string' },
          },
        },
      },
    },
    (request) =>
      options.service.submitPageReview(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        request.body.expectedRevision!,
        String(request.body.locale),
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/pages/:id/rollback',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision', 'locale', 'targetRevisionId'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
            locale: { type: 'string' },
            targetRevisionId: uuid,
          },
        },
      },
    },
    (request) =>
      options.service.rollbackPage(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        String(request.body.targetRevisionId),
        request.body.expectedRevision!,
        String(request.body.locale),
      ),
  );

  app.get<RequestShape>(
    '/api/v1/cms/content-types',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId', 'websiteId'],
          additionalProperties: false,
          properties: { tenantId: uuid, websiteId: uuid },
        },
      },
    },
    (request) =>
      options.service.contentTypes(
        readContext(request, () => options.actor(request)),
        request.query.websiteId!,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/content-types',
    {
      schema: {
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'websiteId', 'code', 'name', 'schema'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            websiteId: uuid,
            code: { type: 'string' },
            name: { type: 'string' },
            schema: { type: 'object' },
          },
        },
      },
    },
    (request) =>
      options.service.createContentType(
        commandContext(request, () => options.actor(request)),
        request.body,
      ),
  );

  app.get<RequestShape>(
    '/api/v1/cms/content-entries',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId', 'websiteId'],
          additionalProperties: false,
          properties: { tenantId: uuid, websiteId: uuid, contentTypeCode: { type: 'string' } },
        },
      },
    },
    (request) =>
      options.service.contentEntries(
        readContext(request, () => options.actor(request)),
        request.query.websiteId!,
        request.query.contentTypeCode,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/content-entries',
    {
      schema: {
        headers: commandHeaders,
        body: {
          type: 'object',
          required: [
            'tenantId',
            'reason',
            'websiteId',
            'contentTypeCode',
            'code',
            'locale',
            'document',
          ],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            websiteId: uuid,
            contentTypeCode: { type: 'string' },
            code: { type: 'string' },
            locale: { type: 'string' },
            document: { type: 'object' },
          },
        },
      },
    },
    (request) =>
      options.service.createContentEntry(
        commandContext(request, () => options.actor(request)),
        request.body as never,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/content-entries/:id/draft',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision', 'locale', 'document'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
            locale: { type: 'string' },
            document: { type: 'object' },
          },
        },
      },
    },
    (request) =>
      options.service.saveContentDraft(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        request.body.expectedRevision!,
        String(request.body.locale),
        request.body.document,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/content-entries/:id/publish',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision', 'locale'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
            locale: { type: 'string' },
          },
        },
      },
    },
    (request) =>
      options.service.publishContent(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        request.body.expectedRevision!,
        String(request.body.locale),
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/content-entries/:id/review',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision', 'locale'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
            locale: { type: 'string' },
          },
        },
      },
    },
    (request) =>
      options.service.submitContentReview(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        request.body.expectedRevision!,
        String(request.body.locale),
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/content-entries/:id/rollback',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision', 'locale', 'targetRevisionId'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
            locale: { type: 'string' },
            targetRevisionId: uuid,
          },
        },
      },
    },
    (request) =>
      options.service.rollbackContent(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        String(request.body.targetRevisionId),
        request.body.expectedRevision!,
        String(request.body.locale),
      ),
  );

  app.get<RequestShape>(
    '/api/v1/cms/assets',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId'],
          additionalProperties: false,
          properties: { tenantId: uuid, websiteId: uuid },
        },
      },
    },
    (request) =>
      options.service.assets(
        readContext(request, () => options.actor(request)),
        request.query.websiteId,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/assets',
    {
      schema: {
        headers: commandHeaders,
        body: {
          type: 'object',
          required: [
            'tenantId',
            'reason',
            'storageProvider',
            'storageKey',
            'publicUrl',
            'name',
            'mimeType',
            'byteSize',
          ],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            websiteId: { anyOf: [uuid, { type: 'null' }] },
            storageProvider: { type: 'string' },
            storageKey: { type: 'string' },
            publicUrl: { type: 'string' },
            name: { type: 'string' },
            mimeType: { type: 'string' },
            byteSize: { type: 'integer', minimum: 0 },
            checksum: { type: 'string' },
            alt: { type: 'object' },
            metadata: { type: 'object' },
          },
        },
      },
    },
    (request) =>
      options.service.createAsset(
        commandContext(request, () => options.actor(request)),
        request.body,
      ),
  );

  app.get<RequestShape>(
    '/api/v1/cms/channels',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId', 'websiteId'],
          additionalProperties: false,
          properties: { tenantId: uuid, websiteId: uuid },
        },
      },
    },
    (request) =>
      options.service.channels(
        readContext(request, () => options.actor(request)),
        request.query.websiteId!,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/channels',
    {
      schema: {
        headers: commandHeaders,
        body: {
          type: 'object',
          required: [
            'tenantId',
            'reason',
            'websiteId',
            'provider',
            'externalAccountId',
            'displayName',
          ],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            websiteId: uuid,
            provider: { type: 'string' },
            externalAccountId: { type: 'string' },
            displayName: { type: 'string' },
            capability: { type: 'object' },
            tokenRef: { type: 'string' },
          },
        },
      },
    },
    (request) =>
      options.service.createChannel(
        commandContext(request, () => options.actor(request)),
        request.body,
      ),
  );

  app.get<RequestShape>(
    '/api/v1/cms/publications',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId', 'websiteId'],
          additionalProperties: false,
          properties: { tenantId: uuid, websiteId: uuid },
        },
      },
    },
    (request) =>
      options.service.publications(
        readContext(request, () => options.actor(request)),
        request.query.websiteId!,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/publications',
    {
      schema: {
        headers: commandHeaders,
        body: {
          type: 'object',
          required: [
            'tenantId',
            'reason',
            'websiteId',
            'connectionId',
            'targetKind',
            'targetId',
            'revisionId',
          ],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            websiteId: uuid,
            connectionId: uuid,
            targetKind: { type: 'string' },
            targetId: uuid,
            revisionId: uuid,
            scheduledAt: { type: 'string' },
          },
        },
      },
    },
    (request) =>
      options.service.queuePublication(
        commandContext(request, () => options.actor(request)),
        request.body,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/publications/:id/retry',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason'],
          additionalProperties: false,
          properties: { tenantId: uuid, reason: { type: 'string', minLength: 5, maxLength: 240 } },
        },
      },
    },
    (request) =>
      options.service.retryPublication(
        commandContext(request, () => options.actor(request)),
        request.params.id,
      ),
  );

  app.get<RequestShape>(
    '/api/v1/cms/menus',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenantId', 'websiteId'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            websiteId: uuid,
            code: { type: 'string' },
            locale: { type: 'string' },
          },
        },
      },
    },
    (request) =>
      options.service.menus(
        readContext(request, () => options.actor(request)),
        request.query.websiteId!,
        request.query.code,
        request.query.locale,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/menus/draft',
    {
      schema: {
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'websiteId', 'code', 'name', 'locale', 'items'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            websiteId: uuid,
            code: { type: 'string' },
            name: { type: 'string' },
            locale: { type: 'string' },
            items: { type: 'array' },
            expectedRevision: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    (request) =>
      options.service.saveMenuDraft(
        commandContext(request, () => options.actor(request)),
        request.body as never,
      ),
  );

  app.post<RequestShape>(
    '/api/v1/cms/menus/:id/publish',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        headers: commandHeaders,
        body: {
          type: 'object',
          required: ['tenantId', 'reason', 'expectedRevision'],
          additionalProperties: false,
          properties: {
            tenantId: uuid,
            reason: { type: 'string', minLength: 5, maxLength: 240 },
            expectedRevision: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    (request) =>
      options.service.publishMenu(
        commandContext(request, () => options.actor(request)),
        request.params.id,
        request.body.expectedRevision!,
      ),
  );

  app.get<{ Querystring: { websiteCode: string; path: string; locale: string } }>(
    '/api/v1/cms/public/page',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['websiteCode', 'path', 'locale'],
          additionalProperties: false,
          properties: {
            websiteCode: { type: 'string' },
            path: { type: 'string' },
            locale: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await options.service.publicPage(
        request.query.websiteCode,
        request.query.path,
        request.query.locale,
      );
      reply
        .header('cache-control', 'public, max-age=60, stale-while-revalidate=300')
        .header('etag', '"' + result.checksum + '"');
      return result;
    },
  );

  app.get<{
    Querystring: { websiteCode: string; contentTypeCode: string; slug: string; locale: string };
  }>(
    '/api/v1/cms/public/content',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['websiteCode', 'contentTypeCode', 'slug', 'locale'],
          additionalProperties: false,
          properties: {
            websiteCode: { type: 'string' },
            contentTypeCode: { type: 'string' },
            slug: { type: 'string' },
            locale: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await options.service.publicContent(
        request.query.websiteCode,
        request.query.contentTypeCode,
        request.query.slug,
        request.query.locale,
      );
      reply
        .header('cache-control', 'public, max-age=60, stale-while-revalidate=300')
        .header('etag', '"' + result.checksum + '"');
      return result;
    },
  );
}
