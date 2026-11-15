import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { stagingAuditDatabase } from '../src/staging-ingress-audit.js';
import { stagingModuleDatabase, stagingTarget } from '../src/staging-config.js';
import { seedRecoveryFixtures, verifyRecoveryFixtures } from './enterprise-recovery-fixtures.js';
import {
  prepareLmsRecovery,
  restoreLmsRecovery,
  verifyLmsRollback,
} from './enterprise-recovery-lms.js';
import { probeReleaseComponents } from './enterprise-component-rollback.js';
import { copyLmsStorage } from './lms-backup-storage.js';
import { verifyTaskWork } from './enterprise-task-work.js';
import { verifyWorkflowOperations } from './enterprise-workflow-operations.js';
import { verifyFormsWork } from './enterprise-forms-work.js';
import {
  exportWorkflowPromotion,
  verifyWorkflowPromotion,
} from './enterprise-workflow-promotion.js';
import { grantModuleRuntime } from '../src/database/module-grants.js';
import { migrateTasks } from '../src/tasks/database.js';

const host = '127.0.0.1';
const slot = 'a';
const admin = 'aio_stage_owner';
const target = stagingTarget(slot);
const stores = {
  foundation: { name: target.database, owner: admin, roles: ['aio_runtime'], schema: 'public' },
  forms: {
    ...stagingModuleDatabase(slot, 'forms'),
    roles: ['aio_forms_runtime'],
    schema: 'public',
  },
  workflows: {
    ...stagingModuleDatabase(slot, 'workflows'),
    roles: ['aio_workflows_runtime'],
    schema: 'public',
  },
  tasks: {
    ...stagingModuleDatabase(slot, 'tasks'),
    roles: ['aio_tasks_runtime'],
    schema: 'public',
  },
  audit: {
    name: stagingAuditDatabase(slot),
    owner: admin,
    roles: ['aio_audit_ingress', 'aio_audit_collect', 'aio_audit_read'],
    schema: 'audit_projection',
  },
} as const;
const storeKeys = ['foundation', 'forms', 'workflows', 'tasks', 'audit'] as const;
type Store = (typeof storeKeys)[number];
type Cluster = {
  directory: string;
  name: string;
  port: number;
  password: string;
  started: boolean;
};
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const vietnam = (value: Date) => value.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

const [release, digest, postgresBin, profile, ...extra] = process.argv.slice(2);
const withRollback = profile === '--with-component-rollback';
const withLms = profile === '--with-lms' || withRollback;
const withTaskWork = profile === '--with-task-work';
const withTaskUpgrade = profile === '--with-task-upgrade';
const needsBaseline = withTaskUpgrade || withRollback;
const withOperations = profile === '--with-workflow-operations';
const withForms = profile === '--with-forms-work';
const withPromotion = profile === '--with-workflow-promotion';
if (
  process.platform !== 'win32' ||
  !release ||
  !/^[a-z0-9][a-z0-9-]{0,39}$/.test(release) ||
  !digest ||
  !/^[a-f0-9]{64}$/.test(digest) ||
  !postgresBin ||
  (profile !== undefined &&
    !withLms &&
    !withTaskWork &&
    !withTaskUpgrade &&
    !withOperations &&
    !withForms &&
    !withPromotion) ||
  (needsBaseline
    ? extra.length !== 2 ||
      !/^[a-z0-9][a-z0-9-]{0,39}$/.test(extra[0]!) ||
      !/^[a-f0-9]{64}$/.test(extra[1]!)
    : extra.length !== 0)
) {
  console.error(
    'Use enterprise-recovery-postgres.ts <release-name> <artifact-sha256> <PostgreSQL-17-bin-directory> [--with-lms|--with-task-work|--with-task-upgrade <baseline> <digest>|--with-workflow-operations|--with-forms-work|--with-workflow-promotion|--with-component-rollback <baseline> <digest>] on Windows.',
  );
  process.exit(1);
}

const root = await realpath('.');
const artifact = join(root, '.local', 'releases', release, 'artifact');
const baseline = needsBaseline
  ? join(root, '.local', 'releases', extra[0]!, 'artifact')
  : undefined;
const binaries = resolve(postgresBin);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key)));

async function command(program: string, args: string[], password?: string, capture = false) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, {
      env: { ...env, ...(password ? { PGPASSWORD: password } : {}) },
      windowsHide: true,
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
    });
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', () => reject(new Error('Child process could not start.')));
    child.once('close', (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error('Child process failed.')),
    );
  });
}

const postgres = (name: string, args: string[], password?: string, capture = false) =>
  command(join(binaries, name + '.exe'), args, password, capture);

async function freePort() {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function clusterPool(
  cluster: Cluster,
  database: string,
  max = 1,
  role?: 'aio_runtime' | 'aio_tasks_runtime' | 'aio_workflows_runtime' | 'aio_forms_runtime',
) {
  return new pg.Pool({
    host,
    port: cluster.port,
    database,
    user: admin,
    password: cluster.password,
    max,
    connectionTimeoutMillis: 2500,
    options: '-c timezone=UTC' + (role ? ' -c role=' + role : ''),
  });
}

async function use<T>(cluster: Cluster, database: string, action: (db: PoolClient) => Promise<T>) {
  const pool = clusterPool(cluster, database);
  try {
    const db = await pool.connect();
    try {
      const state = (
        await db.query(`SELECT current_database() AS db, current_user AS owner,
        current_setting('cluster_name') AS name, current_setting('data_directory') AS directory,
        current_setting('listen_addresses') AS listen, host(inet_server_addr()) AS host,
        inet_server_port() AS port`)
      ).rows[0];
      assert.equal(await realpath(state.directory), cluster.directory);
      assert.deepEqual(
        { ...state, directory: cluster.directory },
        {
          db: database,
          owner: admin,
          name: cluster.name,
          directory: cluster.directory,
          listen: host,
          host,
          port: cluster.port,
        },
      );
      return await action(db);
    } finally {
      db.release();
    }
  } finally {
    await pool.end();
  }
}

async function replayIntake(
  cluster: Cluster,
  ref: { id: string; tenantId: string },
  deliver: () => Promise<string>,
) {
  const { processDraftJobs, observeDraftQueues } = (await import(
    pathToFileURL(join(artifact, 'dist/src/workflows/automation-jobs.js')).href
  )) as typeof import('../src/workflows/automation-jobs.js');
  const createWorkerPool = () => clusterPool(cluster, stores.workflows.name);
  const beforeRestart = createWorkerPool();
  let retryDelayMs = 0;
  const queueState = async (pool: pg.Pool) => {
    const samples = await observeDraftQueues(pool);
    assert.deepEqual(samples.map(({ queue }) => queue).sort(), [
      'email',
      'intake',
      'link',
      'schedule',
    ]);
    const intake = samples.find(({ queue }) => queue === 'intake');
    assert.ok(intake);
    return { due: intake.due, oldestDueMs: intake.oldestDueMs, blocked: intake.blocked };
  };
  let queued: Awaited<ReturnType<typeof queueState>>;
  let inBackoff: Awaited<ReturnType<typeof queueState>>;
  try {
    queued = await queueState(beforeRestart);
    assert.equal(queued.due, 1);
    assert.equal(
      await processDraftJobs(beforeRestart, 'intake', async (_, job) => {
        assert.equal(job.id, ref.id);
        assert.equal(await deliver(), ref.id);
        throw new Error('Synthetic loss of delivery acknowledgement.');
      }),
      1,
    );
    const row = (
      await beforeRestart.query(
        `SELECT status, attempts, error_code,
      (EXTRACT(EPOCH FROM (next_attempt_at-updated_at))*1000)::int AS backoff_ms,
      GREATEST(0,ceil(EXTRACT(EPOCH FROM (next_attempt_at-clock_timestamp()))*1000))::int AS wait_ms
      FROM workflow_intake_jobs WHERE tenant_id=$1 AND id=$2`,
        [ref.tenantId, ref.id],
      )
    ).rows[0];
    assert.deepEqual(
      { ...row, wait_ms: undefined },
      {
        status: 'retry',
        attempts: 1,
        error_code: 'WORKFLOW_INTAKE_TEMPORARY_FAILURE',
        backoff_ms: 30000,
        wait_ms: undefined,
      },
    );
    assert.ok(row.wait_ms > 0 && row.wait_ms <= 30000);
    retryDelayMs = row.wait_ms;
    inBackoff = await queueState(beforeRestart);
    assert.deepEqual(inBackoff, { due: 0, oldestDueMs: 0, blocked: 0 });
    assert.equal(
      await processDraftJobs(beforeRestart, 'intake', async () => {
        throw new Error('Backoff was bypassed.');
      }),
      0,
    );
  } finally {
    await beforeRestart.end();
  }

  await delay(retryDelayMs + 100);
  const replicas = [createWorkerPool(), createWorkerPool()];
  let deliveries = 0;
  let dueAgain: Awaited<ReturnType<typeof queueState>>;
  let drained: Awaited<ReturnType<typeof queueState>>;
  try {
    dueAgain = await queueState(replicas[0]!);
    assert.equal(dueAgain.due, 1);
    const outcomes = await Promise.allSettled(
      replicas.map((pool) =>
        processDraftJobs(pool, 'intake', async (_, job) => {
          assert.equal(job.id, ref.id);
          assert.equal(job.tenant_id, ref.tenantId);
          deliveries++;
          return deliver();
        }),
      ),
    );
    const processed = outcomes.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason;
      return outcome.value;
    });
    assert.deepEqual(processed.sort(), [0, 1]);
    assert.equal(deliveries, 1);
    const rows = (
      await replicas[0]!.query(
        `SELECT j.status,j.attempts,j.target_draft_id,a.attempt,a.status AS attempt_status,a.error_code
      FROM workflow_intake_jobs j JOIN workflow_intake_attempts a ON (a.tenant_id,a.job_id)=(j.tenant_id,j.id)
      WHERE j.tenant_id=$1 AND j.id=$2 ORDER BY a.attempt`,
        [ref.tenantId, ref.id],
      )
    ).rows;
    assert.deepEqual(rows, [
      {
        status: 'done',
        attempts: 2,
        target_draft_id: ref.id,
        attempt: 1,
        attempt_status: 'retry',
        error_code: 'WORKFLOW_INTAKE_TEMPORARY_FAILURE',
      },
      {
        status: 'done',
        attempts: 2,
        target_draft_id: ref.id,
        attempt: 2,
        attempt_status: 'done',
        error_code: null,
      },
    ]);
    drained = await queueState(replicas[0]!);
    assert.deepEqual(drained, { due: 0, oldestDueMs: 0, blocked: 0 });
  } finally {
    await Promise.all(replicas.map((pool) => pool.end()));
  }
  return {
    backoffMs: 30000,
    workerReplicas: replicas.length,
    deliveriesAfterRestart: deliveries,
    attemptStatuses: ['retry', 'done'],
    acknowledged: true,
    queueSamples: { queued, inBackoff, dueAgain, drained },
  };
}

async function start(cluster: Cluster) {
  await mkdir(cluster.directory, { mode: 0o700 });
  const pwfile = join(cluster.directory, '..', cluster.name + '.pw');
  await writeFile(pwfile, cluster.password + '\n', { flag: 'wx', mode: 0o600 });
  try {
    await postgres('initdb', [
      '-D',
      cluster.directory,
      '-U',
      admin,
      '--auth=scram-sha-256',
      '--encoding=UTF8',
      '--locale=C',
      '--pwfile=' + pwfile,
    ]);
  } finally {
    await unlink(pwfile);
  }
  // Mark before startup so finally checks even if pg_ctl times out after launching the server.
  cluster.started = true;
  await postgres('pg_ctl', [
    'start',
    '-w',
    '-t',
    '25',
    '-D',
    cluster.directory,
    '-l',
    join(cluster.directory, '..', cluster.name + '.log'),
    '-o',
    '-h ' + host + ' -p ' + cluster.port + ' -c cluster_name=' + cluster.name,
  ]);
  await use(cluster, 'postgres', async () => {});
}

async function stop(cluster: Cluster) {
  if (!cluster.started) return;
  const pidFile = join(cluster.directory, 'postmaster.pid');
  if (
    await lstat(pidFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    })
  ) {
    assert.equal(await realpath(cluster.directory), cluster.directory);
    await postgres('pg_ctl', ['stop', '-m', 'fast', '-w', '-t', '25', '-D', cluster.directory]);
  }
  cluster.started = false;
}

async function prepare(cluster: Cluster) {
  await use(cluster, 'postgres', async (db) => {
    const roles = new Set(Object.values(stores).flatMap((store) => [store.owner, ...store.roles]));
    roles.delete(admin);
    for (const role of roles)
      await db.query(
        'CREATE ROLE ' +
          identifier(role) +
          ' NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT',
      );
    for (const name of ['postgres', 'template1'])
      await db.query('REVOKE CONNECT ON DATABASE ' + identifier(name) + ' FROM PUBLIC');
    for (const store of Object.values(stores)) {
      await db.query(
        'CREATE DATABASE ' +
          identifier(store.name) +
          ' OWNER ' +
          identifier(store.owner) +
          ' TEMPLATE template0',
      );
      await db.query('REVOKE ALL ON DATABASE ' + identifier(store.name) + ' FROM PUBLIC');
      await db.query(
        'GRANT CONNECT ON DATABASE ' +
          identifier(store.name) +
          ' TO ' +
          store.roles.map(identifier).join(','),
      );
    }
  });
}

async function fingerprints(db: PoolClient, schema: string) {
  const tables = (
    await db.query<{ tablename: string; tableowner: string }>(
      'SELECT tablename,tableowner FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',
      [schema],
    )
  ).rows;
  const rows = [];
  for (const table of tables) {
    const state = (
      await db.query(`SELECT count(*)::int AS rows,
      encode(sha256(convert_to(COALESCE(string_agg(row_text,chr(10) ORDER BY row_text COLLATE "C"),''),'UTF8')),'hex') AS sha256
      FROM (SELECT to_jsonb(t)::text AS row_text FROM ${identifier(schema)}.${identifier(table.tablename)} t) records`)
    ).rows[0];
    rows.push({ ...table, ...state });
  }
  const sequences = (
    await db.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S'
    ORDER BY c.relname`,
      [schema],
    )
  ).rows;
  for (const sequence of sequences)
    Object.assign(
      sequence,
      (
        await db.query(
          'SELECT last_value::text,is_called FROM ' +
            identifier(schema) +
            '.' +
            identifier(sequence.relname),
        )
      ).rows[0],
    );
  const journal =
    schema === 'public'
      ? (
          await db.query(
            'SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version',
          )
        ).rows
      : [];
  return { rows, sequences, journal };
}

async function archiveIdentity(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { bytes: (await stat(file)).size, sha256: hash.digest('hex') };
}

const run = randomUUID();
const local = join(root, '.local');
const recovery = join(local, 'enterprise-recovery');
const runDir = join(recovery, run);
const newCluster = async (side: 'source' | 'target'): Promise<Cluster> => ({
  directory: join(runDir, side),
  name: 'aio_recovery_' + side + '_' + run.slice(0, 8),
  port: await freePort(),
  password: randomBytes(32).toString('hex'),
  started: false,
});

let phase = 'preflight';
let source: Cluster | undefined;
let restored: Cluster | undefined;
let receipt: object | undefined;
try {
  assert.equal(await realpath(local), local);
  await command(process.execPath, ['scripts/release.mjs', 'verify', artifact, digest]);
  if (baseline)
    await command(process.execPath, ['scripts/release.mjs', 'verify', baseline, extra[1]!]);
  const serverVersion = await postgres('postgres', ['--version'], undefined, true);
  assert.match(serverVersion, /^postgres \(PostgreSQL\) 17\./);
  await mkdir(recovery, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(recovery), recovery);
  await mkdir(runDir, { mode: 0o700 });
  source = await newCluster('source');
  phase = 'start and provision isolated source';
  await start(source);
  await prepare(source);
  const fromSource = <T>(key: Store, action: (db: PoolClient) => Promise<T>) =>
    use(source!, stores[key].name, action);
  phase = 'seed AIO PostgreSQL stores from sealed migrations';
  const fixture = await seedRecoveryFixtures(artifact, run, fromSource, baseline ?? artifact);

  let exported: Awaited<ReturnType<typeof exportWorkflowPromotion>> | undefined;
  if (withPromotion) {
    phase = 'export configuration from isolated Workflow source';
    const pool = clusterPool(source, stores.workflows.name, 2, 'aio_workflows_runtime');
    try {
      exported = await exportWorkflowPromotion(artifact, pool);
    } finally {
      await pool.end();
    }
  }

  const lmsRoot = join(runDir, 'lms');
  const lmsBackup = join(lmsRoot, 'checkpoint');
  phase = 'seed and stop isolated LMS Worker';
  const lms = withLms
    ? await prepareLmsRecovery(artifact, lmsRoot, run, fixture.intake)
    : undefined;

  phase = 'seal shared storage checkpoint with writers stopped';
  const checkpointAt = new Date();
  const checkpointStart = performance.now();
  const backups = [];
  for (const key of storeKeys) {
    const store = stores[key];
    const file = join(runDir, key + '.dump');
    const data = await fromSource(key, async (db) => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const snapshot = (await db.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
        const state = await fingerprints(db, store.schema);
        assert.ok(
          state.rows.length > 0 && state.rows.every((row) => row.tableowner === store.owner),
        );
        await postgres(
          'pg_dump',
          [
            '-h',
            host,
            '-p',
            String(source!.port),
            '-U',
            admin,
            '-d',
            store.name,
            '-w',
            '-Fc',
            '--snapshot=' + snapshot,
            '-f',
            file,
          ],
          source!.password,
        );
        return state;
      } finally {
        await db.query('ROLLBACK');
      }
    });
    backups.push({ key, file: key + '.dump', ...(await archiveIdentity(file)), data });
  }
  phase = 'seal offline LMS D1 and R2 storage';
  const lmsFiles = lms ? await copyLmsStorage(lms.sourcePath, lmsBackup) : undefined;
  const backupMs = Math.round(performance.now() - checkpointStart);
  await writeFile(
    join(runDir, 'checkpoint.json'),
    JSON.stringify(
      {
        run,
        digest,
        checkpointAt,
        backups,
        ...(lms && { lms: { files: lmsFiles, snapshot: lms.snapshot, media: lms.media } }),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );

  phase = 'commit later synthetic event then stop source';
  const later = randomUUID();
  await fromSource('foundation', async (db) => {
    const write = await db.query(
      `INSERT INTO audit_events(tenant_id,app_code,action,request_id)
      VALUES ($1,'aio-foundation','recovery.after-checkpoint',$2) RETURNING request_id`,
      [fixture.tenant, later],
    );
    assert.equal(write.rows[0]?.request_id, later);
  });
  const incidentAt = new Date();
  const incidentStart = performance.now();
  const rpoMs = Math.ceil(incidentStart - checkpointStart);
  await stop(source);

  phase = 'initialize empty independent restore cluster';
  restored = await newCluster('target');
  await start(restored);
  await prepare(restored);
  const fromTarget = <T>(key: Store, action: (db: PoolClient) => Promise<T>) =>
    use(restored!, stores[key].name, action);
  for (const { key, file, sha256, bytes, data } of backups) {
    const store = stores[key];
    const path = join(runDir, file);
    phase = 'restore and reconcile ' + key;
    assert.deepEqual(await archiveIdentity(path), { sha256, bytes });
    await fromTarget(key, async (db) => {
      assert.equal(
        (await db.query('SELECT 1 FROM pg_tables WHERE schemaname=$1', [store.schema])).rowCount,
        0,
      );
    });
    await postgres(
      'pg_restore',
      [
        '-h',
        host,
        '-p',
        String(restored.port),
        '-U',
        admin,
        '-d',
        store.name,
        '-w',
        '--single-transaction',
        '--exit-on-error',
        path,
      ],
      restored.password,
    );
    assert.deepEqual(await fromTarget(key, (db) => fingerprints(db, store.schema)), data);
  }
  phase = 'verify restored cross-store records';
  const reconciliation = await verifyRecoveryFixtures(fromTarget, fixture, later);
  phase = 'verify restored database connect privileges';
  await use(restored, 'postgres', async (db) => {
    for (const store of Object.values(stores)) {
      for (const role of store.roles) {
        const grants = (
          await db.query<{ name: string }>(
            `SELECT datname AS name FROM pg_database
          WHERE datallowconn AND has_database_privilege($1,datname,'CONNECT')`,
            [role],
          )
        ).rows;
        assert.deepEqual(grants, [{ name: store.name }]);
      }
    }
  });
  let retry: Awaited<ReturnType<typeof replayIntake>> | undefined;
  phase = 'restore LMS and retry intake with two workers';
  const restoredLms =
    lms && lmsFiles && !withRollback
      ? await restoreLmsRecovery(artifact, lmsRoot, lmsBackup, lmsFiles, lms, async (deliver) => {
          retry = await replayIntake(restored!, fixture.intake, deliver);
        })
      : undefined;
  const rtoMs = Math.ceil(performance.now() - incidentStart);
  const readyAt = new Date();
  assert.ok(rpoMs <= 15 * 60_000 && rtoMs <= 60 * 60_000);
  let taskWork: Awaited<ReturnType<typeof verifyTaskWork>> | undefined;
  let taskUpgrade: object | undefined;
  if (baseline) {
    phase = 'apply additive Tasks migration to restored baseline and verify legacy project';
    taskUpgrade = await fromTarget('tasks', async (db) => {
      const snapshot = () =>
        db
          .query(`SELECT id,revision,archived,name FROM task_projects ORDER BY id`)
          .then(({ rows }) => rows);
      const journal = () =>
        db
          .query(`SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version`)
          .then(({ rows }) => rows);
      const legacyTask = randomUUID();
      const priorProjects = await snapshot();
      assert.ok(priorProjects[0]);
      await db.query(
        `INSERT INTO task_items(id,tenant_id,project_id,title,description,creator_account_id,creator_person_id,creator_name)
        SELECT $1,tenant_id,id,'Việc có trước nâng cấp','',owner_account_id,owner_person_id,'Fixture' FROM task_projects WHERE id=$2`,
        [legacyTask, priorProjects[0].id],
      );
      const before = (
        await db.query('SELECT status,progress,revision FROM task_items WHERE id=$1', [legacyTask])
      ).rows;
      const applied = await journal();
      assert.deepEqual(
        applied.map(({ version }) => version),
        ['001'],
      );
      await db.query('SET ROLE aio_tasks_owner');
      try {
        assert.deepEqual(
          await migrateTasks(db, run, { slot, directory: join(artifact, 'infrastructure/tasks') }),
          ['001', '002'],
        );
        await grantModuleRuntime(db, 'tasks');
      } finally {
        await db.query('RESET ROLE');
      }
      assert.deepEqual((await journal()).slice(0, applied.length), applied);
      assert.deepEqual(await snapshot(), priorProjects);
      assert.deepEqual(
        (
          await db.query('SELECT status,progress,revision FROM task_items WHERE id=$1', [
            legacyTask,
          ])
        ).rows,
        before,
      );
      await db.query(
        `UPDATE task_items SET status='doing',progress=20,revision=revision+1 WHERE id=$1`,
        [legacyTask],
      );
      assert.deepEqual(
        (await db.query('SELECT status,stage_code FROM task_items WHERE id=$1', [legacyTask])).rows,
        [{ status: 'doing', stage_code: null }],
      );
      return {
        baseline: extra[0],
        baselineDigest: extra[1],
        versions: ['001', '002'],
        originalJournalRetained: true,
        legacyProjectAndTaskPreserved: true,
        legacyWriteCompatible: true,
      };
    });
  }
  let rollback: object | undefined;
  if (withRollback) {
    assert.ok(baseline && lms && lmsFiles && taskUpgrade);
    phase = 'inject readiness failure after migration then exercise rollback and roll-forward';
    const db = {
      foundation: clusterPool(restored, stores.foundation.name, 1, 'aio_runtime'),
      forms: clusterPool(restored, stores.forms.name, 1, 'aio_forms_runtime'),
      workflows: clusterPool(restored, stores.workflows.name, 1, 'aio_workflows_runtime'),
      tasks: clusterPool(restored, stores.tasks.name, 1, 'aio_tasks_runtime'),
    };
    const durable = async () => {
      const results = [];
      for (const key of storeKeys)
        results.push(await fromTarget(key, (client) => fingerprints(client, stores[key].schema)));
      return results;
    };
    try {
      const before = await durable();
      const expected = await probeReleaseComponents(artifact, db, fixture);
      await probeReleaseComponents(artifact, db, fixture, randomUUID());
      assert.deepEqual(await durable(), before);
      assert.deepEqual(await probeReleaseComponents(baseline, db, fixture), expected);
      assert.deepEqual(await probeReleaseComponents(artifact, db, fixture), expected);
      assert.deepEqual(await durable(), before);
      const worker = await verifyLmsRollback(
        [artifact, baseline, artifact],
        lmsRoot,
        lmsBackup,
        lmsFiles,
        lms,
      );
      rollback = {
        baseline: extra[0],
        baselineDigest: extra[1],
        services: ['foundation', 'forms', 'workflows', 'tasks', 'lms'],
        wrongInstanceRefused: true,
        switchedArtifacts: ['candidate', 'baseline', 'candidate'],
        journalAndBusinessDataRetained: true,
        sourceRightsFixtures: true,
        worker,
        runner: await archiveIdentity(join(root, 'scripts', 'enterprise-component-rollback.ts')),
      };
    } finally {
      await Promise.all(Object.values(db).map((pool) => pool.end()));
    }
  }
  if (withTaskWork || withTaskUpgrade) {
    phase =
      'verify Portal Tasks source reads and live revocation on the restored PostgreSQL fixture';
    const owner = clusterPool(restored, stores.foundation.name);
    const foundation = clusterPool(restored, stores.foundation.name, 2, 'aio_runtime');
    const tasks = clusterPool(restored, stores.tasks.name, 2, 'aio_tasks_runtime');
    try {
      assert.equal(
        (await foundation.query('SELECT current_user AS role')).rows[0]?.role,
        'aio_runtime',
      );
      assert.equal(
        (await tasks.query('SELECT current_user AS role')).rows[0]?.role,
        'aio_tasks_runtime',
      );
      taskWork = await verifyTaskWork(artifact, foundation, owner, tasks, withTaskUpgrade);
    } finally {
      await Promise.all([owner.end(), foundation.end(), tasks.end()]);
    }
  }
  let operations: Awaited<ReturnType<typeof verifyWorkflowOperations>> | undefined;
  if (withOperations) {
    phase = 'verify Workflow operations and recover a blocked job';
    const first = clusterPool(restored, stores.workflows.name, 2, 'aio_workflows_runtime');
    const second = clusterPool(restored, stores.workflows.name, 2, 'aio_workflows_runtime');
    try {
      assert.equal(
        (await first.query('SELECT current_user AS role')).rows[0]?.role,
        'aio_workflows_runtime',
      );
      operations = await verifyWorkflowOperations(artifact, first, second, fixture.intake);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  }
  let formsWork: Awaited<ReturnType<typeof verifyFormsWork>> | undefined;
  if (withForms) {
    phase = 'verify Forms Portal feed and submission rights';
    const owner = clusterPool(restored, stores.foundation.name);
    const foundation = clusterPool(restored, stores.foundation.name, 2, 'aio_runtime');
    const forms = clusterPool(restored, stores.forms.name, 2, 'aio_forms_runtime');
    try {
      assert.equal(
        (await forms.query('SELECT current_user AS role')).rows[0]?.role,
        'aio_forms_runtime',
      );
      formsWork = await verifyFormsWork(artifact, foundation, owner, forms);
    } finally {
      await Promise.all([owner.end(), foundation.end(), forms.end()]);
    }
  }
  let promotion: Awaited<ReturnType<typeof verifyWorkflowPromotion>> | undefined;
  if (exported) {
    phase = 'review and promote configuration in the independent Workflow target';
    const pool = clusterPool(restored, stores.workflows.name, 2, 'aio_workflows_runtime');
    try {
      promotion = await verifyWorkflowPromotion(artifact, pool, exported);
    } finally {
      await pool.end();
    }
  }
  const completedAt = new Date();
  receipt = {
    status: 'pass',
    scope: restoredLms ? 'postgresql-lms-storage' : 'postgresql-component',
    release,
    artifactDigest: digest,
    run,
    serverVersion,
    runner: await archiveIdentity(join(root, 'scripts', 'enterprise-recovery-postgres.ts')),
    fixtures: await archiveIdentity(join(root, 'scripts', 'enterprise-recovery-fixtures.ts')),
    checkpointAt,
    checkpointAtVietnam: vietnam(checkpointAt),
    incidentAt,
    incidentAtVietnam: vietnam(incidentAt),
    readyAt,
    readyAtVietnam: vietnam(readyAt),
    completedAt,
    completedAtVietnam: vietnam(completedAt),
    backupMs,
    rpoMs,
    rtoMs,
    archives: backups.map(({ data, ...entry }) => ({
      ...entry,
      tables: data.rows.length,
      sequences: data.sequences.length,
      versions: data.journal.map((row) => row.version),
    })),
    reconciliation,
    databaseConnectRestricted: true,
    ...(promotion && {
      promotion: {
        ...promotion,
        runner: await archiveIdentity(join(root, 'scripts', 'enterprise-workflow-promotion.ts')),
      },
    }),
    ...(formsWork && { formsWork }),
    ...(taskUpgrade && { taskUpgrade }),
    ...(rollback && { rollback }),
    ...(operations && {
      operations: {
        ...operations,
        runner: await archiveIdentity(join(root, 'scripts', 'enterprise-workflow-operations.ts')),
      },
    }),
    ...(taskWork && {
      taskWork: {
        ...taskWork,
        identitySimulated: true,
        runner: await archiveIdentity(join(root, 'scripts', 'enterprise-task-work.ts')),
      },
    }),
    lostPostCheckpointEvents: 1,
    ...(restoredLms && {
      lms: restoredLms,
      intakeRetry: retry,
      lmsFiles: lmsFiles?.length,
      lmsRunner: await archiveIdentity(join(root, 'scripts', 'enterprise-recovery-lms.ts')),
      lmsStorageRunner: await archiveIdentity(join(root, 'scripts', 'lms-backup-storage.ts')),
    }),
  };
} catch (error) {
  const code = (error as { code?: unknown } | null)?.code;
  const location =
    error instanceof Error
      ? error.stack?.match(
          /(?:enterprise-recovery-(?:postgres|fixtures|lms)|enterprise-component-rollback|enterprise-task-work|enterprise-workflow-operations|enterprise-workflow-promotion|enterprise-forms-work|lms-backup-storage)\.ts:\d+:\d+/,
        )?.[0]
      : undefined;
  console.error(
    'Storage recovery rehearsal failed at ' +
      phase +
      (typeof code === 'string' && /^[0-9A-Z_]{2,20}$/.test(code) ? ' (' + code + ')' : '') +
      (location ? ' [' + location + ']' : '') +
      '.',
  );
  process.exitCode = 1;
} finally {
  for (const cluster of [restored, source]) {
    if (!cluster) continue;
    try {
      await stop(cluster);
    } catch {
      console.error('Could not stop rehearsal cluster ' + cluster.name + '.');
      process.exitCode = 1;
    }
  }
}
if (receipt && !process.exitCode) {
  await writeFile(join(runDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify(receipt));
}
