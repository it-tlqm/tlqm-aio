import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './store.js';
import type { AppRuntime } from './config.js';
import type { AuthResult } from './management/routes.js';
import { HttpError } from './security.js';
import { portalWorkProof } from './portal-work-proof.js';
import type { PortalWorkQuery } from './portal-work-proof.js';
import { bffSpan } from './bff-telemetry.js';
type DelegatedAuth = AuthResult & { delegatedAccessToken?: string };
export function registerTrainingWorkCenter(
  app: FastifyInstance,
  runtime: AppRuntime,
  store: Store,
  authenticate: (req: FastifyRequest, delegate?: boolean) => Promise<DelegatedAuth>,
  test: boolean,
) {
  const source = runtime.clients.find(
    (c) => c.code === 'aio-lms-sandbox' && c.kind === 'external-application',
  );
  const query = {
    type: 'object',
    additionalProperties: false,
    required: ['tenantId'],
    properties: { tenantId: { type: 'string', format: 'uuid' } },
  };
  app.get<{ Querystring: { tenantId: string } }>(
    '/api/v1/work-center/sources',
    { schema: { querystring: query } },
    async (req) => {
      const { principal } = await authenticate(req);
      if (
        !(await store.memberships(principal.accountId, 'aio-foundation')).some(
          (t) => t.id === req.query.tenantId,
        )
      )
        throw new HttpError(403, 'PERMISSION_DENIED');
      const items = [];
      const available = await store.applications(principal.accountId);
      for (const [code, name, kind] of [
        ['aio-workflows', 'Quy trình', 'application'],
        ['aio-tasks', 'Công việc', 'application'],
        ['aio-forms', 'Biểu mẫu', 'application'],
        ['aio-lms-sandbox', 'Đào tạo', 'external-application'],
      ] as const)
        if (
          runtime.clients.some((c) => c.code === code && c.kind === kind) &&
          available.some((a) => a.code === code) &&
          (await store.memberships(principal.accountId, code)).some(
            (t) => t.id === req.query.tenantId,
          )
        ) {
          if (
            code === 'aio-forms' &&
            !(await store.applicationPermissions(principal.accountId, code)).some(
              (p) =>
                p.tenantId === req.query.tenantId &&
                p.permission === 'forms:respond' &&
                (p.managedAppCode === null || p.managedAppCode === code),
            )
          )
            continue;
          items.push({ code, name });
        }
      return { items };
    },
  );
  if (!source) return;
  app.get<{ Querystring: { tenantId: string } }>(
    '/api/v1/work-center/training',
    { schema: { querystring: query } },
    async (req) => {
      const auth = await authenticate(req, true);
      if (!auth.sessionHash || !auth.delegatedAccessToken)
        throw new HttpError(403, 'PORTAL_SESSION_REQUIRED');
      const body: PortalWorkQuery = {
        instanceId: runtime.instanceId,
        environment: test ? 'test' : runtime.mode,
        tenantId: req.query.tenantId,
        sessionHash: auth.sessionHash,
      };
      let response: Response;
      const span = bffSpan(req);
      try {
        response = await fetch(source.baseUrl + '/api/integrations/portal-work', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(span && { traceparent: span.header() }),
            authorization: 'Bearer ' + auth.delegatedAccessToken,
            'x-aio-service-proof': await portalWorkProof(
              source.clientSecret,
              source.code,
              auth.delegatedAccessToken,
              body,
              'request',
            ),
          },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw new HttpError(503, 'LMS_WORK_SOURCE_UNAVAILABLE');
      }
      if (!response.ok)
        throw new HttpError(
          [401, 403, 413].includes(response.status) ? response.status : 503,
          response.status === 401
            ? 'SESSION_EXPIRED'
            : response.status === 403
              ? 'LMS_PERMISSION_DENIED'
              : response.status === 413
                ? 'LMS_TRAINING_TOO_MANY'
                : 'LMS_WORK_SOURCE_UNAVAILABLE',
        );
      const reader = response.body?.getReader();
      if (!reader) throw new HttpError(503, 'LMS_WORK_SOURCE_UNAVAILABLE');
      let size = 0,
        text = '';
      const decoder = new TextDecoder();
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new HttpError(413, 'LMS_TRAINING_TOO_MANY');
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      let data: Record<string, any>;
      try {
        data = JSON.parse(text);
      } catch {
        throw new HttpError(503, 'LMS_WORK_CONTRACT_INVALID');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new HttpError(503, 'LMS_WORK_CONTRACT_INVALID');
      const uuid = (v: unknown) =>
          typeof v === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
        label = (v: unknown) => typeof v === 'string' && v.length <= 200,
        number = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
      if (
        data.version !== 1 ||
        data.instanceId !== runtime.instanceId ||
        data.environment !== body.environment ||
        data.maxAgeSeconds !== 0 ||
        data.accountId !== auth.principal.accountId ||
        data.personId !== auth.principal.personId ||
        data.tenantId !== body.tenantId ||
        !Array.isArray(data.items) ||
        data.items.length > 1000 ||
        !Array.isArray(data.notices) ||
        data.notices.length > 10000 ||
        !data.items.every(
          (i: any) =>
            i &&
            uuid(i.id) &&
            label(i.title) &&
            label(i.pathTitle) &&
            number(i.startsAt) &&
            number(i.dueAt) &&
            number(i.progress) &&
            i.progress <= 100 &&
            number(i.remainingCourses) &&
            typeof i.overdue === 'boolean' &&
            typeof i.needsReview === 'boolean',
        ) ||
        !data.notices.every(
          (n: any) =>
            n &&
            typeof n.id === 'string' &&
            /^[0-9a-f]{32}$/.test(n.id) &&
            uuid(n.batchId) &&
            label(n.title) &&
            ['assigned', 'rescheduled', 'due_soon', 'overdue'].includes(n.kind) &&
            number(n.createdAt) &&
            (n.readAt === null || number(n.readAt)) &&
            number(n.revision),
        )
      )
        throw new HttpError(503, 'LMS_WORK_CONTRACT_INVALID');
      await authenticate(req);
      return {
        items: data.items.map((i: any) => ({
          id: i.id,
          title: i.title,
          pathTitle: i.pathTitle,
          startsAt: i.startsAt,
          dueAt: i.dueAt,
          progress: i.progress,
          remainingCourses: i.remainingCourses,
          overdue: i.overdue,
          needsReview: i.needsReview,
          route: '/#training-batch/' + i.id,
        })),
        notices: data.notices.map((n: any) => ({
          id: n.id,
          batchId: n.batchId,
          title: n.title,
          kind: n.kind,
          createdAt: n.createdAt,
          readAt: n.readAt,
          revision: n.revision,
          route: '/#training-batch/' + n.batchId,
        })),
        source: { code: source.code, name: 'Đào tạo', baseUrl: source.baseUrl },
      };
    },
  );
}
