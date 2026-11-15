import { copyFile, readFile, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { assertLocalDatabase, loadLocalConfig } from '../src/config.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { bootstrapFixtures } from '../src/database/bootstrap.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { verifyClientRegistration } from './client-contract.js';

const config = await loadLocalConfig();
const keycloak = await localKeycloakAdmin(config);
const verifiedClients = new Set<string>();
for (const client of config.clients) {
  if (client.kind !== undefined) {
    const candidates = (await (
      await keycloak('/clients?clientId=' + encodeURIComponent(client.clientId))
    ).json()) as { id: string; clientId: string }[];
    const candidate = candidates.find((value) => value.clientId === client.clientId);
    if (!candidate || candidates.length !== 1)
      throw new Error('Onboarded local client is missing or ambiguous.');
    const registration = (await (await keycloak('/clients/' + candidate.id)).json()) as Record<
      string,
      unknown
    >;
    verifyClientRegistration(client, config.instanceId, registration, true);
    // Explicitly disabled integrations may stay disabled during migrations/seed.
    continue;
  }
  const records = (await (
    await keycloak('/clients?clientId=' + encodeURIComponent(client.clientId))
  ).json()) as {
    clientId: string;
    enabled: boolean;
    publicClient: boolean;
    protocol: string;
    redirectUris: string[];
  }[];
  if (
    !records.some(
      (record) =>
        record.clientId === client.clientId &&
        record.enabled &&
        !record.publicClient &&
        record.protocol === 'openid-connect' &&
        record.redirectUris.includes(client.baseUrl + '/auth/callback'),
    )
  )
    throw new Error('Local client registration does not match the approved manifest.');
  verifiedClients.add(client.code);
}
assertLocalDatabase(config.databaseUrl);
if (new URL(config.databaseUrl).username !== 'aio_foundation')
  throw new Error('Provisioning requires the local migration owner.');
const owner = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
try {
  const marker = await owner.query("SELECT to_regclass('public.environment_marker') AS table_name");
  if (marker.rows[0]?.table_name) {
    const identity = await owner.query('SELECT purpose FROM environment_marker');
    if (identity.rows[0]?.purpose !== 'tlqm-aio-local')
      throw new Error('Unexpected source database marker.');
  }
  const existingRole = await owner.query(
    "SELECT rolname FROM pg_roles WHERE rolname='aio_runtime'",
  );
  if (existingRole.rowCount && !config.databaseRuntime)
    throw new Error('Unidentified runtime role already exists.');
  if (!config.databaseRuntime) {
    config.databaseRuntime = { username: 'aio_runtime', password: randomBytes(32).toString('hex') };
    try {
      await copyFile(
        '.local/runtime.json',
        '.local/runtime.before-foundation-mvp.json',
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await writeFile('.local/runtime.next.json', JSON.stringify(config, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename('.local/runtime.next.json', '.local/runtime.json');
  }
  if (!existingRole.rowCount) await owner.query('CREATE ROLE aio_runtime NOLOGIN');
  const alter = await owner.query<{ sql: string }>(
    "SELECT format('ALTER ROLE aio_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',$1::text) AS sql",
    [config.databaseRuntime.password],
  );
  await owner.query(alter.rows[0]!.sql);
  const exists = await owner.query("SELECT 1 FROM pg_database WHERE datname='aio_foundation_test'");
  if (!exists.rowCount) await owner.query('CREATE DATABASE aio_foundation_test');
} finally {
  await owner.end();
}

for (const test of [false, true]) {
  const url = new URL(config.databaseUrl);
  url.pathname = test ? '/aio_foundation_test' : '/aio_foundation';
  assertLocalDatabase(url.href, test);
  const pool = new pg.Pool({ connectionString: url.href, max: 1 });
  const db = await pool.connect();
  try {
    const versions = await migrateDatabase(db, test ? 'tlqm-aio-test' : 'tlqm-aio-local');
    await bootstrapFixtures(db, config, verifiedClients);
    await db.query('BEGIN');
    const database = test ? 'aio_foundation_test' : 'aio_foundation';
    await db.query('REVOKE ALL ON DATABASE ' + database + ' FROM PUBLIC');
    await db.query('GRANT CONNECT ON DATABASE ' + database + ' TO aio_runtime');
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.query('GRANT USAGE ON SCHEMA public TO aio_runtime');
    await db.query(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO aio_runtime',
    );
    await db.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO aio_runtime');
    await db.query(
      'REVOKE INSERT,UPDATE,DELETE ON schema_migrations,environment_marker,bootstrap_receipts FROM aio_runtime',
    );
    await db.query('REVOKE UPDATE,DELETE ON audit_events,mutation_receipts FROM aio_runtime');
    await db.query('COMMIT');
    console.log(
      (test ? 'Test' : 'Local') +
        ' database ready: migrations ' +
        versions.join(',') +
        '; API role is aio_runtime.',
    );
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
