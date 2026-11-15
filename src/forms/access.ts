import { HttpError } from '../security.js';

export const formsPermissions = {
  'forms:design': 'Thiết kế biểu mẫu',
  'forms:publish': 'Xuất bản và giao biểu mẫu',
  'forms:respond': 'Điền biểu mẫu được giao',
  'forms:review': 'Đọc phiếu trong phạm vi',
  'forms:analyze': 'Tổng hợp phiếu trong phạm vi',
  'forms:export': 'Xuất phiếu trong phạm vi',
} as const;
export type FormsPermission = keyof typeof formsPermissions;
/** Constructed by the Foundation boundary after live authentication and access checks. */
export type FormsActor = {
  appCode: 'aio-forms';
  accountId: string;
  personId: string;
  tenantIds: string[];
  units: { tenantId: string; orgUnitId: string }[];
  permissions: { tenantId: string; permission: string; orgUnitId: string | null }[];
};
export type FormsReadContext = { tenantId: string; actor: () => Promise<FormsActor> };
export type FormsCommandContext = FormsReadContext & {
  reason: string;
  requestId: string;
  idempotencyKey: string;
};
/** Reference resolution stays in Foundation; Forms never reads an identity database. */
export type FormsDirectory = {
  validateTargets: (
    tenantId: string,
    unitScope: string | null,
    targets: { kind: 'account' | 'unit'; id: string }[],
  ) => Promise<void>;
};
export function hasFormsPermission(
  actor: FormsActor,
  tenant: string,
  permission: FormsPermission,
  unit: string | null,
) {
  return (
    actor.appCode === 'aio-forms' &&
    actor.tenantIds.includes(tenant) &&
    actor.permissions.some(
      (item) =>
        item.tenantId === tenant &&
        item.permission === permission &&
        (item.orgUnitId === null || item.orgUnitId === unit),
    )
  );
}
export function requireFormsPermission(
  actor: FormsActor,
  tenant: string,
  permission: FormsPermission,
  unit: string | null,
) {
  if (!hasFormsPermission(actor, tenant, permission, unit))
    throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
}
export function hasAnyFormsScope(actor: FormsActor, tenant: string, permission: FormsPermission) {
  return (
    actor.appCode === 'aio-forms' &&
    actor.tenantIds.includes(tenant) &&
    actor.permissions.some((item) => item.tenantId === tenant && item.permission === permission)
  );
}
