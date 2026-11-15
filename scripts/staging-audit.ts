import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type { D1Database } from '../src/lms/types.js';
import {
  assertStagingConfig,
  stagingModuleDatabase,
  stagingTarget,
} from '../src/staging-config.js';
import type { StagingConfig } from '../src/staging-config.js';
import {
  stagingAuditTls,
  verifyStagingInfrastructureAudit,
} from './staging-infrastructure-audit.js';
import type { stagingIngressProbes, stagingWorkerdProbe } from './staging-infrastructure-audit.js';

const feeds = {
  foundation: {
    table: 'audit_events',
    app: 'app_code',
    unit: 'NULL::uuid',
    subject: 'subject_account_id',
  },
  forms: {
    table: 'form_audit',
    app: "'aio-forms'::text",
    unit: 'org_unit_id',
    subject: 'NULL::uuid',
  },
  workflows: {
    table: 'workflow_audit',
    app: "'aio-workflows'::text",
    unit: 'org_unit_id',
    subject: 'NULL::uuid',
  },
  tasks: {
    table: 'task_audit',
    app: "'aio-tasks'::text",
    unit: 'NULL::uuid',
    subject: 'NULL::uuid',
  },
} as const;
const correlation = '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
const uuidV4 = new RegExp(correlation);
const retentionDays = 90;
const pageSize = 200;
export type AuditSource = keyof typeof feeds | 'lms';
export type AuditEvidence = { source: AuditSource; requestId: string; action: string };

export function captureAudit(
  evidence: AuditEvidence[] | undefined,
  source: AuditSource,
  action: string,
) {
  return (requestId: string | null) => {
    if (!evidence) return;
    assert.ok(requestId && uuidV4.test(requestId), 'Missing server request ID for ' + source);
    evidence.push({ source, requestId, action });
  };
}
type AuditMetadata = {
  source_id: string;
  occurred_at: Date | string;
  app_code: string;
  tenant_id: string | null;
  org_unit_id: string | null;
  actor_account_id: string | null;
  subject_account_id: string | null;
  action: string;
  request_id: string | null;
};

export async function verifyStagingAudit(
  runtime: StagingConfig,
  foundationOwnerUrl: string,
  ca: string,
  artifact: string,
  lms: D1Database,
  expected: AuditEvidence[],
  infrastructure?: {
    ca: string;
    ingressUrl: string;
    probes: Awaited<ReturnType<typeof stagingIngressProbes>>;
    workerdUrl: string;
    workerd: Record<'denied' | 'unavailable', Awaited<ReturnType<typeof stagingWorkerdProbe>>>;
  },
) {
  assertStagingConfig(runtime);
  assert.ok(runtime.moduleDatabases);
  const target = stagingTarget(runtime.slot);
  const ownerUrl = new URL(foundationOwnerUrl);
  assert.equal(ownerUrl.protocol, 'postgresql:');
  assert.ok(!ownerUrl.search && !ownerUrl.hash);
  assert.equal(ownerUrl.host, '127.0.0.1:' + target.dbPort);
  assert.equal(ownerUrl.pathname, '/' + target.database);
  assert.equal(ownerUrl.username, 'aio_stage_owner');
  const storage = 'aio_audit_stage_' + runtime.slot;
  const connections: pg.Client[] = [];
  const connect = async (database: string, credentials: { user: string; password: string }) => {
    const url = new URL(ownerUrl);
    url.pathname = '/' + database;
    url.username = credentials.user;
    url.password = credentials.password;
    const client = new pg.Client({
      connectionString: url.href,
      connectionTimeoutMillis: 3000,
      statement_timeout: 10000,
      ssl: stagingAuditTls(ca),
    });
    connections.push(client);
    await client.connect();
    return client;
  };
  const owner = { user: ownerUrl.username, password: ownerUrl.password };
  const roles = {
    collector: { user: 'aio_audit_collect', password: randomBytes(32).toString('hex') },
    reader: { user: 'aio_audit_read', password: randomBytes(32).toString('hex') },
    retention: { user: 'aio_audit_prune', password: randomBytes(32).toString('hex') },
  };
  try {
    const bootstrap = await connect(target.database, owner);
    assert.equal(
      (
        await bootstrap.query(
          'SELECT 1 FROM bootstrap_receipts WHERE name=$1 AND current_database()=$2 AND current_user=$3',
          ['enterprise-staging:' + runtime.instanceId, target.database, owner.user],
        )
      ).rowCount,
      1,
    );
    for (const role of Object.values(roles))
      await bootstrap.query(
        'CREATE ROLE ' +
          role.user +
          ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ' +
          bootstrap.escapeLiteral(role.password),
      );
    if (!infrastructure) {
      await bootstrap.query('CREATE DATABASE ' + storage + ' OWNER ' + owner.user);
      await bootstrap.query('REVOKE ALL ON DATABASE ' + storage + ' FROM PUBLIC');
    }
    await bootstrap.query(
      'GRANT CONNECT ON DATABASE ' +
        storage +
        ' TO ' +
        Object.values(roles)
          .map((role) => role.user)
          .join(','),
    );
    for (const name of ['aio_runtime', ...stagingRoleNames(runtime)])
      assert.equal(
        (
          await bootstrap.query("SELECT has_database_privilege($1,$2,'CONNECT') AS granted", [
            name,
            storage,
          ])
        ).rows[0]?.granted,
        false,
      );
    const sinkOwner = await connect(storage, owner);
    if (!infrastructure) {
      await sinkOwner.query(
        await readFile(join(artifact, 'infrastructure/audit/001-staging-audit.sql'), 'utf8'),
      );
      await sinkOwner.query(
        "INSERT INTO audit_projection.environment_marker VALUES (true,$1,'tlqm-aio-audit-staging')",
        [runtime.instanceId],
      );
    }
    await sinkOwner.query(
      'GRANT USAGE ON SCHEMA audit_projection TO aio_audit_collect,aio_audit_read,aio_audit_prune; ' +
        'GRANT SELECT ON audit_projection.environment_marker TO aio_audit_collect,aio_audit_read; ' +
        'GRANT INSERT ON audit_projection.events TO aio_audit_collect; ' +
        'GRANT SELECT ON audit_projection.events TO aio_audit_read; ' +
        'GRANT EXECUTE ON FUNCTION audit_projection.prune_expired() TO aio_audit_prune',
    );
    if (infrastructure)
      await sinkOwner.query(`
      GRANT INSERT ON audit_projection.infrastructure_events TO aio_audit_collect;
      GRANT SELECT ON audit_projection.infrastructure_events TO aio_audit_read;
      GRANT EXECUTE ON FUNCTION audit_projection.prune_infrastructure_expired() TO aio_audit_prune;
    `);
    const writer = await connect(storage, roles.collector);
    const reader = await connect(storage, roles.reader);
    const pruner = await connect(storage, roles.retention);
    const marker = await writer.query(
      'SELECT instance_id,purpose,current_database() AS database FROM audit_projection.environment_marker',
    );
    assert.deepEqual(marker.rows, [
      { instance_id: runtime.instanceId, purpose: 'tlqm-aio-audit-staging', database: storage },
    ]);
    await assert.rejects(writer.query('SELECT * FROM audit_projection.events LIMIT 0'), {
      code: '42501',
    });
    await assert.rejects(
      writer.query('UPDATE audit_projection.events SET action=action WHERE false'),
      { code: '42501' },
    );
    await assert.rejects(reader.query('DELETE FROM audit_projection.events WHERE false'), {
      code: '42501',
    });
    await assert.rejects(reader.query('SELECT audit_projection.prune_expired()'), {
      code: '42501',
    });
    await assert.rejects(pruner.query('SELECT * FROM audit_projection.events LIMIT 0'), {
      code: '42501',
    });

    const sources = new Map<keyof typeof feeds, pg.Client>();
    for (const name of Object.keys(feeds) as (keyof typeof feeds)[]) {
      const feed = feeds[name];
      const database =
        name === 'foundation' ? target.database : stagingModuleDatabase(runtime.slot, name).name;
      const admin = name === 'foundation' ? bootstrap : await connect(database, owner);
      assert.equal(
        (await admin.query('SELECT current_database() AS name')).rows[0]?.name,
        database,
      );
      if (name !== 'foundation')
        assert.equal(
          (
            await admin.query(
              'SELECT 1 FROM environment_marker WHERE instance_id=$1 AND purpose=$2',
              [runtime.instanceId, stagingModuleDatabase(runtime.slot, name).purpose],
            )
          ).rowCount,
          1,
        );
      await admin.query('CREATE SCHEMA audit_projection_source');
      await admin.query(`CREATE VIEW audit_projection_source.events WITH (security_barrier = true) AS
        SELECT id AS source_id, occurred_at, ${feed.app} AS app_code, tenant_id, ${feed.unit} AS org_unit_id,
          actor_account_id, ${feed.subject} AS subject_account_id, action,
          CASE WHEN request_id ~ '${correlation}' THEN request_id::uuid END AS request_id
        FROM public.${feed.table}`);
      await admin.query(
        'GRANT CONNECT ON DATABASE ' +
          database +
          ' TO aio_audit_collect; ' +
          'GRANT USAGE ON SCHEMA audit_projection_source TO aio_audit_collect; ' +
          'GRANT SELECT ON audit_projection_source.events TO aio_audit_collect',
      );
      const source = await connect(database, roles.collector);
      await assert.rejects(
        source.query('SELECT reason,details FROM public.' + feed.table + ' LIMIT 0'),
        { code: '42501' },
      );
      sources.set(name, source);
    }
    assert.deepEqual(
      (await lms.prepare('SELECT instance_id,purpose FROM environment_marker').all()).results,
      [{ instance_id: runtime.instanceId, purpose: 'tlqm-aio-lms-staging' }],
    );

    const insert = async (source: AuditSource, rows: AuditMetadata[]) =>
      (
        await writer.query(
          `INSERT INTO audit_projection.events
        SELECT $1, source_id, occurred_at, app_code, tenant_id, org_unit_id, actor_account_id, subject_account_id, action, request_id
        FROM jsonb_to_recordset($2::jsonb) AS j(source_id bigint, occurred_at timestamptz, app_code text,
          tenant_id uuid, org_unit_id uuid, actor_account_id uuid, subject_account_id uuid, action text, request_id uuid)
        ON CONFLICT DO NOTHING`,
          [source, JSON.stringify(rows)],
        )
      ).rowCount ?? 0;
    const collect = async () => {
      const counts: Partial<Record<AuditSource, number>> = {};
      const cutoff = Date.now() - retentionDays * 86400000;
      for (const [name, source] of sources) {
        let cursor = '0';
        counts[name] = 0;
        for (;;) {
          const { rows } = await source.query<AuditMetadata>(
            'SELECT * FROM audit_projection_source.events WHERE source_id>$1 AND occurred_at >= $2 ORDER BY source_id LIMIT $3',
            [cursor, new Date(cutoff), pageSize],
          );
          if (!rows.length) break;
          counts[name] += await insert(name, rows);
          cursor = rows.at(-1)!.source_id;
        }
      }
      let cursor = 0;
      counts.lms = 0;
      for (;;) {
        const { results } = await lms
          .prepare(
            `SELECT id AS source_id,occurred_at,'aio-lms-sandbox' AS app_code,tenant_id,NULL AS org_unit_id,
            actor_account_id,subject_account_id,action,request_id FROM aio_audit
            WHERE id>? AND occurred_at>=? ORDER BY id LIMIT ?`,
          )
          .bind(cursor, cutoff, pageSize)
          .all<
            Omit<AuditMetadata, 'source_id' | 'occurred_at'> & {
              source_id: number;
              occurred_at: number;
            }
          >();
        if (!results.length) break;
        counts.lms += await insert(
          'lms',
          results.map((row) => ({
            ...row,
            source_id: String(row.source_id),
            occurred_at: new Date(row.occurred_at),
            request_id: row.request_id && uuidV4.test(row.request_id) ? row.request_id : null,
          })),
        );
        cursor = results.at(-1)!.source_id;
      }
      return counts;
    };
    const inserted = await collect();
    assert.equal(Object.keys(inserted).length, 5);
    assert.ok(Object.values(inserted).every((count) => count > 0));
    assert.ok(Object.values(await collect()).every((count) => count === 0));
    assert.equal(new Set(expected.map((item) => item.source)).size, 5);
    for (const { source, requestId, action } of expected) {
      assert.match(requestId, uuidV4);
      assert.equal(
        (
          await reader.query(
            'SELECT 1 FROM audit_projection.events WHERE source=$1 AND request_id=$2 AND action=$3',
            [source, requestId, action],
          )
        ).rowCount,
        1,
      );
    }
    assert.equal(
      (
        await writer.query(
          "INSERT INTO audit_projection.events(source,source_id,occurred_at,app_code,action) VALUES ('foundation',9223372036854775807,now()-interval '2184 hours','aio-foundation','retention.fixture')",
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (await pruner.query('SELECT audit_projection.prune_expired() AS removed')).rows[0]?.removed,
      '1',
    );
    assert.equal(
      (await pruner.query('SELECT audit_projection.prune_expired() AS removed')).rows[0]?.removed,
      '0',
    );
    const count = (await reader.query('SELECT count(*) AS n FROM audit_projection.events')).rows[0]
      ?.n;
    assert.equal(
      Number(count),
      Object.values(inserted).reduce((sum, value) => sum + value, 0),
    );
    const emergencyLogin = expected.find(
      ({ source, action }) => source === 'foundation' && action === 'auth.login',
    );
    if (infrastructure) assert.ok(emergencyLogin);
    const infrastructureEvidence =
      infrastructure &&
      (await verifyStagingInfrastructureAudit(
        runtime,
        await connect('aio_stage_identity', owner),
        () => connect('aio_stage_identity', roles.collector),
        writer,
        reader,
        pruner,
        infrastructure.ingressUrl,
        infrastructure.ca,
        infrastructure.probes,
        emergencyLogin!.requestId,
        infrastructure.workerdUrl,
        infrastructure.workerd,
      ));
    return {
      inserted,
      matchedSources: [...new Set(expected.map((item) => item.source))],
      matchedEvents: expected.length,
      duplicateInserts: 0,
      retentionDays,
      expiredRowsRemoved: 1,
      separatedRoles: true,
      rawAuditFieldsExcluded: true,
      ...(infrastructureEvidence ? { infrastructure: infrastructureEvidence } : {}),
    };
  } finally {
    await Promise.all(connections.map((client) => client.end()));
  }
}

function stagingRoleNames(runtime: StagingConfig) {
  return (['forms', 'workflows', 'tasks'] as const).map(
    (name) => stagingModuleDatabase(runtime.slot, name).role,
  );
}
