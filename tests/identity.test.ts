import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import type { Identity } from '../src/store.js';
import { ids } from '../src/fixtures.js';
import { HttpError, hashToken, seal } from '../src/security.js';
import { IdentityService } from '../src/management/identities.js';
import { DirectoryService } from '../src/management/directory.js';
import { GovernanceService } from '../src/management/governance.js';
import type { MutationContext } from '../src/management/mutations.js';

const runtime = await loadLocalConfig();
const pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 5 });
const store = new Store(pool);
const directory = new DirectoryService(store);
const governance = new GovernanceService(store);
const claims = new Map<string, Identity>();
const provider = {
  async access(token: string) {
    const value = claims.get(token);
    if (!value) throw new HttpError(401, 'INVALID_ACCESS_TOKEN');
    return value;
  },
};
const service = new IdentityService(store, runtime, provider);
const accountIds: string[] = [];
const context = (subject: string = ids.admin, tenantId: string = ids.tenantA): MutationContext => ({
  identity: {
    issuer: runtime.issuer,
    subject,
    authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ['pwd', 'otp'],
  },
  appCode: 'aio-foundation',
  tenantId,
  reason: 'Synthetic identity lifecycle test',
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
});
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
});
after(async () => {
  if (accountIds.length)
    await pool.query('UPDATE accounts SET active=false WHERE id=ANY($1)', [accountIds]);
  await pool.end();
});
async function target() {
  const person = await directory.save('people', context(), {
    displayName: 'Identity fixture ' + randomUUID().slice(0, 8),
  });
  const account = await directory.save('accounts', context(), { personId: person.id });
  accountIds.push(String(account.id));
  return { accountId: String(account.id), personId: String(person.id) };
}
async function proof(subject: string = randomUUID(), overrides: Partial<Identity> = {}) {
  const token = 'synthetic-' + randomUUID();
  claims.set(token, {
    issuer: runtime.issuer,
    subject,
    authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ['pwd'],
    ...overrides,
  });
  const value = await service.createProof(
    {
      accessToken: token,
      idToken: 'synthetic-id',
      subject,
      sid: 'synthetic',
      expiresAt: Date.now() + 300_000,
    },
    randomUUID(),
  );
  return { ...value, token };
}
async function linked() {
  const account = await target();
  const value = await proof();
  const linked = await service.link(context(), {
    accountId: account.accountId,
    proofCode: value.code,
    expectedSubject: value.subject,
    expectedAccountRevision: 1,
  });
  return { ...account, proof: value, identityId: String(linked.id) };
}

test('identity proof requires a recent password authentication and retains no plaintext token/code', async () => {
  for (const overrides of [
    { authenticatedAt: 1 },
    { authenticationMethods: [] },
    { authenticationMethods: ['otp'] },
    { authenticatedAt: Math.floor(Date.now() / 1000) + 200 },
  ])
    await assert.rejects(() => proof(randomUUID(), overrides), {
      code: 'FRESH_IDENTITY_PROOF_REQUIRED',
    });
  const value = await proof();
  const row = (
    await pool.query('SELECT code_hash,encrypted_payload FROM identity_proofs WHERE id=$1', [
      value.id,
    ])
  ).rows[0];
  assert.ok(row.code_hash === hashToken(value.code));
  assert.ok(!row.encrypted_payload.includes(value.token));
  assert.ok(!JSON.stringify(row).includes(value.code));
});
test('identity linking is verified, audited, single use and idempotent without auto-provisioning access', async () => {
  const account = await target();
  const value = await proof();
  const request = context();
  const input = {
    accountId: account.accountId,
    proofCode: value.code,
    expectedSubject: value.subject,
    expectedAccountRevision: 1,
  };
  const actor = await store.principal(request.identity, 'aio-foundation');
  const preview = await service.preview(actor, ids.tenantA, account.accountId, value.code);
  assert.equal(preview.subject, value.subject);
  const linked = await service.link(request, input);
  assert.deepEqual(await service.link(request, input), linked);
  assert.equal(linked.verificationMethod, 'oidc-reverification');
  const stored = (
    await pool.query('SELECT encrypted_payload,consumed_at FROM identity_proofs WHERE id=$1', [
      value.id,
    ])
  ).rows[0];
  assert.equal(stored.encrypted_payload, null);
  assert.ok(stored.consumed_at);
  await assert.rejects(() => service.link(context(), { ...input, expectedAccountRevision: 2 }), {
    code: 'IDENTITY_PROOF_UNAVAILABLE',
  });
  await assert.rejects(() => store.principal(claims.get(value.token)!, 'aio-foundation'), {
    code: 'APPLICATION_ACCESS_DENIED',
  });
  const audit = (
    await pool.query('SELECT details FROM audit_events WHERE request_id=$1', [request.requestId])
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.after.account_id, account.accountId);
  assert.ok(!JSON.stringify(audit).includes(value.code));
  assert.ok(!JSON.stringify(audit).includes(value.token));
});
test('linking rejects tenant escapes, readers, protected/self targets and mismatched subject/revision', async () => {
  const account = await target();
  const value = await proof();
  const input = {
    accountId: account.accountId,
    proofCode: value.code,
    expectedSubject: value.subject,
    expectedAccountRevision: 1,
  };
  await assert.rejects(() => service.link(context(ids.learner), input), {
    code: 'PERMISSION_DENIED',
  });
  await assert.rejects(() => service.link(context(ids.admin, ids.tenantB), input), {
    code: 'PERMISSION_DENIED',
  });
  await assert.rejects(() => service.link(context(), { ...input, accountId: ids.other }), {
    code: 'TARGET_NOT_FOUND',
  });
  await assert.rejects(() => service.link(context(), { ...input, accountId: ids.recovery }), {
    code: 'PROTECTED_ACCOUNT',
  });
  await assert.rejects(() => service.link(context(), { ...input, accountId: ids.admin }), {
    code: 'SELF_MANAGEMENT_FORBIDDEN',
  });
  await assert.rejects(() => service.link(context(), { ...input, expectedSubject: 'wrong' }), {
    code: 'IDENTITY_SUBJECT_MISMATCH',
  });
  await assert.rejects(() => service.link(context(), { ...input, expectedAccountRevision: 99 }), {
    code: 'REVISION_CONFLICT',
  });
});
test('proof expiry, IdP invalidation and concurrent attempts cannot bind one identity twice', async () => {
  const account = await target();
  const other = await target();
  const value = await proof();
  claims.delete(value.token);
  const input = {
    accountId: account.accountId,
    proofCode: value.code,
    expectedSubject: value.subject,
    expectedAccountRevision: 1,
  };
  await assert.rejects(() => service.link(context(), input), {
    code: 'IDENTITY_PROOF_UNAVAILABLE',
  });
  const expired = await proof();
  await pool.query(
    "UPDATE identity_proofs SET verified_at=now()-interval '10 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",
    [expired.id],
  );
  await assert.rejects(
    () =>
      service.link(context(), {
        ...input,
        proofCode: expired.code,
        expectedSubject: expired.subject,
      }),
    { code: 'IDENTITY_PROOF_UNAVAILABLE' },
  );
  const race = await proof();
  const results = await Promise.allSettled(
    [account, other].map((target) =>
      service.link(context(), {
        accountId: target.accountId,
        proofCode: race.code,
        expectedSubject: race.subject,
        expectedAccountRevision: 1,
      }),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM external_identities WHERE issuer=$1 AND subject=$2', [
        runtime.issuer,
        race.subject,
      ])
    ).rowCount,
    1,
  );
});
test('revocation keeps immutable identity ownership and requires fresh authentication even after relink', async () => {
  const record = await linked();
  const other = await target();
  await governance.saveGrant(context(), {
    appCode: 'aio-foundation',
    accountId: record.accountId,
    active: true,
  });
  await service.revoke(context(), record.identityId, 1);
  await assert.rejects(() => store.principal(claims.get(record.proof.token)!, 'aio-foundation'), {
    code: 'ACCOUNT_UNAVAILABLE',
  });
  const next = await proof(record.proof.subject);
  await assert.rejects(
    () =>
      service.link(context(), {
        accountId: other.accountId,
        proofCode: next.code,
        expectedSubject: next.subject,
        expectedAccountRevision: 1,
      }),
    { code: 'IDENTITY_BOUND_TO_OTHER_ACCOUNT' },
  );
  await assert.rejects(
    () =>
      pool.query('UPDATE external_identities SET account_id=$1 WHERE id=$2', [
        other.accountId,
        record.identityId,
      ]),
    { constraint: 'external_identity_binding_immutable' },
  );
  await assert.rejects(
    () => pool.query('UPDATE accounts SET auth_not_before=0 WHERE id=$1', [record.accountId]),
    { constraint: 'account_auth_boundary_monotonic' },
  );
});
test('suspending a person or account revokes sessions and rejects old bearer authentication after reactivation', async () => {
  for (const resource of ['accounts', 'people']) {
    const record = await linked();
    await governance.saveGrant(context(), {
      appCode: 'aio-foundation',
      accountId: record.accountId,
      active: true,
    });
    const sessionHash = hashToken(randomUUID());
    await pool.query(
      "INSERT INTO sessions(hash,app_code,account_id,issuer,subject,encrypted_payload,expires_at,absolute_expires_at) VALUES ($1,'aio-foundation',$2,$3,$4,$5,now()+interval '5 minutes',now()+interval '1 hour')",
      [
        sessionHash,
        record.accountId,
        runtime.issuer,
        record.proof.subject,
        seal({ accessToken: record.proof.token }, runtime.encryptionKey, 'session:aio-foundation'),
      ],
    );
    const id = resource === 'accounts' ? record.accountId : record.personId;
    const revision = resource === 'accounts' ? 2 : 1;
    await directory.save(resource, context(), { active: false }, id, revision);
    assert.equal(
      (await pool.query('SELECT 1 FROM sessions WHERE hash=$1', [sessionHash])).rowCount,
      0,
    );
    await directory.save(resource, context(), { active: true }, id, revision + 1);
    await assert.rejects(() => store.principal(claims.get(record.proof.token)!, 'aio-foundation'), {
      code: 'REAUTHENTICATION_REQUIRED',
    });
    const boundary = Number(
      (await pool.query('SELECT auth_not_before FROM accounts WHERE id=$1', [record.accountId]))
        .rows[0].auth_not_before,
    );
    await store.principal(
      { ...claims.get(record.proof.token)!, authenticatedAt: boundary + 1 },
      'aio-foundation',
    );
  }
});
test('offboarding revokes tenant grants/bindings atomically and reactivation never recreates permissions', async () => {
  const record = await linked();
  for (const app of ['aio-foundation', 'aio-probe']) {
    await governance.saveGrant(context(), {
      appCode: app,
      accountId: record.accountId,
      active: true,
    });
    await governance.saveBinding(context(), {
      appCode: app,
      accountId: record.accountId,
      roleCode: 'reader',
    });
  }
  const request = context();
  const result = await service.offboard(request, record.accountId, 2);
  assert.equal(result.grantsRevoked, 2);
  assert.equal(result.bindingsRevoked, 2);
  assert.deepEqual(await service.offboard(request, record.accountId, 2), result);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM application_grants WHERE account_id=$1 AND active', [
        record.accountId,
      ])
    ).rowCount,
    0,
  );
  await directory.save('accounts', context(), { active: true }, record.accountId, 3);
  const boundary = Number(
    (await pool.query('SELECT auth_not_before FROM accounts WHERE id=$1', [record.accountId]))
      .rows[0].auth_not_before,
  );
  await assert.rejects(
    () =>
      store.principal(
        { ...claims.get(record.proof.token)!, authenticatedAt: boundary + 1 },
        'aio-foundation',
      ),
    { code: 'APPLICATION_ACCESS_DENIED' },
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM audit_events WHERE request_id=$1 AND action='account.offboarded'",
        [request.requestId],
      )
    ).rowCount,
    1,
  );
});
