import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TasksService } from './service.js';
import type { TaskActor, TaskCommand, TaskContext } from './access.js';
import { projectRoles, reminderOffsets, taskStagePattern, taskStatuses } from './options.js';
import type { ProjectRole, TaskInput, TaskStatus, TaskWorkflow } from './options.js';

type Request = {
  Params: { id: string };
  Querystring: {
    tenantId: string;
    search?: string;
    status?: TaskStatus;
    stageCode?: string;
    assigneeId?: string;
    overdue?: 'true';
    mine?: 'true';
    after?: string;
  };
  Body: { tenantId: string; reason: string; expectedRevision: number } & Record<string, unknown>;
};
const uuid = { type: 'string', format: 'uuid' };
const nullableUuid = { anyOf: [uuid, { type: 'null' }] };
const params = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: uuid },
};
const revision = { type: 'integer', minimum: 1 };
const search = { type: 'string', maxLength: 120 };
const stageCode = { type: 'string', pattern: taskStagePattern };
const workflow = {
  type: 'object',
  additionalProperties: false,
  required: ['stages', 'transitions'],
  properties: {
    stages: {
      type: 'array',
      minItems: 3,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'name', 'phase'],
        properties: {
          code: stageCode,
          name: { type: 'string', minLength: 1, maxLength: 60 },
          phase: { type: 'string', enum: taskStatuses },
        },
      },
    },
    transitions: {
      type: 'array',
      maxItems: 56,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'roles'],
        properties: {
          from: stageCode,
          to: stageCode,
          roles: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
            items: { type: 'string', enum: ['manager', 'member'] },
          },
        },
      },
    },
  },
};
const boolQuery = { type: 'string', const: 'true' };
const base = '/api/v1/tasks';
type Route = FastifyRequest<Request>;

export function registerTasksRoutes(
  app: FastifyInstance,
  service: TasksService,
  actor: (request: FastifyRequest) => Promise<TaskActor>,
  lookups: (context: TaskContext) => Promise<unknown>,
) {
  const context = (req: Route): TaskContext => ({
    tenantId: req.query.tenantId,
    actor: () => actor(req),
  });
  const commandContext = (req: Route): TaskCommand => ({
    tenantId: req.body.tenantId,
    reason: req.body.reason,
    requestId: req.id,
    idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
    actor: () => actor(req),
  });
  function get(
    path: string,
    fields: Record<string, unknown>,
    run: (req: Route) => Promise<unknown>,
  ) {
    app.get<Request>(
      base + path,
      {
        schema: {
          ...(path.includes(':id') && { params }),
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['tenantId'],
            properties: { tenantId: uuid, ...fields },
          },
        },
      },
      (req, reply) => {
        reply.header('cache-control', 'private, no-store');
        return run(req);
      },
    );
  }
  get('/lookups', {}, (req) => lookups(context(req)));
  get('/projects', {}, (req) => service.projects(context(req)));
  get('/projects/:id', {}, (req) => service.projectDetails(context(req), req.params.id));
  get('/projects/:id/candidates', { search }, (req) =>
    service.candidates(context(req), req.params.id, req.query.search ?? ''),
  );
  get(
    '/projects/:id/items',
    {
      search,
      status: { type: 'string', enum: taskStatuses },
      stageCode,
      assigneeId: uuid,
      after: uuid,
      overdue: boolQuery,
      mine: boolQuery,
    },
    (req) => {
      const { tenantId: _, overdue, mine, ...filters } = req.query;
      return service.tasks(context(req), req.params.id, {
        ...filters,
        overdue: overdue === 'true',
        mine: mine === 'true',
      });
    },
  );
  get('/projects/:id/report', {}, (req) => service.report(context(req), req.params.id));
  get('/items/:id', {}, (req) => service.taskDetails(context(req), req.params.id));
  get('/reminders', {}, (req) => service.reminders(context(req)));

  function post(
    path: string,
    fields: Record<string, unknown>,
    run: (req: Route) => Promise<unknown>,
    withRevision = false,
    optional: Record<string, unknown> = {},
  ) {
    app.post<Request>(
      base + path,
      {
        schema: {
          ...(path.includes(':id') && { params }),
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
              ...(withRevision ? ['expectedRevision'] : []),
            ],
            properties: {
              tenantId: uuid,
              reason: { type: 'string', minLength: 5, maxLength: 240 },
              ...(withRevision && { expectedRevision: revision }),
              ...fields,
              ...optional,
            },
          },
        },
      },
      (req, reply) => {
        reply.header('cache-control', 'private, no-store');
        return run(req);
      },
    );
  }
  const projectFields = {
    unitId: uuid,
    name: { type: 'string', minLength: 1, maxLength: 160 },
    description: { type: 'string', maxLength: 5000 },
  };
  type ProjectInput = Parameters<TasksService['saveProject']>[1];
  post('/projects', projectFields, (req) =>
    service.saveProject(commandContext(req), req.body as unknown as ProjectInput),
  );
  post(
    '/projects/:id',
    projectFields,
    (req) =>
      service.saveProject(
        commandContext(req),
        req.body as unknown as ProjectInput,
        req.params.id,
        req.body.expectedRevision,
      ),
    true,
    { archived: { type: 'boolean' } },
  );
  post(
    '/projects/:id/member',
    { accountId: uuid, role: { type: 'string', enum: projectRoles }, active: { type: 'boolean' } },
    (req) =>
      service.setMember(commandContext(req), req.params.id, {
        accountId: req.body.accountId as string,
        role: req.body.role as ProjectRole,
        active: req.body.active as boolean,
        expectedRevision: req.body.expectedRevision,
      }),
    true,
  );
  post(
    '/projects/:id/workflow',
    { workflow },
    (req) =>
      service.saveWorkflow(
        commandContext(req),
        req.params.id,
        req.body.workflow as TaskWorkflow,
        req.body.expectedRevision,
      ),
    true,
  );
  const taskFields = {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 10000 },
    dueOn: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
    remindDays: { anyOf: [{ type: 'integer', enum: reminderOffsets }, { type: 'null' }] },
    assigneeId: nullableUuid,
    participantIds: { type: 'array', maxItems: 30, uniqueItems: true, items: uuid },
  };
  const inputOf = ({
    title,
    description,
    dueOn,
    remindDays,
    assigneeId,
    participantIds,
  }: Request['Body']) =>
    ({ title, description, dueOn, remindDays, assigneeId, participantIds }) as TaskInput;
  post(
    '/projects/:id/items',
    taskFields,
    (req) =>
      service.saveTask(commandContext(req), req.params.id, inputOf(req.body), {
        ...(typeof req.body.parentId === 'string' && { parentId: req.body.parentId }),
      }),
    false,
    { parentId: uuid },
  );
  post(
    '/items/:id/edit',
    { ...taskFields, projectId: uuid },
    (req) =>
      service.saveTask(commandContext(req), req.body.projectId as string, inputOf(req.body), {
        id: req.params.id,
        revision: req.body.expectedRevision,
      }),
    true,
  );
  post(
    '/items/:id/progress',
    {
      status: { type: 'string', enum: taskStatuses },
      progress: { type: 'integer', minimum: 0, maximum: 100 },
    },
    (req) =>
      service.progress(commandContext(req), req.params.id, {
        status: req.body.status as TaskStatus,
        progress: req.body.progress as number,
        expectedRevision: req.body.expectedRevision,
        ...(typeof req.body.stageCode === 'string' && { stageCode: req.body.stageCode }),
      }),
    true,
    { stageCode },
  );
  post(
    '/items/:id/handoff',
    { assigneeId: nullableUuid },
    (req) =>
      service.handoff(
        commandContext(req),
        req.params.id,
        req.body.assigneeId as string | null,
        req.body.expectedRevision,
      ),
    true,
  );
  post('/items/:id/comment', { body: { type: 'string', minLength: 1, maxLength: 3000 } }, (req) =>
    service.comment(commandContext(req), req.params.id, req.body.body as string),
  );
}
