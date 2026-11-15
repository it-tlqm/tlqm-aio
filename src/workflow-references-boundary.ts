/** Foundation owns this projection. Workflow domain never reads the identity database. */
import type { Store } from './store.js';
import type { WorkflowActor, WorkflowReferenceQuery } from './workflows/access.js';
import { referenceScope } from './workflows/references.js';
import type { ReferenceAnswer } from './forms/references.js';
export async function workflowReferences(
  store: Store,
  tenant: string,
  actor: WorkflowActor,
  query: WorkflowReferenceQuery,
) {
  referenceScope(actor, tenant, query.unitId);
  const parameters = [
    tenant,
    query.unitId,
    query.id ?? null,
    query.after ?? null,
    query.search ?? '',
  ];
  if (query.kind === 'person') {
    const result = await store.pool.query<ReferenceAnswer>(
      `SELECT p.id,p.display_name AS label FROM persons p JOIN tenants t ON t.id=$1 AND t.active
       WHERE p.active AND ($3::uuid IS NULL OR p.id=$3) AND ($4::uuid IS NULL OR p.id>$4)
       AND strpos(lower(p.display_name),lower($5))>0
       AND EXISTS(SELECT 1 FROM employments e JOIN assignments a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
         JOIN positions pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id AND pos.active
         JOIN org_units u ON u.id=pos.org_unit_id AND u.tenant_id=pos.tenant_id AND u.active
         JOIN legal_entities l ON l.id=u.legal_entity_id AND l.tenant_id=u.tenant_id AND l.active
         WHERE e.person_id=p.id AND e.tenant_id=$1 AND u.id=$2
         AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now())
         AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now()))
       ORDER BY p.id LIMIT 51`,
      parameters,
    );
    return {
      items: result.rows.slice(0, 50),
      nextCursor: result.rows.length > 50 ? result.rows[49]!.id : null,
    };
  }
  // A unit reference is limited to the caller's current start/act scope, never all tenant units by default.
  const unrestricted = actor.permissions.some(
    (p) => p.tenantId === tenant && p.permission === 'workflows:act' && p.orgUnitId === null,
  );
  const units = [
    ...new Set([
      ...actor.permissions
        .filter((p) => p.tenantId === tenant && p.permission === 'workflows:act' && p.orgUnitId)
        .map((p) => p.orgUnitId!),
      ...actor.units
        .filter(
          (u) =>
            u.tenantId === tenant &&
            actor.permissions.some(
              (p) =>
                p.tenantId === tenant &&
                p.permission === 'workflows:start' &&
                (p.orgUnitId === null || p.orgUnitId === u.orgUnitId),
            ),
        )
        .map((u) => u.orgUnitId),
    ]),
  ];
  const result = await store.pool.query<ReferenceAnswer>(
    `SELECT u.id,u.name AS label FROM org_units u JOIN legal_entities l ON l.id=u.legal_entity_id AND l.tenant_id=u.tenant_id AND l.active
     JOIN tenants t ON t.id=u.tenant_id AND t.active WHERE u.tenant_id=$1 AND u.active
     AND ($2::uuid[] IS NULL OR u.id=ANY($2)) AND ($3::uuid IS NULL OR u.id=$3)
     AND ($4::uuid IS NULL OR u.id>$4) AND strpos(lower(u.name),lower($5))>0 ORDER BY u.id LIMIT 51`,
    [
      tenant,
      unrestricted ? null : units,
      query.id ?? null,
      query.after ?? null,
      query.search ?? '',
    ],
  );
  return {
    items: result.rows.slice(0, 50),
    nextCursor: result.rows.length > 50 ? result.rows[49]!.id : null,
  };
}
