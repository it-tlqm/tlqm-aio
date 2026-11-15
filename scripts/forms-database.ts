import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { grantModuleRuntime } from '../src/database/module-grants.js';
import { loadLocalConfig, assertLocalDatabase } from '../src/config.js';
import { formsDatabaseUrl, loadFormsConfig, migrateForms } from '../src/forms/database.js';
import { localContainer } from './local-docker.js';
import type { FormsConfig } from '../src/forms/database.js';

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
  let config: FormsConfig;
  const roles = ['aio_forms_owner', 'aio_forms_runtime'];
  const databases = ['aio_forms', 'aio_forms_test'];
  try {
    config = await loadFormsConfig(runtime.instanceId);
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
    await writeFile('.local/forms.json', JSON.stringify(config, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const before = await readFile('.local/forms.json');
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
        [role, 'tlqm-aio-forms:' + runtime.instanceId],
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
      marker: 'tlqm-aio-forms:' + runtime.instanceId,
    });
  }
  for (const test of [false, true]) {
    const name = test ? 'aio_forms_test' : 'aio_forms';
    stage = 'provision isolated database';
    const prior = await cluster.query(
      "SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
      [name],
    );
    if (!prior.rowCount) {
      await cluster.query(
        'CREATE DATABASE ' + name + ' WITH TEMPLATE template0 OWNER aio_forms_owner',
      );
      const comment = await cluster.query(
        "SELECT format('COMMENT ON DATABASE %I IS %L',$1::text,$2::text) AS sql",
        [name, 'tlqm-aio-forms:' + runtime.instanceId],
      );
      await cluster.query(comment.rows[0].sql);
    } else {
      assert.deepEqual(prior.rows[0], {
        owner: 'aio_forms_owner',
        marker: 'tlqm-aio-forms:' + runtime.instanceId,
      });
    }
    await cluster.query('REVOKE ALL ON DATABASE ' + name + ' FROM PUBLIC');
    await cluster.query('GRANT CONNECT ON DATABASE ' + name + ' TO aio_forms_runtime');
    const owner = new pg.Pool({ connectionString: formsDatabaseUrl(config, test, true), max: 1 });
    pools.push(owner);
    const db = await owner.connect();
    try {
      stage = 'migrate Forms';
      const versions = await migrateForms(db, runtime.instanceId, test);
      await grantModuleRuntime(db, 'forms');
      console.log(
        (test ? 'Test' : 'Local') +
          ' Forms database ready: migrations ' +
          versions.join(',') +
          '; runtime role aio_forms_runtime.',
      );
    } finally {
      db.release();
    }
  }
  stage = 'verify isolation and credential preservation';
  for (const role of roles) {
    const denied = await cluster.query(
      "SELECT has_database_privilege($1,'aio_foundation','CONNECT') OR has_database_privilege($1,'aio_foundation_test','CONNECT') AS access",
      [role],
    );
    assert.equal(denied.rows[0].access, false);
  }
  for (const name of databases)
    assert.equal(
      (
        await cluster.query("SELECT has_database_privilege('aio_runtime',$1,'CONNECT') AS access", [
          name,
        ])
      ).rows[0].access,
      false,
    );
  assert.ok((await readFile('.local/forms.json')).equals(before));
  console.log(
    'PASS: Forms uses separate owner/runtime credentials and databases; Identity DB access denied, credentials preserved.',
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    'Forms setup failed at: ' +
      stage +
      (code && /^[A-Z0-9_]{1,40}$/.test(code) ? ' (' + code + ')' : '') +
      '. No credentials or database payloads logged.',
  );
  process.exitCode = 1;
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
}
