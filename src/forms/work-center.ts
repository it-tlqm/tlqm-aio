import type { FormsActor } from './access.js';
import { hasFormsPermission } from './access.js';
import type { Pool } from 'pg';

export type FormWorkItem = {
  id: string;
  title: string;
  version: number;
  action: 'start' | 'resume';
};
export type FormWorkPage = { items: FormWorkItem[]; nextCursor: string | null };

// Shared by the responder and the Portal projection. All inputs are fixed SQL references.
export function activeFormAudience(
  tenant: string,
  form: string,
  account: string,
  unitMatch: string,
) {
  return `EXISTS (SELECT 1 FROM form_audiences a WHERE a.tenant_id=${tenant} AND a.form_id=${form}
    AND a.active AND a.opens_at<=clock_timestamp() AND (a.closes_at IS NULL OR a.closes_at>clock_timestamp())
    AND ((a.kind='account' AND a.target_id=${account}) OR (a.kind='unit' AND ${unitMatch}) OR
      (a.kind='group' AND EXISTS (SELECT 1 FROM form_groups g JOIN form_group_members m
        ON (m.tenant_id,m.group_id)=(g.tenant_id,g.id) WHERE (g.tenant_id,g.id)=(a.tenant_id,a.target_id)
        AND g.active AND m.active AND m.account_id=${account}))))`;
}

export async function actionableForms(
  pool: Pool,
  actor: FormsActor,
  tenant: string,
  after: string | undefined,
  search: string,
): Promise<FormWorkPage> {
  const units = actor.units
    .filter(
      ({ tenantId, orgUnitId }) =>
        tenantId === tenant && hasFormsPermission(actor, tenant, 'forms:respond', orgUnitId),
    )
    .map(({ orgUnitId }) => orgUnitId);
  const audience = activeFormAudience('f.tenant_id', 'f.id', '$2', 'a.target_id=u.id');
  const { rows } = await pool.query<FormWorkItem>(
    `WITH eligible AS (
    SELECT f.id,f.created_at,v.schema->>'title' AS title,v.version,
      CASE WHEN draft.id IS NULL THEN 'start' ELSE 'resume' END AS action
    FROM forms f
    LEFT JOIN submissions draft ON (draft.tenant_id,draft.form_id,draft.account_id)=(f.tenant_id,f.id,$2) AND draft.status='draft'
    JOIN form_versions v ON (v.tenant_id,v.form_id)=(f.tenant_id,f.id) AND
      ((draft.id IS NULL AND v.version=f.latest_version) OR (draft.id IS NOT NULL AND v.id=draft.version_id))
    WHERE f.tenant_id=$1 AND f.status='open' AND (draft.id IS NULL OR draft.person_id=$3)
      AND NOT EXISTS (SELECT 1 FROM version_availability a WHERE (a.tenant_id,a.form_id,a.version_id)=(v.tenant_id,v.form_id,v.id))
      AND EXISTS (SELECT 1 FROM unnest($4::uuid[]) AS u(id) WHERE
        (f.org_unit_id IS NULL OR f.org_unit_id=u.id) AND (draft.id IS NULL OR draft.org_unit_id=u.id) AND ${audience})
      AND (SELECT count(*) FROM submissions s WHERE (s.tenant_id,s.form_id,s.account_id)=(f.tenant_id,f.id,$2)
        AND s.status='submitted') < f.max_submissions
      AND ($6::text='' OR strpos(lower(v.schema->>'title'),lower($6))>0)
  ) SELECT id,title,version,action FROM eligible WHERE ($5::uuid IS NULL OR
    (created_at,id)<(SELECT created_at,id FROM eligible WHERE id=$5)) ORDER BY created_at DESC,id DESC LIMIT 26`,
    [tenant, actor.accountId, actor.personId, units, after ?? null, search],
  );
  const items = rows.slice(0, 25);
  return { items, nextCursor: rows.length > 25 ? items.at(-1)!.id : null };
}
