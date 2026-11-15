import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import type {
  ConfigurationImportEvidence,
  ConfigurationPackage,
  SignedConfigurationReview,
} from '../src/configuration-package.js';
import type { WorkflowActor, WorkflowPermission } from '../src/workflows/access.js';
import type { WorkflowSpec } from '../src/workflows/contracts.js';
import type { Definition } from '../src/workflows/service.js';

async function environment(artifact: string, pool: Pool, side: 'source' | 'target') {
  const file = (path: string) => pathToFileURL(join(artifact, 'dist/src', path)).href;
  const { WorkflowsService } = (await import(
    file('workflows/service.js')
  )) as typeof import('../src/workflows/service.js');
  const { registerWorkflowsRoutes } = (await import(
    file('workflows/routes.js')
  )) as typeof import('../src/workflows/routes.js');
  const { workflowTemplate } = (await import(
    file('workflows/templates.js')
  )) as typeof import('../src/workflows/templates.js');
  const { HttpError } = (await import(file('security.js'))) as typeof import('../src/security.js');
  const { instance_id: instance } = (await pool.query('SELECT instance_id FROM environment_marker'))
    .rows[0];
  const tenant = randomUUID(),
    unit = randomUUID(),
    assignee = randomUUID(),
    person = randomUUID();
  const makeActor = (permissions: WorkflowPermission[]): WorkflowActor => ({
    appCode: 'aio-workflows',
    accountId: randomUUID(),
    personId: randomUUID(),
    tenantIds: [tenant],
    units: [{ tenantId: tenant, orgUnitId: unit }],
    permissions: permissions.map((permission) => ({
      tenantId: tenant,
      orgUnitId: unit,
      permission,
    })),
  });
  const operator = makeActor(['workflows:design', 'workflows:publish', 'workflows:start']);
  const reviewer = makeActor(['workflows:design']);
  let actor = operator;
  let assigneeAvailable = true;
  const service = new WorkflowsService(pool, {
    async validateUnit(space, id) {
      if (space !== tenant || id !== unit) throw new HttpError(400, 'WORKFLOW_REFERENCE_DENIED');
    },
    async assignee(space, targetUnit, id) {
      if (!assigneeAvailable || space !== tenant || targetUnit !== unit || id !== assignee)
        throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
      return { personId: person, name: 'Người xử lý ' + side };
    },
  });
  const server = Fastify({
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  server.setErrorHandler(
    (error: { status?: number; statusCode?: number; code?: string }, _req, reply) =>
      reply.code(error.statusCode ?? error.status ?? 500).send({ error: error.code }),
  );
  registerWorkflowsRoutes(server, {
    service,
    actor: async () => actor,
    lookups: async () => ({
      units: [{ id: unit, name: 'Đơn vị ' + side }],
      accounts: assigneeAvailable
        ? [{ id: assignee, name: 'Người xử lý ' + side, unitIds: [unit] }]
        : [],
    }),
    configurationTransfer: {
      key: randomBytes(32).toString('hex'),
      domain: instance + ':aio-workflows:component-' + side,
    },
  });
  const post = async <T>(
    url: string,
    fields: object = {},
    status = 200,
    key = randomUUID(),
  ): Promise<T> => {
    const response = await server.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': key },
      payload: { tenantId: tenant, reason: 'Diễn tập chuyển cấu hình giữa hai cụm', ...fields },
    });
    assert.equal(
      response.statusCode,
      status,
      url +
        ' → ' +
        (response.statusCode === status
          ? 'expected'
          : ((response.json() as { error?: string }).error ?? 'unexpected')),
    );
    return response.json<T>();
  };
  const command = () => ({
    tenantId: tenant,
    actor: async () => actor,
    reason: 'Tạo lượt kiểm chứng cấu hình',
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  try {
    const spec = workflowTemplate('blank');
    spec.name =
      side === 'source' ? 'Quy trình đã review tại nguồn' : 'Quy trình hiện hành tại đích';
    spec.audienceUnits = [unit];
    spec.nodes = [
      { id: 'start', kind: 'start', label: 'Gửi', next: 'review' },
      {
        id: 'review',
        kind: 'approval',
        label: 'Xem xét',
        assignee,
        dueHours: 24,
        next: 'end',
        form: null,
      },
      { id: 'end', kind: 'end', label: 'Hoàn thành' },
    ];
    const saved = await service.saveDefinition(command(), {
      code: 'promotion-' + side + '-' + randomUUID().slice(0, 8),
      orgUnitId: unit,
      spec,
    });
    const published = await service.publish(command(), saved.id, saved.revision);
    const transfer = '/api/v1/configuration-transfer/workflow/' + saved.id + '/';
    return {
      server,
      service,
      post,
      command,
      tenant,
      unit,
      assignee,
      operator,
      reviewer,
      published,
      transfer,
      as: (value: WorkflowActor) => {
        actor = value;
      },
      setAssigneeAvailable: (value: boolean) => {
        assigneeAvailable = value;
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

type Preview = {
  review: SignedConfigurationReview;
  changes: { path: string; before: string; after: string }[];
  backup: ConfigurationPackage;
};

export async function exportWorkflowPromotion(artifact: string, pool: Pool) {
  const source = await environment(artifact, pool, 'source');
  try {
    const pack = await source.post<ConfigurationPackage>(source.transfer + 'export');
    const preview = await source.post<Preview>(source.transfer + 'preview', {
      package: pack,
      mappings: [],
    });
    assert.deepEqual(preview.changes, []);
    return { pack, sourceReview: preview.review, unit: source.unit, assignee: source.assignee };
  } finally {
    await source.server.close();
  }
}

export async function verifyWorkflowPromotion(
  artifact: string,
  pool: Pool,
  source: Awaited<ReturnType<typeof exportWorkflowPromotion>>,
) {
  const target = await environment(artifact, pool, 'target');
  const { service, command, published, transfer, post } = target;
  const errorCode = async (url: string, payload: object, status: number, code: string) => {
    assert.equal((await post<{ error: string }>(url, payload, status)).error, code);
  };
  try {
    const definition = published.definition.id;
    const original = published.version.id;
    const start = (versionId: string, title: string) =>
      service.start(command(), {
        definitionId: definition,
        versionId,
        unitId: target.unit,
        title,
        answers: { purpose: 'Dữ liệu giả lập', requested_on: '2026-11-13' },
      });
    const run = await start(original, 'Lượt đang chạy trước promotion');
    const pinned = await service.detail(command(), run.id);
    assert.ok(pinned.tasks.length > 0);
    const snapshot = () =>
      pool
        .query(`SELECT version_id,revision,status FROM workflow_runs WHERE id=$1`, [run.id])
        .then(({ rows }) => rows[0]);
    const before = await snapshot();
    const foreign = { package: source.pack, mappings: [] };
    await errorCode(transfer + 'preview', foreign, 400, 'CONFIGURATION_REFERENCE_UNAVAILABLE');
    await errorCode(
      transfer + 'apply',
      { review: source.sourceReview },
      403,
      'CONFIGURATION_REVIEW_INVALID',
    );
    const mappings = [
      { type: 'unit', from: source.unit, to: target.unit },
      { type: 'account', from: source.assignee, to: target.assignee },
    ];
    const input = { package: source.pack, mappings };
    const preview = await post<Preview>(transfer + 'preview', input);
    assert.ok(preview.changes.some(({ path }) => path === 'name'));
    assert.equal(preview.review.payload.revision, published.definition.revision);
    const evidence = preview.review.payload.importEvidence;
    assert.ok(evidence && evidence.mappingCount === 2);
    assert.equal(evidence.packageSha256, source.sourceReview.payload.importEvidence?.packageSha256);
    assert.notEqual(
      evidence.mappingSha256,
      source.sourceReview.payload.importEvidence?.mappingSha256,
    );
    assert.deepEqual((preview.review.payload.content as WorkflowSpec).audienceUnits, [target.unit]);
    assert.ok(
      (preview.review.payload.content as WorkflowSpec).nodes.some(
        (node) => node.kind === 'approval' && node.assignee === target.assignee,
      ),
    );
    const apply = { review: preview.review };
    target.as(target.reviewer);
    await errorCode(transfer + 'apply', apply, 403, 'CONFIGURATION_REVIEW_OWNER_MISMATCH');
    target.as({ ...target.operator, permissions: [] });
    await errorCode(transfer + 'apply', apply, 403, 'WORKFLOW_PERMISSION_DENIED');
    target.as(target.operator);
    target.setAssigneeAvailable(false);
    await errorCode(transfer + 'apply', apply, 400, 'CONFIGURATION_REFERENCE_UNAVAILABLE');
    target.setAssigneeAvailable(true);
    assert.deepEqual(await snapshot(), before);
    const key = randomUUID();
    const changed = await post<Definition>(transfer + 'apply', apply, 200, key);
    assert.equal(changed.latest_version, 1);
    assert.equal(changed.revision, published.definition.revision + 1);
    assert.deepEqual(await post<Definition>(transfer + 'apply', apply, 200, key), changed);
    await errorCode(transfer + 'apply', apply, 409, 'REVISION_CONFLICT');
    const audits = async () =>
      (
        await pool.query<{ evidence: ConfigurationImportEvidence }>(
          `SELECT details->'configurationImport' AS evidence
      FROM workflow_audit WHERE definition_id=$1 AND action='definition.updated' AND details ? 'configurationImport' ORDER BY id`,
          [definition],
        )
      ).rows;
    assert.deepEqual(await audits(), [{ evidence }]);
    const next = await post<typeof published>(
      '/api/v1/workflows/definitions/' + definition + '/publish',
      { expectedRevision: changed.revision },
    );
    assert.equal(next.version.version, 2);
    assert.equal(next.version.spec.name, (source.pack.content as WorkflowSpec).name);
    assert.equal(
      (await start(next.version.id, 'Lượt mới sau promotion')).version_id,
      next.version.id,
    );
    assert.deepEqual(await snapshot(), before);
    const retained = await service.detail(command(), run.id);
    assert.deepEqual(retained.version, pinned.version);
    assert.deepEqual(retained.tasks, pinned.tasks);
    const rollback = await post<Preview>(transfer + 'preview', {
      package: preview.backup,
      mappings: [],
    });
    const recovered = await post<Definition>(transfer + 'apply', { review: rollback.review });
    assert.deepEqual(recovered.draft, preview.backup.content);
    assert.equal(recovered.latest_version, 2);
    assert.equal((await audits()).length, 2);
    assert.deepEqual(await snapshot(), before);
    return {
      distinctPostgresClusters: true,
      distinctReviewDomains: true,
      distinctSourceAndTargetReferences: true,
      identitySimulated: true,
      packageSha256: evidence.packageSha256,
      mappingSha256: evidence.mappingSha256,
      mappedReferences: 2,
      diffEntries: preview.changes.length,
      crossEnvironmentReviewDenied: true,
      actorAndCurrentPermissionChecked: true,
      changedReferenceDenied: true,
      draftCasAndReplay: true,
      promotionAuditEvents: 1,
      publishedSeparately: true,
      pinnedRunRetained: true,
      backupDraftRestored: true,
    };
  } finally {
    await target.server.close();
  }
}
