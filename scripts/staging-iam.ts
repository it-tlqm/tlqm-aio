import assert from 'node:assert/strict';
import { createPublicKey, randomUUID } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type pg from 'pg';
import { ids } from '../src/fixtures.js';
import { assertStagingConfig } from '../src/staging-config.js';
import type { StagingConfig } from '../src/staging-config.js';
import type { D1Database } from '../src/lms/types.js';
import { captureAudit } from './staging-audit.js';
import type { AuditEvidence } from './staging-audit.js';
import { reserveStagingRequests } from './e2e-request-budget.js';
import { stagingPasswordPolicy } from './staging-password-policy.js';

type Operator = { clientId: string; secret: string };
type Login = (
  base: string,
  fresh: boolean,
  page: Page,
  actor: 'primary' | 'recovery',
) => Promise<void>;
type KeyMetadata = {
  active: Record<string, string>;
  keys: { kid: string; providerPriority: number; status: string }[];
};
type IdpEvent = { type: string; userId: string; clientId: string; error?: string; time: number };
type IdpAdminEvent = {
  operationType: string;
  resourcePath: string;
  representation?: string | null;
  error?: string;
  time: number;
};

function exchange<T>(
  url: URL,
  ca: string,
  method: 'GET' | 'POST' | 'PUT',
  expected: number,
  headers: Record<string, string> = {},
  body?: string,
) {
  return new Promise<{ body: T; location: string | undefined }>((resolve, reject) => {
    const req = request(
      url,
      {
        ca,
        rejectUnauthorized: true,
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        },
        timeout: 5000,
      },
      (res) => {
        if (res.statusCode !== expected) {
          res.resume();
          reject(new Error('Staging IdP operation returned HTTP ' + res.statusCode));
          return;
        }
        let payload = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          payload += chunk;
          if (payload.length > 1_000_000) res.destroy(new Error('Staging IdP response too large.'));
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({
              body: (payload ? JSON.parse(payload) : undefined) as T,
              location: res.headers.location,
            });
          } catch {
            reject(new Error('Staging IdP response is not JSON.'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Staging IdP request timed out.')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function verifyStagingIam(
  runtime: StagingConfig,
  ca: string,
  operator: Operator,
  owner: pg.Pool,
  browser: Browser,
  primaryContext: BrowserContext,
  fixture: {
    primary: { subject: string; username: string; password: string };
    recoverySubject: string;
  },
  login: Login,
  audit: AuditEvidence[],
  lms: D1Database,
  phase: (name: string) => void,
) {
  assertStagingConfig(runtime);
  const issuer = new URL(runtime.issuer);
  const realmName = 'aio-staging-' + runtime.slot;
  assert.equal(operator.clientId, 'aio-stage-operator');
  assert.match(operator.secret, /^[0-9a-f]{64}$/);
  assert.match(fixture.primary.subject, /^[0-9a-f-]{36}$/);
  assert.notEqual(fixture.primary.subject, fixture.recoverySubject);
  assert.equal(fixture.primary.username, 'demo.admin');
  const call = async <T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    expected = 200,
    body?: unknown,
  ) => {
    const token = await exchange<{ access_token: string }>(
      new URL('/realms/master/protocol/openid-connect/token', issuer),
      ca,
      'POST',
      200,
      { 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: operator.clientId,
        client_secret: operator.secret,
      }).toString(),
    );
    assert.ok(
      typeof token.body.access_token === 'string',
      'Staging IdP operator authentication failed.',
    );
    return exchange<T>(
      new URL('/admin/realms/' + realmName + path, issuer),
      ca,
      method,
      expected,
      { 'content-type': 'application/json', authorization: 'Bearer ' + token.body.access_token },
      body === undefined ? undefined : JSON.stringify(body),
    );
  };
  const foundation = runtime.clients.find(({ code }) => code === 'aio-foundation')!;
  const probe = runtime.clients.find(({ code }) => code === 'aio-probe')!;
  const openApplications = async (context: BrowserContext, fresh: boolean) => {
    await reserveStagingRequests(foundation.baseUrl, ca, 65);
    const pages = new Map<string, Page>();
    for (const client of runtime.clients) {
      phase('IAM browser ' + (fresh ? 'after rotation' : 'before rotation') + ' at ' + client.code);
      const page = await context.newPage();
      await login(client.baseUrl, fresh && client.code === foundation.code, page, 'primary');
      pages.set(client.code, page);
    }
    return pages;
  };
  const status = (page: Page) => page.evaluate(async () => (await fetch('/api/v1/me')).status);
  const verifyCookieIsolation = async (context: BrowserContext) => {
    const hosts = runtime.clients.map(({ baseUrl }) => new URL(baseUrl).hostname);
    assert.equal(new Set(hosts).size, runtime.clients.length);
    const cookies = await context.cookies();
    for (const client of runtime.clients) {
      const host = new URL(client.baseUrl).hostname;
      const sessionName =
        client.code === 'aio-lms-sandbox'
          ? `__Host-aio_lms_${runtime.slot}_session`
          : `__Host-aio_${runtime.slot}_session_${client.code}`;
      const session = cookies.find(({ name }) => name === sessionName);
      assert.ok(session?.secure && session.httpOnly && session.path === '/');
      assert.equal(session.domain, host);
      for (const sibling of runtime.clients) {
        if (sibling === client) continue;
        const siblingCookies = await context.cookies(sibling.baseUrl);
        assert.equal(
          siblingCookies.some(({ name }) => name === sessionName),
          false,
        );
      }
    }
    return { hosts, hostOnlySessions: runtime.clients.length };
  };
  const requireAccepted = async (pages: Map<string, Page>) => {
    for (const [app, page] of pages) assert.equal(await status(page), 200, app);
  };
  const keyMetadata = async () => (await call<KeyMetadata>('/keys')).body;
  const publicKids = async () =>
    (
      await exchange<{ keys: ({ kid: string } & JsonWebKey)[] }>(
        new URL(runtime.issuer + '/protocol/openid-connect/certs'),
        ca,
        'GET',
        200,
      )
    ).body.keys.map((key) => {
      if (key.kty === 'RSA') {
        const details = createPublicKey({ key, format: 'jwk' }).asymmetricKeyDetails;
        assert.ok((details?.modulusLength ?? 0) >= 3072);
      }
      return key.kid;
    });
  const begunAt = Date.now();
  phase('IAM Keycloak realm and event policy');
  const realm = (
    await call<{
      id: string;
      realm: string;
      passwordPolicy: string;
      bruteForceProtected: boolean;
      permanentLockout: boolean;
      failureFactor: number;
      accessCodeLifespan: number;
      revokeRefreshToken: boolean;
      refreshTokenMaxReuse: number;
    }>('/')
  ).body;
  assert.equal(realm.realm, realmName);
  assert.equal(realm.passwordPolicy, stagingPasswordPolicy);
  assert.ok(realm.bruteForceProtected && !realm.permanentLockout);
  assert.equal(realm.failureFactor, 8);
  assert.equal(realm.accessCodeLifespan, 60);
  assert.ok(realm.revokeRefreshToken);
  assert.equal(realm.refreshTokenMaxReuse, 0);
  const eventPolicy = (
    await call<{
      eventsEnabled: boolean;
      adminEventsEnabled: boolean;
      adminEventsDetailsEnabled: boolean;
    }>('/events/config')
  ).body;
  assert.ok(
    eventPolicy.eventsEnabled &&
      eventPolicy.adminEventsEnabled &&
      !eventPolicy.adminEventsDetailsEnabled,
  );
  const old = await openApplications(primaryContext, false);
  const cookieIsolation = runtime.namedHosts
    ? await verifyCookieIsolation(primaryContext)
    : undefined;
  phase('IAM active signing key before rotation');
  const originalKeys = await keyMetadata();
  const originalKid = originalKeys.active.RS256;
  assert.ok(originalKid);
  const name = 'aio-stage-rs256-' + runtime.instanceId;
  const keyProvider = (active: boolean, priority: number, id?: string) => ({
    ...(id ? { id } : {}),
    name,
    parentId: realm.id,
    providerType: 'org.keycloak.keys.KeyProvider',
    providerId: 'rsa-generated',
    config: {
      priority: [String(priority)],
      enabled: ['true'],
      active: [String(active)],
      algorithm: ['RS256'],
      keySize: ['3072'],
    },
  });
  phase('IAM create passive key and switch active RS256 key');
  const created = await call<void>('/components', 'POST', 201, keyProvider(false, 0));
  const component = created.location?.split('/').at(-1);
  assert.ok(component && /^[0-9a-f-]{36}$/.test(component));
  const componentPath = '/components/' + component;
  const priority =
    Math.max(0, ...originalKeys.keys.map((key) => Number(key.providerPriority) || 0)) + 100;
  const rotatedContext = await browser.newContext();
  try {
    const rotationStarted = performance.now();
    let rotated: Map<string, Page>;
    let switchMs: number;
    let browserOverlapMs: number;
    try {
      assert.equal((await keyMetadata()).active.RS256, originalKid);
      await call<void>(componentPath, 'PUT', 204, keyProvider(true, priority, component));
      const nextKid = (await keyMetadata()).active.RS256;
      assert.ok(nextKid && nextKid !== originalKid);
      const published = await publicKids();
      assert.ok(published.includes(originalKid) && published.includes(nextKid));
      switchMs = Math.round(performance.now() - rotationStarted);
      phase('IAM old and newly signed browser sessions across all applications');
      await requireAccepted(old);
      await delay(1200);
      rotated = await openApplications(rotatedContext, true);
      await requireAccepted(rotated);
      browserOverlapMs = Math.round(performance.now() - rotationStarted);
      phase('IAM restore original active key and verify passive key overlap');
      await call<void>(componentPath, 'PUT', 204, keyProvider(false, 0, component));
      const restored = await keyMetadata();
      assert.equal(restored.active.RS256, originalKid);
      assert.equal(restored.keys.find(({ kid }) => kid === nextKid)?.status, 'PASSIVE');
      assert.ok((await publicKids()).includes(nextKid));
      await requireAccepted(old);
      await requireAccepted(rotated);
    } finally {
      if ((await keyMetadata()).active.RS256 !== originalKid)
        await call<void>(componentPath, 'PUT', 204, keyProvider(false, 0, component));
    }

    phase('IAM signed backchannel logout and active session denial');
    const primaryPath = '/users/' + fixture.primary.subject;
    const identity = async () =>
      (await call<{ id: string; username: string; enabled: boolean }>(primaryPath)).body;
    const primary = await identity();
    assert.ok(
      primary.id === fixture.primary.subject &&
        primary.username === fixture.primary.username &&
        primary.enabled,
    );
    const emergencyContext = await browser.newContext();
    try {
      const backchannelCounts = async () => {
        const { rows } = await owner.query<{ app_code: string; count: number }>(
          "SELECT app_code, count(*)::integer FROM audit_events WHERE action='auth.backchannel_logout' GROUP BY app_code",
        );
        const lmsEvents = await lms
          .prepare(
            "SELECT count(*) AS count FROM aio_audit WHERE action='session.backchannel_logout'",
          )
          .first<{ count: number }>();
        return new Map([
          ...rows.map(({ app_code, count }) => [app_code, count] as const),
          ['aio-lms-sandbox', lmsEvents?.count ?? 0] as const,
        ]);
      };
      const beforeLogout = await backchannelCounts();
      const lockdownStarted = performance.now();
      await call<void>(primaryPath + '/logout', 'POST', 204);
      const afterLogout = await backchannelCounts();
      const signedBackchannel = runtime.clients.map(({ code }) => {
        const events = (afterLogout.get(code) ?? 0) - (beforeLogout.get(code) ?? 0);
        assert.ok(events > 0, 'Missing accepted Keycloak backchannel for ' + code);
        return { app: code, events };
      });
      await call<void>(primaryPath, 'PUT', 204, { enabled: false });
      assert.equal((await identity()).enabled, false);
      assert.equal((await call<unknown[]>(primaryPath + '/sessions')).body.length, 0);
      const firstDenied = await Promise.all(
        [...rotated].map(async ([app, page]) => {
          const response = await status(page);
          assert.ok(
            response === 401 || response === 403,
            app + ' did not refuse the disabled identity',
          );
          return {
            app,
            status: response,
            afterLockdownMs: Math.round(performance.now() - lockdownStarted),
          };
        }),
      );
      const blocked = await rotatedContext.newPage();
      await blocked.goto(foundation.baseUrl + '/auth/login');
      await blocked.locator('#username').fill(fixture.primary.username);
      await blocked.locator('#password').fill(fixture.primary.password);
      await Promise.all([
        blocked.waitForURL(
          (url) =>
            url.origin === issuer.origin && url.pathname.endsWith('/login-actions/authenticate'),
        ),
        blocked.locator('#kc-login').click(),
      ]);
      await blocked.locator('#username').waitFor({ timeout: 8000 });
      assert.equal(new URL(blocked.url()).origin, issuer.origin);

      phase('IAM emergency administrator MFA and scoped grant changes');
      const recovery = await emergencyContext.newPage();
      const [callback] = await Promise.all([
        recovery.waitForResponse(
          (response) => {
            const parsed = new URL(response.url());
            return parsed.origin === foundation.baseUrl && parsed.pathname === '/auth/callback';
          },
          { timeout: 60000 },
        ),
        login(foundation.baseUrl, true, recovery, 'recovery'),
      ]);
      const loginId = callback.headers()['x-request-id'] ?? null;
      captureAudit(audit, 'foundation', 'auth.login')(loginId);
      const recoveryMs = Math.round(performance.now() - lockdownStarted);
      const grantState = async () =>
        (
          await owner.query<{ active: boolean; revision: number }>(
            'SELECT active,revision FROM application_grants WHERE tenant_id=$1 AND account_id=$2 AND app_code=$3',
            [ids.tenantA, ids.learner, probe.code],
          )
        ).rows[0]!;
      const initial = await grantState();
      assert.ok(initial.active);
      const change = async (active: boolean, expectedRevision: number) =>
        recovery.evaluate(
          async ({ active, expectedRevision, tenantId, accountId, appCode, key }) => {
            const { csrfToken } = await (await fetch('/api/v1/me')).json();
            const response = await fetch('/api/v1/access/grants' + (active ? '' : '/revoke'), {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-csrf-token': csrfToken,
                'idempotency-key': key,
              },
              body: JSON.stringify({
                tenantId,
                accountId,
                appCode,
                expectedRevision,
                reason: 'Synthetic emergency access rehearsal',
              }),
            });
            return { status: response.status, id: response.headers.get('x-request-id') };
          },
          {
            active,
            expectedRevision,
            tenantId: ids.tenantA,
            accountId: ids.learner,
            appCode: probe.code,
            key: randomUUID(),
          },
        );
      const revoked = await change(false, initial.revision);
      assert.equal(revoked.status, 200);
      captureAudit(audit, 'foundation', 'access.revoked')(revoked.id);
      assert.deepEqual(await grantState(), { active: false, revision: initial.revision + 1 });
      const granted = await change(true, initial.revision + 1);
      assert.equal(granted.status, 200);
      captureAudit(audit, 'foundation', 'access.granted')(granted.id);
      assert.deepEqual(await grantState(), { active: true, revision: initial.revision + 2 });
      assert.equal(
        (
          await owner.query(
            'SELECT 1 FROM audit_events WHERE actor_account_id=$1 AND request_id=ANY($2::text[])',
            [ids.recovery, [loginId, revoked.id, granted.id]],
          )
        ).rowCount,
        3,
      );
      await call<void>(primaryPath, 'PUT', 204, { enabled: true });
      assert.equal((await identity()).enabled, true);
      for (const [app, page] of rotated) assert.ok([401, 403].includes(await status(page)), app);
      phase('IAM primary fresh MFA after restoration');
      await primaryContext.clearCookies();
      await login(foundation.baseUrl, true, old.get(foundation.code)!, 'primary');
      await login(probe.baseUrl, false, old.get(probe.code)!, 'primary');

      phase('IAM Keycloak login and admin event evidence');
      const authEvents = (await call<IdpEvent[]>('/events?max=100')).body.filter(
        (event) => event.time >= begunAt,
      );
      assert.ok(
        authEvents.some(
          ({ type, userId, clientId }) =>
            type === 'LOGIN' && userId === fixture.recoverySubject && clientId === foundation.code,
        ),
      );
      assert.ok(
        authEvents.some(
          ({ type, userId, error }) =>
            type === 'LOGIN_ERROR' &&
            userId === fixture.primary.subject &&
            error === 'user_disabled',
        ),
      );
      const operations = (await call<IdpAdminEvent[]>('/admin-events?max=100')).body.filter(
        (event) => event.time >= begunAt && !event.error,
      );
      assert.ok(operations.every(({ representation }) => !representation));
      const count = (path: string, action: string) =>
        operations.filter(
          ({ resourcePath, operationType }) => resourcePath === path && operationType === action,
        ).length;
      assert.equal(count('components/' + component, 'CREATE'), 1);
      assert.equal(count('components/' + component, 'UPDATE'), 2);
      assert.equal(count('users/' + fixture.primary.subject, 'UPDATE'), 2);
      assert.equal(count('users/' + fixture.primary.subject + '/logout', 'ACTION'), 1);
      return {
        ...(cookieIsolation && { cookieIsolation }),
        rotation: {
          switchMs,
          browserOverlapMs,
          applications: [...old.keys()],
          activeAndPassiveKeysVerified: true,
          publishedRsaMinimumBits: 3072,
          originalActiveKeyRestored: true,
        },
        emergency: {
          recoveryMs,
          firstDenied,
          signedBackchannel,
          oldSessionsDeniedAfterRestore: true,
          restoredWithFreshMfa: true,
          grantRevokedAndRestored: true,
          foundationAuditMatches: 3,
        },
        keycloakAudit: {
          rotationOperations: 3,
          primaryOperations: 3,
          recoveryLogin: true,
          disabledLogin: true,
          adminRepresentationsExcluded: true,
        },
        realmPolicy: {
          passwordMinimum: 15,
          temporaryBruteForceProtection: true,
          accessCodeLifespanSeconds: 60,
          refreshReuse: 0,
        },
      };
    } finally {
      await emergencyContext.close();
      if (!(await identity()).enabled) await call<void>(primaryPath, 'PUT', 204, { enabled: true });
    }
  } finally {
    await rotatedContext.close();
  }
}
