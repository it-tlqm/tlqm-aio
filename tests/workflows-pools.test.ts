import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { WorkflowsService } from '../src/workflows/service.js';
import type { Task } from '../src/workflows/service.js';
import { WorkflowWorkCenter } from '../src/workflows/work-center.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { workflowDeadline } from '../src/workflows/calendar.js';
import { parseWorkflow } from '../src/workflows/contracts.js';
import type { HumanStep } from '../src/workflows/contracts.js';
import type {
  WorkflowActor,
  WorkflowCommand,
  WorkflowPermission,
} from '../src/workflows/access.js';
import { HttpError } from '../src/security.js';

const runtime = await loadLocalConfig(),
  config = await loadWorkflowsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 6 });
const tenant = randomUUID(),
  unit = randomUUID();
const actor = (permissions: WorkflowPermission[]): WorkflowActor => ({
  appCode: 'aio-workflows',
  accountId: randomUUID(),
  personId: randomUUID(),
  tenantIds: [tenant],
  units: [{ tenantId: tenant, orgUnitId: unit }],
  permissions: permissions.map((permission) => ({ tenantId: tenant, orgUnitId: unit, permission })),
});
const manager = actor([
    'workflows:design',
    'workflows:publish',
    'workflows:manage',
    'workflows:report',
  ]),
  requester = actor(['workflows:start']);
const people = new Map<string, WorkflowActor>();
function voter() {
  const a = actor(['workflows:act']);
  people.set(a.accountId, a);
  return a;
}
const service = new WorkflowsService(
  pool,
  {
    async validateUnit(t, u) {
      if (t !== tenant || u !== unit) throw new HttpError(400, 'WORKFLOW_REFERENCE_DENIED');
    },
    async assignee(t, u, id) {
      const a = people.get(id);
      if (
        t !== tenant ||
        u !== unit ||
        !a?.permissions.some((p) => p.permission === 'workflows:act')
      )
        throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
      return { name: 'Thành viên ' + id.slice(0, 6), personId: a.personId };
    },
  },
  undefined,
  'synthetic-pool-report-key',
);
const work = new WorkflowWorkCenter(service);
const c = (a: WorkflowActor): WorkflowCommand => ({
  tenantId: tenant,
  actor: async () => structuredClone(a),
  reason: 'Kiểm thử phê duyệt nhóm giả lập',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
});
const isCode = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;
async function setup(
  mode: 'all' | 'any' | 'quorum' = 'all',
  options: {
    people?: WorkflowActor[];
    patch?: Partial<HumanStep>;
    quorum?: number;
    business?: boolean;
    handoff?: boolean;
  } = {},
) {
  const members = options.people ?? [voter(), voter(), voter()];
  const group = await service.saveGroup(c(manager), {
    name: 'Hội đồng giả lập',
    orgUnitId: unit,
    accountIds: members.map((m) => m.accountId),
    active: true,
  });
  const spec = workflowTemplate('blank');
  spec.schemaVersion = 4;
  spec.audienceUnits = [unit];
  spec.positions = {};
  spec.nodes = [
    { id: 'start', label: 'Gửi', kind: 'start', next: 'review' },
    {
      id: 'review',
      label: 'Hội đồng duyệt',
      kind: 'approval',
      assignee: '',
      assigneeRule: {
        kind: 'pool',
        groupId: group.id,
        mode,
        ...(mode === 'quorum' ? { quorum: options.quorum ?? 2 } : {}),
      },
      dueHours: 24,
      deadlineMinutes: 1,
      next: 'end',
      form: null,
      ...options.patch,
    },
    { id: 'end', kind: 'end', label: 'Hoàn tất' },
  ];
  if (options.handoff) {
    spec.schemaVersion = 5;
    (spec.nodes[1] as HumanStep).next = 'fulfil';
    spec.nodes.push({
      id: 'fulfil',
      kind: 'task',
      label: 'Xử lý sau đồng duyệt',
      assignee: '',
      assigneeRule: { kind: 'group', groupId: group.id, selectionTiming: 'handoff' },
      dueHours: 24,
      next: 'end',
      form: null,
    });
  }
  if (options.business) {
    spec.calendar = {
      offsetMinutes: 420,
      weekdays: [1, 2, 3, 4, 5],
      shifts: [
        { start: 480, end: 720 },
        { start: 780, end: 1020 },
      ],
      holidays: [],
    };
    (spec.nodes[1] as HumanStep).deadlineMode = 'business';
  }
  const draft = await service.saveDefinition(c(manager), {
    code: 'pool-' + randomUUID().slice(0, 8),
    orgUnitId: unit,
    spec,
  });
  const published = await service.publish(c(manager), draft.id, draft.revision);
  const run = await service.start(c(requester), {
    definitionId: draft.id,
    versionId: published.version.id,
    unitId: unit,
    title: 'Đề nghị hội đồng giả lập',
    answers: { purpose: 'Kiểm thử', requested_on: '2026-11-11' },
  });
  const detail = await service.detail(c(requester), run.id),
    task = detail.tasks.find((t) => t.status === 'pending')!;
  return { group, spec, published, run, task, members };
}
const vote = (
  who: WorkflowActor,
  task: Task,
  action: 'approve' | 'reject' | 'return' = 'approve',
  context = c(who),
) => service.act(context, task.id, { expectedRevision: task.revision, action, answers: {} });
before(async () =>
  assert.deepEqual((await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-workflows-test' },
  ]),
);
after(async () => pool.end());

test('Performance reports count each pooled vote once and keep one task and run', async () => {
  const first = await setup('quorum', {
    quorum: 2,
    patch: {
      form: {
        schemaVersion: 1,
        title: 'Điểm duyệt',
        sections: [
          {
            id: 'score',
            title: 'Điểm duyệt',
            fields: [{ id: 'points', label: 'Điểm phiếu', type: 'number', required: true }],
          },
        ],
      },
    },
  });
  const scoredVote = (index: number, points: number) =>
    service.act(c(first.members[index]!), first.task.id, {
      expectedRevision: first.task.revision,
      action: 'approve',
      answers: { points },
    });
  await scoredVote(0, 0.1);
  const date = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const input = {
    dataset: 'decisions',
    groupBy: 'person',
    measure: 'people',
    from: date,
    to: date,
    versionId: first.run.version_id,
  } as const;
  const partial = await service.performanceReport(c(manager), input, 1);
  assert.equal(partial.totals.rows, 1);
  assert.equal((await scoredVote(1, 0.2)).status, 'completed');
  const report = await service.performanceReport(c(manager), input, 1);
  assert.deepEqual(
    [report.totals.rows, report.totals.people, report.totals.attempts, report.totals.runs],
    [2, 2, 1, 1],
  );
  assert.equal(report.groupCount, 2);
  for (const group of report.groups) {
    const detail = await service.performanceReportDetail(
      c(manager),
      input,
      group.key,
      1,
      report.observedAt,
    );
    assert.equal(detail.total, 1);
    assert.equal(detail.items[0]?.taskId, first.task.id);
    assert.equal(detail.items[0]?.status, 'approve');
    assert.equal(Object.hasOwn(detail.items[0]!, 'personId'), false);
  }
  const business = {
    ...input,
    groupBy: 'field',
    groupField: 'step.review.points',
    measure: 'fieldValue',
    metricField: 'step.review.points',
    aggregate: 'sum',
    columns: 'step.review.points',
  } as const;
  const scored = await service.performanceReport(c(manager), business, 1);
  assert.equal(scored.totals.fieldValue, '0.3');
  assert.deepEqual(
    scored.groups.map(({ label, metrics }) => [label, metrics.fieldValue]),
    [
      ['0.2', '0.2'],
      ['0.1', '0.1'],
    ],
  );
  for (const group of scored.groups) {
    const { items } = await service.performanceReportDetail(
      c(manager),
      business,
      group.key,
      1,
      scored.observedAt,
    );
    assert.deepEqual(
      items.map(({ taskId, fields }) => [taskId, fields?.['step.review.points']]),
      [[first.task.id, group.label]],
    );
  }
});

test('A submission can be recalled by its owner until a pooled member votes', async () => {
  const first = await setup();
  const command = c(requester);
  const recall = { expectedRevision: first.run.revision };
  assert.equal((await service.detail(c(requester), first.run.id)).canRecallSubmission, true);
  await assert.rejects(
    () => service.recall(c(manager), first.run.id, recall),
    isCode('WORKFLOW_PERMISSION_DENIED'),
  );
  const units = requester.units;
  requester.units = [];
  try {
    await assert.rejects(
      () => service.recall(c(requester), first.run.id, recall),
      isCode('WORKFLOW_PERMISSION_DENIED'),
    );
  } finally {
    requester.units = units;
  }
  const withdrawn = await service.recall(command, first.run.id, recall);
  assert.equal(withdrawn.status, 'needs_revision');
  assert.deepEqual(await service.recall(command, first.run.id, recall), withdrawn);
  const history = await service.detail(c(requester), first.run.id);
  assert.equal(history.tasks[0].status, 'cancelled');
  assert.equal(history.history.filter((event) => event.action === 'run.recalled').length, 1);
  await service.resubmit(c(requester), first.run.id, {
    expectedRevision: withdrawn.revision,
    answers: { purpose: 'Đã bổ sung', requested_on: '2026-11-11' },
  });
  const pending = (await service.detail(c(requester), first.run.id)).tasks.find(
    (t) => t.status === 'pending',
  )!;
  const partial = await vote(first.members[0]!, pending);
  assert.equal(partial.status, 'running');
  assert.equal((await service.detail(c(requester), first.run.id)).canRecallSubmission, false);
  await assert.rejects(
    () => service.recall(c(requester), first.run.id, { expectedRevision: partial.revision }),
    isCode('WORKFLOW_RECALL_UNAVAILABLE'),
  );

  const racing = await setup();
  const results = await Promise.allSettled([
    service.recall(c(requester), racing.run.id, { expectedRevision: racing.run.revision }),
    vote(racing.members[0]!, racing.task),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const final = await service.detail(c(requester), racing.run.id);
  assert.equal(
    final.tasks[0].members.some((member: { action: string | null }) => member.action === 'approve'),
    final.run.status === 'running',
  );
});

test('all pooled voters act concurrently with one terminal transition and immutable per-person votes', async () => {
  const s = await setup();
  assert.equal(s.task.members.length, 3);
  assert.equal(new Date(s.task.due_at).getTime() - new Date(s.task.created_at).getTime(), 60000);
  for (const m of s.members) {
    assert.equal((await service.detail(c(m), s.run.id)).canAct, true);
    assert.ok((await service.runs(c(m), 'inbox')).items.some((r) => r.id === s.run.id));
  }
  const commands = s.members.map((m) => c(m));
  const results = await Promise.all(
    s.members.map((m, i) => vote(m, s.task, 'approve', commands[i])),
  );
  assert.equal(results.filter((r) => r.status === 'completed').length, 1);
  const detail = await service.detail(c(requester), s.run.id);
  assert.equal(
    detail.tasks[0].members.filter((m: { action: string }) => m.action === 'approve').length,
    3,
  );
  assert.equal(detail.history.filter((h) => h.action === 'run.completed').length, 1);
  assert.deepEqual(await vote(s.members[0]!, s.task, 'approve', commands[0]), results[0]);
  await assert.rejects(
    pool.query(
      "UPDATE workflow_approval_votes SET reason='changed' WHERE tenant_id=$1 AND task_id=$2",
      [tenant, s.task.id],
    ),
  );
  await assert.rejects(
    pool.query(
      "UPDATE workflow_tasks SET approval_policy='{}',revision=revision+1 WHERE tenant_id=$1 AND id=$2",
      [tenant, s.task.id],
    ),
  );
});
test('quorum hides a voted task from personal work and reminders but preserves decisions and manager totals', async () => {
  const s = await setup('quorum');
  const first = s.members[0]!,
    second = s.members[1]!;
  const policy = (await work.policies(c(manager))).items[0];
  await work.savePolicy(c(manager), {
    unitId: unit,
    enabled: true,
    beforeMinutes: 60,
    overdueMinutes: 1,
    expectedRevision: policy?.revision ?? 0,
  });
  await Promise.all([work.remind(), work.remind()]);
  const notices = await work.notifications(c(first), 0, false);
  assert.equal(notices.items.filter((n) => n.route.endsWith(s.run.id)).length, 2);
  await vote(first, s.task);
  assert.equal((await service.detail(c(first), s.run.id)).canAct, false);
  assert.ok(!(await service.runs(c(first), 'inbox')).items.some((r) => r.id === s.run.id));
  const processed = (await service.runs(c(first), 'done')).items.find((r) => r.id === s.run.id);
  assert.equal(processed?.task_id, s.task.id);
  assert.equal(processed?.handled_action, 'approve');
  assert.equal(processed?.status, 'running');
  assert.ok(!(await service.runs(c(second), 'done')).items.some((r) => r.id === s.run.id));
  assert.ok(
    !(await work.work(c(first), { view: 'assigned', page: 0 })).items.some(
      (r) => r.id === s.run.id,
    ),
  );
  assert.ok(
    !(await work.notifications(c(first), 0, false)).items.some((n) => n.route.endsWith(s.run.id)),
  );
  const managed = await work.work(c(manager), {
    view: 'managed',
    page: 0,
    search: 'Đề nghị hội đồng',
  });
  assert.ok(managed.groups?.assignees.some((g) => g.id === second.accountId));
  await assert.rejects(vote(first, s.task), isCode('WORKFLOW_ALREADY_VOTED'));
  await vote(second, s.task);
  assert.equal((await service.detail(c(requester), s.run.id)).run.status, 'completed');
});
test('any, veto and disabled return are explicit policies, and each resubmission gets fresh members', async () => {
  const any = await setup('any');
  await vote(any.members[0]!, any.task);
  assert.equal((await service.detail(c(requester), any.run.id)).run.status, 'completed');
  const denied = await setup('all', { patch: { allowReturn: false } });
  await assert.rejects(
    vote(denied.members[0]!, denied.task, 'return'),
    isCode('WORKFLOW_RETURN_DISABLED'),
  );
  await vote(denied.members[0]!, denied.task, 'reject');
  assert.equal((await service.detail(c(requester), denied.run.id)).run.status, 'rejected');
  const returned = await setup();
  const r = await vote(returned.members[0]!, returned.task, 'return');
  assert.equal(r.status, 'needs_revision');
  await service.resubmit(c(requester), r.id, {
    expectedRevision: r.revision,
    answers: { purpose: 'Bổ sung', requested_on: '2026-11-11' },
  });
  const detail = await service.detail(c(requester), r.id);
  assert.equal(detail.tasks.length, 2);
  assert.equal(detail.tasks[1].members.filter((m: { action: string }) => m.action).length, 0);
});
test('Only a decisive pooled vote previews a handoff and a missing choice rolls back the vote', async () => {
  const s = await setup('quorum', { handoff: true });
  const [first, second, recipient] = s.members as [WorkflowActor, WorkflowActor, WorkflowActor];
  const action = { expectedRevision: s.task.revision, action: 'approve' as const, answers: {} };
  const handoff = { stepId: 'fulfil', accountId: recipient.accountId };
  assert.deepEqual(await service.previewHandoff(c(first), s.task.id, action), { selection: null });
  await assert.rejects(
    () => service.act(c(first), s.task.id, { ...action, handoff }),
    isCode('WORKFLOW_HANDOFF_CHANGED'),
  );
  await service.act(c(first), s.task.id, action);
  const preview = await service.previewHandoff(c(second), s.task.id, action);
  assert.equal(preview.selection?.stepId, handoff.stepId);
  assert.ok(
    preview.selection?.candidates.some((candidate) => candidate.id === recipient.accountId),
  );
  await assert.rejects(
    () => service.act(c(second), s.task.id, action),
    isCode('WORKFLOW_HANDOFF_REQUIRED'),
  );
  const retained = await service.detail(c(requester), s.run.id);
  assert.equal(
    retained.tasks[0].members.filter((member: { action: string }) => member.action === 'approve')
      .length,
    1,
  );
  const command = c(second);
  const next = await service.act(command, s.task.id, { ...action, handoff });
  assert.deepEqual(await service.act(command, s.task.id, { ...action, handoff }), next);
  const detail = await service.detail(c(requester), s.run.id);
  assert.equal(
    detail.tasks.find((task) => task.status === 'pending')?.assignee_account_id,
    recipient.accountId,
  );
  assert.equal(
    detail.history.filter((event) => event.details.handedOffFrom === s.task.id).length,
    1,
  );
});
test('removal and revoked source authority deny pooled action/detail/inbox/notifications without erasing history', async () => {
  const s = await setup(),
    m = s.members[0]!;
  await service.saveGroup(
    c(manager),
    {
      name: s.group.name,
      orgUnitId: unit,
      active: true,
      accountIds: s.members.slice(1).map((m) => m.accountId),
    },
    s.group.id,
    s.group.revision,
  );
  await assert.rejects(vote(m, s.task), isCode('WORKFLOW_NOT_ASSIGNED'));
  await assert.rejects(service.detail(c(m), s.run.id), isCode('WORKFLOW_PERMISSION_DENIED'));
  assert.ok(!(await service.runs(c(m), 'inbox')).items.some((r) => r.id === s.run.id));
  assert.ok(
    !(await work.notifications(c(m), 0, false)).items.some((n) => n.route.endsWith(s.run.id)),
  );
  assert.equal((await service.detail(c(manager), s.run.id)).assignmentUnavailable, true);
  const n = s.members[1]!;
  n.permissions = [];
  await assert.rejects(vote(n, s.task), isCode('WORKFLOW_PERMISSION_DENIED'));
});
test('unvoted replacement is revisioned, preserves history and does not revive old notices A-B-A', async () => {
  const a = voter(),
    b = voter(),
    s = await setup('all', { people: [a] }),
    group = await service.saveGroup(
      c(manager),
      { name: s.group.name, orgUnitId: unit, active: true, accountIds: [a.accountId, b.accountId] },
      s.group.id,
      s.group.revision,
    );
  const initial = (await work.notifications(c(a), 0, false)).items.find((n) =>
    n.route.endsWith(s.run.id),
  )!;
  const t2 = await service.reassign(c(manager), s.task.id, {
    expectedRevision: 1,
    accountId: b.accountId,
    replaceAccountId: a.accountId,
  });
  assert.ok(
    !(await work.notifications(c(a), 0, false)).items.some((n) => n.route.endsWith(s.run.id)),
  );
  const t3 = await service.reassign(c(manager), s.task.id, {
    expectedRevision: t2.revision,
    accountId: a.accountId,
    replaceAccountId: b.accountId,
  });
  const notices = (await work.notifications(c(a), 0, false)).items.filter((n) =>
    n.route.endsWith(s.run.id),
  );
  assert.equal(notices.length, 1);
  assert.notEqual(notices[0]!.id, initial.id);
  await assert.rejects(vote(a, s.task), isCode('REVISION_CONFLICT'));
  await vote(a, t3);
  assert.equal(group.revision, 2);
});
test('one person cannot multiply votes, requester is excluded, and insufficient quorum fails without a run', async () => {
  const a = voter(),
    alias = voter();
  alias.personId = a.personId;
  await assert.rejects(
    setup('all', { people: [a, alias] }),
    isCode('WORKFLOW_POOL_DUPLICATE_PERSON'),
  );
  const self = voter();
  self.personId = requester.personId;
  await assert.rejects(
    setup('quorum', { people: [voter(), self], quorum: 2 }),
    isCode('WORKFLOW_POOL_INSUFFICIENT'),
  );
  const s = await setup('all', { people: [voter(), self] });
  assert.equal(s.task.members.length, 1);
  await assert.rejects(vote(self, s.task), isCode('WORKFLOW_NOT_ASSIGNED'));
  const current = s.members[0]!,
    oldPerson = current.personId;
  current.personId = randomUUID();
  await assert.rejects(vote(current, s.task), isCode('WORKFLOW_NOT_ASSIGNED'));
  current.personId = oldPerson;
});
test('late permission revocation rolls back vote, audit, transition and idempotency receipt together', async () => {
  const s = await setup('any'),
    who = s.members[0]!;
  let calls = 0;
  const command = {
    ...c(who),
    actor: async () => {
      calls++;
      return { ...structuredClone(who), permissions: calls > 1 ? [] : who.permissions };
    },
  };
  await assert.rejects(vote(who, s.task, 'approve', command), isCode('WORKFLOW_PERMISSION_DENIED'));
  assert.equal(
    (
      await pool.query('SELECT 1 FROM workflow_approval_votes WHERE tenant_id=$1 AND task_id=$2', [
        tenant,
        s.task.id,
      ])
    ).rowCount,
    0,
  );
  const detail = await service.detail(c(requester), s.run.id);
  assert.equal(detail.run.status, 'running');
  assert.equal(detail.history.filter((h) => h.action === 'task.vote').length, 0);
});
test('business minute deadlines use published calendar and unsupported v4 fields are not accepted as legacy', async () => {
  const s = await setup('all', { business: true });
  assert.equal(
    new Date(s.task.due_at).toISOString(),
    workflowDeadline(new Date(s.task.created_at), 1, s.spec.calendar).toISOString(),
  );
  assert.throws(() => parseWorkflow({ ...s.spec, schemaVersion: 3 }));
  const next = structuredClone(s.spec);
  next.calendar!.holidays = ['2026-11-11'];
  (next.nodes[1] as HumanStep).deadlineMinutes = 120;
  const draft = await service.saveDefinition(
    c(manager),
    { code: s.published.definition.code, orgUnitId: unit, spec: next },
    s.published.definition.id,
    s.published.definition.revision,
  );
  await service.publish(c(manager), draft.id, draft.revision);
  const detail = await service.detail(c(requester), s.run.id);
  assert.equal(detail.version.id, s.published.version.id);
  assert.equal(
    new Date(detail.tasks[0].due_at).toISOString(),
    new Date(s.task.due_at).toISOString(),
  );
});
