import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { WorkflowsService } from '../src/workflows/service.js';
import { WorkflowWorkCenter } from '../src/workflows/work-center.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { parseWorkflow, previousAssigneeSteps } from '../src/workflows/contracts.js';
import { workflowCandidateIds } from '../src/workflows/assignments.js';
import type { HumanStep } from '../src/workflows/contracts.js';
import type {
  WorkflowActor,
  WorkflowCommand,
  WorkflowPermission,
} from '../src/workflows/access.js';
import { HttpError } from '../src/security.js';
const runtime = await loadLocalConfig(),
  config = await loadWorkflowsConfig(runtime.instanceId),
  pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 5 }),
  owner = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true, true), max: 1 });
const tenant = randomUUID(),
  unitA = randomUUID(),
  unitC = randomUUID();
function actor(permissions: WorkflowPermission[], unit: string | null = unitA): WorkflowActor {
  return {
    appCode: 'aio-workflows',
    accountId: randomUUID(),
    personId: randomUUID(),
    tenantIds: [tenant],
    units: [{ tenantId: tenant, orgUnitId: unit ?? unitA }],
    permissions: permissions.map((permission) => ({
      tenantId: tenant,
      permission,
      orgUnitId: unit,
    })),
  };
}
const manager = actor(['workflows:manage'], null),
  scoped = actor(['workflows:manage']),
  designer = actor(['workflows:design'], null),
  publisher = actor(['workflows:publish'], null),
  requester = actor(['workflows:start']),
  handler = actor(['workflows:act']),
  finance = actor(['workflows:act'], null),
  otherUnit = actor(['workflows:act'], unitC),
  self = actor(['workflows:act']);
self.personId = requester.personId;
const actors = new Map([handler, finance, otherUnit, self].map((a) => [a.accountId, a]));
const service = new WorkflowsService(pool, {
  async validateUnit(t, u) {
    if (t !== tenant || ![unitA, unitC].some((unit) => unit === u))
      throw new HttpError(400, 'WORKFLOW_REFERENCE_DENIED');
  },
  async assignee(t, u, id) {
    const a = actors.get(id);
    if (
      t !== tenant ||
      !a ||
      !a.permissions.some(
        (p) =>
          p.permission === 'workflows:act' &&
          (u === null || p.orgUnitId === null || p.orgUnitId === u),
      )
    )
      throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
    return { personId: a.personId, name: 'Người xử lý ' + id.slice(0, 8) };
  },
});
test('organization rule v3 resolves at queue time, rejects self approval and stale responsibility, supports audited explicit reassignment', async () => {
  let responsible = handler;
  const organizationService = new WorkflowsService(pool, {
    ...service.directory,
    async responsible(t, u, person, kind) {
      assert.equal(t, tenant);
      assert.equal(u, unitA);
      assert.equal(person, requester.personId);
      assert.equal(kind, 'manager');
      return {
        accountId: responsible.accountId,
        personId: responsible.personId,
        basis: [{ id: 'test-projection', revision: 1 }],
      };
    },
  });
  const spec = workflowTemplate();
  spec.schemaVersion = 3;
  spec.audienceUnits = [unitA];
  spec.positions = {};
  spec.nodes = [
    { id: 'start', label: 'Bắt đầu', kind: 'start', next: 'review' },
    {
      id: 'review',
      label: 'Quản lý duyệt',
      kind: 'approval',
      assignee: '',
      assigneeRule: { kind: 'organization', relation: 'manager' },
      dueHours: 24,
      next: 'end',
      form: null,
    },
    { id: 'end', label: 'Hoàn tất', kind: 'end' },
  ];
  assert.doesNotThrow(() => parseWorkflow(spec));
  assert.throws(() => parseWorkflow({ ...spec, schemaVersion: 2 }));
  const draft = await organizationService.saveDefinition(c(designer), {
    code: 'org-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const version = await organizationService.publish(c(publisher), draft.id, draft.revision);
  const input = {
    definitionId: draft.id,
    versionId: version.version.id,
    unitId: unitA,
    title: 'Quản lý trực tiếp duyệt',
    answers,
    selections: {},
  };
  responsible = self;
  await assert.rejects(() => organizationService.start(c(requester), input), {
    code: 'WORKFLOW_SELF_APPROVAL',
  });
  responsible = handler;
  const run = await organizationService.start(c(requester), input);
  const detail = await organizationService.detail(c(requester), run.id);
  const task = detail.tasks.find((t) => t.status === 'pending')!;
  assert.equal(task.assignee_account_id, handler.accountId);
  assert.equal(task.organization_rule.kind, 'manager');
  responsible = finance;
  await assert.rejects(
    () =>
      organizationService.act(c(handler), task.id, {
        expectedRevision: task.revision,
        action: 'approve',
        answers: {},
      }),
    { code: 'WORKFLOW_ORGANIZATION_CHANGED' },
  );
  const reassigned = await organizationService.reassign(c(manager), task.id, {
    expectedRevision: task.revision,
    accountId: finance.accountId,
  });
  assert.equal(Object.hasOwn(reassigned, 'execution_order'), false);
  assert.equal(reassigned.organization_rule, null);
  await organizationService.act(c(finance), task.id, {
    expectedRevision: reassigned.revision,
    action: 'approve',
    answers: {},
  });
  assert.equal((await organizationService.detail(c(requester), run.id)).run.status, 'completed');
});
const c = (a: WorkflowActor, options: Partial<WorkflowCommand> = {}): WorkflowCommand => ({
  tenantId: tenant,
  actor: async () => structuredClone(a),
  reason: 'Kiểm thử giao nhiệm vụ động',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
  ...options,
});
const answers = { purpose: 'Dữ liệu giả lập', amount: 100, needed_on: '2026-12-01' };
const group = (members = [handler.accountId, finance.accountId]) =>
  service.saveGroup(c(manager), {
    name: 'Nhóm giả lập',
    orgUnitId: unitA,
    accountIds: members,
    active: true,
  });
async function setup(groupId: string, reassignRoles?: HumanStep['reassignRoles']) {
  const spec = workflowTemplate();
  spec.schemaVersion = reassignRoles ? 5 : 2;
  spec.audienceUnits = [unitA];
  for (const node of spec.nodes) {
    if (node.kind !== 'approval' && node.kind !== 'task') continue;
    node.assignee = '';
    node.assigneeRule =
      node.id === 'review' ? { kind: 'group', groupId } : { kind: 'previous', stepId: 'review' };
    if (node.id === 'review' && reassignRoles) node.reassignRoles = reassignRoles;
  }
  const draft = await service.saveDefinition(c(designer), {
    code: 'dynamic-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  return service.publish(c(publisher), draft.id, draft.revision);
}
const start = async (set: Awaited<ReturnType<typeof setup>>, selection = handler.accountId) =>
  service.start(c(requester), {
    definitionId: set.definition.id,
    versionId: set.version.id,
    unitId: unitA,
    title: 'Đề nghị phân công',
    answers,
    selections: { review: selection },
  });
const pending = async (id: string) =>
  (await service.detail(c(requester), id)).tasks.find((t) => t.status === 'pending')!;
test('followers read only allowed fields, cannot act, and mentions are atomic and revoked with the follower revision', async () => {
  const follower = actor(['workflows:collaborate']);
  const other = actor(['workflows:collaborate'], unitC);
  const reader = actor(['workflows:report']);
  follower.displayName = 'Người theo dõi giả lập';
  let eligibilityChecks = 0;
  let loseMentionTarget = false;
  const collaboration = new WorkflowsService(pool, {
    ...service.directory,
    async collaborators(t, unit, query) {
      if (
        t !== tenant ||
        unit !== unitA ||
        (query.accountId && query.accountId !== follower.accountId)
      )
        return [];
      if (query.accountId && loseMentionTarget && ++eligibilityChecks >= 2) return [];
      return follower.units.length && follower.permissions.length
        ? [
            {
              accountId: follower.accountId,
              personId: follower.personId,
              name: follower.displayName!,
            },
          ]
        : [];
    },
  });
  const workCenter = new WorkflowWorkCenter(collaboration);
  const spec = workflowTemplate();
  spec.schemaVersion = 5;
  spec.audienceUnits = [unitA];
  spec.fieldReaders = { 'input.purpose': ['owner', 'review'] };
  for (const node of spec.nodes) if ('form' in node) node.assignee = handler.accountId;
  const definition = await collaboration.saveDefinition(c(designer), {
    code: 'collab-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const published = await collaboration.publish(c(publisher), definition.id, definition.revision);
  const run = await collaboration.start(c(requester), {
    definitionId: definition.id,
    versionId: published.version.id,
    unitId: unitA,
    title: 'Hồ sơ phối hợp giả lập',
    answers,
  });
  const denied = { code: 'WORKFLOW_PERMISSION_DENIED' };
  await assert.rejects(() => collaboration.detail(c(follower), run.id), denied);
  await assert.rejects(() => collaboration.followerCandidates(c(follower), run.id, ''), denied);
  await assert.rejects(
    () => collaboration.followerCandidates(c({ ...requester, units: [] }), run.id, ''),
    denied,
  );
  assert.deepEqual((await collaboration.runs(c(follower), 'followed')).items, []);
  assert.equal((await collaboration.followerCandidates(c(requester), run.id, '')).items.length, 1);
  await assert.rejects(() => collaboration.addFollower(c(requester), run.id, other.accountId), {
    code: 'WORKFLOW_FOLLOWER_UNAVAILABLE',
  });
  const invite = c(requester);
  const member = await collaboration.addFollower(invite, run.id, follower.accountId);
  assert.deepEqual(await collaboration.addFollower(invite, run.id, follower.accountId), member);
  const detail = await collaboration.detail(c(follower), run.id);
  assert.equal(detail.following, true);
  assert.equal(detail.run.inputs.purpose, undefined);
  assert.equal(detail.run.inputs.amount, answers.amount);
  assert.ok(detail.version.spec.nodes.every((node) => 'form' in node));
  assert.equal(detail.canAct, false);
  assert.equal(detail.canReassign, false);
  assert.equal((await collaboration.runs(c(follower), 'followed')).items[0]?.id, run.id);
  const base = definition.id + '/';
  const workspace = await collaboration.runs(c(follower), 'followed', undefined, {
    search: 'PHỐI HỢP',
    fields: true,
    columns: [base + 'purpose', base + 'amount'],
  });
  assert.equal(workspace.items[0]?.cells[base + 'amount'], '100');
  assert.ok(!workspace.fields?.some((field) => field.id === base + 'purpose'));
  assert.ok(!JSON.stringify(workspace).includes(answers.purpose));
  await assert.rejects(
    () =>
      collaboration.act(c(follower), detail.tasks[0]!.id, {
        action: 'approve',
        expectedRevision: 1,
        answers: {},
      }),
    denied,
  );
  await assert.rejects(() => collaboration.postComment(c(reader), run.id, 'Chỉ xem', []), denied);
  await assert.rejects(
    () => collaboration.postComment(c(requester), run.id, 'Sai người nhận', [randomUUID()]),
    {
      code: 'WORKFLOW_FOLLOWER_UNAVAILABLE',
    },
  );
  loseMentionTarget = true;
  await assert.rejects(
    () => collaboration.postComment(c(requester), run.id, 'Hoàn tác bình luận', [member.id]),
    {
      code: 'WORKFLOW_FOLLOWER_UNAVAILABLE',
    },
  );
  loseMentionTarget = false;
  assert.equal((await collaboration.discussion(c(follower), run.id)).comments.length, 0);
  assert.equal((await workCenter.notifications(c(follower), 0, false)).total, 0);
  const post = c(requester);
  const sent = await collaboration.postComment(post, run.id, 'Vui lòng xem hồ sơ.', [member.id]);
  assert.deepEqual(
    await collaboration.postComment(post, run.id, 'Vui lòng xem hồ sơ.', [member.id]),
    sent,
  );
  const reply = c(follower);
  await collaboration.postComment(reply, run.id, 'Tôi đã xem.', []);
  assert.equal((await collaboration.discussion(c(follower), run.id)).comments.length, 2);
  const notice = await workCenter.notifications(c(follower), 0, false);
  assert.equal(notice.total, 1);
  assert.equal(notice.items[0]!.kind, 'mentioned');
  assert.equal(notice.items[0]!.route, '/#workflow-run/' + run.id);
  assert.ok(!JSON.stringify(notice).includes('Vui lòng'));
  const role = follower.permissions;
  follower.permissions = [];
  await assert.rejects(() => collaboration.discussion(c(follower), run.id), denied);
  assert.equal((await workCenter.notifications(c(follower), 0, false)).total, 0);
  follower.permissions = role;
  const units = follower.units;
  follower.units = [];
  assert.deepEqual((await collaboration.runs(c(follower), 'followed')).items, []);
  await assert.rejects(() => collaboration.detail(c(follower), run.id), denied);
  follower.units = units;
  await assert.rejects(
    () => collaboration.removeFollower(c(requester), run.id, member.id, member.revision + 1),
    {
      code: 'WORKFLOW_FOLLOWER_CONFLICT',
    },
  );
  await collaboration.removeFollower(c(requester), run.id, member.id, member.revision);
  await assert.rejects(() => collaboration.discussion(c(follower), run.id), denied);
  await assert.rejects(() => collaboration.postComment(reply, run.id, 'Tôi đã xem.', []), denied);
  const reopened = await collaboration.addFollower(c(requester), run.id, follower.accountId);
  assert.equal(reopened.id, member.id);
  assert.equal(reopened.revision, member.revision + 2);
  assert.equal((await workCenter.notifications(c(follower), 0, false)).total, 0);
  assert.equal((await collaboration.discussion(c(follower), run.id)).comments.length, 2);
});
test('step collaboration retains exact attempts and keeps other discussions, actions and files private', async () => {
  const follower = actor(['workflows:collaborate']);
  const collaboration = new WorkflowsService(pool, {
    ...service.directory,
    async collaborators(t, unit, query) {
      return t === tenant &&
        unit === unitA &&
        (!query.accountId || query.accountId === follower.accountId)
        ? [
            {
              accountId: follower.accountId,
              personId: follower.personId,
              name: 'Người theo dõi bước',
            },
          ]
        : [];
    },
  });
  const work = new WorkflowWorkCenter(collaboration);
  const spec = workflowTemplate('blank');
  spec.schemaVersion = 5;
  spec.audienceUnits = [unitA];
  const review = spec.nodes.find((node) => node.id === 'review') as HumanStep;
  review.assignee = handler.accountId;
  review.inputFields = { requested_on: 'read', purpose: 'read' };
  review.next = 'finance';
  review.form = {
    title: 'Chứng từ',
    schemaVersion: 2,
    sections: [
      {
        id: 'proof',
        title: 'Kết quả',
        fields: [
          { id: 'evidence', type: 'attachment', label: 'Chứng từ', required: false },
          { id: 'secret', type: 'attachment', label: 'Chứng từ hạn chế', required: false },
        ],
      },
    ],
  };
  spec.nodes.push({
    id: 'finance',
    label: 'Đối soát',
    kind: 'task',
    assignee: finance.accountId,
    next: 'end',
    form: null,
    allowReturn: true,
    returnMode: 'previous',
    dueHours: 12,
  });
  spec.fieldReaders = { 'input.purpose': ['owner', 'review'], 'review.secret': ['review'] };
  const definition = await collaboration.saveDefinition(c(designer), {
    code: 'step-related-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const published = await collaboration.publish(c(publisher), definition.id, definition.revision);
  const makeRun = () =>
    collaboration.start(c(requester), {
      definitionId: definition.id,
      versionId: published.version.id,
      unitId: unitA,
      title: 'Theo dõi bước giả lập',
      answers: { purpose: 'Nội dung giới hạn', requested_on: '2026-12-01' },
    });
  const run = await makeRun();
  const otherRun = await makeRun();
  const step = await pending(run.id);
  const crossRun = await pending(otherRun.id);
  const deny = { code: 'WORKFLOW_PERMISSION_DENIED' };
  await assert.rejects(
    () => collaboration.addFollower(c(requester), run.id, follower.accountId, crossRun.id),
    deny,
  );
  const invite = c(requester);
  const member = await collaboration.addFollower(invite, run.id, follower.accountId, step.id);
  assert.deepEqual(
    await collaboration.addFollower(invite, run.id, follower.accountId, step.id),
    member,
  );
  await assert.rejects(() => collaboration.detail(c(follower), run.id), deny);
  await assert.rejects(() => collaboration.discussion(c(follower), run.id), deny);
  assert.equal(
    (await collaboration.runs(c(follower), 'followed')).items.find((r) => r.id === run.id)
      ?.related_task_id,
    step.id,
  );
  const detail = await collaboration.detail(c(follower), run.id, step.id);
  assert.deepEqual(detail.run.inputs, { requested_on: '2026-12-01' });
  assert.deepEqual(
    detail.tasks.map((task) => task.id),
    [step.id],
  );
  assert.equal(detail.canAct, false);
  await assert.rejects(
    () =>
      collaboration.act(c(follower), step.id, {
        expectedRevision: step.revision,
        action: 'approve',
        answers: {},
      }),
    deny,
  );
  await assert.rejects(
    () => collaboration.postComment(c(requester), run.id, 'Sai phạm vi', [member.id]),
    { code: 'WORKFLOW_FOLLOWER_UNAVAILABLE' },
  );
  await collaboration.postComment(
    c(requester),
    run.id,
    'Trao đổi riêng bước kiểm tra',
    [member.id],
    step.id,
  );
  assert.equal((await collaboration.discussion(c(requester), run.id)).comments.length, 0);
  assert.equal(
    (await collaboration.discussion(c(follower), run.id, undefined, step.id)).comments.length,
    1,
  );
  const notification = (await work.notifications(c(follower), 0, false)).items[0]!;
  assert.equal(notification.route, '/#workflow-run/' + run.id + '/' + step.id);
  await collaboration.postComment(c(follower), run.id, 'Đã xem tại bước này', [], step.id);
  const upload = (fieldId: string) =>
    collaboration.uploadAttachment(c(handler), 'task', step.id, {
      fieldId,
      fileName: fieldId + '.txt',
      content: Buffer.from('Chứng từ giả lập').toString('base64'),
    });
  const evidence = await upload('evidence');
  const secret = await upload('secret');
  await collaboration.act(c(handler), step.id, {
    expectedRevision: step.revision,
    action: 'approve',
    answers: { evidence: [evidence.id], secret: [secret.id] },
  });
  const next = await pending(run.id);
  assert.equal(next.node_id, 'finance');
  assert.equal((await collaboration.detail(c(requester), run.id)).run.status, 'running');
  assert.equal((await collaboration.detail(c(follower), run.id, step.id)).run.status, 'completed');
  assert.equal(
    (
      await collaboration.runs(c(follower), 'followed', undefined, { status: 'completed' })
    ).items.find((item) => item.id === run.id)?.status,
    'completed',
  );
  await assert.rejects(() => collaboration.detail(c(follower), run.id, next.id), deny);
  await assert.rejects(
    () => collaboration.discussion(c(follower), run.id, undefined, next.id),
    deny,
  );
  await assert.rejects(
    () => collaboration.discussion(c(finance), run.id, undefined, step.id),
    deny,
  );
  const ownerHistory = (await collaboration.detail(c(requester), run.id)).history;
  const siblingHistory = (await collaboration.detail(c(finance), run.id)).history;
  assert.ok(
    ownerHistory.some(
      (event) => event.action === 'run.comment_posted' && event.details.taskId === step.id,
    ),
  );
  assert.ok(
    !siblingHistory.some(
      (event) => event.action === 'run.comment_posted' && event.details.taskId === step.id,
    ),
  );
  assert.deepEqual(
    (await collaboration.detail(c(follower), run.id, step.id)).attachments.map((item) => item.id),
    [evidence.id],
  );
  assert.equal(
    (await collaboration.downloadAttachment(c(follower), evidence.id)).fileName,
    'evidence.txt',
  );
  await assert.rejects(() => collaboration.downloadAttachment(c(follower), secret.id), {
    code: 'WORKFLOW_ATTACHMENT_NOT_FOUND',
  });
  await collaboration.act(c(finance), next.id, {
    expectedRevision: next.revision,
    action: 'return',
    answers: {},
  });
  const replacement = await pending(run.id);
  assert.notEqual(replacement.id, step.id);
  await assert.rejects(() => collaboration.detail(c(follower), run.id, step.id), deny);
  await assert.rejects(() => collaboration.detail(c(follower), run.id, replacement.id), deny);
  await assert.rejects(() => collaboration.downloadAttachment(c(follower), evidence.id), {
    code: 'WORKFLOW_ATTACHMENT_NOT_FOUND',
  });
  assert.equal((await work.notifications(c(follower), 0, false)).total, 0);
  const archive = await collaboration.discussion(c(requester), run.id, undefined, step.id);
  assert.equal(archive.comments.length, 2);
  assert.equal(archive.canComment, false);
  await collaboration.addFollower(c(requester), otherRun.id, follower.accountId, crossRun.id);
  const recalled = await collaboration.recall(c(requester), otherRun.id, {
    expectedRevision: otherRun.revision,
  });
  await collaboration.resubmit(c(requester), otherRun.id, {
    expectedRevision: recalled.revision,
    answers: { purpose: 'Lần gửi mới', requested_on: '2026-12-02' },
  });
  await assert.rejects(() => collaboration.detail(c(follower), otherRun.id, crossRun.id), deny);
  assert.deepEqual((await collaboration.runs(c(follower), 'followed')).items, []);
});
test('processed work uses real decisions and personal workspace presets enforce scope, revision and replay', async () => {
  const members = await group();
  const published = await setup(members.id);
  const run = await start(published);
  const options = { search: 'ĐỀ NGHỊ PHÂN CÔNG', unitId: unitA } as const;
  assert.ok(
    !(await service.runs(c(handler), 'done', undefined, options)).items.some(
      (r) => r.id === run.id,
    ),
  );
  const task = await pending(run.id);
  await service.act(c(handler), task.id, {
    action: 'approve',
    expectedRevision: task.revision,
    answers: {},
  });
  const row = (await service.runs(c(handler), 'done', undefined, options)).items.find(
    (r) => r.id === run.id,
  );
  assert.equal(row?.task_id, task.id);
  assert.equal(row?.handled_action, 'approve');
  assert.ok(row?.handled_at instanceof Date);
  assert.ok(
    !(await service.runs(c(finance), 'done', undefined, options)).items.some(
      (r) => r.id === run.id,
    ),
  );
  assert.deepEqual(
    (await service.runs(c(handler), 'done', undefined, { ...options, unitId: unitC })).items,
    [],
  );
  const command = c(handler);
  const settings = { ...options, columns: ['status', 'handled'] };
  const preset = await service.saveWorkspaceView(command, 'done', '  Hồ sơ của tôi ', settings);
  assert.equal(preset.name, 'Hồ sơ của tôi');
  assert.deepEqual(
    await service.saveWorkspaceView(command, 'done', '  Hồ sơ của tôi ', settings),
    preset,
  );
  assert.deepEqual((await service.workspaceViews(c(finance), 'done')).items, []);
  assert.deepEqual((await service.workspaceViews(c(handler), 'inbox')).items, []);
  await assert.rejects(() => service.archiveWorkspaceView(c(finance), 'done', preset.id, 1), {
    code: 'WORKFLOW_WORKSPACE_CONFLICT',
  });
  await assert.rejects(() => service.workspaceViews(c({ ...handler, permissions: [] }), 'done'), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
  const edited = await service.saveWorkspaceView(
    c(handler),
    'done',
    'Đã xử lý gần đây',
    { ...settings, columns: ['step'] },
    { id: preset.id, revision: preset.revision },
  );
  assert.equal(edited.revision, 2);
  await assert.rejects(() => service.archiveWorkspaceView(c(handler), 'done', preset.id, 1), {
    code: 'WORKFLOW_WORKSPACE_CONFLICT',
  });
  await service.archiveWorkspaceView(c(handler), 'done', edited.id, edited.revision);
  assert.deepEqual((await service.workspaceViews(c(handler), 'done')).items, []);
});
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-workflows-test',
  );
});
after(async () => {
  await pool.end();
  await owner.end();
});
test('Selector v2 requires a guaranteed earlier human step; legacy v1 and immutable source data remain valid', () => {
  const spec = workflowTemplate();
  spec.schemaVersion = 2;
  spec.audienceUnits = [unitA];
  for (const node of spec.nodes)
    if (node.kind === 'approval' || node.kind === 'task') node.assignee = handler.accountId;
  const fulfil = spec.nodes.find((n) => n.id === 'fulfil') as HumanStep;
  fulfil.assignee = '';
  fulfil.assigneeRule = { kind: 'previous', stepId: 'review' };
  assert.doesNotThrow(() => parseWorkflow(spec));
  assert.deepEqual(
    previousAssigneeSteps(spec.nodes, 'fulfil').map((n) => n.id),
    ['review'],
  );
  fulfil.assigneeRule = { kind: 'previous', stepId: 'director' };
  assert.throws(() => parseWorkflow(spec));
  fulfil.assigneeRule = { kind: 'previous', stepId: 'fulfil' };
  assert.throws(() => parseWorkflow(spec));
  fulfil.assigneeRule = { kind: 'group', groupId: randomUUID() };
  assert.doesNotThrow(() => parseWorkflow(spec));
  spec.schemaVersion = 1;
  assert.throws(() => parseWorkflow(spec));
  assert.deepEqual(workflowCandidateIds([handler.accountId.toUpperCase()]), [handler.accountId]);
  assert.throws(() => workflowCandidateIds([handler.accountId, handler.accountId.toUpperCase()]));
});
test('Group administration is scoped, optimistic and audited; membership does not grant application authority', async () => {
  const created = await group();
  await assert.rejects(
    () =>
      service.saveGroup(c(designer), {
        name: 'Denied',
        orgUnitId: unitA,
        accountIds: [],
        active: true,
      }),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  await assert.rejects(
    () =>
      service.saveGroup(c(scoped), {
        name: 'Global denied',
        orgUnitId: null,
        accountIds: [],
        active: true,
      }),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  await assert.rejects(
    () =>
      service.saveGroup(c(manager), {
        name: 'Unavailable',
        orgUnitId: unitA,
        accountIds: [randomUUID()],
        active: true,
      }),
    { code: 'WORKFLOW_ASSIGNEE_UNAVAILABLE' },
  );
  const request = c(manager),
    update = { name: 'Đã đổi', orgUnitId: unitA, accountIds: [finance.accountId], active: true };
  const saved = await service.saveGroup(request, update, created.id, created.revision);
  assert.deepEqual(await service.saveGroup(request, update, created.id, created.revision), saved);
  await assert.rejects(() => service.saveGroup(c(manager), update, created.id, created.revision), {
    code: 'REVISION_CONFLICT',
  });
  await assert.rejects(
    () =>
      service.saveGroup(c(manager), { ...update, orgUnitId: unitC }, created.id, saved.revision),
    { code: 'WORKFLOW_OWNERSHIP_IMMUTABLE' },
  );
  assert.equal(
    (await service.groups(c(designer))).items.find((g) => g.id === created.id)!.account_ids,
    undefined,
  );
  await assert.rejects(() => service.groups(c(requester)), { code: 'WORKFLOW_PERMISSION_DENIED' });
});
test('Selection candidates intersect group, tenant/unit, active rights and same-person self-approval exclusions', async () => {
  const global = await service.saveGroup(c(manager), {
    name: 'Nhóm chung',
    orgUnitId: null,
    accountIds: [handler.accountId, finance.accountId, otherUnit.accountId, self.accountId],
    active: true,
  });
  const set = await setup(global.id);
  const options = await service.startSelections(
    c(requester),
    set.definition.id,
    unitA,
    set.version.id,
  );
  assert.deepEqual(
    options.items[0]!.candidates.map((p) => p.id).sort(),
    [handler.accountId, finance.accountId].sort(),
  );
  await assert.rejects(() => start(set, otherUnit.accountId), {
    code: 'WORKFLOW_SELECTION_REQUIRED',
  });
  await assert.rejects(() => start(set, self.accountId), { code: 'WORKFLOW_SELECTION_REQUIRED' });
  await assert.rejects(
    () =>
      service.start(c(requester), {
        definitionId: set.definition.id,
        versionId: set.version.id,
        unitId: unitA,
        title: 'Thiếu người',
        answers,
      }),
    { code: 'WORKFLOW_SELECTION_REQUIRED' },
  );
  await assert.rejects(
    () =>
      service.start(c(requester), {
        definitionId: set.definition.id,
        versionId: set.version.id,
        unitId: unitA,
        title: 'Giả mạo',
        answers,
        selections: { review: handler.accountId, fulfil: finance.accountId },
      }),
    { code: 'WORKFLOW_ASSIGNMENT_INVALID' },
  );
  await assert.rejects(
    () => service.startSelections(c(requester), set.definition.id, unitC, set.version.id),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
});
test('Chosen group member and actual previous actor are fixed per round; idempotent retries create no duplicate choices/tasks', async () => {
  const created = await group(),
    set = await setup(created.id),
    request = c(requester),
    input = {
      definitionId: set.definition.id,
      versionId: set.version.id,
      unitId: unitA,
      title: 'Phiếu động',
      answers,
      selections: { review: handler.accountId },
    };
  const run = await service.start(request, input);
  assert.deepEqual(await service.start(request, input), run);
  const first = await pending(run.id);
  assert.equal(first.assignment_group_id, created.id);
  const replacement = await service.reassign(c(manager), first.id, {
    expectedRevision: first.revision,
    accountId: finance.accountId,
  });
  await service.act(c(finance), replacement.id, {
    expectedRevision: replacement.revision,
    action: 'approve',
    answers: {},
  });
  const next = await pending(run.id);
  assert.equal(next.node_id, 'fulfil');
  assert.equal(next.assignee_account_id, finance.accountId);
  const detail = await service.detail(c(requester), run.id);
  assert.equal(detail.selections[0].choices.review, handler.accountId);
  assert.equal(detail.selections.length, 1);
  await assert.rejects(() => pool.query('UPDATE workflow_run_assignments SET choices=choices'), {
    code: '42501',
  });
  await assert.rejects(
    () =>
      owner.query('UPDATE workflow_run_assignments SET choices=choices WHERE run_id=$1', [run.id]),
    { code: '42501' },
  );
});
test('Delegated reassignment requires a configured role, live authority and a different eligible group member', async () => {
  const created = await group([handler.accountId, finance.accountId, self.accountId]),
    set = await setup(created.id, ['sender', 'assignee']),
    run = await start(set),
    first = await pending(run.id);
  const choices = await service.taskCandidates(c(handler), first.id);
  assert.deepEqual(
    choices.candidates.map((item) => item.id),
    [finance.accountId],
  );
  assert.equal((await service.detail(c(requester), run.id)).canReassign, true);
  await assert.rejects(() => service.taskCandidates(c(finance), first.id), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
  await assert.rejects(
    () =>
      service.reassign(c(requester), first.id, {
        expectedRevision: first.revision,
        accountId: self.accountId,
      }),
    { code: 'WORKFLOW_SELF_APPROVAL' },
  );
  let actorReads = 0;
  await assert.rejects(
    () =>
      service.reassign(
        c(handler, {
          actor: async () => ({
            ...handler,
            permissions: actorReads++ === 0 ? handler.permissions : [],
          }),
        }),
        first.id,
        { expectedRevision: first.revision, accountId: finance.accountId },
      ),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  assert.equal((await pending(run.id)).revision, first.revision);
  const changed = await service.reassign(c(handler), first.id, {
    expectedRevision: first.revision,
    accountId: finance.accountId,
  });
  assert.equal(changed.assignee_account_id, finance.accountId);
  await assert.rejects(() => service.taskCandidates(c(handler), first.id), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
  await assert.rejects(
    () =>
      service.reassign(c(requester), first.id, {
        expectedRevision: first.revision,
        accountId: handler.accountId,
      }),
    { code: 'REVISION_CONFLICT' },
  );
  const sender = c(requester);
  const back = { expectedRevision: changed.revision, accountId: handler.accountId };
  const restored = await service.reassign(sender, first.id, back);
  assert.deepEqual(await service.reassign(sender, first.id, back), restored);
  const detail = await service.detail(c(requester), run.id);
  assert.deepEqual(
    detail.history
      .filter((event) => event.action === 'task.reassigned')
      .map((event) => event.details.authority),
    ['assignee', 'sender'],
  );
  assert.deepEqual((await pending(run.id)).due_at, first.due_at);
  const legacy = await start(await setup(created.id));
  assert.equal((await service.detail(c(requester), legacy.id)).canReassign, false);
});

test('Action routing previews normalized results and commits only a live handoff to the resolved destination', async () => {
  const created = await group([handler.accountId, finance.accountId, self.accountId]);
  const spec = workflowTemplate();
  spec.schemaVersion = 5;
  spec.audienceUnits = [unitA];
  const review = spec.nodes.find((n) => n.id === 'review') as HumanStep;
  const fulfil = spec.nodes.find((n) => n.id === 'fulfil') as HumanStep;
  const director = spec.nodes.find((n) => n.id === 'director') as HumanStep;
  const budget = spec.nodes.find((n) => n.kind === 'condition')!;
  review.assignee = handler.accountId;
  review.rejectNext = fulfil.id;
  review.form = {
    schemaVersion: 1,
    title: 'Đánh giá',
    sections: [
      {
        id: 'assessment',
        title: 'Đánh giá',
        fields: [{ id: 'escalate', type: 'boolean', label: 'Cần duyệt thêm', required: true }],
      },
    ],
  };
  fulfil.assigneeRule = { kind: 'group', groupId: created.id, selectionTiming: 'handoff' };
  director.assignee = finance.accountId;
  budget.condition.rules = [{ fieldCode: 'step.review.escalate', operator: 'EQUALS', value: true }];
  const draft = await service.saveDefinition(c(designer), {
    code: 'handoff-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const published = await service.publish(c(publisher), draft.id, draft.revision);
  const input = {
    definitionId: draft.id,
    versionId: published.version.id,
    unitId: unitA,
    title: 'Bàn giao hồ sơ',
    answers,
  };
  assert.deepEqual(
    (await service.startSelections(c(requester), draft.id, unitA, published.version.id)).items,
    [],
  );
  const run = await service.start(c(requester), input);
  const task = await pending(run.id);
  const approve = {
    expectedRevision: task.revision,
    action: 'approve' as const,
    answers: { escalate: false },
  };
  const handoff = { stepId: fulfil.id, accountId: finance.accountId };
  await assert.rejects(() => service.previewHandoff(c(finance), task.id, approve), {
    code: 'WORKFLOW_NOT_ASSIGNED',
  });
  const preview = await service.previewHandoff(c(handler), task.id, approve);
  assert.equal(preview.selection?.stepId, fulfil.id);
  assert.deepEqual(Object.keys(preview.selection!.candidates[0]!).sort(), ['id', 'name']);
  assert.equal(
    (await service.previewHandoff(c(handler), task.id, { ...approve, answers: { escalate: true } }))
      .selection,
    null,
  );
  await assert.rejects(() => service.act(c(handler), task.id, approve), {
    code: 'WORKFLOW_HANDOFF_REQUIRED',
  });
  await assert.rejects(
    () => service.act(c(handler), task.id, { ...approve, answers: { escalate: true }, handoff }),
    { code: 'WORKFLOW_HANDOFF_CHANGED' },
  );
  await service.saveGroup(
    c(manager),
    { name: created.name, orgUnitId: unitA, active: true, accountIds: [handler.accountId] },
    created.id,
    created.revision,
  );
  await assert.rejects(() => service.act(c(handler), task.id, { ...approve, handoff }), {
    code: 'WORKFLOW_GROUP_MEMBER_DENIED',
  });
  assert.equal((await pending(run.id)).revision, task.revision);
  const command = c(handler);
  const reject = {
    ...approve,
    action: 'reject' as const,
    answers: {},
    handoff: { ...handoff, accountId: handler.accountId },
  };
  assert.equal(
    (await service.previewHandoff(c(handler), task.id, reject)).selection?.stepId,
    fulfil.id,
  );
  const result = await service.act(command, task.id, reject);
  assert.deepEqual(await service.act(command, task.id, reject), result);
  const detail = await service.detail(c(requester), run.id);
  assert.equal(detail.tasks.find((item) => item.id === task.id)?.status, 'rejected');
  assert.equal(
    detail.tasks.find((item) => item.status === 'pending')?.assignee_account_id,
    handler.accountId,
  );
  assert.equal(detail.history.filter((event) => event.details.handedOffFrom === task.id).length, 1);
  assert.deepEqual(detail.selections[0].choices, {});
});

test('Removing a group member denies open inbox/detail/action and forbids out-of-group reassignment, without losing history', async () => {
  const created = await group(),
    set = await setup(created.id),
    run = await start(set),
    first = await pending(run.id);
  await service.saveGroup(
    c(manager),
    { name: created.name, orgUnitId: unitA, active: true, accountIds: [finance.accountId] },
    created.id,
    created.revision,
  );
  assert.equal(
    (await service.runs(c(handler), 'inbox')).items.some((r) => r.id === run.id),
    false,
  );
  await assert.rejects(() => service.detail(c(handler), run.id), {
    code: 'WORKFLOW_PERMISSION_DENIED',
  });
  await assert.rejects(
    () =>
      service.act(c(handler), first.id, {
        expectedRevision: first.revision,
        action: 'approve',
        answers: {},
      }),
    { code: 'WORKFLOW_GROUP_MEMBER_DENIED' },
  );
  await assert.rejects(
    () =>
      service.reassign(c(manager), first.id, {
        expectedRevision: first.revision,
        accountId: handler.accountId,
      }),
    { code: 'WORKFLOW_GROUP_MEMBER_DENIED' },
  );
  assert.equal((await service.detail(c(manager), run.id)).assignmentUnavailable, true);
  const reassigned = await service.reassign(c(manager), first.id, {
    expectedRevision: first.revision,
    accountId: finance.accountId,
  });
  await service.act(c(finance), reassigned.id, {
    expectedRevision: reassigned.revision,
    action: 'approve',
    answers: {},
  });
  assert.equal(
    (await service.detail(c(requester), run.id)).selections[0].choices.review,
    handler.accountId,
  );
});

test('A return reopens an effective attempt, preserves history and re-evaluates the route and previous actor', async () => {
  const created = await group();
  const spec = workflowTemplate();
  spec.schemaVersion = 5;
  spec.audienceUnits = [unitA];
  const review = spec.nodes.find((n) => n.id === 'review') as HumanStep;
  const director = spec.nodes.find((n) => n.id === 'director') as HumanStep;
  const fulfil = spec.nodes.find((n) => n.id === 'fulfil') as HumanStep;
  const budget = spec.nodes.find((n) => n.kind === 'condition')!;
  review.assigneeRule = { kind: 'group', groupId: created.id, selectionTiming: 'handoff' };
  review.form = {
    schemaVersion: 1,
    title: 'Hạn mức',
    sections: [
      {
        id: 'assessment',
        title: 'Hạn mức',
        fields: [{ id: 'escalate', type: 'boolean', label: 'Duyệt thêm', required: true }],
      },
    ],
  };
  budget.condition.rules = [{ fieldCode: 'step.review.escalate', operator: 'EQUALS', value: true }];
  director.assignee = finance.accountId;
  director.returnMode = 'choose';
  fulfil.returnMode = 'choose';
  fulfil.assigneeRule = { kind: 'previous', stepId: review.id };
  const definition = await service.saveDefinition(c(designer), {
    code: 'return-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const published = await service.publish(c(publisher), definition.id, definition.revision);
  const run = await service.start(c(requester), {
    definitionId: definition.id,
    versionId: published.version.id,
    unitId: unitA,
    title: 'Mua sắm cần cập nhật hạn mức',
    answers,
    selections: { review: handler.accountId },
  });
  const first = await pending(run.id);
  await service.act(c(handler), first.id, {
    expectedRevision: first.revision,
    action: 'approve',
    answers: { escalate: true },
  });
  const second = await pending(run.id);
  assert.equal(second.node_id, director.id);
  assert.deepEqual((await service.detail(c(requester), run.id)).returnTargets, []);
  assert.deepEqual(
    (await service.detail(c(finance), run.id)).returnTargets.map((target) => target.id),
    [first.id, 'initiator'],
  );
  const command = c(finance);
  const move = { expectedRevision: second.revision, action: 'return' as const, answers: {} };
  await assert.rejects(() => service.act(c(finance), second.id, move), {
    code: 'WORKFLOW_RETURN_TARGET_REQUIRED',
  });
  await assert.rejects(
    () => service.act(c(finance), second.id, { ...move, returnTarget: randomUUID() }),
    {
      code: 'WORKFLOW_RETURN_TARGET_CHANGED',
    },
  );
  const selection = { ...move, returnTarget: first.id };
  assert.equal(
    (await service.previewHandoff(c(finance), second.id, selection)).selection?.stepId,
    review.id,
  );
  const handoff = { stepId: review.id, accountId: finance.accountId };
  await assert.rejects(
    () =>
      service.act(c(finance), second.id, {
        ...selection,
        handoff: { ...handoff, accountId: otherUnit.accountId },
      }),
    { code: 'WORKFLOW_GROUP_MEMBER_DENIED' },
  );
  const fault = c(finance);
  await owner.query(
    `CREATE FUNCTION return_attempt_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.request_id='${fault.requestId}' AND NEW.action='run.step_returned' THEN
       RAISE EXCEPTION 'Synthetic return audit failure';
      END IF;
      RETURN NEW;
     END; $$;`,
  );
  await owner.query(
    'CREATE TRIGGER return_attempt_test_failure BEFORE INSERT ON workflow_audit FOR EACH ROW EXECUTE FUNCTION return_attempt_test_failure()',
  );
  try {
    await assert.rejects(() => service.act(fault, second.id, { ...selection, handoff }));
  } finally {
    await owner.query('DROP TRIGGER return_attempt_test_failure ON workflow_audit');
    await owner.query('DROP FUNCTION return_attempt_test_failure()');
  }
  assert.equal((await pending(run.id)).id, second.id);
  assert.ok(
    (await service.detail(c(requester), run.id)).tasks.every((t) => !t.superseded_by_task_id),
  );
  const input = { ...selection, handoff };
  const results = await Promise.allSettled([
    service.act(command, second.id, input),
    service.act(c(finance), second.id, input),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.some((r) => r.status === 'rejected' && r.reason.code === 'REVISION_CONFLICT'));
  const replay = await pending(run.id);
  assert.equal(replay.node_id, first.node_id);
  assert.equal(replay.round, first.round);
  assert.equal(replay.attempt, 2);
  assert.equal(replay.assignee_account_id, finance.accountId);
  if (results[0].status === 'fulfilled')
    assert.deepEqual(await service.act(command, second.id, input), results[0].value);
  const detail = await service.detail(c(requester), run.id);
  assert.deepEqual(detail.tasks.find((t) => t.id === first.id)?.answers, { escalate: true });
  assert.equal(detail.tasks.find((t) => t.id === first.id)?.superseded_by_task_id, second.id);
  assert.equal(detail.history.filter((event) => event.action === 'run.step_returned').length, 1);
  await service.act(c(finance), replay.id, {
    expectedRevision: replay.revision,
    action: 'approve',
    answers: { escalate: false },
  });
  const next = await pending(run.id);
  assert.equal(next.node_id, fulfil.id);
  assert.equal(next.assignee_account_id, finance.accountId);
  await assert.rejects(
    () =>
      service.act(c(finance), next.id, {
        expectedRevision: next.revision,
        action: 'return',
        answers: {},
        returnTarget: first.id,
      }),
    { code: 'WORKFLOW_RETURN_TARGET_CHANGED' },
  );
});

test('Automatic prior return checks the replay recipient and a first step falls back to the initiator', async () => {
  const spec = workflowTemplate('blank');
  spec.schemaVersion = 5;
  spec.audienceUnits = [unitA];
  const review = spec.nodes.find((n) => n.id === 'review') as HumanStep;
  review.assignee = handler.accountId;
  review.returnMode = 'previous';
  review.next = 'verify';
  spec.nodes.find((node) => node.kind === 'start')!.next = 'precheck';
  spec.nodes.push(
    {
      id: 'precheck',
      kind: 'task',
      label: 'Kiểm tra chứng từ',
      assignee: finance.accountId,
      returnMode: 'previous',
      form: null,
      dueHours: 24,
      next: review.id,
    },
    {
      id: 'verify',
      kind: 'approval',
      label: 'Xác nhận',
      assignee: finance.accountId,
      rejectReturnMode: 'previous',
      form: null,
      dueHours: 24,
      next: 'end',
    },
  );
  const definition = await service.saveDefinition(c(designer), {
    code: 'previous-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const published = await service.publish(c(publisher), definition.id, definition.revision);
  const run = await service.start(c(requester), {
    definitionId: definition.id,
    versionId: published.version.id,
    unitId: unitA,
    title: 'Đối soát chứng từ',
    answers: { purpose: 'Giả lập', requested_on: '2026-12-01' },
  });
  const precheck = await pending(run.id);
  await service.act(c(finance), precheck.id, {
    expectedRevision: precheck.revision,
    action: 'complete',
    answers: {},
  });
  const first = await pending(run.id);
  await service.act(c(handler), first.id, {
    expectedRevision: first.revision,
    action: 'approve',
    answers: {},
  });
  const second = await pending(run.id);
  const action = { expectedRevision: second.revision, action: 'reject' as const, answers: {} };
  const rights = handler.permissions;
  handler.permissions = [];
  try {
    await assert.rejects(() => service.act(c(finance), second.id, action), {
      code: 'WORKFLOW_ASSIGNEE_UNAVAILABLE',
    });
  } finally {
    handler.permissions = rights;
  }
  assert.equal((await pending(run.id)).id, second.id);
  assert.equal((await service.act(c(finance), second.id, action)).current_step, review.id);
  const replay = await pending(run.id);
  assert.equal(replay.assignee_account_id, handler.accountId);
  const preserved = await service.detail(c(requester), run.id);
  assert.equal(preserved.tasks.find((t) => t.id === precheck.id)?.superseded_by_task_id, null);
  await service.act(c(handler), replay.id, {
    expectedRevision: replay.revision,
    action: 'return',
    answers: {},
  });
  const reopenedPrecheck = await pending(run.id);
  assert.equal(reopenedPrecheck.node_id, precheck.node_id);
  assert.equal(reopenedPrecheck.attempt, 2);
  const returned = await service.act(c(finance), reopenedPrecheck.id, {
    expectedRevision: reopenedPrecheck.revision,
    action: 'return',
    answers: {},
  });
  assert.equal(returned.status, 'needs_revision');
  const resubmitted = await service.resubmit(c(requester), run.id, {
    expectedRevision: returned.revision,
    answers: { purpose: 'Đã bổ sung', requested_on: '2026-12-01' },
  });
  assert.equal(resubmitted.round, 2);
  assert.equal((await pending(run.id)).attempt, 1);
});
test('Return/resubmit requires a fresh valid selection and previous-actor resolution never reuses an earlier round', async () => {
  const created = await group(),
    set = await setup(created.id),
    run = await start(set),
    first = await pending(run.id);
  const returned = await service.act(c(handler), first.id, {
    expectedRevision: first.revision,
    action: 'return',
    answers: {},
  });
  await service.saveGroup(
    c(manager),
    { name: created.name, orgUnitId: unitA, active: true, accountIds: [finance.accountId] },
    created.id,
    created.revision,
  );
  await assert.rejects(
    () =>
      service.resubmit(c(requester), run.id, {
        expectedRevision: returned.revision,
        answers,
        selections: { review: handler.accountId },
      }),
    { code: 'WORKFLOW_SELECTION_REQUIRED' },
  );
  await service.resubmit(c(requester), run.id, {
    expectedRevision: returned.revision,
    answers,
    selections: { review: finance.accountId },
  });
  const second = await pending(run.id);
  await service.act(c(finance), second.id, {
    expectedRevision: second.revision,
    action: 'approve',
    answers: {},
  });
  const final = await pending(run.id);
  assert.equal(final.assignee_account_id, finance.accountId);
  assert.equal(final.round, 2);
  const detail = await service.detail(c(requester), run.id);
  assert.equal(detail.selections.length, 2);
  assert.equal(detail.selections[0].choices.review, handler.accountId);
  assert.equal(detail.selections[1].choices.review, finance.accountId);
});
test('Disabled groups and revoked app rights fail closed; reactivation cannot restore removed members', async () => {
  const created = await group(),
    set = await setup(created.id),
    run = await start(set),
    first = await pending(run.id);
  const closed = await service.saveGroup(
    c(manager),
    { name: created.name, orgUnitId: unitA, active: false, accountIds: [finance.accountId] },
    created.id,
    created.revision,
  );
  await assert.rejects(
    () =>
      service.act(c(handler), first.id, {
        expectedRevision: first.revision,
        action: 'approve',
        answers: {},
      }),
    { code: 'WORKFLOW_GROUP_MEMBER_DENIED' },
  );
  await service.saveGroup(
    c(manager),
    { name: created.name, orgUnitId: unitA, active: true, accountIds: [finance.accountId] },
    created.id,
    closed.revision,
  );
  await assert.rejects(() => start(set, handler.accountId), {
    code: 'WORKFLOW_SELECTION_REQUIRED',
  });
  const rights = finance.permissions;
  finance.permissions = [];
  try {
    assert.equal(
      (await service.startSelections(c(requester), set.definition.id, unitA, set.version.id))
        .items[0]!.candidates.length,
      0,
    );
  } finally {
    finance.permissions = rights;
  }
});
test('Group audit failure rolls back membership and revision atomically', async () => {
  const created = await group(),
    request = c(manager);
  await owner.query(
    `CREATE FUNCTION assignment_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${request.requestId}' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF;RETURN NEW;END;$$;`,
  );
  await owner.query(
    'CREATE TRIGGER assignment_test_failure BEFORE INSERT ON workflow_audit FOR EACH ROW EXECUTE FUNCTION assignment_test_failure()',
  );
  try {
    await assert.rejects(() =>
      service.saveGroup(
        request,
        { name: created.name, orgUnitId: unitA, active: false, accountIds: [] },
        created.id,
        created.revision,
      ),
    );
  } finally {
    await owner.query('DROP TRIGGER assignment_test_failure ON workflow_audit');
    await owner.query('DROP FUNCTION assignment_test_failure()');
  }
  const retained = (await service.groups(c(manager))).items.find((g) => g.id === created.id)!;
  assert.equal(retained.revision, created.revision);
  assert.equal(retained.active, true);
  assert.deepEqual(retained.account_ids?.sort(), [handler.accountId, finance.accountId].sort());
});

test('Independent nested branches and a pooled vote join once, and a return reopens only dependent work', async () => {
  const council = await group([finance.accountId]);
  const spec = workflowTemplate('blank');
  spec.schemaVersion = 5;
  spec.audienceUnits = [unitA];
  const assignment = { assignee: handler.accountId, dueHours: 24, form: null };
  const verificationForm: NonNullable<HumanStep['form']> = {
    schemaVersion: 1,
    title: 'Kết quả chuẩn bị',
    sections: [
      {
        id: 'confirmation',
        title: 'Xác nhận',
        fields: [{ id: 'ready', type: 'boolean', label: 'Đã sẵn sàng', required: true }],
      },
    ],
  };
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Gửi', next: 'intake' },
    { ...assignment, id: 'intake', kind: 'task', label: 'Tiếp nhận', next: 'split' },
    {
      id: 'split',
      kind: 'parallel',
      label: 'Xử lý cùng lúc',
      branches: ['finance', 'technical'],
      join: 'join',
    },
    {
      ...assignment,
      id: 'finance',
      kind: 'approval',
      label: 'Tài chính duyệt',
      assignee: '',
      assigneeRule: { kind: 'pool', groupId: council.id, mode: 'all' },
      next: 'join',
    },
    {
      id: 'technical',
      kind: 'parallel',
      label: 'Hỗ trợ',
      branches: ['it', 'assets'],
      join: 'technical_join',
    },
    {
      ...assignment,
      id: 'it',
      kind: 'task',
      label: 'Chuẩn bị tài khoản',
      next: 'technical_join',
      form: verificationForm,
    },
    {
      ...assignment,
      id: 'assets',
      kind: 'task',
      label: 'Cấp tài sản',
      assignee: finance.accountId,
      next: 'technical_join',
      form: verificationForm,
    },
    { id: 'technical_join', kind: 'join', label: 'Đủ hỗ trợ', next: 'join' },
    { id: 'join', kind: 'join', label: 'Hợp nhánh', next: 'ready' },
    {
      id: 'ready',
      kind: 'condition',
      label: 'Đủ tài khoản và tài sản?',
      yes: 'signoff',
      no: 'end',
      condition: {
        schemaVersion: 1,
        logicalOperator: 'AND',
        rules: [
          { fieldCode: 'step.it.ready', operator: 'EQUALS', value: true },
          { fieldCode: 'step.assets.ready', operator: 'EQUALS', value: true },
        ],
      },
    },
    {
      ...assignment,
      id: 'signoff',
      kind: 'approval',
      label: 'Xác nhận hoàn tất',
      assignee: '',
      assigneeRule: { kind: 'previous', stepId: 'assets' },
      next: 'end',
      returnMode: 'choose',
    },
    { id: 'end', kind: 'end', label: 'Xong' },
  ];
  const saved = await service.saveDefinition(c(designer), {
    code: 'parallel-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const published = await service.publish(c(publisher), saved.id, saved.revision);
  const run = await service.start(c(requester), {
    definitionId: saved.id,
    versionId: published.version.id,
    unitId: unitA,
    title: 'Tiếp nhận nhân sự song song',
    answers: { purpose: 'Giả lập', requested_on: '2026-12-01' },
  });
  const intake = await pending(run.id);
  await service.act(c(handler), intake.id, {
    expectedRevision: intake.revision,
    action: 'complete',
    answers: {},
  });
  const first = await service.detail(c(requester), run.id);
  const tasks = new Map(
    first.tasks.filter((task) => task.status === 'pending').map((task) => [task.node_id, task]),
  );
  assert.deepEqual([...tasks.keys()].sort(), ['assets', 'finance', 'it']);
  const it = tasks.get('it')!,
    assets = tasks.get('assets')!,
    approval = tasks.get('finance')!;
  assert.equal((await service.detail(c(handler), run.id)).activeTaskId, it.id);
  const work = new WorkflowWorkCenter(service);
  const workRows = (await work.work(c(finance), { view: 'assigned', page: 0, search: run.title }))
    .items;
  assert.deepEqual(new Set(workRows.map((row) => row.taskId)), new Set([assets.id, approval.id]));
  assert.ok(workRows.every((row) => row.route.endsWith('/' + row.taskId)));
  const inbox = (await service.runs(c(finance), 'inbox')).items.filter((row) => row.id === run.id);
  assert.deepEqual(new Set(inbox.map((row) => row.task_id)), new Set([assets.id, approval.id]));
  await assert.rejects(
    () =>
      service.act(c(finance), it.id, {
        expectedRevision: it.revision,
        action: 'complete',
        answers: {},
      }),
    { code: 'WORKFLOW_NOT_ASSIGNED' },
  );
  const financeVote = c(finance);
  const vote = { expectedRevision: approval.revision, action: 'approve' as const, answers: {} };
  const results = await Promise.all([
    service.act(c(handler), it.id, {
      expectedRevision: it.revision,
      action: 'complete',
      answers: { ready: true },
    }),
    service.act(c(finance), assets.id, {
      expectedRevision: assets.revision,
      action: 'complete',
      answers: { ready: true },
    }),
    service.act(financeVote, approval.id, vote),
  ]);
  assert.equal(results.filter((result) => result.current_step === 'signoff').length, 1);
  assert.deepEqual(await service.act(financeVote, approval.id, vote), results[2]);
  const signoff = await pending(run.id);
  assert.equal(signoff.node_id, 'signoff');
  assert.equal(signoff.assignee_account_id, finance.accountId);
  const joined = await service.detail(c(finance), run.id);
  assert.equal(joined.history.filter((event) => event.action === 'run.parallel_joined').length, 2);
  assert.ok(joined.returnTargets.some((target) => target.id === it.id));
  await service.act(c(finance), signoff.id, {
    expectedRevision: signoff.revision,
    action: 'return',
    returnTarget: it.id,
    answers: {},
  });
  const replayed = await service.detail(c(requester), run.id);
  assert.equal(replayed.tasks.find((task) => task.id === approval.id)?.superseded_by_task_id, null);
  assert.equal(replayed.tasks.find((task) => task.id === assets.id)?.superseded_by_task_id, null);
  const replay = await pending(run.id);
  assert.equal(replay.node_id, it.node_id);
  assert.equal(replay.attempt, 2);
  await service.act(c(handler), replay.id, {
    expectedRevision: replay.revision,
    action: 'complete',
    answers: { ready: true },
  });
  const signoffAgain = await pending(run.id);
  assert.equal(signoffAgain.node_id, signoff.node_id);
  assert.equal(signoffAgain.attempt, 2);
  const recallView = await service.detail(c(handler), run.id);
  assert.ok(recallView.recallTargets.some((target) => target.taskId === replay.id));
  await service.recall(c(handler), run.id, {
    expectedRevision: recallView.run.revision,
    sourceTaskId: replay.id,
  });
  const recalled = await service.detail(c(requester), run.id);
  assert.equal(recalled.tasks.find((task) => task.id === signoffAgain.id)?.status, 'cancelled');
  assert.equal(recalled.tasks.find((task) => task.id === assets.id)?.superseded_by_task_id, null);
  const reopened = await pending(run.id);
  assert.equal(reopened.node_id, 'it');
  assert.equal(reopened.attempt, 3);
  await service.act(c(handler), reopened.id, {
    expectedRevision: reopened.revision,
    action: 'complete',
    answers: { ready: true },
  });
  const final = await pending(run.id);
  const finished = await service.act(c(finance), final.id, {
    expectedRevision: final.revision,
    action: 'approve',
    answers: {},
  });
  assert.equal(finished.status, 'completed');
});

test('The actual sender recalls a reassigned step with its deadline and audit failure leaves the successor open', async () => {
  const council = await group();
  const spec = workflowTemplate('blank');
  spec.schemaVersion = 5;
  spec.audienceUnits = [unitA];
  const review = spec.nodes.find((node) => node.id === 'review') as HumanStep;
  review.assignee = handler.accountId;
  review.next = 'finish';
  spec.nodes.push({
    id: 'finish',
    kind: 'approval',
    label: 'Chốt chứng từ',
    assignee: '',
    assigneeRule: { kind: 'pool', groupId: council.id, mode: 'all' },
    dueHours: 24,
    form: null,
    next: 'end',
  });
  const definition = await service.saveDefinition(c(designer), {
    code: 'recall-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const published = await service.publish(c(publisher), definition.id, definition.revision);
  const run = await service.start(c(requester), {
    definitionId: definition.id,
    versionId: published.version.id,
    unitId: unitA,
    title: 'Thu hồi để sửa chứng từ',
    answers: { purpose: 'Giả lập', requested_on: '2026-12-01' },
  });
  const initial = await pending(run.id);
  const assigned = await service.reassign(c(manager), initial.id, {
    expectedRevision: initial.revision,
    accountId: finance.accountId,
  });
  const forwarded = await service.act(c(finance), assigned.id, {
    expectedRevision: assigned.revision,
    action: 'approve',
    answers: {},
  });
  const successor = await pending(run.id);
  const input = { expectedRevision: forwarded.revision, sourceTaskId: assigned.id };
  await assert.rejects(() => service.recall(c(handler), run.id, input), {
    code: 'WORKFLOW_NOT_ASSIGNED',
  });
  await assert.rejects(
    () => service.recall(c(finance, { tenantId: randomUUID() }), run.id, input),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  const permissions = finance.permissions;
  finance.permissions = [];
  try {
    await assert.rejects(() => service.recall(c(finance), run.id, input), {
      code: 'WORKFLOW_PERMISSION_DENIED',
    });
  } finally {
    finance.permissions = permissions;
  }
  assert.deepEqual(
    (await service.detail(c(finance), run.id)).recallTargets.map((target) => target.taskId),
    [assigned.id],
  );
  const fault = c(finance);
  await owner.query(
    `CREATE FUNCTION recall_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
       IF NEW.request_id='${fault.requestId}' AND NEW.action='run.recalled' THEN
        RAISE EXCEPTION 'Synthetic recall audit failure';
       END IF; RETURN NEW; END; $$;`,
  );
  await owner.query(
    'CREATE TRIGGER recall_test_failure BEFORE INSERT ON workflow_audit FOR EACH ROW EXECUTE FUNCTION recall_test_failure()',
  );
  try {
    await assert.rejects(() => service.recall(fault, run.id, input));
  } finally {
    await owner.query('DROP TRIGGER recall_test_failure ON workflow_audit');
    await owner.query('DROP FUNCTION recall_test_failure()');
  }
  assert.equal((await pending(run.id)).id, successor.id);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM workflow_recall_events WHERE tenant_id=$1 AND run_id=$2', [
        tenant,
        run.id,
      ])
    ).rowCount,
    0,
  );
  const result = await service.recall(fault, run.id, input);
  assert.deepEqual(await service.recall(fault, run.id, input), result);
  const replay = await pending(run.id);
  assert.equal(replay.attempt, 2);
  assert.equal(replay.assignee_account_id, finance.accountId);
  assert.equal(new Date(replay.due_at).toISOString(), new Date(initial.due_at).toISOString());
  const retained = await service.detail(c(requester), run.id);
  assert.equal(retained.tasks.find((task) => task.id === assigned.id)?.status, 'completed');
  assert.equal(retained.tasks.find((task) => task.id === successor.id)?.status, 'cancelled');
  await assert.rejects(
    () =>
      service.act(c(handler), successor.id, {
        expectedRevision: successor.revision,
        action: 'approve',
        answers: {},
      }),
    { code: 'REVISION_CONFLICT' },
  );
  await service.act(c(finance), replay.id, {
    expectedRevision: replay.revision,
    action: 'approve',
    answers: {},
  });
  const next = await pending(run.id);
  const voted = await service.act(c(handler), next.id, {
    expectedRevision: next.revision,
    action: 'approve',
    answers: {},
  });
  assert.equal((await pending(run.id)).id, next.id);
  assert.deepEqual((await service.detail(c(finance), run.id)).recallTargets, []);
  await assert.rejects(
    () =>
      service.recall(c(finance), run.id, {
        expectedRevision: voted.revision,
        sourceTaskId: replay.id,
      }),
    { code: 'WORKFLOW_RECALL_UNAVAILABLE' },
  );
});

test('Attachments are bound to drafts, rounds and editable step fields with current read authority', async () => {
  const spec = workflowTemplate('blank');
  spec.schemaVersion = 5;
  spec.input.schemaVersion = 2;
  spec.audienceUnits = [unitA];
  const policy = { formats: ['txt', 'pdf'], maxFiles: 2, maxBytes: 2000 } as NonNullable<
    import('../src/forms/contracts.js').FormField['attachments']
  >;
  spec.input.sections[0]!.fields.push({
    id: 'documents',
    type: 'attachment',
    label: 'Chứng từ mua sắm',
    required: true,
    attachments: policy,
  });
  const review = spec.nodes.find((node) => node.id === 'review') as HumanStep;
  review.assignee = handler.accountId;
  review.next = 'finance';
  spec.nodes.push({
    id: 'finance',
    kind: 'task',
    label: 'Đối soát chứng từ',
    assignee: finance.accountId,
    dueHours: 24,
    next: 'end',
    inputFields: { documents: 'required' },
    form: {
      schemaVersion: 2,
      title: 'Đối soát',
      sections: [
        {
          id: 'proof',
          title: 'Kết quả',
          fields: [
            {
              id: 'evidence',
              type: 'attachment',
              label: 'Biên bản',
              required: true,
              attachments: policy,
            },
          ],
        },
      ],
    },
  });
  spec.fieldReaders = { 'input.documents': ['finance'] };
  const definition = await service.saveDefinition(c(designer), {
    code: 'attachments-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const published = await service.publish(c(publisher), definition.id, definition.revision);
  const baseAnswers = { purpose: 'Mua vật tư', requested_on: '2026-12-01' };
  const input = {
    definitionId: definition.id,
    versionId: published.version.id,
    unitId: unitA,
    title: 'Đính kèm chứng từ mua sắm',
    answers: baseAnswers,
  };
  const draft = await service.saveRequest(c(requester), input);
  const otherDraft = await service.saveRequest(c(requester), input);
  const bytes = Buffer.from('Chứng từ giả lập TLQM');
  const upload = {
    fieldId: 'documents',
    fileName: 'Chứng từ.txt',
    content: bytes.toString('base64'),
  };
  const command = c(requester);
  const uploaded = await service.uploadAttachment(command, 'request', draft.id, upload);
  assert.equal(uploaded.status, 'ready');
  await assert.rejects(
    () =>
      service.uploadAttachment(c(requester), 'request', draft.id, {
        ...upload,
        content: Buffer.alloc(2001, 65).toString('base64'),
      }),
    { code: 'WORKFLOW_ATTACHMENT_TOO_LARGE' },
  );
  assert.deepEqual(await service.uploadAttachment(command, 'request', draft.id, upload), uploaded);
  assert.deepEqual((await service.downloadAttachment(c(requester), uploaded.id)).content, bytes);
  await assert.rejects(() => service.downloadAttachment(c(handler), uploaded.id), {
    code: 'WORKFLOW_ATTACHMENT_NOT_FOUND',
  });
  const rejected = await service.uploadAttachment(c(requester), 'request', draft.id, {
    ...upload,
    fileName: 'Sai định dạng.pdf',
  });
  assert.equal(rejected.status, 'quarantined');
  await assert.rejects(() => service.downloadAttachment(c(requester), rejected.id), {
    code: 'WORKFLOW_ATTACHMENT_NOT_FOUND',
  });
  await assert.rejects(
    () =>
      service.saveRequest(
        c(requester),
        { ...input, answers: { ...baseAnswers, documents: [uploaded.id] } },
        otherDraft.id,
        otherDraft.revision,
      ),
    { code: 'FORM_VALIDATION_FAILED' },
  );
  await assert.rejects(
    () =>
      service.saveRequest(
        c(requester),
        { ...input, answers: { ...baseAnswers, documents: [rejected.id] } },
        draft.id,
        draft.revision,
      ),
    { code: 'FORM_VALIDATION_FAILED' },
  );
  const saved = await service.saveRequest(
    c(requester),
    { ...input, answers: { ...baseAnswers, documents: [uploaded.id] } },
    draft.id,
    draft.revision,
  );
  assert.deepEqual((await service.requestDraft(c(requester), saved.id)).attachments, [uploaded]);
  const run = await service.submitRequest(c(requester), saved.id, saved.revision);
  const first = await pending(run.id);
  assert.deepEqual((await service.detail(c(handler), run.id)).attachments, []);
  await assert.rejects(() => service.downloadAttachment(c(handler), uploaded.id), {
    code: 'WORKFLOW_ATTACHMENT_NOT_FOUND',
  });
  const returned = await service.act(c(handler), first.id, {
    expectedRevision: first.revision,
    action: 'return',
    answers: {},
  });
  const additional = await service.uploadAttachment(c(requester), 'revision', run.id, {
    ...upload,
    fileName: 'Bổ sung.txt',
  });
  await service.resubmit(c(requester), run.id, {
    expectedRevision: returned.revision,
    answers: { ...baseAnswers, documents: [uploaded.id, additional.id] },
  });
  const reviewAgain = await pending(run.id);
  await service.act(c(handler), reviewAgain.id, {
    expectedRevision: reviewAgain.revision,
    action: 'approve',
    answers: {},
  });
  const task = await pending(run.id);
  assert.equal((await service.detail(c(finance), run.id)).attachments.length, 2);
  assert.deepEqual((await service.downloadAttachment(c(finance), additional.id)).content, bytes);
  const evidence = await service.uploadAttachment(c(finance), 'task', task.id, {
    ...upload,
    fieldId: 'evidence',
    fileName: 'Biên bản.txt',
  });
  const completed = await service.act(c(finance), task.id, {
    expectedRevision: task.revision,
    action: 'complete',
    answers: { 'input.documents': [uploaded.id, additional.id], evidence: [evidence.id] },
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual((await service.downloadAttachment(c(requester), evidence.id)).content, bytes);
  const old = await service.detail(c(requester), run.id);
  assert.deepEqual(old.inputs[0].inputs.documents, [uploaded.id]);
  const permissions = finance.permissions;
  finance.permissions = [];
  try {
    await assert.rejects(() => service.downloadAttachment(c(finance), additional.id), {
      code: 'WORKFLOW_ATTACHMENT_NOT_FOUND',
    });
  } finally {
    finance.permissions = permissions;
  }
});

test('Parallel handoff requires every live recipient and returning before the split closes the old branches', async () => {
  const people = await group();
  const spec = workflowTemplate('blank');
  spec.schemaVersion = 5;
  spec.audienceUnits = [unitA];
  const rule = { kind: 'group', groupId: people.id, selectionTiming: 'handoff' } as const;
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Gửi', next: 'intake' },
    {
      id: 'intake',
      kind: 'task',
      label: 'Tiếp nhận',
      assignee: handler.accountId,
      dueHours: 24,
      form: null,
      next: 'split',
    },
    {
      id: 'split',
      kind: 'parallel',
      label: 'Xử lý cùng lúc',
      branches: ['one', 'two'],
      join: 'join',
    },
    ...['one', 'two'].map((id): HumanStep => ({
      id,
      kind: 'task',
      label: 'Nhánh ' + id,
      assignee: '',
      assigneeRule: rule,
      dueHours: 24,
      form: null,
      next: 'join',
      returnMode: 'previous',
    })),
    { id: 'join', kind: 'join', label: 'Hợp nhánh', next: 'end' },
    { id: 'end', kind: 'end', label: 'Xong' },
  ];
  const saved = await service.saveDefinition(c(designer), {
    code: 'split-handoff-' + randomUUID().slice(0, 8),
    orgUnitId: unitA,
    spec,
  });
  const published = await service.publish(c(publisher), saved.id, saved.revision);
  const run = await service.start(c(requester), {
    definitionId: saved.id,
    versionId: published.version.id,
    unitId: unitA,
    title: 'Bàn giao hai nhánh',
    answers: { purpose: 'Giả lập', requested_on: '2026-12-01' },
  });
  const intake = await pending(run.id);
  const forward = { expectedRevision: intake.revision, action: 'complete' as const, answers: {} };
  const handoffs = ['one', 'two'].map((stepId) => ({ stepId, accountId: finance.accountId }));
  assert.deepEqual(
    (await service.previewHandoff(c(handler), intake.id, forward)).selections?.map(
      (choice) => choice.stepId,
    ),
    ['one', 'two'],
  );
  await assert.rejects(
    () => service.act(c(handler), intake.id, { ...forward, handoff: handoffs[0]! }),
    {
      code: 'WORKFLOW_HANDOFF_REQUIRED',
    },
  );
  assert.equal((await pending(run.id)).id, intake.id);
  await service.act(c(handler), intake.id, { ...forward, handoffs });
  const opened = (await service.detail(c(finance), run.id)).tasks;
  const first = opened.find((task) => task.node_id === 'one')!;
  const sibling = opened.find((task) => task.node_id === 'two')!;
  const returned = await service.act(c(finance), first.id, {
    expectedRevision: first.revision,
    action: 'return',
    answers: {},
  });
  assert.equal(returned.current_step, 'intake');
  const retained = await service.detail(c(requester), run.id);
  assert.equal(retained.tasks.find((task) => task.id === sibling.id)?.status, 'cancelled');
  assert.equal(
    retained.tasks.find((task) => task.id === sibling.id)?.superseded_by_task_id,
    first.id,
  );
  assert.equal(retained.tasks.filter((task) => task.status === 'pending').length, 1);
});
