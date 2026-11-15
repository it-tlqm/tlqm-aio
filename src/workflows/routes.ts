import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WorkflowsService, WorkflowRunView } from './service.js';
import type { AttachmentUpload } from './service.js';
import { maxAttachmentBytes } from '../forms/attachment-fields.js';
import { attachmentDisposition } from './attachment-content.js';
import type { WorkflowActor, WorkflowCommand } from './access.js';
import {
  fieldAggregates,
  reportDatasets,
  reportGroups,
  reportHistory,
  reportMeasures,
} from './report-options.js';
import { reportFieldAddress } from './performance-reports.js';
import { documentActions } from './document-library-options.js';
import type { DocumentAction, DocumentDraftInput } from './document-library-options.js';
import type { PerformanceReportQuery } from './report-options.js';
import type { IntakeKind, IntakeRuleInput } from './intakes.js';
import { operationKinds, operationViews } from './operations-options.js';
import type { OperationQuery } from './operations-options.js';
import { registerWorkflowTransferRoutes } from './configuration-transfer-routes.js';
import {
  workflowRunViews,
  workflowRunStatuses,
  workflowDueFilters,
  workspaceColumnPattern,
} from './workspace-options.js';
import type { WorkspaceFilters, WorkspaceSettings } from './workspace-options.js';
const uuid = { type: 'string', format: 'uuid' },
  revision = { type: 'integer', minimum: 1 };
type Route = {
  Params: { id: string };
  Querystring: WorkspaceFilters & {
    tenantId: string;
    view?: WorkflowRunView;
    after?: string;
    unitId?: string;
    versionId?: string;
    definitionId?: string;
    kind?: 'person' | 'orgUnit';
    intakeKind?: IntakeKind;
    search?: string;
    taskId?: string;
    fields?: 'true';
    columns?: string;
    unitsOnly?: 'true';
  };
  Body: { tenantId: string; reason: string; expectedRevision: number } & Record<string, unknown>;
};
export function registerWorkflowsRoutes(
  app: FastifyInstance,
  options: {
    service: WorkflowsService;
    actor: (request: FastifyRequest) => Promise<WorkflowActor>;
    lookups: (request: FastifyRequest, tenant: string, unitsOnly?: boolean) => Promise<unknown>;
    configurationTransfer?: { key: string; domain: string };
  },
) {
  const { service } = options;
  const workCenter = new WorkflowWorkCenter(service);
  if (options.configurationTransfer)
    registerWorkflowTransferRoutes(
      app,
      options,
      options.configurationTransfer.key,
      options.configurationTransfer.domain,
    );
  const read = (req: FastifyRequest<Route>) => ({
    tenantId: req.query.tenantId,
    actor: () => options.actor(req),
  });
  const context = (req: FastifyRequest<Route>): WorkflowCommand => ({
    tenantId: req.body.tenantId,
    actor: () => options.actor(req),
    requestId: req.id,
    idempotencyKey:
      typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : '',
    reason: req.body.reason,
  });
  const params = {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: uuid },
  };
  app.get<{ Querystring: OperationQuery & { tenantId: string } }>(
    '/api/v1/workflows/operations',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'kind', 'view'],
          properties: {
            tenantId: uuid,
            kind: { type: 'string', enum: operationKinds },
            view: { type: 'string', enum: operationViews },
            after: uuid,
            runId: uuid,
          },
        },
      },
    },
    (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { tenantId, ...query } = request.query;
      return service.operations({ tenantId, actor: () => options.actor(request) }, query);
    },
  );
  app.get<{ Params: { id: string }; Querystring: { tenantId: string; before?: string } }>(
    '/api/v1/workflows/definitions/:id/versions',
    {
      schema: {
        params,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: uuid, before: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } },
        },
      },
    },
    (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      return service.versionHistory(
        { tenantId: req.query.tenantId, actor: () => options.actor(req) },
        req.params.id,
        req.query.before === undefined ? undefined : Number(req.query.before),
      );
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { tenantId: string; before: string; after: string };
  }>(
    '/api/v1/workflows/definitions/:id/versions/compare',
    {
      schema: {
        params,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'before', 'after'],
          properties: { tenantId: uuid, before: uuid, after: uuid },
        },
      },
    },
    (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      return service.versionComparison(
        { tenantId: req.query.tenantId, actor: () => options.actor(req) },
        req.params.id,
        req.query.before,
        req.query.after,
      );
    },
  );
  const documentVersionQuery = {
    tenantId: uuid,
    version: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' },
    issued: { type: 'string', const: 'true' },
  };
  type DocumentReadQuery = { tenantId: string; version?: string; issued?: 'true' };
  app.get<{
    Querystring: {
      tenantId: string;
      search?: string;
      folderId?: string;
      versionId?: string;
      after?: string;
    };
  }>(
    '/api/v1/workflows/documents',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: {
            tenantId: uuid,
            search: { type: 'string', maxLength: 120 },
            folderId: uuid,
            versionId: uuid,
            after: uuid,
          },
        },
      },
    },
    (req, reply) => {
      const { tenantId, ...filters } = req.query;
      reply.header('cache-control', 'private, no-store');
      return service.documents({ tenantId, actor: () => options.actor(req) }, filters);
    },
  );
  app.get<{ Params: { id: string }; Querystring: DocumentReadQuery }>(
    '/api/v1/workflows/documents/:id',
    {
      schema: {
        params,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: documentVersionQuery,
        },
      },
    },
    (req, reply) => {
      const { tenantId, version, issued } = req.query;
      reply.header('cache-control', 'private, no-store');
      return service.documentDetail(
        { tenantId, actor: () => options.actor(req) },
        req.params.id,
        version === undefined ? undefined : Number(version),
        issued === 'true',
      );
    },
  );
  app.get<{ Params: { id: string; fileId: string }; Querystring: DocumentReadQuery }>(
    '/api/v1/workflows/documents/:id/files/:fileId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'fileId'],
          properties: { id: uuid, fileId: uuid },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: documentVersionQuery,
        },
      },
    },
    async (req, reply) => {
      const { tenantId, version, issued } = req.query;
      const file = await service.downloadDocumentFile(
        { tenantId, actor: () => options.actor(req) },
        req.params.id,
        req.params.fileId,
        version === undefined ? undefined : Number(version),
        issued === 'true',
      );
      return reply
        .type('application/octet-stream')
        .header('content-disposition', attachmentDisposition(file.fileName))
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(file.content);
    },
  );
  const viewField = { type: 'string', enum: [...workflowRunViews] };
  const filters = {
    search: { type: 'string', maxLength: 120 },
    status: { type: 'string', enum: [...workflowRunStatuses] },
    unitId: uuid,
    due: { type: 'string', enum: [...workflowDueFilters] },
  };
  for (const [path, handler] of [
    ['/definitions', (req: FastifyRequest<Route>) => service.definitions(read(req))],
    ['/intake-rules', (req: FastifyRequest<Route>) => service.intakeRules(read(req))],
    [
      '/runs/:id/training-intake',
      (req: FastifyRequest<Route>) => service.trainingIntakeStatus(read(req), req.params.id),
    ],
    [
      '/intake-rules/:id/jobs',
      (req: FastifyRequest<Route>) => service.intakeJobs(read(req), req.params.id),
    ],
    [
      '/intake-recipients',
      (req: FastifyRequest<Route>) =>
        service.intakeRecipients(
          read(req),
          req.query.intakeKind!,
          req.query.definitionId!,
          req.query.unitId!,
          req.query.search ?? '',
        ),
    ],
    ['/output-templates', (req: FastifyRequest<Route>) => service.outputTemplates(read(req))],
    [
      '/output-templates/:id/jobs',
      (req: FastifyRequest<Route>) => service.outputJobs(read(req), req.params.id),
    ],
    [
      '/runs/:id/print-templates',
      (req: FastifyRequest<Route>) => service.printTemplates(read(req), req.params.id),
    ],
    ['/output-mailbox', (req: FastifyRequest<Route>) => workCenter.outputMailbox(read(req))],
    [
      '/draft-schedules',
      (req: FastifyRequest<Route>) => service.draftSchedules(read(req), req.query.after),
    ],
    [
      '/draft-schedules/:id/jobs',
      (req: FastifyRequest<Route>) =>
        service.draftScheduleJobs(read(req), req.params.id, req.query.after),
    ],
    [
      '/draft-schedule-recipients',
      (req: FastifyRequest<Route>) =>
        service.draftScheduleRecipients(
          read(req),
          req.query.definitionId!,
          req.query.unitId!,
          req.query.search ?? '',
        ),
    ],
    ['/link-rules', (req: FastifyRequest<Route>) => service.linkRules(read(req))],
    [
      '/link-rules/:id/jobs',
      (req: FastifyRequest<Route>) => service.linkJobs(read(req), req.params.id, req.query.after),
    ],
    [
      '/runs/:id/linked-requests',
      (req: FastifyRequest<Route>) => service.relatedRequests(read(req), req.params.id),
    ],
    [
      '/requests',
      (req: FastifyRequest<Route>) => service.requestDrafts(read(req), req.query.after),
    ],
    [
      '/requests/:id',
      (req: FastifyRequest<Route>) => service.requestDraft(read(req), req.params.id),
    ],
    [
      '/runs',
      (req: FastifyRequest<Route>) =>
        service.runs(read(req), req.query.view ?? 'mine', req.query.after, {
          ...req.query,
          fields: req.query.fields === 'true',
          columns: req.query.columns ? req.query.columns.split(',') : [],
        }),
    ],
    [
      '/workspace-views',
      (req: FastifyRequest<Route>) => service.workspaceViews(read(req), req.query.view!),
    ],
    [
      '/runs/:id',
      (req: FastifyRequest<Route>) => service.detail(read(req), req.params.id, req.query.taskId),
    ],
    [
      '/runs/:id/discussion',
      (req: FastifyRequest<Route>) =>
        service.discussion(read(req), req.params.id, req.query.after, req.query.taskId),
    ],
    [
      '/runs/:id/follower-candidates',
      (req: FastifyRequest<Route>) =>
        service.followerCandidates(
          read(req),
          req.params.id,
          req.query.search ?? '',
          req.query.taskId,
        ),
    ],
    ['/report', (req: FastifyRequest<Route>) => service.report(read(req))],
    [
      '/lookups',
      (req: FastifyRequest<Route>) =>
        options.lookups(req, req.query.tenantId, req.query.unitsOnly === 'true'),
    ],
    [
      '/references',
      (req: FastifyRequest<Route>) =>
        service.referenceOptions(read(req), {
          kind: req.query.kind!,
          unitId: req.query.unitId!,
          ...(req.query.search !== undefined ? { search: req.query.search } : {}),
          ...(req.query.after ? { after: req.query.after } : {}),
        }),
    ],
    ['/groups', (req: FastifyRequest<Route>) => service.groups(read(req))],
    [
      '/definitions/:id/selections',
      (req: FastifyRequest<Route>) =>
        service.startSelections(read(req), req.params.id, req.query.unitId!, req.query.versionId!),
    ],
    [
      '/runs/:id/selections',
      (req: FastifyRequest<Route>) => service.runSelections(read(req), req.params.id),
    ],
    [
      '/tasks/:id/candidates',
      async (req: FastifyRequest<Route>) => {
        const result = await service.taskCandidates(read(req), req.params.id);
        if (result.restricted) return result;
        const lookup = (await options.lookups(req, req.query.tenantId)) as {
          accounts: { id: string; name: string; unitIds: string[] }[];
        };
        return {
          ...result,
          candidates: lookup.accounts
            .filter((account) => account.unitIds.includes(result.unitId))
            .map(({ id, name }) => ({ id, name })),
        };
      },
    ],
  ] as const)
    app.get<Route>(
      '/api/v1/workflows' + path,
      {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: [
              'tenantId',
              ...(path === '/definitions/:id/selections' ? ['unitId', 'versionId'] : []),
              ...(path === '/references' ? ['unitId', 'kind'] : []),
              ...(path === '/draft-schedule-recipients' ? ['unitId', 'definitionId'] : []),
              ...(path === '/intake-recipients' ? ['unitId', 'definitionId', 'intakeKind'] : []),
              ...(path === '/workspace-views' ? ['view'] : []),
            ],
            properties: {
              tenantId: uuid,
              ...(path === '/lookups' ? { unitsOnly: { type: 'string', enum: ['true'] } } : {}),
              ...(path === '/references'
                ? {
                    unitId: uuid,
                    kind: { type: 'string', enum: ['person', 'orgUnit'] },
                    search: { type: 'string', maxLength: 100 },
                    after: uuid,
                  }
                : {}),
              ...(path === '/definitions/:id/selections' ? { unitId: uuid, versionId: uuid } : {}),
              ...([
                '/requests',
                '/link-rules/:id/jobs',
                '/draft-schedules',
                '/draft-schedules/:id/jobs',
              ].includes(path)
                ? { after: uuid }
                : {}),
              ...(path === '/draft-schedule-recipients'
                ? { unitId: uuid, definitionId: uuid, search: { type: 'string', maxLength: 100 } }
                : {}),
              ...(path === '/intake-recipients'
                ? {
                    unitId: uuid,
                    definitionId: uuid,
                    search: { type: 'string', maxLength: 100 },
                    intakeKind: { type: 'string', enum: ['hr-onboarding', 'lms-training'] },
                  }
                : {}),
              ...(path === '/runs/:id' ? { taskId: uuid } : {}),
              ...(path === '/runs/:id/discussion' ? { after: uuid, taskId: uuid } : {}),
              ...(path === '/runs/:id/follower-candidates'
                ? { search: { type: 'string', maxLength: 100 }, taskId: uuid }
                : {}),
              ...(path === '/runs'
                ? {
                    view: viewField,
                    after: uuid,
                    ...filters,
                    fields: { type: 'string', enum: ['true'] },
                    columns: { type: 'string', maxLength: 1250 },
                  }
                : {}),
              ...(path === '/workspace-views' ? { view: viewField } : {}),
            },
          },
          ...(path.includes(':id') ? { params } : {}),
        },
      },
      handler,
    );
  app.get<{
    Params: { id: string };
    Querystring: { tenantId: string; templateId: string; download?: 'true' };
  }>(
    '/api/v1/workflows/runs/:id/print',
    {
      schema: {
        params,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'templateId'],
          properties: {
            tenantId: uuid,
            templateId: uuid,
            download: { type: 'string', enum: ['true'] },
          },
        },
      },
    },
    async (req, reply) => {
      const html = await service.printRun(
        { tenantId: req.query.tenantId, actor: () => options.actor(req) },
        req.params.id,
        req.query.templateId,
      );
      reply
        .header('cache-control', 'no-store')
        .header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
        )
        .header('x-content-type-options', 'nosniff');
      if (req.query.download === 'true')
        reply.header('content-disposition', 'attachment; filename="ho-so-quy-trinh.html"');
      return reply.type('text/html; charset=utf-8').send(html);
    },
  );
  const requiredReportFields = ['dataset', 'groupBy', 'measure', 'from', 'to'];
  const fieldAddress = { type: 'string', pattern: reportFieldAddress.source };
  const reportFields = {
    dataset: { type: 'string', enum: reportDatasets },
    groupBy: { type: 'string', enum: reportGroups },
    measure: { type: 'string', enum: reportMeasures },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
    history: { type: 'string', enum: reportHistory },
    unitId: uuid,
    versionId: uuid,
    status: { type: 'string', pattern: '^[a-z_]{1,24}$' },
    columns: { type: 'string', minLength: 1, maxLength: 1079 },
    groupField: fieldAddress,
    filterField: fieldAddress,
    match: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    metricField: fieldAddress,
    aggregate: { type: 'string', enum: fieldAggregates },
  };
  const reportGroup = { type: 'string', minLength: 1, maxLength: 130 };
  app.get<{ Querystring: { tenantId: string } }>(
    '/api/v1/workflows/performance-report/versions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: uuid },
        },
      },
    },
    (req) =>
      service.performanceReportVersions({
        tenantId: req.query.tenantId,
        actor: () => options.actor(req),
      }),
  );
  app.get<{ Querystring: PerformanceReportQuery & { tenantId: string; search?: string } }>(
    '/api/v1/workflows/performance-report/fields',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'versionId', ...requiredReportFields],
          properties: {
            tenantId: uuid,
            ...reportFields,
            search: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    (req, reply) => {
      const { tenantId, search, ...filters } = req.query;
      reply.header('cache-control', 'private, no-store');
      return service.performanceReportFields(
        { tenantId, actor: () => options.actor(req) },
        filters,
        search,
      );
    },
  );
  for (const detail of [false, true]) {
    app.get<{
      Querystring: PerformanceReportQuery & {
        tenantId: string;
        page?: string;
        group?: string;
        observedAt?: string;
      };
    }>(
      '/api/v1/workflows/performance-report' + (detail ? '/details' : ''),
      {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: [
              'tenantId',
              ...requiredReportFields,
              ...(detail ? ['group', 'observedAt'] : []),
            ],
            properties: {
              tenantId: uuid,
              ...reportFields,
              page: { type: 'string', pattern: '^([1-9][0-9]{0,3}|10000)$' },
              ...(detail && {
                group: reportGroup,
                observedAt: { type: 'string', format: 'date-time' },
              }),
            },
          },
        },
      },
      (req, reply) => {
        const { tenantId, page, group, observedAt, ...filters } = req.query;
        reply.header('cache-control', 'private, no-store');
        const c = { tenantId, actor: () => options.actor(req) };
        return detail
          ? service.performanceReportDetail(c, filters, group!, Number(page ?? '1'), observedAt!)
          : service.performanceReport(c, filters, Number(page ?? '1'));
      },
    );
  }
  function command(
    path: string,
    fields: Record<string, unknown>,
    handler: (request: FastifyRequest<Route>, reply: FastifyReply) => Promise<unknown>,
    rev = true,
    optionalFields: Record<string, unknown> = {},
    bodyLimit = 524288,
  ) {
    app.post<Route>(
      '/api/v1/workflows' + path,
      {
        bodyLimit,
        schema: {
          ...(path.includes(':id') ? { params } : {}),
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
            required: [
              'tenantId',
              'reason',
              ...Object.keys(fields),
              ...(rev ? ['expectedRevision'] : []),
            ],
            properties: {
              tenantId: uuid,
              reason: { type: 'string', minLength: 5, maxLength: 240 },
              ...(rev ? { expectedRevision: revision } : {}),
              ...fields,
              ...optionalFields,
            },
          },
        },
      },
      handler,
    );
  }
  const nullableUnit = { anyOf: [uuid, { type: 'null' }] };
  const folderInput = {
    unitId: uuid,
    parentId: nullableUnit,
    name: { type: 'string', minLength: 1, maxLength: 120 },
  };
  type FolderInput = Parameters<WorkflowsService['saveDocumentFolder']>[1];
  command(
    '/document-folders',
    folderInput,
    (req) => service.saveDocumentFolder(context(req), req.body as unknown as FolderInput),
    false,
  );
  command('/document-folders/:id', folderInput, (req) =>
    service.saveDocumentFolder(
      context(req),
      req.body as unknown as FolderInput,
      req.params.id,
      req.body.expectedRevision,
    ),
  );
  const encodedLimit = Math.ceil(maxAttachmentBytes / 3) * 4;
  const documentInput = {
    unitId: uuid,
    folderId: nullableUnit,
    title: { type: 'string', minLength: 1, maxLength: 160 },
    content: { type: 'string', maxLength: 20000 },
    viewerUnits: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: uuid },
    files: {
      type: 'array',
      maxItems: 4,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['reuseId'],
            properties: { reuseId: uuid },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['fileName', 'content'],
            properties: {
              fileName: { type: 'string', minLength: 1, maxLength: 180 },
              content: { type: 'string', minLength: 1, maxLength: encodedLimit },
            },
          },
        ],
      },
    },
  };
  const documentOptional = {
    workflow: {
      type: 'object',
      additionalProperties: false,
      required: ['definitionId', 'versionId'],
      properties: { definitionId: uuid, versionId: uuid },
    },
  };
  command(
    '/documents',
    documentInput,
    (req) => service.saveDocument(context(req), req.body as unknown as DocumentDraftInput),
    false,
    documentOptional,
    encodedLimit + 130000,
  );
  command(
    '/documents/:id',
    documentInput,
    (req) =>
      service.saveDocument(
        context(req),
        req.body as unknown as DocumentDraftInput,
        req.params.id,
        req.body.expectedRevision,
      ),
    true,
    documentOptional,
    encodedLimit + 130000,
  );
  command(
    '/documents/:id/transition',
    { action: { type: 'string', enum: documentActions } },
    (req) =>
      service.transitionDocument(
        context(req),
        req.params.id,
        req.body.action as DocumentAction,
        req.body.expectedRevision,
      ),
  );
  command(
    '/documents/:id/restore',
    { sourceVersion: { type: 'integer', minimum: 1, maximum: 2147483647 } },
    (req) =>
      service.restoreDocumentDraft(
        context(req),
        req.params.id,
        req.body.sourceVersion as number,
        req.body.expectedRevision,
      ),
  );
  const savedViewFields = {
    view: viewField,
    name: { type: 'string', minLength: 1, maxLength: 80 },
    settings: {
      type: 'object',
      additionalProperties: false,
      required: ['columns'],
      properties: {
        ...filters,
        columns: {
          type: 'array',
          maxItems: 12,
          uniqueItems: true,
          items: { type: 'string', pattern: workspaceColumnPattern },
        },
      },
    },
  };
  command(
    '/workspace-views',
    savedViewFields,
    (req) =>
      service.saveWorkspaceView(
        context(req),
        req.body.view as WorkflowRunView,
        req.body.name as string,
        req.body.settings as WorkspaceSettings,
      ),
    false,
  );
  command('/workspace-views/:id', savedViewFields, (req) =>
    service.saveWorkspaceView(
      context(req),
      req.body.view as WorkflowRunView,
      req.body.name as string,
      req.body.settings as WorkspaceSettings,
      { id: req.params.id, revision: req.body.expectedRevision },
    ),
  );
  command('/workspace-views/:id/archive', { view: viewField }, (req) =>
    service.archiveWorkspaceView(
      context(req),
      req.body.view as WorkflowRunView,
      req.params.id,
      req.body.expectedRevision,
    ),
  );
  command(
    '/runs/:id/followers',
    { accountId: uuid },
    (req) =>
      service.addFollower(
        context(req),
        req.params.id,
        req.body.accountId as string,
        req.body.taskId as string | undefined,
      ),
    false,
    { taskId: uuid },
  );
  command(
    '/runs/:id/followers/remove',
    { followerId: uuid },
    (req) =>
      service.removeFollower(
        context(req),
        req.params.id,
        req.body.followerId as string,
        req.body.expectedRevision,
        req.body.taskId as string | undefined,
      ),
    true,
    { taskId: uuid },
  );
  command(
    '/runs/:id/discussion',
    {
      text: { type: 'string', minLength: 1, maxLength: 4000 },
      mentionIds: { type: 'array', maxItems: 10, uniqueItems: true, items: uuid },
    },
    (req) =>
      service.postComment(
        context(req),
        req.params.id,
        req.body.text as string,
        req.body.mentionIds as string[],
        req.body.taskId as string | undefined,
      ),
    false,
    { taskId: uuid },
  );
  const maxEncodedAttachment = Math.ceil(maxAttachmentBytes / 3) * 4;
  for (const [prefix, scope] of [
    ['requests', 'request'],
    ['runs', 'revision'],
    ['tasks', 'task'],
  ] as const)
    command(
      '/' + prefix + '/:id/attachments',
      {
        fieldId: { type: 'string', pattern: '^(?:input\\.)?[a-z][a-z0-9_]{0,63}$' },
        fileName: { type: 'string', minLength: 1, maxLength: 180 },
        content: { type: 'string', minLength: 4, maxLength: maxEncodedAttachment },
      },
      (req) =>
        service.uploadAttachment(
          context(req),
          scope,
          req.params.id,
          req.body as unknown as AttachmentUpload,
        ),
      false,
      {},
      maxEncodedAttachment + 4096,
    );
  app.get<Route>(
    '/api/v1/workflows/attachments/:id',
    {
      schema: {
        params,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: uuid },
        },
      },
    },
    async (req, reply) => {
      const file = await service.downloadAttachment(read(req), req.params.id);
      return reply
        .type('application/octet-stream')
        .header('content-disposition', attachmentDisposition(file.fileName))
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(file.content);
    },
  );
  command(
    '/performance-report/export',
    {
      report: {
        type: 'object',
        additionalProperties: false,
        required: requiredReportFields,
        properties: reportFields,
      },
    },
    async (req, reply) => {
      const result = await service.exportPerformanceReport(
        context(req),
        req.body.report as PerformanceReportQuery,
        req.body.group as string | undefined,
      );
      return reply
        .header('cache-control', 'private, no-store')
        .header('content-disposition', 'attachment; filename="bao-cao-quy-trinh.csv"')
        .header('x-content-type-options', 'nosniff')
        .header('x-report-rows', String(result.rows))
        .type('text/csv; charset=utf-8')
        .send(result.csv);
    },
    false,
    { group: reportGroup },
  );

  const definition = {
    code: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,50}$' },
    orgUnitId: uuid,
    spec: { type: 'object' },
  };
  const selections = {
    type: 'object',
    maxProperties: 30,
    propertyNames: { pattern: '^[a-z][a-z0-9_]{0,59}$' },
    additionalProperties: uuid,
  };
  const group = {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    orgUnitId: { anyOf: [uuid, { type: 'null' }] },
    active: { type: 'boolean' },
    accountIds: { type: 'array', maxItems: 50, uniqueItems: true, items: uuid },
  };
  const requestFields = {
    definitionId: uuid,
    versionId: uuid,
    unitId: uuid,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    answers: { type: 'object' },
  };
  command(
    '/requests',
    requestFields,
    (req) =>
      service.saveRequest(
        context(req),
        req.body as unknown as Parameters<WorkflowsService['saveRequest']>[1],
      ),
    false,
    { selections },
  );
  command(
    '/requests/:id',
    requestFields,
    (req) =>
      service.saveRequest(
        context(req),
        req.body as unknown as Parameters<WorkflowsService['saveRequest']>[1],
        req.params.id,
        req.body.expectedRevision,
      ),
    true,
    { selections },
  );
  command('/requests/:id/submit', {}, (req) =>
    service.submitRequest(context(req), req.params.id, req.body.expectedRevision),
  );
  command(
    '/link-rules',
    {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      unitId: uuid,
      sourceDefinitionId: uuid,
      sourceVersionId: uuid,
      targetDefinitionId: uuid,
      targetVersionId: uuid,
      mapping: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: {
            from: { type: 'string', maxLength: 64 },
            to: { type: 'string', maxLength: 64 },
            origin: { type: 'string', enum: ['input', 'step'] },
          },
        },
      },
    },
    (req) =>
      service.createLinkRule(
        context(req),
        req.body as unknown as Parameters<WorkflowsService['createLinkRule']>[1],
      ),
    false,
    {
      recipientAccountId: uuid,
      sourceStepId: { type: 'string', minLength: 1, maxLength: 64 },
      recipientIsStepActor: { type: 'boolean' },
      predicate: {
        type: 'object',
        additionalProperties: false,
        required: ['fieldId', 'equals'],
        properties: {
          fieldId: { type: 'string', maxLength: 64 },
          equals: {},
          origin: { type: 'string', enum: ['input', 'step'] },
        },
      },
    },
  );
  command(
    '/draft-schedules',
    {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      definitionId: uuid,
      versionId: uuid,
      unitId: uuid,
      recipientAccountId: uuid,
      cadence: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly', 'yearly'] },
      every: { type: 'integer', minimum: 1, maximum: 365 },
      startDate: { type: 'string', format: 'date' },
      localTime: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
    },
    (req) =>
      service.createDraftSchedule(
        context(req),
        req.body as unknown as Parameters<WorkflowsService['createDraftSchedule']>[1],
      ),
    false,
    { endDate: { type: 'string', format: 'date' } },
  );
  command('/draft-schedules/:id/disable', {}, (req) =>
    service.disableDraftSchedule(context(req), req.params.id, req.body.expectedRevision),
  );
  command('/draft-schedule-jobs/:id/retry', {}, (req) =>
    service.retryDraftScheduleJob(context(req), req.params.id, req.body.expectedRevision),
  );
  command(
    '/output-templates',
    {
      definitionId: uuid,
      versionId: uuid,
      unitId: uuid,
      kind: { type: 'string', enum: ['print', 'email'] },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      heading: { type: 'string', minLength: 1, maxLength: 240 },
      body: { type: 'string', maxLength: 6000 },
      fields: { type: 'array', maxItems: 60, items: { type: 'string', maxLength: 150 } },
    },
    (req) =>
      service.createOutputTemplate(
        context(req),
        req.body as unknown as Parameters<WorkflowsService['createOutputTemplate']>[1],
      ),
    false,
    {
      event: { type: 'string', enum: Object.keys(outputEvents) },
      stepId: { type: 'string', minLength: 1, maxLength: 64 },
    },
  );
  command('/output-templates/:id/disable', {}, (req) =>
    service.disableOutputTemplate(context(req), req.params.id, req.body.expectedRevision),
  );
  command('/output-jobs/:id/retry', {}, (req) =>
    service.retryOutputJob(context(req), req.params.id, req.body.expectedRevision),
  );
  command(
    '/intake-rules',
    {
      definitionId: uuid,
      versionId: uuid,
      unitId: uuid,
      recipientAccountId: uuid,
      kind: { type: 'string', enum: ['hr-onboarding', 'lms-training'] },
      mapping: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          ['displayName', 'employeeCode', 'title', 'summary'].map((name) => [
            name,
            { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
          ]),
        ),
      },
    },
    (req) => service.createIntakeRule(context(req), req.body as unknown as IntakeRuleInput),
    false,
  );
  command('/intake-rules/:id/disable', {}, (req) =>
    service.disableIntakeRule(context(req), req.params.id, req.body.expectedRevision),
  );
  command('/intake-jobs/:id/retry', {}, (req) =>
    service.retryIntakeJob(context(req), req.params.id, req.body.expectedRevision),
  );
  command('/link-rules/:id/disable', {}, (req) =>
    service.disableLinkRule(context(req), req.params.id, req.body.expectedRevision),
  );
  command('/link-jobs/:id/retry', {}, (req) =>
    service.retryLinkJob(context(req), req.params.id, req.body.expectedRevision),
  );
  command(
    '/groups',
    group,
    (req) =>
      service.saveGroup(
        context(req),
        req.body as unknown as Parameters<WorkflowsService['saveGroup']>[1],
      ),
    false,
  );
  command('/groups/:id', group, (req) =>
    service.saveGroup(
      context(req),
      req.body as unknown as Parameters<WorkflowsService['saveGroup']>[1],
      req.params.id,
      req.body.expectedRevision,
    ),
  );
  command(
    '/definitions',
    definition,
    (req) =>
      service.saveDefinition(
        context(req),
        req.body as unknown as Parameters<WorkflowsService['saveDefinition']>[1],
      ),
    false,
  );
  command('/definitions/:id', definition, (req) =>
    service.saveDefinition(
      context(req),
      req.body as unknown as Parameters<WorkflowsService['saveDefinition']>[1],
      req.params.id,
      req.body.expectedRevision,
    ),
  );
  command('/definitions/:id/publish', {}, (req) =>
    service.publish(context(req), req.params.id, req.body.expectedRevision),
  );
  command('/definitions/:id/versions/restore', { sourceVersionId: uuid }, (req) =>
    service.restoreVersion(
      context(req),
      req.params.id,
      req.body.expectedRevision,
      req.body.sourceVersionId as string,
    ),
  );
  command(
    '/definitions/:id/status',
    { status: { type: 'string', enum: ['published', 'paused'] } },
    (req) =>
      service.setStatus(
        context(req),
        req.params.id,
        req.body.expectedRevision,
        req.body.status as 'published' | 'paused',
      ),
  );
  command(
    '/runs',
    {
      definitionId: uuid,
      versionId: uuid,
      unitId: uuid,
      title: { type: 'string', minLength: 1, maxLength: 200 },
      answers: { type: 'object' },
    },
    (req) =>
      service.start(context(req), req.body as unknown as Parameters<WorkflowsService['start']>[1]),
    false,
    { selections },
  );
  const actionFields = {
    action: { type: 'string', enum: ['approve', 'reject', 'complete', 'return'] },
    answers: { type: 'object' },
  };
  const returnTarget = { anyOf: [uuid, { type: 'string', const: 'initiator' }] };
  const handoffChoice = {
    type: 'object',
    additionalProperties: false,
    required: ['stepId', 'accountId'],
    properties: {
      stepId: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,59}$' },
      accountId: uuid,
    },
  };
  app.post<Route>(
    '/api/v1/workflows/tasks/:id/handoff-preview',
    {
      bodyLimit: 524288,
      schema: {
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'expectedRevision', 'action', 'answers'],
          properties: { tenantId: uuid, expectedRevision: revision, ...actionFields, returnTarget },
        },
      },
    },
    (req) =>
      service.previewHandoff(
        { tenantId: req.body.tenantId, actor: () => options.actor(req) },
        req.params.id,
        req.body as unknown as Parameters<WorkflowsService['previewHandoff']>[2],
      ),
  );
  command(
    '/tasks/:id/action',
    actionFields,
    (req) =>
      service.act(
        context(req),
        req.params.id,
        req.body as unknown as Parameters<WorkflowsService['act']>[2],
      ),
    true,
    {
      returnTarget,
      handoff: handoffChoice,
      handoffs: { type: 'array', minItems: 1, maxItems: 28, items: handoffChoice },
    },
  );
  command(
    '/tasks/:id/reassign',
    { accountId: uuid },
    (req) =>
      service.reassign(
        context(req),
        req.params.id,
        req.body as unknown as Parameters<WorkflowsService['reassign']>[2],
      ),
    true,
    { replaceAccountId: uuid },
  );
  command(
    '/runs/:id/resubmit',
    { answers: { type: 'object' } },
    (req) =>
      service.resubmit(context(req), req.params.id, {
        expectedRevision: req.body.expectedRevision,
        answers: req.body.answers,
        ...(req.body.selections !== undefined ? { selections: req.body.selections } : {}),
      }),
    true,
    { selections },
  );
  command('/runs/:id/cancel', {}, (req) =>
    service.cancel(context(req), req.params.id, req.body.expectedRevision),
  );
  command(
    '/runs/:id/recall',
    {},
    (req) =>
      service.recall(
        context(req),
        req.params.id,
        req.body as unknown as Parameters<WorkflowsService['recall']>[2],
      ),
    true,
    { sourceTaskId: uuid },
  );
}
import { WorkflowWorkCenter } from './work-center.js';
import { outputEvents } from './output-templates.js';
