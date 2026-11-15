import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

type Docker = (args: string[]) => Promise<string>;
const owner = 'aio_stage_owner';
export const restoreOperator = 'aio_stage_restore_operator';
const databaseName = /^aio_[a-z_]+$/;

async function fingerprint(directory: string, name: string) {
  const path = join(directory, name);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const { size } = await stat(path);
  assert.ok(size > 0);
  return { name, bytes: size, sha256: hash.digest('hex') };
}

async function databaseState(pool: Pool, database: string) {
  const sql = await pool.query<{ schema: string; name: string; tableOwner: string }>(
    `SELECT schemaname AS schema,tablename AS name,tableowner AS "tableOwner"
     FROM pg_tables WHERE schemaname IN ('public','audit_projection','personnel_sync')
     ORDER BY schemaname,tablename`,
  );
  const rows = [];
  for (const table of sql.rows) {
    const quoted = [table.schema, table.name]
      .map((part) => '"' + part.replaceAll('"', '""') + '"')
      .join('.');
    const {
      rows: [state],
    } = await pool.query(
      `SELECT count(*)::integer AS count,encode(sha256(convert_to(COALESCE(string_agg(body,chr(10) ORDER BY body COLLATE "C"),''),'UTF8')),'hex') AS digest
       FROM (SELECT to_jsonb(record)::text AS body FROM ${quoted} record) data`,
    );
    rows.push({ ...table, ...state });
  }
  assert.ok(rows.length > 0, database);
  return rows;
}

export async function checkpointStagingPostgres(
  docker: Docker,
  container: string,
  directory: string,
  pools: ReadonlyMap<string, Pool>,
) {
  const catalogue = await Promise.all(
    [...pools].map(async ([database, pool]) => ({
      database,
      rows: await databaseState(pool, database),
    })),
  );
  await docker([
    'exec',
    container,
    'pg_dumpall',
    '-U',
    owner,
    '--roles-only',
    '-f',
    '/checkpoint/roles.sql',
  ]);
  const files = [await fingerprint(directory, 'roles.sql')];
  for (const database of pools.keys()) {
    assert.match(database, databaseName);
    const name = database + '.dump';
    await docker([
      'exec',
      container,
      'pg_dump',
      '-U',
      owner,
      '-Fc',
      '-f',
      '/checkpoint/' + name,
      database,
    ]);
    files.push(await fingerprint(directory, name));
  }
  return { catalogue, files };
}

export async function restoreStagingPostgres(
  docker: Docker,
  container: string,
  directory: string,
  checkpoint: Awaited<ReturnType<typeof checkpointStagingPostgres>>,
  pools: ReadonlyMap<string, Pool>,
) {
  for (const file of checkpoint.files)
    assert.deepEqual(await fingerprint(directory, file.name), file);
  await docker([
    'exec',
    container,
    'psql',
    '-U',
    restoreOperator,
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '--single-transaction',
    '-f',
    '/checkpoint/roles.sql',
  ]);
  for (const { database } of checkpoint.catalogue) {
    assert.match(database, databaseName);
    await docker([
      'exec',
      container,
      'pg_restore',
      '-U',
      restoreOperator,
      '-d',
      'postgres',
      '--create',
      '--exit-on-error',
      '/checkpoint/' + database + '.dump',
    ]);
    assert.ok(pools.has(database));
  }
  for (const { database, rows } of checkpoint.catalogue)
    assert.deepEqual(await databaseState(pools.get(database)!, database), rows);
  return {
    databases: checkpoint.catalogue.map(({ database, rows }) => ({
      database,
      tables: rows.length,
    })),
    archives: checkpoint.files,
  };
}
