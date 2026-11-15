/** Foundation-owned projection: callers receive an explicit responsibility, never database access. */
import type { Store } from './store.js';
import { HttpError } from './security.js';
export type OrganizationRule = 'manager' | 'unit-head';
export async function organizationResponsibility(
  store: Store,
  tenant: string,
  unit: string,
  personId: string,
  kind: OrganizationRule,
) {
  const db = await store.pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const employments = (
      await db.query(
        `SELECT DISTINCT e.id,e.legal_entity_id FROM employments e JOIN persons person ON person.id=e.person_id AND person.active JOIN assignments a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.is_primary JOIN positions p ON p.id=a.position_id AND p.active JOIN job_titles j ON j.id=p.job_title_id AND j.active JOIN org_units u ON u.id=p.org_unit_id AND u.active JOIN legal_entities l ON l.id=u.legal_entity_id AND l.active WHERE e.tenant_id=$1 AND e.person_id=$2 AND u.id=$3 AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now()) AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now())`,
        [tenant, personId, unit],
      )
    ).rows;
    if (employments.length !== 1)
      throw new HttpError(400, 'WORKFLOW_ORGANIZATION_EMPLOYMENT_AMBIGUOUS');
    const owner = employments[0];
    const rows = (
      await db.query(
        kind === 'manager'
          ? 'SELECT id,revision,manager_employment_id AS target FROM reporting_lines WHERE tenant_id=$1 AND employment_id=$2 AND active AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())'
          : 'SELECT id,revision,employment_id AS target FROM unit_leaders WHERE tenant_id=$1 AND org_unit_id=$2 AND active AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())',
        [tenant, kind === 'manager' ? owner.id : unit],
      )
    ).rows;
    if (rows.length !== 1) throw new HttpError(400, 'WORKFLOW_ORGANIZATION_RESPONSIBLE_MISSING');
    let employment = rows[0].target as string;
    const basis = [{ id: rows[0].id, revision: rows[0].revision }];
    const validEmployment = async (id: string) => {
      const row = (
        await db.query(
          'SELECT e.person_id FROM employments e JOIN persons p ON p.id=e.person_id AND p.active WHERE e.id=$1 AND e.tenant_id=$2 AND e.legal_entity_id=$3 AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now())',
          [id, tenant, owner.legal_entity_id],
        )
      ).rows[0];
      if (!row) throw new HttpError(400, 'WORKFLOW_ORGANIZATION_RESPONSIBLE_MISSING');
      return row.person_id as string;
    };
    await validEmployment(employment);
    const substitutes = (
      await db.query(
        'SELECT id,revision,substitute_employment_id FROM approval_substitutions WHERE tenant_id=$1 AND employment_id=$2 AND active AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())',
        [tenant, employment],
      )
    ).rows;
    if (substitutes.length > 1) throw new HttpError(400, 'WORKFLOW_ORGANIZATION_SUBSTITUTE_CHAIN');
    if (substitutes.length) {
      const s = substitutes[0];
      employment = s.substitute_employment_id;
      basis.push({ id: s.id, revision: s.revision });
      if (
        (
          await db.query(
            'SELECT 1 FROM approval_substitutions WHERE tenant_id=$1 AND employment_id=$2 AND active AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())',
            [tenant, employment],
          )
        ).rowCount
      )
        throw new HttpError(400, 'WORKFLOW_ORGANIZATION_SUBSTITUTE_CHAIN');
    }
    const responsiblePersonId = await validEmployment(employment);
    const accounts = (
      await db.query(
        'SELECT a.id FROM accounts a JOIN tenant_memberships m ON m.account_id=a.id AND m.tenant_id=$1 AND m.active WHERE a.person_id=$2 AND a.active AND EXISTS(SELECT 1 FROM external_identities i WHERE i.account_id=a.id AND i.active) ORDER BY a.id',
        [tenant, responsiblePersonId],
      )
    ).rows.map((r) => r.id as string);
    await db.query('COMMIT');
    return { personId: responsiblePersonId, accountIds: accounts, employmentId: employment, basis };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
