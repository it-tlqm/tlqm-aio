import type { AppRuntime } from './config.js';
import type { Store } from './store.js';
import { HttpError } from './security.js';
import { PersonnelWorkflowIntake } from './management/personnel-workflow-intakes.js';
import { signTrainingIntake } from './lms-intake-proof.js';
import type { TrainingIntakeEnvelope } from './lms-intake-proof.js';
import type { IntakeDestination, IntakeReference } from './workflows/intakes.js';

export function moduleIntakeDestination(
  runtime: AppRuntime,
  store: Store,
  test: boolean,
): IntakeDestination {
  const hr = new PersonnelWorkflowIntake(store);
  const lms = runtime.clients.find(
    (client) => client.code === 'aio-lms-sandbox' && client.kind === 'external-application',
  );
  function client() {
    if (!lms || (runtime.mode === 'local' && lms.baseUrl !== 'http://127.0.0.1:4104'))
      throw new HttpError(503, 'WORKFLOW_INTAKE_UNAVAILABLE');
    return lms;
  }
  async function permitted(tenant: string, account: string, person: string) {
    const { code } = client();
    const eligible = await store.pool.query(
      `SELECT 1 FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active
       JOIN external_identities i ON i.account_id=a.id AND i.issuer=$4 AND i.active
       JOIN applications app ON app.code=$3 AND app.status='active'
       WHERE (a.id,a.person_id)=($1,$2) AND a.active`,
      [account, person, code, runtime.issuer],
    );
    return (
      !!eligible.rowCount &&
      (await store.applicationPermissions(account, code)).some(
        (p) =>
          p.tenantId === tenant &&
          p.orgUnitId === null &&
          p.permission === 'lms:admin' &&
          (p.managedAppCode === null || p.managedAppCode === code),
      )
    );
  }
  async function send(operation: 'receive' | 'status', ref: IntakeReference) {
    const target = client();
    if (ref.kind !== 'lms-training') throw new HttpError(400, 'WORKFLOW_INTAKE_INVALID');
    const envelope: TrainingIntakeEnvelope = {
      instanceId: runtime.instanceId,
      environment: test ? 'test' : runtime.mode,
      reference: { ...ref, kind: ref.kind },
    };
    let response: Response;
    try {
      response = await fetch(
        target.baseUrl +
          '/api/integrations/workflow-intake' +
          (operation === 'status' ? '-status' : ''),
        {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(4000),
          headers: {
            'content-type': 'application/json',
            'x-aio-service-proof': await signTrainingIntake(
              target.clientSecret,
              target.clientId,
              operation,
              envelope,
            ),
          },
          body: JSON.stringify(envelope),
        },
      );
    } catch {
      throw new HttpError(503, 'WORKFLOW_INTAKE_UNAVAILABLE');
    }
    const result = (await response.json().catch(() => null)) as {
      id?: string;
      error?: string;
      state?: unknown;
    } | null;
    if (response.status === 403 && result?.error === 'LMS_TRAINING_INTAKE_RECIPIENT_DENIED')
      throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
    if (response.status === 409) throw new HttpError(409, 'WORKFLOW_INTAKE_REFERENCE_CONFLICT');
    if (!response.ok || result?.id !== ref.id)
      throw new HttpError(503, 'WORKFLOW_INTAKE_UNAVAILABLE');
    return result;
  }
  return {
    async recipients(kind, tenant, unit, search) {
      if (kind === 'hr-onboarding') return hr.recipients(kind, tenant, unit, search);
      client();
      const rows = (
        await store.pool.query<{ id: string; name: string; personId: string }>(
          `SELECT a.id,p.display_name AS name,a.person_id AS "personId"
         FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active
         WHERE a.active AND strpos(lower(p.display_name),lower($2))>0 AND EXISTS (
           SELECT 1 FROM tenant_memberships m JOIN application_grants g ON (g.tenant_id,g.account_id)=(m.tenant_id,m.account_id)
           WHERE (m.tenant_id,m.account_id)=($1,a.id) AND m.active AND g.active AND g.app_code='aio-workflows'
             AND (g.valid_until IS NULL OR g.valid_until>now())
         ) ORDER BY lower(p.display_name),a.id LIMIT 100`,
          [tenant, search],
        )
      ).rows;
      const result = [];
      for (const { id, name, personId } of rows) {
        if (await permitted(tenant, id, personId)) result.push({ id, name });
        if (result.length === 30) break;
      }
      return result;
    },
    async assertRecipient(kind, tenant, unit, account, person) {
      if (kind === 'hr-onboarding') return hr.assertRecipient(kind, tenant, unit, account, person);
      if (!(await permitted(tenant, account, person)))
        throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
    },
    async receive(ref) {
      if (ref.kind === 'hr-onboarding') return hr.receive(ref);
      await send('receive', ref);
    },
    async trainingStatus(ref) {
      const { state } = await send('status', ref);
      if (state === 'draft' || state === 'active' || state === 'cancelled') return state;
      throw new HttpError(503, 'WORKFLOW_INTAKE_UNAVAILABLE');
    },
  };
}
