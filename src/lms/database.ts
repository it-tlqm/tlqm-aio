import assert from 'node:assert/strict';
import { hash } from './security.js';
import type { LmsConfig } from './security.js';
import { lmsMigrations } from './migrations.js';
import type { D1Database } from './types.js';

export async function migrateLms(db: D1Database, config: LmsConfig) {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<{ name: string }>()
  ).results;
  if (!tables.length)
    await db.batch([
      db.prepare(
        'CREATE TABLE environment_marker(id INTEGER PRIMARY KEY CHECK(id=1),instance_id TEXT NOT NULL,purpose TEXT NOT NULL)',
      ),
      db
        .prepare('INSERT INTO environment_marker VALUES (1,?,?)')
        .bind(config.instanceId, config.purpose),
      db.prepare(
        'CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)',
      ),
    ]);
  else if (
    !['environment_marker', 'schema_migrations'].every((name) =>
      tables.some((table) => table.name === name),
    )
  )
    throw new Error('Unidentified LMS D1 database; migration refused.');
  assert.deepEqual(
    (await db.prepare('SELECT instance_id,purpose FROM environment_marker').all()).results,
    [{ instance_id: config.instanceId, purpose: config.purpose }],
  );
  const applied = (
    await db
      .prepare('SELECT version,checksum FROM schema_migrations ORDER BY version')
      .all<{ version: string; checksum: string }>()
  ).results;
  if (applied.some((row) => !lmsMigrations.some((migration) => migration.version === row.version)))
    throw new Error('Unknown LMS migration registry entry.');
  for (const migration of lmsMigrations) {
    const checksum = await hash(JSON.stringify(migration.statements));
    const prior = applied.find((row) => row.version === migration.version);
    if (prior) {
      if (prior.checksum !== checksum)
        throw new Error('LMS migration checksum changed; add a new version.');
      continue;
    }
    await db.batch([
      ...migration.statements.map((sql) => db.prepare(sql)),
      db
        .prepare('INSERT INTO schema_migrations VALUES (?,?,?)')
        .bind(migration.version, checksum, Date.now()),
    ]);
  }
}
