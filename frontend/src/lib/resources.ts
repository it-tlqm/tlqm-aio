export type Field = {
  key: string;
  label: string;
  kind?: 'text' | 'boolean' | 'date' | 'select' | 'permissions' | 'textarea';
  source?: string;
  optional?: boolean;
  immutable?: boolean;
  options?: { value: string; label: string }[];
};
export type Resource = {
  key: string;
  title: string;
  singular: string;
  read: string;
  write: string;
  create?: string;
  appScoped?: boolean;
  idKey?: string;
  columns: string[];
  fields: Field[];
};
const active: Field = { key: 'active', label: 'Đang hoạt động', kind: 'boolean' };
const code: Field = { key: 'code', label: 'Mã' };
const name: Field = { key: 'name', label: 'Tên' };
const entity: Field = {
  key: 'legalEntityId',
  label: 'Pháp nhân',
  kind: 'select',
  source: 'legal-entities',
  immutable: true,
};
const person: Field = {
  key: 'personId',
  label: 'Nhân sự',
  kind: 'select',
  source: 'people',
  immutable: true,
};
const account: Field = {
  key: 'accountId',
  label: 'Tài khoản',
  kind: 'select',
  source: 'accounts',
  immutable: true,
};
const from: Field = { key: 'validFrom', label: 'Hiệu lực từ', kind: 'date' };
const until: Field = { key: 'validUntil', label: 'Hiệu lực đến', kind: 'date', optional: true };

export const resources: Resource[] = [
  {
    key: 'legal-entities',
    title: 'Pháp nhân',
    singular: 'pháp nhân',
    read: 'directory:read',
    write: 'directory:manage',
    columns: ['code', 'name', 'active'],
    fields: [code, name, active],
  },
  {
    key: 'org-units',
    title: 'Đơn vị / phòng ban',
    singular: 'đơn vị',
    read: 'directory:read',
    write: 'directory:manage',
    columns: ['code', 'name', 'legalEntityId', 'parentId', 'active'],
    fields: [
      entity,
      { key: 'parentId', label: 'Đơn vị cha', kind: 'select', source: 'org-units', optional: true },
      code,
      name,
      active,
    ],
  },
  {
    key: 'job-titles',
    title: 'Chức danh',
    singular: 'chức danh',
    read: 'directory:read',
    write: 'directory:manage',
    columns: ['code', 'name', 'active'],
    fields: [code, name, active],
  },
  {
    key: 'positions',
    title: 'Vị trí công tác',
    singular: 'vị trí',
    read: 'directory:read',
    write: 'directory:manage',
    columns: ['name', 'orgUnitId', 'jobTitleId', 'active'],
    fields: [
      entity,
      { key: 'orgUnitId', label: 'Đơn vị', kind: 'select', source: 'org-units' },
      { key: 'jobTitleId', label: 'Chức danh', kind: 'select', source: 'job-titles' },
      name,
      active,
    ],
  },
  {
    key: 'people',
    title: 'Hồ sơ nhân sự',
    singular: 'hồ sơ',
    read: 'people:read',
    write: 'people:manage',
    columns: ['displayName', 'active'],
    fields: [{ key: 'displayName', label: 'Họ và tên' }, active],
  },
  {
    key: 'accounts',
    title: 'Tài khoản',
    singular: 'tài khoản',
    read: 'accounts:manage',
    write: 'accounts:manage',
    columns: ['personId', 'active', 'mfaRequired', 'isProtected'],
    fields: [person, active],
  },
  {
    key: 'employments',
    title: 'Quan hệ công tác',
    singular: 'quan hệ công tác',
    read: 'people:read',
    write: 'people:manage',
    columns: ['employeeCode', 'personId', 'legalEntityId', 'validFrom', 'validUntil'],
    fields: [person, entity, { key: 'employeeCode', label: 'Mã nhân sự' }, from, until],
  },
  {
    key: 'assignments',
    title: 'Bổ nhiệm / kiêm nhiệm',
    singular: 'bổ nhiệm',
    read: 'people:read',
    write: 'people:manage',
    columns: ['employmentId', 'positionId', 'isPrimary', 'validFrom', 'validUntil'],
    fields: [
      entity,
      {
        key: 'employmentId',
        label: 'Quan hệ công tác',
        kind: 'select',
        source: 'employments',
        immutable: true,
      },
      { key: 'positionId', label: 'Vị trí', kind: 'select', source: 'positions', immutable: true },
      { key: 'isPrimary', label: 'Vị trí chính', kind: 'boolean' },
      from,
      until,
    ],
  },
  {
    key: 'applications',
    title: 'Danh mục ứng dụng',
    singular: 'ứng dụng',
    read: 'applications:manage',
    write: 'applications:manage',
    create: 'applications:create',
    idKey: 'code',
    columns: ['code', 'name', 'status', 'launchUrl', 'provisionedAt'],
    fields: [
      { ...code, immutable: true },
      name,
      { key: 'description', label: 'Mô tả', kind: 'textarea', optional: true },
      { key: 'launchUrl', label: 'Địa chỉ mở ứng dụng local', optional: true },
      {
        key: 'status',
        label: 'Trạng thái',
        kind: 'select',
        options: [
          { value: 'planned', label: 'Chuẩn bị' },
          { value: 'active', label: 'Hoạt động' },
          { value: 'disabled', label: 'Tạm dừng' },
        ],
      },
    ],
  },
  {
    key: 'roles',
    title: 'Vai trò',
    singular: 'vai trò',
    read: 'roles:read',
    write: 'roles:manage',
    appScoped: true,
    idKey: 'code',
    columns: ['code', 'name', 'permissions', 'bindingCount', 'active', 'protected'],
    fields: [
      { ...code, immutable: true },
      name,
      {
        key: 'permissions',
        label: 'Quyền trong vai trò',
        kind: 'permissions',
        source: 'permissions',
      },
      active,
    ],
  },
  {
    key: 'permissions',
    title: 'Danh mục quyền',
    singular: 'quyền',
    read: 'roles:read',
    write: 'roles:manage',
    appScoped: true,
    idKey: 'code',
    columns: ['code', 'name', 'active', 'protected'],
    fields: [{ ...code, immutable: true }, name, active],
  },
  {
    key: 'bindings',
    title: 'Gán vai trò',
    singular: 'phân công vai trò',
    read: 'roles:read',
    write: 'roles:manage',
    appScoped: true,
    columns: ['displayName', 'roleCode', 'orgUnitId', 'managedAppCode', 'active', 'validUntil'],
    fields: [
      account,
      { key: 'roleCode', label: 'Vai trò', kind: 'select', source: 'roles' },
      {
        key: 'orgUnitId',
        label: 'Phạm vi đơn vị (để trống = toàn tenant)',
        kind: 'select',
        source: 'org-units',
        optional: true,
      },
      {
        key: 'managedAppCode',
        label: 'Ứng dụng được ủy quyền quản trị',
        kind: 'select',
        source: 'applications',
        optional: true,
      },
      from,
      until,
      active,
    ],
  },
  {
    key: 'grants',
    title: 'Cấp truy cập ứng dụng',
    singular: 'quyền truy cập',
    read: 'access:manage',
    write: 'access:manage',
    appScoped: true,
    idKey: 'accountId',
    columns: ['displayName', 'active', 'accountActive', 'validUntil', 'isProtected'],
    fields: [account, active, until],
  },
];
for (const [key, title, singular, target, targetLabel] of [
  [
    'reporting-lines',
    'Quản lý trực tiếp',
    'quan hệ quản lý',
    'managerEmploymentId',
    'Người quản lý',
  ],
  ['unit-leaders', 'Trưởng đơn vị', 'trưởng đơn vị', 'orgUnitId', 'Đơn vị phụ trách'],
  [
    'approval-substitutions',
    'Người thay thế',
    'người thay thế',
    'substituteEmploymentId',
    'Người thay thế',
  ],
]) {
  resources.push({
    key: key!,
    title: title!,
    singular: singular!,
    read: 'people:read',
    write: 'people:manage',
    columns: ['employmentId', target!, 'validFrom', 'validUntil', 'active'],
    fields: [
      entity,
      {
        key: 'employmentId',
        label: key === 'unit-leaders' ? 'Người phụ trách' : 'Nhân sự',
        kind: 'select',
        source: 'employments',
        immutable: true,
      },
      {
        key: target!,
        label: targetLabel!,
        kind: 'select',
        source: key === 'unit-leaders' ? 'org-units' : 'employments',
        immutable: true,
      },
      from,
      until,
      active,
    ],
  });
}
export const resourceByKey = Object.fromEntries(
  resources.map((resource) => [resource.key, resource]),
);
export const labels: Record<string, string> = Object.assign(
  {
    code: 'Mã',
    name: 'Tên',
    active: 'Trạng thái',
    displayName: 'Họ và tên',
    protected: 'Bảo vệ',
    isProtected: 'Bảo vệ',
    mfaRequired: 'Yêu cầu MFA',
    bindingCount: 'Số phân công',
    accountActive: 'Tài khoản',
    provisionedAt: 'Cấu hình SSO',
    managedAppCode: 'Ứng dụng được ủy quyền',
  },
  ...resources.map((resource) =>
    Object.fromEntries(resource.fields.map((field) => [field.key, field.label])),
  ),
);
