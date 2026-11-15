import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { loadLocalConfig, assertLocalDatabase } from '../src/config.js';
import { cmsDatabaseUrl, loadCmsConfig, migrateCms } from '../src/cms/database.js';
import { localContainer } from './local-docker.js';

const pools: pg.Pool[] = [];
let stage = 'preflight';
try {
  const runtime = await loadLocalConfig();
  assertLocalDatabase(runtime.databaseUrl);
  assert.equal((await localContainer('foundation-db')).running, true);
  const cluster = new pg.Pool({ connectionString: runtime.databaseUrl, max: 1 });
  pools.push(cluster);
  assert.equal(
    (await cluster.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-local',
  );
  let config;
  try {
    config = await loadCmsConfig(runtime.instanceId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    config = {
      instanceId: runtime.instanceId,
      ownerPassword: randomBytes(32).toString('hex'),
      runtimePassword: randomBytes(32).toString('hex'),
    };
    await writeFile('.local/cms.json', JSON.stringify(config, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const roles = ['aio_cms_owner', 'aio_cms_runtime'];
  const databases = ['aio_cms', 'aio_cms_test'];
  for (const [index, role] of roles.entries()) {
    stage = 'provision role';
    const exists = await cluster.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!exists.rowCount) {
      const password = index === 0 ? config.ownerPassword : config.runtimePassword;
      const statement = await cluster.query(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',$1::text,$2::text) AS sql",
        [role, password],
      );
      await cluster.query(statement.rows[0].sql);
      const marker = await cluster.query(
        "SELECT format('COMMENT ON ROLE %I IS %L',$1::text,$2::text) AS sql",
        [role, 'tlqm-aio-cms:' + runtime.instanceId],
      );
      await cluster.query(marker.rows[0].sql);
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
      marker: 'tlqm-aio-cms:' + runtime.instanceId,
    });
  }
  for (const test of [false, true]) {
    const name = test ? 'aio_cms_test' : 'aio_cms';
    stage = 'provision database';
    const prior = await cluster.query(
      "SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
      [name],
    );
    if (!prior.rowCount) {
      await cluster.query(
        'CREATE DATABASE ' + name + ' WITH TEMPLATE template0 OWNER aio_cms_owner',
      );
      const marker = await cluster.query(
        "SELECT format('COMMENT ON DATABASE %I IS %L',$1::text,$2::text) AS sql",
        [name, 'tlqm-aio-cms:' + runtime.instanceId],
      );
      await cluster.query(marker.rows[0].sql);
    } else
      assert.deepEqual(prior.rows[0], {
        owner: 'aio_cms_owner',
        marker: 'tlqm-aio-cms:' + runtime.instanceId,
      });
    await cluster.query('REVOKE ALL ON DATABASE ' + name + ' FROM PUBLIC');
    await cluster.query('GRANT CONNECT ON DATABASE ' + name + ' TO aio_cms_runtime');
    const owner = new pg.Pool({ connectionString: cmsDatabaseUrl(config, test, true), max: 1 });
    pools.push(owner);
    const db = await owner.connect();
    try {
      stage = 'migrate CMS';
      const versions = await migrateCms(db, runtime.instanceId, test);
      await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await db.query('GRANT USAGE ON SCHEMA public TO aio_cms_runtime');
      await db.query(
        'GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO aio_cms_runtime',
      );
      await db.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO aio_cms_runtime');
      await db.query(
        'REVOKE INSERT,UPDATE ON schema_migrations,environment_marker FROM aio_cms_runtime',
      );
      await db.query(
        'REVOKE UPDATE ON cms_page_revisions,cms_content_revisions,cms_audit FROM aio_cms_runtime',
      );
      console.log(
        (test ? 'Test' : 'Local') +
          ' CMS database ready: migrations ' +
          versions.join(',') +
          '; runtime role aio_cms_runtime.',
      );
    } finally {
      db.release();
    }
  }
  for (const role of roles) {
    assert.equal(
      (
        await cluster.query(
          "SELECT has_database_privilege($1,'aio_foundation','CONNECT') OR has_database_privilege($1,'aio_foundation_test','CONNECT') AS access",
          [role],
        )
      ).rows[0].access,
      false,
    );
  }
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    'CMS setup failed at: ' +
      stage +
      (code && /^[A-Z0-9_]{1,40}$/.test(code) ? ' (' + code + ')' : '') +
      '. No credentials or database payloads logged.',
  );
  process.exitCode = 1;
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
}
