// Synthetic identifiers only. These never identify real employees.
export const ids = {
  tenantA: '10000000-0000-4000-8000-000000000001',
  tenantB: '10000000-0000-4000-8000-000000000002',
  legalA: '20000000-0000-4000-8000-000000000001',
  legalB: '20000000-0000-4000-8000-000000000002',
  unitA: '30000000-0000-4000-8000-000000000001',
  unitB: '30000000-0000-4000-8000-000000000002',
  unitC: '30000000-0000-4000-8000-000000000003',
  admin: '40000000-0000-4000-8000-000000000001',
  learner: '40000000-0000-4000-8000-000000000002',
  noAccess: '40000000-0000-4000-8000-000000000003',
  blocked: '40000000-0000-4000-8000-000000000004',
  other: '40000000-0000-4000-8000-000000000005',
} as const;
export const demoUsers = [
  { id: ids.admin, username: 'demo.admin', name: 'Quản trị thử nghiệm', tenantId: ids.tenantA },
  {
    id: ids.learner,
    username: 'demo.learner',
    name: 'Nhân viên thử nghiệm',
    tenantId: ids.tenantA,
  },
  {
    id: ids.noAccess,
    username: 'demo.no-access',
    name: 'Chưa cấp ứng dụng',
    tenantId: ids.tenantA,
  },
  { id: ids.blocked, username: 'demo.blocked', name: 'Tài khoản bị khóa', tenantId: ids.tenantA },
  { id: ids.other, username: 'demo.other', name: 'Nhân viên đơn vị B', tenantId: ids.tenantB },
];
