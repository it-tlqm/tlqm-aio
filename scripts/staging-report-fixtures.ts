import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Page } from '@playwright/test';
import { ids } from '../src/fixtures.js';

export const reportActors = {
  reviewer: {
    id: '40000000-0000-4000-8000-000000000011',
    username: 'stage.report-reviewer',
    name: 'Quản lý báo cáo đơn vị A giả lập',
    tenantId: ids.tenantA,
    unitId: ids.unitA,
    forms: ['forms:review'],
    lms: ['lms:review', 'directory:lookup'],
  },
  analyst: {
    id: '40000000-0000-4000-8000-000000000012',
    username: 'stage.report-analyst',
    name: 'Phân tích Forms đơn vị A giả lập',
    tenantId: ids.tenantA,
    unitId: ids.unitA,
    forms: ['forms:analyze', 'forms:export'],
    lms: [],
  },
  outside: {
    id: '40000000-0000-4000-8000-000000000013',
    username: 'stage.report-outside',
    name: 'Học viên đơn vị C giả lập',
    tenantId: ids.tenantA,
    unitId: ids.unitC,
    forms: ['forms:respond'],
    lms: ['lms:learn'],
  },
} as const;

export type ReportActor = keyof typeof reportActors;
export type ReportSession = (
  app: 'aio-forms' | 'aio-lms-sandbox',
  actor: ReportActor,
) => Promise<Page>;

export async function provisionStagingReportActors(
  db: PoolClient,
  issuer: string,
  subjects: Record<ReportActor, string>,
) {
  const roles = Object.keys(reportActors) as ReportActor[];
  for (const role of roles) {
    const actor = reportActors[role];
    assert.match(subjects[role], /^[0-9a-f-]{36}$/);
    await db.query('INSERT INTO persons(id,display_name,home_tenant_id) VALUES ($1,$2,$3)', [
      actor.id,
      actor.name,
      actor.tenantId,
    ]);
    await db.query('INSERT INTO accounts(id,person_id,mfa_required) VALUES ($1,$1,true)', [
      actor.id,
    ]);
    await db.query('INSERT INTO external_identities(issuer,subject,account_id) VALUES ($1,$2,$3)', [
      issuer,
      subjects[role],
      actor.id,
    ]);
    await db.query('INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)', [
      actor.id,
      actor.tenantId,
    ]);
    const employment = randomUUID();
    await db.query(
      'INSERT INTO employments(id,person_id,tenant_id,legal_entity_id,employee_code) VALUES ($1,$2,$3,$4,$5)',
      [employment, actor.id, actor.tenantId, ids.legalA, 'NV-STAGE-REPORT-' + role],
    );
    const assignment = await db.query(
      `INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary)
       SELECT $1,p.tenant_id,p.legal_entity_id,$2,p.id,true FROM positions p
       WHERE p.tenant_id=$3 AND p.org_unit_id=$4 AND p.legal_entity_id=$5 AND p.active
       ORDER BY p.id LIMIT 1`,
      [randomUUID(), employment, actor.tenantId, actor.unitId, ids.legalA],
    );
    assert.equal(assignment.rowCount, 1);
    for (const [app, permissions] of [
      ['aio-forms', actor.forms],
      ['aio-lms-sandbox', actor.lms],
    ] as const) {
      if (!permissions.length) continue;
      const roleCode = 'stage-report-' + role;
      await db.query(
        'INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,$3)',
        [actor.id, actor.tenantId, app],
      );
      await db.query('INSERT INTO app_roles(tenant_id,app_code,code,name) VALUES ($1,$2,$3,$3)', [
        actor.tenantId,
        app,
        roleCode,
      ]);
      for (const permission of permissions) {
        await db.query(
          'INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,$2,$3,$4)',
          [actor.tenantId, app, roleCode, permission],
        );
      }
      await db.query(
        'INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code,org_unit_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), actor.id, actor.tenantId, app, roleCode, actor.unitId],
      );
    }
  }
}
