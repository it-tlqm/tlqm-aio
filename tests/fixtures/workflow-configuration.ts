import { randomUUID } from 'node:crypto';
import pg from 'pg';
import assert from 'node:assert/strict';
import { loadLocalConfig } from '../../src/config.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../../src/workflows/database.js';
import { WorkflowsService } from '../../src/workflows/service.js';
import { workflowTemplate } from '../../src/workflows/templates.js';
import type {
  WorkflowActor,
  WorkflowCommand,
  WorkflowPermission,
} from '../../src/workflows/access.js';
import { HttpError } from '../../src/security.js';
export async function workflowConfigurationFixture() {
  const runtime = await loadLocalConfig(),
    config = await loadWorkflowsConfig(runtime.instanceId),
    pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 3 }),
    tenant = randomUUID(),
    unit = randomUUID();
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-workflows-test',
  );
  const actor = (permissions: WorkflowPermission[]): WorkflowActor => ({
    appCode: 'aio-workflows',
    accountId: randomUUID(),
    personId: randomUUID(),
    tenantIds: [tenant],
    units: [{ tenantId: tenant, orgUnitId: unit }],
    permissions: permissions.map((permission) => ({
      tenantId: tenant,
      permission,
      orgUnitId: null,
    })),
  });
  const designer = actor(['workflows:design', 'workflows:publish', 'workflows:start']),
    reviewer = actor(['workflows:act']);
  const service = new WorkflowsService(pool, {
    async validateUnit(t, id) {
      if (t !== tenant || id !== unit) throw new HttpError(400, 'WORKFLOW_REFERENCE_DENIED');
    },
    async assignee(t, u, id) {
      if (t !== tenant || (u !== null && u !== unit) || id !== reviewer.accountId)
        throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
      return { personId: reviewer.personId, name: 'Người duyệt giả lập' };
    },
  });
  const c = (a = designer): WorkflowCommand => ({
    tenantId: tenant,
    actor: async () => structuredClone(a),
    reason: 'Kiểm thử cấu hình quy trình giả lập',
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  const spec = workflowTemplate('blank');
  spec.audienceUnits = [unit];
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Gửi', next: 'review' },
    {
      id: 'review',
      kind: 'approval',
      label: 'Xem xét',
      assignee: reviewer.accountId,
      dueHours: 24,
      next: 'end',
      form: null,
    },
    { id: 'end', kind: 'end', label: 'Hoàn thành' },
  ];
  const saved = await service.saveDefinition(c(), {
      code: 'transfer-' + randomUUID().slice(0, 8),
      orgUnitId: unit,
      spec,
    }),
    published = await service.publish(c(), saved.id, saved.revision);
  const lookups = async () => ({
    units: [{ id: unit, name: 'Đơn vị giả lập' }],
    accounts: [{ id: reviewer.accountId, name: 'Người duyệt giả lập', unitIds: [unit] }],
  });
  return { pool, runtime, tenant, unit, designer, reviewer, service, c, lookups, published };
}
