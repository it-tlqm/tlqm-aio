import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { get } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';
import { stagingAuditDatabase, stagingRequestId } from '../src/staging-ingress-audit.js';
import { assertStagingConfig, stagingTarget } from '../src/staging-config.js';
import type { StagingConfig } from '../src/staging-config.js';

export const stagingAuditTls = (ca: string) => ({
  ca,
  rejectUnauthorized: true,
  minVersion: 'TLSv1.2' as const,
});

type HttpAuditProbe = { status: number; requestId: string; ignoredId: string };
type WorkerdProbes = { denied: HttpAuditProbe; unavailable: HttpAuditProbe };

export async function prepareStagingInfrastructureAudit(
  runtime: StagingConfig,
  owner: pg.Pool,
  ownerUrl: URL,
  artifact: string,
  ca: string,
) {
  assertStagingConfig(runtime);
  const database = stagingAuditDatabase(runtime.slot);
  const target = stagingTarget(runtime.slot);
  assert.equal(ownerUrl.host, '127.0.0.1:' + target.dbPort);
  assert.equal(ownerUrl.pathname, '/' + target.database);
  assert.equal(ownerUrl.username, 'aio_stage_owner');
  assert.equal(
    (
      await owner.query(
        'SELECT 1 FROM bootstrap_receipts WHERE name=$1 AND current_database()=$2 AND current_user=$3',
        ['enterprise-staging:' + runtime.instanceId, target.database, 'aio_stage_owner'],
      )
    ).rowCount,
    1,
  );
  const ingress = { user: 'aio_audit_ingress', password: randomBytes(32).toString('hex') };
  const workerd = { user: 'aio_audit_workerd', password: randomBytes(32).toString('hex') };
  for (const { user, password } of [ingress, workerd])
    await owner.query(
      `CREATE ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ` +
        pg.escapeLiteral(password),
    );
  await owner.query('CREATE DATABASE ' + database + ' OWNER aio_stage_owner');
  await owner.query('REVOKE ALL ON DATABASE ' + database + ' FROM PUBLIC');
  await owner.query(
    'GRANT CONNECT ON DATABASE ' + database + ' TO aio_audit_ingress,aio_audit_workerd',
  );
  const url = new URL(ownerUrl);
  url.pathname = '/' + database;
  const sink = new pg.Client({
    connectionString: url.href,
    ssl: stagingAuditTls(ca),
    connectionTimeoutMillis: 4000,
  });
  try {
    await sink.connect();
    for (const name of [
      '001-staging-audit.sql',
      '002-staging-infrastructure-audit.sql',
      '003-staging-workerd-audit.sql',
    ]) {
      await sink.query(await readFile(join(artifact, 'infrastructure/audit', name), 'utf8'));
    }
    await sink.query(
      "INSERT INTO audit_projection.environment_marker VALUES (true,$1,'tlqm-aio-audit-staging')",
      [runtime.instanceId],
    );
    await sink.query(`
      GRANT USAGE ON SCHEMA audit_projection TO aio_audit_ingress,aio_audit_workerd;
      GRANT SELECT ON audit_projection.environment_marker TO aio_audit_ingress,aio_audit_workerd;
      GRANT INSERT ON audit_projection.infrastructure_events TO aio_audit_ingress,aio_audit_workerd;
    `);
  } finally {
    await sink.end();
  }
  const writer = ({ user, password }: typeof ingress) => {
    const connection = new URL(url);
    connection.username = user;
    connection.password = password;
    return { databaseUrl: connection.href, instanceId: runtime.instanceId };
  };
  return { ingress: writer(ingress), workerd: writer(workerd) };
}

export async function stagingWorkerdProbe(base: string, ca: string, status: 401 | 503) {
  const ignoredId = randomUUID();
  const probe = await new Promise<{ status: number; requestId: string }>((resolve, reject) => {
    get(
      base + '/api/v1/me?fixture=' + ignoredId,
      {
        ca,
        rejectUnauthorized: true,
        headers: { 'x-request-id': ignoredId },
        signal: AbortSignal.timeout(5000),
      },
      (response) => {
        response.resume();
        resolve({
          status: response.statusCode ?? 0,
          requestId: String(response.headers['x-request-id'] ?? ''),
        });
      },
    ).on('error', reject);
  });
  assert.equal(probe.status, status);
  assert.match(probe.requestId, stagingRequestId);
  assert.notEqual(probe.requestId, ignoredId);
  return { ...probe, ignoredId };
}

export async function stagingIngressProbes(base: string, ca: string) {
  const endpoint = new URL(base);
  const spoofedId = randomUUID();
  const probe = (host?: string) =>
    new Promise<{ status: number; requestId: string }>((resolve, reject) => {
      const req = get(
        base + '/api/v1/me?fixture=' + spoofedId,
        {
          ca,
          rejectUnauthorized: true,
          checkServerIdentity: (_name, certificate) =>
            checkServerIdentity(endpoint.hostname, certificate),
          headers: { 'x-request-id': spoofedId, ...(host ? { host } : {}) },
          signal: AbortSignal.timeout(5000),
        },
        (response) => {
          response.resume();
          resolve({
            status: response.statusCode ?? 0,
            requestId: String(response.headers['x-request-id'] ?? ''),
          });
        },
      );
      req.on('error', reject);
    });
  const denied = await probe();
  const rejected = await probe('fixture.invalid');
  assert.equal(denied.status, 401);
  assert.equal(rejected.status, 400);
  for (const result of [denied, rejected]) {
    assert.ok(stagingRequestId.test(result.requestId) && result.requestId !== spoofedId);
  }
  assert.notEqual(denied.requestId, rejected.requestId);
  return { denied: denied.requestId, rejected: rejected.requestId, ignoredId: spoofedId };
}

export async function verifyStagingInfrastructureAudit(
  runtime: StagingConfig,
  sourceOwner: pg.Client,
  connectSource: () => Promise<pg.Client>,
  writer: pg.Client,
  reader: pg.Client,
  pruner: pg.Client,
  ingressUrl: string,
  ca: string,
  expected: Awaited<ReturnType<typeof stagingIngressProbes>>,
  loginRequestId: string,
  workerdUrl: string,
  workerd: WorkerdProbes,
) {
  assertStagingConfig(runtime);
  assert.equal(
    (await sourceOwner.query('SELECT current_database() AS name')).rows[0]?.name,
    'aio_stage_identity',
  );
  const realm = sourceOwner.escapeLiteral('aio-staging-' + runtime.slot);
  const apps = runtime.clients.map(({ code }) => sourceOwner.escapeLiteral(code)).join(',');
  const uuid = stagingRequestId.source;
  await sourceOwner.query(`
    CREATE SCHEMA audit_projection_source;
    CREATE VIEW audit_projection_source.keycloak_events WITH (security_barrier = true) AS
      SELECT 'keycloak-auth'::text AS source, e.id::uuid AS source_id,
        to_timestamp(e.event_time / 1000.0) AS occurred_at, e.client_id::text AS app_code,
        CASE e.type WHEN 'LOGIN' THEN 'login' ELSE 'login.failed' END AS action,
        CASE WHEN e.user_id ~ '${uuid}' THEN e.user_id::uuid END AS subject_ref
      FROM public.event_entity e JOIN public.realm r ON r.id=e.realm_id
      WHERE r.name=${realm} AND e.id ~ '${uuid}' AND e.type IN ('LOGIN','LOGIN_ERROR') AND e.client_id IN (${apps})
      UNION ALL
      SELECT 'keycloak-admin'::text, e.id::uuid, to_timestamp(e.admin_event_time / 1000.0),
        'aio-keycloak'::text,
        CASE
          WHEN e.resource_path LIKE 'components/%' AND e.operation_type='CREATE' THEN 'key.create'
          WHEN e.resource_path LIKE 'components/%' THEN 'key.update'
          WHEN e.operation_type='ACTION' THEN 'user.logout'
          ELSE 'user.update'
        END,
        CASE WHEN split_part(e.resource_path,'/',1)='users' AND split_part(e.resource_path,'/',2) ~ '${uuid}'
          THEN split_part(e.resource_path,'/',2)::uuid END
      FROM public.admin_event_entity e JOIN public.realm r ON r.id=e.realm_id
      WHERE r.name=${realm} AND e.id ~ '${uuid}' AND e.error IS NULL
        AND ((e.resource_path LIKE 'components/%' AND e.operation_type IN ('CREATE','UPDATE') AND EXISTS (
            SELECT FROM public.component c WHERE c.id=split_part(e.resource_path,'/',2)
              AND c.provider_type='org.keycloak.keys.KeyProvider'
          ))
          OR (e.resource_path LIKE 'users/%' AND e.operation_type='UPDATE')
          OR (e.resource_path LIKE 'users/%/logout' AND e.operation_type='ACTION'));
    GRANT CONNECT ON DATABASE aio_stage_identity TO aio_audit_collect;
    GRANT USAGE ON SCHEMA audit_projection_source TO aio_audit_collect;
    GRANT SELECT ON audit_projection_source.keycloak_events TO aio_audit_collect;
  `);
  const source = await connectSource();
  await assert.rejects(source.query('SELECT details_json FROM public.event_entity LIMIT 0'), {
    code: '42501',
  });
  await assert.rejects(
    source.query('SELECT representation FROM public.admin_event_entity LIMIT 0'),
    { code: '42501' },
  );
  await assert.rejects(
    source.query('UPDATE public.event_entity SET event_time=event_time WHERE false'),
    { code: '42501' },
  );
  const collect = async () => {
    let cursor: string | null = null;
    let count = 0;
    for (;;) {
      const { rows }: { rows: { source_id: string }[] } = await source.query<{ source_id: string }>(
        `SELECT * FROM audit_projection_source.keycloak_events
         WHERE occurred_at >= now() - interval '90 days' AND ($1::uuid IS NULL OR source_id>$1)
         ORDER BY source_id LIMIT 200`,
        [cursor],
      );
      if (!rows.length) return count;
      const inserted = await writer.query(
        `
        INSERT INTO audit_projection.infrastructure_events(source,source_id,occurred_at,app_code,action,subject_ref)
        SELECT source,source_id,occurred_at,app_code,action,subject_ref
        FROM jsonb_to_recordset($1::jsonb) AS j(source text,source_id uuid,occurred_at timestamptz,app_code text,action text,subject_ref uuid)
        ON CONFLICT DO NOTHING`,
        [JSON.stringify(rows)],
      );
      count += inserted.rowCount ?? 0;
      cursor = rows.at(-1)!.source_id;
    }
  };
  const keycloak = await collect();
  assert.equal(await collect(), 0);
  const groups = (
    await reader.query<{ source: string; action: string; count: number }>(
      'SELECT source,action,count(*)::int AS count FROM audit_projection.infrastructure_events GROUP BY source,action ORDER BY source,action',
    )
  ).rows;
  const actionCount = (source: string, action: string) =>
    groups.find((group) => group.source === source && group.action === action)?.count ?? 0;
  assert.ok(actionCount('keycloak-auth', 'login') > 0);
  assert.ok(actionCount('keycloak-auth', 'login.failed') > 0);
  for (const [action, count] of [
    ['key.create', 1],
    ['key.update', 2],
    ['user.update', 2],
    ['user.logout', 1],
  ] as const)
    assert.equal(actionCount('keycloak-admin', action), count);

  let matches = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    matches = (
      await reader.query<{ n: number }>(
        `
      SELECT count(*)::int AS n FROM audit_projection.infrastructure_events
      WHERE source='ingress' AND ((request_id=$1 AND action='http.denied' AND http_status=401)
        OR (request_id=$2 AND action='edge.rejected' AND http_status=400))`,
        [expected.denied, expected.rejected],
      )
    ).rows[0]!.n;
    if (matches === 2) break;
    await delay(100);
  }
  assert.equal(matches, 2);
  let workerEvents: { request_id: string; action: string; http_status: number; skew: number }[] =
    [];
  for (let attempt = 0; attempt < 30; attempt++) {
    workerEvents = (
      await reader.query<(typeof workerEvents)[number]>(
        `
      SELECT request_id,action,http_status,abs(extract(epoch FROM (received_at-occurred_at))*1000)::int AS skew
      FROM audit_projection.infrastructure_events WHERE source='workerd' AND app_code='aio-lms-sandbox'
        AND request_id=ANY($1::uuid[])`,
        [[workerd.denied.requestId, workerd.unavailable.requestId]],
      )
    ).rows;
    if (workerEvents.length === 2) break;
    await delay(100);
  }
  assert.equal(workerEvents.length, 2);
  for (const [expectedProbe, action] of [
    [workerd.denied, 'http.denied'],
    [workerd.unavailable, 'http.error'],
  ] as const) {
    const found = workerEvents.find(({ request_id }) => request_id === expectedProbe.requestId);
    assert.ok(
      found &&
        found.http_status === expectedProbe.status &&
        found.action === action &&
        found.skew <= 5000,
    );
  }
  assert.equal(
    (
      await reader.query(
        'SELECT 1 FROM audit_projection.infrastructure_events i,unnest($1::text[]) AS t(value) WHERE position(t.value in to_jsonb(i)::text)>0',
        [[expected.ignoredId, workerd.denied.ignoredId, workerd.unavailable.ignoredId]],
      )
    ).rowCount,
    0,
  );
  const callbacks = (
    await reader.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM audit_projection.infrastructure_events i
    JOIN audit_projection.events e ON e.request_id=i.request_id AND e.app_code=i.app_code
    WHERE i.source='ingress' AND i.action='auth.callback' AND e.source='foundation' AND e.action='auth.login'
  `)
  ).rows[0]!.n;
  assert.ok(callbacks > 0);
  assert.equal(
    (
      await reader.query(
        `
    SELECT 1 FROM audit_projection.infrastructure_events i
    JOIN audit_projection.events e ON e.request_id=i.request_id AND e.app_code=i.app_code
    WHERE i.source='ingress' AND i.action='auth.callback' AND e.source='foundation' AND e.action='auth.login'
      AND i.request_id=$1
  `,
        [loginRequestId],
      )
    ).rowCount,
    1,
  );
  const versions = await Promise.all(
    [source, writer, reader, pruner].map(async (client) => {
      const row = (
        await client.query<{ ssl: boolean; version: string }>(
          'SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
        )
      ).rows[0];
      assert.ok(row?.ssl && ['TLSv1.2', 'TLSv1.3'].includes(row.version));
      return row.version;
    }),
  );
  const failedConnection = async (ssl: false | { ca: never[]; rejectUnauthorized: true }) => {
    const client = new pg.Client({
      connectionString: ingressUrl,
      ssl,
      connectionTimeoutMillis: 3000,
    });
    try {
      await assert.rejects(client.connect(), (error: { code?: string }) =>
        ssl === false
          ? error.code === '28000'
          : ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code ?? ''),
      );
    } finally {
      await client.end();
    }
  };
  await failedConnection(false);
  await failedConnection({ ca: [], rejectUnauthorized: true });
  const ingress = new pg.Client({
    connectionString: ingressUrl,
    ssl: stagingAuditTls(ca),
    connectionTimeoutMillis: 3000,
  });
  try {
    await ingress.connect();
    await assert.rejects(
      ingress.query('SELECT * FROM audit_projection.infrastructure_events LIMIT 0'),
      { code: '42501' },
    );
    await assert.rejects(
      ingress.query(
        `
      INSERT INTO audit_projection.infrastructure_events(source,source_id,occurred_at,app_code,action)
      VALUES ('keycloak-auth',$1,now(),'aio-foundation','login')`,
        [randomUUID()],
      ),
      { code: '42501' },
    );
  } finally {
    await ingress.end();
  }
  const workerWriter = new pg.Client({
    connectionString: workerdUrl,
    ssl: stagingAuditTls(ca),
    connectionTimeoutMillis: 3000,
  });
  try {
    await workerWriter.connect();
    await assert.rejects(
      workerWriter.query('SELECT * FROM audit_projection.infrastructure_events LIMIT 0'),
      { code: '42501' },
    );
    await assert.rejects(
      workerWriter.query(
        `INSERT INTO audit_projection.infrastructure_events(source,source_id,occurred_at,app_code,action,http_status,request_id)
      VALUES ('ingress',$1,now(),'aio-lms-sandbox','http.denied',401,$2)`,
        [randomUUID(), randomUUID()],
      ),
      { code: '42501' },
    );
  } finally {
    await workerWriter.end();
  }
  await assert.rejects(reader.query('SELECT audit_projection.prune_infrastructure_expired()'), {
    code: '42501',
  });
  const retention = await writer.query(
    `
    INSERT INTO audit_projection.infrastructure_events(source,source_id,occurred_at,app_code,action)
    VALUES ('keycloak-auth',$1,now()-interval '2184 hours','aio-foundation','login')
  `,
    [randomUUID()],
  );
  assert.equal(retention.rowCount, 1);
  for (const count of ['1', '0'])
    assert.equal(
      (await pruner.query('SELECT audit_projection.prune_infrastructure_expired() AS n')).rows[0]
        ?.n,
      count,
    );
  return {
    groups,
    keycloak,
    duplicateKeycloakEvents: 0,
    ingressDenialsMatched: matches,
    correlatedCallbacks: callbacks,
    workerd: {
      matchedDenials: 1,
      matchedErrors: 1,
      maxReceiptClockDeltaMs: Math.max(...workerEvents.map(({ skew }) => skew)),
      requestIdsGeneratedAtSource: true,
      separateInsertOnlyRole: true,
    },
    transport: [...new Set(versions)],
    plaintextRefused: true,
    wrongCaRefused: true,
    expiredRowsRemoved: 1,
  };
}
