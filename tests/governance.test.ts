import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import type { MutationContext } from '../src/management/mutations.js';
import { ids } from '../src/fixtures.js';

const config = await loadLocalConfig();
const pool = new pg.Pool({ connectionString: testDatabaseUrl(config), max: 4 });
const store = new Store(pool);
const service = new GovernanceService(store);
const createdSubjects: string[] = [];
const createdRoles: string[] = [];
function context(subject: string = ids.admin, tenantId: string = ids.tenantA): MutationContext {
  return {
    identity: {
      issuer: config.issuer,
      subject,
      authenticatedAt: Math.floor(Date.now() / 1000),
      authenticationMethods: ['pwd', 'otp'],
    },
    appCode: 'aio-foundation',
    tenantId,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    reason: 'Kiểm thử quyền quản trị',
  };
}
async function subject(permissions: string[] = [], unitScope: string | null = null) {
  const id = randomUUID();
  await pool.query('INSERT INTO persons(id,display_name,home_tenant_id) VALUES ($1,$2,$3)', [
    id,
    'Governance fixture ' + id.slice(0, 8),
    ids.tenantA,
  ]);
  await pool.query('INSERT INTO accounts(id,person_id) VALUES ($1,$1)', [id]);
  await pool.query('INSERT INTO external_identities(issuer,subject,account_id) VALUES ($1,$2,$3)', [
    config.issuer,
    id,
    id,
  ]);
  await pool.query('INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)', [
    id,
    ids.tenantA,
  ]);
  await pool.query(
    "INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,'aio-foundation')",
    [id, ids.tenantA],
  );
  createdSubjects.push(id);
  if (permissions.length) {
    const role = 'fixture-' + id.slice(0, 8);
    await pool.query(
      "INSERT INTO app_roles(tenant_id,app_code,code,name,protected) VALUES ($1,'aio-foundation',$2,'Fixture manager',false)",
      [ids.tenantA, role],
    );
    for (const permission of permissions)
      await pool.query(
        "INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,'aio-foundation',$2,$3)",
        [ids.tenantA, role, permission],
      );
    await pool.query(
      "INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code,managed_app_code) VALUES ($1,$2,$3,'aio-foundation',$4,'aio-foundation')",
      [randomUUID(), id, ids.tenantA, role],
    );
    createdRoles.push(role);
  }
  if (unitScope)
    await pool.query(
      "INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code,org_unit_id) VALUES ($1,$2,$3,'aio-foundation','reader',$4)",
      [randomUUID(), id, ids.tenantA, unitScope],
    );
  return id;
}
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
});
after(async () => {
  if (createdSubjects.length) {
    await pool.query('UPDATE accounts SET active=false WHERE id=ANY($1::uuid[])', [
      createdSubjects,
    ]);
    await pool.query('UPDATE persons SET active=false WHERE id=ANY($1::uuid[])', [createdSubjects]);
    await pool.query('UPDATE role_bindings SET active=false WHERE account_id=ANY($1::uuid[])', [
      createdSubjects,
    ]);
  }
  if (createdRoles.length)
    await pool.query(
      "UPDATE app_roles SET active=false WHERE tenant_id=$1 AND app_code='aio-foundation' AND code=ANY($2::text[])",
      [ids.tenantA, createdRoles],
    );
  await pool.end();
});

test('registry creates a planned app with explicit owner delegation, never arbitrary remote URLs or unprovisioned activation', async () => {
  const code = 'app-' + randomUUID().slice(0, 8);
  const request = context();
  const app = await service.saveApplication(request, {
    code,
    name: 'Ứng dụng kiểm thử',
    launchUrl: 'http://127.0.0.1:4102',
  });
  assert.equal(app.status, 'planned');
  assert.equal(app.ownerTenantId, ids.tenantA);
  assert.equal(app.provisionedAt, null);
  assert.deepEqual(
    await service.saveApplication(request, {
      code,
      name: 'Ứng dụng kiểm thử',
      launchUrl: 'http://127.0.0.1:4102',
    }),
    app,
  );
  await assert.rejects(() => service.saveApplication(context(), { status: 'active' }, code, 1), {
    code: 'APPLICATION_PROVISIONING_REQUIRED',
  });
  await assert.rejects(
    () =>
      service.saveApplication(context(), {
        code: 'bad-' + randomUUID().slice(0, 8),
        name: 'Bad URL',
        launchUrl: 'https://example.com',
      }),
    { code: 'INVALID_LOCAL_URL' },
  );
  await assert.rejects(
    () =>
      service.saveApplication(context(ids.learner), {
        code: 'no-' + randomUUID().slice(0, 8),
        name: 'Not allowed',
      }),
    { code: 'PERMISSION_DENIED' },
  );
  await service.saveApplication(context(), { status: 'disabled' }, code, 1);
});
test('custom catalog and roles support revisions and archival without allowing reserved permissions', async () => {
  const appCode = 'catalog-' + randomUUID().slice(0, 8);
  await service.saveApplication(context(), { code: appCode, name: 'Catalog fixture' });
  const permission = await service.savePermission(context(), {
    appCode,
    code: 'documents:read',
    name: 'Đọc tài liệu',
  });
  assert.equal(permission.protected, false);
  await assert.rejects(
    () =>
      service.savePermission(context(), { appCode, code: 'accounts:manage', name: 'Escalation' }),
    { code: 'RESERVED_PERMISSION_CODE' },
  );
  const role = await service.saveRole(context(), {
    appCode,
    code: 'viewer',
    name: 'Người xem',
    permissions: ['documents:read'],
  });
  assert.deepEqual(role.permissions, ['documents:read']);
  assert.equal(role.protected, false);
  const renamed = await service.saveRole(
    context(),
    { appCode, name: 'Người xem tài liệu' },
    'viewer',
    1,
  );
  assert.equal(renamed.revision, 2);
  await assert.rejects(() => service.saveRole(context(), { appCode, name: 'Stale' }, 'viewer', 1), {
    code: 'REVISION_CONFLICT',
  });
  await service.saveRole(context(), { appCode, active: false }, 'viewer', 2);
  await service.savePermission(context(), { appCode, active: false }, 'documents:read', 1);
  const principal = await store.principal(context().identity, 'aio-foundation');
  assert.equal((await service.roles(principal, ids.tenantA, appCode)).items[0]?.active, false);
  await service.saveApplication(context(), { status: 'disabled' }, appCode, 1);
});
test('An app delegate cannot grant Directory lookup without corresponding Foundation people and organization read authority', async () => {
  const appCode = 'dir-' + randomUUID().slice(0, 8);
  await service.saveApplication(context(), { code: appCode, name: 'Directory delegation fixture' });
  await service.savePermission(context(), {
    appCode,
    code: 'directory:lookup',
    name: 'App Directory lookup',
  });
  const delegate = await subject(['roles:manage', 'access:manage']);
  await pool.query(
    'INSERT INTO application_delegations(account_id,tenant_id,app_code,active,created_by) VALUES ($1,$2,$3,true,$4)',
    [delegate, ids.tenantA, appCode, ids.admin],
  );
  await assert.rejects(
    () =>
      service.saveRole(context(delegate), {
        appCode,
        code: 'lookup-reader',
        name: 'Should be rejected',
        permissions: ['directory:lookup'],
      }),
    { code: 'PERMISSION_CEILING_EXCEEDED' },
  );
  const approved = await service.saveRole(context(), {
    appCode,
    code: 'lookup-reader',
    name: 'Approved by Foundation',
    permissions: ['directory:lookup'],
  });
  assert.deepEqual(approved.permissions, ['directory:lookup']);
  const recipient = await subject();
  await assert.rejects(
    () =>
      service.saveBinding(context(delegate), {
        appCode,
        accountId: recipient,
        roleCode: 'lookup-reader',
        orgUnitId: ids.unitA,
      }),
    { code: 'PERMISSION_CEILING_EXCEEDED' },
  );
  const disabled = await service.savePermission(
    context(),
    { appCode, active: false },
    'directory:lookup',
    1,
  );
  await assert.rejects(
    () =>
      service.savePermission(
        context(delegate),
        { appCode, active: true },
        'directory:lookup',
        Number(disabled.revision),
      ),
    { code: 'PERMISSION_CEILING_EXCEEDED' },
  );
});
test('Identity provisioning capability cannot be manufactured by ordinary application delegates', async () => {
  const appCode = 'idp-' + randomUUID().slice(0, 8);
  await service.saveApplication(context(), {
    code: appCode,
    name: 'Identity provisioning fixture',
  });
  const delegate = await subject([
    'roles:manage',
    'access:manage',
    'directory:read',
    'people:read',
  ]);
  await pool.query(
    'INSERT INTO application_delegations(account_id,tenant_id,app_code,active,created_by) VALUES ($1,$2,$3,true,$4)',
    [delegate, ids.tenantA, appCode, ids.admin],
  );
  await assert.rejects(
    () =>
      service.savePermission(context(delegate), {
        appCode,
        code: 'identity:provision',
        name: 'Unapproved',
      }),
    { code: 'PERMISSION_CEILING_EXCEEDED' },
  );
  await service.savePermission(context(), {
    appCode,
    code: 'identity:provision',
    name: 'Verified adapter provisioning',
  });
  await assert.rejects(
    () =>
      service.saveRole(context(delegate), {
        appCode,
        code: 'provisioner',
        name: 'Unapproved',
        permissions: ['identity:provision'],
      }),
    { code: 'PERMISSION_CEILING_EXCEEDED' },
  );
  await service.saveRole(context(), {
    appCode,
    code: 'provisioner',
    name: 'Approved',
    permissions: ['identity:provision'],
  });
  const recipient = await subject();
  await assert.rejects(
    () =>
      service.saveBinding(context(delegate), {
        appCode,
        accountId: recipient,
        roleCode: 'provisioner',
      }),
    { code: 'PERMISSION_CEILING_EXCEEDED' },
  );
  await assert.rejects(
    () =>
      service.saveBinding(context(), {
        appCode,
        accountId: recipient,
        roleCode: 'provisioner',
        orgUnitId: ids.unitA,
      }),
    { code: 'MANAGEMENT_ROLE_REQUIRES_TENANT_SCOPE' },
  );
  await service.saveBinding(context(), { appCode, accountId: recipient, roleCode: 'provisioner' });
  assert.equal(
    (await pool.query('SELECT mfa_required FROM accounts WHERE id=$1', [recipient])).rows[0]
      .mfa_required,
    true,
  );
  await service.savePermission(context(), { appCode, active: false }, 'identity:provision', 1);
  await assert.rejects(
    () =>
      service.savePermission(context(delegate), { appCode, active: true }, 'identity:provision', 2),
    { code: 'PERMISSION_CEILING_EXCEEDED' },
  );
});

test('role and catalog guards reject protected edits, missing delegation, cross-tenant access and permission escalation', async () => {
  const roleRevision = (
    await pool.query(
      "SELECT revision FROM app_roles WHERE tenant_id=$1 AND app_code='aio-foundation' AND code='reader'",
      [ids.tenantA],
    )
  ).rows[0].revision;
  const permissionRevision = (
    await pool.query(
      "SELECT revision FROM permission_catalog WHERE app_code='aio-foundation' AND code='directory:read'",
    )
  ).rows[0].revision;
  await assert.rejects(
    () =>
      service.saveRole(
        context(),
        { appCode: 'aio-foundation', active: false },
        'reader',
        roleRevision,
      ),
    { code: 'PROTECTED_ROLE' },
  );
  await assert.rejects(
    () =>
      service.savePermission(
        context(),
        { appCode: 'aio-foundation', active: false },
        'directory:read',
        permissionRevision,
      ),
    { code: 'PROTECTED_PERMISSION' },
  );
  const manager = await subject(['roles:manage', 'roles:read'], ids.unitA);
  await assert.rejects(
    () =>
      service.saveRole(context(manager), {
        appCode: 'aio-foundation',
        code: 'not-allowed',
        name: 'Escalation',
        permissions: ['directory:manage'],
      }),
    { code: 'PERMISSION_CEILING_EXCEEDED' },
  );
  await assert.rejects(
    () =>
      service.saveRole(context(manager), {
        appCode: 'aio-probe',
        code: 'not-allowed',
        name: 'Outside delegation',
        permissions: [],
      }),
    { code: 'APPLICATION_DELEGATION_DENIED' },
  );
  await assert.rejects(
    () =>
      service.saveRole(context(ids.admin, ids.tenantB), {
        appCode: 'aio-foundation',
        code: 'not-allowed',
        name: 'Cross tenant',
        permissions: [],
      }),
    { code: 'PERMISSION_DENIED' },
  );
});
test('binding delegation cannot widen an org scope, assign to self, target protected users or cross tenant', async () => {
  const manager = await subject(['roles:manage', 'roles:read'], ids.unitA);
  const target = await subject();
  const body = {
    appCode: 'aio-foundation',
    accountId: target,
    roleCode: 'reader',
    orgUnitId: ids.unitA,
  };
  const binding = await service.saveBinding(context(manager), body);
  const principal = await store.principal(context(target).identity, 'aio-foundation');
  assert.equal(principal.permissions.length, 1);
  assert.equal(principal.permissions[0]?.orgUnitId, ids.unitA);
  await assert.rejects(() => service.saveBinding(context(manager), { ...body, orgUnitId: null }), {
    code: 'PERMISSION_CEILING_EXCEEDED',
  });
  await assert.rejects(
    () => service.saveBinding(context(manager), { ...body, orgUnitId: ids.unitC }),
    { code: 'PERMISSION_CEILING_EXCEEDED' },
  );
  await assert.rejects(() => service.saveBinding(context(), { ...body, accountId: ids.admin }), {
    code: 'SELF_ASSIGNMENT_FORBIDDEN',
  });
  await assert.rejects(
    () => service.saveBinding(context(manager), { ...body, accountId: ids.admin }),
    { code: 'PROTECTED_ACCOUNT' },
  );
  await assert.rejects(() => service.saveBinding(context(), { ...body, accountId: ids.other }), {
    code: 'TARGET_NOT_FOUND',
  });
  await service.saveBinding(
    context(manager),
    { appCode: 'aio-foundation', active: false },
    String(binding.id),
    1,
  );
  assert.equal(
    (await store.principal(context(target).identity, 'aio-foundation')).permissions.length,
    0,
  );
});
test('an administrator cannot expand a role already assigned to themselves', async () => {
  const manager = await subject([
    'roles:manage',
    'roles:read',
    'directory:read',
    'directory:manage',
  ]);
  const roleCode = 'self-' + randomUUID().slice(0, 8);
  await service.saveRole(context(manager), {
    appCode: 'aio-foundation',
    code: roleCode,
    name: 'Own role fixture',
    permissions: ['directory:read'],
  });
  createdRoles.push(roleCode);
  await pool.query(
    "INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code) VALUES ($1,$2,$3,'aio-foundation',$4)",
    [randomUUID(), manager, ids.tenantA, roleCode],
  );
  await assert.rejects(
    () =>
      service.saveRole(
        context(manager),
        { appCode: 'aio-foundation', permissions: ['directory:read', 'directory:manage'] },
        roleCode,
        1,
      ),
    { code: 'SELF_ESCALATION_FORBIDDEN' },
  );
});
test('role changes take effect on existing bindings and mark privileged assignees as requiring MFA', async () => {
  const target = await subject();
  const roleCode = 'dynamic-' + randomUUID().slice(0, 8);
  createdRoles.push(roleCode);
  await service.saveRole(context(), {
    appCode: 'aio-foundation',
    code: roleCode,
    name: 'Dynamic role',
    permissions: ['directory:read'],
  });
  const binding = await service.saveBinding(context(), {
    appCode: 'aio-foundation',
    accountId: target,
    roleCode,
  });
  await service.saveRole(
    context(),
    { appCode: 'aio-foundation', permissions: ['directory:read', 'directory:manage'] },
    roleCode,
    1,
  );
  assert.equal(
    (await store.principal(context(target).identity, 'aio-foundation')).permissions.some(
      (p) => p.permission === 'directory:manage',
    ),
    true,
  );
  assert.equal(
    (await pool.query('SELECT mfa_required FROM accounts WHERE id=$1', [target])).rows[0]
      .mfa_required,
    true,
  );
  await service.saveRole(context(), { appCode: 'aio-foundation', active: false }, roleCode, 2);
  assert.equal(
    (await store.principal(context(target).identity, 'aio-foundation')).permissions.length,
    0,
  );
  await service.saveBinding(
    context(),
    { appCode: 'aio-foundation', active: false },
    String(binding.id),
    1,
  );
});
test('grant management enforces revisions, self protection and immediate revocation', async () => {
  const target = await subject();
  const body = { appCode: 'aio-probe', accountId: target, active: true };
  const request = context();
  const grant = await service.saveGrant(request, body);
  assert.equal(grant.revision, 1);
  assert.deepEqual(await service.saveGrant(request, body), grant);
  await store.principal(context(target).identity, 'aio-probe');
  await assert.rejects(() => service.saveGrant(context(), { ...body, active: false }, 9), {
    code: 'REVISION_CONFLICT',
  });
  await service.saveGrant(context(), { ...body, active: false }, 1);
  await assert.rejects(() => store.principal(context(target).identity, 'aio-probe'), {
    code: 'APPLICATION_ACCESS_DENIED',
  });
  await assert.rejects(() => service.saveGrant(context(), { ...body, accountId: ids.admin }), {
    code: 'SELF_ASSIGNMENT_FORBIDDEN',
  });
  await assert.rejects(
    () =>
      service.saveGrant(
        context(),
        {
          accountId: ids.admin,
          appCode: 'aio-foundation',
          active: false,
        },
        0,
      ),
    { code: 'SELF_ASSIGNMENT_FORBIDDEN' },
  );
});
