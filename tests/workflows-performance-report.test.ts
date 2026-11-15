import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { WorkflowsService } from '../src/workflows/service.js';
import { businessPurchaseTemplate, workflowTemplate } from '../src/workflows/templates.js';
import type { WorkflowSpec } from '../src/workflows/contracts.js';
import { HttpError } from '../src/security.js';
import type { WorkflowActor, WorkflowCommand } from '../src/workflows/access.js';
import type { PerformanceReportQuery } from '../src/workflows/report-options.js';

const runtime = await loadLocalConfig();
const config = await loadWorkflowsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 4 });
const tenant = randomUUID(),
  unitA = randomUUID(),
  unitB = randomUUID();
const otherTenant = randomUUID(),
  owner = randomUUID(),
  initiator = randomUUID(),
  assignee = randomUUID(),
  person = randomUUID();
const versionA = randomUUID(),
  versionB = randomUUID(),
  foreignVersion = randomUUID();
const run = randomUUID(),
  second = randomUUID(),
  outside = randomUUID(),
  foreign = randomUUID();
const prior = randomUUID(),
  replacement = randomUUID(),
  returned = randomUUID(),
  pending = randomUUID(),
  nextDay = randomUUID();
const subject = '=Mua sắm giả lập';
const secret = 'Ghi chú nội bộ phải giữ riêng';
const label = 'Báo cáo mua sắm ' + tenant.slice(0, 8);
const actor: WorkflowActor = {
  accountId: randomUUID(),
  personId: randomUUID(),
  appCode: 'aio-workflows',
  tenantIds: [tenant],
  units: [],
  permissions: [{ tenantId: tenant, orgUnitId: unitA, permission: 'workflows:report' }],
};
const service = new WorkflowsService(
  pool,
  {
    validateUnit: async () => {},
    assignee: async () => ({ name: 'Người xử lý giả lập', personId: person }),
  },
  undefined,
  'synthetic-report-key',
);
const ctx = (a: WorkflowActor = actor): WorkflowCommand => ({
  tenantId: tenant,
  actor: async () => a,
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
  reason: 'Nghiệm thu báo cáo giả lập',
});
const isCode = (code: string) => (error: unknown) =>
  error instanceof HttpError && error.code === code;
const query: PerformanceReportQuery = {
  dataset: 'attempts',
  groupBy: 'step',
  measure: 'lateRate',
  from: '2026-10-16',
  to: '2026-10-16',
};

async function seedDefinition(
  t: string,
  unit: string,
  version: string,
  name: string,
  spec = workflowTemplate('leave'),
) {
  const id = randomUUID();
  spec.name = name;
  await pool.query(
    `INSERT INTO workflow_definitions(id,tenant_id,code,name,category,org_unit_id,owner_account_id,draft,status,latest_version)
    VALUES($1,$2,$3,$4,'Báo cáo',$5,$6,$7,'published',1)`,
    [id, t, 'report-' + id.slice(0, 8), name, unit, owner, JSON.stringify(spec)],
  );
  await pool.query(
    'INSERT INTO workflow_versions(id,tenant_id,definition_id,version,spec,checksum,published_by) VALUES($1,$2,$3,1,$4,$5,$6)',
    [version, t, id, JSON.stringify(spec), 'synthetic-report', owner],
  );
  return id;
}

async function seedRun(
  id: string,
  t: string,
  unit: string,
  definition: string,
  version: string,
  title: string,
  complete: boolean,
) {
  await pool.query(
    `INSERT INTO workflow_runs(id,tenant_id,definition_id,version_id,org_unit_id,owner_account_id,owner_person_id,title,status,inputs,created_at,finished_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'2026-10-15T17:00:00Z',$11)`,
    [
      id,
      t,
      definition,
      version,
      unit,
      owner,
      initiator,
      title,
      complete ? 'completed' : 'running',
      JSON.stringify({ confidential: secret }),
      complete ? '2026-10-15T18:00:00Z' : null,
    ],
  );
}

async function seedTask(
  id: string,
  t: string,
  runId: string,
  node: string,
  start: string,
  due: string,
  finish: string | null,
  status: string,
  attempt = 1,
  round = 1,
) {
  await pool.query(
    `INSERT INTO workflow_tasks(id,tenant_id,run_id,round,node_id,label,kind,assignee_account_id,assignee_name,status,created_at,due_at,finished_at,attempt)
    VALUES($1,$2,$3,$12,$4,$5,'approval',$6,'Người xử lý giả lập',$7,$8,$9,$10,$11)`,
    [
      id,
      t,
      runId,
      node,
      node === 'review' ? 'Xét duyệt' : node,
      assignee,
      status,
      start,
      due,
      finish,
      attempt,
      round,
    ],
  );
  if (finish && status !== 'cancelled')
    await pool.query(
      `INSERT INTO workflow_task_results(tenant_id,task_id,actor_account_id,actor_person_id,action,answers,reason,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'Quyết định giả lập',$7)`,
      [
        t,
        id,
        assignee,
        person,
        status === 'returned' ? 'return' : 'approve',
        JSON.stringify({ confidential: secret }),
        finish,
      ],
    );
}

before(async () => {
  const marker = (await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows[0];
  assert.deepEqual(marker, { instance_id: runtime.instanceId, purpose: 'tlqm-aio-workflows-test' });
  const first = await seedDefinition(tenant, unitA, versionA, label);
  const scopedOut = await seedDefinition(tenant, unitB, versionB, 'Quy trình khác đơn vị');
  const crossTenant = await seedDefinition(
    otherTenant,
    unitA,
    foreignVersion,
    'Quy trình khác tenant',
  );
  await seedRun(run, tenant, unitA, first, versionA, subject, false);
  await seedRun(second, tenant, unitA, first, versionA, 'Hồ sơ hoàn thành', true);
  await seedRun(outside, tenant, unitB, scopedOut, versionB, 'Dữ liệu khác đơn vị', true);
  await seedRun(
    foreign,
    otherTenant,
    unitA,
    crossTenant,
    foreignVersion,
    'Dữ liệu khác tenant',
    true,
  );
  await seedTask(
    prior,
    tenant,
    run,
    'review',
    '2026-10-15T17:00Z',
    '2026-10-15T17:20Z',
    '2026-10-15T17:40Z',
    'completed',
  );
  await seedTask(
    returned,
    tenant,
    run,
    'return_review',
    '2026-10-15T17:40Z',
    '2026-10-15T18:30Z',
    '2026-10-15T18:00Z',
    'returned',
  );
  await pool.query(
    'INSERT INTO workflow_task_supersessions(tenant_id,run_id,round,task_id,caused_by_task_id) VALUES($1,$2,1,$3,$4)',
    [tenant, run, prior, returned],
  );
  await seedTask(
    replacement,
    tenant,
    run,
    'review',
    '2026-10-15T18:00Z',
    '2026-10-15T18:30Z',
    '2026-10-15T18:20Z',
    'completed',
    2,
  );
  await seedTask(
    pending,
    tenant,
    run,
    'pending_review',
    '2026-10-15T18:20Z',
    '2026-10-15T18:40Z',
    null,
    'pending',
  );
  await seedTask(
    nextDay,
    tenant,
    second,
    'review',
    '2026-10-16T17:00Z',
    '2026-10-16T18:00Z',
    '2026-10-16T17:30Z',
    'completed',
  );
  await seedTask(
    randomUUID(),
    tenant,
    outside,
    'review',
    '2026-10-15T17:00Z',
    '2026-10-15T18:00Z',
    '2026-10-15T17:30Z',
    'completed',
  );
  await seedTask(
    randomUUID(),
    otherTenant,
    foreign,
    'review',
    '2026-10-15T17:00Z',
    '2026-10-15T18:00Z',
    '2026-10-15T17:30Z',
    'completed',
  );
});
after(async () => {
  await pool.end();
});

test('SLA uses actual attempts, final decisions and Vietnam day boundaries, with matching detail', async () => {
  const current = await service.performanceReport(ctx(), query, 1);
  assert.equal(current.totals.rows, 3);
  assert.equal(current.totals.runs, 1);
  assert.equal(current.totals.assessed, 2);
  assert.equal(current.totals.lateRate, 0);
  assert.equal(current.totals.openOverdue, 1);
  assert.equal(current.totals.averageSeconds, 1200);
  const all = { ...query, history: 'all' } as const;
  const summary = await service.performanceReport(ctx(), all, 1);
  assert.equal(summary.totals.rows, 4);
  assert.equal(summary.totals.lateRate, 100 / 3);
  const bucket = summary.groups.find((group) => group.key === versionA + '/review')!;
  assert.equal(bucket.metrics.lateRate, 50);
  assert.equal(bucket.metrics.averageSeconds, 1800);
  const detail = await service.performanceReportDetail(
    ctx(),
    all,
    bucket.key,
    1,
    summary.observedAt,
  );
  assert.equal(detail.total, bucket.metrics.rows);
  assert.deepEqual(
    detail.items.map(({ taskId, superseded, late }) => ({ taskId, superseded, late })),
    [
      { taskId: replacement, superseded: false, late: false },
      { taskId: prior, superseded: true, late: true },
    ],
  );
  assert(!JSON.stringify(detail).includes(secret));
  assert(!JSON.stringify(detail).includes(nextDay));
  const runs = await service.performanceReport(
    ctx(),
    { ...query, dataset: 'runs', groupBy: 'version', measure: 'averageSeconds' },
    1,
  );
  assert.equal(runs.totals.rows, 2);
  assert.equal(runs.totals.averageSeconds, 3600);
});

test('Scoped selectors and exports enforce current grant on replay, with safe CSV and one audit receipt', async () => {
  assert.deepEqual((await service.performanceReportVersions(ctx())).items, [
    { id: versionA, version: 1, name: label },
  ]);
  await assert.rejects(
    service.performanceReport(ctx(), { ...query, unitId: unitB }, 1),
    isCode('WORKFLOW_PERMISSION_DENIED'),
  );
  await assert.rejects(
    service.performanceReport(ctx({ ...actor, permissions: [] }), query, 1),
    isCode('WORKFLOW_PERMISSION_DENIED'),
  );
  await assert.rejects(
    service.performanceReport(ctx(), { ...query, from: '2026-10-32' }, 1),
    isCode('WORKFLOW_REPORT_INVALID'),
  );
  const both: WorkflowActor = {
    ...actor,
    permissions: [
      ...actor.permissions,
      { tenantId: tenant, orgUnitId: unitB, permission: 'workflows:report' },
    ],
  };
  const command = ctx(both);
  const total = await service.exportPerformanceReport(command, query);
  assert(total.csv.includes('Quy trình khác đơn vị'));
  assert(!total.csv.includes('Quy trình khác tenant'));
  assert.deepEqual(await service.exportPerformanceReport(command, query), total);
  await assert.rejects(
    service.exportPerformanceReport({ ...command, actor: async () => actor }, query),
    isCode('IDEMPOTENCY_KEY_REUSED'),
  );
  const detail = await service.exportPerformanceReport(
    ctx(),
    { ...query, history: 'all' },
    versionA + '/review',
  );
  assert.match(detail.csv, /text: =Mua sắm giả lập/);
  assert.doesNotMatch(detail.csv, /Ghi chú nội bộ|khác đơn vị|khác tenant/);
  assert.equal(detail.rows, 2);
  const audit = (
    await pool.query(
      `SELECT details FROM workflow_audit WHERE tenant_id=$1 AND action='report.exported' AND request_id=$2`,
      [tenant, command.requestId],
    )
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.rows, total.rows);
  assert(!JSON.stringify(audit).includes(subject));
  const receipt = (
    await pool.query(
      'SELECT response FROM workflow_receipts WHERE tenant_id=$1 AND idempotency_key=$2',
      [tenant, command.idempotencyKey],
    )
  ).rows[0]?.response;
  assert(!Object.hasOwn(receipt, 'csv'));
});

test('Business report projects the authorized round and exact attempt, and invalidates revoked exports', async () => {
  const spec: WorkflowSpec = businessPurchaseTemplate();
  spec.audienceUnits = [unitA];
  for (const node of spec.nodes) if ('assignee' in node) node.assignee = assignee;
  spec.input.sections[0]!.fields.push(
    { id: 'confidential', type: 'shortText', label: 'Nhãn bảo mật giả lập', required: false },
    {
      id: 'extra',
      type: 'shortText',
      label: 'Ghi chú khi được chọn',
      required: false,
      visibleWhen: {
        mode: 'all',
        rules: [{ fieldId: 'purpose', operator: 'eq', value: 'Chứng từ mới' }],
      },
    },
  );
  spec.fieldReaders = { 'input.confidential': ['review'] };
  const versionId = randomUUID(),
    record = randomUUID();
  const definition = await seedDefinition(tenant, unitA, versionId, 'Báo cáo trường giả lập', spec);
  const oldInputs = {
    purpose: '=Chứng từ cũ',
    extra: 'Không hiển thị theo điều kiện',
    confidential: secret + ' cũ',
    items: { rows: [], totals: { amount: '0.10' } },
  };
  const newInputs = {
    purpose: 'Chứng từ mới',
    confidential: secret + ' mới',
    items: { rows: [], totals: { amount: '0.20' } },
  };
  await pool.query(
    `INSERT INTO workflow_runs(id,tenant_id,definition_id,version_id,org_unit_id,owner_account_id,owner_person_id,title,status,inputs,round,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'Báo cáo theo trường','running',$8,2,'2026-10-17T17:00:00Z')`,
    [record, tenant, definition, versionId, unitA, owner, initiator, JSON.stringify(newInputs)],
  );
  await pool.query(
    'INSERT INTO workflow_run_inputs(tenant_id,run_id,round,inputs) VALUES($1,$2,1,$3),($1,$2,2,$4)',
    [tenant, record, JSON.stringify(oldInputs), JSON.stringify(newInputs)],
  );
  const old = randomUUID(),
    replaced = randomUUID(),
    cause = randomUUID(),
    current = randomUUID();
  await seedTask(
    old,
    tenant,
    record,
    'review',
    '2026-10-17T17:00Z',
    '2026-10-17T17:25Z',
    '2026-10-17T17:20Z',
    'returned',
  );
  await seedTask(
    replaced,
    tenant,
    record,
    'review',
    '2026-10-17T17:20Z',
    '2026-10-17T17:40Z',
    '2026-10-17T17:35Z',
    'completed',
    1,
    2,
  );
  await seedTask(
    cause,
    tenant,
    record,
    'director',
    '2026-10-17T17:35Z',
    '2026-10-17T17:50Z',
    '2026-10-17T17:45Z',
    'returned',
    1,
    2,
  );
  await pool.query(
    'INSERT INTO workflow_task_supersessions(tenant_id,run_id,round,task_id,caused_by_task_id) VALUES($1,$2,2,$3,$4)',
    [tenant, record, replaced, cause],
  );
  await seedTask(
    current,
    tenant,
    record,
    'review',
    '2026-10-17T17:45Z',
    '2026-10-17T18:00Z',
    '2026-10-17T17:55Z',
    'completed',
    2,
    2,
  );

  const report = {
    ...query,
    versionId,
    from: '2026-10-18',
    to: '2026-10-18',
    history: 'all',
    groupBy: 'field',
    groupField: 'input.purpose',
    measure: 'fieldValue',
    metricField: 'input.items:amount',
    aggregate: 'sum',
    columns: 'input.purpose,input.items:amount,input.extra',
  } as const;
  const catalog = await service.performanceReportFields(ctx(), {
    ...report,
    filterField: 'input.purpose',
  });
  assert(!JSON.stringify(catalog).includes('Nhãn bảo mật'));
  const oldValue = catalog.values.find(({ label }) => label === oldInputs.purpose)!;
  assert.match(oldValue.id, /^[a-f0-9]{64}$/);
  await assert.rejects(
    service.performanceReport(ctx(), { ...report, versionId: versionB }, 1),
    isCode('WORKFLOW_NOT_FOUND'),
  );
  await assert.rejects(
    service.performanceReport(ctx(), { ...report, versionId: foreignVersion }, 1),
    isCode('WORKFLOW_NOT_FOUND'),
  );
  await assert.rejects(
    service.performanceReport(ctx(), { ...report, groupField: 'input.confidential' }, 1),
    isCode('WORKFLOW_REPORT_FIELD_DENIED'),
  );
  await assert.rejects(
    service.performanceReport(
      ctx(),
      { ...report, filterField: 'input.purpose', match: '0'.repeat(64) },
      1,
    ),
    isCode('WORKFLOW_REPORT_FILTER_STALE'),
  );

  const result = await service.performanceReport(ctx(), report, 1);
  assert.equal(result.totals.fieldValue, '0.70');
  assert.equal(result.totals.rows, 4);
  for (const [aggregate, expected] of [
    ['average', '0.18'],
    ['min', '0.10'],
    ['max', '0.20'],
  ] as const) {
    const calculated = await service.performanceReport(ctx(), { ...report, aggregate }, 1);
    assert.equal(calculated.totals.fieldValue, expected);
  }
  const narrowed = { ...report, filterField: 'input.purpose', match: oldValue.id };
  const filtered = await service.performanceReport(ctx(), narrowed, 1);
  assert.deepEqual(
    filtered.groups.map(({ key, label, metrics }) => [key, label, metrics.fieldValue]),
    [[oldValue.id, oldInputs.purpose, '0.10']],
  );
  const csv = await service.exportPerformanceReport(ctx(), narrowed, oldValue.id);
  assert.match(csv.csv, /text: =Chứng từ cũ/);
  assert.doesNotMatch(csv.csv, /Không hiển thị|Chứng từ mới|Nhãn bảo mật/);

  const reporter = { ...actor, accountId: assignee, personId: person };
  let acting: WorkflowActor = {
    ...reporter,
    permissions: [
      ...reporter.permissions,
      { tenantId: tenant, orgUnitId: unitA, permission: 'workflows:act' },
    ],
  };
  const command = { ...ctx(), actor: async () => acting };
  const privateColumns = { ...report, columns: report.columns + ',input.confidential' };
  const summary = await service.performanceReport(command, privateColumns, 1);
  const latest = summary.groups.find(({ label }) => label === newInputs.purpose)!;
  const detail = await service.performanceReportDetail(
    command,
    privateColumns,
    latest.key,
    1,
    summary.observedAt,
  );
  assert.equal(
    detail.items.find(({ taskId }) => taskId === current)?.fields?.['input.confidential'],
    newInputs.confidential,
  );
  assert(
    !Object.hasOwn(
      detail.items.find(({ taskId }) => taskId === replaced)!.fields!,
      'input.confidential',
    ),
  );
  assert.equal(
    detail.items.find(({ taskId }) => taskId === current)?.fields?.['input.extra'],
    null,
  );
  const firstExport = await service.exportPerformanceReport(command, privateColumns, latest.key);
  assert(firstExport.csv.includes(newInputs.confidential));
  assert.deepEqual(
    await service.exportPerformanceReport(command, privateColumns, latest.key),
    firstExport,
  );
  let authorityReads = 0;
  await assert.rejects(
    service.exportPerformanceReport(
      { ...command, actor: async () => (++authorityReads < 4 ? acting : reporter) },
      privateColumns,
      latest.key,
    ),
    isCode('WORKFLOW_PERMISSION_DENIED'),
  );
  acting = reporter;
  await assert.rejects(
    service.exportPerformanceReport(command, privateColumns, latest.key),
    isCode('WORKFLOW_REPORT_FIELD_DENIED'),
  );
  assert(
    !JSON.stringify(await service.performanceReportFields(command, report)).includes(
      'Nhãn bảo mật',
    ),
  );
});
