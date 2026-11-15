import type { Pool, PoolClient } from 'pg';
import { FormValidationError, schemaFields } from '../forms/contracts.js';
import type { Answers, FormSchema } from '../forms/contracts.js';
import type { AttachmentField, AttachmentFormat } from '../forms/attachment-fields.js';
import type { WorkflowActor } from './access.js';

type Db = Pool | PoolClient;
export type AttachmentLocation = {
  requestId: string | null;
  runId: string | null;
  round: number | null;
  taskId: string | null;
  nodeId: string | null;
};
export type AttachmentSummary = {
  id: string;
  fileName: string;
  byteCount: number;
  format: AttachmentFormat | 'unknown';
  status: 'ready' | 'quarantined';
};
export type AttachmentRow = {
  id: string;
  request_id: string | null;
  run_id: string | null;
  round: number | null;
  task_id: string | null;
  field_id: string;
  uploader_account_id: string;
  uploader_person_id: string;
  file_name: string;
  byte_count: number;
  format: AttachmentSummary['format'];
  scan_status: AttachmentSummary['status'];
};
type Link = {
  attachment_id: string;
  run_id: string;
  round: number;
  task_id: string | null;
  field_id: string;
  node_id: string | null;
};
const metadataColumns =
  'id,request_id,run_id,round,task_id,field_id,uploader_account_id,uploader_person_id,file_name,byte_count,format,scan_status';

function summary(file: AttachmentRow): AttachmentSummary {
  return {
    id: file.id,
    fileName: file.file_name,
    byteCount: file.byte_count,
    format: file.format,
    status: file.scan_status,
  };
}

export function ownsAttachment(
  file: AttachmentRow,
  actor: WorkflowActor,
  location: AttachmentLocation,
) {
  return (
    file.uploader_account_id === actor.accountId &&
    file.uploader_person_id === actor.personId &&
    file.request_id === location.requestId &&
    file.run_id === location.runId &&
    file.round === location.round &&
    file.task_id === location.taskId
  );
}

export async function attachmentRows(db: Db, tenant: string, ids: string[]) {
  if (!ids.length) return [];
  return (
    await db.query<AttachmentRow>(
      'SELECT ' +
        metadataColumns +
        ' FROM workflow_attachments WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
      [tenant, ids],
    )
  ).rows;
}

export async function attachmentLinks(db: Db, tenant: string, ids: string[], runId?: string) {
  if (!ids.length) return [];
  return (
    await db.query<Link>(
      `SELECT l.attachment_id,l.run_id,l.round,l.task_id,l.field_id,t.node_id
     FROM workflow_attachment_links l
     LEFT JOIN workflow_tasks t ON (t.tenant_id,t.id)=(l.tenant_id,l.task_id)
     WHERE l.tenant_id=$1 AND l.attachment_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR l.run_id=$3)`,
      [tenant, ids, runId ?? null],
    )
  ).rows;
}

export function attachmentReferences(schema: FormSchema | null, answers: Answers) {
  const references: { id: string; fieldId: string; policy: AttachmentField }[] = [];
  if (schema)
    for (const field of schemaFields(schema)) {
      if (field.type !== 'attachment') continue;
      const ids = answers[field.id];
      if (Array.isArray(ids))
        for (const id of ids)
          references.push({ id, fieldId: field.id, policy: field.attachments! });
    }
  return references;
}

function reusable(link: Link, fieldId: string, location: AttachmentLocation) {
  if (link.run_id !== location.runId) return false;
  if (!location.taskId)
    return !link.task_id && link.field_id === fieldId && link.round < location.round!;
  if (link.round !== location.round) return false;
  return link.task_id
    ? link.node_id === location.nodeId && link.field_id === fieldId
    : 'input.' + link.field_id === fieldId;
}

export async function verifyAttachmentAnswers(
  db: Db,
  tenant: string,
  actor: WorkflowActor,
  schema: FormSchema | null,
  answers: Answers,
  location?: AttachmentLocation,
) {
  const refs = attachmentReferences(schema, answers);
  if (!refs.length) return refs;
  const ids = [...new Set(refs.map((ref) => ref.id))];
  const files = location ? await attachmentRows(db, tenant, ids) : [];
  const links = location?.runId ? await attachmentLinks(db, tenant, ids, location.runId) : [];
  const fileById = new Map(files.map((file) => [file.id, file]));
  for (const ref of refs) {
    const file = fileById.get(ref.id);
    if (
      !location ||
      !file ||
      file.scan_status !== 'ready' ||
      file.format === 'unknown' ||
      !ref.policy.formats.includes(file.format) ||
      file.byte_count > ref.policy.maxBytes ||
      !(
        (file.field_id === ref.fieldId && ownsAttachment(file, actor, location)) ||
        links.some((link) => link.attachment_id === ref.id && reusable(link, ref.fieldId, location))
      )
    ) {
      throw new FormValidationError([
        { path: 'answers.' + ref.fieldId, code: 'ATTACHMENT_REFERENCE_INVALID' },
      ]);
    }
  }
  return refs;
}

export async function linkAttachments(
  db: PoolClient,
  tenant: string,
  runId: string,
  round: number,
  taskId: string | null,
  refs: { id: string; fieldId: string }[],
) {
  if (!refs.length) return;
  await db.query(
    `INSERT INTO workflow_attachment_links(tenant_id,run_id,round,task_id,field_id,attachment_id)
     SELECT $1,$2,$3,$4,p.field_id,p.attachment_id
     FROM unnest($5::text[],$6::uuid[]) AS p(field_id,attachment_id) ON CONFLICT DO NOTHING`,
    [tenant, runId, round, taskId, refs.map((ref) => ref.fieldId), refs.map((ref) => ref.id)],
  );
}

export async function attachmentSummaries(db: Db, tenant: string, refs: { id: string }[]) {
  return (await attachmentRows(db, tenant, [...new Set(refs.map((ref) => ref.id))])).map(summary);
}

export async function insertAttachment(
  db: PoolClient,
  tenant: string,
  actor: WorkflowActor,
  location: AttachmentLocation,
  id: string,
  fieldId: string,
  file: Omit<AttachmentSummary, 'id'> & { checksum: string; content: Buffer | null },
) {
  const row = (
    await db.query<AttachmentRow>(
      `INSERT INTO workflow_attachments(
      id,tenant_id,request_id,run_id,round,task_id,field_id,uploader_account_id,uploader_person_id,
      file_name,format,byte_count,checksum,scan_status,content
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ` + metadataColumns,
      [
        id,
        tenant,
        location.requestId,
        location.runId,
        location.round,
        location.taskId,
        fieldId,
        actor.accountId,
        actor.personId,
        file.fileName,
        file.format,
        file.byteCount,
        file.checksum,
        file.status,
        file.content,
      ],
    )
  ).rows[0]!;
  return summary(row);
}
