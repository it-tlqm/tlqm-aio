import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Browser } from '@playwright/test';
import { applicationDatabaseUrl } from '../src/config.js';
import type { LocalConfig } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { Store } from '../src/store.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { auditMutation } from '../src/management/mutations.js';

// Operator-only synthetic recovery rehearsal. Never imported into the HTTP application.
// The target and recovery actor are fixed: this is not an arbitrary user reset endpoint.
export async function recoverLocalAdministrator(runtime: LocalConfig, browser: Browser) {
  const proof = await authenticateMfaFixture(browser, runtime, ids.recovery);
  const identity = {
    issuer: runtime.issuer,
    subject: proof.subject,
    authenticatedAt: proof.authTime,
    authenticationMethods: proof.authenticationMethods ?? [],
  };
  const recovery = runtime.users.find((user) => user.id === ids.recovery)!;
  const target = runtime.users.find((user) => user.id === ids.admin)!;
  if (
    proof.subject !== (recovery.subject ?? recovery.id) ||
    proof.subject === (target.subject ?? target.id)
  )
    throw new Error('Recovery actor and target must be separate verified synthetic identities.');
  const request = await localKeycloakAdmin(runtime);
  const targetPath = '/users/' + (target.subject ?? target.id);
  const record = (await (await request(targetPath)).json()) as {
    id: string;
    username: string;
    requiredActions?: string[];
  };
  if (record.id !== (target.subject ?? target.id) || record.username !== 'demo.admin')
    throw new Error('Recovery target does not match the local fixture.');
  const credentials = (await (await request(targetPath + '/credentials')).json()) as {
    id: string;
    type: string;
    userLabel: string;
  }[];
  const otp = credentials.filter((value) => value.type === 'otp');
  if (otp.some((value) => value.userLabel !== 'AIO local synthetic fixture'))
    throw new Error('Recovery refuses an OTP credential not managed by the synthetic fixture.');
  const pools = [false, true].map(
    (test) => new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, test), max: 1 }),
  );
  const recoveryId = 'local-recovery-' + randomUUID();
  let authBoundary = 0;
  try {
    // Verify both targets and actor authority before the first mutation.
    for (const [index, pool] of pools.entries()) {
      const marker = (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose;
      if (marker !== (index === 0 ? 'tlqm-aio-local' : 'tlqm-aio-test'))
        throw new Error('Recovery requires verified isolated database markers.');
      const store = new Store(pool);
      const actor = await store.principal(identity, 'aio-foundation');
      if (actor.accountId !== ids.recovery) throw new Error('Invalid recovery account mapping.');
      store.require(actor, 'accounts:manage', ids.tenantA);
    }
    for (const pool of pools) {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock(71092027)');
        const store = new Store(pool);
        const actor = await store.principal(identity, 'aio-foundation', db);
        store.require(actor, 'accounts:manage', ids.tenantA);
        const before = (
          await db.query(
            'SELECT id,mfa_required,auth_not_before,revision FROM accounts WHERE id=$1 FOR UPDATE',
            [ids.admin],
          )
        ).rows[0];
        const changed = (
          await db.query(
            'UPDATE accounts SET mfa_required=true,auth_not_before=GREATEST(auth_not_before,floor(extract(epoch FROM clock_timestamp()))::bigint),revision=revision+1 WHERE id=$1 RETURNING id,mfa_required,auth_not_before,revision',
            [ids.admin],
          )
        ).rows[0];
        authBoundary = Math.max(authBoundary, Number(changed.auth_not_before));
        await db.query('DELETE FROM sessions WHERE account_id=$1', [ids.admin]);
        await auditMutation(
          db,
          {
            identity,
            appCode: 'aio-foundation',
            tenantId: ids.tenantA,
            reason:
              'Synthetic lost-OTP rehearsal; authentication boundary advanced before IdP reset',
            requestId: recoveryId,
            idempotencyKey: randomUUID(),
          },
          actor,
          'account.mfa_recovery_requested',
          'account',
          ids.admin,
          before,
          changed,
          ids.admin,
        );
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
    }
    await request(targetPath + '/logout', 'POST');
    await request(targetPath, 'PUT', {
      requiredActions: [...new Set([...(record.requiredActions ?? []), 'CONFIGURE_TOTP'])],
    });
    for (const credential of otp)
      await request(targetPath + '/credentials/' + credential.id, 'DELETE');
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, (authBoundary + 1) * 1000 - Date.now() + 100)),
    );
    // Keep password and recovery administrator untouched; reenrollment is verified with a fresh OTP login.
    const restored = await authenticateMfaFixture(browser, runtime, ids.admin, true);
    for (const pool of pools) {
      const store = new Store(pool);
      const actor = await store.principal(identity, 'aio-foundation');
      store.require(actor, 'accounts:manage', ids.tenantA);
      await store.principal(
        {
          issuer: runtime.issuer,
          subject: restored.subject,
          authenticatedAt: restored.authTime,
          authenticationMethods: restored.authenticationMethods ?? [],
        },
        'aio-foundation',
      );
      await store.audit(
        ids.recovery,
        ids.admin,
        ids.tenantA,
        'aio-foundation',
        'account.mfa_recovery_completed',
        'Synthetic primary administrator reenrolled and authenticated with password plus OTP',
        recoveryId,
      );
    }
    return { recovery: proof, restored, recoveryId };
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
  }
}
