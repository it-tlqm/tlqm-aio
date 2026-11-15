import { createHmac } from 'node:crypto';
import { fieldState, schemaFields } from '../forms/contracts.js';
import type { Answers, FormField, FormSchema } from '../forms/contracts.js';
import { isNumericField } from '../forms/field-types.js';
import { isReferenceAnswer } from '../forms/references.js';
import { isTableAnswer } from '../forms/business.js';
import { HttpError } from '../security.js';
import { mayReadField } from './field-access.js';
import type { FieldAudience } from './field-access.js';
import type { WorkflowSpec } from './contracts.js';
import type { ReportFieldRow, ReportProjection, ReportQuery } from './performance-reports.js';
import type { ReportFieldChoice, ReportFieldValue } from './report-options.js';

type CatalogField = ReportFieldChoice & {
  origin: string;
  nodeId: string | null;
  field: FormField;
  form: FormSchema;
  column?: string;
};
const applicable = (field: CatalogField, row: ReportFieldRow) =>
  field.nodeId === null || row.node_id === field.nodeId;
const publicChoice = ({ id, label, numeric, currency }: CatalogField): ReportFieldChoice => ({
  id,
  label,
  numeric,
  ...(currency && { currency }),
});

function catalog(spec: WorkflowSpec, query: ReportQuery): CatalogField[] {
  const schemas: { nodeId: string | null; label: string; form: FormSchema }[] = [
    { nodeId: null, label: '', form: spec.input },
  ];
  if (query.dataset !== 'runs') {
    for (const node of spec.nodes)
      if ('form' in node && node.form)
        schemas.push({ nodeId: node.id, label: node.label + ' · ', form: node.form });
  }
  return schemas.flatMap(({ nodeId, label, form }) =>
    schemaFields(form).flatMap((field): CatalogField[] => {
      const origin = nodeId ?? 'input';
      const id = (nodeId === null ? 'input' : 'step.' + nodeId) + '.' + field.id;
      const title = label + field.label;
      if (field.type === 'table')
        return (field.columns ?? [])
          .filter((column) => column.summarize)
          .map((column) => ({
            id: id + ':' + column.id,
            label: title + ' · Tổng ' + column.label,
            origin,
            nodeId,
            form,
            field,
            column: column.id,
            numeric: true,
            ...(field.currency && { currency: field.currency }),
          }));
      return [
        {
          id,
          label: title,
          origin,
          nodeId,
          form,
          field,
          numeric:
            isNumericField(field.type) || field.type === 'money' || field.type === 'attachment',
          ...(field.type === 'money' && field.currency && { currency: field.currency }),
        },
      ];
    }),
  );
}

type Value = { identity: unknown; display: string | null; numeric: string | null };
const empty: Value = { identity: null, display: null, numeric: null };
function project(field: CatalogField, answers: Answers | null): Value {
  const { field: spec } = field;
  const value = answers?.[spec.id];
  const numeric = (v: unknown): Value => {
    const text =
      typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : '';
    if (!/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) || text.length > 40) return empty;
    return { identity: text, display: text, numeric: text };
  };
  if (field.column) return numeric(isTableAnswer(value) ? value.totals[field.column] : null);
  if (spec.type === 'attachment') return Array.isArray(value) ? numeric(value.length) : empty;
  if (field.numeric) return numeric(value);
  if (isReferenceAnswer(value)) return { identity: value.id, display: value.label, numeric: null };
  if (typeof value === 'boolean')
    return { identity: value, display: value ? 'Có' : 'Không', numeric: null };
  const choice = (id: string) => spec.options?.find((option) => option.id === id)?.label ?? id;
  if (Array.isArray(value) && value.length) {
    const ids = [...value].sort();
    return { identity: ids, display: ids.map(choice).join(', '), numeric: null };
  }
  if (typeof value === 'string' && value !== '')
    return {
      identity: value,
      display: spec.type === 'singleChoice' ? choice(value) : value,
      numeric: null,
    };
  return empty;
}

export function fieldReportProjection({
  spec,
  query,
  rows,
  audience,
  tenantId,
  secret,
  facetSearch,
}: {
  spec: WorkflowSpec;
  query: ReportQuery;
  rows: ReportFieldRow[];
  audience: (row: ReportFieldRow) => FieldAudience;
  tenantId: string;
  secret: string;
  facetSearch?: string;
}) {
  const available = catalog(spec, query);
  const audiences = rows.map((row) => ({ row, who: audience(row) }));
  const readable = (field: CatalogField, subject: (typeof audiences)[number]) =>
    applicable(field, subject.row) && mayReadField(spec, field.origin, field.field.id, subject.who);
  const choices = available.filter(
    (field) =>
      !spec.fieldReaders?.[field.origin + '.' + field.field.id] ||
      audiences.some((subject) => readable(field, subject)),
  );
  const byId = new Map(choices.map((field) => [field.id, field]));
  const requireField = (id: string) => {
    const field = byId.get(id);
    if (!field) throw new HttpError(403, 'WORKFLOW_REPORT_FIELD_DENIED');
    return field;
  };
  const columns = (query.columns?.split(',') ?? []).map(requireField);
  const group = query.groupField ? requireField(query.groupField) : undefined;
  const filter = query.filterField ? requireField(query.filterField) : undefined;
  const metric = query.metricField ? requireField(query.metricField) : undefined;
  if (metric && !metric.numeric) throw new HttpError(400, 'WORKFLOW_REPORT_INVALID');
  const token = (field: CatalogField, value: Value) =>
    createHmac('sha256', secret)
      .update(
        JSON.stringify([
          'workflow-report-field-v1',
          tenantId,
          query.versionId,
          field.id,
          value.identity,
        ]),
      )
      .digest('hex');
  const label = (value: Value) => value.display ?? 'Chưa có giá trị';
  const matches = new Map<string, ReportFieldValue>();
  const projected: ReportProjection['rows'] = [];
  for (const subject of audiences) {
    const { row } = subject;
    const state = new Map<FormSchema, ReturnType<typeof fieldState>>();
    const answers = (field: CatalogField) => (field.nodeId === null ? row.inputs : row.answers);
    const inReport = (field: CatalogField) => {
      if (!readable(field, subject)) return false;
      if (!field.field.visibleWhen) return true;
      const current = state.get(field.form) ?? fieldState(field.form, answers(field) ?? {});
      state.set(field.form, current);
      return current.visible[field.field.id] === true;
    };
    if (filter) {
      if (!inReport(filter)) continue;
      const value = project(filter, answers(filter));
      const id = token(filter, value);
      matches.set(id, { id, label: label(value) });
      if (query.match && query.match !== id) continue;
    }
    if (facetSearch !== undefined || (group && !inReport(group)) || (metric && !inReport(metric)))
      continue;
    const grouping = group && project(group, answers(group));
    projected.push({
      run_id: row.run_id,
      task_id: row.task_id,
      person_id: row.person_id,
      field_key: group && grouping ? token(group, grouping) : null,
      field_label: grouping ? label(grouping) : null,
      field_values: Object.fromEntries(
        columns.filter(inReport).map((field) => [field.id, project(field, answers(field)).display]),
      ),
      field_number: metric ? project(metric, answers(metric)).numeric : null,
    });
  }
  if (facetSearch === undefined && query.match && !matches.has(query.match))
    throw new HttpError(400, 'WORKFLOW_REPORT_FILTER_STALE');
  const text = (facetSearch ?? '').trim().toLocaleLowerCase('vi-VN');
  const values = [...matches.values()]
    .filter(
      (item) => item.id === query.match || item.label.toLocaleLowerCase('vi-VN').includes(text),
    )
    .sort(
      (a, b) =>
        Number(b.id === query.match) - Number(a.id === query.match) ||
        a.label.localeCompare(b.label, 'vi') ||
        a.id.localeCompare(b.id),
    );
  return {
    fields: choices.map(publicChoice),
    values: values.slice(0, 100),
    more: values.length > 100,
    projection: {
      rows: projected,
      columns: columns.map(publicChoice),
      ...(metric && { metric: publicChoice(metric) }),
    } as ReportProjection,
  };
}
