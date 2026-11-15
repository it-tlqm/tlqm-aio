import { HttpError } from '../security.js';
import type { TaskPerson } from './options.js';

export const taskPermissions = {
  'tasks:view': 'Xem công việc trong phạm vi',
  'tasks:work': 'Giao và thực hiện công việc',
  'tasks:manage': 'Quản trị dự án theo đơn vị',
  'tasks:report': 'Xem báo cáo dự án',
} as const;
export type TaskPermission = keyof typeof taskPermissions;
export type TaskActor = TaskPerson & {
  appCode: 'aio-tasks';
  tenantIds: string[];
  units: { tenantId: string; orgUnitId: string }[];
  permissions: { tenantId: string; orgUnitId: string | null; permission: string }[];
};
export type TaskContext = { tenantId: string; actor: () => Promise<TaskActor> };
export type TaskCommand = TaskContext & {
  reason: string;
  idempotencyKey: string;
  requestId: string;
};
export type TaskDirectory = {
  validateUnit: (tenant: string, unit: string) => Promise<void>;
  actor: (tenant: string, account: string) => Promise<TaskActor | null>;
  search: (tenant: string, unit: string, search: string) => Promise<TaskPerson[]>;
};
export const taskAllowed = (
  actor: TaskActor,
  tenant: string,
  unit: string,
  permission: TaskPermission,
) =>
  actor.appCode === 'aio-tasks' &&
  actor.tenantIds.includes(tenant) &&
  actor.permissions.some(
    (entry) =>
      entry.tenantId === tenant &&
      entry.permission === permission &&
      (entry.orgUnitId === null || entry.orgUnitId === unit),
  );
export const taskUnitMember = (actor: TaskActor, tenant: string, unit: string) =>
  actor.units.some((entry) => entry.tenantId === tenant && entry.orgUnitId === unit);
export const taskDenied = () => new HttpError(403, 'TASKS_PERMISSION_DENIED');
export function taskUuid(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  )
    throw new HttpError(400, 'INVALID_IDENTIFIER');
}
