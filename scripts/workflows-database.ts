import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { grantModuleRuntime } from '../src/database/module-grants.js';
import { loadLocalConfig, assertLocalDatabase } from '../src/config.js';
import {
  workflowsDatabaseUrl,
  loadWorkflowsConfig,
  migrateWorkflows,
} from '../src/workflows/database.js';
import { localContainer } from './local-docker.js';
import type { WorkflowsConfig } from '../src/workflows/database.js';

let stage = 'preflight';
const pools: pg.Pool[] = [];
try {
  const runtime = await loadLocalConfig();
  assertLocalDatabase(runtime.databaseUrl);
  assert.equal(new URL(runtime.databaseUrl).username, 'aio_foundation');
  assert.equal((await localContainer('foundation-db')).running, true);
  const cluster = new pg.Pool({ connectionString: runtime.databaseUrl, max: 1 });
  pools.push(cluster);
  assert.equal(
    (await cluster.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-local',
  );
  let config: WorkflowsConfig;
  const roles = ['aio_workflows_owner', 'aio_workflows_runtime'];
  const databases = ['aio_workflows', 'aio_workflows_test'];
  try {
    config = await loadWorkflowsConfig(runtime.instanceId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    assert.equal(
      (await cluster.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1)', [roles])).rowCount,
      0,
    );
    assert.equal(
      (await cluster.query('SELECT 1 FROM pg_database WHERE datname=ANY($1)', [databases]))
        .rowCount,
      0,
    );
    config = {
      instanceId: runtime.instanceId,
      ownerPassword: randomBytes(32).toString('hex'),
      runtimePassword: randomBytes(32).toString('hex'),
    };
    await writeFile('.local/workflows.json', JSON.stringify(config, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const before = await readFile('.local/workflows.json');
  for (const [index, role] of roles.entries()) {
    stage = 'provision isolated role';
    const prior = await cluster.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!prior.rowCount) {
      const password = index === 0 ? config.ownerPassword : config.runtimePassword;
      const statement = await cluster.query(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',$1::text,$2::text) AS sql",
        [role, password],
      );
      await cluster.query(statement.rows[0].sql);
      const comment = await cluster.query(
        "SELECT format('COMMENT ON ROLE %I IS %L',$1::text,$2::text) AS sql",
        [role, 'tlqm-aio-workflows:' + runtime.instanceId],
      );
      await cluster.query(comment.rows[0].sql);
    }
    const actual = (
      await cluster.query(
        "SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
        [role],
      )
    ).rows[0];
    assert.deepEqual(actual, {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      marker: 'tlqm-aio-workflows:' + runtime.instanceId,
    });
  }
  for (const test of [false, true]) {
    const name = test ? 'aio_workflows_test' : 'aio_workflows';
    stage = 'provision isolated database';
    const prior = await cluster.query(
      "SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
      [name],
    );
    if (!prior.rowCount) {
      await cluster.query(
        'CREATE DATABASE ' + name + ' WITH TEMPLATE template0 OWNER aio_workflows_owner',
      );
      const comment = await cluster.query(
        "SELECT format('COMMENT ON DATABASE %I IS %L',$1::text,$2::text) AS sql",
        [name, 'tlqm-aio-workflows:' + runtime.instanceId],
      );
      await cluster.query(comment.rows[0].sql);
    } else {
      assert.deepEqual(prior.rows[0], {
        owner: 'aio_workflows_owner',
        marker: 'tlqm-aio-workflows:' + runtime.instanceId,
      });
    }
    await cluster.query('REVOKE ALL ON DATABASE ' + name + ' FROM PUBLIC');
    await cluster.query('GRANT CONNECT ON DATABASE ' + name + ' TO aio_workflows_runtime');
    const owner = new pg.Pool({
      connectionString: workflowsDatabaseUrl(config, test, true),
      max: 1,
    });
    pools.push(owner);
    const db = await owner.connect();
    try {
      stage = 'migrate Workflows';
      const versions = await migrateWorkflows(db, runtime.instanceId, test);
      await grantModuleRuntime(db, 'workflows');
      console.log(
        (test ? 'Test' : 'Local') +
          ' Workflows database ready: migrations ' +
          versions.join(',') +
          '; runtime role aio_workflows_runtime.',
      );
    } finally {
      db.release();
    }
  }
  stage = 'verify isolation and credential preservation';
  for (const role of roles) {
    const denied = await cluster.query(
      "SELECT has_database_privilege($1,'aio_foundation','CONNECT') OR has_database_privilege($1,'aio_foundation_test','CONNECT') OR has_database_privilege($1,'aio_forms','CONNECT') OR has_database_privilege($1,'aio_forms_test','CONNECT') AS access",
      [role],
    );
    assert.equal(denied.rows[0].access, false);
  }
  for (const name of databases)
    assert.equal(
      (
        await cluster.query(
          "SELECT has_database_privilege('aio_runtime',$1,'CONNECT') OR has_database_privilege('aio_forms_runtime',$1,'CONNECT') AS access",
          [name],
        )
      ).rows[0].access,
      false,
    );
  assert.ok((await readFile('.local/workflows.json')).equals(before));
  console.log(
    'PASS: Workflows uses separate owner/runtime credentials and databases; Identity DB access denied, credentials preserved.',
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    'Workflows setup failed at: ' +
      stage +
      (code && /^[A-Z0-9_]{1,40}$/.test(code) ? ' (' + code + ')' : '') +
      '. No credentials or database payloads logged.',
  );
  process.exitCode = 1;
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
}
