import type { Row } from '../lib/api.js';
export type DirectoryData = Record<string, Row[]>;
export const orgKeys = [
  'legal-entities',
  'org-units',
  'job-titles',
  'positions',
  'people',
  'employments',
  'assignments',
];
export const peopleKeys = [...orgKeys, 'accounts', 'applications'];
export const accessKeys = [
  'roles',
  'permissions',
  'bindings',
  'grants',
  'accounts',
  'people',
  'org-units',
];
export const normalize = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLocaleLowerCase('vi')
    .trim();
export const byName = (a: Row, b: Row) =>
  String(a.name ?? a.displayName ?? '').localeCompare(
    String(b.name ?? b.displayName ?? ''),
    'vi',
  ) || String(a.id ?? a.code).localeCompare(String(b.id ?? b.code));
export function effective(row: Row, now = Date.now()) {
  return (
    row.active !== false &&
    (!row.validFrom || Date.parse(String(row.validFrom)) <= now) &&
    (!row.validUntil || Date.parse(String(row.validUntil)) > now)
  );
}
export function lifecycle(row: Row, now = Date.now()) {
  if (row.active === false || (row.validUntil && Date.parse(String(row.validUntil)) <= now))
    return 'ended';
  if (row.validFrom && Date.parse(String(row.validFrom)) > now) return 'future';
  return 'current';
}
export function find(data: DirectoryData, key: string, id: unknown) {
  return data[key]?.find((row) => row.id === id);
}
export function label(data: DirectoryData, key: string, id: unknown) {
  return rowLabel(find(data, key, id));
}
export function rowLabel(row: Row | undefined) {
  return row
    ? String(row.name ?? row.displayName ?? row.employeeCode ?? row.code ?? 'Chưa đặt tên')
    : 'Không có trong phạm vi xem';
}
export function childrenOf(units: Row[], parentId: string, includeSelf = true) {
  const selected = new Set<string>(includeSelf ? [parentId] : []),
    visited = new Set([parentId]),
    pending = [parentId];
  while (pending.length) {
    const parent = pending.shift();
    for (const unit of units)
      if (unit.parentId === parent && !visited.has(String(unit.id))) {
        const id = String(unit.id);
        visited.add(id);
        selected.add(id);
        pending.push(id);
      }
  }
  return selected;
}
export function currentAssignments(data: DirectoryData, now = Date.now()) {
  return (data.assignments ?? []).filter((assignment) => {
    if (!effective(assignment, now)) return false;
    const employment = find(data, 'employments', assignment.employmentId),
      position = find(data, 'positions', assignment.positionId);
    if (!employment || !position || !effective(employment, now) || !effective(position, now))
      return false;
    const person = find(data, 'people', employment.personId),
      unit = find(data, 'org-units', position.orgUnitId),
      entity = find(data, 'legal-entities', position.legalEntityId),
      title = find(data, 'job-titles', position.jobTitleId);
    return (
      !!person &&
      effective(person, now) &&
      !!unit &&
      effective(unit, now) &&
      !!entity &&
      effective(entity, now) &&
      !!title &&
      effective(title, now)
    );
  });
}
export function personAssignments(data: DirectoryData, personId: unknown, currentOnly = false) {
  const employmentIds = new Set(
    (data.employments ?? []).filter((row) => row.personId === personId).map((row) => row.id),
  );
  return (currentOnly ? currentAssignments(data) : (data.assignments ?? [])).filter((row) =>
    employmentIds.has(row.employmentId),
  );
}
export function currentMembers(data: DirectoryData, unitIds: Set<string>) {
  const assignments = currentAssignments(data).filter((row) =>
    unitIds.has(String(find(data, 'positions', row.positionId)?.orgUnitId)),
  );
  const ids = new Set(
    assignments.map((row) => find(data, 'employments', row.employmentId)?.personId),
  );
  return { assignments, people: (data.people ?? []).filter((row) => ids.has(row.id)).sort(byName) };
}
