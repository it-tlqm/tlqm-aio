import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Principal, Store } from '../store.js';
import { HttpError } from '../security.js';
import { auditMutation, mutate } from './mutations.js';
import type { MutationContext } from './mutations.js';
import { responsibilityTables, validateResponsibility } from './responsibilities.js';

const uuid = { type: 'string', format: 'uuid' };
const optionalUuid = { anyOf: [uuid, { type: 'null' }] };
const instant = { type: 'string', format: 'date-time' };
const text = { type: 'string', minLength: 1, maxLength: 160, pattern: '\\S' };
const code = { type: 'string', minLength: 2, maxLength: 48, pattern: '^[A-Za-z0-9_-]+$' };
type Field = { column: string; schema: Record<string, unknown> };
type Resource = {
  table: string;
  tenantColumn: string | null;
  read: string;
  manage: string;
  fields: Record<string, Field>;
  required: string[];
  immutable?: string[];
};
const field = (column: string, schema: Record<string, unknown>): Field => ({ column, schema });
export const directoryResources: Record<string, Resource> = {
  'legal-entities': {
    table: 'legal_entities',
    tenantColumn: 'tenant_id',
    read: 'directory:read',
    manage: 'directory:manage',
    fields: {
      code: field('code', code),
      name: field('name', text),
      active: field('active', { type: 'boolean' }),
    },
    required: ['code', 'name'],
  },
  'org-units': {
    table: 'org_units',
    tenantColumn: 'tenant_id',
    read: 'directory:read',
    manage: 'directory:manage',
    fields: {
      legalEntityId: field('legal_entity_id', uuid),
      parentId: field('parent_id', optionalUuid),
      code: field('code', code),
      name: field('name', text),
      active: field('active', { type: 'boolean' }),
    },
    required: ['legalEntityId', 'code', 'name'],
    immutable: ['legalEntityId'],
  },
  'job-titles': {
    table: 'job_titles',
    tenantColumn: 'tenant_id',
    read: 'directory:read',
    manage: 'directory:manage',
    fields: {
      code: field('code', code),
      name: field('name', text),
      active: field('active', { type: 'boolean' }),
    },
    required: ['code', 'name'],
  },
  positions: {
    table: 'positions',
    tenantColumn: 'tenant_id',
    read: 'directory:read',
    manage: 'directory:manage',
    fields: {
      legalEntityId: field('legal_entity_id', uuid),
      orgUnitId: field('org_unit_id', uuid),
      jobTitleId: field('job_title_id', uuid),
      name: field('name', text),
      active: field('active', { type: 'boolean' }),
    },
    required: ['legalEntityId', 'orgUnitId', 'jobTitleId', 'name'],
    immutable: ['legalEntityId'],
  },
  people: {
    table: 'persons',
    tenantColumn: 'home_tenant_id',
    read: 'people:read',
    manage: 'people:manage',
    fields: {
      displayName: field('display_name', text),
      active: field('active', { type: 'boolean' }),
    },
    required: ['displayName'],
  },
  accounts: {
    table: 'accounts',
    tenantColumn: null,
    read: 'accounts:manage',
    manage: 'accounts:manage',
    fields: { personId: field('person_id', uuid), active: field('active', { type: 'boolean' }) },
    required: ['personId'],
    immutable: ['personId'],
  },
  employments: {
    table: 'employments',
    tenantColumn: 'tenant_id',
    read: 'people:read',
    manage: 'people:manage',
    fields: {
      personId: field('person_id', uuid),
      legalEntityId: field('legal_entity_id', uuid),
      employeeCode: field('employee_code', code),
      validFrom: field('valid_from', instant),
      validUntil: field('valid_until', { anyOf: [instant, { type: 'null' }] }),
    },
    required: ['personId', 'legalEntityId', 'employeeCode', 'validFrom'],
    immutable: ['personId', 'legalEntityId'],
  },
  assignments: {
    table: 'assignments',
    tenantColumn: 'tenant_id',
    read: 'people:read',
    manage: 'people:manage',
    fields: {
      legalEntityId: field('legal_entity_id', uuid),
      employmentId: field('employment_id', uuid),
      positionId: field('position_id', uuid),
      isPrimary: field('is_primary', { type: 'boolean' }),
      validFrom: field('valid_from', instant),
      validUntil: field('valid_until', { anyOf: [instant, { type: 'null' }] }),
    },
    required: ['legalEntityId', 'employmentId', 'positionId', 'isPrimary', 'validFrom'],
    immutable: ['legalEntityId', 'employmentId', 'positionId'],
  },
};
export function camelRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}
for (const [key, spec] of Object.entries(responsibilityTables)) {
  directoryResources[key] = {
    table: spec.table,
    tenantColumn: 'tenant_id',
    read: 'people:read',
    manage: 'people:manage',
    fields: {
      legalEntityId: field('legal_entity_id', uuid),
      employmentId: field('employment_id', uuid),
      ...(spec.key
        ? { [spec.key]: field(spec.target, uuid) }
        : { orgUnitId: field('org_unit_id', uuid) }),
      validFrom: field('valid_from', instant),
      validUntil: field('valid_until', { anyOf: [instant, { type: 'null' }] }),
      active: field('active', { type: 'boolean' }),
    },
    required: ['legalEntityId', 'employmentId', spec.key ?? 'orgUnitId', 'validFrom'],
    immutable: ['legalEntityId', 'employmentId', spec.key ?? 'orgUnitId'],
  };
}
function definition(resource: string): Resource {
  const value = directoryResources[resource];
  if (!value) throw new HttpError(404, 'RESOURCE_NOT_FOUND');
  return value;
}
function tenantWhere(resource: Resource) {
  return resource.tenantColumn
    ? 't.' + resource.tenantColumn + '=$1'
    : 'EXISTS(SELECT 1 FROM persons p WHERE p.id=t.person_id AND p.home_tenant_id=$1)';
}
function allowedUnits(principal: Principal, permission: string, tenantId: string): string[] | null {
  const matches = principal.permissions.filter(
    (value) => value.tenantId === tenantId && value.permission === permission,
  );
  if (!matches.length) throw new HttpError(403, 'PERMISSION_DENIED');
  return matches.some((value) => value.orgUnitId === null)
    ? null
    : [...new Set(matches.map((value) => value.orgUnitId!))];
}
const unitFilters: Record<string, string> = {
  'legal-entities':
    'EXISTS(SELECT 1 FROM org_units u WHERE u.legal_entity_id=t.id AND u.id=ANY($2::uuid[]))',
  'org-units': 't.id=ANY($2::uuid[])',
  'job-titles':
    'EXISTS(SELECT 1 FROM positions p WHERE p.job_title_id=t.id AND p.org_unit_id=ANY($2::uuid[]))',
  positions: 't.org_unit_id=ANY($2::uuid[])',
  assignments:
    'EXISTS(SELECT 1 FROM positions p WHERE p.id=t.position_id AND p.org_unit_id=ANY($2::uuid[]))',
  employments:
    'EXISTS(SELECT 1 FROM assignments a JOIN positions p ON p.id=a.position_id WHERE a.employment_id=t.id AND p.org_unit_id=ANY($2::uuid[]) AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now()))',
  people:
    'EXISTS(SELECT 1 FROM employments e JOIN assignments a ON a.employment_id=e.id JOIN positions p ON p.id=a.position_id WHERE e.person_id=t.id AND p.org_unit_id=ANY($2::uuid[]) AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now()))',
};
for (const [resource, spec] of Object.entries(responsibilityTables)) {
  const visibleEmployment = (column: string) =>
    'EXISTS(SELECT 1 FROM assignments a JOIN positions p ON p.id=a.position_id WHERE a.employment_id=t.' +
    column +
    ' AND p.org_unit_id=ANY($2::uuid[]) AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now()))';
  unitFilters[resource] =
    visibleEmployment('employment_id') +
    (spec.target ? ' AND ' + visibleEmployment(spec.target) : ' AND t.org_unit_id=ANY($2::uuid[])');
}
export class DirectoryService {
  constructor(private store: Store) {}
  async get(
    resource: string,
    principal: Principal,
    tenantId: string,
    id: string,
    db: Pool | PoolClient = this.store.pool,
  ) {
    const spec = definition(resource),
      units = allowedUnits(principal, spec.read, tenantId);
    if (units && !unitFilters[resource]) throw new HttpError(403, 'PERMISSION_DENIED');
    const row = (
      await db.query(
        'SELECT t.* FROM ' +
          spec.table +
          ' t WHERE ' +
          tenantWhere(spec) +
          (units ? ' AND ' + unitFilters[resource] : '') +
          ' AND t.id=$' +
          (units ? 3 : 2),
        [tenantId, ...(units ? [units] : []), id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'RECORD_NOT_FOUND');
    return camelRow(row);
  }
  async list(resource: string, principal: Principal, tenantId: string, cursor?: string) {
    if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor))
      throw new HttpError(400, 'INVALID_REQUEST');
    const spec = definition(resource);
    const units = allowedUnits(principal, spec.read, tenantId);
    if (units && !unitFilters[resource]) throw new HttpError(403, 'PERMISSION_DENIED');
    const result = await this.store.pool.query(
      'SELECT t.* FROM ' +
        spec.table +
        ' t WHERE ' +
        tenantWhere(spec) +
        (units ? ' AND ' + unitFilters[resource] : '') +
        (cursor ? ' AND t.id>$' + (units ? 3 : 2) + '::uuid' : '') +
        ' ORDER BY t.id LIMIT 501',
      [...(units ? [tenantId, units] : [tenantId]), ...(cursor ? [cursor] : [])],
    );
    return {
      items: result.rows.slice(0, 500).map(camelRow),
      limit: 500,
      nextCursor: result.rows.length > 500 ? (result.rows[499].id as string) : null,
    };
  }
  async save(
    resource: string,
    context: MutationContext,
    data: Record<string, unknown>,
    id?: string,
    expectedRevision?: number,
  ) {
    const spec = definition(resource);
    const keys = Object.keys(data);
    if (!keys.length || keys.some((key) => !spec.fields[key]))
      throw new HttpError(400, 'INVALID_REQUEST');
    if (!id && spec.required.some((key) => data[key] === undefined))
      throw new HttpError(400, 'MISSING_REQUIRED_FIELD');
    if (id && (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1))
      throw new HttpError(400, 'REVISION_REQUIRED');
    return mutate(
      this.store,
      context,
      spec.manage,
      resource + (id ? '.update' : '.create'),
      { id: id ?? null, expectedRevision: expectedRevision ?? null, data },
      (db, actor) =>
        this.saveInTransaction(db, actor, resource, context, data, id, expectedRevision),
    );
  }
  /** Caller owns the transaction and has refreshed the actor under the shared mutation lock. */
  async saveInTransaction(
    db: PoolClient,
    actor: Principal,
    resource: string,
    context: MutationContext,
    data: Record<string, unknown>,
    id?: string,
    expectedRevision?: number,
  ) {
    const spec = definition(resource),
      keys = Object.keys(data);
    this.store.require(actor, spec.manage, context.tenantId);
    if (!keys.length || keys.some((key) => !spec.fields[key]))
      throw new HttpError(400, 'INVALID_REQUEST');
    if (!id && spec.required.some((key) => data[key] === undefined))
      throw new HttpError(400, 'MISSING_REQUIRED_FIELD');

    let before: Record<string, unknown> | null = null;
    if (id) {
      before =
        (
          await db.query(
            'SELECT t.* FROM ' +
              spec.table +
              ' t WHERE ' +
              tenantWhere(spec) +
              ' AND t.id=$2 FOR UPDATE',
            [context.tenantId, id],
          )
        ).rows[0] ?? null;
      if (!before) throw new HttpError(404, 'RECORD_NOT_FOUND');
      if (before.revision !== expectedRevision) throw new HttpError(409, 'REVISION_CONFLICT');
      if (
        spec.immutable?.some(
          (key) => data[key] !== undefined && data[key] !== before![spec.fields[key]!.column],
        )
      )
        throw new HttpError(400, 'IMMUTABLE_RELATION');
    }
    await this.validateRelations(db, resource, context.tenantId, data, before, actor);
    let row: Record<string, unknown>;
    if (id) {
      const set = keys.map((key, index) => spec.fields[key]!.column + '=$' + (index + 3));
      row = (
        await db.query(
          'UPDATE ' +
            spec.table +
            ' t SET ' +
            set.join(',') +
            ',revision=revision+1 WHERE ' +
            tenantWhere(spec) +
            ' AND t.id=$2 RETURNING t.*',
          [context.tenantId, id, ...keys.map((key) => data[key])],
        )
      ).rows[0];
    } else {
      const recordId = randomUUID();
      const columns = [
        'id',
        ...(spec.tenantColumn ? [spec.tenantColumn] : []),
        ...keys.map((key) => spec.fields[key]!.column),
      ];
      const values = [
        recordId,
        ...(spec.tenantColumn ? [context.tenantId] : []),
        ...keys.map((key) => data[key]),
      ];
      row = (
        await db.query(
          'INSERT INTO ' +
            spec.table +
            '(' +
            columns.join(',') +
            ') VALUES (' +
            values.map((_, index) => '$' + (index + 1)).join(',') +
            ') RETURNING *',
          values,
        )
      ).rows[0];
      if (resource === 'accounts')
        await db.query('INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)', [
          recordId,
          context.tenantId,
        ]);
    }
    await auditMutation(
      db,
      context,
      actor,
      resource + (id ? '.updated' : '.created'),
      resource,
      String(row.id),
      before,
      row,
      resource === 'accounts' ? String(row.id) : null,
    );
    return camelRow(row);
  }
  private async validateRelations(
    db: PoolClient,
    resource: string,
    tenantId: string,
    data: Record<string, unknown>,
    before: Record<string, unknown> | null,
    actor: Principal,
  ) {
    if (resource in responsibilityTables) {
      const spec = definition(resource);
      await validateResponsibility(db, resource, tenantId, {
        ...before,
        ...Object.fromEntries(
          Object.entries(data).map(([key, value]) => [spec.fields[key]!.column, value]),
        ),
      });
    }
    if (resource === 'people' && data.active === false) {
      if (before?.id === actor.personId) throw new HttpError(403, 'SELF_MANAGEMENT_FORBIDDEN');
      if (
        (await db.query('SELECT 1 FROM accounts WHERE person_id=$1 AND is_protected', [before?.id]))
          .rowCount
      )
        throw new HttpError(403, 'PROTECTED_ACCOUNT');
    }
    if (resource === 'accounts') {
      if (before?.is_protected) throw new HttpError(403, 'PROTECTED_ACCOUNT');
      if (before?.id === actor.accountId) throw new HttpError(403, 'SELF_MANAGEMENT_FORBIDDEN');
      if (
        !before &&
        !(
          await db.query('SELECT 1 FROM persons WHERE id=$1 AND home_tenant_id=$2 AND active', [
            data.personId,
            tenantId,
          ])
        ).rowCount
      )
        throw new HttpError(400, 'INVALID_RELATION');
      if (before && data.active === false)
        await db.query('DELETE FROM sessions WHERE account_id=$1', [before.id]);
    }
    if (
      data.legalEntityId &&
      !(
        await db.query('SELECT 1 FROM legal_entities WHERE id=$1 AND tenant_id=$2 AND active', [
          data.legalEntityId,
          tenantId,
        ])
      ).rowCount
    )
      throw new HttpError(400, 'INVALID_RELATION');
    if (
      resource === 'org-units' &&
      data.parentId &&
      !(
        await db.query('SELECT 1 FROM org_units WHERE id=$1 AND tenant_id=$2 AND active', [
          data.parentId,
          tenantId,
        ])
      ).rowCount
    )
      throw new HttpError(400, 'INVALID_RELATION');
    if (resource === 'positions') {
      if (
        data.orgUnitId &&
        !(
          await db.query('SELECT 1 FROM org_units WHERE id=$1 AND tenant_id=$2 AND active', [
            data.orgUnitId,
            tenantId,
          ])
        ).rowCount
      )
        throw new HttpError(400, 'INVALID_RELATION');
      if (
        data.jobTitleId &&
        !(
          await db.query('SELECT 1 FROM job_titles WHERE id=$1 AND tenant_id=$2 AND active', [
            data.jobTitleId,
            tenantId,
          ])
        ).rowCount
      )
        throw new HttpError(400, 'INVALID_RELATION');
    }
    if (
      resource === 'employments' &&
      data.personId &&
      !(
        await db.query('SELECT 1 FROM persons WHERE id=$1 AND home_tenant_id=$2 AND active', [
          data.personId,
          tenantId,
        ])
      ).rowCount
    )
      throw new HttpError(400, 'INVALID_RELATION');
    if (resource === 'assignments' && !before) {
      if (
        !(
          await db.query(
            'SELECT 1 FROM positions p JOIN org_units u ON u.id=p.org_unit_id WHERE p.id=$1 AND p.tenant_id=$2 AND p.active AND u.active',
            [data.positionId, tenantId],
          )
        ).rowCount
      )
        throw new HttpError(400, 'INVALID_RELATION');
    }
    if (data.active === false && before) {
      const dependencies: Record<string, string> = {
        'legal-entities': 'SELECT 1 FROM org_units WHERE legal_entity_id=$1 AND active LIMIT 1',
        'org-units':
          'SELECT 1 FROM org_units WHERE parent_id=$1 AND active UNION ALL SELECT 1 FROM positions WHERE org_unit_id=$1 AND active LIMIT 1',
        'job-titles': 'SELECT 1 FROM positions WHERE job_title_id=$1 AND active LIMIT 1',
        positions:
          'SELECT 1 FROM assignments WHERE position_id=$1 AND (valid_until IS NULL OR valid_until>now()) LIMIT 1',
      };
      if (dependencies[resource] && (await db.query(dependencies[resource], [before.id])).rowCount)
        throw new HttpError(409, 'ACTIVE_DEPENDENCIES');
    }
  }
}
