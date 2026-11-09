import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { assertLocalDatabase, loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { demoUsers, ids } from '../src/fixtures.js';

const config = await loadLocalConfig();
const adminPool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
try {
  const exists = await adminPool.query(
    "SELECT 1 FROM pg_database WHERE datname = 'aio_foundation_test'",
  );
  if (!exists.rowCount) await adminPool.query('CREATE DATABASE aio_foundation_test');
} finally {
  await adminPool.end();
}

for (const test of [false, true]) {
  const url = test ? testDatabaseUrl(config) : config.databaseUrl;
  assertLocalDatabase(url, test);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(71092026)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const sql = await readFile('infrastructure/database/001-foundation.sql', 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prior = await client.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version=$1',
      ['001'],
    );
    if (prior.rows[0] && prior.rows[0].checksum !== checksum)
      throw new Error('Migration checksum changed; create a new migration.');
    if (!prior.rowCount) {
      const tables = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'",
      );
      if (tables.rowCount) throw new Error('Refusing migration in an unidentified database.');
      await client.query(sql);
      await client.query('INSERT INTO environment_marker(purpose) VALUES ($1)', [
        test ? 'tlqm-aio-test' : 'tlqm-aio-local',
      ]);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)', [
        '001',
        checksum,
      ]);
    }
    const marker = await client.query<{ purpose: string }>(
      'SELECT purpose FROM environment_marker',
    );
    if (marker.rows[0]?.purpose !== (test ? 'tlqm-aio-test' : 'tlqm-aio-local'))
      throw new Error('Wrong database marker.');
    for (const [id, code, name] of [
      [ids.tenantA, 'DEMO-A', 'Không gian thử A'],
      [ids.tenantB, 'DEMO-B', 'Không gian thử B'],
    ]) {
      await client.query(
        'INSERT INTO tenants(id,code,name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [id, code, name],
      );
    }
    for (const item of config.clients) {
      await client.query(
        "INSERT INTO applications(code,name,status,launch_url) VALUES ($1,$2,'active',$3) ON CONFLICT DO NOTHING",
        [item.code, item.name, item.baseUrl],
      );
      await client.query(
        "INSERT INTO app_roles(app_code,code) VALUES ($1,'reader'),($1,'access-admin') ON CONFLICT DO NOTHING",
        [item.code],
      );
      for (const [role, permission] of [
        ['reader', 'directory:read'],
        ['access-admin', 'directory:read'],
        ['access-admin', 'access:manage'],
        ['access-admin', 'audit:read'],
      ]) {
        await client.query(
          'INSERT INTO role_permissions(app_code,role_code,permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [item.code, role, permission],
        );
      }
    }
    await client.query(
      "INSERT INTO applications(code,name,status) VALUES ('aio-forms','AIO Forms','planned'),('tlqm-lms','TLQM LMS','planned') ON CONFLICT DO NOTHING",
    );
    for (const user of demoUsers) {
      await client.query(
        'INSERT INTO persons(id,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [user.id, user.name],
      );
      await client.query(
        'INSERT INTO accounts(id,person_id,active) VALUES ($1,$1,$2) ON CONFLICT DO NOTHING',
        [user.id, user.id !== ids.blocked],
      );
      await client.query(
        'INSERT INTO external_identities(issuer,subject,account_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [config.issuer, user.id, user.id],
      );
      await client.query(
        'INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [user.id, user.tenantId],
      );
      for (const app of config.clients) {
        if (user.id !== ids.noAccess)
          await client.query(
            'INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [user.id, user.tenantId, app.code],
          );
        const role = user.id === ids.admin ? 'access-admin' : 'reader';
        for (const managed of user.id === ids.admin ? config.clients.map((c) => c.code) : [null]) {
          const existing = await client.query(
            'SELECT 1 FROM role_bindings WHERE account_id=$1 AND app_code=$2 AND role_code=$3 AND managed_app_code IS NOT DISTINCT FROM $4',
            [user.id, app.code, role, managed],
          );
          if (!existing.rowCount)
            await client.query(
              'INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code,managed_app_code) VALUES ($1,$2,$3,$4,$5,$6)',
              [randomUUID(), user.id, user.tenantId, app.code, role, managed],
            );
        }
      }
    }
    for (const [id, tenant, code, name] of [
      [ids.legalA, ids.tenantA, 'LEGAL-A', 'Pháp nhân giả lập A'],
      [ids.legalB, ids.tenantB, 'LEGAL-B', 'Pháp nhân giả lập B'],
    ]) {
      await client.query(
        'INSERT INTO legal_entities(id,tenant_id,code,name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [id, tenant, code, name],
      );
    }
    for (const [id, tenant, legal, code, name] of [
      [ids.unitA, ids.tenantA, ids.legalA, 'HR', 'Đào tạo'],
      [ids.unitC, ids.tenantA, ids.legalA, 'DIGITAL', 'Chuyển đổi số'],
      [ids.unitB, ids.tenantB, ids.legalB, 'OPS', 'Vận hành'],
    ]) {
      await client.query(
        'INSERT INTO org_units(id,tenant_id,legal_entity_id,code,name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [id, tenant, legal, code, name],
      );
    }
    const title = '50000000-0000-4000-8000-000000000001';
    const employment = '60000000-0000-4000-8000-000000000001';
    await client.query(
      "INSERT INTO job_titles(id,code,name) VALUES ($1,'SPECIALIST','Chuyên viên') ON CONFLICT DO NOTHING",
      [title],
    );
    await client.query(
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
      await client.query(
        'INSERT INTO positions(id,tenant_id,legal_entity_id,org_unit_id,job_title_id,name) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [position, ids.tenantA, ids.legalA, unit, title, 'Vị trí thử nghiệm'],
      );
      await client.query(
        'INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [assignment, ids.tenantA, ids.legalA, employment, position, primary],
      );
    }
    await client.query('COMMIT');
    console.log(
      (test ? 'Test' : 'Local') + ' Foundation database ready; existing grants/accounts preserved.',
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
