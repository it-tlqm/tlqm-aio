import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { WorkflowsService } from '../src/workflows/service.js';
import { WorkflowWorkCenter } from '../src/workflows/work-center.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import type {
  WorkflowActor,
  WorkflowCommand,
  WorkflowPermission,
} from '../src/workflows/access.js';
import { HttpError } from '../src/security.js';
const runtime = await loadLocalConfig(),
  config = await loadWorkflowsConfig(runtime.instanceId),
  pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 5 });
const tenant = randomUUID(),
  unit = randomUUID(),
  otherUnit = randomUUID();
function actor(permissions: WorkflowPermission[], scope: string | null = unit): WorkflowActor {
  return {
    appCode: 'aio-workflows',
    accountId: randomUUID(),
    personId: randomUUID(),
    tenantIds: [tenant],
    units: [{ tenantId: tenant, orgUnitId: scope ?? unit }],
    permissions: permissions.map((permission) => ({
      tenantId: tenant,
      permission,
      orgUnitId: scope,
    })),
  };
}
const designer = actor(['workflows:design', 'workflows:publish'], null),
  manager = actor(['workflows:manage', 'workflows:report']),
  sender = actor(['workflows:start']),
  handler = actor(['workflows:act']),
  replacement = actor(['workflows:act']);
const actors = new Map([handler, replacement].map((a) => [a.accountId, a]));
const workflows = new WorkflowsService(pool, {
  async validateUnit(t, u) {
    if (t !== tenant || ![unit, otherUnit].some((value) => value === u))
      throw new HttpError(400, 'WORKFLOW_REFERENCE_DENIED');
  },
  async assignee(t, u, id) {
    const a = actors.get(id);
    if (
      t !== tenant ||
      !a ||
      !a.permissions.some(
        (p) => p.permission === 'workflows:act' && (p.orgUnitId === null || p.orgUnitId === u),
      )
    )
      throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
    return {
      personId: a.personId,
      name: id === handler.accountId ? 'Người nhận' : 'Người nhận thay',
    };
  },
});
const hub = new WorkflowWorkCenter(workflows),
  c = (a: WorkflowActor): WorkflowCommand => ({
    actor: async () => structuredClone(a),
    tenantId: tenant,
    idempotencyKey: randomUUID(),
    reason: 'Kiểm thử trung tâm công việc giả lập',
    requestId: randomUUID(),
  });
let published: Awaited<ReturnType<WorkflowsService['publish']>>;
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-workflows-test',
  );
  const spec = workflowTemplate();
  spec.audienceUnits = [unit];
  spec.positions = {};
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Bắt đầu', next: 'review' },
    {
      id: 'review',
      kind: 'approval',
      label: 'Duyệt',
      assignee: handler.accountId,
      next: 'end',
      form: null,
      dueHours: 1,
    },
    { id: 'end', kind: 'end', label: 'Xong' },
  ];
  const draft = await workflows.saveDefinition(c(designer), {
    code: 'hub-' + randomUUID().slice(0, 8),
    orgUnitId: unit,
    spec,
  });
  published = await workflows.publish(c(designer), draft.id, draft.revision);
});
after(() => pool.end());

async function start() {
  return workflows.start(c(sender), {
    definitionId: published.definition.id,
    versionId: published.version.id,
    unitId: unit,
    title: 'Đề nghị ' + randomUUID().slice(0, 8),
    answers: { purpose: 'Dữ liệu giả lập', amount: 100, needed_on: '2026-12-01' },
  });
}
const pending = async (id: string) =>
  (await workflows.detail(c(sender), id)).tasks.find((t) => t.status === 'pending')!;
test('assignment notification and work list enforce current scope, read ownership, revision and revocation', async () => {
  const run = await start(),
    notice = (await hub.notifications(c(handler), 0, false)).items.find((n) =>
      n.route.endsWith(run.id),
    )!;
  assert.ok(notice);
  const key = c(handler);
  const read = await hub.mark(key, notice.id, true, 1);
  assert.deepEqual(await hub.mark(key, notice.id, true, 1), read);
  await assert.rejects(() => hub.mark(c(handler), notice.id, false, 1), {
    code: 'REVISION_CONFLICT',
  });
  await assert.rejects(() => hub.mark(c(replacement), notice.id, true, 1), {
    code: 'WORK_CENTER_NOTIFICATION_UNAVAILABLE',
  });
  assert.equal(
    (await hub.work(c(handler), { view: 'assigned', page: 0 })).items.some((i) => i.id === run.id),
    true,
  );
  const permissions = handler.permissions;
  handler.permissions = [];
  assert.equal((await hub.notifications(c(handler), 0, false)).unreadCount, 0);
  assert.equal((await hub.notifications(c(handler), 0, false)).items.length, 0);
  assert.equal((await hub.work(c(handler), { view: 'assigned', page: 0 })).total, 0);
  handler.permissions = permissions;
  const task = await pending(run.id);
  await workflows.reassign(c(manager), task.id, {
    expectedRevision: task.revision,
    accountId: replacement.accountId,
  });
  assert.equal(
    (await hub.notifications(c(handler), 0, false)).items.some((n) => n.id === notice.id),
    false,
  );
  assert.equal(
    (await hub.notifications(c(replacement), 0, false)).items.some((n) => n.route.endsWith(run.id)),
    true,
  );
  await assert.rejects(
    () => hub.notifications({ ...c(handler), tenantId: randomUUID() }, 0, false),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  await assert.rejects(() => hub.work(c(handler), { view: 'managed', page: 0 }), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
});
test('return and completion notifications reach only the owner; manager aggregates use authorized units', async () => {
  const run = await start(),
    task = await pending(run.id);
  await workflows.act(c(handler), task.id, {
    expectedRevision: task.revision,
    action: 'return',
    answers: {},
  });
  assert.ok(
    (await hub.notifications(c(sender), 0, false)).items.some(
      (n) => n.kind === 'returned' && n.route.endsWith(run.id),
    ),
  );
  assert.ok(
    (await hub.work(c(sender), { view: 'returned', page: 0 })).items.some((r) => r.id === run.id),
  );
  const run2 = await start(),
    task2 = await pending(run2.id);
  await workflows.act(c(handler), task2.id, {
    expectedRevision: task2.revision,
    action: 'approve',
    answers: {},
  });
  assert.ok(
    (await hub.notifications(c(sender), 0, false)).items.some(
      (n) => n.kind === 'completed' && n.route.endsWith(run2.id),
    ),
  );
  assert.equal(
    (await hub.notifications(c(replacement), 0, false)).items.some((n) =>
      n.route.endsWith(run2.id),
    ),
    false,
  );
  const dashboard = await hub.work(c(manager), { view: 'managed', page: 0 });
  assert.ok(dashboard.total > 0);
  assert.deepEqual(
    dashboard.groups?.units.map((g) => g.id),
    [unit],
  );
  const scoped = actor(['workflows:report'], otherUnit);
  assert.equal((await hub.work(c(scoped), { view: 'managed', page: 0 })).total, 0);
});
test('durable reminders survive new worker instances and concurrency without duplicates, respect configuration and current rights', async () => {
  const run = await start();
  const policy = await hub.savePolicy(c(manager), {
    unitId: unit,
    enabled: true,
    beforeMinutes: 120,
    overdueMinutes: 1,
    expectedRevision: 0,
  });
  const other = new WorkflowWorkCenter(workflows);
  await Promise.all([hub.remind(), other.remind(), hub.remind()]);
  await new WorkflowWorkCenter(workflows).remind();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM workflow_notifications WHERE tenant_id=$1 AND run_id=$2 AND kind='due_soon'",
        [tenant, run.id],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    () =>
      hub.savePolicy(c(manager), {
        unitId: unit,
        enabled: false,
        beforeMinutes: 120,
        overdueMinutes: 1,
        expectedRevision: 0,
      }),
    { code: 'REVISION_CONFLICT' },
  );
  await assert.rejects(
    () =>
      hub.savePolicy(c(handler), {
        unitId: unit,
        enabled: false,
        beforeMinutes: 120,
        overdueMinutes: 1,
        expectedRevision: policy.revision,
      }),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  await hub.savePolicy(c(manager), {
    unitId: unit,
    enabled: false,
    beforeMinutes: 120,
    overdueMinutes: 1,
    expectedRevision: policy.revision,
  });
  const later = await start();
  await hub.remind();
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM workflow_notifications WHERE tenant_id=$1 AND run_id=$2 AND kind='due_soon'",
        [tenant, later.id],
      )
    ).rowCount,
    0,
  );
  const current = (await hub.policies(c(manager))).items[0];
  await hub.savePolicy(c(manager), {
    unitId: unit,
    enabled: true,
    beforeMinutes: 120,
    overdueMinutes: 1,
    expectedRevision: current.revision,
  });
  const permissions = handler.permissions;
  handler.permissions = [];
  await hub.remind();
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM workflow_notifications WHERE tenant_id=$1 AND run_id=$2 AND kind='due_soon'",
        [tenant, later.id],
      )
    ).rowCount,
    0,
  );
  handler.permissions = permissions;
  await hub.remind();
  assert.ok((await hub.policies(c(manager))).worker?.last_completed_at);
});
test('overdue fixtures create one overdue alert, completed work is not reminded, and rollback keeps no notification', async () => {
  const source = await start(),
    id = randomUUID(),
    taskId = randomUUID();
  await pool.query(
    "INSERT INTO workflow_runs(id,tenant_id,definition_id,version_id,org_unit_id,owner_account_id,owner_person_id,title,status,inputs,current_step) SELECT $1,tenant_id,definition_id,version_id,org_unit_id,owner_account_id,owner_person_id,'Quá hạn giả lập','running',inputs,'review' FROM workflow_runs WHERE id=$2",
    [id, source.id],
  );
  await pool.query(
    "INSERT INTO workflow_tasks(id,tenant_id,run_id,round,node_id,label,kind,assignee_account_id,assignee_name,due_at) VALUES($1,$2,$3,1,'review','Duyệt quá hạn','approval',$4,'Người nhận',now()-interval '2 hours')",
    [taskId, tenant, id, handler.accountId],
  );
  await hub.remind();
  await hub.remind();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM workflow_notifications WHERE tenant_id=$1 AND run_id=$2 AND kind='overdue'",
        [tenant, id],
      )
    ).rows[0].n,
    1,
  );
  assert.ok(
    (await hub.work(c(handler), { view: 'overdue', page: 0 })).items.some((r) => r.id === id),
  );
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      'UPDATE workflow_tasks SET assignee_account_id=$1,revision=revision+1 WHERE id=$2',
      [replacement.accountId, taskId],
    );
    await db.query('ROLLBACK');
  } finally {
    db.release();
  }
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM workflow_notifications WHERE tenant_id=$1 AND task_id=$2 AND recipient_account_id=$3',
        [tenant, taskId, replacement.accountId],
      )
    ).rowCount,
    0,
  );
  await workflows.act(c(handler), taskId, { expectedRevision: 1, action: 'approve', answers: {} });
  assert.equal(
    (await hub.notifications(c(handler), 0, false)).items.some((n) => n.route.endsWith(id)),
    false,
  );
});

test('a failing tenant rolls back its reminders, records failure, allows other tenants and retries later', async () => {
  const run = await start(),
    otherTenant = 'ffffffff-ffff-4fff-8fff-' + randomUUID().replaceAll('-', '').slice(0, 12);
  await pool.query(
    'INSERT INTO workflow_reminder_policies(tenant_id,org_unit_id,enabled,before_minutes,overdue_minutes) VALUES($1,$2,true,120,1) ON CONFLICT(tenant_id,org_unit_id) DO UPDATE SET enabled=true,before_minutes=120',
    [tenant, unit],
  );
  await pool.query(
    'INSERT INTO workflow_reminder_policies(tenant_id,org_unit_id,enabled) VALUES($1,$2,true)',
    [otherTenant, otherUnit],
  );
  const original = workflows.assignment.eligible.bind(workflows.assignment);
  workflows.assignment.eligible = async (...args) => {
    if (args[1] === tenant) throw new HttpError(503, 'SOURCE_UNAVAILABLE');
    return original(...args);
  };
  try {
    const result = await hub.remind();
    assert.ok(result.failedTenants >= 1);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM workflow_notifications WHERE tenant_id=$1 AND run_id=$2 AND kind='due_soon'",
          [tenant, run.id],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT last_error_code FROM workflow_reminder_runs WHERE tenant_id=$1', [
          tenant,
        ])
      ).rows[0].last_error_code,
      'REMINDER_FAILED',
    );
    assert.ok(
      (
        await pool.query(
          'SELECT last_completed_at FROM workflow_reminder_runs WHERE tenant_id=$1',
          [otherTenant],
        )
      ).rows[0].last_completed_at,
    );
  } finally {
    workflows.assignment.eligible = original;
    await pool.query('UPDATE workflow_reminder_policies SET enabled=false WHERE tenant_id=$1', [
      otherTenant,
    ]);
  }
  await hub.remind();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM workflow_notifications WHERE tenant_id=$1 AND run_id=$2 AND kind='due_soon'",
        [tenant, run.id],
      )
    ).rows[0].n,
    1,
  );
  await pool.query('UPDATE workflow_reminder_policies SET enabled=false WHERE tenant_id=$1', [
    tenant,
  ]);
});
