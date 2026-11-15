import type { FormSchema } from '../forms/contracts.js';
import { formHash } from '../forms/service.js';
import type { WorkflowSpec } from './contracts.js';

export const versionSections = ['definition', 'input', 'steps', 'access'] as const;
type VersionSection = (typeof versionSections)[number];
export type WorkflowVersionItem = {
  id: string;
  version: number;
  name: string;
  publishedAt: string;
};
export type WorkflowVersionChange = {
  key: string;
  section: VersionSection;
  label: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
};

type Entry = { section: VersionSection; label: string; value: unknown };
function versionEntries(spec: WorkflowSpec) {
  const entries = new Map<string, Entry>();
  const add = (key: string, section: VersionSection, label: string, value: unknown) =>
    entries.set(key, { section, label, value });
  const form = (prefix: string, section: 'input' | 'steps', title: string, schema: FormSchema) => {
    const { sections, ...settings } = schema;
    add(prefix, section, title, settings);
    for (const [position, { fields, ...part }] of sections.entries()) {
      add(prefix + '/sections/' + part.id, section, title + ' · ' + part.title, {
        ...part,
        position,
      });
      for (const [index, field] of fields.entries())
        add(prefix + '/fields/' + field.id, section, title + ' · ' + field.label, {
          section: part.id,
          position: index,
          field,
        });
    }
  };
  add('name', 'definition', 'Tên quy trình', spec.name);
  add('description', 'definition', 'Mô tả', spec.description);
  add('category', 'definition', 'Nhóm quy trình', spec.category);
  add('schemaVersion', 'definition', 'Phiên bản cấu hình', spec.schemaVersion);
  if (spec.calendar) add('calendar', 'definition', 'Lịch làm việc', spec.calendar);
  add('audienceUnits', 'access', 'Đơn vị được khởi chạy', [...spec.audienceUnits].sort());
  for (const [address, readers] of Object.entries(spec.fieldReaders ?? {}))
    add('access/' + address, 'access', 'Quyền đọc ' + address, readers);
  form('input', 'input', 'Biểu mẫu khởi tạo', spec.input);
  for (const [position, node] of spec.nodes.entries()) {
    const prefix = 'steps/' + node.id;
    if ('form' in node) {
      const { form: schema, ...config } = node;
      add(prefix, 'steps', node.label, { ...config, position });
      if (schema) form(prefix + '/form', 'steps', node.label, schema);
    } else {
      add(prefix, 'steps', node.label, { ...node, position });
    }
    if (spec.positions[node.id])
      add(
        prefix + '/layout',
        'steps',
        node.label + ' · Vị trí trên sơ đồ',
        spec.positions[node.id],
      );
  }
  return entries;
}

export function compareWorkflowVersions(before: WorkflowSpec, after: WorkflowSpec) {
  const left = versionEntries(before);
  const right = versionEntries(after);
  const changes: WorkflowVersionChange[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const old = left.get(key);
    const next = right.get(key);
    if (old && next && formHash(old.value) === formHash(next.value)) continue;
    const entry = next ?? old!;
    changes.push({
      key,
      section: entry.section,
      label: entry.label,
      kind: !old ? 'added' : !next ? 'removed' : 'changed',
      ...(old && { before: old.value }),
      ...(next && { after: next.value }),
    });
  }
  return changes;
}
