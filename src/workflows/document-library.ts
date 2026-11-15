import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { maxAttachmentBytes } from '../forms/attachment-fields.js';
import type { AttachmentField } from '../forms/attachment-fields.js';
import { HttpError } from '../security.js';
import { workflowAllowed, workflowRequire } from './access.js';
import type { WorkflowActor, WorkflowDirectory } from './access.js';
import { inspectAttachment, verifyStoredWorkflowAttachment } from './attachment-content.js';
import type { UploadScan } from '../upload-scan.js';
import { workflowUuid } from './contracts.js';
import type {
  DocumentAction,
  DocumentDraftInput,
  DocumentFile,
  DocumentFolder,
  DocumentItem,
  DocumentReviewState,
} from './document-library-options.js';

type Db = Pool | PoolClient;
type Document = {
  id: string;
  tenant_id: string;
  org_unit_id: string;
  folder_id: string | null;
  draft_version: number;
  issued_version: number | null;
  review_state: DocumentReviewState;
  published: boolean;
  revision: number;
  updated_at: Date;
};
type Version = {
  version: number;
  title: string;
  content: string;
  viewer_units: string[];
  definition_id: string | null;
  workflow_version_id: string | null;
  file_count: number;
  created_by: string;
  created_person_id: string;
  created_at: Date;
};
const filePolicy: AttachmentField = {
  formats: ['pdf', 'docx', 'xlsx', 'txt', 'png', 'jpeg'],
  maxFiles: 4,
  maxBytes: maxAttachmentBytes,
};
const notFound = () => new HttpError(404, 'WORKFLOW_DOCUMENT_NOT_FOUND');
const invalid = () => new HttpError(400, 'WORKFLOW_DOCUMENT_INVALID');
const designer = (actor: WorkflowActor, tenant: string, unit: string) =>
  workflowAllowed(actor, tenant, 'workflows:design', unit);
const publisher = (actor: WorkflowActor, tenant: string, unit: string) =>
  workflowAllowed(actor, tenant, 'workflows:publish', unit);
const libraryViewerUnits = (actor: WorkflowActor, tenant: string) => [
  ...new Set(
    actor.units
      .filter(
        ({ tenantId, orgUnitId }) =>
          tenantId === tenant &&
          (workflowAllowed(actor, tenant, 'workflows:start', orgUnitId) ||
            workflowAllowed(actor, tenant, 'workflows:act', orgUnitId)),
      )
      .map(({ orgUnitId }) => orgUnitId),
  ),
];

const view = (
  doc: Document,
  version: Pick<Version, 'title' | 'version' | 'created_at'>,
  manage: boolean,
): DocumentItem => ({
  id: doc.id,
  unitId: doc.org_unit_id,
  folderId: doc.folder_id,
  title: version.title,
  version: version.version,
  published: doc.published,
  updatedAt: (manage ? doc.updated_at : version.created_at).toISOString(),
  ...(manage && {
    revision: doc.revision,
    reviewState: doc.review_state,
    issuedVersion: doc.issued_version,
  }),
});
const expectedRevision = (actual: number, expected?: number) => {
  if (actual !== expected) throw new HttpError(409, 'REVISION_CONFLICT');
};

export class WorkflowDocumentLibrary {
  constructor(
    private readonly directory: WorkflowDirectory,
    private readonly uploadScan?: UploadScan,
  ) {}

  async get(db: Db, tenant: string, id: string) {
    workflowUuid(id);
    const { rows } = await db.query<Document>(
      'SELECT * FROM workflow_documents WHERE (tenant_id,id)=($1,$2)',
      [tenant, id],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  private async version(db: Db, doc: Document, version: number) {
    const { rows } = await db.query<Version>(
      'SELECT * FROM workflow_document_versions WHERE (tenant_id,document_id,version)=($1,$2,$3)',
      [doc.tenant_id, doc.id, version],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  private async folder(db: Db, tenant: string, unit: string, id: string) {
    const { rows } = await db.query<DocumentFolder>(
      'SELECT id,org_unit_id,parent_id,name,revision FROM workflow_document_folders WHERE (tenant_id,org_unit_id,id)=($1,$2,$3)',
      [tenant, unit, id],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  async list(
    db: Db,
    tenant: string,
    actor: WorkflowActor,
    filters: { after?: string; search?: string; versionId?: string; folderId?: string },
  ) {
    const units = actor.permissions
      .filter(
        ({ tenantId, permission }) =>
          tenantId === tenant &&
          (permission === 'workflows:design' || permission === 'workflows:publish'),
      )
      .map(({ orgUnitId }) => orgUnitId);
    const all = units.includes(null);
    const managed = units.filter((id): id is string => id !== null);
    const publicUnits = libraryViewerUnits(actor, tenant);
    const { rows } = await db.query<
      Document & Pick<Version, 'title' | 'version'> & { managed: boolean; version_at: Date }
    >(
      `WITH scoped AS (
        SELECT d.*, ($2 OR d.org_unit_id=ANY($3::uuid[])) AS managed
        FROM workflow_documents d WHERE tenant_id=$1
      ), visible AS (
        SELECT d.*,v.title,v.version,v.created_at AS version_at,
          CASE WHEN d.managed AND $5::uuid IS NULL THEN d.updated_at ELSE v.created_at END AS visible_at
        FROM scoped d JOIN workflow_document_versions v ON (v.tenant_id,v.document_id,v.version)=
          (d.tenant_id,d.id,CASE WHEN d.managed AND $5::uuid IS NULL THEN d.draft_version ELSE d.issued_version END)
        WHERE (d.managed AND $5::uuid IS NULL OR d.published AND (d.managed OR v.viewer_units && $4::uuid[]))
          AND ($5::uuid IS NULL OR v.workflow_version_id=$5)
          AND ($6::uuid IS NULL OR d.folder_id=$6)
          AND ($7::text='' OR position(lower($7) in lower(v.title))>0)
      )
      SELECT visible.* FROM visible
      WHERE ($8::uuid IS NULL OR (visible_at,id)<(SELECT visible_at,id FROM visible WHERE id=$8))
      ORDER BY visible_at DESC,id DESC LIMIT 61`,
      [
        tenant,
        all,
        managed,
        publicUnits,
        filters.versionId ?? null,
        filters.folderId ?? null,
        filters.search?.trim() ?? '',
        filters.after ?? null,
      ],
    );
    const page = rows.slice(0, 60);
    const folders = (
      await db.query<DocumentFolder>(
        `WITH RECURSIVE accessible AS (
        SELECT f.id,f.org_unit_id,f.parent_id,f.name,f.revision FROM workflow_document_folders f
        WHERE f.tenant_id=$1 AND ($2 OR f.org_unit_id=ANY($3::uuid[]) OR EXISTS (
          SELECT 1 FROM workflow_documents d JOIN workflow_document_versions v
            ON (v.tenant_id,v.document_id,v.version)=(d.tenant_id,d.id,d.issued_version)
          WHERE (d.tenant_id,d.folder_id)=(f.tenant_id,f.id) AND d.published AND v.viewer_units && $4::uuid[]
        ))
        UNION
        SELECT p.id,p.org_unit_id,p.parent_id,p.name,p.revision FROM workflow_document_folders p
          JOIN accessible c ON (p.org_unit_id,p.id)=(c.org_unit_id,c.parent_id) WHERE p.tenant_id=$1
      ) SELECT * FROM accessible ORDER BY name,id LIMIT 500`,
        [tenant, all, managed, publicUnits],
      )
    ).rows;
    return {
      items: page.map((doc) =>
        view(
          doc,
          { title: doc.title, version: doc.version, created_at: doc.version_at },
          doc.managed && !filters.versionId,
        ),
      ),
      folders,
      nextAfter: rows.length > 60 ? page.at(-1)!.id : null,
    };
  }

  private async read(
    db: Db,
    tenant: string,
    actor: WorkflowActor,
    id: string,
    number?: number,
    issuedOnly = false,
  ) {
    const doc = await this.get(db, tenant, id);
    const canDraft = designer(actor, tenant, doc.org_unit_id);
    const canPublish = publisher(actor, tenant, doc.org_unit_id);
    const manage = canDraft || canPublish;
    const current =
      manage && !issuedOnly ? doc.draft_version : doc.published ? doc.issued_version : null;
    if (!current || ((!manage || issuedOnly) && number !== undefined && number !== current))
      throw notFound();
    const version = await this.version(db, doc, number ?? current);
    if (
      !manage &&
      !libraryViewerUnits(actor, tenant).some((unit) => version.viewer_units.includes(unit))
    )
      throw notFound();
    return { doc, version, canDraft, canPublish, manage };
  }

  private files(db: Db, doc: Document, version: number) {
    return db.query<DocumentFile>(
      `SELECT f.id,f.file_name,f.byte_count,f.format,f.scan_status FROM workflow_document_version_files l
       JOIN workflow_document_files f ON (f.tenant_id,f.document_id,f.id)=(l.tenant_id,l.document_id,l.file_id)
       WHERE (l.tenant_id,l.document_id,l.version)=($1,$2,$3) ORDER BY l.position`,
      [doc.tenant_id, doc.id, version],
    );
  }

  async detail(
    db: Db,
    tenant: string,
    actor: WorkflowActor,
    id: string,
    number?: number,
    issuedOnly?: boolean,
  ) {
    const { doc, version, canDraft, canPublish, manage } = await this.read(
      db,
      tenant,
      actor,
      id,
      number,
      issuedOnly,
    );
    const [files, versions, history] = await Promise.all([
      this.files(db, doc, version.version),
      manage && !issuedOnly
        ? db.query<{ version: number; title: string; createdAt: Date }>(
            'SELECT version,title,created_at AS "createdAt" FROM workflow_document_versions WHERE (tenant_id,document_id)=($1,$2) ORDER BY version DESC LIMIT 100',
            [tenant, id],
          )
        : null,
      manage && !issuedOnly
        ? db.query(
            `SELECT id,action,reason,actor_account_id,occurred_at,details FROM workflow_audit
         WHERE tenant_id=$1 AND action LIKE 'document.%' AND details->>'documentId'=$2 ORDER BY id DESC LIMIT 100`,
            [tenant, id],
          )
        : null,
    ]);
    return {
      ...view(doc, version, manage && !issuedOnly),
      content: version.content,
      workflow:
        version.definition_id && version.workflow_version_id
          ? { definitionId: version.definition_id, versionId: version.workflow_version_id }
          : null,
      ...(manage && !issuedOnly && { viewerUnits: version.viewer_units }),
      files: files.rows,
      canDraft: canDraft && !issuedOnly,
      canPublish: canPublish && !issuedOnly,
      versions:
        versions?.rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) ?? [],
      history: history?.rows ?? [],
    };
  }

  async download(
    db: Db,
    tenant: string,
    actor: WorkflowActor,
    id: string,
    fileId: string,
    number?: number,
    issuedOnly?: boolean,
  ) {
    workflowUuid(fileId);
    const { doc, version } = await this.read(db, tenant, actor, id, number, issuedOnly);
    const { rows } = await db.query<{ fileName: string; content: Buffer; checksum: string }>(
      `SELECT f.file_name AS "fileName",f.content,f.checksum FROM workflow_document_version_files l
       JOIN workflow_document_files f ON (f.tenant_id,f.document_id,f.id)=(l.tenant_id,l.document_id,l.file_id)
       WHERE (l.tenant_id,l.document_id,l.version,l.file_id)=($1,$2,$3,$4) AND f.scan_status='ready'`,
      [tenant, doc.id, version.version, fileId],
    );
    const file = rows[0];
    if (!file) throw notFound();
    if (this.uploadScan)
      await verifyStoredWorkflowAttachment(file.content, file.checksum, this.uploadScan);
    return { fileName: file.fileName, content: file.content };
  }

  async authorizeFolder(
    db: Db,
    tenant: string,
    actor: WorkflowActor,
    unit: string,
    parent: string | null,
    id?: string,
  ) {
    workflowUuid(unit);
    workflowRequire(actor, tenant, 'workflows:design', unit);
    await this.directory.validateUnit(tenant, unit);
    if (id) {
      workflowUuid(id);
      const folder = await this.folder(db, tenant, unit, id);
      if (folder.parent_id !== parent) throw invalid();
    } else if (parent) {
      workflowUuid(parent);
      await this.folder(db, tenant, unit, parent);
      const { rows } = await db.query<{ depth: number }>(
        `WITH RECURSIVE levels AS (
           SELECT id,parent_id,1 AS depth FROM workflow_document_folders WHERE (tenant_id,org_unit_id,id)=($1,$2,$3)
           UNION ALL SELECT f.id,f.parent_id,l.depth+1 FROM workflow_document_folders f
             JOIN levels l ON f.id=l.parent_id WHERE (f.tenant_id,f.org_unit_id)=($1,$2) AND l.depth<8
         ) SELECT max(depth)::integer AS depth FROM levels`,
        [tenant, unit, parent],
      );
      if (rows[0]!.depth >= 8) throw invalid();
    }
  }

  async saveFolder(
    db: Db,
    tenant: string,
    actor: WorkflowActor,
    input: { unitId: string; parentId: string | null; name: string },
    id?: string,
    revision?: number,
  ) {
    const name = typeof input.name === 'string' ? input.name.trim().normalize('NFC') : '';
    if (!name || name.length > 120) throw invalid();
    if (id) {
      expectedRevision((await this.folder(db, tenant, input.unitId, id)).revision, revision);
      return (
        await db.query<DocumentFolder>(
          'UPDATE workflow_document_folders SET name=$4,revision=revision+1,updated_at=now() WHERE (tenant_id,org_unit_id,id)=($1,$2,$3) RETURNING id,org_unit_id,parent_id,name,revision',
          [tenant, input.unitId, id, name],
        )
      ).rows[0]!;
    }
    return (
      await db.query<DocumentFolder>(
        'INSERT INTO workflow_document_folders(id,tenant_id,org_unit_id,parent_id,name,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,org_unit_id,parent_id,name,revision',
        [randomUUID(), tenant, input.unitId, input.parentId, name, actor.accountId],
      )
    ).rows[0]!;
  }

  private async validateAudience(
    db: Db,
    tenant: string,
    unit: string,
    viewers: string[],
    workflow?: DocumentDraftInput['workflow'],
  ) {
    if (
      !Array.isArray(viewers) ||
      viewers.length < 1 ||
      viewers.length > 50 ||
      new Set(viewers).size !== viewers.length
    )
      throw invalid();
    for (const viewer of viewers) {
      workflowUuid(viewer);
      await this.directory.validateUnit(tenant, viewer);
    }
    if (!workflow) return;
    workflowUuid(workflow.definitionId);
    workflowUuid(workflow.versionId);
    const { rows } = await db.query<{ audience: string[] }>(
      `SELECT v.spec->'audienceUnits' AS audience FROM workflow_versions v
       JOIN workflow_definitions d ON (d.tenant_id,d.id)=(v.tenant_id,v.definition_id)
       WHERE (v.tenant_id,v.definition_id,v.id,d.org_unit_id)=($1,$2,$3,$4)`,
      [tenant, workflow.definitionId, workflow.versionId, unit],
    );
    if (!rows[0] || viewers.some((viewer) => !rows[0]!.audience.includes(viewer))) throw invalid();
  }

  async authorizeDraft(
    db: Db,
    tenant: string,
    actor: WorkflowActor,
    input: DocumentDraftInput,
    id?: string,
  ) {
    workflowUuid(input.unitId);
    workflowRequire(actor, tenant, 'workflows:design', input.unitId);
    await this.directory.validateUnit(tenant, input.unitId);
    if (input.folderId) {
      workflowUuid(input.folderId);
      await this.folder(db, tenant, input.unitId, input.folderId);
    }
    if (id) {
      const doc = await this.get(db, tenant, id);
      if (doc.org_unit_id !== input.unitId || doc.folder_id !== input.folderId) throw notFound();
    }
    await this.validateAudience(db, tenant, input.unitId, input.viewerUnits, input.workflow);
  }

  async saveDraft(
    db: Db,
    tenant: string,
    actor: WorkflowActor,
    input: DocumentDraftInput,
    id?: string,
    revision?: number,
  ) {
    const title = typeof input.title === 'string' ? input.title.trim().normalize('NFC') : '';
    if (
      !title ||
      title.length > 160 ||
      typeof input.content !== 'string' ||
      input.content.length > 20000 ||
      !Array.isArray(input.files) ||
      input.files.length > filePolicy.maxFiles ||
      (!input.content.trim() && !input.files.length)
    )
      throw invalid();
    const previous = id ? await this.get(db, tenant, id) : undefined;
    if (previous) {
      expectedRevision(previous.revision, revision);
      if (previous.review_state === 'pending') throw new HttpError(409, 'WORKFLOW_DOCUMENT_STATE');
    }
    const documentId = previous?.id ?? randomUUID();
    const version = (previous?.draft_version ?? 0) + 1;
    if (!previous)
      await db.query(
        `INSERT INTO workflow_documents(id,tenant_id,org_unit_id,folder_id,draft_version,review_state,created_by)
       VALUES($1,$2,$3,$4,$5,'draft',$6)`,
        [documentId, tenant, input.unitId, input.folderId, version, actor.accountId],
      );
    await db.query(
      `INSERT INTO workflow_document_versions(tenant_id,document_id,version,title,content,viewer_units,definition_id,workflow_version_id,file_count,created_by,created_person_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        tenant,
        documentId,
        version,
        title,
        input.content,
        input.viewerUnits,
        input.workflow?.definitionId ?? null,
        input.workflow?.versionId ?? null,
        input.files.length,
        actor.accountId,
        actor.personId,
      ],
    );
    const fileIds = new Set<string>();
    let size = 0;
    for (const [index, file] of input.files.entries()) {
      let fileId: string, byteCount: number;
      if ('reuseId' in file) {
        workflowUuid(file.reuseId);
        if (!previous) throw invalid();
        const { rows } = await db.query<{ byte_count: number }>(
          'SELECT byte_count FROM workflow_document_files WHERE (tenant_id,document_id,id)=($1,$2,$3)',
          [tenant, documentId, file.reuseId],
        );
        if (!rows[0]) throw notFound();
        fileId = file.reuseId;
        byteCount = rows[0].byte_count;
      } else {
        const checked = await inspectAttachment(
          file.fileName,
          file.content,
          filePolicy,
          this.uploadScan,
        );
        fileId = randomUUID();
        byteCount = checked.byteCount;
        await db.query(
          `INSERT INTO workflow_document_files(id,tenant_id,document_id,file_name,byte_count,format,checksum,scan_status,content)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            fileId,
            tenant,
            documentId,
            checked.fileName,
            byteCount,
            checked.format,
            checked.checksum,
            checked.status,
            checked.content,
          ],
        );
      }
      if (fileIds.has(fileId)) throw invalid();
      fileIds.add(fileId);
      size += byteCount;
      if (size > maxAttachmentBytes) throw new HttpError(413, 'WORKFLOW_ATTACHMENT_TOO_LARGE');
      await db.query('INSERT INTO workflow_document_version_files VALUES($1,$2,$3,$4,$5)', [
        tenant,
        documentId,
        version,
        fileId,
        index + 1,
      ]);
    }
    if (previous) await this.activateDraft(db, previous, version);
    return await this.get(db, tenant, documentId);
  }

  private activateDraft(db: Db, doc: Document, version: number) {
    return db.query(
      `UPDATE workflow_documents SET draft_version=$3,review_state='draft',revision=revision+1,updated_at=now()
       WHERE (tenant_id,id)=($1,$2)`,
      [doc.tenant_id, doc.id, version],
    );
  }

  async restoreDraft(
    db: Db,
    doc: Document,
    actor: WorkflowActor,
    source: number,
    revision: number,
  ) {
    expectedRevision(doc.revision, revision);
    if (doc.review_state === 'pending' || source === doc.draft_version)
      throw new HttpError(409, 'WORKFLOW_DOCUMENT_STATE');
    const old = await this.version(db, doc, source);
    const version = doc.draft_version + 1;
    await this.validateAudience(
      db,
      doc.tenant_id,
      doc.org_unit_id,
      old.viewer_units,
      old.definition_id && old.workflow_version_id
        ? {
            definitionId: old.definition_id,
            versionId: old.workflow_version_id,
          }
        : undefined,
    );
    await db.query(
      `INSERT INTO workflow_document_versions(tenant_id,document_id,version,title,content,viewer_units,definition_id,workflow_version_id,file_count,created_by,created_person_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        doc.tenant_id,
        doc.id,
        version,
        old.title,
        old.content,
        old.viewer_units,
        old.definition_id,
        old.workflow_version_id,
        old.file_count,
        actor.accountId,
        actor.personId,
      ],
    );
    await db.query(
      `INSERT INTO workflow_document_version_files(tenant_id,document_id,version,file_id,position)
       SELECT tenant_id,document_id,$4,file_id,position FROM workflow_document_version_files WHERE (tenant_id,document_id,version)=($1,$2,$3)`,
      [doc.tenant_id, doc.id, source, version],
    );
    await this.activateDraft(db, doc, version);
    return this.get(db, doc.tenant_id, doc.id);
  }

  async authorizeAction(
    db: Db,
    tenant: string,
    actor: WorkflowActor,
    id: string,
    action: DocumentAction | 'restore',
  ) {
    const doc = await this.get(db, tenant, id);
    workflowRequire(
      actor,
      tenant,
      action === 'submit' || action === 'reopen' || action === 'restore'
        ? 'workflows:design'
        : 'workflows:publish',
      doc.org_unit_id,
    );
    await this.directory.validateUnit(tenant, doc.org_unit_id);
    if (action === 'issue') {
      const draft = await this.version(db, doc, doc.draft_version);
      for (const unit of draft.viewer_units)
        workflowRequire(actor, tenant, 'workflows:publish', unit);
      await this.validateAudience(
        db,
        tenant,
        doc.org_unit_id,
        draft.viewer_units,
        draft.definition_id && draft.workflow_version_id
          ? {
              definitionId: draft.definition_id,
              versionId: draft.workflow_version_id,
            }
          : undefined,
      );
    }
    return doc;
  }

  async transition(
    db: Db,
    doc: Document,
    actor: WorkflowActor,
    action: DocumentAction,
    revision: number,
  ) {
    expectedRevision(doc.revision, revision);
    let review = doc.review_state,
      published = doc.published,
      issued = doc.issued_version;
    const badState = () => new HttpError(409, 'WORKFLOW_DOCUMENT_STATE');
    switch (action) {
      case 'submit':
        if (review !== 'draft') throw badState();
        if (
          (await this.files(db, doc, doc.draft_version)).rows.some(
            (file) => file.scan_status !== 'ready',
          )
        )
          throw new HttpError(409, 'WORKFLOW_DOCUMENT_FILE_QUARANTINED');
        review = 'pending';
        break;
      case 'reopen':
        if (review !== 'pending') throw badState();
        review = 'draft';
        break;
      case 'approve':
      case 'reject':
        if (review !== 'pending') throw badState();
        const draft = await this.version(db, doc, doc.draft_version);
        if (draft.created_by === actor.accountId || draft.created_person_id === actor.personId)
          throw new HttpError(403, 'WORKFLOW_DOCUMENT_SELF_REVIEW');
        review = action === 'approve' ? 'approved' : 'rejected';
        break;
      case 'issue':
        if (review !== 'approved' || (published && issued === doc.draft_version)) throw badState();
        published = true;
        issued = doc.draft_version;
        break;
      case 'withdraw':
        if (!published) throw badState();
        published = false;
        break;
    }
    return (
      await db.query<Document>(
        `UPDATE workflow_documents SET review_state=$3,published=$4,issued_version=$5,revision=revision+1,updated_at=now()
       WHERE (tenant_id,id)=($1,$2) RETURNING *`,
        [doc.tenant_id, doc.id, review, published, issued],
      )
    ).rows[0]!;
  }
}
