import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { HttpError } from '../src/security.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { WorkflowsService } from '../src/workflows/service.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import type {
  WorkflowActor,
  WorkflowCommand,
  WorkflowDirectory,
  WorkflowPermission,
} from '../src/workflows/access.js';
import type { DocumentDraftInput } from '../src/workflows/document-library-options.js';

const runtime = await loadLocalConfig(),
  config = await loadWorkflowsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 5 });
const owner = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true, true), max: 1 });
const tenant = randomUUID(),
  unit = randomUUID(),
  otherUnit = randomUUID(),
  otherTenant = randomUUID();
const actor = (roles: WorkflowPermission[], orgUnitId: string | null = unit): WorkflowActor => ({
  accountId: randomUUID(),
  personId: randomUUID(),
  displayName: 'Người dùng giả lập',
  appCode: 'aio-workflows',
  tenantIds: [tenant],
  units: [{ tenantId: tenant, orgUnitId: orgUnitId ?? unit }],
  permissions: roles.map((permission) => ({ tenantId: tenant, orgUnitId, permission })),
});
const author = actor(['workflows:design', 'workflows:publish']);
const publisher = actor(['workflows:publish']);
const reader = actor(['workflows:start']);
const outsider = actor(['workflows:start', 'workflows:design'], otherUnit);
const handler = actor(['workflows:act']);
const directory: WorkflowDirectory = {
  async validateUnit(t, u) {
    if (t !== tenant || (u !== unit && u !== otherUnit))
      throw new HttpError(400, 'WORKFLOW_REFERENCE_DENIED');
  },
  async assignee(t, u, id) {
    if (t !== tenant || u !== unit || id !== handler.accountId)
      throw new HttpError(400, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
    return { personId: handler.personId, name: 'Người xử lý giả lập' };
  },
};
const service = new WorkflowsService(pool, directory);
const c = (a: WorkflowActor): WorkflowCommand => ({
  tenantId: tenant,
  actor: async () => structuredClone(a),
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
  reason: 'Nghiệm thu tài liệu giả lập',
});
const rejects = (code: string) => (error: unknown) =>
  error instanceof HttpError && error.code === code;
const input = (overrides: Partial<DocumentDraftInput> = {}): DocumentDraftInput => ({
  unitId: unit,
  folderId: null,
  title: 'Hướng dẫn mua sắm giả lập',
  content: 'Kiểm tra dữ liệu trước khi gửi đề nghị.',
  viewerUnits: [unit],
  files: [
    {
      fileName: 'huong-dan.txt',
      content: Buffer.from('Tài liệu tổng hợp giả lập').toString('base64'),
    },
  ],
  ...overrides,
});
async function approve(id: string, revision: number) {
  const submitted = await service.transitionDocument(c(author), id, 'submit', revision);
  return service.transitionDocument(c(publisher), id, 'approve', submitted.revision);
}
before(async () => {
  assert.deepEqual((await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-workflows-test' },
  ]);
});
after(async () => {
  await pool.end();
  await owner.end();
});

test('Document folders and exact linked editions follow live IAM across approval, replacement and withdrawal', async () => {
  const parent = await service.saveDocumentFolder(c(author), {
    unitId: unit,
    parentId: null,
    name: 'Quản lý chất lượng',
  });
  const child = await service.saveDocumentFolder(c(author), {
    unitId: unit,
    parentId: parent.id,
    name: 'Mua sắm',
  });
  await assert.rejects(
    service.saveDocumentFolder(c(outsider), {
      unitId: otherUnit,
      parentId: child.id,
      name: 'Sai phạm vi',
    }),
    rejects('WORKFLOW_DOCUMENT_NOT_FOUND'),
  );
  const spec = workflowTemplate('leave');
  spec.audienceUnits = [unit];
  for (const node of spec.nodes) if ('assignee' in node) node.assignee = handler.accountId;
  const definition = await service.saveDefinition(c(author), {
    code: 'document-' + randomUUID().slice(0, 8),
    orgUnitId: unit,
    spec,
  });
  const first = await service.publish(c(publisher), definition.id, definition.revision);
  const second = await service.publish(c(publisher), definition.id, first.definition.revision);
  const data = input({
    folderId: child.id,
    workflow: { definitionId: definition.id, versionId: first.version.id },
  });
  const draft = await service.saveDocument(c(author), data);
  assert.equal((await service.documents(c(reader), {})).items.length, 0);
  await assert.rejects(
    service.documentDetail(c(reader), draft.id),
    rejects('WORKFLOW_DOCUMENT_NOT_FOUND'),
  );
  const pending = await service.transitionDocument(c(author), draft.id, 'submit', draft.revision);
  await assert.rejects(
    service.transitionDocument(c(author), draft.id, 'approve', pending.revision),
    rejects('WORKFLOW_DOCUMENT_SELF_REVIEW'),
  );
  await assert.rejects(
    service.transitionDocument(
      c({ ...publisher, personId: author.personId }),
      draft.id,
      'approve',
      pending.revision,
    ),
    rejects('WORKFLOW_DOCUMENT_SELF_REVIEW'),
  );
  const approved = await service.transitionDocument(
    c(publisher),
    draft.id,
    'approve',
    pending.revision,
  );
  const issue = c(publisher);
  const published = await service.transitionDocument(issue, draft.id, 'issue', approved.revision);
  assert.deepEqual(
    await service.transitionDocument(issue, draft.id, 'issue', approved.revision),
    published,
  );
  const linked = await service.documents(c(reader), { versionId: first.version.id });
  assert.deepEqual(
    linked.items.map(({ id }) => id),
    [draft.id],
  );
  assert.deepEqual(new Set(linked.folders.map(({ id }) => id)), new Set([parent.id, child.id]));
  assert.deepEqual(
    (await service.documents(c(reader), { versionId: second.version.id })).items,
    [],
  );
  const visible = await service.documentDetail(c(reader), draft.id);
  assert.equal(visible.content, data.content);
  assert.equal(visible.history.length, 0);
  const fileId = visible.files[0]!.id;
  const attachment = await service.downloadDocumentFile(c(reader), draft.id, fileId, 1);
  assert.equal(attachment.content.toString(), 'Tài liệu tổng hợp giả lập');
  await assert.rejects(
    service.downloadDocumentFile(c(outsider), draft.id, fileId, 1),
    rejects('WORKFLOW_DOCUMENT_NOT_FOUND'),
  );
  let verdict: 'infected' | 'clean' | 'offline' = 'infected';
  let scans = 0;
  const guarded = new WorkflowsService(pool, directory, undefined, undefined, async (content) => {
    scans++;
    assert.deepEqual(content, attachment.content);
    if (verdict === 'offline') throw new Error('Scanner unavailable');
    return verdict;
  });
  await assert.rejects(
    guarded.downloadDocumentFile(c(outsider), draft.id, fileId, 1),
    rejects('WORKFLOW_DOCUMENT_NOT_FOUND'),
  );
  assert.equal(scans, 0);
  await assert.rejects(
    guarded.downloadDocumentFile(c(reader), draft.id, fileId, 1),
    rejects('WORKFLOW_ATTACHMENT_NOT_FOUND'),
  );
  verdict = 'offline';
  await assert.rejects(
    guarded.downloadDocumentFile(c(reader), draft.id, fileId, 1),
    rejects('WORKFLOW_ATTACHMENT_SCANNER_UNAVAILABLE'),
  );
  verdict = 'clean';
  assert.deepEqual(await guarded.downloadDocumentFile(c(reader), draft.id, fileId, 1), attachment);
  assert.equal(scans, 3);
  await assert.rejects(
    service.documentDetail({ ...c(reader), tenantId: otherTenant }, draft.id),
    rejects('WORKFLOW_PERMISSION_DENIED'),
  );

  const change = {
    ...data,
    content: 'Hướng dẫn phiên bản mới.',
    files: [
      {
        fileName: 'huong-dan-v2.txt',
        content: Buffer.from('Tài liệu mới giả lập').toString('base64'),
      },
    ],
  };
  const edit = await service.saveDocument(c(author), change, draft.id, published.revision);
  assert.equal((await service.documentDetail(c(reader), draft.id)).content, data.content);
  const revised = await approve(draft.id, edit.revision);
  const replaced = await service.transitionDocument(
    c(publisher),
    draft.id,
    'issue',
    revised.revision,
  );
  const current = await service.documentDetail(c(reader), draft.id);
  assert.equal(current.content, change.content);
  await assert.rejects(
    pool.query('INSERT INTO workflow_document_version_files VALUES($1,$2,1,$3,2)', [
      tenant,
      draft.id,
      current.files[0]!.id,
    ]),
    /Invalid slot for a document snapshot/,
  );
  await assert.rejects(
    service.documentDetail(c(reader), draft.id, 1, true),
    rejects('WORKFLOW_DOCUMENT_NOT_FOUND'),
  );
  await assert.rejects(
    service.downloadDocumentFile(c(reader), draft.id, fileId, 1),
    rejects('WORKFLOW_DOCUMENT_NOT_FOUND'),
  );
  assert.deepEqual(await service.downloadDocumentFile(c(author), draft.id, fileId, 1), attachment);
  const restored = await service.restoreDocumentDraft(c(author), draft.id, 1, replaced.revision);
  assert.equal(restored.version, 3);
  const prepared = await service.documentDetail(c(author), draft.id);
  assert.equal(prepared.history[0]?.details.actorName, author.displayName);
  assert.equal(prepared.history[0]?.actor_account_id, author.accountId);
  assert.equal(prepared.content, data.content);
  assert.equal(prepared.files[0]!.id, fileId);
  assert.equal((await service.documentDetail(c(reader), draft.id)).version, 2);
  const revoked = { ...reader, permissions: [] };
  await assert.rejects(
    service.documentDetail(c(revoked), draft.id),
    rejects('WORKFLOW_DOCUMENT_NOT_FOUND'),
  );
  await service.transitionDocument(c(publisher), draft.id, 'withdraw', restored.revision);
  await assert.rejects(
    service.documentDetail(c(reader), draft.id),
    rejects('WORKFLOW_DOCUMENT_NOT_FOUND'),
  );
  assert.equal((await service.documentDetail(c(author), draft.id, 1)).content, data.content);
});

test('Document snapshots enforce quarantine, audience publication rights, CAS and transactional audit', async () => {
  const quarantined = await service.saveDocument(
    c(author),
    input({
      title: 'Bản nháp có tệp cách ly',
      files: [
        { fileName: 'giay-to.pdf', content: Buffer.from('Sai định dạng PDF').toString('base64') },
      ],
    }),
  );
  const bad = await service.documentDetail(c(author), quarantined.id);
  assert.equal(bad.files[0]?.scan_status, 'quarantined');
  await assert.rejects(
    service.transitionDocument(c(author), bad.id, 'submit', bad.revision!),
    rejects('WORKFLOW_DOCUMENT_FILE_QUARANTINED'),
  );
  await assert.rejects(
    service.downloadDocumentFile(c(author), bad.id, bad.files[0]!.id),
    rejects('WORKFLOW_DOCUMENT_NOT_FOUND'),
  );

  const data = input({ title: 'Tài liệu hai đơn vị', viewerUnits: [unit, otherUnit] });
  const doc = await service.saveDocument(c(author), data);
  const attempts = await Promise.allSettled(
    ['Cập nhật thứ nhất', 'Cập nhật thứ hai'].map((content) =>
      service.saveDocument(c(author), { ...data, content }, doc.id, doc.revision),
    ),
  );
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  const failed = attempts.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )!;
  assert(rejects('REVISION_CONFLICT')(failed.reason));
  const latest = await service.documentDetail(c(author), doc.id);
  const approved = await approve(doc.id, latest.revision!);
  await assert.rejects(
    service.transitionDocument(c(publisher), doc.id, 'issue', approved.revision),
    rejects('WORKFLOW_PERMISSION_DENIED'),
  );

  const wide = actor(['workflows:publish'], null);
  const trigger = 'test_doc_audit_' + randomUUID().replaceAll('-', '');
  assert.deepEqual((await owner.query('SELECT instance_id,purpose FROM environment_marker')).rows, [
    { instance_id: runtime.instanceId, purpose: 'tlqm-aio-workflows-test' },
  ]);
  await owner.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.tenant_id='${tenant}' AND NEW.action='document.issue' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
    RETURN NEW; END $$`);
  await owner.query(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON workflow_audit FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );
  const command = c(wide);
  try {
    await assert.rejects(
      service.transitionDocument(command, doc.id, 'issue', approved.revision),
      /synthetic audit failure/,
    );
    const unchanged = await service.documentDetail(c(author), doc.id);
    assert.equal(unchanged.published, false);
    assert.equal(unchanged.revision, approved.revision);
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM workflow_receipts WHERE tenant_id=$1 AND idempotency_key=$2',
          [tenant, command.idempotencyKey],
        )
      ).rowCount,
      0,
    );
  } finally {
    await owner.query(`DROP TRIGGER ${trigger} ON workflow_audit`);
    await owner.query(`DROP FUNCTION ${trigger}()`);
  }
  await service.transitionDocument(command, doc.id, 'issue', approved.revision);
  assert.equal((await service.documentDetail(c(outsider), doc.id)).published, true);
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM workflow_audit WHERE tenant_id=$1 AND details->>'documentId'=$2 AND action='document.issue'",
        [tenant, doc.id],
      )
    ).rowCount,
    1,
  );
});
