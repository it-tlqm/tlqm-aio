import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { HttpError, hashToken } from '../src/security.js';
import { Sessions, SESSION_IDLE_MS, SESSION_MAX_MS } from '../src/sessions.js';
import { Store } from '../src/store.js';
import type { LoginTokens, OidcClient } from '../src/oidc.js';

const runtime = await loadLocalConfig();
const pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 5 });
const store = new Store(pool);
const app = runtime.clients.find((value) => value.code === 'aio-foundation')!;
const hashes: string[] = [];
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
});
after(async () => {
  await pool.query('DELETE FROM sessions WHERE hash=ANY($1)', [hashes]);
  await pool.end();
});
const initial = (): LoginTokens => ({
  accessToken: 'synthetic-access',
  idToken: 'synthetic-id',
  refreshToken: 'synthetic-refresh',
  subject: ids.learner,
  sid: 'synthetic-sid',
  expiresAt: Date.now() - 1000,
});
function provider(overrides: Partial<Pick<OidcClient, 'access' | 'refresh'>> = {}) {
  let refreshes = 0;
  return {
    get refreshes() {
      return refreshes;
    },
    async access() {
      return { issuer: runtime.issuer, subject: ids.learner };
    },
    async refresh(tokens: LoginTokens) {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ...tokens,
        accessToken: 'renewed-synthetic',
        refreshToken: 'rotated-synthetic',
        expiresAt: Date.now() + 300_000,
      };
    },
    ...overrides,
  };
}
async function fixture(oidc = provider(), tokens = initial()) {
  const hash = hashToken(randomUUID());
  hashes.push(hash);
  const sessions = new Sessions(store, runtime, app, oidc);
  await sessions.create(hash, tokens, 'session-create-' + randomUUID());
  return { hash, sessions, oidc };
}
const row = async (hash: string) =>
  (await pool.query('SELECT * FROM sessions WHERE hash=$1', [hash])).rows[0];

test('concurrent requests rotate a refresh token once, audit once and preserve the absolute maximum', async () => {
  const { sessions, hash, oidc } = await fixture();
  const before = await row(hash);
  const id = 'renewal-' + randomUUID();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => sessions.authenticate(hash, id)),
  );
  assert.equal(oidc.refreshes, 1);
  assert.ok(results.every((result) => result.principal.accountId === ids.learner));
  const after = await row(hash);
  assert.equal(after.absolute_expires_at.getTime(), before.absolute_expires_at.getTime());
  assert.ok(after.expires_at.getTime() <= Date.now() + SESSION_IDLE_MS);
  assert.ok(after.absolute_expires_at.getTime() <= Date.now() + SESSION_MAX_MS);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE request_id=$1 AND action='auth.session_renewed'",
        [id],
      )
    ).rows[0].count,
    1,
  );
});

test('idle and absolute expiry end sessions before contacting the identity provider', async () => {
  for (const absolute of [false, true]) {
    const { sessions, hash, oidc } = await fixture();
    await pool.query(
      absolute
        ? "UPDATE sessions SET expires_at=now()-interval '1 second',absolute_expires_at=now()-interval '1 second' WHERE hash=$1"
        : "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE hash=$1",
      [hash],
    );
    await assert.rejects(() => sessions.authenticate(hash, 'expired'), { code: 'SESSION_EXPIRED' });
    assert.equal(oidc.refreshes, 0);
    assert.equal(await row(hash), undefined);
  }
});

test('IdP failure cannot extend the idle deadline or save an unverified payload', async () => {
  const { sessions, hash } = await fixture(
    provider({
      async refresh() {
        throw new HttpError(503, 'IDENTITY_UNAVAILABLE');
      },
    }),
  );
  const before = await row(hash);
  await assert.rejects(() => sessions.authenticate(hash, 'outage'), { statusCode: 503 });
  const after = await row(hash);
  assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
  assert.ok(after.encrypted_payload === before.encrypted_payload);
});

test('a stalled session query discards its connection without waiting for rollback', async () => {
  const { hash } = await fixture();
  const locked = await pool.connect();
  const bounded = new pg.Pool({ connectionString: testDatabaseUrl(runtime), query_timeout: 300 });
  try {
    await locked.query('BEGIN');
    await locked.query('SELECT hash FROM sessions WHERE hash=$1 FOR UPDATE', [hash]);
    const sessions = new Sessions(new Store(bounded), runtime, app, provider());
    await assert.rejects(() => sessions.authenticate(hash, 'paused-db'), {
      message: 'Query read timeout',
    });
    assert.equal(bounded.totalCount, 0);
  } finally {
    await locked.query('ROLLBACK');
    locked.release();
    await bounded.end();
  }
  assert.ok(await row(hash));
});

test('invalid refresh grant and changed subject invalidate the session without fallback', async () => {
  for (const oidc of [
    provider({
      async refresh() {
        throw new HttpError(401, 'SESSION_REVOKED');
      },
    }),
    provider({
      async access() {
        return { issuer: runtime.issuer, subject: ids.other };
      },
    }),
  ]) {
    const { sessions, hash } = await fixture(oidc);
    await assert.rejects(() => sessions.authenticate(hash, 'invalid-refresh'), { statusCode: 401 });
    assert.equal(await row(hash), undefined);
  }
});

test('revoked app access is checked before renewal and remains denied', async () => {
  const { sessions, hash, oidc } = await fixture();
  try {
    await pool.query(
      'UPDATE application_grants SET active=false WHERE account_id=$1 AND app_code=$2 AND tenant_id=$3',
      [ids.learner, app.code, ids.tenantA],
    );
    await assert.rejects(() => sessions.authenticate(hash, 'grant-revoked'), {
      code: 'APPLICATION_ACCESS_DENIED',
    });
    assert.equal(oidc.refreshes, 0);
  } finally {
    await pool.query(
      'UPDATE application_grants SET active=true WHERE account_id=$1 AND app_code=$2 AND tenant_id=$3',
      [ids.learner, app.code, ids.tenantA],
    );
  }
});

test('logout racing renewal deletes the row and no later request resurrects it', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { sessions, hash } = await fixture(
    provider({
      async refresh(tokens) {
        entered();
        await blocked;
        return { ...tokens, expiresAt: Date.now() + 300_000 };
      },
    }),
  );
  const pending = sessions.authenticate(hash, 'racing-renewal');
  await started;
  const logout = pool.query('DELETE FROM sessions WHERE hash=$1', [hash]);
  release();
  await Promise.all([pending, logout]);
  assert.equal(await row(hash), undefined);
  await assert.rejects(() => sessions.authenticate(hash, 'after-logout'), {
    code: 'SESSION_EXPIRED',
  });
});

test('session replacement and logout roll back together with their audit when auditing fails', async () => {
  const { sessions, hash } = await fixture();
  const brokenStore = new Store(pool);
  brokenStore.audit = async () => {
    throw new Error('Synthetic audit failure');
  };
  const nextHash = hashToken(randomUUID());
  hashes.push(nextHash);
  const broken = new Sessions(brokenStore, runtime, app, provider());
  await assert.rejects(() => broken.create(nextHash, initial(), 'audit-failure', hash));
  assert.ok(await row(hash));
  assert.equal(await row(nextHash), undefined);
  await assert.rejects(() => broken.logout(hash, 'logout-audit-failure'));
  assert.ok(await row(hash));
  await sessions.authenticate(hash, 'original-session-preserved');
});
