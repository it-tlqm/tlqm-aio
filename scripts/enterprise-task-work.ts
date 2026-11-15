import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { ids } from '../src/fixtures.js';
import type { Store } from '../src/store.js';
import { taskPermissions } from '../src/tasks/access.js';
import type { TaskCommand } from '../src/tasks/access.js';
import { defaultTaskStages } from '../src/tasks/options.js';
import type { TaskWorkPage, TaskWorkReminder, TaskWorkflow } from '../src/tasks/options.js';

export async function verifyTaskWork(
  artifact: string,
  foundation: Pool,
  owner: Pool,
  tasks: Pool,
  withWorkflow = false,
) {
  const load = (file: string) => pathToFileURL(join(artifact, 'dist/src', file)).href;
  const { Store } = (await import(load('store.js'))) as typeof import('../src/store.js');
  const { TasksService } = (await import(
    load('tasks/service.js')
  )) as typeof import('../src/tasks/service.js');
  const { registerTasksRoutes } = (await import(
    load('tasks/routes.js')
  )) as typeof import('../src/tasks/routes.js');
  const { tasksDirectory } = (await import(
    load('tasks-boundary.js')
  )) as typeof import('../src/tasks-boundary.js');
  const { registerTasksWorkRoutes, taskWorkActor } = (await import(
    load('tasks-work-center-boundary.js')
  )) as typeof import('../src/tasks-work-center-boundary.js');
  const store: Store = new Store(foundation);
  const service = new TasksService(tasks, tasksDirectory(store));
  const tenant = ids.tenantA,
    unit = ids.unitA;
  const app = 'aio-tasks';
  const issuer = 'https://127.0.0.1:4518/realms/aio-staging-a';
  const identity = (subject: string) => ({
    issuer,
    subject,
    authenticationMethods: ['pwd', 'otp'],
    authenticatedAt: Math.floor(Date.now() / 1000),
  });
  const portal = (subject: string) => store.principal(identity(subject), 'aio-foundation');
  const actor = async (subject: string, space: string = tenant) =>
    taskWorkActor(store, identity(subject), await portal(subject), space);
  const command = (subject: string = ids.admin): TaskCommand => ({
    tenantId: tenant,
    actor: () => actor(subject),
    reason: 'Diễn tập Công việc AIO',
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
  });

  const transaction = await owner.connect();
  try {
    await transaction.query('BEGIN');
    await transaction.query(
      `INSERT INTO applications(code,name,status,owner_tenant_id)
      VALUES ($1,'Công việc diễn tập','active',$2)`,
      [app, tenant],
    );
    await transaction.query(
      `INSERT INTO permission_catalog(app_code,code,name)
      SELECT $1,code,name FROM jsonb_each_text($2::jsonb) AS permission(code,name)`,
      [app, JSON.stringify(taskPermissions)],
    );
    for (const [account, role, permissions] of [
      [ids.admin, 'e4-operator', Object.keys(taskPermissions)],
      [ids.learner, 'e4-member', ['tasks:view', 'tasks:work']],
    ] as const) {
      await transaction.query(
        'INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,$3)',
        [account, tenant, app],
      );
      await transaction.query(
        'INSERT INTO app_roles(tenant_id,app_code,code,name) VALUES ($1,$2,$3,$3)',
        [tenant, app, role],
      );
      await transaction.query(
        `INSERT INTO role_permissions(tenant_id,app_code,role_code,permission)
        SELECT $1,$2,$3,unnest($4::text[])`,
        [tenant, app, role, permissions],
      );
      await transaction.query(
        'INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), account, tenant, app, role],
      );
    }
    const employment = randomUUID();
    await transaction.query(
      `INSERT INTO employments(id,person_id,tenant_id,legal_entity_id,employee_code)
      VALUES ($1,$2,$3,$4,'NV-E4-OPERATOR')`,
      [employment, ids.admin, tenant, ids.legalA],
    );
    await transaction.query(
      'INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary) VALUES ($1,$2,$3,$4,$5,true)',
      [randomUUID(), tenant, ids.legalA, employment, '70000000-0000-4000-8000-000000000001'],
    );
    await transaction.query('COMMIT');
  } catch (error) {
    await transaction.query('ROLLBACK');
    throw error;
  } finally {
    transaction.release();
  }

  const server = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  server.setErrorHandler((error: { statusCode?: number; code?: string }, _request, reply) =>
    reply.code(error.statusCode ?? 500).send({ error: error.code }),
  );
  const source = 'https://127.0.0.1:4516';
  let subject: string = ids.learner;
  registerTasksWorkRoutes(server, service, (_req, space) => actor(subject, space), source);
  registerTasksRoutes(
    server,
    service,
    () => actor(subject),
    async () => ({ units: [] }),
  );
  const read = async <T>(
    kind: 'assigned' | 'reminders',
    filters: Record<string, string> = {},
    status = 200,
  ) => {
    const url =
      '/api/v1/work-center/tasks/' +
      kind +
      '?' +
      new URLSearchParams({ tenantId: tenant, ...filters });
    const result = await server.inject({ method: 'GET', url });
    assert.equal(result.statusCode, status);
    if (status === 200) assert.equal(result.headers['cache-control'], 'private, no-store');
    return result.json<T>();
  };
  try {
    const project = await service.saveProject(command(), {
      name: 'Dự án E4',
      description: '',
      unitId: unit,
    });
    const member = await service.setMember(command(), project.id, {
      accountId: ids.learner,
      role: 'member',
      active: true,
      expectedRevision: project.revision,
    });
    const due = new Date(Date.now() + 7 * 3600000 - 86400000).toISOString().slice(0, 10);
    const add = (title: string, assigneeId: string, dueOn: string | null = null) =>
      service.saveTask(command(), project.id, {
        title,
        description: 'Mô tả riêng',
        assigneeId,
        participantIds: [],
        dueOn,
        remindDays: dueOn ? 0 : null,
      });
    const assigned = await add('E4 được giao', ids.learner, due);
    const other = await add('E4 dành cho người khác', ids.admin);
    for (let i = 0; i < 26; i++) await add('E4 trang ' + i, ids.learner);

    const first = await read<TaskWorkPage & { source: { baseUrl: string } }>('assigned');
    assert.equal(first.source.baseUrl, source);
    assert.equal(first.items.length, 25);
    assert.equal(first.items[0]?.id, assigned.id);
    assert.equal(first.items[0]?.overdue, true);
    assert.ok(first.nextAfter && !first.items.some(({ id }) => id === other.id));
    assert.deepEqual(Object.keys(first.items[0]!).sort(), [
      'dueOn',
      'id',
      'overdue',
      'projectId',
      'projectName',
      'status',
      'title',
    ]);
    const second = await read<TaskWorkPage>('assigned', { after: first.nextAfter });
    assert.equal(second.items.length, 2);
    assert.equal(second.nextAfter, null);
    assert.equal(new Set([...first.items, ...second.items].map(({ id }) => id)).size, 27);
    assert.equal((await read<TaskWorkPage>('assigned', { after: other.id })).items.length, 0);
    assert.equal((await read<TaskWorkPage>('assigned', { search: 'Dự án E4' })).items.length, 25);
    await read('assigned', { tenantId: ids.tenantB }, 403);

    await service.runReminders();
    const reminders = async () => (await read<{ items: TaskWorkReminder[] }>('reminders')).items;
    const matching = async () =>
      (await read<TaskWorkPage>('assigned', { search: 'E4 được giao' })).items;
    assert.deepEqual(
      (await reminders()).map(({ taskId }) => taskId),
      [assigned.id],
    );
    const moved = await service.handoff(command(), assigned.id, ids.admin, assigned.revision);
    assert.deepEqual(await matching(), []);
    assert.deepEqual(await reminders(), []);
    subject = ids.admin;
    assert.deepEqual(
      (await matching()).map(({ id }) => id),
      [assigned.id],
    );
    await service.progress(command(), assigned.id, {
      expectedRevision: moved.revision,
      status: 'done',
      progress: 100,
    });
    assert.deepEqual(await matching(), []);

    let revision = member.revision;
    if (withWorkflow) {
      const post = async (url: string, input: object, status = 200, key = randomUUID()) => {
        const result = await server.inject({
          method: 'POST',
          url,
          headers: { 'idempotency-key': key },
          payload: { tenantId: tenant, reason: 'Kiểm quy tắc cấu hình E4', ...input },
        });
        assert.equal(result.statusCode, status);
        return result.json<{ id: string; revision: number; error?: string }>();
      };
      const workflow: TaskWorkflow = {
        stages: [
          ...defaultTaskStages.slice(0, 2),
          { code: 'review', phase: 'doing', name: 'Chờ duyệt' },
          defaultTaskStages[2]!,
        ],
        transitions: [
          { from: 'todo', to: 'review', roles: ['member', 'manager'] },
          { from: 'review', to: 'done', roles: ['manager'] },
        ],
      };
      const path = '/api/v1/tasks/projects/' + project.id + '/workflow';
      const progressPath =
        '/api/v1/tasks/items/' + (await add('E4 cần duyệt', ids.learner)).id + '/progress';
      const taskId = progressPath.split('/').at(-2)!;
      const change = { workflow, expectedRevision: revision };
      subject = ids.learner;
      assert.equal((await post(path, change, 403)).error, 'TASKS_PERMISSION_DENIED');
      subject = ids.admin;
      const configKey = randomUUID();
      const configured = await post(path, change, 200, configKey);
      assert.deepEqual(await post(path, change, 200, configKey), configured);
      assert.equal((await post(path, change, 409)).error, 'REVISION_CONFLICT');
      revision = configured.revision;
      const move = { status: 'doing', stageCode: 'review', progress: 60, expectedRevision: 1 };
      subject = ids.learner;
      const key = randomUUID();
      const changed = await post(progressPath, move, 200, key);
      assert.deepEqual(await post(progressPath, move, 200, key), changed);
      assert.equal(
        (
          await post(
            progressPath,
            { status: 'done', progress: 100, expectedRevision: changed.revision },
            403,
          )
        ).error,
        'TASKS_TRANSITION_DENIED',
      );
      const review = (await read<TaskWorkPage>('assigned', { search: 'E4 cần duyệt' })).items[0];
      assert.deepEqual(
        [review?.id, review?.status, review?.stageName],
        [taskId, 'doing', 'Chờ duyệt'],
      );
      const detail = await service.taskDetails(command(ids.learner), taskId);
      assert.deepEqual(detail.item.allowedStages, []);
      assert.deepEqual(
        (await service.tasks(command(ids.learner), project.id, { stageCode: 'review' })).items.map(
          ({ id }) => id,
        ),
        [taskId],
      );
      subject = ids.admin;
      assert.equal(
        (
          await post(
            path,
            {
              workflow: { stages: defaultTaskStages, transitions: [] },
              expectedRevision: revision,
            },
            409,
          )
        ).error,
        'TASKS_STAGE_IN_USE',
      );
      await assert.rejects(
        () =>
          tasks.query(
            `UPDATE task_items SET status='done', progress=100,
        stage_code=NULL,completed_at=now(),revision=revision+1 WHERE id=$1`,
            [taskId],
          ),
        { code: '23514' },
      );
      const completed = await post(progressPath, {
        status: 'done',
        progress: 100,
        expectedRevision: changed.revision,
      });
      assert.equal(completed.revision, 3);
      const counts = (
        await tasks.query(
          `SELECT count(*) FILTER (WHERE action='project.workflow_changed')::int AS configured,
        count(*) FILTER (WHERE task_id=$1 AND action='task.progress')::int AS transitions FROM task_audit WHERE project_id=$2`,
          [taskId, project.id],
        )
      ).rows[0];
      assert.deepEqual(counts, { configured: 1, transitions: 2 });
    }
    subject = ids.learner;
    await service.setMember(command(), project.id, {
      accountId: ids.learner,
      role: 'member',
      active: false,
      expectedRevision: revision,
    });
    assert.deepEqual((await read<TaskWorkPage>('assigned')).items, []);
    await owner.query(
      'UPDATE application_grants SET active=false,revision=revision+1 WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
      [subject, tenant, app],
    );
    assert.equal(
      (await read<{ error: string }>('assigned', {}, 403)).error,
      'APPLICATION_ACCESS_DENIED',
    );
    assert.equal(
      (await read<{ error: string }>('reminders', {}, 403)).error,
      'APPLICATION_ACCESS_DENIED',
    );
    return {
      firstPage: 25,
      secondPage: 2,
      scopedCursor: true,
      minimumFields: true,
      crossTenantStatus: 403,
      handoff: true,
      completion: true,
      reminderDisappeared: true,
      membershipRevocation: true,
      grantRevocationStatus: 403,
      ...(withWorkflow && {
        projectWorkflow: {
          customStage: true,
          roleDenied: 403,
          staleRevision: 409,
          inUseDenied: 409,
          legacyWriterBlockedForConfiguredProject: true,
          replayAndAudit: true,
        },
      }),
    };
  } finally {
    await server.close();
  }
}
