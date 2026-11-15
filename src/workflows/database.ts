import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { stagingModuleDatabase } from '../staging-config.js';
import type { StagingSlot } from '../staging-config.js';

export type WorkflowsConfig = {
  instanceId: string;
  ownerPassword: string;
  runtimePassword: string;
};
export function assertWorkflowsDatabase(url: string, test: boolean, owner = false) {
  const value = new URL(url);
  if (
    value.protocol !== 'postgresql:' ||
    value.hostname !== '127.0.0.1' ||
    value.port !== '5438' ||
    value.username !== (owner ? 'aio_workflows_owner' : 'aio_workflows_runtime') ||
    value.pathname !== (test ? '/aio_workflows_test' : '/aio_workflows') ||
    value.search ||
    value.hash ||
    !/^[0-9a-f]{64}$/.test(value.password)
  )
    throw new Error('Only the isolated Workflows database and matching role are allowed.');
}
export function workflowsDatabaseUrl(config: WorkflowsConfig, test: boolean, owner = false) {
  const role = owner ? 'aio_workflows_owner' : 'aio_workflows_runtime';
  const password = owner ? config.ownerPassword : config.runtimePassword;
  const url = new URL(
    'postgresql://127.0.0.1:5438/' + (test ? 'aio_workflows_test' : 'aio_workflows'),
  );
  url.username = role;
  url.password = password;
  assertWorkflowsDatabase(url.href, test, owner);
  return url.href;
}
export async function loadWorkflowsConfig(instanceId: string): Promise<WorkflowsConfig> {
  const config = JSON.parse(await readFile('.local/workflows.json', 'utf8')) as WorkflowsConfig;
  if (config.instanceId !== instanceId)
    throw new Error('Workflows configuration belongs to a different local instance.');
  workflowsDatabaseUrl(config, false);
  workflowsDatabaseUrl(config, true, true);
  return config;
}
export async function migrateWorkflows(
  db: PoolClient,
  instanceId: string,
  target: boolean | { slot: StagingSlot; directory: string },
) {
  const staging =
    typeof target === 'object' ? stagingModuleDatabase(target.slot, 'workflows') : null;
  const test = target === true;
  const expectedDatabase = staging?.name ?? (test ? 'aio_workflows_test' : 'aio_workflows');
  const purpose =
    staging?.purpose ?? (test ? 'tlqm-aio-workflows-test' : 'tlqm-aio-workflows-local');
  const directory = typeof target === 'object' ? target.directory : 'infrastructure/workflows';
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(71092029)');
    const identity = (await db.query('SELECT current_database() AS database,current_user AS role'))
      .rows[0];
    if (identity.database !== expectedDatabase || identity.role !== 'aio_workflows_owner')
      throw new Error('Wrong Workflows migration target/owner.');
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
      throw new Error('Unidentified nonempty Workflows database.');
    }
    const markers = await db.query('SELECT instance_id,purpose FROM environment_marker');
    if (
      markers.rowCount !== 1 ||
      markers.rows[0].instance_id !== instanceId ||
      markers.rows[0].purpose !== purpose
    )
      throw new Error('Wrong Workflows environment marker.');
    const files = (await readdir(directory)).filter((name) => /^\d{3}-.*\.sql$/.test(name)).sort();
    const versions = files.map((name) => name.slice(0, 3));
    const applied = (await db.query('SELECT version,checksum FROM schema_migrations')).rows as {
      version: string;
      checksum: string;
    }[];
    if (
      new Set(versions).size !== versions.length ||
      applied.some((row) => !versions.includes(row.version))
    )
      throw new Error('Workflows migration registry mismatch.');
    for (const file of files) {
      const version = file.slice(0, 3);
      const sql = await readFile(directory + '/' + file, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.find((row) => row.version === version);
      if (prior) {
        if (prior.checksum !== checksum)
          throw new Error('Workflows migration checksum changed: ' + version);
        continue;
      }
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)', [
        version,
        checksum,
      ]);
    }
    await db.query('COMMIT');
    return versions;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
