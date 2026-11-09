import Fastify, { LogController } from 'fastify';
import type { FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import type { ClientConfig, LocalConfig } from './config.js';
import { assertLocalDatabase } from './config.js';
import { OidcClient } from './oidc.js';
import type { LoginTokens, LoginTransaction } from './oidc.js';
import { Store } from './store.js';
import {
  csrfToken,
  equalSecret,
  hashToken,
  HttpError,
  randomToken,
  seal,
  unseal,
} from './security.js';

type Options = { runtime: LocalConfig; client: ClientConfig; test?: boolean; logger?: boolean };
const uuid = { type: 'string', format: 'uuid' } as const;
const tenantQuery = {
  type: 'object',
  properties: { tenantId: uuid },
  required: ['tenantId'],
  additionalProperties: false,
};
const grantBody = {
  type: 'object',
  required: ['accountId', 'tenantId', 'appCode', 'reason'],
  additionalProperties: false,
  properties: {
    accountId: uuid,
    tenantId: uuid,
    appCode: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,50}$' },
    reason: { type: 'string', minLength: 5, maxLength: 200 },
  },
};
type GrantChange = { accountId: string; tenantId: string; appCode: string; reason: string };
export async function createApp(options: Options) {
  const { runtime, client } = options;
  assertLocalDatabase(runtime.databaseUrl, options.test ?? false);
  const pool = new pg.Pool({
    connectionString: runtime.databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  const store = new Store(pool);
  const oidc = await OidcClient.create(runtime, client);
  const app = Fastify({
    logger: options.logger === false ? false : { level: 'info' },
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    bodyLimit: 32768,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: false,
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      const entries = new URLSearchParams(body as string);
      if (entries.getAll('logout_token').length !== 1)
        return done(new HttpError(400, 'INVALID_LOGOUT_REQUEST'));
      done(null, { logout_token: entries.get('logout_token') });
    },
  );
  const sessionCookie = 'aio_session_' + client.code;
  const transactionCookie = 'aio_transaction_' + client.code;
  const cookieOptions = { httpOnly: true, secure: false, sameSite: 'lax' as const, path: '/' };
  app.addHook('onRequest', async (req, reply) => {
    const host = new URL(client.baseUrl).host;
    const backchannel =
      req.url === '/auth/backchannel-logout' &&
      req.headers.host === 'host.docker.internal:' + client.port;
    if (req.headers.host !== host && !backchannel) throw new HttpError(400, 'INVALID_HOST');
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
  });
  app.setErrorHandler((error, req, reply) => {
    const known = error instanceof HttpError;
    const validation = typeof error === 'object' && error !== null && 'validation' in error;
    const suppliedStatus =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const status = known
      ? error.statusCode
      : validation
        ? 400
        : suppliedStatus === 429
          ? 429
          : suppliedStatus === 413
            ? 413
            : suppliedStatus === 415
              ? 415
              : 500;
    const code = known
      ? error.code
      : validation
        ? 'INVALID_REQUEST'
        : status === 429
          ? 'RATE_LIMITED'
          : status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : status === 415
              ? 'UNSUPPORTED_MEDIA_TYPE'
              : 'INTERNAL_ERROR';
    // No exception text, headers, callback query, credentials or tokens enter logs.
    app.log.warn({ code, requestId: req.id }, 'Request rejected');
    reply.code(status).send({ error: code, requestId: req.id });
  });
  app.setNotFoundHandler(() => {
    throw new HttpError(404, 'NOT_FOUND');
  });
  const authenticate = async (req: FastifyRequest) => {
    let token: string;
    let sessionHash: string | undefined;
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization);
      if (!match?.[1]) throw new HttpError(401, 'AUTHENTICATION_REQUIRED');
      token = match[1];
    } else {
      const raw = req.cookies[sessionCookie];
      if (!raw) throw new HttpError(401, 'AUTHENTICATION_REQUIRED');
      sessionHash = hashToken(raw);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const supplied = req.headers['x-csrf-token'];
        if (
          req.headers.origin !== client.baseUrl ||
          typeof supplied !== 'string' ||
          !equalSecret(supplied, csrfToken(sessionHash, runtime.encryptionKey, client.code))
        )
          throw new HttpError(403, 'CSRF_REJECTED');
      }
      const row = (
        await pool.query(
          'SELECT encrypted_payload FROM sessions WHERE hash=$1 AND app_code=$2 AND expires_at>now()',
          [sessionHash, client.code],
        )
      ).rows[0];
      if (!row) throw new HttpError(401, 'SESSION_EXPIRED');
      const payload = unseal<LoginTokens>(
        row.encrypted_payload,
        runtime.encryptionKey,
        'session:' + client.code,
      );
      token = payload.accessToken;
    }
    const identity = await oidc.access(token);
    const principal = await store.principal(identity, client.code);
    return { identity, principal, sessionHash };
  };
  app.get('/health/live', async () => ({ status: 'ok', service: client.code }));
  app.get('/health/ready', async () => {
    const marker = (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose;
    if (marker !== (options.test ? 'tlqm-aio-test' : 'tlqm-aio-local'))
      throw new HttpError(503, 'DATABASE_NOT_READY');
    return { status: 'ready', service: client.code, mode: 'local' };
  });
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(await readFile('public/index.html', 'utf8')),
  );
  app.get('/app.js', async (_req, reply) =>
    reply.type('application/javascript').send(await readFile('public/app.js', 'utf8')),
  );
  app.get('/styles.css', async (_req, reply) =>
    reply.type('text/css').send(await readFile('public/styles.css', 'utf8')),
  );
  app.get(
    '/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      const { transaction, url } = await oidc.begin();
      const raw = randomToken();
      await pool.query(
        "INSERT INTO login_transactions(hash,app_code,encrypted_payload,expires_at) VALUES ($1,$2,$3,now()+interval '5 minutes')",
        [
          hashToken(raw),
          client.code,
          seal(transaction, runtime.encryptionKey, 'login:' + client.code),
        ],
      );
      reply.setCookie(transactionCookie, raw, { ...cookieOptions, maxAge: 300 });
      return reply.redirect(url);
    },
  );
  app.get('/auth/callback', async (req, reply) => {
    const raw = req.cookies[transactionCookie];
    reply.clearCookie(transactionCookie, cookieOptions);
    if (!raw) throw new HttpError(401, 'LOGIN_TRANSACTION_MISSING');
    // DELETE ... RETURNING makes the transaction single-use even under concurrent replay.
    const row = (
      await pool.query(
        'DELETE FROM login_transactions WHERE hash=$1 AND app_code=$2 AND expires_at>now() RETURNING encrypted_payload',
        [hashToken(raw), client.code],
      )
    ).rows[0];
    if (!row) throw new HttpError(401, 'LOGIN_TRANSACTION_EXPIRED');
    const transaction = unseal<LoginTransaction>(
      row.encrypted_payload,
      runtime.encryptionKey,
      'login:' + client.code,
    );
    const tokens = await oidc.complete(new URL(req.url, client.baseUrl), transaction);
    const principal = await store.principal(
      { issuer: runtime.issuer, subject: tokens.subject },
      client.code,
    );
    const session = randomToken();
    // Remove the previous local session when replacing it.
    if (req.cookies[sessionCookie])
      await pool.query('DELETE FROM sessions WHERE hash=$1 AND app_code=$2', [
        hashToken(req.cookies[sessionCookie]!),
        client.code,
      ]);
    await pool.query(
      'INSERT INTO sessions(hash,app_code,account_id,issuer,subject,sid,encrypted_payload,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        hashToken(session),
        client.code,
        principal.accountId,
        runtime.issuer,
        tokens.subject,
        tokens.sid,
        seal(tokens, runtime.encryptionKey, 'session:' + client.code),
        new Date(tokens.expiresAt),
      ],
    );
    await store.audit(
      principal.accountId,
      principal.accountId,
      null,
      client.code,
      'auth.login',
      null,
      req.id,
    );
    reply.setCookie(sessionCookie, session, {
      ...cookieOptions,
      maxAge: Math.max(1, Math.floor((tokens.expiresAt - Date.now()) / 1000)),
    });
    return reply.redirect('/');
  });
  app.post<{ Body: { global?: boolean } }>(
    '/auth/logout',
    {
      schema: {
        body: {
          type: 'object',
          properties: { global: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      // Logout is allowed after access has been revoked; authenticate only the local session + CSRF.
      const raw = req.cookies[sessionCookie];
      const supplied = req.headers['x-csrf-token'];
      if (
        !raw ||
        req.headers.origin !== client.baseUrl ||
        typeof supplied !== 'string' ||
        !equalSecret(supplied, csrfToken(hashToken(raw), runtime.encryptionKey, client.code))
      )
        throw new HttpError(403, 'CSRF_REJECTED');
      const row = (
        await pool.query(
          'DELETE FROM sessions WHERE hash=$1 AND app_code=$2 RETURNING account_id',
          [hashToken(raw), client.code],
        )
      ).rows[0];
      reply.clearCookie(sessionCookie, cookieOptions);
      if (row)
        await store.audit(
          row.account_id,
          row.account_id,
          null,
          client.code,
          'auth.logout',
          null,
          req.id,
        );
      // No tokens in URLs. Global logout uses the IdP's explicit confirmation screen.
      return { redirectTo: req.body.global ? oidc.endSession() : '/' };
    },
  );
  app.post<{ Body: { logout_token: string } }>(
    '/auth/backchannel-logout',
    {
      schema: {
        body: {
          type: 'object',
          required: ['logout_token'],
          additionalProperties: false,
          properties: { logout_token: { type: 'string', maxLength: 16000 } },
        },
      },
    },
    async (req, reply) => {
      const event = await oidc.logoutToken(req.body.logout_token);
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const receipt = await db.query(
          "INSERT INTO logout_receipts(app_code,jti,expires_at) VALUES ($1,$2,now()+interval '5 minutes') ON CONFLICT DO NOTHING RETURNING jti",
          [client.code, event.jti],
        );
        if (receipt.rowCount) {
          if (event.sid)
            await db.query('DELETE FROM sessions WHERE app_code=$1 AND issuer=$2 AND sid=$3', [
              client.code,
              runtime.issuer,
              event.sid,
            ]);
          else
            await db.query('DELETE FROM sessions WHERE app_code=$1 AND issuer=$2 AND subject=$3', [
              client.code,
              runtime.issuer,
              event.subject,
            ]);
          await store.audit(
            null,
            null,
            null,
            client.code,
            'auth.backchannel_logout',
            null,
            req.id,
            db,
          );
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
      return reply.code(204).send();
    },
  );
  app.get('/api/v1/me', async (req) => {
    const auth = await authenticate(req);
    return {
      ...auth.principal,
      appCode: client.code,
      assignments: await store.assignments(auth.principal.personId),
      csrfToken: auth.sessionHash
        ? csrfToken(auth.sessionHash, runtime.encryptionKey, client.code)
        : null,
    };
  });
  app.get('/api/v1/applications', async (req) => {
    const { principal } = await authenticate(req);
    return { items: await store.applications(principal.accountId) };
  });
  app.get<{ Querystring: { tenantId: string } }>(
    '/api/v1/directory',
    { schema: { querystring: tenantQuery } },
    async (req) => {
      const { principal } = await authenticate(req);
      store.require(principal, 'directory:read', req.query.tenantId);
      const [legalEntities, units] = await Promise.all([
        pool.query('SELECT id,code,name FROM legal_entities WHERE tenant_id=$1 ORDER BY code', [
          req.query.tenantId,
        ]),
        pool.query(
          'SELECT id,code,name,legal_entity_id AS "legalEntityId",parent_id AS "parentId" FROM org_units WHERE tenant_id=$1 ORDER BY code',
          [req.query.tenantId],
        ),
      ]);
      return { tenantId: req.query.tenantId, legalEntities: legalEntities.rows, units: units.rows };
    },
  );
  app.get<{ Querystring: { tenantId: string } }>(
    '/api/v1/audit',
    { schema: { querystring: tenantQuery } },
    async (req) => {
      const { principal } = await authenticate(req);
      store.require(principal, 'audit:read', req.query.tenantId);
      return {
        items: (
          await pool.query(
            'SELECT id,occurred_at AS "occurredAt",actor_account_id AS "actorAccountId",subject_account_id AS "subjectAccountId",app_code AS "appCode",action,reason FROM audit_events WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100',
            [req.query.tenantId],
          )
        ).rows,
      };
    },
  );
  for (const active of [true, false])
    app.post<{ Body: GrantChange }>(
      '/api/v1/access/grants' + (active ? '' : '/revoke'),
      { schema: { body: grantBody } },
      async (req) => {
        const auth = await authenticate(req);
        await store.changeGrant(auth.identity, client.code, req.body, active, req.id);
        return { status: active ? 'granted' : 'revoked' };
      },
    );
  const cleanup = setInterval(() => {
    void store
      .purgeExpired()
      .catch(() => app.log.warn({ code: 'CLEANUP_FAILED' }, 'Session cleanup unavailable'));
  }, 60_000);
  cleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
    await pool.end();
  });
  return app;
}
