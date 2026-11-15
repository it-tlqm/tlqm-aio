export const foundationPermissions = {
  'directory:read': 'Xem cơ cấu tổ chức',
  'directory:manage': 'Quản lý cơ cấu tổ chức',
  'people:read': 'Xem hồ sơ nhân sự',
  'people:manage': 'Quản lý quan hệ nhân sự',
  'accounts:manage': 'Quản lý trạng thái tài khoản',
  'identity:link': 'Xác minh liên kết định danh',
  'applications:manage': 'Quản lý danh mục ứng dụng',
  'applications:create': 'Đăng ký ứng dụng mới',
  'roles:read': 'Xem vai trò và quyền',
  'roles:manage': 'Quản lý vai trò và phân quyền',
  'access:manage': 'Cấp và thu hồi truy cập',
  'audit:read': 'Xem lịch sử quản trị',
} as const;
export const managementPermissions = new Set(
  Object.keys(foundationPermissions).filter(
    (code) =>
      code.endsWith(':manage') || code === 'identity:link' || code === 'applications:create',
  ),
);
// These application permissions perform administrative actions and also require verified MFA.
managementPermissions.add('forms:design');
managementPermissions.add('forms:publish');
managementPermissions.add('lms:admin');
managementPermissions.add('identity:provision');
managementPermissions.add('workflows:design');
managementPermissions.add('workflows:publish');
managementPermissions.add('workflows:manage');
managementPermissions.add('tasks:manage');
