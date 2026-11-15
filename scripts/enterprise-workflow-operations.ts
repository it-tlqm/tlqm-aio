import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { ids } from '../src/fixtures.js';
import type { WorkflowActor } from '../src/workflows/access.js';
import type { IntakeReference } from '../src/workflows/intakes.js';
import type { OperationItem } from '../src/workflows/operations-options.js';

export async function verifyWorkflowOperations(
  artifact: string,
  pool: Pool,
  secondPool: Pool,
  source: IntakeReference,
) {
  const load = (file: string) => pathToFileURL(join(artifact, 'dist/src', file)).href;
  const { WorkflowsService } = (await import(
    load('workflows/service.js')
  )) as typeof import('../src/workflows/service.js');
  const { registerWorkflowsRoutes } = (await import(
    load('workflows/routes.js')
  )) as typeof import('../src/workflows/routes.js');
  const { HttpError } = (await import(load('security.js'))) as typeof import('../src/security.js');
  const tenant = source.tenantId,
    unit = source.unitId;
  const operator: WorkflowActor = {
    appCode: 'aio-workflows',
    accountId: ids.admin,
    personId: ids.admin,
    tenantIds: [tenant],
    units: [],
    permissions: ['workflows:publish', 'workflows:manage'].map((permission) => ({
      tenantId: tenant,
      permission,
      orgUnitId: unit,
    })),
  };
  let actor = operator;
  let available = false;
  const delivered: IntakeReference[] = [];
  const directory = {
    validateUnit: async () => {},
    linkRecipient: async () => operator,
    assignee: async () => ({ personId: ids.admin, name: 'Fixture' }),
  };
  const destination = {
    recipients: async () => [],
    assertRecipient: async () => {
      if (!available) throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
    },
    receive: async (reference: IntakeReference) => {
      delivered.push(reference);
    },
  };
  const first = new WorkflowsService(pool, directory, destination);
  const second = new WorkflowsService(secondPool, directory, destination);
  const server = Fastify({
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  server.setErrorHandler((error: { statusCode?: number; code?: string }, _request, reply) =>
    reply.code(error.statusCode ?? 500).send({ error: error.code }),
  );
  registerWorkflowsRoutes(server, {
    service: first,
    actor: async () => actor,
    lookups: async () => ({}),
  });
  const read = async (fields: Record<string, string> = {}, expected = 200) => {
    const result = await server.inject({
      method: 'GET',
      url:
        '/api/v1/workflows/operations?' +
        new URLSearchParams({ tenantId: tenant, kind: 'intake', view: 'attention', ...fields }),
    });
    assert.equal(
      result.statusCode,
      expected,
      'Operations query returned ' + result.body.slice(0, 140),
    );
    if (expected === 200) assert.equal(result.headers['cache-control'], 'private, no-store');
    return result.json<{ items: OperationItem[]; nextCursor: string | null }>();
  };
  const retry = async (revision: number, expected = 200, key = randomUUID()) => {
    const result = await server.inject({
      method: 'POST',
      url: '/api/v1/workflows/intake-jobs/' + source.id + '/retry',
      headers: { 'idempotency-key': key },
      payload: {
        tenantId: tenant,
        expectedRevision: revision,
        reason: 'Đã khôi phục quyền tiếp nhận fixture',
      },
    });
    assert.equal(result.statusCode, expected, 'Retry returned ' + result.body.slice(0, 140));
    return result.json();
  };
  try {
    const locked = await first.processModuleIntakes();
    assert.equal(locked, 1);
    const attention = await read({ runId: source.runId });
    assert.equal(attention.items.length, 1);
    const job = attention.items[0]!;
    assert.deepEqual(
      [job.id, job.runId, job.status, job.attempts, job.canRetry, job.version],
      [source.id, source.runId, 'blocked', 1, true, 1],
    );
    assert.equal(job.errorCode, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
    assert.deepEqual(
      job.history.map(({ status, attempt }) => [status, attempt]),
      [['blocked', 1]],
    );
    assert.ok(!Object.hasOwn(job, 'sourceTaskId') && !Object.hasOwn(job, 'versionId'));
    const { definition_id: definition } = (
      await pool.query('SELECT definition_id FROM workflow_runs WHERE id=$1', [source.runId])
    ).rows[0];
    const schedule = randomUUID();
    await pool.query(
      `INSERT INTO workflow_draft_schedules(id,tenant_id,org_unit_id,definition_id,version_id,title,recipient_account_id,recipient_person_id,
      cadence,every,start_date,local_time,created_by) VALUES ($1,$2,$3,$4,$5,'Lịch giả lập',$6,$6,'daily',1,current_date,'08:00',$6)`,
      [schedule, tenant, unit, definition, source.versionId, ids.admin],
    );
    await pool.query(
      `INSERT INTO workflow_scheduled_draft_jobs(id,tenant_id,schedule_id,scheduled_for,next_attempt_at,created_at)
      SELECT gen_random_uuid(),$1,$2,now()-n*interval '1 hour',now()-interval '3 minutes',now()-n*interval '1 hour'
      FROM generate_series(1,52) n`,
      [tenant, schedule],
    );
    const schedules = await read({ kind: 'schedule' });
    assert.equal(schedules.items.length, 50);
    assert.ok(
      schedules.nextCursor &&
        schedules.items.every((item) => item.overdue && !item.canRetry && item.runId === null),
    );
    const rest = await read({ kind: 'schedule', after: schedules.nextCursor });
    assert.equal(rest.items.length, 2);
    assert.equal(new Set([...schedules.items, ...rest.items].map(({ id }) => id)).size, 52);
    assert.deepEqual(await read({ kind: 'schedule', after: source.id }), {
      items: [],
      nextCursor: null,
    });
    for (const kind of ['email', 'link'])
      assert.deepEqual(await read({ kind }), { items: [], nextCursor: null });

    actor = {
      ...operator,
      permissions: [{ tenantId: tenant, permission: 'workflows:publish', orgUnitId: ids.unitC }],
    };
    assert.deepEqual(await read(), { items: [], nextCursor: null });
    await retry(1, 403);
    actor = {
      ...operator,
      permissions: operator.permissions.filter(
        ({ permission }) => permission === 'workflows:publish',
      ),
    };
    assert.equal((await read()).items[0]?.runId, null);
    await read({ runId: source.runId }, 403);
    actor = { ...operator, permissions: [] };
    await read({}, 403);
    actor = operator;
    await read({ tenantId: ids.tenantB }, 403);
    await retry(2, 409);
    available = true;
    const key = randomUUID();
    assert.deepEqual(await retry(1, 200, key), { id: source.id, status: 'queued' });
    assert.deepEqual(await retry(1, 200, key), { id: source.id, status: 'queued' });
    await retry(1, 409);
    assert.equal((await read({ view: 'active' })).items[0]?.id, source.id);
    assert.deepEqual(
      (await Promise.all([first.processModuleIntakes(), second.processModuleIntakes()])).sort(),
      [0, 1],
    );
    const finished = (await read({ view: 'resolved', runId: source.runId })).items[0];
    assert.deepEqual(
      [finished?.status, finished?.canRetry, finished?.attempts],
      ['done', false, 2],
    );
    assert.deepEqual(
      finished?.history.map(({ status }) => status),
      ['done', 'blocked'],
    );
    assert.deepEqual(delivered, [source]);
    assert.deepEqual(await read(), { items: [], nextCursor: null });
    const audit = (
      await pool.query(
        `SELECT count(*)::int AS n FROM workflow_audit
      WHERE action='intake.retry_requested' AND details->>'jobId'=$1`,
        [source.id],
      )
    ).rows[0]?.n;
    assert.equal(audit, 1);
    return {
      blockedReason: job.errorCode,
      overdueJobs: 52,
      cursor: true,
      unitAndTenantIsolation: true,
      runLinkPermission: true,
      livePermissionDenied: true,
      retryCasAndReplay: true,
      retryAuditEvents: audit,
      workers: 2,
      deliveries: delivered.length,
      history: ['blocked', 'done'],
      destinationSimulated: true,
      identitySimulated: true,
    };
  } finally {
    await server.close();
  }
}
