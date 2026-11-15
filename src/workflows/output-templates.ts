import { isTableAnswer } from '../forms/business.js';
import { schemaFields } from '../forms/contracts.js';
import type { Answers, FormField } from '../forms/contracts.js';
import { isReferenceAnswer } from '../forms/references.js';
import { HttpError } from '../security.js';
import { workflowUuid } from './contracts.js';
import type { WorkflowSpec } from './contracts.js';

export const outputEvents = {
  assigned: 'Giao nhiệm vụ',
  approved: 'Phê duyệt bước',
  returned: 'Trả hồ sơ',
  completed: 'Hoàn thành quy trình',
  rejected: 'Từ chối hồ sơ',
  cancelled: 'Hủy hồ sơ',
  due_soon: 'Sắp đến hạn',
  overdue: 'Quá hạn',
  mentioned: 'Nhắc tên',
} as const;
export const stepOutputEvents = [
  'assigned',
  'approved',
  'due_soon',
  'overdue',
  'mentioned',
] as const;
export type OutputEvent = keyof typeof outputEvents;
export type OutputTemplateInput = {
  definitionId: string;
  versionId: string;
  unitId: string;
  kind: 'print' | 'email';
  name: string;
  heading: string;
  body: string;
  fields: string[];
  event?: OutputEvent;
  stepId?: string;
};
export type OutputTemplate = {
  id: string;
  tenant_id: string;
  definition_id: string;
  version_id: string;
  org_unit_id: string;
  kind: OutputTemplateInput['kind'];
  name: string;
  heading: string;
  body: string;
  fields: string[];
  event_kind: OutputEvent | null;
  step_id: string | null;
  enabled: boolean;
  revision: number;
};
export type OutputJob = {
  id: string;
  tenant_id: string;
  template_id: string;
  notification_id: string;
  source_round: number;
  status: 'queued' | 'retry' | 'done' | 'blocked' | 'skipped';
  attempts: number;
};
type OutputDetail = {
  run: { title: string; status: string; round: number; inputs: Answers };
  version: { spec: WorkflowSpec; version: number };
  inputs: { round: number; inputs: Answers }[];
  tasks: {
    id: string;
    node_id: string;
    round: number;
    attempt: number;
    status: string;
    answers: Answers | null;
    superseded_by_task_id?: string | null;
    decided_at?: Date | string | null;
  }[];
};
export function outputFields(spec: WorkflowSpec) {
  return [
    ...schemaFields(spec.input).map((field) => ({
      field,
      key: 'input.' + field.id,
      label: field.label,
    })),
    ...spec.nodes.flatMap((node) =>
      'form' in node && node.form
        ? schemaFields(node.form).map((field) => ({
            field,
            key: 'step.' + node.id + '.' + field.id,
            label: node.label + ' · ' + field.label,
          }))
        : [],
    ),
  ].filter(({ field }) => field.type !== 'attachment');
}
const fieldToken = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g;
const invalid = () => new HttpError(400, 'WORKFLOW_OUTPUT_INVALID');

export function validateOutputTemplate(input: OutputTemplateInput, spec: WorkflowSpec) {
  for (const id of [input.definitionId, input.versionId, input.unitId]) workflowUuid(id);
  if (
    !['print', 'email'].includes(input.kind) ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 120 ||
    typeof input.heading !== 'string' ||
    !input.heading.trim() ||
    input.heading.length > 240 ||
    /[\r\n]/.test(input.heading) ||
    typeof input.body !== 'string' ||
    input.body.length > 6000 ||
    !Array.isArray(input.fields) ||
    input.fields.length > 60 ||
    new Set(input.fields).size !== input.fields.length
  )
    throw invalid();
  const catalog = outputFields(spec);
  const fields = new Set(catalog.map(({ key }) => key));
  const simple = new Set(
    catalog.filter(({ field }) => field.type !== 'table').map(({ key }) => key),
  );
  const allKeys = new Set(['run.title', 'run.version', 'run.round', ...simple]);
  if (input.kind === 'email') {
    if (!input.event || !Object.hasOwn(outputEvents, input.event) || input.fields.length)
      throw invalid();
    allKeys.add('event.kind');
    if (
      input.stepId &&
      (!stepOutputEvents.some((event) => event === input.event) ||
        !spec.nodes.some(
          (node) => node.id === input.stepId && (node.kind === 'task' || node.kind === 'approval'),
        ))
    )
      throw invalid();
  } else if (input.event || input.stepId || input.fields.some((field) => !fields.has(field)))
    throw invalid();
  for (const value of [input.heading, input.body]) {
    const matches = [...value.matchAll(fieldToken)];
    if (
      matches.length > 80 ||
      matches.some((match) => !allKeys.has(match[1]!)) ||
      /{{|}}/.test(value.replace(fieldToken, ''))
    )
      throw invalid();
  }
}
type PrintColumn = { label: string; numeric: boolean };
type DisplayValue = string | { columns: PrintColumn[]; rows: string[][]; totals: string[] };
function displayValue(field: FormField, value: Answers[string] | undefined): DisplayValue {
  if (value === undefined || value === '') return '—';
  if (isReferenceAnswer(value)) return value.label;
  if (isTableAnswer(value)) {
    const columns = field.columns ?? [];
    return {
      columns: columns.map(({ label, type }) => ({ label, numeric: type !== 'text' })),
      rows: value.rows.map(({ cells }) => columns.map(({ id }) => cells[id] ?? '—')),
      totals: columns.map(({ id }) => value.totals[id] ?? ''),
    };
  }
  const optionLabel = (item: string) =>
    field.options?.find((entry) => entry.id === item)?.label ?? item;
  if (Array.isArray(value)) return value.length ? value.map(optionLabel).join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'Có' : 'Không';
  if (field.type === 'singleChoice') return optionLabel(String(value));
  if (field.type === 'money') return String(value) + ' ' + (field.currency ?? 'VND');
  return String(value);
}
type PrintRow = { label: string; value: DisplayValue };
export type OutputPreview = { heading: string; body: string; rows: PrintRow[] };

export function renderOutput(
  template: OutputTemplate,
  data: OutputDetail,
  options?: {
    round: number;
    taskId?: string | null;
    event: OutputEvent;
    occurredAt: Date;
  },
): OutputPreview {
  const round = options?.round ?? data.run.round;
  const values = new Map<string, DisplayValue>([
    ['run.title', data.run.title],
    ['run.version', String(data.version.version)],
    ['run.round', String(round)],
  ]);
  if (options) values.set('event.kind', outputEvents[options.event]);
  const input =
    data.inputs.find((entry) => entry.round === round)?.inputs ??
    (round === data.run.round ? data.run.inputs : {});
  for (const field of schemaFields(data.version.spec.input)) {
    if (field.type !== 'attachment')
      values.set('input.' + field.id, displayValue(field, input[field.id]));
  }
  const visibleSteps = new Map<string, OutputDetail['tasks'][number]>();
  const eventTask = options?.taskId
    ? data.tasks.find((task) => task.id === options.taskId)
    : undefined;
  for (const task of data.tasks) {
    if (
      task.round !== round ||
      task.superseded_by_task_id ||
      task.status !== 'completed' ||
      !task.answers
    )
      continue;
    if (options && (!task.decided_at || new Date(task.decided_at) > options.occurredAt)) continue;
    if (eventTask?.node_id === task.node_id && task.id !== eventTask.id) continue;
    const existing = visibleSteps.get(task.node_id);
    if (!existing || existing.attempt < task.attempt) visibleSteps.set(task.node_id, task);
  }
  for (const node of data.version.spec.nodes) {
    if (!('form' in node) || !node.form) continue;
    const task = visibleSteps.get(node.id);
    for (const field of schemaFields(node.form)) {
      if (field.type !== 'attachment')
        values.set(
          'step.' + node.id + '.' + field.id,
          displayValue(field, task?.answers?.[field.id]),
        );
    }
  }
  const format = (text: string) =>
    text.replace(fieldToken, (_token, key: string) => {
      const value = values.get(key);
      return typeof value === 'string' ? value : '—';
    });
  return {
    heading: format(template.heading)
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 500),
    body: format(template.body).slice(0, 40000),
    rows: outputFields(data.version.spec)
      .filter(({ key }) => template.fields.includes(key))
      .sort((a, b) => template.fields.indexOf(a.key) - template.fields.indexOf(b.key))
      .map(({ key, label }) => ({ label, value: values.get(key) ?? '—' })),
  };
}

const escapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => escapes[char]!);
export function printOutputHtml(preview: OutputPreview) {
  const renderRow = ({ label, value }: PrintRow) => {
    if (typeof value === 'string')
      return '<section><h2>' + escape(label) + '</h2><p>' + escape(value) + '</p></section>';
    const cells = (row: string[], footer = false) =>
      row
        .map((cell, index) => {
          if (footer && index === 0 && !cell) return '<th scope="row">Tổng</th>';
          const className = value.columns[index]?.numeric ? ' class="number"' : '';
          return '<td' + className + '>' + escape(cell) + '</td>';
        })
        .join('');
    return (
      '<section><h2>' +
      escape(label) +
      '</h2><div class="scroll"><table><thead><tr>' +
      value.columns.map(({ label }) => '<th scope="col">' + escape(label) + '</th>').join('') +
      '</tr></thead><tbody>' +
      value.rows.map((row) => '<tr>' + cells(row) + '</tr>').join('') +
      '</tbody>' +
      (value.totals.some(Boolean)
        ? '<tfoot><tr>' + cells(value.totals, true) + '</tr></tfoot>'
        : '') +
      '</table></div></section>'
    );
  };
  const title = escape(preview.heading);
  return (
    '<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
    title +
    '</title><style>body{font-family:system-ui,sans-serif;color:#1f2937;margin:0 auto;padding:clamp(1rem,5vw,2rem);max-width:900px}h1{color:#223873;font-size:1.75rem;overflow-wrap:anywhere}h2{font-size:1rem;margin-bottom:.35rem}p{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:.35rem}section{margin:1rem 0}.scroll{overflow:auto}table{width:100%;border-collapse:collapse}td,th{border:1px solid #8490a1;padding:.45rem;text-align:left;overflow-wrap:anywhere}.number{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}thead,tfoot{background:#f0f5f2;font-weight:600}tr{break-inside:avoid}@media print{body{padding:0}.scroll{overflow:visible}}@page{margin:16mm}</style></head><body><main><h1>' +
    title +
    '</h1>' +
    (preview.body ? '<p>' + escape(preview.body) + '</p>' : '') +
    preview.rows.map(renderRow).join('') +
    '</main></body></html>'
  );
}
