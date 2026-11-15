import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { loadLocalConfig, testDatabaseUrl, assertLocalDatabase } from '../src/config.js';
import { Store } from '../src/store.js';
import { ids } from '../src/fixtures.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { bootstrapFixtures } from '../src/database/bootstrap.js';

const config = await loadLocalConfig();
const url = testDatabaseUrl(config);
assertLocalDatabase(url, true);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const ownerUrl = new URL(config.databaseUrl);
ownerUrl.pathname = '/aio_foundation_test';
assertLocalDatabase(ownerUrl.href, true);
const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 1 });
const store = new Store(pool);
const identity = (subject: string) => ({
  issuer: config.issuer,
  subject,
  authenticatedAt: Math.floor(Date.now() / 1000),
  authenticationMethods: ['pwd', 'otp'],
});
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
});
after(async () => {
  await pool.end();
  await ownerPool.end();
});
async function rollback(callback: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await callback(db);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}
test('API role is distinct from the migration owner and cannot change schema, markers or audit history', async () => {
  const role = (
    await pool.query(
      'SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
    )
  ).rows[0];
  assert.deepEqual(role, {
    name: 'aio_runtime',
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
  });
  for (const sql of [
    'CREATE TABLE public.must_not_be_created_by_runtime(id integer)',
    'ALTER TABLE persons ADD COLUMN must_not_exist integer',
    'UPDATE environment_marker SET purpose=purpose',
    'DELETE FROM schema_migrations WHERE false',
    'UPDATE audit_events SET reason=reason WHERE false',
    'DELETE FROM audit_events WHERE false',
  ])
    await assert.rejects(() => pool.query(sql), { code: '42501' });
});
test('organization hierarchy rejects cycles and cross-tenant legal references', async () => {
  await rollback(async (db) => {
    const first = randomUUID(),
      second = randomUUID();
    await db.query(
      'INSERT INTO org_units(id,tenant_id,legal_entity_id,code,name) VALUES ($1,$2,$3,$4,$5)',
      [first, ids.tenantA, ids.legalA, 'U-' + first, 'Parent test'],
    );
    await db.query(
      'INSERT INTO org_units(id,tenant_id,legal_entity_id,parent_id,code,name) VALUES ($1,$2,$3,$4,$5,$6)',
      [second, ids.tenantA, ids.legalA, first, 'U-' + second, 'Child test'],
    );
    await assert.rejects(
      () => db.query('UPDATE org_units SET parent_id=$1 WHERE id=$2', [second, first]),
      { code: '23514', constraint: 'organization_no_cycle' },
    );
  });
  await rollback(async (db) => {
    await assert.rejects(
      () =>
        db.query(
          'INSERT INTO org_units(id,tenant_id,legal_entity_id,code,name) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), ids.tenantA, ids.legalB, 'CROSS', 'Wrong scope'],
        ),
      { code: '23503' },
    );
  });
});
test('primary assignments cannot overlap while concurrent secondary assignments remain valid', async () => {
  const employment = '60000000-0000-4000-8000-000000000001';
  const position = '70000000-0000-4000-8000-000000000002';
  await rollback(async (db) => {
    await db.query(
      "INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary,valid_from) VALUES ($1,$2,$3,$4,$5,false,now()+interval '1 day')",
      [randomUUID(), ids.tenantA, ids.legalA, employment, position],
    );
    await assert.rejects(
      () =>
        db.query(
          "INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary,valid_from) VALUES ($1,$2,$3,$4,$5,true,now()+interval '1 day')",
          [randomUUID(), ids.tenantA, ids.legalA, employment, position],
        ),
      { code: '23P01', constraint: 'primary_assignment_no_overlap' },
    );
  });
});
test('assignment validity must fit its employment and ending employment preserves valid history', async () => {
  const employment = '60000000-0000-4000-8000-000000000001';
  const position = '70000000-0000-4000-8000-000000000002';
  await rollback(async (db) => {
    await assert.rejects(
      () =>
        db.query(
          "INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary,valid_from) VALUES ($1,$2,$3,$4,$5,false,'2000-01-01T00:00:00Z')",
          [randomUUID(), ids.tenantA, ids.legalA, employment, position],
        ),
      { code: '23514', constraint: 'assignment_within_employment' },
    );
  });
  await rollback(async (db) => {
    await db.query("UPDATE employments SET valid_until=now()+interval '1 day' WHERE id=$1", [
      employment,
    ]);
    await assert.rejects(() => db.query('SET CONSTRAINTS ALL IMMEDIATE'), {
      code: '23514',
      constraint: 'employment_contains_assignments',
    });
  });
});
test('role definitions in one tenant never expand another tenant role with the same code', async () => {
  await rollback(async (db) => {
    await db.query(
      "INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,'aio-foundation','reader','roles:manage')",
      [ids.tenantB],
    );
    const tenantB = await store.principal(identity(ids.other), 'aio-foundation', db);
    assert.equal(
      tenantB.permissions.some((permission) => permission.permission === 'roles:manage'),
      true,
    );
    const tenantA = await store.principal(identity(ids.learner), 'aio-foundation', db);
    assert.equal(
      tenantA.permissions.some((permission) => permission.permission === 'roles:manage'),
      false,
    );
    await db.query(
      "UPDATE app_roles SET active=false WHERE tenant_id=$1 AND app_code='aio-foundation' AND code='reader'",
      [ids.tenantA],
    );
    const revoked = await store.principal(identity(ids.learner), 'aio-foundation', db);
    assert.equal(revoked.permissions.length, 0);
  });
});
test('an org-unit binding cannot be used as a tenant-wide or other-unit permission', async () => {
  await rollback(async (db) => {
    await db.query(
      "UPDATE role_bindings SET org_unit_id=$1 WHERE account_id=$2 AND app_code='aio-foundation'",
      [ids.unitA, ids.learner],
    );
    const principal = await store.principal(identity(ids.learner), 'aio-foundation', db);
    store.require(principal, 'directory:read', ids.tenantA, undefined, ids.unitA);
    assert.throws(() => store.require(principal, 'directory:read', ids.tenantA), {
      code: 'PERMISSION_DENIED',
    });
    assert.throws(
      () => store.require(principal, 'directory:read', ids.tenantA, undefined, ids.unitC),
      { code: 'PERMISSION_DENIED' },
    );
  });
});
test('rerunning fixture setup preserves revoked app grants and disabled bindings', async () => {
  const grant = (
    await pool.query(
      "SELECT active FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code='aio-probe'",
      [ids.learner, ids.tenantA],
    )
  ).rows[0];
  const bindings = (
    await pool.query<{ id: string; active: boolean }>(
      "SELECT id,active FROM role_bindings WHERE account_id=$1 AND app_code='aio-probe'",
      [ids.learner],
    )
  ).rows;
  const owner = await ownerPool.connect();
  try {
    await pool.query(
      "UPDATE application_grants SET active=false WHERE account_id=$1 AND tenant_id=$2 AND app_code='aio-probe'",
      [ids.learner, ids.tenantA],
    );
    await pool.query(
      "UPDATE role_bindings SET active=false WHERE account_id=$1 AND app_code='aio-probe'",
      [ids.learner],
    );
    await bootstrapFixtures(owner, config);
    assert.equal(
      (
        await pool.query(
          "SELECT active FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code='aio-probe'",
          [ids.learner, ids.tenantA],
        )
      ).rows[0].active,
      false,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM role_bindings WHERE account_id=$1 AND app_code='aio-probe' AND active",
          [ids.learner],
        )
      ).rowCount,
      0,
    );
  } finally {
    await pool.query(
      "UPDATE application_grants SET active=$1 WHERE account_id=$2 AND tenant_id=$3 AND app_code='aio-probe'",
      [grant.active, ids.learner, ids.tenantA],
    );
    for (const binding of bindings)
      await pool.query('UPDATE role_bindings SET active=$1 WHERE id=$2', [
        binding.active,
        binding.id,
      ]);
    owner.release();
  }
});
test('core seed never grants new integration clients broadly or revives their disabled records', async () => {
  const client = config.clients.find((entry) => entry.kind === 'integration-probe');
  assert.ok(client, 'Run local:client before Foundation acceptance tests.');
  const before = await pool.query(
    'SELECT account_id,tenant_id,app_code,active FROM application_grants WHERE app_code=$1 ORDER BY account_id,tenant_id',
    [client.code],
  );
  const owner = await ownerPool.connect();
  try {
    await pool.query('UPDATE application_grants SET active=false WHERE app_code=$1', [client.code]);
    await bootstrapFixtures(owner, config);
    const after = await pool.query(
      'SELECT account_id,tenant_id,app_code,active FROM application_grants WHERE app_code=$1 ORDER BY account_id,tenant_id',
      [client.code],
    );
    assert.deepEqual(
      after.rows,
      before.rows.map((row) => ({ ...row, active: false })),
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM app_roles WHERE app_code=$1 AND code IN ('reader','access-admin')",
          [client.code],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM application_grants WHERE app_code=$1 AND account_id=$2', [
          client.code,
          ids.other,
        ])
      ).rowCount,
      0,
    );
  } finally {
    for (const row of before.rows)
      await pool.query(
        'UPDATE application_grants SET active=$1 WHERE app_code=$2 AND account_id=$3 AND tenant_id=$4',
        [row.active, row.app_code, row.account_id, row.tenant_id],
      );
    owner.release();
  }
});

test('migration checksum changes are rejected without altering the migration journal', async () => {
  const directory = '.local/evidence/migration-checksum-rejection';
  await mkdir(directory, { recursive: true });
  for (const file of (await readdir('infrastructure/database')).filter((name) =>
    name.endsWith('.sql'),
  )) {
    const content = await readFile('infrastructure/database/' + file, 'utf8');
    await writeFile(
      directory + '/' + file,
      content + (file.startsWith('001-') ? '\n-- Deliberate checksum-test change\n' : ''),
    );
  }
  const owner = await ownerPool.connect();
  try {
    const before = (
      await owner.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    await assert.rejects(
      () => migrateDatabase(owner, 'tlqm-aio-test', directory),
      /Migration checksum changed at 001/,
    );
    const after = (
      await owner.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    assert.deepEqual(after, before);
  } finally {
    owner.release();
  }
});
