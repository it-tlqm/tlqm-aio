import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { loadLocalConfig, assertLocalDatabase, applicationDatabaseUrl } from '../src/config.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { bootstrapFixtures } from '../src/database/bootstrap.js';
import { Store } from '../src/store.js';
import { ids } from '../src/fixtures.js';
import { localContainer } from './local-docker.js';
import { authenticateMfaFixture } from './mfa-browser.js';

const runtime = await loadLocalConfig();
assertLocalDatabase(runtime.databaseUrl);
const sourcePool = new pg.Pool({ connectionString: runtime.databaseUrl, max: 1 });
const targetName = 'aio_foundation_bootstrap_' + randomUUID().slice(0, 8);
if (!/^aio_foundation_bootstrap_[0-9a-f]{8}$/.test(targetName))
  throw new Error('Invalid bootstrap rehearsal target.');
const ownerUrl = new URL(runtime.databaseUrl);
ownerUrl.pathname = '/' + targetName;
if (
  ownerUrl.hostname !== '127.0.0.1' ||
  ownerUrl.port !== '5438' ||
  ownerUrl.username !== 'aio_foundation'
)
  throw new Error('Bootstrap rehearsal requires the isolated owner/host.');
let targetPool: pg.Pool | undefined;
let runtimePool: pg.Pool | undefined;
let stage = 'preflight';
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal(
    (await sourcePool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-local',
  );
  assert.equal(
    (await sourcePool.query('SELECT 1 FROM pg_database WHERE datname=$1', [targetName])).rowCount,
    0,
  );
  const configBefore = await readFile('.local/runtime.json');
  const browser = await chromium.launch({ headless: true });
  let proof;
  try {
    proof = await authenticateMfaFixture(browser, runtime, ids.admin);
  } finally {
    await browser.close();
  }
  await sourcePool.query(
    'CREATE DATABASE ' + targetName + ' WITH TEMPLATE template0 OWNER aio_foundation',
  );
  await sourcePool.query('REVOKE ALL ON DATABASE ' + targetName + ' FROM PUBLIC');
  targetPool = new pg.Pool({ connectionString: ownerUrl.href, max: 1 });
  const owner = await targetPool.connect();
  try {
    assert.equal((await owner.query('SELECT current_database() AS name')).rows[0].name, targetName);
    assert.equal(
      (await owner.query("SELECT 1 FROM pg_tables WHERE schemaname='public'")).rowCount,
      0,
    );
    stage = 'migrate empty database';
    const versions = await migrateDatabase(owner, 'tlqm-aio-test');
    stage = 'bootstrap fresh fixtures';
    await bootstrapFixtures(
      owner,
      runtime,
      new Set(runtime.clients.filter((client) => !client.kind).map((client) => client.code)),
    );
    await owner.query('GRANT CONNECT ON DATABASE ' + targetName + ' TO aio_runtime');
    await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await owner.query('GRANT USAGE ON SCHEMA public TO aio_runtime');
    await owner.query(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO aio_runtime',
    );
    await owner.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO aio_runtime');
    await owner.query(
      'REVOKE INSERT,UPDATE,DELETE ON schema_migrations,environment_marker,bootstrap_receipts FROM aio_runtime',
    );
    await owner.query('REVOKE UPDATE,DELETE ON audit_events,mutation_receipts FROM aio_runtime');
    const apiUrl = new URL(applicationDatabaseUrl(runtime));
    apiUrl.pathname = '/' + targetName;
    runtimePool = new pg.Pool({ connectionString: apiUrl.href, max: 1 });
    const store = new Store(runtimePool);
    stage = 'verify first-run identity and runtime privileges';
    const admin = await store.principal(
      {
        issuer: runtime.issuer,
        subject: proof.subject,
        authenticatedAt: proof.authTime,
        authenticationMethods: proof.authenticationMethods ?? [],
      },
      'aio-foundation',
    );
    assert.equal(admin.accountId, ids.admin);
    store.require(admin, 'identity:link', ids.tenantA);
    store.require(admin, 'applications:create', ids.tenantA);
    assert.equal((await store.assignments(ids.learner)).length, 2);
    assert.equal(
      (
        await owner.query(
          'SELECT 1 FROM accounts WHERE id=ANY($1) AND is_protected AND mfa_required',
          [[ids.admin, ids.recovery]],
        )
      ).rowCount,
      2,
    );
    assert.equal(
      (
        await owner.query(
          "SELECT 1 FROM applications WHERE code IN ('aio-foundation','aio-probe') AND protected AND provisioned_at IS NOT NULL",
        )
      ).rowCount,
      2,
    );
    assert.equal(
      (await owner.query("SELECT 1 FROM application_grants WHERE app_code='aio-onboarding'"))
        .rowCount,
      0,
    );
    await assert.rejects(
      () => runtimePool!.query('CREATE TABLE forbidden_bootstrap_ddl(id integer)'),
      { code: '42501' },
    );
    await assert.rejects(() => runtimePool!.query('DELETE FROM schema_migrations WHERE false'), {
      code: '42501',
    });
    stage = 'idempotent second setup';
    const snapshot = (
      await owner.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    await owner.query(
      "UPDATE application_grants SET active=false WHERE account_id=$1 AND app_code='aio-probe'",
      [ids.learner],
    );
    await owner.query(
      "UPDATE role_bindings SET active=false WHERE account_id=$1 AND app_code='aio-probe'",
      [ids.learner],
    );
    await migrateDatabase(owner, 'tlqm-aio-test');
    await bootstrapFixtures(owner, runtime);
    assert.deepEqual(
      (await owner.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows,
      snapshot,
    );
    assert.equal(
      (
        await owner.query(
          "SELECT 1 FROM application_grants WHERE account_id=$1 AND app_code='aio-probe' AND active",
          [ids.learner],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await owner.query(
          "SELECT 1 FROM role_bindings WHERE account_id=$1 AND app_code='aio-probe' AND active",
          [ids.learner],
        )
      ).rowCount,
      0,
    );
    assert.ok((await readFile('.local/runtime.json')).equals(configBefore));
    await owner.query('CREATE SCHEMA aio_bootstrap_guard AUTHORIZATION aio_foundation');
    await owner.query('REVOKE ALL ON SCHEMA aio_bootstrap_guard FROM PUBLIC,aio_runtime');
    await owner.query(
      'CREATE TABLE aio_bootstrap_guard.environment(instance_id uuid NOT NULL,purpose text NOT NULL)',
    );
    await owner.query(
      "INSERT INTO aio_bootstrap_guard.environment VALUES ($1,'empty-database-bootstrap-rehearsal')",
      [runtime.instanceId],
    );
    await mkdir('.local/evidence', { recursive: true });
    await writeFile(
      '.local/evidence/bootstrap.json',
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          result: 'pass',
          targetDatabase: targetName,
          versions,
          emptyDatabaseMigrated: true,
          freshMfaProofMappedToBootstrapAdmin: true,
          protectedAdminsAndClients: true,
          runtimePrivilegesChecked: true,
          secondSetupPreservedRevocation: true,
          configurationUnchanged: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS: empty isolated database migration/bootstrap, MFA identity mapping, runtime privileges and idempotent rerun.',
    );
  } finally {
    owner.release();
  }
} catch (error) {
  const diagnostic = error as {
    code?: string;
    constraint?: string;
    table?: string;
    column?: string;
  };
  const safeIdentifiers = Object.fromEntries(
    Object.entries({
      code: diagnostic.code,
      constraint: diagnostic.constraint,
      table: diagnostic.table,
      column: diagnostic.column,
    }).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(entry[1]),
    ),
  );
  console.error(
    'Empty bootstrap rehearsal failed at: ' +
      stage +
      '. Target retained; no credentials/data logged.',
  );
  console.error(JSON.stringify(safeIdentifiers));
  process.exitCode = 1;
} finally {
  await runtimePool?.end();
  // The retained rehearsal target is owner-only after testing; normal API configuration never points here.
  if (targetPool)
    await sourcePool
      .query('REVOKE CONNECT ON DATABASE ' + targetName + ' FROM aio_runtime')
      .catch(() => {});
  await targetPool?.end();
  await sourcePool.end();
}
