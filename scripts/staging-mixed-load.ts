import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Agent, request } from 'node:https';
import { cpus, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, Page } from '@playwright/test';
import type { Pool, PoolClient } from 'pg';
import { ids } from '../src/fixtures.js';
import { assertStagingConfig } from '../src/staging-config.js';
import type { StagingConfig } from '../src/staging-config.js';
import { reportActors } from './staging-report-fixtures.js';
import { reserveStagingRequests } from './e2e-request-budget.js';
import { loadTargets, runMixedLoad } from './enterprise-mixed-load.js';
import type { LoadAction, LoadKind, LoadSession } from './enterprise-mixed-load.js';

export type StagingLoadFixtures = {
  formId: string;
  runId: string;
  taskId: string;
  outsideProjectId: string;
  courseId: string;
  versionId: string;
  mediaId: string;
};
export type LoadActor = 'operator' | 'outside' | 'other';
export type LoadClient = 'foundation' | 'forms' | 'workflows' | 'tasks' | 'lms-sandbox';
type Exchange = { status: number; body: Buffer };
type Session = { base: string; cookie: string; csrf: string };
const population = [
  {
    actor: 'operator',
    count: 50,
    clients: ['foundation', 'forms', 'workflows', 'tasks', 'lms-sandbox'],
    tenant: ids.tenantA,
    template: ids.admin,
  },
  {
    actor: 'outside',
    count: 25,
    clients: ['lms-sandbox'],
    tenant: ids.tenantA,
    template: reportActors.outside.id,
  },
  { actor: 'other', count: 25, clients: ['tasks'], tenant: ids.tenantB, template: ids.other },
] as const;
export function stagingLoadIdentities() {
  return population.flatMap(({ actor, count, tenant, template }) =>
    Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      username: 'stage.load-' + actor + '-' + (index + 1),
      name: 'Tải giả lập ' + actor + ' ' + (index + 1),
      tenantId: tenant,
      actor,
      index,
      template,
    })),
  );
}
export type LoadIdentity = ReturnType<typeof stagingLoadIdentities>[number] & { subject: string };

export async function seedMixedLoadJobs(pool: Pool, definitionId: string) {
  const schedule = randomUUID();
  const count = 30;
  const result = await pool.query(
    `WITH pinned AS (
    SELECT d.tenant_id,d.id,v.id AS version FROM workflow_definitions d JOIN workflow_versions v
      ON (v.tenant_id,v.definition_id,v.version)=(d.tenant_id,d.id,d.latest_version)
    WHERE d.id=$1 AND d.tenant_id=$2 AND d.org_unit_id=$3 AND d.status='published'
  ), schedule AS (
    INSERT INTO workflow_draft_schedules(id,tenant_id,org_unit_id,definition_id,version_id,title,recipient_account_id,recipient_person_id,cadence,every,start_date,local_time,created_by)
    SELECT $4,tenant_id,$3,id,version,'Lịch đo tải',$5,$5,'daily',1,current_date,'08:00',$5 FROM pinned RETURNING id,tenant_id
  ) INSERT INTO workflow_scheduled_draft_jobs(id,tenant_id,schedule_id,scheduled_for,next_attempt_at)
    SELECT gen_random_uuid(),s.tenant_id,s.id,due.at,due.at FROM schedule s CROSS JOIN LATERAL
    (SELECT now() + n * interval '55 seconds' AS at FROM generate_series(1,$6::int) n) due`,
    [definitionId, ids.tenantA, ids.unitA, schedule, ids.admin, count],
  );
  assert.equal(result.rowCount, count);
  return { schedule, count };
}

export async function mixedLoadJobResults(
  pool: Pool,
  fixture: Awaited<ReturnType<typeof seedMixedLoadJobs>>,
) {
  const { rows } = await pool.query<{
    status: string;
    elapsed: number | null;
    draft: string | null;
  }>(
    `SELECT j.status,j.target_request_id AS draft,
    CASE WHEN j.status='done' THEN greatest(0,extract(epoch FROM (j.updated_at-j.scheduled_for))*1000)::float8 END AS elapsed
    FROM workflow_scheduled_draft_jobs j WHERE (j.tenant_id,j.schedule_id)=($1,$2) ORDER BY j.scheduled_for`,
    [ids.tenantA, fixture.schedule],
  );
  const completed = rows
    .flatMap(({ elapsed }) => (elapsed === null ? [] : [elapsed]))
    .sort((a, b) => a - b);
  const p95Ms = completed.length ? completed[Math.ceil(completed.length * 0.95) - 1]! : null;
  const distinctDrafts = new Set(rows.flatMap(({ draft }) => (draft ? [draft] : []))).size;
  return {
    scheduled: fixture.count,
    completed: completed.length,
    distinctDrafts,
    p95Ms,
    status:
      rows.length === fixture.count &&
      distinctDrafts === fixture.count &&
      p95Ms !== null &&
      p95Ms <= 120000
        ? 'pass'
        : 'fail',
  };
}

export async function provisionStagingLoadIdentities(
  db: PoolClient,
  runtime: StagingConfig,
  users: LoadIdentity[],
) {
  assertStagingConfig(runtime);
  assert.equal(users.length, loadTargets.sessions);
  const marker = await db.query('SELECT 1 FROM bootstrap_receipts WHERE name=$1', [
    'enterprise-staging:' + runtime.instanceId,
  ]);
  assert.equal(marker.rowCount, 1);
  await db.query('BEGIN');
  try {
    for (const user of users) {
      await db.query('INSERT INTO persons(id,display_name,home_tenant_id) VALUES ($1,$2,$3)', [
        user.id,
        user.name,
        user.tenantId,
      ]);
      await db.query('INSERT INTO accounts(id,person_id,mfa_required) VALUES ($1,$1,true)', [
        user.id,
      ]);
      await db.query(
        'INSERT INTO external_identities(issuer,subject,account_id) VALUES ($1,$2,$3)',
        [runtime.issuer, user.subject, user.id],
      );
      await db.query('INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)', [
        user.id,
        user.tenantId,
      ]);
      const clients = population
        .find(({ actor }) => actor === user.actor)!
        .clients.map((code) => 'aio-' + code);
      assert.equal(
        (
          await db.query(
            `INSERT INTO application_grants(account_id,tenant_id,app_code)
        SELECT $1,tenant_id,app_code FROM application_grants WHERE account_id=$2 AND tenant_id=$3 AND app_code=ANY($4::text[]) AND active`,
            [user.id, user.template, user.tenantId, clients],
          )
        ).rowCount,
        clients.length,
      );
      await db.query(
        `INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code,org_unit_id,managed_app_code)
        SELECT gen_random_uuid(),$1,tenant_id,app_code,role_code,org_unit_id,managed_app_code FROM role_bindings
        WHERE account_id=$2 AND tenant_id=$3 AND app_code=ANY($4::text[]) AND active
          AND (managed_app_code IS NULL OR managed_app_code=app_code)`,
        [user.id, user.template, user.tenantId, clients],
      );
      if (user.actor === 'other') continue;
      const employment = randomUUID();
      await db.query(
        `INSERT INTO employments(id,person_id,tenant_id,legal_entity_id,employee_code) VALUES ($1,$2,$3,$4,$5)`,
        [employment, user.id, user.tenantId, ids.legalA, 'NV-LOAD-' + user.id],
      );
      const unit = user.actor === 'operator' ? ids.unitA : ids.unitC;
      assert.equal(
        (
          await db.query(
            `INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary)
        SELECT gen_random_uuid(),tenant_id,legal_entity_id,$1,id,true FROM positions WHERE tenant_id=$2 AND org_unit_id=$3 AND active ORDER BY id LIMIT 1`,
            [employment, user.tenantId, unit],
          )
        ).rowCount,
        1,
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

function exchange(
  agent: Agent,
  base: string,
  path: string,
  signal: AbortSignal,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<Exchange> {
  assert.ok(path.startsWith('/') && !path.startsWith('//'));
  return new Promise((resolve, reject) => {
    const call = request(
      base + path,
      { agent, signal, method: body ? 'POST' : 'GET', headers },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) response.destroy(new Error('Load response too large.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    call.on('error', reject);
    call.end(body);
  });
}

export async function verifyStagingMixedLoad(
  runtime: StagingConfig,
  ca: string,
  browser: Browser,
  enter: (
    client: LoadClient,
    actor: LoadActor,
    first: boolean,
    page: Page,
    index: number,
  ) => Promise<void>,
  fixtures: StagingLoadFixtures,
  sample: () => Promise<Record<string, number | null>>,
  beforeLoad?: () => Promise<void>,
) {
  assertStagingConfig(runtime);
  const endpoint = (client: LoadClient) =>
    runtime.clients.find(({ code }) => code === 'aio-' + client)!.baseUrl;
  const agent = new Agent({ ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', maxSockets: 100 });
  const seen = new Set<string>();
  const sessions: LoadSession[] = [];
  const assessmentChecks: (() => boolean)[] = [];
  const reason = 'Tải giả lập E3';
  const pdf = Buffer.from('%PDF-1.4\n% Synthetic load fixture\n%%EOF\n');
  const mediaSha = createHash('sha256').update(pdf).digest('hex');
  try {
    let lastLogin = 0;
    for (const { actor, count, clients, tenant } of population)
      for (let index = 0; index < count; index++) {
        await reserveStagingRequests(endpoint('foundation'), ca, 70);
        if (lastLogin) await delay(Math.max(0, 3400 - (performance.now() - lastLogin)));
        lastLogin = performance.now();
        const context = await browser.newContext();
        const bindings = new Map<LoadClient, Session>();
        try {
          const page = await context.newPage();
          for (const [offset, client] of clients.entries()) {
            const base = endpoint(client);
            if (client !== 'foundation' && client !== 'lms-sandbox')
              await reserveStagingRequests(base, ca, 35);
            await enter(client, actor, offset === 0, page, index);
            const prefix = '__Host-aio_';
            const name =
              client === 'lms-sandbox'
                ? prefix + 'lms_' + runtime.slot + '_session'
                : prefix + runtime.slot + '_session_aio-' + client;
            const cookie = (await context.cookies(base)).find((entry) => entry.name === name);
            assert.ok(cookie?.secure && cookie.httpOnly);
            const hash = createHash('sha256').update(cookie.value).digest('hex');
            assert.ok(!seen.has(hash), 'Each staged session must have an independent cookie.');
            seen.add(hash);
            const credentials = name + '=' + cookie.value;
            const me = await exchange(agent, base, '/api/v1/me', AbortSignal.timeout(15000), {
              cookie: credentials,
            });
            assert.equal(me.status, 200);
            const { csrfToken: csrf } = JSON.parse(me.body.toString()) as { csrfToken?: string };
            assert.ok(csrf);
            bindings.set(client, { base, cookie: credentials, csrf });
          }
        } finally {
          await context.close();
        }
        const action = (
          name: string,
          kind: LoadKind,
          client: LoadClient,
          path: string,
          payload?: () => { body: Buffer; headers?: Record<string, string>; key?: string },
          expected = 200,
        ): LoadAction => ({
          name,
          kind,
          async run(signal) {
            const binding = bindings.get(client)!;
            const data = payload?.();
            const result = await exchange(
              agent,
              binding.base,
              path,
              signal,
              {
                cookie: binding.cookie,
                ...(data && {
                  origin: binding.base,
                  'x-csrf-token': binding.csrf,
                  'idempotency-key': data.key ?? randomUUID(),
                  'content-type': 'application/json',
                  'content-length': String(data.body.length),
                  ...data.headers,
                }),
              },
              data?.body,
            );
            return {
              status: result.status,
              expected: result.status === expected,
              bytes: result.body.length,
            };
          },
        });
        const json = (value: object, key?: string) => () => ({
          body: Buffer.from(JSON.stringify(value)),
          ...(key && { key }),
        });
        const query = '?tenantId=' + tenant;
        const forms = '/api/v1/forms/' + fixtures.formId;
        const task = '/api/v1/tasks/items/' + fixtures.taskId;
        const course = '/api/lms/course?versionId=' + fixtures.versionId;
        const assessmentKey = randomUUID();
        let assessed = false;
        const assessment = json(
          {
            action: 'submit',
            data: { versionId: fixtures.versionId, answers: { q: 0 }, tabSwitchCount: 0 },
            reason,
          },
          assessmentKey,
        );
        const submit = action(
          'lms-assessment-submit',
          'write',
          'lms-sandbox',
          '/api/lms/commands',
          assessment,
        );
        const actions: LoadAction[] =
          actor === 'operator'
            ? [
                action('portal-application-list', 'read', 'foundation', '/api/v1/applications'),
                action(
                  'portal-workflow-feed',
                  'read',
                  'foundation',
                  '/api/v1/work-center/work' + query,
                ),
                action('forms-read', 'read', 'forms', forms + query),
                action(
                  'workflow-read',
                  'read',
                  'workflows',
                  '/api/v1/workflows/runs/' + fixtures.runId + query,
                ),
                action(
                  'task-comment',
                  'write',
                  'tasks',
                  task + '/comment',
                  json({ tenantId: tenant, reason, body: 'Trao đổi giả lập' }),
                ),
                action('forms-interactive-report', 'report', 'forms', forms + '/report' + query),
                action(
                  'lms-interactive-report',
                  'report',
                  'lms-sandbox',
                  '/api/lms/report?courseId=' + fixtures.courseId,
                ),
                action(
                  'lms-xlsx-export',
                  'transfer',
                  'lms-sandbox',
                  '/api/lms/report-export',
                  json({ filters: { courseId: fixtures.courseId }, reason }),
                ),
                action('lms-pdf-upload', 'transfer', 'lms-sandbox', '/api/lms/media', () => ({
                  body: pdf,
                  headers: {
                    'content-type': 'application/pdf',
                    'x-file-name': 'load.pdf',
                    'x-file-size': String(pdf.length),
                    'x-file-sha256': mediaSha,
                    'x-media-id': randomUUID(),
                    'x-owner-unit-id': ids.unitA,
                  },
                })),
              ]
            : actor === 'outside'
              ? [
                  action('lms-course-read', 'read', 'lms-sandbox', course),
                  {
                    ...submit,
                    name: 'lms-assessment-and-replay',
                    async run(signal) {
                      const result = await submit.run(signal);
                      if (result.expected) assessed = true;
                      return result;
                    },
                  },
                  action(
                    'lms-media-download',
                    'transfer',
                    'lms-sandbox',
                    '/api/lms/media/' + fixtures.mediaId + '?versionId=' + fixtures.versionId,
                  ),
                ]
              : [
                  action(
                    'tenant-b-project',
                    'read',
                    'tasks',
                    '/api/v1/tasks/projects/' + fixtures.outsideProjectId + query,
                  ),
                  action(
                    'tenant-b-project-items',
                    'read',
                    'tasks',
                    '/api/v1/tasks/projects/' + fixtures.outsideProjectId + '/items' + query,
                  ),
                  action(
                    'tenant-b-cross-tenant-denial',
                    'read',
                    'tasks',
                    task + query,
                    undefined,
                    404,
                  ),
                ];
        sessions.push({ id: randomUUID(), tenant, actions });
        if (actor === 'outside') assessmentChecks.push(() => assessed);
      }
    await beforeLoad?.();
    const result = await runMixedLoad(sessions, {
      durationMs: loadTargets.durationMs,
      thinkMs: 20000,
      timeoutMs: 15000,
      sampleMs: 15000,
      sample,
    });
    return {
      ...result,
      assessedLearners: assessmentChecks.filter((check) => check()).length,
      host: {
        logicalCpus: cpus().length,
        cpuModel: cpus()[0]?.model,
        totalMemoryBytes: totalmem(),
      },
      issuedAppSessions: seen.size,
      workload: 'closed-loop',
      thinkMs: 20000,
      costInputs: {
        requests: result.requests,
        elapsedSeconds: result.wallMs / 1000,
        transferBytes: result.groups.transfer.bytes,
      },
    };
  } finally {
    agent.destroy();
  }
}
