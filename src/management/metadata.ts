import type { Pool, PoolClient } from 'pg';
import type { Store, Principal } from '../store.js';
import { HttpError } from '../security.js';
import { parseFormSchema, parseAnswers, schemaFields } from '../forms/contracts.js';
import type { FormSchema, Answers } from '../forms/contracts.js';
import { DirectoryService, camelRow } from './directory.js';
import { mutate, auditMutation } from './mutations.js';
import type { MutationContext } from './mutations.js';
import type { ProfileWorkflowLink } from './profile-workflows.js';
type Db = Pool | PoolClient;
export const metadataResources = ['people', 'org-units', 'job-titles', 'positions'] as const;
export type MetadataResource = (typeof metadataResources)[number];
export type DirectoryConfiguration = { schema: FormSchema; selfView: string[]; selfEdit: string[] };
function resource(value: string): asserts value is MetadataResource {
  if (!metadataResources.some((r) => r === value)) throw new HttpError(400, 'INVALID_REQUEST');
}
const manage = (r: string) => (r === 'people' ? 'people:manage' : 'directory:manage');
function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>, ids: string[]) {
  const result = Object.fromEntries(Object.entries(base).filter(([id]) => ids.includes(id)));
  for (const [id, value] of Object.entries(patch)) {
    if (value === null) delete result[id];
    else result[id] = value;
  }
  return result;
}
export function parseDirectoryConfiguration(value: unknown, res: string): DirectoryConfiguration {
  resource(res);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !['schema', 'selfView', 'selfEdit'].includes(k))
  )
    throw new HttpError(400, 'PROFILE_CONFIGURATION_INVALID');
  const raw = value as DirectoryConfiguration,
    schema = parseFormSchema(raw.schema),
    fields = schemaFields(schema),
    ids = new Set(fields.map((f) => f.id));
  if (
    !Array.isArray(raw.selfView) ||
    !Array.isArray(raw.selfEdit) ||
    [...raw.selfView, ...raw.selfEdit].some((id) => typeof id !== 'string' || !ids.has(id)) ||
    new Set(raw.selfView).size !== raw.selfView.length ||
    new Set(raw.selfEdit).size !== raw.selfEdit.length ||
    raw.selfEdit.some((id) => !raw.selfView.includes(id)) ||
    (res !== 'people' && (raw.selfView.length || raw.selfEdit.length))
  )
    throw new HttpError(400, 'PROFILE_CONFIGURATION_INVALID');
  for (const f of fields.filter((f) => raw.selfView.includes(f.id)))
    for (const condition of [f.visibleWhen, f.requiredWhen])
      if (condition?.rules.some((r) => !raw.selfView.includes(r.fieldId)))
        throw new HttpError(400, 'PROFILE_SELF_CONDITION_HIDDEN');
  return { schema, selfView: [...raw.selfView], selfEdit: [...raw.selfEdit] };
}
function projectedSchema(config: DirectoryConfiguration, ids: string[]) {
  return {
    ...config.schema,
    sections: config.schema.sections
      .map((s) => ({ ...s, fields: s.fields.filter((f) => ids.includes(f.id)) }))
      .filter((s) => s.fields.length),
  };
}
export class DirectoryMetadata {
  constructor(
    private store: Store,
    private verifyWorkflow?: (
      c: MutationContext,
      link: ProfileWorkflowLink,
      proposal: Record<string, any>,
    ) => Promise<void>,
  ) {}
  private async own(db: Db, actor: Principal, tenant: string, personId: string) {
    if (
      actor.personId !== personId ||
      !(
        await db.query('SELECT 1 FROM persons WHERE id=$1 AND home_tenant_id=$2 AND active', [
          personId,
          tenant,
        ])
      ).rowCount ||
      !(
        await db.query(
          "SELECT 1 FROM tenant_memberships m JOIN application_grants g ON g.account_id=m.account_id AND g.tenant_id=m.tenant_id JOIN applications a ON a.code=g.app_code AND a.status='active' WHERE m.account_id=$1 AND m.tenant_id=$2 AND m.active AND g.app_code='aio-foundation' AND g.active AND (g.valid_until IS NULL OR g.valid_until>now())",
          [actor.accountId, tenant],
        )
      ).rowCount
    )
      throw new HttpError(403, 'PROFILE_SELF_DENIED');
  }
  private async latest(db: Db, tenant: string, res: string) {
    resource(res);
    const row = (
      await db.query(
        'SELECT v.* FROM directory_schema_versions v JOIN directory_configurations c ON c.tenant_id=v.tenant_id AND c.resource=v.resource AND c.current_version=v.version WHERE v.tenant_id=$1 AND v.resource=$2',
        [tenant, res],
      )
    ).rows[0];
    if (!row) throw new HttpError(409, 'PROFILE_CONFIGURATION_UNPUBLISHED');
    return {
      version: Number(row.version),
      config: parseDirectoryConfiguration(row.configuration, res),
    };
  }
  async configuration(actor: Principal, tenant: string, res: string) {
    resource(res);
    this.store.require(actor, manage(res), tenant);
    const config = (
      await this.store.pool.query(
        'SELECT * FROM directory_configurations WHERE tenant_id=$1 AND resource=$2',
        [tenant, res],
      )
    ).rows[0];
    const versions = (
      await this.store.pool.query(
        'SELECT version,published_at FROM directory_schema_versions WHERE tenant_id=$1 AND resource=$2 ORDER BY version DESC',
        [tenant, res],
      )
    ).rows;
    return { configuration: config ? camelRow(config) : null, versions: versions.map(camelRow) };
  }
  async saveConfiguration(
    c: MutationContext,
    res: string,
    value: unknown,
    expectedRevision: number,
  ) {
    resource(res);
    const draft = parseDirectoryConfiguration(value, res);
    return mutate(
      this.store,
      c,
      manage(res),
      'directory.configuration.save',
      { res, draft, expectedRevision },
      async (db, actor) => {
        const before =
          (
            await db.query(
              'SELECT * FROM directory_configurations WHERE tenant_id=$1 AND resource=$2',
              [c.tenantId, res],
            )
          ).rows[0] ?? null;
        if ((before?.revision ?? 0) !== expectedRevision)
          throw new HttpError(409, 'REVISION_CONFLICT');
        const row = (
          await db.query(
            'INSERT INTO directory_configurations(tenant_id,resource,draft) VALUES($1,$2,$3) ON CONFLICT(tenant_id,resource) DO UPDATE SET draft=EXCLUDED.draft,revision=directory_configurations.revision+1 RETURNING *',
            [c.tenantId, res, JSON.stringify(draft)],
          )
        ).rows[0];
        await auditMutation(
          db,
          c,
          actor,
          'directory.configuration.saved',
          'configuration',
          res,
          before,
          row,
        );
        return camelRow(row);
      },
    );
  }
  async publish(c: MutationContext, res: string, expectedRevision: number) {
    resource(res);
    return mutate(
      this.store,
      c,
      manage(res),
      'directory.configuration.publish',
      { res, expectedRevision },
      async (db, actor) => {
        const before = (
          await db.query(
            'SELECT * FROM directory_configurations WHERE tenant_id=$1 AND resource=$2',
            [c.tenantId, res],
          )
        ).rows[0];
        if (!before || before.revision !== expectedRevision)
          throw new HttpError(409, 'REVISION_CONFLICT');
        const configuration = parseDirectoryConfiguration(before.draft, res),
          version = before.current_version + 1;
        // An existing field ID must never silently change type; use a new ID and retain old history.
        const old = (
          await db.query(
            'SELECT configuration FROM directory_schema_versions WHERE tenant_id=$1 AND resource=$2',
            [c.tenantId, res],
          )
        ).rows;
        for (const row of old) {
          const fields = schemaFields(row.configuration.schema);
          if (
            schemaFields(configuration.schema).some((f) =>
              fields.some((old) => old.id === f.id && old.type !== f.type),
            )
          )
            throw new HttpError(400, 'PROFILE_FIELD_TYPE_IMMUTABLE');
        }
        await db.query(
          'INSERT INTO directory_schema_versions(tenant_id,resource,version,configuration,published_by) VALUES($1,$2,$3,$4,$5)',
          [c.tenantId, res, version, JSON.stringify(configuration), actor.accountId],
        );
        const row = (
          await db.query(
            'UPDATE directory_configurations SET current_version=$3,revision=revision+1 WHERE tenant_id=$1 AND resource=$2 RETURNING *',
            [c.tenantId, res, version],
          )
        ).rows[0];
        await auditMutation(
          db,
          c,
          actor,
          'directory.configuration.published',
          'configuration',
          res,
          before,
          row,
        );
        return camelRow(row);
      },
    );
  }
  async record(actor: Principal, tenant: string, res: string, id: string, self = false) {
    resource(res);
    if (self) {
      if (res !== 'people') throw new HttpError(403, 'PROFILE_SELF_DENIED');
      await this.own(this.store.pool, actor, tenant, id);
    } else await new DirectoryService(this.store).get(res, actor, tenant, id);
    const latest = await this.latest(this.store.pool, tenant, res),
      row = (
        await this.store.pool.query(
          'SELECT * FROM directory_metadata WHERE tenant_id=$1 AND resource=$2 AND target_id=$3',
          [tenant, res, id],
        )
      ).rows[0];
    const ids = self ? latest.config.selfView : schemaFields(latest.config.schema).map((f) => f.id),
      answers = Object.fromEntries(
        Object.entries(row?.answers ?? {}).filter(([id]) => ids.includes(id)),
      );
    return {
      schema: projectedSchema(latest.config, ids),
      selfEdit: self ? latest.config.selfEdit : [],
      answers,
      revision: row?.revision ?? 0,
      schemaVersion: latest.version,
      storedVersion: row?.schema_version ?? 0,
    };
  }
  private async saveValues(
    db: PoolClient,
    c: MutationContext,
    actor: Principal,
    res: string,
    id: string,
    values: unknown,
    expectedRevision: number,
    expectedVersion: number,
  ) {
    const latest = await this.latest(db, c.tenantId, res);
    if (latest.version !== expectedVersion) throw new HttpError(409, 'PROFILE_SCHEMA_CHANGED');
    const answers = parseAnswers(latest.config.schema, values, 'submit');
    const before =
      (
        await db.query(
          'SELECT * FROM directory_metadata WHERE tenant_id=$1 AND resource=$2 AND target_id=$3',
          [c.tenantId, res, id],
        )
      ).rows[0] ?? null;
    if ((before?.revision ?? 0) !== expectedRevision) throw new HttpError(409, 'REVISION_CONFLICT');
    const row = (
      await db.query(
        'INSERT INTO directory_metadata(tenant_id,resource,target_id,schema_version,answers) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,resource,target_id) DO UPDATE SET schema_version=EXCLUDED.schema_version,answers=EXCLUDED.answers,revision=directory_metadata.revision+1,updated_at=now() RETURNING *',
        [c.tenantId, res, id, expectedVersion, JSON.stringify(answers)],
      )
    ).rows[0];
    await db.query(
      'INSERT INTO directory_metadata_history(tenant_id,resource,target_id,schema_version,answers,revision,actor_account_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        c.tenantId,
        res,
        id,
        expectedVersion,
        JSON.stringify(answers),
        row.revision,
        actor.accountId,
      ],
    );
    await auditMutation(db, c, actor, 'directory.metadata.saved', res, id, before, row);
    return camelRow(row);
  }
  async save(
    c: MutationContext,
    res: string,
    id: string,
    answers: unknown,
    expectedRevision: number,
    expectedVersion: number,
  ) {
    resource(res);
    return mutate(
      this.store,
      c,
      manage(res),
      'directory.metadata.save',
      { res, id, answers, expectedRevision, expectedVersion },
      async (db, a) =>
        this.saveValues(db, c, a, res, id, answers, expectedRevision, expectedVersion),
      async (db, a) => {
        const row = await new DirectoryService(this.store).get(res, a, c.tenantId, id, db);
        if (row.active === false) throw new HttpError(400, 'PROFILE_TARGET_INACTIVE');
      },
    );
  }
  async history(actor: Principal, tenant: string, res: string, id: string, cursor?: string) {
    resource(res);
    if (cursor && !/^[1-9][0-9]{0,9}$/.test(cursor)) throw new HttpError(400, 'INVALID_REQUEST');
    await new DirectoryService(this.store).get(res, actor, tenant, id);
    const rows = (
      await this.store.pool.query(
        'SELECT h.*,v.configuration FROM directory_metadata_history h JOIN directory_schema_versions v ON v.tenant_id=h.tenant_id AND v.resource=h.resource AND v.version=h.schema_version WHERE h.tenant_id=$1 AND h.resource=$2 AND h.target_id=$3' +
          (cursor ? ' AND h.revision<$4' : '') +
          ' ORDER BY h.revision DESC LIMIT 101',
        [tenant, res, id, ...(cursor ? [Number(cursor)] : [])],
      )
    ).rows;
    return {
      items: rows.slice(0, 100).map(camelRow),
      nextCursor: rows.length > 100 ? String(rows[99].revision) : null,
    };
  }

  async propose(c: MutationContext, patch: unknown, baseRevision: number, version: number) {
    return mutate(
      this.store,
      c,
      null,
      'profile.propose',
      { patch, baseRevision, version },
      async (db, a) => {
        const latest = await this.latest(db, c.tenantId, 'people');
        if (latest.version !== version) throw new HttpError(409, 'PROFILE_SCHEMA_CHANGED');
        if (
          !patch ||
          typeof patch !== 'object' ||
          Array.isArray(patch) ||
          !Object.keys(patch).length ||
          Object.keys(patch).some((id) => !latest.config.selfEdit.includes(id))
        )
          throw new HttpError(403, 'PROFILE_FIELD_DENIED');
        const current = (
          await db.query(
            "SELECT * FROM directory_metadata WHERE tenant_id=$1 AND resource='people' AND target_id=$2",
            [c.tenantId, a.personId],
          )
        ).rows[0];
        if ((current?.revision ?? 0) !== baseRevision)
          throw new HttpError(409, 'REVISION_CONFLICT');
        const ids = schemaFields(latest.config.schema).map((f) => f.id),
          merged = mergePatch(current?.answers ?? {}, patch as Record<string, unknown>, ids);
        try {
          parseAnswers(latest.config.schema, merged, 'submit');
        } catch {
          throw new HttpError(400, 'PROFILE_PROPOSAL_INVALID');
        }
        const row = (
          await db.query(
            'INSERT INTO directory_profile_proposals(tenant_id,person_id,actor_account_id,schema_version,base_revision,patch,reason) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              c.tenantId,
              a.personId,
              a.accountId,
              version,
              baseRevision,
              JSON.stringify(patch),
              c.reason,
            ],
          )
        ).rows[0];
        await auditMutation(
          db,
          c,
          a,
          'profile.proposed',
          'profile-proposal',
          row.id,
          null,
          row,
          a.accountId,
        );
        return { id: row.id, status: row.status, revision: row.revision };
      },
      async (db, a) => this.own(db, a, c.tenantId, a.personId),
    );
  }
  async proposals(actor: Principal, tenant: string, self = false, cursor?: string) {
    if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor))
      throw new HttpError(400, 'INVALID_REQUEST');
    if (self) await this.own(this.store.pool, actor, tenant, actor.personId);
    else {
      this.store.require(actor, 'people:manage', tenant);
      this.store.require(actor, 'people:read', tenant);
    }
    const params = [tenant, ...(self ? [actor.personId] : [])];
    let where = self ? ' AND q.person_id=$2' : '';
    if (cursor) {
      params.push(cursor);
      where +=
        ' AND (q.created_at,q.id)<(SELECT created_at,id FROM directory_profile_proposals WHERE tenant_id=$1 AND id=$' +
        params.length +
        (self ? ' AND person_id=$2' : '') +
        ')';
    }
    const page = (
        await this.store.pool.query(
          "SELECT q.*,p.display_name,v.configuration,EXISTS(SELECT 1 FROM directory_profile_workflows w WHERE w.tenant_id=q.tenant_id AND w.proposal_id=q.id) AS workflow_linked FROM directory_profile_proposals q JOIN persons p ON p.id=q.person_id AND p.home_tenant_id=q.tenant_id JOIN directory_schema_versions v ON v.tenant_id=q.tenant_id AND v.resource='people' AND v.version=q.schema_version WHERE q.tenant_id=$1" +
            where +
            ' ORDER BY q.created_at DESC,q.id DESC LIMIT 101',
          params,
        )
      ).rows,
      rows = page.slice(0, 100);
    const allowed =
      self && rows.length
        ? (await this.latest(this.store.pool, tenant, 'people')).config.selfView
        : null;
    return {
      nextCursor: page.length > 100 ? String(page[99].id) : null,
      items: rows.map((row) => {
        const { configuration, ...record } = row;
        const fields = schemaFields(configuration.schema);
        const patch = Object.fromEntries(
          Object.entries(row.patch).filter(([id]) => allowed === null || allowed.includes(id)),
        );
        return {
          ...camelRow(record),
          patch,
          changes: Object.entries(patch).map(([id, value]) => {
            const field = fields.find((f) => f.id === id);
            const format = (v: unknown) =>
              field?.options?.find((o) => o.id === v)?.label ??
              (v === null
                ? '(Xóa giá trị)'
                : typeof v === 'boolean'
                  ? v
                    ? 'Có'
                    : 'Không'
                  : String(v));
            return {
              id,
              label: field?.label ?? id,
              value: Array.isArray(value) ? value.map(format).join(', ') : format(value),
            };
          }),
        };
      }),
    };
  }

  async review(
    c: MutationContext,
    id: string,
    decision: 'approved' | 'rejected' | 'withdrawn',
    expectedRevision: number,
  ) {
    if (!['approved', 'rejected', 'withdrawn'].includes(decision))
      throw new HttpError(400, 'INVALID_REQUEST');
    return mutate(
      this.store,
      c,
      decision === 'withdrawn' ? null : 'people:manage',
      'profile.review',
      { id, decision, expectedRevision },
      async (db, a) => {
        const row = (
          await db.query('SELECT * FROM directory_profile_proposals WHERE tenant_id=$1 AND id=$2', [
            c.tenantId,
            id,
          ])
        ).rows[0];
        if (!row || row.revision !== expectedRevision || row.status !== 'pending')
          throw new HttpError(409, 'REVISION_CONFLICT');
        if (decision === 'approved') {
          const config = await this.latest(db, c.tenantId, 'people');
          if (
            config.version !== row.schema_version ||
            Object.keys(row.patch).some((id) => !config.config.selfEdit.includes(id))
          )
            throw new HttpError(409, 'PROFILE_SCHEMA_CHANGED');
          const target = await new DirectoryService(this.store).get(
            'people',
            a,
            c.tenantId,
            row.person_id,
            db,
          );
          if (target.active === false) throw new HttpError(400, 'PROFILE_TARGET_INACTIVE');
          const old = (
            await db.query(
              "SELECT answers FROM directory_metadata WHERE tenant_id=$1 AND resource='people' AND target_id=$2",
              [c.tenantId, row.person_id],
            )
          ).rows[0];
          const ids = schemaFields(config.config.schema).map((f) => f.id);
          await this.saveValues(
            db,
            c,
            a,
            'people',
            row.person_id,
            mergePatch(old?.answers ?? {}, row.patch, ids),
            row.base_revision,
            row.schema_version,
          );
          await db.query(
            'UPDATE directory_profile_workflows SET applied_at=now(),revision=revision+1 WHERE tenant_id=$1 AND proposal_id=$2 AND applied_at IS NULL',
            [c.tenantId, id],
          );
        }
        const result = (
          await db.query(
            'UPDATE directory_profile_proposals SET status=$3,revision=revision+1,review_reason=$4,reviewer_account_id=$5,reviewed_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
            [c.tenantId, id, decision, c.reason, a.accountId],
          )
        ).rows[0];
        await auditMutation(
          db,
          c,
          a,
          'profile.' + decision,
          'profile-proposal',
          id,
          row,
          result,
          row.actor_account_id,
        );
        return { id, status: result.status, revision: result.revision };
      },
      async (db, a) => {
        const row = (
          await db.query('SELECT * FROM directory_profile_proposals WHERE tenant_id=$1 AND id=$2', [
            c.tenantId,
            id,
          ])
        ).rows[0];
        if (!row) throw new HttpError(404, 'RECORD_NOT_FOUND');
        if (decision === 'withdrawn') {
          await this.own(db, a, c.tenantId, row.person_id);
          if (row.actor_account_id !== a.accountId) throw new HttpError(403, 'PROFILE_SELF_DENIED');
        } else {
          this.store.require(a, 'people:manage', c.tenantId);
          if (a.personId === row.person_id) throw new HttpError(403, 'SELF_MANAGEMENT_FORBIDDEN');
          if (decision === 'approved') {
            const link = (
              await db.query(
                'SELECT * FROM directory_profile_workflows WHERE tenant_id=$1 AND proposal_id=$2',
                [c.tenantId, id],
              )
            ).rows[0] as ProfileWorkflowLink | undefined;
            if (link) {
              if (!this.verifyWorkflow) throw new HttpError(409, 'PROFILE_WORKFLOW_REQUIRED');
              await this.verifyWorkflow(c, link, row);
            }
          }
        }
      },
    );
  }
}
