import type { ClientConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import type { MutationContext } from '../src/management/mutations.js';
import { auditMutation, mutate } from '../src/management/mutations.js';
import { GovernanceService } from '../src/management/governance.js';
import { HttpError } from '../src/security.js';
import { ids } from '../src/fixtures.js';

// Convert only the untouched local Forms placeholder; ordinary APIs cannot claim protected apps.
export async function claimLocalFormsReservation(
  store: Store,
  context: MutationContext,
  client: Pick<ClientConfig, 'code' | 'baseUrl' | 'name'>,
) {
  if (
    client.code !== 'aio-forms' ||
    client.baseUrl !== 'http://127.0.0.1:4103' ||
    client.name !== 'AIO Forms'
  )
    throw new HttpError(400, 'RESERVATION_CONTRACT_MISMATCH');
  return mutate(
    store,
    context,
    'applications:create',
    'application.claim_forms_reservation',
    client,
    async (db, actor) => {
      if (actor.accountId !== ids.admin || context.tenantId !== ids.tenantA)
        throw new HttpError(403, 'RESERVATION_OPERATOR_REQUIRED');
      const before = (
        await db.query('SELECT * FROM applications WHERE code=$1 FOR UPDATE', [client.code])
      ).rows[0];
      if (
        !before ||
        before.name !== 'AIO Forms' ||
        before.owner_tenant_id !== ids.tenantA ||
        !before.protected ||
        before.status !== 'planned' ||
        before.launch_url !== null ||
        before.provisioned_at !== null ||
        before.oidc_client_id !== null ||
        before.oidc_audience !== null
      )
        throw new HttpError(409, 'RESERVATION_ALREADY_USED');
      for (const table of [
        'application_grants',
        'app_roles',
        'permission_catalog',
        'application_delegations',
      ]) {
        if (
          (await db.query('SELECT 1 FROM ' + table + ' WHERE app_code=$1 LIMIT 1', [client.code]))
            .rowCount
        )
          throw new HttpError(409, 'RESERVATION_ALREADY_USED');
      }
      const after = (
        await db.query(
          'UPDATE applications SET protected=false,launch_url=$2,revision=revision+1 WHERE code=$1 RETURNING *',
          [client.code, client.baseUrl],
        )
      ).rows[0];
      await db.query(
        'INSERT INTO application_delegations(account_id,tenant_id,app_code,created_by) VALUES ($1,$2,$3,$1)',
        [actor.accountId, context.tenantId, client.code],
      );
      await auditMutation(
        db,
        context,
        actor,
        'application.reservation.claimed',
        'application',
        client.code,
        before,
        after,
      );
      return after;
    },
  );
}

// Operator-only attestation after verifying the live IdP. Not exposed by an HTTP route.
export async function recordClientProvisioning(
  store: Store,
  context: MutationContext,
  client: ClientConfig,
) {
  const governance = new GovernanceService(store);
  const contract = {
    code: client.code,
    baseUrl: client.baseUrl,
    clientId: client.clientId,
    audience: client.audience,
  };
  return mutate(
    store,
    context,
    'applications:manage',
    'application.provision',
    contract,
    async (db, actor) => {
      const before = (
        await db.query(
          'SELECT * FROM applications WHERE code=$1 AND owner_tenant_id=$2 FOR UPDATE',
          [client.code, context.tenantId],
        )
      ).rows[0];
      if (!before || before.launch_url !== client.baseUrl)
        throw new HttpError(409, 'PROVISIONING_REGISTRY_MISMATCH');
      if (
        before.provisioned_at &&
        before.oidc_client_id === client.clientId &&
        before.oidc_audience === client.audience
      )
        return before;
      const row = (
        await db.query(
          'UPDATE applications SET oidc_client_id=$2,oidc_audience=$3,provisioned_at=now(),revision=revision+1 WHERE code=$1 RETURNING *',
          [client.code, client.clientId, client.audience],
        )
      ).rows[0];
      await auditMutation(
        db,
        context,
        actor,
        'application.provisioned',
        'application',
        client.code,
        before,
        row,
      );
      return row;
    },
    async (db, actor) => {
      await governance.assertApp(db, actor, context.tenantId, client.code, 'applications:manage');
    },
  );
}

export async function expireClientSessions(
  store: Store,
  context: MutationContext,
  appCode: string,
) {
  const governance = new GovernanceService(store);
  return mutate(
    store,
    context,
    'applications:manage',
    'application.expire_sessions',
    { appCode },
    async (db, actor) => {
      const deleted = await db.query('DELETE FROM sessions WHERE app_code=$1', [appCode]);
      await auditMutation(
        db,
        context,
        actor,
        'application.sessions_revoked',
        'application',
        appCode,
        null,
        { sessionsRevoked: deleted.rowCount },
      );
      return { sessionsRevoked: deleted.rowCount };
    },
    async (db, actor) => {
      await governance.assertApp(db, actor, context.tenantId, appCode, 'applications:manage');
    },
  );
}
