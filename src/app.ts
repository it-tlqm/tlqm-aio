import Fastify, { LogController } from 'fastify';
import type { FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import pg from 'pg';
import { readFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import type { ClientConfig, AppRuntime } from './config.js';
import { assertLocalDatabase, applicationDatabaseUrl } from './config.js';
import { assertStagingConfig, stagingDatabaseTls } from './staging-config.js';
import { assertFoundationReady } from './database/foundation-runtime.js';
import { OidcClient } from './oidc.js';
import type { LoginTransaction } from './oidc.js';
import { Sessions } from './sessions.js';
import { Store } from './store.js';
import { registerManagementRoutes } from './management/routes.js';
import { stagingFileScanner } from './staging-file-scan.js';
import { PersonnelWorkflowIntake } from './management/personnel-workflow-intakes.js';
import { DirectoryService } from './management/directory.js';
import { GovernanceService } from './management/governance.js';
import { IdentityService } from './management/identities.js';
import { registerIdentityRoutes } from './management/identity-routes.js';
import { databaseUnavailable } from './dependencies.js';
import { FormValidationError } from './forms/contracts.js';
import { registerFormsBoundary, registerFormsWorkCenter } from './forms-boundary.js';
import { registerIntegrationAccess } from './integration-access.js';
import { registerWorkflowsBoundary } from './workflows-boundary.js';
import { registerTasksBoundary } from './tasks-boundary.js';
import { registerTasksWorkCenter } from './tasks-work-center-boundary.js';
import { registerCmsBoundary } from './cms-boundary.js';
import { registerWorkCenter } from './work-center-boundary.js';
import { registerTrainingWorkCenter } from './training-work-center-boundary.js';
import { registerPortalWorkAccess } from './portal-work-access.js';
import { ConfigurationTransferError } from './configuration-package.js';
import { WorkflowValidationError } from './workflows/contracts.js';
import { registerBffTelemetry } from './bff-telemetry.js';
import { isHttpService } from './telemetry.js';
import type { Observe } from './telemetry.js';
import {
  csrfToken,
  equalSecret,
  hashToken,
  HttpError,
  randomToken,
  seal,
  unseal,
} from './security.js';

type Options = {
  runtime: AppRuntime;
  client: ClientConfig;
  test?: boolean;
  logger?: boolean;
  observe?: Observe;
  stagingTls?: { cert: Buffer; key: Buffer };
};
const uuid = { type: 'string', format: 'uuid' } as const;
const tenantQuery = {
  type: 'object',
  properties: { tenantId: uuid },
  required: ['tenantId'],
  additionalProperties: false,
};
const grantBody = {
  type: 'object',
  required: ['accountId', 'tenantId', 'appCode', 'reason', 'expectedRevision'],
  additionalProperties: false,
  properties: {
    accountId: uuid,
    tenantId: uuid,
    appCode: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,50}$' },
    reason: { type: 'string', minLength: 5, maxLength: 200 },
    expectedRevision: { type: 'integer', minimum: 0 },
  },
};
type GrantChange = {
  accountId: string;
  tenantId: string;
  appCode: string;
  reason: string;
  expectedRevision: number;
};
export async function createApp(options: Options) {
  const { runtime, client } = options;
  if (client.kind === 'external-application')
    throw new Error('External applications must run in their own runtime.');
  const staging = runtime.mode === 'staging' ? runtime : undefined;
  if (runtime.mode === 'staging') {
    assertStagingConfig(runtime);
    if (options.test || !runtime.clients.includes(client) || !options.stagingTls)
      throw new Error('Select a registered staging client and staging database.');
  } else {
    assertLocalDatabase(runtime.databaseUrl, options.test ?? false);
  }
  const pool = new pg.Pool({
    connectionString:
      runtime.mode === 'staging'
        ? runtime.databaseUrl
        : applicationDatabaseUrl(runtime, options.test ?? false),
    ...(staging && { ssl: stagingDatabaseTls(staging.databaseCa), query_timeout: 7500 }),
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  const store = new Store(pool);
  const directory = new DirectoryService(store);
  const governance = new GovernanceService(store);
  const oidc = await OidcClient.create(runtime, client);
  const sessions = new Sessions(store, runtime, client, oidc);
  const identities = new IdentityService(store, runtime, oidc);
  const frontendIndex = resolve('frontend/dist/index.html');
  const hasFrontend = await access(frontendIndex).then(
    () => true,
    () => false,
  );
  const app = Fastify<import('node:http').Server>({
    ...(staging &&
      options.stagingTls && {
        serverFactory: (handler) =>
          createHttpsServer({ ...options.stagingTls, minVersion: 'TLSv1.2' }, handler),
      }),
    logger: options.logger === false ? false : { level: 'info' },
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 32768,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  if (options.observe && isHttpService(client.code))
    registerBffTelemetry(app, client.code, options.observe);
  pool.on('error', () =>
    app.log.warn({ code: 'DATABASE_POOL_UNAVAILABLE' }, 'Database pool connection lost'),
  );
  await app.register(cookie);
  await app.register(helmet, {
    enableCSPNonces: true,
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
    hsts: staging ? { maxAge: 31536000, includeSubDomains: true } : false,
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
  const cookiePrefix = staging ? '__Host-aio_' + staging.slot + '_' : 'aio_';
  const sessionCookie = cookiePrefix + 'session_' + client.code;
  const transactionCookie = cookiePrefix + 'transaction_' + client.code;
  const proofCookie = cookiePrefix + 'identity_proof_' + client.code;
  const authErrorCookie = cookiePrefix + 'auth_error_' + client.code;
  const authDenials = new Set([
    'ACCOUNT_UNAVAILABLE',
    'APPLICATION_ACCESS_DENIED',
    'MFA_REQUIRED',
    'REAUTHENTICATION_REQUIRED',
  ]);
  const cookieOptions = {
    httpOnly: true,
    secure: Boolean(staging),
    sameSite: 'lax' as const,
    path: '/',
  };
  app.addHook('onRequest', async (req, reply) => {
    const host = new URL(client.baseUrl).host;
    if (staging) {
      const key = req.headers['x-aio-ingress-key'];
      if (
        req.raw.socket.remoteAddress !== '127.0.0.1' ||
        req.headers['x-forwarded-proto'] !== 'https' ||
        typeof key !== 'string' ||
        !equalSecret(key, staging.ingressKey)
      )
        throw new HttpError(400, 'INVALID_INGRESS');
      delete req.headers['x-aio-ingress-key'];
    }
    const backchannel =
      !staging &&
      req.url === '/auth/backchannel-logout' &&
      req.headers.host === 'host.docker.internal:' + client.port;
    if (req.headers.host !== host && !backchannel) throw new HttpError(400, 'INVALID_HOST');
    reply
      .header('x-request-id', req.id)
      .header(
        'cache-control',
        req.url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
      )
      .header('referrer-policy', 'no-referrer');
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ConfigurationTransferError)
      return reply.code(error.status).send({ error: error.code, requestId: req.id });
    if (error instanceof FormValidationError || error instanceof WorkflowValidationError)
      return reply.code(400).send({ error: error.code, issues: error.issues, requestId: req.id });
    const known = error instanceof HttpError;
    const databaseError = databaseUnavailable(error);
    const validation = typeof error === 'object' && error !== null && 'validation' in error;
    const suppliedStatus =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const status = known
      ? error.statusCode
      : databaseError
        ? 503
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
      : databaseError
        ? 'DATABASE_UNAVAILABLE'
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
    // Browser recovery starts a new OIDC transaction on an explicit click. Never
    // exchange an orphaned code, reconstruct state, or auto-loop through the IdP.
    const acceptsHtml = (req.headers.accept ?? '').split(',').some((entry) => {
      const [mediaType, ...parameters] = entry.trim().toLowerCase().split(';');
      const quality = parameters
        .map((value) => value.trim())
        .find((value) => value.startsWith('q='));
      return mediaType === 'text/html' && (quality === undefined || Number(quality.slice(2)) > 0);
    });
    if (
      req.method === 'GET' &&
      req.routeOptions.url === '/auth/callback' &&
      known &&
      ['LOGIN_TRANSACTION_MISSING', 'LOGIN_TRANSACTION_EXPIRED'].includes(code) &&
      acceptsHtml
    )
      return reply.redirect('/#login-recovery', 303);
    reply.code(status).send({ error: code, requestId: req.id });
  });
  app.setNotFoundHandler(() => {
    throw new HttpError(404, 'NOT_FOUND');
  });
  const authenticate = async (req: FastifyRequest, delegateRead = false) => {
    let token: string;
    let sessionHash: string | undefined;
    if (req.headers.authorization !== undefined) {
      if (delegateRead) throw new HttpError(403, 'PORTAL_SESSION_REQUIRED');
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
      return { ...(await sessions.authenticate(sessionHash, req.id, delegateRead)), sessionHash };
    }
    const identity = await oidc.access(token);
    const principal = await store.principal(identity, client.code);
    return { identity, principal, sessionHash };
  };
  app.get('/health/live', async () => ({ status: 'ok', service: client.code }));
  app.get('/api/v1/runtime-info', async (req, reply) => {
    const error = req.cookies[authErrorCookie];
    if (error) reply.clearCookie(authErrorCookie, cookieOptions);
    return {
      appCode: client.code,
      name: client.name,
      environment: runtime.mode,
      loginUrl: '/auth/login',
      logoutUrl: oidc.endSession(),
      accountUrl: runtime.issuer + '/account/',
      portalUrl: runtime.clients.find(({ code }) => code === 'aio-foundation')?.baseUrl,
      ...(error && authDenials.has(error) ? { authError: error } : {}),
    };
  });
  let applicationReady: (() => Promise<void>) | undefined;
  const checkReady = async () => {
    await assertFoundationReady(pool, runtime, options.test ?? false);
    await applicationReady?.();
  };
  if (staging) app.addHook('onReady', checkReady);
  app.get('/health/ready', async () => {
    await checkReady();
    return { status: 'ready', service: client.code, mode: runtime.mode };
  });
  app.get('/', async (_req, reply) => {
    const html = await readFile(hasFrontend ? frontendIndex : 'public/index.html', 'utf8');
    return reply
      .type('text/html; charset=utf-8')
      .send(html.replace('__AIO_STYLE_NONCE__', reply.cspNonce.style));
  });
  if (hasFrontend) {
    await app.register(fastifyStatic, {
      root: resolve('frontend/dist/assets'),
      prefix: '/assets/',
      decorateReply: false,
      immutable: true,
      maxAge: '1y',
    });
    await app.register(fastifyStatic, {
      root: resolve('frontend/dist/licenses'),
      prefix: '/licenses/',
      decorateReply: false,
    });
  }
  app.get('/app.js', async (_req, reply) =>
    reply.type('application/javascript').send(await readFile('public/app.js', 'utf8')),
  );
  app.get('/styles.css', async (_req, reply) =>
    reply.type('text/css').send(await readFile('public/styles.css', 'utf8')),
  );
  app.get<{ Querystring: { reauth?: string } }>(
    '/auth/login',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        querystring: {
          type: 'object',
          properties: { reauth: { type: 'string', enum: ['1'] } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      reply.clearCookie(authErrorCookie, cookieOptions);
      const { transaction, url } = await oidc.begin(req.query.reauth === '1');
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
    if (transaction.purpose === 'identity-proof') {
      if (client.code !== 'aio-foundation') throw new HttpError(403, 'FOUNDATION_ONLY');
      const proof = await identities.createProof(tokens, req.id);
      reply.setCookie(
        proofCookie,
        seal({ code: proof.code }, runtime.encryptionKey, 'proof-cookie:' + client.code),
        { ...cookieOptions, maxAge: 300 },
      );
      return reply.redirect('/#identity-proof');
    }
    const session = randomToken();
    let lifetime;
    try {
      lifetime = await sessions.create(
        hashToken(session),
        tokens,
        req.id,
        req.cookies[sessionCookie] ? hashToken(req.cookies[sessionCookie]!) : undefined,
      );
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 403 || !authDenials.has(error.code))
        throw error;
      if (req.cookies[sessionCookie])
        await sessions.logout(hashToken(req.cookies[sessionCookie]!), req.id);
      reply.clearCookie(sessionCookie, cookieOptions);
      reply.setCookie(authErrorCookie, error.code, { ...cookieOptions, maxAge: 60 });
      return reply.redirect('/');
    }
    reply.setCookie(sessionCookie, session, {
      ...cookieOptions,
      maxAge: Math.max(1, Math.floor((lifetime.absoluteExpiresAt - Date.now()) / 1000)),
    });
    return reply.redirect('/');
  });
  if (client.code === 'aio-foundation') {
    app.get(
      '/auth/identity-proof',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (_req, reply) => {
        reply.clearCookie(authErrorCookie, cookieOptions);
        reply.clearCookie(proofCookie, cookieOptions);
        const { transaction, url } = await oidc.begin(true);
        const raw = randomToken();
        await pool.query(
          "INSERT INTO login_transactions(hash,app_code,encrypted_payload,expires_at) VALUES ($1,$2,$3,now()+interval '5 minutes')",
          [
            hashToken(raw),
            client.code,
            seal(
              { ...transaction, purpose: 'identity-proof' },
              runtime.encryptionKey,
              'login:' + client.code,
            ),
          ],
        );
        reply.setCookie(transactionCookie, raw, { ...cookieOptions, maxAge: 300 });
        return reply.redirect(url);
      },
    );
    app.get('/api/v1/identity-proof', async (req) => {
      const raw = req.cookies[proofCookie];
      if (!raw) throw new HttpError(400, 'IDENTITY_PROOF_UNAVAILABLE');
      let code: string;
      try {
        code = unseal<{ code: string }>(
          raw,
          runtime.encryptionKey,
          'proof-cookie:' + client.code,
        ).code;
      } catch {
        throw new HttpError(400, 'IDENTITY_PROOF_UNAVAILABLE');
      }
      return identities.ownProof(code);
    });
  }
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
      await sessions.logout(hashToken(raw), req.id);
      reply.clearCookie(sessionCookie, cookieOptions);
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
      memberships: await store.memberships(auth.principal.accountId, client.code),
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
      const [legalEntities, units] = await Promise.all([
        directory.list('legal-entities', principal, req.query.tenantId),
        directory.list('org-units', principal, req.query.tenantId),
      ]);
      return {
        tenantId: req.query.tenantId,
        legalEntities: legalEntities.items.filter((row) => row.active),
        units: units.items.filter((row) => row.active),
      };
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
            'SELECT id,occurred_at AS "occurredAt",actor_account_id AS "actorAccountId",subject_account_id AS "subjectAccountId",app_code AS "appCode",action,reason,target_type AS "targetType",target_id AS "targetId",details,request_id AS "requestId" FROM audit_events WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100',
            [req.query.tenantId],
          )
        ).rows,
      };
    },
  );
  for (const active of [true, false])
    app.post<{ Body: GrantChange }>(
      '/api/v1/access/grants' + (active ? '' : '/revoke'),
      {
        schema: {
          body: grantBody,
          headers: {
            type: 'object',
            required: ['idempotency-key'],
            properties: {
              'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' },
            },
          },
        },
      },
      async (req) => {
        const auth = await authenticate(req);
        const grant = await governance.saveGrant(
          {
            identity: auth.identity,
            appCode: client.code,
            tenantId: req.body.tenantId,
            requestId: req.id,
            idempotencyKey: req.headers['idempotency-key'] as string,
            reason: req.body.reason,
          },
          { accountId: req.body.accountId, appCode: req.body.appCode, active },
          req.body.expectedRevision,
        );
        return { status: active ? 'granted' : 'revoked', revision: grant.revision };
      },
    );
  const workflowSource =
    client.code === 'aio-foundation' &&
    runtime.clients.some((c) => c.code === 'aio-workflows' && c.kind === 'application')
      ? await registerWorkCenter(app, runtime, store, authenticate, options.test ?? false)
      : undefined;
  registerManagementRoutes(app, {
    store,
    appCode: client.code,
    authenticate,
    ...(client.code === 'aio-foundation' && {
      ...(runtime.mode === 'staging' &&
        runtime.moduleDatabases && {
          organizationUploadScan: stagingFileScanner(runtime.slot, runtime.scannerTls),
        }),
      personnelIntake: new PersonnelWorkflowIntake(
        store,
        workflowSource?.moduleIntakeDraft.bind(workflowSource),
      ),
    }),
    configurationTransfer: {
      key: runtime.encryptionKey,
      domain: runtime.instanceId + ':' + client.code + ':' + (options.test ? 'test' : runtime.mode),
    },
  });
  registerIdentityRoutes(app, { store, appCode: client.code, authenticate }, identities);
  const externalIntegration = runtime.clients.some((c) => c.kind === 'external-application');
  if (client.code === 'aio-foundation' && (runtime.mode === 'local' || externalIntegration)) {
    registerIntegrationAccess(app, runtime, store, workflowSource, options.test ?? false);
    registerPortalWorkAccess(app, runtime, store, options.test ?? false);
  }
  if (client.code === 'aio-foundation') {
    registerTrainingWorkCenter(app, runtime, store, authenticate, options.test ?? false);
    await registerTasksWorkCenter(app, runtime, store, authenticate, options.test ?? false);
    await registerFormsWorkCenter(app, runtime, store, authenticate, options.test ?? false);
  }
  if (client.code === 'aio-forms' && client.kind === 'application')
    applicationReady = await registerFormsBoundary(
      app,
      runtime,
      store,
      authenticate,
      options.test ?? false,
    );
  if (client.code === 'aio-workflows' && client.kind === 'application')
    applicationReady = await registerWorkflowsBoundary(
      app,
      runtime,
      store,
      authenticate,
      options.test ?? false,
    );
  if (client.code === 'aio-tasks' && client.kind === 'application')
    applicationReady = await registerTasksBoundary(
      app,
      runtime,
      store,
      authenticate,
      options.test ?? false,
    );
  if (client.code === 'aio-cms' && client.kind === 'application')
    applicationReady = await registerCmsBoundary(
      app,
      runtime,
      store,
      authenticate,
      options.test ?? false,
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
