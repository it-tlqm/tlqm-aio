import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { HttpError } from '../src/security.js';
import { loadTasksConfig, tasksDatabaseUrl } from '../src/tasks/database.js';
import { TasksService } from '../src/tasks/service.js';
import type { TaskActor, TaskCommand, TaskPermission } from '../src/tasks/access.js';
import type { ProjectRole, TaskInput } from '../src/tasks/options.js';

const runtime = await loadLocalConfig(),
  config = await loadTasksConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: tasksDatabaseUrl(config, true), max: 6 });
const owner = new pg.Pool({ connectionString: tasksDatabaseUrl(config, true, true), max: 1 });
const tenant = randomUUID(),
  otherTenant = randomUUID(),
  unit = randomUUID(),
  outside = randomUUID();
const people = new Map<string, TaskActor>();
function actor(name: string, permissions: TaskPermission[], unitId = unit) {
  const entry: TaskActor = {
    appCode: 'aio-tasks',
    accountId: randomUUID(),
    personId: randomUUID(),
    name,
    tenantIds: [tenant],
    units: [{ tenantId: tenant, orgUnitId: unitId }],
    permissions: permissions.map((permission) => ({
      tenantId: tenant,
      orgUnitId: unitId,
      permission,
    })),
  };
  people.set(entry.accountId, entry);
  return entry;
}
const manager = actor('Quản lý giả lập', [
  'tasks:manage',
  'tasks:view',
  'tasks:work',
  'tasks:report',
]);
const worker = actor('Thực hiện giả lập', ['tasks:view', 'tasks:work']);
const analyst = actor('Báo cáo giả lập', ['tasks:view', 'tasks:work', 'tasks:report']);
const viewer = actor('Theo dõi giả lập', ['tasks:view']);
const foreign = actor('Khác đơn vị giả lập', ['tasks:view', 'tasks:work'], outside);
const service = new TasksService(pool, {
  async validateUnit(t, u) {
    if (t !== tenant || u !== unit) throw new HttpError(400, 'TASKS_UNIT_UNAVAILABLE');
  },
  async actor(t, id) {
    return t === tenant ? (people.get(id) ?? null) : null;
  },
  async search(t, u) {
    return t === tenant && u === unit
      ? [...people.values()].filter((entry) =>
          entry.units.some(({ orgUnitId }) => orgUnitId === unit),
        )
      : [];
  },
});
const ctx = (who: TaskActor): TaskCommand => ({
  tenantId: tenant,
  actor: async () => structuredClone(people.get(who.accountId) ?? who),
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
  reason: 'Kiểm thử công việc giả lập',
});
const code = (value: string) => (error: unknown) =>
  error instanceof HttpError && error.code === value;
const task = (title: string, overrides: Partial<TaskInput> = {}): TaskInput => ({
  title,
  description: 'Nội dung giả lập',
  dueOn: null,
  remindDays: null,
  assigneeId: null,
  participantIds: [],
  ...overrides,
});
async function project(name: string) {
  let current = await service.saveProject(ctx(manager), {
    unitId: unit,
    name,
    description: 'Dữ liệu giả lập',
  });
  const entries: [TaskActor, ProjectRole][] = [
    [worker, 'member'],
    [analyst, 'member'],
    [viewer, 'viewer'],
  ];
  for (const [person, role] of entries)
    current = await service.setMember(ctx(manager), current.id, {
      accountId: person.accountId,
      role,
      active: true,
      expectedRevision: current.revision,
    });
  return current;
}
before(async () => {
  assert.deepEqual((await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-tasks-test' },
  ]);
});
after(async () => {
  await pool.end();
  await owner.end();
});

test('Project membership scopes tasks, subtasks, progress, handoff, discussion and reports', async () => {
  const p = await project('Dự án kiểm quyền');
  const parent = await service.saveTask(
    ctx(manager),
    p.id,
    task('Chuẩn bị hồ sơ', {
      assigneeId: worker.accountId,
      participantIds: [analyst.accountId],
    }),
  );
  const child = await service.saveTask(
    ctx(manager),
    p.id,
    task('Đối chiếu tài liệu', { assigneeId: analyst.accountId }),
    { parentId: parent.id },
  );
  const hidden = await service.saveTask(ctx(manager), p.id, task('Việc chỉ quản lý xem'));
  assert.deepEqual(
    (await service.tasks(ctx(worker), p.id)).items.map(({ id }) => id),
    [parent.id],
  );
  assert.deepEqual(
    new Set((await service.tasks(ctx(analyst), p.id)).items.map(({ id }) => id)),
    new Set([parent.id, child.id]),
  );
  assert.equal((await service.tasks(ctx(viewer), p.id)).items.length, 3);
  assert.equal((await service.taskDetails(ctx(worker), parent.id)).children.length, 0);
  assert.equal((await service.taskDetails(ctx(manager), parent.id)).children[0]?.id, child.id);
  assert.equal((await service.projects(ctx(foreign))).items.length, 0);
  await assert.rejects(service.projectDetails(ctx(foreign), p.id), code('TASKS_PERMISSION_DENIED'));
  await assert.rejects(
    service.projectDetails({ ...ctx(worker), tenantId: otherTenant }, p.id),
    code('TASKS_PERMISSION_DENIED'),
  );
  await assert.rejects(
    service.taskDetails(ctx(analyst), hidden.id),
    code('TASKS_PERMISSION_DENIED'),
  );
  await assert.rejects(
    service.saveTask(ctx(manager), p.id, task('Việc con cấp hai'), { parentId: child.id }),
    code('TASKS_PERMISSION_DENIED'),
  );
  await assert.rejects(service.report(ctx(viewer), p.id), code('TASKS_PERMISSION_DENIED'));
  assert.equal((await service.report(ctx(manager), p.id)).total, 3);
  assert.equal((await service.report(ctx(analyst), p.id)).total, 2);
  await assert.rejects(
    service.comment(ctx(viewer), parent.id, 'Người xem ghi bình luận'),
    code('TASKS_PERMISSION_DENIED'),
  );

  const message = ctx(analyst);
  const comment = await service.comment(message, parent.id, 'Đã đối chiếu tài liệu.');
  assert.deepEqual(await service.comment(message, parent.id, 'Đã đối chiếu tài liệu.'), comment);
  assert.equal((await service.taskDetails(ctx(worker), parent.id)).comments.length, 1);
  const active = await service.progress(ctx(worker), parent.id, {
    status: 'doing',
    progress: 40,
    expectedRevision: parent.revision,
  });
  const sent = await service.handoff(ctx(worker), parent.id, analyst.accountId, active.revision);
  await assert.rejects(
    service.taskDetails(ctx(worker), parent.id),
    code('TASKS_PERMISSION_DENIED'),
  );
  const accepted = await service.taskDetails(ctx(analyst), parent.id);
  assert.equal(accepted.item.assignee?.accountId, analyst.accountId);
  assert.equal(accepted.item.progress, 40);
  assert.equal(accepted.history[0]?.action, 'task.handoff');
  const done = await service.progress(ctx(analyst), parent.id, {
    status: 'done',
    progress: 100,
    expectedRevision: sent.revision,
  });
  assert.equal((await service.report(ctx(analyst), p.id)).percentDone, 50);
  await assert.rejects(
    service.handoff(ctx(manager), parent.id, worker.accountId, done.revision),
    code('TASKS_DONE'),
  );
  const archived = await service.saveProject(
    ctx(manager),
    { unitId: unit, name: 'Dự án kiểm quyền', description: 'Dữ liệu giả lập', archived: true },
    p.id,
    p.revision,
  );
  assert.equal(
    (await service.projectDetails(ctx(manager), p.id)).project.revision,
    archived.revision,
  );
  await assert.rejects(
    service.comment(ctx(analyst), parent.id, 'Dự án đã lưu trữ'),
    code('TASKS_PERMISSION_DENIED'),
  );
});

test('Reminders are unique across workers and hide immediately after handoff, role revocation and completion', async () => {
  const p = await project('Dự án nhắc hạn');
  const dueOn = new Date(Date.now() + 7 * 3600000 - 86400000).toISOString().slice(0, 10);
  const row = await service.saveTask(
    ctx(manager),
    p.id,
    task('Việc quá hạn', { assigneeId: worker.accountId, dueOn, remindDays: 0 }),
  );
  await Promise.all([service.runReminders(), service.runReminders()]);
  const before = (await service.reminders(ctx(worker))).items.filter(
    ({ taskId }) => taskId === row.id,
  );
  assert.equal(before.length, 1);
  assert.equal(before[0]?.kind, 'overdue');
  const moved = await service.handoff(ctx(manager), row.id, analyst.accountId, row.revision);
  assert(!(await service.reminders(ctx(worker))).items.some(({ taskId }) => taskId === row.id));
  await service.runReminders();
  assert.equal(
    (await service.reminders(ctx(analyst))).items.filter(({ taskId }) => taskId === row.id).length,
    1,
  );
  const old = people.get(analyst.accountId)!;
  try {
    people.set(analyst.accountId, {
      ...old,
      permissions: old.permissions.filter(({ permission }) => permission !== 'tasks:work'),
    });
    assert(!(await service.reminders(ctx(analyst))).items.some(({ taskId }) => taskId === row.id));
    await assert.rejects(
      service.progress(ctx(analyst), row.id, {
        status: 'doing',
        progress: 10,
        expectedRevision: moved.revision,
      }),
      code('TASKS_PERMISSION_DENIED'),
    );
  } finally {
    people.set(analyst.accountId, old);
  }
  await service.progress(ctx(analyst), row.id, {
    status: 'done',
    progress: 100,
    expectedRevision: moved.revision,
  });
  assert(!(await service.reminders(ctx(analyst))).items.some(({ taskId }) => taskId === row.id));
});

test('Task update CAS, replay and failed audit preserve one transactional state', async () => {
  const p = await project('Dự án kiểm giao dịch');
  const row = await service.saveTask(
    ctx(manager),
    p.id,
    task('Việc có audit', { assigneeId: worker.accountId }),
  );
  const key = ctx(worker);
  const input = { status: 'doing', progress: 10, expectedRevision: row.revision } as const;
  const fault = 'test_tasks_audit_' + randomUUID().replaceAll('-', '');
  assert.deepEqual((await owner.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-tasks-test' },
  ]);
  await owner.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.task_id='${row.id}' AND NEW.action='task.progress' THEN RAISE EXCEPTION 'synthetic tasks audit failure'; END IF; RETURN NEW; END $$`);
  await owner.query(
    `CREATE TRIGGER ${fault} BEFORE INSERT ON task_audit FOR EACH ROW EXECUTE FUNCTION ${fault}()`,
  );
  try {
    await assert.rejects(service.progress(key, row.id, input), /synthetic tasks audit failure/);
    assert.equal((await service.taskDetails(ctx(worker), row.id)).item.revision, row.revision);
    assert.equal(
      (
        await pool.query('SELECT 1 FROM task_receipts WHERE tenant_id=$1 AND idempotency_key=$2', [
          tenant,
          key.idempotencyKey,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await owner.query(`DROP TRIGGER ${fault} ON task_audit`);
    await owner.query(`DROP FUNCTION ${fault}()`);
  }
  const applied = await service.progress(key, row.id, input);
  assert.deepEqual(await service.progress(key, row.id, input), applied);
  await assert.rejects(
    service.progress(key, row.id, { ...input, progress: 12 }),
    code('IDEMPOTENCY_KEY_REUSED'),
  );
  const conflicting = await Promise.allSettled(
    [25, 60].map((progress) =>
      service.progress(ctx(worker), row.id, {
        status: 'doing',
        progress,
        expectedRevision: applied.revision,
      }),
    ),
  );
  assert.equal(conflicting.filter(({ status }) => status === 'fulfilled').length, 1);
  assert(
    code('REVISION_CONFLICT')(
      (conflicting.find(({ status }) => status === 'rejected') as PromiseRejectedResult).reason,
    ),
  );
  await service.setMember(ctx(manager), p.id, {
    accountId: worker.accountId,
    role: 'member',
    active: false,
    expectedRevision: p.revision,
  });
  await assert.rejects(service.progress(key, row.id, input), code('TASKS_PERMISSION_DENIED'));
});
