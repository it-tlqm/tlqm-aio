import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrateLms } from '../src/lms/database.js';
import {
  seal,
  unseal,
  opaque,
  hash,
  csrf,
  verifyCsrf,
  cookie,
  LmsError,
  validateLmsConfig,
} from '../src/lms/security.js';
import { requirePermission, requireLink } from '../src/lms/access.js';
import type { LmsPrincipal, LmsLink } from '../src/lms/access.js';
import { LmsSessions } from '../src/lms/sessions.js';
import type { LmsOidc, LmsTokens } from '../src/lms/oidc.js';
import { controlLms } from '../src/lms/lifecycle.js';
import type { D1Database } from '../src/lms/types.js';
import { subjectProof, verifySubjectProof } from '../src/integration-proof.js';

const config = validateLmsConfig({
  mode: 'local',
  purpose: 'tlqm-aio-lms-test',
  instanceId: randomUUID(),
  issuer: 'http://127.0.0.1:8180/realms/aio-local',
  clientId: 'aio-lms-sandbox',
  clientSecret: randomBytes(32).toString('hex'),
  audience: 'aio-lms-sandbox-api',
  baseUrl: 'http://127.0.0.1:4104',
  foundationUrl: 'http://127.0.0.1:4100/api/v1/integrations/aio-lms-sandbox/authorize',
  encryptionKey: randomBytes(32).toString('hex'),
});
const mf = new Miniflare({
  modules: true,
  script: 'export default {fetch(){return new Response("test")}}',
  host: '127.0.0.1',
  port: 0,
  d1Databases: ['DB'],
  log: new Log(LogLevel.NONE),
});
let db: D1Database;
const accountId = randomUUID(),
  personId = randomUUID(),
  tenantId = randomUUID(),
  unitId = randomUUID();
const principal: LmsPrincipal = {
  version: 1,
  appCode: config.clientId,
  issuer: config.issuer,
  subject: 'synthetic-subject',
  accountId,
  personId,
  displayName: 'Synthetic',
  tenantIds: [tenantId],
  units: [{ tenantId, orgUnitId: unitId }],
  permissions: [{ tenantId, permission: 'lms:learn', orgUnitId: null }],
  authenticatedAt: Math.floor(Date.now() / 1000) + 1,
  authenticationMethods: ['pwd'],
  maxAgeSeconds: 0,
};
const link: LmsLink = {
  account_id: accountId,
  person_id: personId,
  employee_id: 'synthetic-legacy',
  tenant_id: tenantId,
  org_unit_id: unitId,
  active: 1,
  auth_not_before: 0,
  name: 'Synthetic',
  code: 'fixture',
  department: 'Unit',
  role: 'learner',
};
const tokens: LmsTokens = {
  accessToken: 'synthetic-only',
  idToken: 'synthetic-only',
  refreshToken: 'synthetic-only',
  subject: principal.subject,
  sid: 'synthetic-sid',
  authTime: principal.authenticatedAt,
  expiresAt: Date.now() + 300000,
  nonce: 'synthetic-nonce',
};
before(async () => {
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  await migrateLms(db, config);
  await db.batch([
    db
      .prepare(
        'INSERT INTO employees(id,code,name,department,role,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .bind(
        link.employee_id,
        'unit',
        'Synthetic',
        'Unit',
        'learner',
        'unusable-unit-test-fixture',
        '',
        '',
      ),
    db
      .prepare(
        'INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(accountId, personId, link.employee_id, tenantId, unitId, Date.now(), accountId),
    db
      .prepare(
        'INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES (?,?,?,?,?)',
      )
      .bind(config.issuer, principal.subject, accountId, Date.now(), accountId),
  ]);
});
after(() => mf.dispose());
test('Integration service proof binds app, caller token, IDs and freshness', async () => {
  const ids = [accountId],
    secret = 'synthetic-test-only';
  const proof = await subjectProof(secret, config.clientId, 'token', ids);
  assert.equal(await verifySubjectProof(secret, config.clientId, 'token', ids, proof), true);
  for (const [key, app, token, targets] of [
    [secret, 'other', 'token', ids],
    [secret, config.clientId, 'other', ids],
    [secret, config.clientId, 'token', [randomUUID()]],
    ['wrong', config.clientId, 'token', ids],
  ] as const)
    assert.equal(await verifySubjectProof(key, app, token, [...targets], proof), false);
  assert.equal(
    await verifySubjectProof(
      secret,
      config.clientId,
      'token',
      ids,
      await subjectProof(secret, config.clientId, 'token', ids, Math.floor(Date.now() / 1000) - 31),
    ),
    false,
  );
});
test('LMS authenticated envelopes bind payloads to environment, session and key', async () => {
  const cipher = await seal(config, { value: 'synthetic' }, 'session:a');
  assert.deepEqual(await unseal(config, cipher, 'session:a'), { value: 'synthetic' });
  for (const [other, context] of [
    [config, 'session:b'],
    [{ ...config, purpose: 'tlqm-aio-lms-local' as const }, 'session:a'],
    [{ ...config, encryptionKey: '00'.repeat(32) }, 'session:a'],
  ] as const)
    await assert.rejects(() => unseal(other, cipher, context), { code: 'LMS_SESSION_INVALID' });
  await assert.rejects(() => unseal(config, cipher.slice(0, -5) + 'AAAAA', 'session:a'), {
    code: 'LMS_SESSION_INVALID',
  });
});
test('LMS CSRF binds origin and session; duplicate session cookies are rejected', async () => {
  const raw = opaque(),
    hashed = await hash(raw),
    token = await csrf(config, hashed);
  const request = (origin: string, secret: string) =>
    new Request(config.baseUrl + '/auth/logout', {
      method: 'POST',
      headers: { origin, 'x-csrf-token': secret },
    });
  await verifyCsrf(config, request(config.baseUrl, token), hashed);
  await assert.rejects(() => verifyCsrf(config, request('http://example.test', token), hashed), {
    code: 'CSRF_REJECTED',
  });
  await assert.rejects(
    () => verifyCsrf(config, request(config.baseUrl, token), 'different-session'),
    { code: 'CSRF_REJECTED' },
  );
  assert.equal(
    cookie(new Request(config.baseUrl, { headers: { cookie: 's=' + raw + '; s=' + raw } }), 's'),
    undefined,
  );
});
test('LMS effective permission intersects tenant, unit, AIO role, legacy role and MFA', async () => {
  requirePermission(principal, link, 'lms:learn');
  assert.throws(() => requirePermission(principal, link, 'lms:admin'), {
    code: 'LMS_PERMISSION_DENIED',
  });
  const admin = {
    ...principal,
    permissions: [{ tenantId, permission: 'lms:admin', orgUnitId: null }],
  };
  assert.throws(() => requirePermission(admin, { ...link, role: 'admin' }, 'lms:admin'), {
    code: 'MFA_REQUIRED',
  });
  requirePermission(
    { ...admin, authenticationMethods: ['pwd', 'otp'] },
    { ...link, role: 'admin' },
    'lms:admin',
  );
  assert.throws(
    () =>
      requirePermission(
        {
          ...principal,
          permissions: [{ tenantId, permission: 'lms:review', orgUnitId: randomUUID() }],
        },
        { ...link, role: 'manager' },
        'lms:review',
      ),
    { code: 'LMS_PERMISSION_DENIED' },
  );
  await assert.rejects(() => requireLink(db, config, { ...principal, units: [] }), {
    code: 'LMS_UNIT_MAPPING_STALE',
  });
  await assert.rejects(() => requireLink(db, config, { ...principal, accountId: randomUUID() }), {
    code: 'LMS_IDENTITY_NOT_LINKED',
  });
});
function sessions(refresh: () => Promise<LmsTokens> = async () => tokens) {
  const service = new LmsSessions(db, config, { refresh } as unknown as LmsOidc);
  service.verify = async () => ({ principal, link });
  return service;
}
test('D1 ownership and audit are immutable; failed audit rolls back session creation', async () => {
  await assert.rejects(
    () =>
      db
        .prepare('UPDATE aio_account_links SET employee_id=? WHERE account_id=?')
        .bind('other', accountId)
        .run(),
    /LMS_IDENTITY_OWNERSHIP_IMMUTABLE/,
  );
  const service = sessions();
  const created = await service.create(tokens, 'unit-test');
  const key = await hash(created.raw);
  await assert.rejects(
    () =>
      db
        .prepare('UPDATE aio_sessions SET absolute_expires_at=absolute_expires_at+1 WHERE hash=?')
        .bind(key)
        .run(),
    /LMS_SESSION_OWNER_IMMUTABLE/,
  );
  await assert.rejects(
    () => db.prepare("UPDATE aio_audit SET reason='rewrite'").run(),
    /LMS_AUDIT_IMMUTABLE/,
  );
  const before = await db.prepare('SELECT count(*) AS n FROM aio_sessions').first<{ n: number }>();
  await db
    .prepare(
      "CREATE TRIGGER test_audit_failure BEFORE INSERT ON aio_audit BEGIN SELECT RAISE(ABORT,'synthetic audit outage'); END",
    )
    .run();
  try {
    await assert.rejects(() => service.create(tokens, 'unit-test'), /synthetic audit outage/);
  } finally {
    await db.prepare('DROP TRIGGER test_audit_failure').run();
  }
  assert.deepEqual(await db.prepare('SELECT count(*) AS n FROM aio_sessions').first(), before);
  await service.revoke(key, 'test cleanup', 'unit-test');
});
test('concurrent D1 refresh rotates once; logout during refresh cannot recreate a session', async () => {
  let count = 0;
  const service = sessions(async () => {
    count++;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ...tokens, expiresAt: Date.now() + 300000 };
  });
  const created = await service.create({ ...tokens, expiresAt: 0 }, 'unit-test');
  const key = await hash(created.raw);
  await Promise.all(Array.from({ length: 8 }, () => service.authenticate(key, 'unit-test')));
  assert.equal(count, 1);
  let release: () => void = () => {},
    started: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  const racing = sessions(async () => {
    started();
    await waiting;
    return tokens;
  });
  const second = await racing.create({ ...tokens, expiresAt: 0 }, 'unit-test');
  const secondHash = await hash(second.raw);
  const pending = racing.authenticate(secondHash, 'unit-test');
  void pending.catch(() => {});
  await entered;
  await racing.revoke(secondHash, 'logout race', 'unit-test');
  release();
  await assert.rejects(() => pending, { code: 'SESSION_REVOKED' });
  assert.equal(
    await db.prepare('SELECT 1 FROM aio_sessions WHERE hash=?').bind(secondHash).first(),
    null,
  );
  await service.revoke(key, 'test cleanup', 'unit-test');
});
test('LMS retries live authorization after rotation without reusing the consumed refresh token', async () => {
  let rotations = 0;
  const rotated = {
    ...tokens,
    refreshToken: 'new-synthetic-credential',
    expiresAt: Date.now() + 300000,
  };
  const service = sessions(async () => {
    rotations++;
    assert.equal(rotations, 1);
    return rotated;
  });
  const created = await service.create({ ...tokens, expiresAt: 0 }, 'unit-test');
  const key = await hash(created.raw);
  const lifetime = () =>
    db
      .prepare('SELECT idle_expires_at,absolute_expires_at FROM aio_sessions WHERE hash=?')
      .bind(key)
      .first();
  const before = await lifetime();
  const verify = service.verify;
  service.verify = async () => {
    throw new LmsError(503, 'FOUNDATION_UNAVAILABLE');
  };
  try {
    await assert.rejects(service.authenticate(key, 'unit-test'), {
      code: 'FOUNDATION_UNAVAILABLE',
    });
    assert.deepEqual(await lifetime(), before);
    service.verify = verify;
    const resumed = await service.authenticate(key, 'unit-test');
    assert.deepEqual(resumed.tokens, rotated);
    assert.equal(rotations, 1);
  } finally {
    await service.revoke(key, 'test cleanup', 'unit-test');
  }
});

test('D1 expiry and failed dependency never extend idle lifetime', async () => {
  const service = sessions();
  const created = await service.create(tokens, 'unit-test'),
    key = await hash(created.raw);
  await db.prepare('UPDATE aio_sessions SET idle_expires_at=0 WHERE hash=?').bind(key).run();
  await assert.rejects(() => service.authenticate(key, 'unit-test'), { code: 'SESSION_EXPIRED' });
  assert.equal(await db.prepare('SELECT 1 FROM aio_sessions WHERE hash=?').bind(key).first(), null);
  const unavailable = sessions(async () => {
    throw new LmsError(503, 'IDENTITY_UNAVAILABLE');
  });
  const second = await unavailable.create({ ...tokens, expiresAt: 0 }, 'unit-test');
  const secondHash = await hash(second.raw);
  const before = await db
    .prepare('SELECT idle_expires_at,absolute_expires_at FROM aio_sessions WHERE hash=?')
    .bind(secondHash)
    .first();
  await assert.rejects(() => unavailable.authenticate(secondHash, 'unit-test'), {
    code: 'IDENTITY_UNAVAILABLE',
  });
  assert.deepEqual(
    await db
      .prepare('SELECT idle_expires_at,absolute_expires_at FROM aio_sessions WHERE hash=?')
      .bind(secondHash)
      .first(),
    before,
  );
  await unavailable.revoke(secondHash, 'test cleanup', 'unit-test');
});
test('operator controls use revision/idempotency + atomic audit; re-enable retains tombstones', async () => {
  const service = sessions();
  const created = await service.create(tokens, 'unit-test');
  const actor = { accountId, tenantId };
  const command = {
    target: 'mapping' as const,
    accountId,
    enabled: false,
    expectedRevision: 1,
    reason: 'Synthetic rollback rehearsal',
    commandKey: randomUUID(),
  };
  const first = await controlLms(db, actor, command);
  assert.equal(first.enabled, false);
  assert.deepEqual(await controlLms(db, actor, command), first);
  assert.deepEqual(
    await controlLms(db, actor, {
      reason: command.reason,
      commandKey: command.commandKey,
      expectedRevision: command.expectedRevision,
      enabled: command.enabled,
      accountId: command.accountId,
      target: command.target,
    }),
    first,
  );
  await assert.rejects(() => controlLms(db, actor, { ...command, enabled: true }), {
    code: 'IDEMPOTENCY_KEY_REUSED',
  });
  await assert.rejects(() => controlLms(db, actor, { ...command, commandKey: randomUUID() }), {
    code: 'REVISION_CONFLICT',
  });
  assert.equal(
    await db
      .prepare('SELECT 1 FROM aio_sessions WHERE hash=?')
      .bind(await hash(created.raw))
      .first(),
    null,
  );
  const disabled = await db
    .prepare('SELECT auth_not_before FROM aio_account_links WHERE account_id=?')
    .bind(accountId)
    .first<{ auth_not_before: number }>();
  assert.ok(disabled!.auth_not_before > 0);
  await controlLms(db, actor, {
    ...command,
    commandKey: randomUUID(),
    enabled: true,
    expectedRevision: first.revision,
  });
  assert.deepEqual(
    await db
      .prepare('SELECT auth_not_before FROM aio_account_links WHERE account_id=?')
      .bind(accountId)
      .first(),
    disabled,
  );
  await assert.rejects(
    () => requireLink(db, config, { ...principal, authenticatedAt: disabled!.auth_not_before }),
    { code: 'REAUTHENTICATION_REQUIRED' },
  );
  const adapter = await controlLms(db, actor, {
    ...command,
    target: 'adapter',
    commandKey: randomUUID(),
    expectedRevision: 1,
  });
  await controlLms(db, actor, {
    ...command,
    target: 'adapter',
    commandKey: randomUUID(),
    expectedRevision: adapter.revision,
    enabled: true,
  });
});
test('explicit unit reconciliation keeps ownership and invalidates the former session', async () => {
  principal.authenticatedAt = Math.floor(Date.now() / 1000) + 1;
  const service = sessions(),
    created = await service.create(
      { ...tokens, authTime: principal.authenticatedAt },
      'unit-transfer',
    );
  const prior = await db
    .prepare('SELECT revision FROM aio_account_links WHERE account_id=?')
    .bind(accountId)
    .first<{ revision: number }>();
  const newUnit = randomUUID();
  const command = {
    target: 'mapping' as const,
    accountId,
    orgUnitId: newUnit,
    enabled: true,
    expectedRevision: prior!.revision,
    reason: 'Explicit verified synthetic unit transfer',
    commandKey: randomUUID(),
  };
  const changed = await controlLms(db, { accountId, tenantId }, command);
  assert.equal(
    await db
      .prepare('SELECT 1 FROM aio_sessions WHERE hash=?')
      .bind(await hash(created.raw))
      .first(),
    null,
  );
  assert.deepEqual(
    await db
      .prepare(
        'SELECT account_id,person_id,employee_id,tenant_id,org_unit_id FROM aio_account_links WHERE account_id=?',
      )
      .bind(accountId)
      .first(),
    {
      account_id: accountId,
      person_id: personId,
      employee_id: link.employee_id,
      tenant_id: tenantId,
      org_unit_id: newUnit,
    },
  );
  await controlLms(
    db,
    { accountId, tenantId },
    { ...command, orgUnitId: unitId, expectedRevision: changed.revision, commandKey: randomUUID() },
  );
});
