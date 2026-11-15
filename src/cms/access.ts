import { HttpError } from '../security.js';

export const cmsPermissions = {
  'cms:read': 'Đọc nội dung CMS',
  'cms:edit': 'Soạn và sửa nội dung CMS',
  'cms:publish': 'Phát hành nội dung CMS',
  'cms:manage': 'Quản trị website CMS',
} as const;
export type CmsPermission = keyof typeof cmsPermissions;

export type CmsActor = {
  appCode: 'aio-cms';
  accountId: string;
  personId: string;
  tenantIds: string[];
  permissions: { tenantId: string; permission: string; orgUnitId: string | null }[];
};

export type CmsContext = { tenantId: string; actor: () => Promise<CmsActor> };
export type CmsCommand = CmsContext & {
  reason: string;
  requestId: string;
  idempotencyKey: string;
};

export function hasCmsPermission(actor: CmsActor, tenantId: string, permission: CmsPermission) {
  return (
    actor.appCode === 'aio-cms' &&
    actor.tenantIds.includes(tenantId) &&
    actor.permissions.some(
      (item) =>
        item.tenantId === tenantId && item.permission === permission && item.orgUnitId === null,
    )
  );
}

export function requireCmsPermission(actor: CmsActor, tenantId: string, permission: CmsPermission) {
  if (!hasCmsPermission(actor, tenantId, permission))
    throw new HttpError(403, 'CMS_PERMISSION_DENIED');
}

export function cmsUuid(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new HttpError(400, 'CMS_INVALID_IDENTIFIER');
  return value;
}
