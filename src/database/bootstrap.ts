import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { LocalConfig } from '../config.js';
import { demoUsers, ids } from '../fixtures.js';
import { foundationPermissions } from '../policy.js';

export async function bootstrapFixtures(
  db: PoolClient,
  config: Pick<LocalConfig, 'clients' | 'issuer' | 'users'>,
  verifiedClients: ReadonlySet<string> = new Set(),
) {
  // Onboarded clients receive explicit fixture grants through the governance contract, never blanket seed access.
  const bootstrapClients = config.clients.filter((client) => client.kind === undefined);
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(71092026)');
    for (const [id, code, name] of [
      [ids.tenantA, 'DEMO-A', 'Không gian thử A'],
      [ids.tenantB, 'DEMO-B', 'Không gian thử B'],
    ]) {
      await db.query('INSERT INTO tenants(id,code,name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
        id,
        code,
        name,
      ]);
    }
    for (const app of bootstrapClients) {
      await db.query(
        "INSERT INTO applications(code,name,status,launch_url,owner_tenant_id) VALUES ($1,$2,'active',$3,$4) ON CONFLICT DO NOTHING",
        [app.code, app.name, app.baseUrl, ids.tenantA],
      );
      if (verifiedClients.has(app.code))
        await db.query(
          'UPDATE applications SET oidc_client_id=$2,oidc_audience=$3,provisioned_at=COALESCE(provisioned_at,now()) WHERE code=$1 AND launch_url=$4',
          [app.code, app.clientId, app.audience, app.baseUrl],
        );
      const permissions =
        app.code === 'aio-foundation'
          ? Object.entries(foundationPermissions)
          : [
              ['directory:read', 'Xem cơ cấu tổ chức'],
              ['access:manage', 'Cấp và thu hồi truy cập'],
              ['audit:read', 'Xem lịch sử quản trị'],
            ];
      for (const [permission, name] of permissions)
        await db.query(
          'INSERT INTO permission_catalog(app_code,code,name,protected) VALUES ($1,$2,$3,true) ON CONFLICT(app_code,code) DO UPDATE SET name=EXCLUDED.name WHERE permission_catalog.protected AND permission_catalog.name=permission_catalog.code',
          [app.code, permission, name],
        );
      for (const tenant of [ids.tenantA, ids.tenantB]) {
        for (const [code, name] of [
          ['reader', 'Đọc danh mục'],
          ['access-admin', 'Quản trị nền tảng'],
        ]) {
          await db.query(
            'INSERT INTO app_roles(tenant_id,app_code,code,name,protected) VALUES ($1,$2,$3,$4,true) ON CONFLICT(tenant_id,app_code,code) DO UPDATE SET name=EXCLUDED.name WHERE app_roles.protected AND app_roles.name=app_roles.code',
            [tenant, app.code, code, name],
          );
        }
        const receipt = 'v2-role-permissions:' + tenant + ':' + app.code;
        const first = await db.query(
          'INSERT INTO bootstrap_receipts(name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name',
          [receipt],
        );
        if (first.rowCount) {
          await db.query(
            "INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,$2,'reader','directory:read') ON CONFLICT DO NOTHING",
            [tenant, app.code],
          );
          for (const [permission] of permissions)
            await db.query(
              "INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,$2,'access-admin',$3) ON CONFLICT DO NOTHING",
              [tenant, app.code, permission],
            );
        }
      }
    }
    await db.query(
      "INSERT INTO applications(code,name,status,owner_tenant_id) VALUES ('aio-forms','AIO Forms','planned',$1),('tlqm-lms','TLQM LMS','planned',$1) ON CONFLICT DO NOTHING",
      [ids.tenantA],
    );
    for (const user of demoUsers) {
      const administrator = user.id === ids.admin || user.id === ids.recovery;
      await db.query(
        'INSERT INTO persons(id,display_name,home_tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [user.id, user.name, user.tenantId],
      );
      await db.query(
        'INSERT INTO accounts(id,person_id,active,is_protected,mfa_required) VALUES ($1,$1,$2,$3,$3) ON CONFLICT DO NOTHING',
        [user.id, user.id !== ids.blocked, administrator],
      );
      await db.query(
        'INSERT INTO external_identities(issuer,subject,account_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [
          config.issuer,
          config.users.find((value) => value.id === user.id)?.subject ?? user.id,
          user.id,
        ],
      );
      await db.query(
        'INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [user.id, user.tenantId],
      );
      for (const app of bootstrapClients) {
        if (user.id !== ids.noAccess)
          await db.query(
            'INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [user.id, user.tenantId, app.code],
          );
        const role = administrator ? 'access-admin' : 'reader';
        for (const managed of administrator
          ? bootstrapClients.map((client) => client.code)
          : [null]) {
          const exists = await db.query(
            'SELECT 1 FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 AND role_code=$4 AND managed_app_code IS NOT DISTINCT FROM $5',
            [user.id, user.tenantId, app.code, role, managed],
          );
          if (!exists.rowCount) {
            const receipt = 'v2-binding:' + user.id + ':' + app.code + ':' + String(managed);
            const first = await db.query(
              'INSERT INTO bootstrap_receipts(name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name',
              [receipt],
            );
            if (first.rowCount)
              await db.query(
                'INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code,managed_app_code) VALUES ($1,$2,$3,$4,$5,$6)',
                [randomUUID(), user.id, user.tenantId, app.code, role, managed],
              );
          } else {
            await db.query(
              'INSERT INTO bootstrap_receipts(name) VALUES ($1) ON CONFLICT DO NOTHING',
              ['v2-binding:' + user.id + ':' + app.code + ':' + String(managed)],
            );
          }
        }
      }
    }
    for (const [id, tenant, code, name] of [
      [ids.legalA, ids.tenantA, 'LEGAL-A', 'Pháp nhân giả lập A'],
      [ids.legalB, ids.tenantB, 'LEGAL-B', 'Pháp nhân giả lập B'],
    ]) {
      await db.query(
        'INSERT INTO legal_entities(id,tenant_id,code,name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [id, tenant, code, name],
      );
    }
    for (const [id, tenant, legal, code, name] of [
      [ids.unitA, ids.tenantA, ids.legalA, 'HR', 'Đào tạo'],
      [ids.unitC, ids.tenantA, ids.legalA, 'DIGITAL', 'Chuyển đổi số'],
      [ids.unitB, ids.tenantB, ids.legalB, 'OPS', 'Vận hành'],
    ]) {
      await db.query(
        'INSERT INTO org_units(id,tenant_id,legal_entity_id,code,name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [id, tenant, legal, code, name],
      );
    }
    const title = '50000000-0000-4000-8000-000000000001';
    const employment = '60000000-0000-4000-8000-000000000001';
    await db.query(
      "INSERT INTO job_titles(id,tenant_id,code,name) VALUES ($1,$2,'SPECIALIST','Chuyên viên') ON CONFLICT DO NOTHING",
      [title, ids.tenantA],
    );
    await db.query(
      "INSERT INTO employments(id,person_id,tenant_id,legal_entity_id,employee_code) VALUES ($1,$2,$3,$4,'NV-DEMO-01') ON CONFLICT DO NOTHING",
      [employment, ids.learner, ids.tenantA, ids.legalA],
    );
    for (const [position, assignment, unit, primary] of [
      [
        '70000000-0000-4000-8000-000000000001',
        '80000000-0000-4000-8000-000000000001',
        ids.unitA,
        true,
      ],
      [
        '70000000-0000-4000-8000-000000000002',
        '80000000-0000-4000-8000-000000000002',
        ids.unitC,
        false,
      ],
    ]) {
      await db.query(
        'INSERT INTO positions(id,tenant_id,legal_entity_id,org_unit_id,job_title_id,name) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [position, ids.tenantA, ids.legalA, unit, title, 'Vị trí thử nghiệm'],
      );
      await db.query(
        'INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
        [assignment, ids.tenantA, ids.legalA, employment, position, primary],
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
