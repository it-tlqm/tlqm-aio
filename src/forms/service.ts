import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../security.js';
import { parseFormSchema, parseAnswers } from './contracts.js';
import { csvExport, summarizeVersion } from './reporting.js';
import { actionableForms, activeFormAudience } from './work-center.js';
import type { FormSchema, Answers } from './contracts.js';
import { hasFormsPermission, requireFormsPermission, hasAnyFormsScope } from './access.js';
import type {
  FormsActor,
  FormsReadContext,
  FormsCommandContext,
  FormsDirectory,
  FormsPermission,
} from './access.js';

export type FormRow = {
  id: string;
  tenant_id: string;
  code: string;
  title: string;
  owner_account_id: string;
  org_unit_id: string | null;
  status: 'open' | 'closed' | 'archived';
  revision: number;
  draft_schema: FormSchema | null;
  latest_version: number;
  max_submissions: number;
};
export type VersionRow = {
  id: string;
  tenant_id: string;
  form_id: string;
  version: number;
  schema: FormSchema;
  checksum: string;
};
export type SubmissionRow = {
  id: string;
  tenant_id: string;
  form_id: string;
  version_id: string;
  account_id: string;
  person_id: string;
  org_unit_id: string;
  status: 'draft' | 'submitted' | 'cancelled';
  answers: Answers;
  revision: number;
};
export type AudienceInput = {
  kind: 'account' | 'unit' | 'group';
  targetId: string;
  opensAt: string;
  closesAt: string | null;
};
type Db = Pool | PoolClient;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function formHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function uuid(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new HttpError(400, 'INVALID_IDENTIFIER');
}
function revision(actual: number, expected: number) {
  if (!Number.isInteger(expected) || expected < 1) throw new HttpError(400, 'REVISION_REQUIRED');
  if (actual !== expected) throw new HttpError(409, 'REVISION_CONFLICT');
}
function formSummary(form: FormRow) {
  const { draft_schema: draft, ...metadata } = form;
  return { ...metadata, hasDraft: draft !== null };
}
export class FormsService {
  constructor(
    readonly pool: Pool,
    readonly directory: FormsDirectory,
  ) {}
  private async actor(context: FormsReadContext) {
    uuid(context.tenantId);
    const actor = await context.actor();
    uuid(actor.accountId);
    uuid(actor.personId);
    if (actor.appCode !== 'aio-forms' || !actor.tenantIds.includes(context.tenantId))
      throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
    return actor;
  }
  private async form(db: Db, tenant: string, id: string): Promise<FormRow> {
    uuid(id);
    const row = (await db.query('SELECT * FROM forms WHERE tenant_id=$1 AND id=$2', [tenant, id]))
      .rows[0] as FormRow | undefined;
    if (!row) throw new HttpError(404, 'FORM_NOT_FOUND');
    return row;
  }
  private async version(
    db: Db,
    tenant: string,
    formId: string,
    versionId: string,
  ): Promise<VersionRow> {
    uuid(versionId);
    const row = (
      await db.query('SELECT * FROM form_versions WHERE tenant_id=$1 AND form_id=$2 AND id=$3', [
        tenant,
        formId,
        versionId,
      ])
    ).rows[0] as VersionRow | undefined;
    if (!row) throw new HttpError(404, 'FORM_VERSION_NOT_FOUND');
    return row;
  }
  private async audit(
    db: PoolClient,
    context: FormsCommandContext,
    actor: FormsActor,
    action: string,
    form: FormRow | null,
    target: string,
    details: unknown,
    unit: string | null = null,
  ) {
    await db.query(
      'INSERT INTO form_audit(tenant_id,form_id,org_unit_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        context.tenantId,
        form?.id ?? null,
        unit ?? form?.org_unit_id ?? null,
        actor.accountId,
        action,
        target,
        context.reason.trim(),
        context.requestId,
        JSON.stringify(details),
      ],
    );
  }
  private async command<T>(
    context: FormsCommandContext,
    operation: string,
    input: unknown,
    authorize: (db: PoolClient, actor: FormsActor) => Promise<void>,
    action: (db: PoolClient, actor: FormsActor) => Promise<T>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(context.idempotencyKey))
      throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    if (context.reason.trim().length < 5 || context.reason.length > 240)
      throw new HttpError(400, 'REASON_REQUIRED');
    const hash = formHash({ operation, input, reason: context.reason });
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'aio-forms:' + context.tenantId,
      ]);
      const actor = await this.actor(context);
      await authorize(db, actor);
      const prior = (
        await db.query(
          'SELECT operation,request_hash,response FROM form_receipts WHERE tenant_id=$1 AND actor_account_id=$2 AND idempotency_key=$3',
          [context.tenantId, actor.accountId, context.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.operation !== operation || prior.request_hash !== hash)
          throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
        await db.query('COMMIT');
        return prior.response as T;
      }
      const result = JSON.parse(JSON.stringify(await action(db, actor))) as T;
      // Locks may have queued the request. Never commit using an expired or revoked access snapshot.
      const current = await this.actor(context);
      if (actor.accountId !== current.accountId || actor.personId !== current.personId)
        throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
      await authorize(db, current);
      await db.query(
        'INSERT INTO form_receipts(tenant_id,actor_account_id,idempotency_key,operation,request_hash,response) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          context.tenantId,
          actor.accountId,
          context.idempotencyKey,
          operation,
          hash,
          JSON.stringify(result),
        ],
      );
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      const code = (error as { code?: string }).code;
      if (code === '23505') throw new HttpError(409, 'FORMS_DUPLICATE_RECORD');
      if (code === '23503' || code === '23514') throw new HttpError(400, 'FORMS_INVALID_RELATION');
      if (code === '40001' || code === '40P01') throw new HttpError(409, 'RETRY_REQUIRED');
      throw error;
    } finally {
      db.release();
    }
  }
  private manage(tenant: string, formId: string, permission: FormsPermission) {
    return async (db: PoolClient, actor: FormsActor) => {
      const form = await this.form(db, tenant, formId);
      requireFormsPermission(actor, tenant, permission, form.org_unit_id);
    };
  }
  async create(
    context: FormsCommandContext,
    input: { code: string; schema: unknown; orgUnitId: string | null; maxSubmissions: number },
  ) {
    if (
      !/^[a-z][a-z0-9-]{2,50}$/.test(input.code) ||
      !Number.isInteger(input.maxSubmissions) ||
      input.maxSubmissions < 1 ||
      input.maxSubmissions > 100
    )
      throw new HttpError(400, 'FORM_INVALID_DATA');
    if (input.orgUnitId !== null) uuid(input.orgUnitId);
    const schema = parseFormSchema(input.schema);
    return this.command(
      context,
      'form.create',
      input,
      async (_db, actor) => {
        requireFormsPermission(actor, context.tenantId, 'forms:design', input.orgUnitId);
        if (input.orgUnitId)
          await this.directory.validateTargets(context.tenantId, input.orgUnitId, [
            { kind: 'unit', id: input.orgUnitId },
          ]);
      },
      async (db, actor) => {
        const form = (
          await db.query(
            'INSERT INTO forms(id,tenant_id,code,title,owner_account_id,org_unit_id,draft_schema,max_submissions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
            [
              randomUUID(),
              context.tenantId,
              input.code,
              schema.title,
              actor.accountId,
              input.orgUnitId,
              JSON.stringify(schema),
              input.maxSubmissions,
            ],
          )
        ).rows[0] as FormRow;
        await this.audit(db, context, actor, 'form.created', form, form.id, {
          schemaChecksum: formHash(schema),
          revision: form.revision,
        });
        return form;
      },
    );
  }
  async saveDraft(
    context: FormsCommandContext,
    formId: string,
    expectedRevision: number,
    value: unknown,
  ) {
    const schema = parseFormSchema(value);
    return this.command(
      context,
      'form.draft.save',
      { formId, expectedRevision, schema },
      this.manage(context.tenantId, formId, 'forms:design'),
      async (db, actor) => {
        const before = await this.form(db, context.tenantId, formId);
        revision(before.revision, expectedRevision);
        if (before.status === 'archived') throw new HttpError(409, 'FORM_ARCHIVED');
        const form = (
          await db.query(
            'UPDATE forms SET draft_schema=$3,title=$4,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
            [context.tenantId, formId, JSON.stringify(schema), schema.title],
          )
        ).rows[0] as FormRow;
        await this.audit(db, context, actor, 'form.draft.saved', form, formId, {
          beforeChecksum: before.draft_schema ? formHash(before.draft_schema) : null,
          afterChecksum: formHash(schema),
          revision: form.revision,
        });
        return form;
      },
    );
  }
  async publish(context: FormsCommandContext, formId: string, expectedRevision: number) {
    return this.command(
      context,
      'form.publish',
      { formId, expectedRevision },
      this.manage(context.tenantId, formId, 'forms:publish'),
      async (db, actor) => {
        const form = await this.form(db, context.tenantId, formId);
        revision(form.revision, expectedRevision);
        if (form.status !== 'open' || !form.draft_schema)
          throw new HttpError(409, 'FORM_NOT_PUBLISHABLE');
        const schema = parseFormSchema(form.draft_schema);
        const version = (
          await db.query(
            'INSERT INTO form_versions(id,tenant_id,form_id,version,schema,checksum,published_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              randomUUID(),
              context.tenantId,
              formId,
              form.latest_version + 1,
              JSON.stringify(schema),
              formHash(schema),
              actor.accountId,
            ],
          )
        ).rows[0] as VersionRow;
        await db.query(
          'UPDATE forms SET draft_schema=NULL,latest_version=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, formId, version.version],
        );
        await this.audit(db, context, actor, 'form.published', form, version.id, {
          version: version.version,
          checksum: version.checksum,
        });
        return { version, form: await this.form(db, context.tenantId, formId) };
      },
    );
  }
  async setStatus(
    context: FormsCommandContext,
    formId: string,
    expectedRevision: number,
    status: 'open' | 'closed' | 'archived',
  ) {
    if (!['open', 'closed', 'archived'].includes(status))
      throw new HttpError(400, 'FORM_INVALID_DATA');
    return this.command(
      context,
      'form.status',
      { formId, expectedRevision, status },
      this.manage(context.tenantId, formId, 'forms:publish'),
      async (db, actor) => {
        const before = await this.form(db, context.tenantId, formId);
        revision(before.revision, expectedRevision);
        if (before.status === 'archived') throw new HttpError(409, 'FORM_ARCHIVED');
        const form = (
          await db.query(
            'UPDATE forms SET status=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
            [context.tenantId, formId, status],
          )
        ).rows[0] as FormRow;
        await this.audit(db, context, actor, 'form.status.changed', form, formId, {
          before: before.status,
          after: status,
        });
        return form;
      },
    );
  }
  async closeVersion(
    context: FormsCommandContext,
    formId: string,
    versionId: string,
    expectedRevision: number,
  ) {
    return this.command(
      context,
      'form.version.close',
      { formId, versionId, expectedRevision },
      this.manage(context.tenantId, formId, 'forms:publish'),
      async (db, actor) => {
        const form = await this.form(db, context.tenantId, formId);
        revision(form.revision, expectedRevision);
        await this.version(db, context.tenantId, formId, versionId);
        await db.query(
          'INSERT INTO version_availability(tenant_id,form_id,version_id,closed_by) VALUES ($1,$2,$3,$4)',
          [context.tenantId, formId, versionId, actor.accountId],
        );
        await db.query(
          'UPDATE forms SET revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, formId],
        );
        await this.audit(db, context, actor, 'form.version.closed', form, versionId, {});
        return { closed: true, versionId };
      },
    );
  }
  async setAudience(
    context: FormsCommandContext,
    formId: string,
    expectedRevision: number,
    audiences: AudienceInput[],
  ) {
    if (!Array.isArray(audiences) || audiences.length > 100)
      throw new HttpError(400, 'FORM_INVALID_AUDIENCE');
    for (const audience of audiences) {
      uuid(audience.targetId);
      if (
        !['account', 'unit', 'group'].includes(audience.kind) ||
        !Number.isFinite(Date.parse(audience.opensAt)) ||
        (audience.closesAt !== null &&
          (!Number.isFinite(Date.parse(audience.closesAt)) ||
            Date.parse(audience.closesAt) <= Date.parse(audience.opensAt)))
      )
        throw new HttpError(400, 'FORM_INVALID_AUDIENCE');
    }
    return this.command(
      context,
      'form.audience',
      { formId, expectedRevision, audiences },
      this.manage(context.tenantId, formId, 'forms:publish'),
      async (db, actor) => {
        const form = await this.form(db, context.tenantId, formId);
        revision(form.revision, expectedRevision);
        if (form.status === 'archived') throw new HttpError(409, 'FORM_ARCHIVED');
        await this.directory.validateTargets(
          context.tenantId,
          form.org_unit_id,
          audiences
            .filter(
              (item): item is AudienceInput & { kind: 'account' | 'unit' } => item.kind !== 'group',
            )
            .map((item) => ({ kind: item.kind, id: item.targetId })),
        );
        for (const audience of audiences.filter((item) => item.kind === 'group')) {
          const group = (
            await db.query(
              'SELECT org_unit_id FROM form_groups WHERE tenant_id=$1 AND id=$2 AND active',
              [context.tenantId, audience.targetId],
            )
          ).rows[0];
          if (!group || (form.org_unit_id && group.org_unit_id !== form.org_unit_id))
            throw new HttpError(400, 'FORM_INVALID_AUDIENCE');
        }
        await db.query(
          'UPDATE form_audiences SET active=false WHERE tenant_id=$1 AND form_id=$2 AND active',
          [context.tenantId, formId],
        );
        for (const audience of audiences)
          await db.query(
            'INSERT INTO form_audiences(id,tenant_id,form_id,kind,target_id,opens_at,closes_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [
              randomUUID(),
              context.tenantId,
              formId,
              audience.kind,
              audience.targetId,
              audience.opensAt,
              audience.closesAt,
            ],
          );
        await db.query(
          'UPDATE forms SET revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, formId],
        );
        await this.audit(db, context, actor, 'form.audience.changed', form, formId, { audiences });
        return { form: await this.form(db, context.tenantId, formId), audiences };
      },
    );
  }
  async saveGroup(
    context: FormsCommandContext,
    input: { name: string; orgUnitId: string | null; accountIds: string[]; active: boolean },
    id?: string,
    expectedRevision?: number,
  ) {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 200 ||
      !Array.isArray(input.accountIds) ||
      input.accountIds.length > 200 ||
      typeof input.active !== 'boolean'
    )
      throw new HttpError(400, 'FORM_INVALID_DATA');
    input.accountIds.forEach(uuid);
    if (id) uuid(id);
    if (input.orgUnitId) uuid(input.orgUnitId);
    return this.command(
      context,
      'form.group.save',
      { input, id, expectedRevision },
      async (db, actor) => {
        requireFormsPermission(actor, context.tenantId, 'forms:publish', input.orgUnitId);
        if (id) {
          const row = (
            await db.query('SELECT * FROM form_groups WHERE tenant_id=$1 AND id=$2', [
              context.tenantId,
              id,
            ])
          ).rows[0];
          if (!row) throw new HttpError(404, 'FORM_GROUP_NOT_FOUND');
          requireFormsPermission(actor, context.tenantId, 'forms:publish', row.org_unit_id);
          if (row.org_unit_id !== input.orgUnitId)
            throw new HttpError(400, 'FORM_GROUP_SCOPE_IMMUTABLE');
        }
      },
      async (db, actor) => {
        await this.directory.validateTargets(context.tenantId, input.orgUnitId, [
          ...input.accountIds.map((account) => ({ kind: 'account' as const, id: account })),
          ...(input.orgUnitId ? [{ kind: 'unit' as const, id: input.orgUnitId }] : []),
        ]);
        const groupId = id ?? randomUUID();
        if (id) {
          const row = (
            await db.query('SELECT revision FROM form_groups WHERE tenant_id=$1 AND id=$2', [
              context.tenantId,
              id,
            ])
          ).rows[0];
          revision(row.revision, expectedRevision!);
          await db.query(
            'UPDATE form_groups SET name=$3,active=$4,revision=revision+1 WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, id, input.name, input.active],
          );
        } else
          await db.query(
            'INSERT INTO form_groups(id,tenant_id,org_unit_id,name,active) VALUES ($1,$2,$3,$4,$5)',
            [groupId, context.tenantId, input.orgUnitId, input.name, input.active],
          );
        await db.query(
          'UPDATE form_group_members SET active=false WHERE tenant_id=$1 AND group_id=$2',
          [context.tenantId, groupId],
        );
        for (const accountId of new Set(input.accountIds))
          await db.query(
            'INSERT INTO form_group_members(tenant_id,group_id,account_id) VALUES ($1,$2,$3) ON CONFLICT(tenant_id,group_id,account_id) DO UPDATE SET active=true',
            [context.tenantId, groupId, accountId],
          );
        await this.audit(
          db,
          context,
          actor,
          'form.group.saved',
          null,
          groupId,
          { name: input.name, members: input.accountIds, active: input.active },
          input.orgUnitId,
        );
        return (
          await db.query('SELECT * FROM form_groups WHERE tenant_id=$1 AND id=$2', [
            context.tenantId,
            groupId,
          ])
        ).rows[0];
      },
    );
  }
  private async audience(
    db: Db,
    actor: FormsActor,
    form: FormRow,
    unitId?: string,
  ): Promise<boolean> {
    const units = actor.units
      .filter((unit) => unit.tenantId === form.tenant_id && (!unitId || unit.orgUnitId === unitId))
      .map((unit) => unit.orgUnitId);
    const result = await db.query(
      'SELECT 1 WHERE ' + activeFormAudience('$1', '$2', '$3', 'a.target_id=ANY($4::uuid[])'),
      [form.tenant_id, form.id, actor.accountId, units],
    );
    return !!result.rowCount;
  }
  private canReadAllVersions(actor: FormsActor, form: FormRow) {
    return (
      hasFormsPermission(actor, form.tenant_id, 'forms:design', form.org_unit_id) ||
      hasFormsPermission(actor, form.tenant_id, 'forms:publish', form.org_unit_id) ||
      (form.org_unit_id === null
        ? hasAnyFormsScope(actor, form.tenant_id, 'forms:review') ||
          hasAnyFormsScope(actor, form.tenant_id, 'forms:analyze')
        : hasFormsPermission(actor, form.tenant_id, 'forms:review', form.org_unit_id) ||
          hasFormsPermission(actor, form.tenant_id, 'forms:analyze', form.org_unit_id))
    );
  }
  private async responseUnits(db: Db, actor: FormsActor, form: FormRow) {
    const result: string[] = [];
    if (!form.latest_version) return result;
    for (const unit of actor.units) {
      if (
        unit.tenantId !== form.tenant_id ||
        (form.org_unit_id && form.org_unit_id !== unit.orgUnitId)
      )
        continue;
      if (
        hasFormsPermission(actor, form.tenant_id, 'forms:respond', unit.orgUnitId) &&
        (await this.audience(db, actor, form, unit.orgUnitId))
      )
        result.push(unit.orgUnitId);
    }
    return [...new Set(result)];
  }
  private async canReadForm(db: Db, actor: FormsActor, form: FormRow) {
    if (this.canReadAllVersions(actor, form) || (await this.responseUnits(db, actor, form)).length)
      return true;
    return (
      hasAnyFormsScope(actor, form.tenant_id, 'forms:respond') &&
      !!(
        await db.query(
          'SELECT 1 FROM submissions WHERE tenant_id=$1 AND form_id=$2 AND account_id=$3 LIMIT 1',
          [form.tenant_id, form.id, actor.accountId],
        )
      ).rowCount
    );
  }
  async list(context: FormsReadContext) {
    return (await this.listPage(context)).items;
  }
  async assignedForms(context: FormsReadContext, after?: string, search = '') {
    if (after !== undefined) uuid(after);
    if (typeof search !== 'string' || search.length > 120)
      throw new HttpError(400, 'INVALID_REQUEST');
    const actor = await this.actor(context);
    if (!hasAnyFormsScope(actor, context.tenantId, 'forms:respond'))
      throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
    return actionableForms(this.pool, actor, context.tenantId, after, search.trim());
  }
  async listPage(context: FormsReadContext, after?: string) {
    if (after) uuid(after);
    const actor = await this.actor(context);
    const rows = (
      await this.pool.query(
        'SELECT * FROM forms f WHERE f.tenant_id=$1 AND ($2::uuid IS NULL OR (f.created_at,f.id)<(SELECT created_at,id FROM forms WHERE tenant_id=$1 AND id=$2)) ORDER BY f.created_at DESC,f.id DESC LIMIT 101',
        [context.tenantId, after ?? null],
      )
    ).rows as FormRow[];
    const result = [];
    for (const form of rows.slice(0, 100)) {
      if (!(await this.canReadForm(this.pool, actor, form))) continue;
      const summary = formSummary(form);
      const manage =
        hasFormsPermission(actor, context.tenantId, 'forms:design', form.org_unit_id) ||
        hasFormsPermission(actor, context.tenantId, 'forms:publish', form.org_unit_id);
      if (!manage) {
        const allVersions =
          this.canReadAllVersions(actor, form) ||
          (await this.responseUnits(this.pool, actor, form)).length > 0;
        const title = (
          await this.pool.query(
            "SELECT v.schema->>'title' AS title FROM form_versions v WHERE v.tenant_id=$1 AND v.form_id=$2 AND ($3::boolean OR EXISTS(SELECT 1 FROM submissions s WHERE s.tenant_id=v.tenant_id AND s.form_id=v.form_id AND s.version_id=v.id AND s.account_id=$4)) ORDER BY v.version DESC LIMIT 1",
            [context.tenantId, form.id, allVersions, actor.accountId],
          )
        ).rows[0]?.title;
        if (title) summary.title = title as string;
        summary.hasDraft = false;
      }
      result.push(summary);
    }
    return { items: result, nextCursor: rows.length > 100 ? rows[99]!.id : null };
  }
  async detail(context: FormsReadContext, formId: string) {
    const actor = await this.actor(context),
      form = await this.form(this.pool, context.tenantId, formId);
    if (!(await this.canReadForm(this.pool, actor, form)))
      throw new HttpError(403, 'FORM_AUDIENCE_DENIED');
    const manage =
      hasFormsPermission(actor, context.tenantId, 'forms:design', form.org_unit_id) ||
      hasFormsPermission(actor, context.tenantId, 'forms:publish', form.org_unit_id);
    const responseUnits = await this.responseUnits(this.pool, actor, form);
    const allVersions = this.canReadAllVersions(actor, form) || responseUnits.length > 0;
    const versions = (
      await this.pool.query(
        'SELECT v.*,a.closed_at FROM form_versions v LEFT JOIN version_availability a ON a.version_id=v.id WHERE v.tenant_id=$1 AND v.form_id=$2 AND ($3::boolean OR EXISTS(SELECT 1 FROM submissions s WHERE s.tenant_id=v.tenant_id AND s.form_id=v.form_id AND s.version_id=v.id AND s.account_id=$4)) ORDER BY v.version DESC',
        [context.tenantId, formId, allVersions, actor.accountId],
      )
    ).rows as VersionRow[];
    const audiences = hasFormsPermission(actor, context.tenantId, 'forms:publish', form.org_unit_id)
      ? (
          await this.pool.query(
            'SELECT * FROM form_audiences WHERE tenant_id=$1 AND form_id=$2 AND active',
            [context.tenantId, formId],
          )
        ).rows
      : [];
    return {
      form: {
        ...formSummary(form),
        ...(manage
          ? { draft_schema: form.draft_schema }
          : { hasDraft: false, title: versions[0]?.schema.title ?? form.title }),
      },
      versions,
      audiences,
      responseUnits,
    };
  }
  private respond(tenantId: string, formId: string, unitId: string) {
    return async (db: PoolClient, actor: FormsActor) => {
      const form = await this.form(db, tenantId, formId);
      requireFormsPermission(actor, tenantId, 'forms:respond', unitId);
      if (
        !actor.units.some((unit) => unit.tenantId === tenantId && unit.orgUnitId === unitId) ||
        (form.org_unit_id && form.org_unit_id !== unitId) ||
        !(await this.audience(db, actor, form, unitId))
      )
        throw new HttpError(403, 'FORM_AUDIENCE_DENIED');
    };
  }
  async saveSubmission(
    context: FormsCommandContext,
    formId: string,
    input: { versionId: string; orgUnitId: string; answers: unknown; submit: boolean },
    id?: string,
    expectedRevision?: number,
  ) {
    uuid(input.orgUnitId);
    uuid(input.versionId);
    if (id) uuid(id);
    if (typeof input.submit !== 'boolean') throw new HttpError(400, 'FORM_INVALID_DATA');
    return this.command(
      context,
      'form.submission.save',
      { formId, input, id, expectedRevision },
      this.respond(context.tenantId, formId, input.orgUnitId),
      async (db, actor) => {
        const form = await this.form(db, context.tenantId, formId);
        if (form.status !== 'open') throw new HttpError(409, 'FORM_CLOSED');
        const version = await this.version(db, context.tenantId, formId, input.versionId);
        if (!id && version.version !== form.latest_version)
          throw new HttpError(409, 'FORM_VERSION_STALE');
        if (
          (
            await db.query(
              'SELECT 1 FROM version_availability WHERE tenant_id=$1 AND form_id=$2 AND version_id=$3',
              [context.tenantId, formId, input.versionId],
            )
          ).rowCount
        )
          throw new HttpError(409, 'FORM_VERSION_CLOSED');
        const answers = parseAnswers(
          parseFormSchema(version.schema),
          input.answers,
          input.submit ? 'submit' : 'draft',
        );
        const count = (
          await db.query(
            "SELECT count(*)::integer AS count FROM submissions WHERE tenant_id=$1 AND form_id=$2 AND account_id=$3 AND status='submitted'",
            [context.tenantId, formId, actor.accountId],
          )
        ).rows[0].count as number;
        if (count >= form.max_submissions) throw new HttpError(409, 'FORM_SUBMISSION_LIMIT');
        const submissionId = id ?? randomUUID();
        let row: SubmissionRow;
        if (id) {
          const before = (
            await db.query(
              'SELECT * FROM submissions WHERE tenant_id=$1 AND form_id=$2 AND id=$3 AND account_id=$4',
              [context.tenantId, formId, id, actor.accountId],
            )
          ).rows[0] as SubmissionRow | undefined;
          if (!before) throw new HttpError(404, 'FORM_SUBMISSION_NOT_FOUND');
          revision(before.revision, expectedRevision!);
          if (
            before.status !== 'draft' ||
            before.version_id !== input.versionId ||
            before.org_unit_id !== input.orgUnitId
          )
            throw new HttpError(409, 'FORM_SUBMISSION_IMMUTABLE');
          row = (
            await db.query(
              "UPDATE submissions SET answers=$3,status=$4,submitted_at=CASE WHEN $4='submitted' THEN now() ELSE NULL END,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
              [context.tenantId, id, JSON.stringify(answers), input.submit ? 'submitted' : 'draft'],
            )
          ).rows[0] as SubmissionRow;
        } else {
          row = (
            await db.query(
              "INSERT INTO submissions(id,tenant_id,form_id,version_id,account_id,person_id,org_unit_id,status,answers,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8='submitted' THEN now() ELSE NULL END) RETURNING *",
              [
                submissionId,
                context.tenantId,
                formId,
                input.versionId,
                actor.accountId,
                actor.personId,
                input.orgUnitId,
                input.submit ? 'submitted' : 'draft',
                JSON.stringify(answers),
              ],
            )
          ).rows[0] as SubmissionRow;
        }
        await this.audit(
          db,
          context,
          actor,
          input.submit ? 'form.submission.sent' : 'form.submission.saved',
          form,
          submissionId,
          {
            versionId: version.id,
            revision: row.revision,
            answerChecksum: formHash(answers),
            status: row.status,
          },
          input.orgUnitId,
        );
        return row;
      },
    );
  }
  async cancelDraft(
    context: FormsCommandContext,
    formId: string,
    id: string,
    expectedRevision: number,
  ) {
    uuid(id);
    return this.command(
      context,
      'form.submission.cancel',
      { formId, id, expectedRevision },
      async (db, actor) => {
        await this.form(db, context.tenantId, formId);
        if (!hasAnyFormsScope(actor, context.tenantId, 'forms:respond'))
          throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
        if (
          !(
            await db.query(
              'SELECT 1 FROM submissions WHERE tenant_id=$1 AND form_id=$2 AND id=$3 AND account_id=$4',
              [context.tenantId, formId, id, actor.accountId],
            )
          ).rowCount
        )
          throw new HttpError(404, 'FORM_SUBMISSION_NOT_FOUND');
      },
      async (db, actor) => {
        const before = (
          await db.query('SELECT * FROM submissions WHERE tenant_id=$1 AND id=$2', [
            context.tenantId,
            id,
          ])
        ).rows[0] as SubmissionRow;
        revision(before.revision, expectedRevision);
        if (before.status !== 'draft') throw new HttpError(409, 'FORM_SUBMISSION_IMMUTABLE');
        const row = (
          await db.query(
            "UPDATE submissions SET status='cancelled',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [context.tenantId, id],
          )
        ).rows[0] as SubmissionRow;
        await this.audit(
          db,
          context,
          actor,
          'form.submission.cancelled',
          await this.form(db, context.tenantId, formId),
          id,
          { revision: row.revision },
          before.org_unit_id,
        );
        return row;
      },
    );
  }
  async submissions(context: FormsReadContext, formId: string, own = false) {
    return (await this.submissionsPage(context, formId, own)).items;
  }
  async submissionsPage(context: FormsReadContext, formId: string, own = false, after?: string) {
    if (after) uuid(after);
    const actor = await this.actor(context);
    await this.form(this.pool, context.tenantId, formId);
    if (!hasAnyFormsScope(actor, context.tenantId, own ? 'forms:respond' : 'forms:review'))
      throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
    const units = actor.permissions
      .filter(
        (item) =>
          item.tenantId === context.tenantId &&
          item.permission === (own ? 'forms:respond' : 'forms:review'),
      )
      .map((item) => item.orgUnitId);
    const rows = (
      await this.pool.query(
        "SELECT s.*,v.schema AS version_schema,v.version FROM submissions s JOIN form_versions v ON v.id=s.version_id AND v.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.form_id=$2 AND (($3::boolean AND s.account_id=$4) OR (NOT $3::boolean AND s.status='submitted' AND ($5::boolean OR s.org_unit_id=ANY($6::uuid[])))) AND ($7::uuid IS NULL OR (s.created_at,s.id)<(SELECT created_at,id FROM submissions WHERE tenant_id=$1 AND form_id=$2 AND id=$7)) ORDER BY s.created_at DESC,s.id DESC LIMIT 101",
        [
          context.tenantId,
          formId,
          own,
          actor.accountId,
          units.includes(null),
          units.filter((value) => value !== null),
          after ?? null,
        ],
      )
    ).rows as SubmissionRow[];
    const submittedCount = own
      ? ((
          await this.pool.query(
            "SELECT count(*)::integer AS count FROM submissions WHERE tenant_id=$1 AND form_id=$2 AND account_id=$3 AND status='submitted'",
            [context.tenantId, formId, actor.accountId],
          )
        ).rows[0].count as number)
      : undefined;
    return {
      items: rows.slice(0, 100),
      nextCursor: rows.length > 100 ? rows[99]!.id : null,
      ...(submittedCount !== undefined ? { submittedCount } : {}),
    };
  }
  private async reportingRows(
    db: Db,
    actor: FormsActor,
    tenant: string,
    formId: string,
    permission: 'forms:analyze' | 'forms:export',
    versionId?: string,
  ) {
    const form = await this.form(db, tenant, formId);
    if (
      !hasAnyFormsScope(actor, tenant, permission) ||
      (form.org_unit_id !== null &&
        !hasFormsPermission(actor, tenant, permission, form.org_unit_id))
    )
      throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
    const units = actor.permissions
      .filter((item) => item.tenantId === tenant && item.permission === permission)
      .map((item) => item.orgUnitId);
    const rows = (
      await db.query(
        "SELECT s.*,v.schema AS version_schema,v.version FROM submissions s JOIN form_versions v ON v.tenant_id=s.tenant_id AND v.id=s.version_id WHERE s.tenant_id=$1 AND s.form_id=$2 AND s.status='submitted' AND ($3::boolean OR s.org_unit_id=ANY($4::uuid[])) AND ($5::uuid IS NULL OR s.version_id=$5) ORDER BY s.created_at,s.id LIMIT 10001",
        [
          tenant,
          formId,
          units.includes(null),
          units.filter((unit) => unit !== null),
          versionId ?? null,
        ],
      )
    ).rows as (SubmissionRow & {
      version_schema: FormSchema;
      version: number;
      submitted_at: Date;
    })[];
    if (rows.length > 10000) throw new HttpError(413, 'FORM_REPORT_TOO_LARGE');
    return { form, rows };
  }
  async groups(context: FormsReadContext) {
    const actor = await this.actor(context);
    if (!hasAnyFormsScope(actor, context.tenantId, 'forms:publish'))
      throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
    const rows = (
      await this.pool.query(
        "SELECT g.*,COALESCE((SELECT json_agg(m.account_id ORDER BY m.account_id) FROM form_group_members m WHERE m.tenant_id=g.tenant_id AND m.group_id=g.id AND m.active),'[]'::json) AS account_ids FROM form_groups g WHERE g.tenant_id=$1 ORDER BY g.name LIMIT 200",
        [context.tenantId],
      )
    ).rows;
    return rows.filter((row) =>
      hasFormsPermission(actor, context.tenantId, 'forms:publish', row.org_unit_id),
    );
  }
  async history(context: FormsReadContext, formId: string) {
    const actor = await this.actor(context),
      form = await this.form(this.pool, context.tenantId, formId);
    if (
      !hasFormsPermission(actor, context.tenantId, 'forms:design', form.org_unit_id) &&
      !hasFormsPermission(actor, context.tenantId, 'forms:publish', form.org_unit_id)
    )
      throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
    return (
      await this.pool.query(
        'SELECT * FROM form_audit WHERE tenant_id=$1 AND form_id=$2 ORDER BY id DESC LIMIT 200',
        [context.tenantId, formId],
      )
    ).rows;
  }
  async report(context: FormsReadContext, formId: string) {
    const actor = await this.actor(context);
    const { rows } = await this.reportingRows(
      this.pool,
      actor,
      context.tenantId,
      formId,
      'forms:analyze',
    );
    const byUnit = new Map<string, number>();
    const versions = new Map<
      string,
      { versionId: string; version: number; schema: FormSchema; rows: typeof rows }
    >();
    for (const row of rows) {
      byUnit.set(row.org_unit_id, (byUnit.get(row.org_unit_id) ?? 0) + 1);
      if (!versions.has(row.version_id))
        versions.set(row.version_id, {
          versionId: row.version_id,
          version: row.version,
          schema: parseFormSchema(row.version_schema),
          rows: [],
        });
      versions.get(row.version_id)!.rows.push(row);
    }
    return {
      total: rows.length,
      byUnit: [...byUnit].map(([orgUnitId, count]) => ({ orgUnitId, count })),
      versions: [...versions.values()].map((version) => ({
        versionId: version.versionId,
        version: version.version,
        total: version.rows.length,
        fields: summarizeVersion(version.schema, version.rows),
      })),
    };
  }
  /** A download is a fresh scoped read with an audit event, not a cached mutation response. */
  async export(context: FormsCommandContext, formId: string, versionId: string) {
    uuid(versionId);
    if (context.reason.trim().length < 5 || context.reason.length > 240)
      throw new HttpError(400, 'REASON_REQUIRED');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const actor = await this.actor(context);
      const { form, rows } = await this.reportingRows(
        db,
        actor,
        context.tenantId,
        formId,
        'forms:export',
        versionId,
      );
      const version = await this.version(db, context.tenantId, formId, versionId);
      const csv = csvExport(parseFormSchema(version.schema), rows);
      const current = await this.actor(context);
      if (
        current.accountId !== actor.accountId ||
        !hasAnyFormsScope(current, context.tenantId, 'forms:export') ||
        rows.some(
          (row) => !hasFormsPermission(current, context.tenantId, 'forms:export', row.org_unit_id),
        )
      )
        throw new HttpError(403, 'FORMS_PERMISSION_DENIED');
      const units = [...new Set(rows.map((row) => row.org_unit_id))];
      await this.audit(db, context, current, 'form.exported', form, versionId, {
        versionId,
        rows: rows.length,
        units,
        csvChecksum: formHash(csv),
      });
      await db.query('COMMIT');
      return { csv, rows: rows.length, version: version.version };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
}
