import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createConnection } from 'node:net';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { assertLocalDatabase, loadLocalConfig } from '../src/config.js';
import { localContainer } from './local-docker.js';
import { ids } from '../src/fixtures.js';

function assertRestoreTarget(url: string, name: string) {
  const value = new URL(url);
  if (
    !/^aio_foundation_restore_\d{8}_[0-9a-f]{8}$/.test(name) ||
    value.protocol !== 'postgresql:' ||
    value.hostname !== '127.0.0.1' ||
    value.port !== '5438' ||
    value.username !== 'aio_foundation' ||
    value.pathname !== '/' + name ||
    value.search
  )
    throw new Error('Invalid isolated restore target.');
}
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Unexpected local SQL identifier.');
  return '"' + value + '"';
};
async function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}
async function fingerprints(db: PoolClient) {
  const tables = (
    await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const result: Record<string, { rows: number; sha256: string }> = {};
  for (const { tablename } of tables) {
    const row = (
      await db.query(
        "SELECT count(*)::int AS rows,encode(sha256(convert_to(COALESCE(string_agg(row_text,chr(10) ORDER BY row_text),''),'UTF8')),'hex') AS sha256 FROM (SELECT to_jsonb(t)::text AS row_text FROM public." +
          identifier(tablename) +
          ' t) records',
      )
    ).rows[0];
    result[tablename] = row;
  }
  return result;
}
async function archiveCommand(
  containerId: string,
  program: 'pg_dump' | 'pg_restore',
  args: string[],
  file: string,
) {
  const current = await localContainer('foundation-db');
  if (!current.running || current.id !== containerId)
    throw new Error('PostgreSQL container ownership changed.');
  const child = spawn(
    'docker',
    [
      '--context',
      'desktop-linux',
      'exec',
      ...(program === 'pg_restore' ? ['-i'] : []),
      containerId,
      program,
      ...args,
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  // stderr may include database details, so consume it without logging or persisting.
  child.stderr.resume();
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Local archive process unavailable.')));
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Local archive operation failed.')),
    );
  });
  const streaming =
    program === 'pg_dump'
      ? pipeline(child.stdout, createWriteStream(file, { flags: 'wx', mode: 0o600 }))
      : pipeline(createReadStream(file), child.stdin);
  if (program === 'pg_dump') child.stdin.end();
  else child.stdout.resume();
  await Promise.all([streaming, exited]);
}
let stage = 'preflight';
let targetName = '';
const runtime = await loadLocalConfig();
assertLocalDatabase(runtime.databaseUrl);
if (new URL(runtime.databaseUrl).username !== 'aio_foundation')
  throw new Error('Backup rehearsal requires the isolated migration owner.');
const sourcePool = new pg.Pool({
  connectionString: runtime.databaseUrl,
  max: 2,
  connectionTimeoutMillis: 3000,
});
let targetPool: pg.Pool | undefined;
let source: PoolClient | undefined;
let target: PoolClient | undefined;
try {
  for (const client of runtime.clients)
    if (await portOpen(client.port))
      throw new Error('Stop API instances before the isolated restore rehearsal.');
  const container = await localContainer('foundation-db');
  assert.equal(container.running, true);
  const configBytes = await readFile('.local/runtime.json');
  const workspace = await realpath(process.cwd());
  const local = await realpath('.local');
  const localRelative = relative(workspace, local);
  if (localRelative.startsWith('..') || isAbsolute(localRelative))
    throw new Error('Local artifacts must stay inside this workspace.');
  await mkdir('.local/backups', { recursive: true });
  await mkdir('.local/evidence', { recursive: true });
  const backupDir = await realpath('.local/backups');
  if (relative(local, backupDir).startsWith('..'))
    throw new Error('Backup directory escapes local workspace.');
  const run = randomUUID().slice(0, 8);
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  targetName = 'aio_foundation_restore_' + date + '_' + run;
  const targetUrl = new URL(runtime.databaseUrl);
  targetUrl.pathname = '/' + targetName;
  assertRestoreTarget(targetUrl.href, targetName);
  const archive = resolve(backupDir, targetName + '.dump');
  source = await sourcePool.connect();
  await source.query("SET TIME ZONE 'UTC'");
  const actual = (
    await source.query(
      'SELECT current_database() AS database,current_user AS owner,(SELECT purpose FROM environment_marker) AS marker',
    )
  ).rows[0];
  assert.deepEqual(actual, {
    database: 'aio_foundation',
    owner: 'aio_foundation',
    marker: 'tlqm-aio-local',
  });
  assert.equal(
    (await source.query('SELECT 1 FROM pg_database WHERE datname=$1', [targetName])).rowCount,
    0,
  );
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot = (await source.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const before = await fingerprints(source);
  assert.ok((before.audit_events?.rows ?? 0) > 0);
  const migrations = (
    await source.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
  ).rows;
  const sequences = (
    await source.query(
      "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
    )
  ).rows;
  stage = 'consistent read-only backup';
  const backupStart = Date.now();
  await archiveCommand(
    container.id,
    'pg_dump',
    [
      '--username=aio_foundation',
      '--dbname=aio_foundation',
      '--no-password',
      '--format=custom',
      '--snapshot=' + snapshot,
    ],
    archive,
  );
  const backupMs = Date.now() - backupStart;
  const sourceUnchanged = await fingerprints(source);
  assert.deepEqual(sourceUnchanged, before);
  await source.query('COMMIT');
  stage = 'create isolated restore database';
  await source.query(
    'CREATE DATABASE ' + identifier(targetName) + ' WITH TEMPLATE template0 OWNER aio_foundation',
  );
  await source.query('REVOKE ALL ON DATABASE ' + identifier(targetName) + ' FROM PUBLIC');
  targetPool = new pg.Pool({
    connectionString: targetUrl.href,
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  target = await targetPool.connect();
  assert.equal((await target.query('SELECT current_database() AS name')).rows[0].name, targetName);
  assert.equal(
    (await target.query("SELECT 1 FROM pg_tables WHERE schemaname='public'")).rowCount,
    0,
  );
  await writeFile(
    '.local/backups/' + targetName + '.receipt.json',
    JSON.stringify({
      instanceId: runtime.instanceId,
      sourceDatabase: 'aio_foundation',
      targetDatabase: targetName,
      container: container.name,
      archive,
      createdAt: new Date().toISOString(),
    }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  stage = 'restore into the new target only';
  const restoreStart = Date.now();
  await archiveCommand(
    container.id,
    'pg_restore',
    [
      '--username=aio_foundation',
      '--dbname=' + targetName,
      '--no-password',
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
    ],
    archive,
  );
  const restoreMs = Date.now() - restoreStart;
  await target.query("SET TIME ZONE 'UTC'");
  stage = 'ownership, schema, data and audit verification';
  assert.deepEqual(await fingerprints(target), before);
  assert.deepEqual(
    (await target.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows,
    migrations,
  );
  assert.deepEqual(
    (
      await target.query(
        "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
      )
    ).rows,
    sequences,
  );
  const owners = (
    await target.query(
      "SELECT tableowner FROM pg_tables WHERE schemaname='public' UNION SELECT sequenceowner FROM pg_sequences WHERE schemaname='public'",
    )
  ).rows;
  assert.ok(owners.length > 0 && owners.every((row) => row.tableowner === 'aio_foundation'));
  assert.equal(
    (
      await source.query("SELECT has_database_privilege('aio_runtime',$1,'CONNECT') AS allowed", [
        targetName,
      ])
    ).rows[0].allowed,
    false,
  );
  await target.query('CREATE SCHEMA aio_restore_guard AUTHORIZATION aio_foundation');
  await target.query('REVOKE ALL ON SCHEMA aio_restore_guard FROM PUBLIC,aio_runtime');
  await target.query(
    'CREATE TABLE aio_restore_guard.environment(instance_id uuid NOT NULL,source_database text NOT NULL,target_database text NOT NULL,restored_at timestamptz NOT NULL DEFAULT now())',
  );
  await target.query(
    'INSERT INTO aio_restore_guard.environment(instance_id,source_database,target_database) VALUES ($1,$2,$3)',
    [runtime.instanceId, 'aio_foundation', targetName],
  );
  stage = 'restore smoke transaction and audit protections';
  await target.query('BEGIN');
  await target.query('INSERT INTO job_titles(id,tenant_id,code,name) VALUES ($1,$2,$3,$4)', [
    randomUUID(),
    ids.tenantA,
    'RESTORE-' + run,
    'Synthetic restore smoke',
  ]);
  await target.query('ROLLBACK');
  const auditId = (await target.query('SELECT min(id) AS id FROM audit_events')).rows[0].id;
  await assert.rejects(
    () => target!.query('UPDATE audit_events SET reason=reason WHERE id=$1', [auditId]),
    { code: '42501' },
  );
  assert.deepEqual(await fingerprints(target), before);
  assert.deepEqual(await fingerprints(source), before);
  assert.ok((await readFile('.local/runtime.json')).equals(configBytes));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const report = {
    checkedAt: new Date().toISOString(),
    result: 'pass',
    sourceDatabase: 'aio_foundation',
    targetDatabase: targetName,
    markerSchema: 'aio_restore_guard',
    owner: 'aio_foundation',
    runtimeCannotConnect: true,
    sourceUnchanged: true,
    configurationUnchanged: true,
    backupBytes: (await stat(archive)).size,
    backupSha256: hash.digest('hex'),
    backupMs,
    restoreMs,
    tables: before,
    migrations,
    sequenceStatePreserved: true,
    smokeRollbackPassed: true,
    auditAppendOnlyPassed: true,
  };
  await writeFile('.local/evidence/restore.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    'PASS: consistent synthetic backup restored into ' +
      targetName +
      '; source unchanged, ownership/data/audit verified.',
  );
} catch {
  console.error(
    'Isolated restore rehearsal failed at: ' +
      stage +
      '. No dump, credential or data values logged. New targets are retained for review.',
  );
  process.exitCode = 1;
} finally {
  if (source) {
    await source.query('ROLLBACK').catch(() => {});
    source.release();
  }
  target?.release();
  await targetPool?.end();
  await sourcePool.end();
}
