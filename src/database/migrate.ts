import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';

export async function migrateDatabase(
  db: PoolClient,
  purpose: 'tlqm-aio-local' | 'tlqm-aio-test',
  directory = 'infrastructure/database',
) {
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(71092026)');
    const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if (tables.rowCount && !tables.rows.some((row) => row.tablename === 'schema_migrations'))
      throw new Error('Unidentified database: migration refused.');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await db.query<{ version: string; checksum: string }>(
      'SELECT version,checksum FROM schema_migrations ORDER BY version',
    );
    if (applied.rowCount) {
      const marker = await db.query('SELECT purpose FROM environment_marker');
      if (marker.rows[0]?.purpose !== purpose)
        throw new Error('Wrong database environment marker.');
    } else if (tables.rows.some((row) => row.tablename !== 'schema_migrations'))
      throw new Error('Nonempty unidentified database.');
    const files = (await readdir(directory)).filter((name) => /^\d{3}-.*\.sql$/.test(name)).sort();
    const versions = files.map((name) => name.slice(0, 3));
    if (
      new Set(versions).size !== versions.length ||
      applied.rows.some((row) => !versions.includes(row.version))
    )
      throw new Error('Migration registry does not match source.');
    for (const file of files) {
      const version = file.slice(0, 3);
      const sql = await readFile(directory + '/' + file, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.rows.find((row) => row.version === version);
      if (prior) {
        if (prior.checksum !== checksum)
          throw new Error('Migration checksum changed at ' + version + '. Add a new migration.');
        continue;
      }
      await db.query(sql);
      if (version === '001')
        await db.query('INSERT INTO environment_marker(purpose) VALUES ($1)', [purpose]);
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
