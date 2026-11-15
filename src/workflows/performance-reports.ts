import type { Pool, PoolClient } from 'pg';
import { isDate } from '../forms/contracts.js';
import type { Answers } from '../forms/contracts.js';
import { csvCell } from '../forms/reporting.js';
import { HttpError } from '../security.js';
import { workflowUuid } from './contracts.js';
import {
  fieldAggregates,
  reportOptions,
  reportHistory,
  reportStateLabels,
  reportUsesFields,
} from './report-options.js';
import type {
  PerformanceReportQuery,
  ReportBucket,
  ReportMetrics,
  ReportObservation,
  ReportFieldChoice,
} from './report-options.js';

type Db = Pool | PoolClient;
export type ReportScope = { tenantId: string; allUnits: boolean; unitIds: string[] };
const day = 86_400_000;
const groupPageSize = 20;
const detailPageSize = 30;
const exportLimit = 2000;
export const reportFieldAddress =
  /^(?:input\.[a-z][a-z0-9_]{0,63}|step\.[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_]{0,63})(?::[a-z][a-z0-9_]{0,39})?$/;

export function parsePerformanceReport(input: PerformanceReportQuery) {
  if (!Object.hasOwn(reportOptions, input.dataset))
    throw new HttpError(400, 'WORKFLOW_REPORT_INVALID');
  const options = reportOptions[input.dataset];
  if (
    !(options.groups as readonly string[]).includes(input.groupBy) ||
    (!(options.measures as readonly string[]).includes(input.measure) &&
      !(input.measure === 'fieldValue' && input.metricField)) ||
    (input.status !== undefined && !(options.states as readonly string[]).includes(input.status)) ||
    (input.history !== undefined && !reportHistory.includes(input.history)) ||
    !isDate(input.from) ||
    !isDate(input.to)
  )
    throw new HttpError(400, 'WORKFLOW_REPORT_INVALID');
  const columns = input.columns?.split(',') ?? [];
  if (
    (reportUsesFields(input) && !input.versionId) ||
    (input.groupBy === 'field') !== Boolean(input.groupField) ||
    (input.match && (!input.filterField || !/^[a-f0-9]{64}$/.test(input.match))) ||
    Boolean(input.metricField) !== Boolean(input.aggregate) ||
    (input.aggregate && !fieldAggregates.includes(input.aggregate)) ||
    columns.length > 6 ||
    new Set(columns).size !== columns.length ||
    [input.groupField, input.filterField, input.metricField, ...columns].some(
      (field) => field !== undefined && !reportFieldAddress.test(field),
    )
  )
    throw new HttpError(400, 'WORKFLOW_REPORT_INVALID');
  for (const id of [input.unitId, input.versionId]) if (id !== undefined) workflowUuid(id);
  const since = Date.parse(input.from + 'T00:00:00+07:00');
  const until = Date.parse(input.to + 'T00:00:00+07:00') + day;
  if (
    !Number.isFinite(since) ||
    !Number.isFinite(until) ||
    until <= since ||
    until - since > 366 * day
  )
    throw new HttpError(400, 'WORKFLOW_REPORT_DATES_INVALID');
  return {
    ...input,
    history: input.dataset === 'runs' ? 'all' : (input.history ?? 'effective'),
    since: new Date(since),
    until: new Date(until),
  };
}
export type ReportQuery = ReturnType<typeof parsePerformanceReport>;
export type ReportFieldRow = {
  run_id: string;
  task_id: string | null;
  person_id: string | null;
  unit_id: string;
  round: number;
  node_id: string | null;
  owner_account_id: string;
  owner_person_id: string;
  inputs: Answers;
  answers: Answers | null;
};
export type ReportProjection = {
  rows: {
    run_id: string;
    task_id: string | null;
    person_id: string | null;
    field_key: string | null;
    field_label: string | null;
    field_values: Record<string, string | null>;
    field_number: string | null;
  }[];
  columns: ReportFieldChoice[];
  metric?: ReportFieldChoice;
};

const runs = `SELECT id AS run_id, NULL::uuid AS task_id, title, unit_id, version_id, workflow, version,
    NULL::text AS node_id,NULL::text AS step,round,NULL::integer AS attempt,
    NULL::uuid AS person_id,NULL::text AS person,status,started_at AS observed_at,started_at,
    NULL::timestamptz AS due_at,finished_at,false AS superseded,false AS overdue,NULL::boolean AS late,
    CASE WHEN status IN('completed','rejected') THEN EXTRACT(epoch FROM finished_at-started_at)::float8 END AS seconds
  FROM scoped_runs`;
const taskColumns = `r.id AS run_id,t.id AS task_id,r.title,r.unit_id,r.version_id,r.workflow,r.version,
    t.node_id,t.label AS step,t.round,t.attempt`;
const taskSource = `FROM scoped_runs r JOIN workflow_tasks t ON (t.tenant_id,t.run_id)=(r.tenant_id,r.id)
    LEFT JOIN workflow_task_supersessions s ON (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id)`;
const superseded = '(t.round<>r.round OR s.task_id IS NOT NULL)';
const sources = {
  runs,
  attempts: `SELECT ${taskColumns},NULL::uuid AS person_id,t.assignee_name AS person,t.status,
    t.created_at AS observed_at,t.created_at AS started_at,t.due_at,t.finished_at,
    ${superseded} AS superseded,(t.status='pending' AND t.due_at<$10::timestamptz) AS overdue,
    CASE WHEN t.status IN('completed','rejected','returned') THEN t.finished_at>t.due_at END AS late,
    CASE WHEN t.status IN('completed','rejected','returned') THEN EXTRACT(epoch FROM t.finished_at-t.created_at)::float8 END AS seconds
    ${taskSource}`,
  decisions: `SELECT ${taskColumns},d.person_id,d.person,d.action AS status,
    d.decided_at AS observed_at,t.created_at AS started_at,t.due_at,d.decided_at AS finished_at,
    ${superseded} AS superseded,false AS overdue,(d.decided_at>t.due_at) AS late,
    EXTRACT(epoch FROM d.decided_at-t.created_at)::float8 AS seconds
    ${taskSource}
    JOIN LATERAL (
      SELECT x.actor_person_id AS person_id,t.assignee_name AS person,x.action,x.created_at AS decided_at
        FROM workflow_task_results x WHERE (x.tenant_id,x.task_id)=(t.tenant_id,t.id) AND t.approval_policy IS NULL
      UNION ALL
      SELECT x.person_id,m.name,x.action,x.created_at FROM workflow_approval_votes x
        JOIN workflow_approval_members m ON (m.tenant_id,m.task_id,m.account_id)=(x.tenant_id,x.task_id,x.account_id)
        WHERE (x.tenant_id,x.task_id)=(t.tenant_id,t.id) AND t.approval_policy IS NOT NULL
    ) d ON true`,
};
const groups = {
  version: ['version_id::text', "workflow || ' · v' || version"],
  unit: ['unit_id::text', 'unit_id::text'],
  step: ["version_id::text || '/' || node_id", "step || ' · ' || workflow || ' · v' || version"],
  status: ['status', 'status'],
  person: ["md5($1::uuid::text || '/' || person_id::text)", 'person'],
} as const;

function population(scope: ReportScope, query: ReportQuery, observedAt: string) {
  if (query.unitId && !scope.allUnits && !scope.unitIds.includes(query.unitId))
    throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
  const [key, label] = groups[query.groupBy === 'field' ? 'version' : query.groupBy];
  const sql = `WITH scoped_runs AS (
    SELECT r.id,r.tenant_id,r.org_unit_id AS unit_id,r.title,r.status,r.round,r.version_id,
      r.created_at AS started_at,r.finished_at,v.spec->>'name' AS workflow,v.version
    FROM workflow_runs r JOIN workflow_versions v ON (v.tenant_id,v.definition_id,v.id)=(r.tenant_id,r.definition_id,r.version_id)
    WHERE r.tenant_id=$1::uuid AND ($2::boolean OR r.org_unit_id=ANY($3::uuid[]))
      AND ($4::uuid IS NULL OR r.org_unit_id=$4) AND ($5::uuid IS NULL OR r.version_id=$5)
  ), source AS (${sources[query.dataset]}), observations AS (
    SELECT source.*,${key} AS group_key,${label} AS group_label
    FROM source WHERE observed_at>=$6::timestamptz AND observed_at<$7::timestamptz AND observed_at<=$10::timestamptz
      AND ($8::text IS NULL OR status=$8)
      AND ($9::text='all' OR superseded=($9='superseded'))
  )`;
  return {
    sql,
    args: [
      scope.tenantId,
      scope.allUnits,
      scope.unitIds,
      query.unitId ?? null,
      query.versionId ?? null,
      query.since,
      query.until,
      query.status ?? null,
      query.history,
      observedAt,
    ],
  };
}

export async function reportFieldRows(
  db: Db,
  scope: ReportScope,
  query: ReportQuery,
  observedAt: string,
) {
  const { sql, args } = population(scope, query, observedAt);
  const rows = (
    await db.query<ReportFieldRow>(
      `${sql}
    SELECT o.run_id,o.task_id,o.person_id,o.unit_id,o.round,o.node_id,r.owner_account_id,r.owner_person_id,
      COALESCE(h.inputs,CASE WHEN r.round=o.round THEN r.inputs END,'{}'::jsonb) AS inputs,
      ${query.dataset === 'decisions' ? 'CASE WHEN t.approval_policy IS NOT NULL THEN vote.answers ELSE result.answers END' : 'result.answers'} AS answers
    FROM observations o JOIN workflow_runs r ON (r.tenant_id,r.id)=($1::uuid,o.run_id)
    LEFT JOIN workflow_run_inputs h ON (h.tenant_id,h.run_id,h.round)=(r.tenant_id,r.id,o.round)
    LEFT JOIN workflow_task_results result ON (result.tenant_id,result.task_id)=(r.tenant_id,o.task_id)
    ${
      query.dataset === 'decisions'
        ? `LEFT JOIN workflow_tasks t ON (t.tenant_id,t.id)=(r.tenant_id,o.task_id)
       LEFT JOIN workflow_approval_votes vote ON (vote.tenant_id,vote.task_id,vote.person_id)=(r.tenant_id,o.task_id,o.person_id)`
        : ''
    }
    LIMIT 5001`,
      args,
    )
  ).rows;
  if (rows.length > 5000) throw new HttpError(413, 'WORKFLOW_REPORT_FIELDS_TOO_LARGE');
  return rows;
}

export async function reportFieldSpec(db: Db, scope: ReportScope, query: ReportQuery) {
  if (query.unitId && !scope.allUnits && !scope.unitIds.includes(query.unitId))
    throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
  const row = (
    await db.query<{ spec: unknown }>(
      `SELECT v.spec FROM workflow_versions v
    WHERE (v.tenant_id,v.id)=($1,$2) AND EXISTS(SELECT 1 FROM workflow_runs r
      WHERE (r.tenant_id,r.definition_id,r.version_id)=(v.tenant_id,v.definition_id,v.id)
      AND ($3::boolean OR r.org_unit_id=ANY($4::uuid[])) AND ($5::uuid IS NULL OR r.org_unit_id=$5))`,
      [scope.tenantId, query.versionId, scope.allUnits, scope.unitIds, query.unitId ?? null],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
  return row.spec;
}

function reportRows(
  scope: ReportScope,
  query: ReportQuery,
  observedAt: string,
  projected?: ReportProjection,
) {
  const { sql, args } = population(scope, query, observedAt);
  const key = query.groupBy === 'field' ? 'field_key' : 'group_key';
  const label = query.groupBy === 'field' ? 'field_label' : 'group_label';
  return projected
    ? {
        sql: `${sql}, report_rows AS (
      SELECT o.*,f.field_key,f.field_label,f.field_values,f.field_number
      FROM observations o JOIN jsonb_to_recordset($11::jsonb) AS f(run_id uuid, task_id uuid, person_id uuid,
        field_key text,field_label text,field_values jsonb,field_number numeric)
      ON f.run_id=o.run_id AND f.task_id IS NOT DISTINCT FROM o.task_id AND f.person_id IS NOT DISTINCT FROM o.person_id)`,
        args: [...args, JSON.stringify(projected.rows)],
        key,
        label,
      }
    : {
        sql: `${sql}, report_rows AS (SELECT *,NULL::jsonb AS field_values,NULL::numeric AS field_number FROM observations)`,
        args,
        key,
        label,
      };
}

type Aggregate = ReportMetrics & {
  total: boolean;
  key: string | null;
  label: string | null;
  groups: number;
};
const aggregateSql = (
  operation: NonNullable<ReportQuery['aggregate']>,
  field: ReportFieldChoice,
) => {
  if (operation === 'average') return `round(avg(field_number),${field.currency ? 2 : 6})`;
  return operation + '(field_number)';
};
const rollup = (key: string, label: string, query: ReportQuery, projected?: ReportProjection) =>
  `SELECT GROUPING(${key})=1 AS total,${key} AS key,MAX(${label}) AS label,
    count(*)::integer AS "rows",count(DISTINCT run_id)::integer AS "runs",
    count(DISTINCT task_id)::integer AS "attempts",count(DISTINCT person_id)::integer AS "people",
    avg(seconds)::float8 AS "averageSeconds",count(*) FILTER(WHERE late)::integer AS late,
    count(late)::integer AS assessed,
    100.0*count(*) FILTER(WHERE late)/NULLIF(count(late),0)::float8 AS "lateRate",
    count(*) FILTER(WHERE overdue)::integer AS "openOverdue"
    ${projected?.metric && query.aggregate ? `, ${aggregateSql(query.aggregate, projected.metric)} AS "fieldValue"` : ''}
  FROM report_rows GROUP BY GROUPING SETS ((${key}),())`;
const reportMetrics = ({
  total: _,
  key: __,
  label: ___,
  groups: ____,
  ...metrics
}: Aggregate): ReportMetrics => metrics;

export async function reportSummary(
  db: Db,
  scope: ReportScope,
  query: ReportQuery,
  page: number,
  observedAt: string,
  limit = groupPageSize,
  projected?: ReportProjection,
) {
  const { sql, args, key, label } = reportRows(scope, query, observedAt, projected);
  const order = `"${query.measure}" DESC NULLS LAST,label,key`;
  const rows = (
    await db.query<Aggregate>(
      `${sql}, aggregates AS (${rollup(key, label, query, projected)}), page AS (
    (SELECT * FROM aggregates WHERE total) UNION ALL
    (SELECT * FROM aggregates WHERE NOT total ORDER BY ${order} LIMIT $${args.length + 1} OFFSET $${args.length + 2})
  ) SELECT page.*,(SELECT count(*)::integer FROM aggregates WHERE NOT total) AS groups
    FROM page ORDER BY total DESC,${order}`,
      [...args, limit, (page - 1) * limit],
    )
  ).rows;
  const total = rows[0]!;
  return {
    observedAt,
    groupCount: total.groups,
    page,
    pageSize: limit,
    totals: reportMetrics(total),
    ...(projected?.metric && { fieldMetric: projected.metric }),
    groups: rows.slice(1).map((row): ReportBucket => ({
      key: row.key!,
      label: row.label!,
      metrics: reportMetrics(row),
    })),
  };
}

export async function reportDetail(
  db: Db,
  scope: ReportScope,
  query: ReportQuery,
  group: string,
  page: number,
  observedAt: string,
  limit = detailPageSize,
  projected?: ReportProjection,
) {
  const { sql, args, key } = reportRows(scope, query, observedAt, projected);
  return (
    await db.query<{ total: number; items: ReportObservation[] }>(
      `${sql}, bucket AS MATERIALIZED (
    SELECT * FROM report_rows WHERE ${key}=$${args.length + 1}
  ) SELECT (SELECT count(*)::integer FROM bucket) AS total,COALESCE(json_agg(detail),'[]'::json) AS items FROM (
    SELECT run_id AS "runId",task_id AS "taskId",title,unit_id AS "unitId",workflow,version,step,round,attempt,
      person,status,started_at AS "startedAt",due_at AS "dueAt",finished_at AS "finishedAt",
      seconds AS "elapsedSeconds",late,overdue,superseded${projected ? ',field_values AS fields' : ''}
    FROM bucket ORDER BY observed_at DESC,run_id,task_id,person_id LIMIT $${args.length + 2} OFFSET $${args.length + 3}
  ) detail`,
      [...args, group, limit, (page - 1) * limit],
    )
  ).rows[0]!;
}

export async function reportVersions(db: Db, scope: ReportScope) {
  return (
    await db.query<{ id: string; version: number; name: string }>(
      `SELECT DISTINCT v.id,v.version,v.spec->>'name' AS name FROM workflow_runs r
     JOIN workflow_versions v ON (v.tenant_id,v.definition_id,v.id)=(r.tenant_id,r.definition_id,r.version_id)
     WHERE r.tenant_id=$1 AND ($2::boolean OR r.org_unit_id=ANY($3::uuid[]))
     ORDER BY name,version DESC,v.id LIMIT 500`,
      [scope.tenantId, scope.allUnits, scope.unitIds],
    )
  ).rows;
}

export async function reportCsv(
  db: Db,
  scope: ReportScope,
  query: ReportQuery,
  observedAt: string,
  group?: string,
  projected?: ReportProjection,
) {
  let rows: unknown[][];
  if (group !== undefined) {
    const detail = await reportDetail(
      db,
      scope,
      query,
      group,
      1,
      observedAt,
      exportLimit,
      projected,
    );
    if (detail.total > exportLimit) throw new HttpError(413, 'WORKFLOW_REPORT_EXPORT_TOO_LARGE');
    rows = [
      [
        'Mã hồ sơ',
        'Mã lần xử lý',
        'Tiêu đề',
        'Đơn vị',
        'Quy trình',
        'Phiên bản',
        'Bước',
        'Vòng',
        'Lần xử lý',
        'Người xử lý',
        'Trạng thái',
        'Bắt đầu',
        'Hạn',
        'Kết thúc / quyết định',
        'Thời gian (giây)',
        'Trễ hạn',
        'Đang quá hạn',
        'Đã thay thế',
        ...(projected?.columns.map(({ label }) => label) ?? []),
      ],
      ...detail.items.map((row) => [
        row.runId,
        row.taskId,
        row.title,
        row.unitId,
        row.workflow,
        row.version,
        row.step,
        row.round,
        row.attempt,
        row.person,
        reportStateLabels[row.status] ?? row.status,
        row.startedAt,
        row.dueAt,
        row.finishedAt,
        row.elapsedSeconds,
        row.late === null ? null : row.late ? 'Có' : 'Không',
        row.overdue ? 'Có' : 'Không',
        row.superseded ? 'Có' : 'Không',
        ...(projected?.columns.map(({ id }) => row.fields?.[id]) ?? []),
      ]),
    ];
  } else {
    const summary = await reportSummary(db, scope, query, 1, observedAt, exportLimit, projected);
    if (summary.groupCount > exportLimit)
      throw new HttpError(413, 'WORKFLOW_REPORT_EXPORT_TOO_LARGE');
    const measures = reportOptions[query.dataset].measures as readonly (keyof ReportMetrics)[];
    const labels: Record<keyof ReportMetrics, string> = {
      rows: 'Số dòng dữ liệu',
      runs: 'Hồ sơ',
      attempts: 'Lần xử lý',
      people: 'Người xử lý',
      averageSeconds: 'Thời gian trung bình (giây)',
      late: 'Số trễ hạn',
      lateRate: 'Tỷ lệ trễ (%)',
      openOverdue: 'Đang quá hạn',
      assessed: 'Có kết quả để tính tỷ lệ trễ',
      fieldValue: 'Giá trị trường',
    };
    rows = [
      [
        'Nhóm',
        ...measures.map((measure) => labels[measure]),
        ...(projected?.metric
          ? [
              projected.metric.label +
                (projected.metric.currency ? ' (' + projected.metric.currency + ')' : ''),
            ]
          : []),
      ],
      ...summary.groups.map((bucket) => [
        query.groupBy === 'status'
          ? (reportStateLabels[bucket.label] ?? bucket.label)
          : bucket.label,
        ...measures.map((measure) => bucket.metrics[measure]),
        ...(projected?.metric ? [bucket.metrics.fieldValue] : []),
      ]),
    ];
  }
  return {
    rows: rows.length - 1,
    csv: '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
  };
}
