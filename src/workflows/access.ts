import { HttpError } from '../security.js';
import type { ReferenceAnswer, ReferenceKind } from '../forms/references.js';
export type WorkflowReferenceQuery = {
  kind: ReferenceKind;
  unitId: string;
  search?: string;
  after?: string;
  id?: string;
};
export const workflowPermissions = {
  'workflows:design': 'Thiết kế quy trình',
  'workflows:publish': 'Phát hành quy trình',
  'workflows:start': 'Khởi tạo lượt chạy',
  'workflows:act': 'Xử lý nhiệm vụ được giao',
  'workflows:manage': 'Điều phối và phân công lại',
  'workflows:report': 'Xem báo cáo quy trình',
  'workflows:collaborate': 'Theo dõi hồ sơ được chia sẻ',
} as const;
export type WorkflowPermission = keyof typeof workflowPermissions;
export type WorkflowActor = {
  appCode: 'aio-workflows';
  accountId: string;
  personId: string;
  displayName?: string;
  tenantIds: string[];
  units: { tenantId: string; orgUnitId: string }[];
  permissions: { tenantId: string; permission: string; orgUnitId: string | null }[];
};
export type WorkflowContext = { tenantId: string; actor: () => Promise<WorkflowActor> };
export type WorkflowCommand = WorkflowContext & {
  idempotencyKey: string;
  requestId: string;
  reason: string;
};
export type WorkflowDirectory = {
  linkRecipient?: (tenant: string, accountId: string) => Promise<WorkflowActor | null>;
  draftRecipients?: (
    tenant: string,
    unit: string,
    search: string,
  ) => Promise<{ accountId: string; name: string }[]>;
  collaborators?: (
    tenant: string,
    unit: string,
    query: { search?: string; accountId?: string },
    permission?: 'workflows:collaborate' | 'workflows:start',
  ) => Promise<{ accountId: string; personId: string; name: string }[]>;
  references?: (
    tenant: string,
    actor: WorkflowActor,
    query: WorkflowReferenceQuery,
  ) => Promise<{
    items: ReferenceAnswer[];
    nextCursor: string | null;
  }>;
  responsible?: (
    tenant: string,
    unit: string,
    ownerPersonId: string,
    kind: 'manager' | 'unit-head',
  ) => Promise<{ accountId: string; personId: string; basis: { id: string; revision: number }[] }>;
  validateUnit: (tenant: string, unit: string) => Promise<void>;
  assignee: (
    tenant: string,
    unit: string | null,
    accountId: string,
  ) => Promise<{ personId: string; name: string }>;
};
export function workflowAllowed(
  actor: WorkflowActor,
  tenant: string,
  permission: WorkflowPermission,
  unit: string | null,
) {
  return (
    actor.appCode === 'aio-workflows' &&
    actor.tenantIds.includes(tenant) &&
    actor.permissions.some(
      (entry) =>
        entry.tenantId === tenant &&
        entry.permission === permission &&
        (entry.orgUnitId === null || entry.orgUnitId === unit),
    )
  );
}
export function workflowRequire(
  actor: WorkflowActor,
  tenant: string,
  permission: WorkflowPermission,
  unit: string | null,
) {
  if (!workflowAllowed(actor, tenant, permission, unit))
    throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
}
