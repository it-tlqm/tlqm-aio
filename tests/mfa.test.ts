import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { ids } from '../src/fixtures.js';
import { fixtureTotp } from '../scripts/local-totp.js';

const config = await loadLocalConfig();
const pool = new pg.Pool({ connectionString: testDatabaseUrl(config), max: 2 });
const store = new Store(pool);
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
});
after(() => pool.end());

test('privileged accounts require verified password and OTP methods, including bootstrap roles without the flag', async () => {
  for (const methods of [undefined, [], ['pwd'], ['otp'], ['mfa'], ['pwd', 'email']]) {
    await assert.rejects(
      () =>
        store.principal(
          {
            issuer: config.issuer,
            subject: ids.admin,
            authenticatedAt: Math.floor(Date.now() / 1000),
            ...(methods ? { authenticationMethods: methods } : {}),
          },
          'aio-foundation',
        ),
      { code: 'MFA_REQUIRED' },
    );
  }
  const admin = await store.principal(
    {
      issuer: config.issuer,
      subject: ids.admin,
      authenticatedAt: Math.floor(Date.now() / 1000),
      authenticationMethods: ['pwd', 'otp'],
    },
    'aio-foundation',
  );
  assert.equal(admin.accountId, ids.admin);
  await store.principal(
    { issuer: config.issuer, subject: ids.learner, authenticationMethods: ['pwd'] },
    'aio-foundation',
  );
});

test('new MFA requirement takes effect for a previously password-only identity without a new login', async () => {
  const prior = (await pool.query('SELECT mfa_required FROM accounts WHERE id=$1', [ids.learner]))
    .rows[0].mfa_required;
  try {
    await pool.query('UPDATE accounts SET mfa_required=true WHERE id=$1', [ids.learner]);
    await assert.rejects(
      () =>
        store.principal(
          { issuer: config.issuer, subject: ids.learner, authenticationMethods: ['pwd'] },
          'aio-foundation',
        ),
      { code: 'MFA_REQUIRED' },
    );
  } finally {
    await pool.query('UPDATE accounts SET mfa_required=$2 WHERE id=$1', [ids.learner, prior]);
  }
});

test('synthetic OTP generator matches published RFC 6238 SHA-1 vectors', () => {
  const secret = '12345678901234567890';
  for (const [time, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ] as const)
    assert.equal(fixtureTotp(secret, time * 1000, 8), expected);
});
