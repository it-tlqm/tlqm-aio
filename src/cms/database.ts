import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';

export type CmsConfig = {
  instanceId: string;
  ownerPassword: string;
  runtimePassword: string;
};

export function assertCmsDatabase(url: string, test: boolean, owner = false) {
  const value = new URL(url);
  if (
    value.protocol !== 'postgresql:' ||
    value.hostname !== '127.0.0.1' ||
    value.port !== '5438' ||
    value.username !== (owner ? 'aio_cms_owner' : 'aio_cms_runtime') ||
    value.pathname !== (test ? '/aio_cms_test' : '/aio_cms') ||
    value.search ||
    value.hash ||
    !/^[0-9a-f]{64}$/.test(value.password)
  )
    throw new Error('Only the isolated CMS database and matching role are allowed.');
}

export function cmsDatabaseUrl(config: CmsConfig, test: boolean, owner = false) {
  const url = new URL('postgresql://127.0.0.1:5438/' + (test ? 'aio_cms_test' : 'aio_cms'));
  url.username = owner ? 'aio_cms_owner' : 'aio_cms_runtime';
  url.password = owner ? config.ownerPassword : config.runtimePassword;
  assertCmsDatabase(url.href, test, owner);
  return url.href;
}

export async function loadCmsConfig(instanceId: string) {
  const config = JSON.parse(await readFile('.local/cms.json', 'utf8')) as CmsConfig;
  if (config.instanceId !== instanceId)
    throw new Error('CMS configuration belongs to another instance.');
  cmsDatabaseUrl(config, false);
  cmsDatabaseUrl(config, true, true);
  return config;
}

export async function migrateCms(db: PoolClient, instanceId: string, test: boolean) {
  const expectedDatabase = test ? 'aio_cms_test' : 'aio_cms';
  const purpose = test ? 'tlqm-aio-cms-test' : 'tlqm-aio-cms-local';
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(71092035)');
    const identity = (await db.query('SELECT current_database() AS database,current_user AS role'))
      .rows[0];
    if (identity.database !== expectedDatabase || identity.role !== 'aio_cms_owner')
      throw new Error('Wrong CMS migration target/owner.');
    const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'"))
      .rows as { tablename: string }[];
    if (!tables.length) {
      await db.query(
        'CREATE TABLE environment_marker(instance_id uuid NOT NULL,purpose text NOT NULL)',
      );
      await db.query('INSERT INTO environment_marker VALUES ($1,$2)', [instanceId, purpose]);
      await db.query(
        'CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
    } else if (
      !['environment_marker', 'schema_migrations'].every((name) =>
        tables.some((table) => table.tablename === name),
      )
    ) {
      throw new Error('Unidentified nonempty CMS database.');
    }
    const marker = await db.query('SELECT instance_id,purpose FROM environment_marker');
    if (
      marker.rowCount !== 1 ||
      marker.rows[0].instance_id !== instanceId ||
      marker.rows[0].purpose !== purpose
    )
      throw new Error('Wrong CMS environment marker.');
    const files = (await readdir('infrastructure/cms'))
      .filter((name) => /^\d{3}-.*\.sql$/.test(name))
      .sort();
    const applied = (await db.query('SELECT version,checksum FROM schema_migrations')).rows as {
      version: string;
      checksum: string;
    }[];
    for (const file of files) {
      const version = file.slice(0, 3);
      const sql = await readFile('infrastructure/cms/' + file, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.find((row) => row.version === version);
      if (prior) {
        if (prior.checksum !== checksum)
          throw new Error('CMS migration checksum changed: ' + version);
        continue;
      }
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)', [
        version,
        checksum,
      ]);
    }
    await db.query('COMMIT');
    return files.map((file) => file.slice(0, 3));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
