import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { ids } from '../src/fixtures.js';
import {
  stagingDatabaseTls,
  stagingModuleDatabase,
  stagingModules,
  stagingTarget,
} from '../src/staging-config.js';
import type { StagingConfig, StagingModule } from '../src/staging-config.js';
import { migrateForms } from '../src/forms/database.js';
import { migrateTasks } from '../src/tasks/database.js';
import { migrateWorkflows } from '../src/workflows/database.js';
import { grantModuleRuntime } from '../src/database/module-grants.js';
import { formsPermissions } from '../src/forms/access.js';
import { taskPermissions } from '../src/tasks/access.js';
import { workflowPermissions } from '../src/workflows/access.js';
import { provisionStagingReportActors } from './staging-report-fixtures.js';
import type { ReportActor } from './staging-report-fixtures.js';

const modules = {
  forms: {
    migrate: migrateForms,
    permissions: formsPermissions,
    member: ['forms:respond'],
    audit: 'form_audit',
  },
  tasks: {
    migrate: migrateTasks,
    permissions: taskPermissions,
    member: ['tasks:view', 'tasks:work'],
    audit: 'task_audit',
  },
  workflows: {
    migrate: migrateWorkflows,
    permissions: workflowPermissions,
    member: ['workflows:start', 'workflows:act'],
    audit: 'workflow_audit',
  },
};
const lmsFixture = {
  permissions: {
    'directory:lookup': 'Tra cứu đơn vị và người học trong phạm vi',
    'lms:learn': 'Xem dữ liệu học của tôi',
    'lms:review': 'Xem báo cáo đào tạo theo phạm vi',
    'lms:admin': 'Quản trị đào tạo',
  },
  member: ['lms:learn'],
};

export async function upgradeStagingModules(
  runtime: StagingConfig,
  ownerUrl: URL,
  ca: string,
  artifact?: string,
) {
  const result: Record<string, { before: string[]; after: string[] }> = {};
  for (const module of stagingModules) {
    const database = stagingModuleDatabase(runtime.slot, module);
    const url = new URL(ownerUrl);
    url.pathname = '/' + database.name;
    const pool = new pg.Pool({
      connectionString: url.href,
      ssl: stagingDatabaseTls(ca),
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    try {
      const db = await pool.connect();
      try {
        const journal = () =>
          db
            .query<{ version: string }>('SELECT * FROM schema_migrations ORDER BY version')
            .then(({ rows }) => rows);
        assert.deepEqual(
          (await db.query('SELECT current_database() AS name,current_user AS role')).rows[0],
          { name: database.name, role: 'aio_stage_owner' },
        );
        const before = await journal();
        if (artifact) {
          await db.query('SET ROLE ' + database.owner);
          await modules[module].migrate(db, runtime.instanceId, {
            slot: runtime.slot,
            directory: join(artifact, 'infrastructure', module),
          });
          await grantModuleRuntime(db, module);
        }
        const after = await journal();
        assert.deepEqual(after.slice(0, before.length), before);
        result[module] = {
          before: before.map(({ version }) => version),
          after: after.map(({ version }) => version),
        };
      } finally {
        db.release(true);
      }
    } finally {
      await pool.end();
    }
  }
  return result;
}

export async function provisionStagingModules(
  db: PoolClient,
  runtime: StagingConfig,
  ca: string,
  artifact: string,
  accessUi = false,
  reportSubjects?: Record<ReportActor, string>,
) {
  const target = stagingTarget(runtime.slot);
  assert.ok(runtime.moduleDatabases);
  assert.deepEqual(
    (await db.query('SELECT current_database() AS name, current_user AS owner')).rows[0],
    { name: target.database, owner: 'aio_stage_owner' },
  );
  assert.equal(
    (
      await db.query('SELECT 1 FROM bootstrap_receipts WHERE name=$1', [
        'enterprise-staging:' + runtime.instanceId,
      ])
    ).rowCount,
    1,
  );
  for (const name of ['postgres', 'template1'])
    await db.query('REVOKE CONNECT ON DATABASE ' + name + ' FROM PUBLIC');
  const journals: Partial<Record<StagingModule, string[]>> = {};
  for (const module of stagingModules) {
    const database = stagingModuleDatabase(runtime.slot, module);
    const ownerPassword = randomBytes(32).toString('hex');
    const runtimeUrl = new URL(runtime.moduleDatabases[module]);
    for (const [role, password] of [
      [database.owner, ownerPassword],
      [database.role, runtimeUrl.password],
    ] as const)
      await db.query(
        'CREATE ROLE ' +
          role +
          ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ' +
          db.escapeLiteral(password),
      );
    await db.query('CREATE DATABASE ' + database.name + ' OWNER ' + database.owner);
    await db.query('REVOKE ALL ON DATABASE ' + database.name + ' FROM PUBLIC');
    await db.query('GRANT CONNECT ON DATABASE ' + database.name + ' TO ' + database.role);
    const ownerUrl = new URL(runtimeUrl);
    ownerUrl.username = database.owner;
    ownerUrl.password = ownerPassword;
    const owner = new pg.Pool({
      connectionString: ownerUrl.href,
      ssl: stagingDatabaseTls(ca),
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    try {
      const connection = await owner.connect();
      try {
        journals[module] = await modules[module].migrate(connection, runtime.instanceId, {
          slot: runtime.slot,
          directory: join(artifact, 'infrastructure', module),
        });
        await grantModuleRuntime(connection, module);
        assert.deepEqual(
          (
            await connection.query(
              "SELECT has_table_privilege($1,'schema_migrations','INSERT') AS journal, has_table_privilege($1,'environment_marker','UPDATE') AS marker, has_table_privilege($1,$2,'UPDATE,DELETE') AS audit, has_schema_privilege($1,'public','CREATE') AS ddl",
              [database.role, modules[module].audit],
            )
          ).rows[0],
          { journal: false, marker: false, audit: false, ddl: false },
        );
      } finally {
        connection.release();
      }
    } finally {
      await owner.end();
    }
  }
  const moduleTargets = stagingModules.map((module) => stagingModuleDatabase(runtime.slot, module));
  for (const { role, name } of [{ role: 'aio_runtime', name: target.database }, ...moduleTargets]) {
    const grants = (
      await db.query<{ name: string; allowed: boolean }>(
        "SELECT name,has_database_privilege($1,name,'CONNECT') AS allowed FROM unnest($2::text[]) AS t(name)",
        [
          role,
          [
            target.database,
            'aio_stage_identity',
            'postgres',
            'template1',
            ...moduleTargets.map((m) => m.name),
          ],
        ],
      )
    ).rows;
    assert.deepEqual(
      grants.filter((grant) => grant.allowed).map((grant) => grant.name),
      [name],
    );
  }
  await db.query('BEGIN');
  try {
    const employment = randomUUID();
    await db.query(
      "INSERT INTO employments(id,person_id,tenant_id,legal_entity_id,employee_code) VALUES ($1,$2,$3,$4,'NV-STAGE-OPERATOR')",
      [employment, ids.admin, ids.tenantA, ids.legalA],
    );
    await db.query(
      'INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary) VALUES ($1,$2,$3,$4,$5,true)',
      [randomUUID(), ids.tenantA, ids.legalA, employment, '70000000-0000-4000-8000-000000000001'],
    );
    const appFixtures: {
      code: string;
      permissions: Readonly<Record<string, string>>;
      member: string[];
    }[] = stagingModules.map((module) => ({
      code: 'aio-' + module,
      permissions: modules[module].permissions,
      member: modules[module].member,
    }));
    if (runtime.clients.some((client) => client.code === 'aio-lms-sandbox'))
      appFixtures.push({ code: 'aio-lms-sandbox', ...lmsFixture });
    for (const fixture of appFixtures) {
      const app = runtime.clients.find((client) => client.code === fixture.code)!;
      const activation = await db.query(
        `INSERT INTO applications(code,name,status,launch_url,owner_tenant_id,oidc_client_id,oidc_audience,provisioned_at)
         VALUES ($1,$2,'active',$3,$4,$5,$6,now())
         ON CONFLICT(code) DO UPDATE SET status='active',launch_url=excluded.launch_url,
           oidc_client_id=excluded.oidc_client_id,oidc_audience=excluded.oidc_audience,provisioned_at=now()
         WHERE applications.status='planned' AND applications.owner_tenant_id=excluded.owner_tenant_id`,
        [app.code, app.name, app.baseUrl, ids.tenantA, app.clientId, app.audience],
      );
      assert.equal(activation.rowCount, 1);
      const permissions = Object.entries(fixture.permissions);
      for (const [code, label] of permissions)
        await db.query('INSERT INTO permission_catalog(app_code,code,name) VALUES ($1,$2,$3)', [
          app.code,
          code,
          label,
        ]);
      for (const [role, codes] of [
        ['stage-operator', permissions.map(([code]) => code)],
        ['stage-member', fixture.member],
      ] as const) {
        await db.query('INSERT INTO app_roles(tenant_id,app_code,code,name) VALUES ($1,$2,$3,$3)', [
          ids.tenantA,
          app.code,
          role,
        ]);
        for (const code of codes)
          await db.query(
            'INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,$2,$3,$4)',
            [ids.tenantA, app.code, role, code],
          );
      }
      for (const [account, role, unit] of [
        [ids.admin, 'stage-operator', null],
        [ids.recovery, 'stage-operator', null],
        [ids.learner, 'stage-member', ids.unitA],
      ] as const) {
        await db.query(
          'INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,$3)',
          [account, ids.tenantA, app.code],
        );
        await db.query(
          'INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code,org_unit_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [randomUUID(), account, ids.tenantA, app.code, role, unit],
        );
      }
      await db.query(
        "INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code,managed_app_code) VALUES ($1,$2,$3,'aio-foundation','access-admin',$4)",
        [randomUUID(), ids.admin, ids.tenantA, app.code],
      );
    }
    if (accessUi) {
      await db.query(
        "INSERT INTO app_roles(tenant_id,app_code,code,name) VALUES ($1,'aio-tasks','stage-tenant-operator','Stage tenant operator')",
        [ids.tenantB],
      );
      for (const permission of ['tasks:manage', 'tasks:view']) {
        await db.query(
          "INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,'aio-tasks','stage-tenant-operator',$2)",
          [ids.tenantB, permission],
        );
      }
      await db.query(
        "INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,'aio-tasks')",
        [ids.other, ids.tenantB],
      );
      await db.query(
        "INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code) VALUES ($1,$2,$3,'aio-tasks','stage-tenant-operator')",
        [randomUUID(), ids.other, ids.tenantB],
      );
    }
    if (reportSubjects) await provisionStagingReportActors(db, runtime.issuer, reportSubjects);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
  return { journals, runtimeIsolation: true };
}
