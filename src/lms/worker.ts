import { TrainingNotices } from './training-notices.js';
import { portalTrainingFeed } from './portal-training-feed.js';
import { LmsConfigurationTransfer } from './configuration-transfer.js';
import { lmsConfigurationRoute } from './configuration-transfer-routes.js';
import { trainingRoute } from './training-routes.js';
import {
  fetchTrainingIntakeSource,
  TrainingIntakeInbox,
  trainingIntakeBackchannel,
} from './training-intakes.js';
import type { D1Database, MediaBucket } from './types.js';
import {
  LmsError,
  validateLmsConfig,
  opaque,
  hash,
  seal,
  unseal,
  cookie,
  cookieHeader,
  csrf,
  verifyCsrf,
} from './security.js';
import type { LmsConfig } from './security.js';
import { LmsOidc } from './oidc.js';
import type { LmsTransaction } from './oidc.js';
import { LmsSessions } from './sessions.js';
import { allowed, requirePermission, subjectUnits } from './access.js';
import { Courses } from './courses.js';
import { Achievements } from './achievements.js';
import { QuestionBank } from './question-bank.js';
import { questionRoute } from './question-routes.js';
import { foundationDirectory } from './directory.js';
import { Reports } from './reports.js';
import { reportRoute } from './report-routes.js';
import { Learners } from './learners.js';
import { foundationLearners } from './learner-directory.js';
import { learnerRoute } from './learner-routes.js';
import { encodeListCursor, legacyCursor, LMS_PAGE_SIZE } from './list-cursor.js';
import { courseRoute } from './course-routes.js';
import { CourseValidationError } from './course-contracts.js';
import { lmsMediaScanCache, uploadMedia, serveMedia } from './media.js';
import { classifyHttp, HttpSpan } from '../telemetry.js';
import type { UploadScan } from '../upload-scan.js';

type Env = {
  LMS_CONFIG: string;
  LMS_DB: D1Database;
  LMS_MEDIA: MediaBucket;
  AIO_TELEMETRY?: { fetch(request: Request): Promise<Response> };
  AIO_INGRESS_AUDIT?: { fetch(request: Request): Promise<Response> };
  AIO_UPLOAD_SCAN?: { fetch(request: Request): Promise<Response> };
  ASSETS: { fetch(request: Request): Promise<Response> };
};
const clients = new Map<string, Promise<LmsOidc>>();
const authErrors = new Set([
  'LMS_IDENTITY_NOT_LINKED',
  'APPLICATION_ACCESS_DENIED',
  'ACCOUNT_UNAVAILABLE',
  'MFA_REQUIRED',
  'REAUTHENTICATION_REQUIRED',
  'LMS_UNIT_MAPPING_STALE',
]);
let bucket = { started: Date.now(), count: 0 };
async function readBody(request: Request, max = 16384) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new LmsError(413, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk.value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(output);
}
async function client(config: LmsConfig) {
  let result = clients.get(config.purpose);
  if (!result) {
    result = LmsOidc.create(config).catch((error) => {
      clients.delete(config.purpose);
      throw error;
    });
    clients.set(config.purpose, result);
  }
  return result;
}
function headers(nonce: string) {
  return new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com https://player.vimeo.com; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; media-src 'self' https:; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://drive.google.com; form-action 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`,
  });
}
async function handle(
  request: Request,
  env: Env,
  requestId: string,
  span?: HttpSpan,
): Promise<Response> {
  const nonce = opaque(),
    outputHeaders = headers(nonce);
  outputHeaders.set('x-request-id', requestId);
  const json = (body: unknown, status = 200) => {
    outputHeaders.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body), { status, headers: outputHeaders });
  };
  const redirect = (url: string) => {
    outputHeaders.set('location', url);
    return new Response(null, { status: 302, headers: outputHeaders });
  };
  try {
    let config: LmsConfig;
    try {
      config = validateLmsConfig(JSON.parse(env.LMS_CONFIG) as LmsConfig);
    } catch {
      throw new LmsError(503, 'LMS_CONFIGURATION_INVALID');
    }
    const secure = config.mode === 'staging';
    const scan: UploadScan | undefined = secure
      ? async (content) => {
          if (!env.AIO_UPLOAD_SCAN) throw new Error('Missing staging upload scanner.');
          const result = await env.AIO_UPLOAD_SCAN.fetch(
            new Request('https://scanner.invalid/upload', {
              method: 'POST',
              body: content as Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
            }),
          );
          await result.body?.cancel();
          if (result.status === 204) return 'clean';
          if (result.status === 422) return 'infected';
          throw new Error('Upload scanner unavailable.');
        }
      : undefined;
    const prefix = config.mode === 'staging' ? '__Host-aio_lms_' + config.slot + '_' : 'aio_lms_';
    const sessionName = prefix + 'session';
    const transactionName = prefix + 'transaction';
    const errorName = prefix + 'auth_error';
    const setCookie = (name: string, value: string, seconds: number) =>
      outputHeaders.append('set-cookie', cookieHeader(name, value, seconds, secure));
    const clear = (name: string) => setCookie(name, '', 0);
    if (secure)
      outputHeaders.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const url = new URL(request.url),
      path = url.pathname;
    const backchannel =
      path === '/auth/backchannel-logout' &&
      request.method === 'POST' &&
      url.origin ===
        (secure ? 'https:' : 'http:') + '//host.docker.internal:' + new URL(config.baseUrl).port;
    if (url.origin !== config.baseUrl && !backchannel) throw new LmsError(400, 'INVALID_HOST');
    // Consume bounded request bodies before an early CSRF/authorization rejection so
    // the local workerd HTTP connection can be reused without leaking unread bytes.
    const rawUpload =
      ['/api/lms/media', '/api/lms/question-imports/preview'].includes(path) &&
      request.method === 'POST';
    const requestBody =
      request.body && !rawUpload
        ? await readBody(
            request,
            path === '/api/lms/config-transfer'
              ? 524288
              : [
                    '/api/lms/commands',
                    '/api/lms/question-commands',
                    '/api/lms/training-commands',
                  ].includes(path)
                ? 262144
                : 16384,
          )
        : '';
    if (path.startsWith('/assets/') || path.startsWith('/licenses/') || path === '/') {
      const asset = await env.ASSETS.fetch(request);
      if (!asset.ok) return json({ error: 'ASSET_NOT_FOUND' }, asset.status);
      outputHeaders.set(
        'content-type',
        asset.headers.get('content-type') ?? 'application/octet-stream',
      );
      if (path !== '/') {
        outputHeaders.set('cache-control', 'public,max-age=31536000,immutable');
        return new Response(asset.body, { status: 200, headers: outputHeaders });
      }
      return new Response((await asset.text()).replace('__AIO_STYLE_NONCE__', nonce), {
        status: 200,
        headers: outputHeaders,
      });
    }
    if (Date.now() - bucket.started >= 60000) bucket = { started: Date.now(), count: 0 };
    if (++bucket.count > 300) {
      outputHeaders.set('retry-after', '60');
      throw new LmsError(429, 'RATE_LIMITED');
    }
    if (path === '/health/live')
      return json({ status: 'ok', service: config.clientId, runtime: 'workerd' });
    const marker = await env.LMS_DB.prepare(
      'SELECT instance_id,purpose FROM environment_marker WHERE id=1',
    ).first<{ instance_id: string; purpose: string }>();
    if (marker?.instance_id !== config.instanceId || marker?.purpose !== config.purpose)
      throw new LmsError(503, 'DATABASE_NOT_READY');
    if (path === '/health/ready')
      return json({
        status: 'ready',
        service: config.clientId,
        environment: config.purpose,
        instanceId: config.instanceId,
      });
    const oidc = await client(config),
      sessions = new LmsSessions(env.LMS_DB, config, oidc);
    if (path === '/api/v1/runtime-info') {
      const error = (request.headers.get('cookie') ?? '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(errorName + '='))
        ?.slice(errorName.length + 1);
      if (error) clear(errorName);
      return json({
        appCode: config.clientId,
        name: 'LMS — Sandbox SSO',
        environment: config.mode,
        loginUrl: '/auth/login',
        logoutUrl: oidc.endSession(),
        accountUrl: config.issuer + '/account/',
        portalUrl: new URL(config.foundationUrl).origin,
        ...(error && authErrors.has(error) ? { authError: error } : {}),
      });
    }
    if (path === '/auth/backchannel-logout' && request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
        throw new LmsError(415, 'UNSUPPORTED_MEDIA_TYPE');
      const data = new URLSearchParams(requestBody);
      if (data.getAll('logout_token').length !== 1)
        throw new LmsError(400, 'INVALID_LOGOUT_REQUEST');
      await sessions.backchannel(data.get('logout_token')!, requestId);
      return json({ status: 'ok' });
    }
    const enabled = await env.LMS_DB.prepare(
      'SELECT enabled FROM aio_adapter_control WHERE id=1',
    ).first<{ enabled: number }>();
    if (enabled?.enabled !== 1) throw new LmsError(503, 'LMS_ADAPTER_DISABLED');
    if (path === '/api/integrations/portal-work')
      return json(await portalTrainingFeed(env.LMS_DB, config, request, requestBody, span));
    if (
      path === '/api/integrations/workflow-intake' ||
      path === '/api/integrations/workflow-intake-status'
    )
      return json(await trainingIntakeBackchannel(env.LMS_DB, config, request, requestBody));
    if (path === '/auth/login' && request.method === 'GET') {
      const { transaction, url: destination } = await oidc.begin(
        url.searchParams.get('reauth') === '1',
      );
      const raw = opaque(),
        transactionHash = await hash(raw);
      await env.LMS_DB.prepare(
        'INSERT INTO aio_login_transactions(hash,encrypted_payload,expires_at) VALUES (?,?,?)',
      )
        .bind(
          transactionHash,
          await seal(config, transaction, 'transaction:' + transactionHash),
          Date.now() + 300000,
        )
        .run();
      await env.LMS_DB.prepare('DELETE FROM aio_login_transactions WHERE expires_at<?')
        .bind(Date.now())
        .run();
      setCookie(transactionName, raw, 300);
      return redirect(destination);
    }
    if (path === '/auth/callback' && request.method === 'GET') {
      const raw = cookie(request, transactionName);
      if (!raw) throw new LmsError(400, 'LOGIN_TRANSACTION_INVALID');
      const transactionHash = await hash(raw);
      const row = await env.LMS_DB.prepare(
        'SELECT encrypted_payload FROM aio_login_transactions WHERE hash=? AND expires_at>?',
      )
        .bind(transactionHash, Date.now())
        .first<{ encrypted_payload: string }>();
      if (!row) throw new LmsError(400, 'LOGIN_TRANSACTION_INVALID');
      const transaction = await unseal<LmsTransaction>(
        config,
        row.encrypted_payload,
        'transaction:' + transactionHash,
      );
      if (
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== transaction.state
      )
        throw new LmsError(401, 'OIDC_CALLBACK_REJECTED');
      const consumed = await env.LMS_DB.prepare(
        'DELETE FROM aio_login_transactions WHERE hash=? AND expires_at>? RETURNING hash',
      )
        .bind(transactionHash, Date.now())
        .first();
      if (!consumed) throw new LmsError(400, 'LOGIN_TRANSACTION_INVALID');
      clear(transactionName);
      const tokens = await oidc.complete(url, transaction);
      try {
        const previous = cookie(request, sessionName);
        const created = await sessions.create(
          tokens,
          requestId,
          previous ? await hash(previous) : undefined,
        );
        setCookie(sessionName, created.raw, 3600);
        clear(errorName);
        return redirect(config.baseUrl + '/');
      } catch (error) {
        if (error instanceof LmsError && authErrors.has(error.code)) {
          const previous = cookie(request, sessionName);
          if (previous)
            await sessions.revoke(await hash(previous), 'login authorization denied', requestId);
          clear(sessionName);
          setCookie(errorName, error.code, 60);
          return redirect(config.baseUrl + '/');
        }
        throw error;
      }
    }
    const raw = cookie(request, sessionName);
    if (!raw) throw new LmsError(401, 'AUTHENTICATION_REQUIRED');
    const sessionHash = await hash(raw);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      await verifyCsrf(config, request, sessionHash);
    if (path === '/auth/logout' && request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        throw new LmsError(415, 'UNSUPPORTED_MEDIA_TYPE');
      let body: { global?: unknown };
      try {
        body = JSON.parse(requestBody) as typeof body;
      } catch {
        throw new LmsError(400, 'INVALID_REQUEST');
      }
      if (typeof body.global !== 'boolean' || Object.keys(body).some((key) => key !== 'global'))
        throw new LmsError(400, 'INVALID_REQUEST');
      await sessions.revoke(sessionHash, 'user logout', requestId);
      clear(sessionName);
      return json({ redirectTo: body.global ? oidc.endSession() : config.baseUrl + '/' });
    }
    const auth = await sessions.authenticate(sessionHash, requestId),
      { principal, link } = auth;
    if (path.startsWith('/api/lms/')) {
      if (request.method === 'GET' && ['/api/lms/certificate', '/api/lms/ranking'].includes(path)) {
        const achievements = new Achievements(
          env.LMS_DB,
          async () => ({ principal, link, sessionHash }),
          (ids) => subjectUnits(config, auth.tokens.accessToken, principal.subject, ids),
        );
        return json(
          path === '/api/lms/certificate'
            ? await achievements.certificate(url.searchParams.get('code') ?? '')
            : await achievements.ranking({
                orgUnitId: url.searchParams.get('orgUnitId') ?? undefined,
                page: url.searchParams.get('page') ?? undefined,
                search: url.searchParams.get('search') ?? undefined,
              }),
        );
      }
      let usedInitial = false;
      const authorizeCourse = async () => {
        const current = usedInitial ? await sessions.authenticate(sessionHash, requestId) : auth;
        usedInitial = true;
        return { principal: current.principal, link: current.link, sessionHash, requestId };
      };
      if (path === '/api/lms/learners' || path.startsWith('/api/lms/learner-'))
        return await learnerRoute(
          new Learners(
            env.LMS_DB,
            authorizeCourse,
            foundationLearners(config, auth.tokens.accessToken, principal.subject),
          ),
          request,
          requestBody,
          outputHeaders,
        );
      if (path === '/api/lms/report' || path.startsWith('/api/lms/report-'))
        return await reportRoute(
          new Reports(
            env.LMS_DB,
            authorizeCourse,
            foundationDirectory(config, auth.tokens.accessToken, principal.subject),
          ),
          request,
          requestBody,
          outputHeaders,
        );
      if (path.startsWith('/api/lms/question-'))
        return await questionRoute(
          new QuestionBank(
            env.LMS_DB,
            authorizeCourse,
            foundationDirectory(config, auth.tokens.accessToken, principal.subject),
          ),
          request,
          requestBody,
          outputHeaders,
          scan,
        );
      if (path.startsWith('/api/lms/training-'))
        return json(
          await trainingRoute(
            new TrainingNotices(
              env.LMS_DB,
              authorizeCourse,
              foundationDirectory(config, auth.tokens.accessToken, principal.subject),
              new TrainingIntakeInbox(env.LMS_DB, async (ref) => {
                const live = await sessions.authenticate(sessionHash, requestId);
                requirePermission(live.principal, live.link, 'lms:admin');
                return fetchTrainingIntakeSource(config, live.tokens.accessToken, ref);
              }),
            ),
            request,
            requestBody,
          ),
        );
      if (path === '/api/lms/config-transfer')
        return json(
          await lmsConfigurationRoute(
            new LmsConfigurationTransfer(
              env.LMS_DB,
              authorizeCourse,
              foundationDirectory(config, auth.tokens.accessToken, principal.subject),
              config,
            ),
            request,
            requestBody,
          ),
        );
      const courses = new Courses(
        env.LMS_DB,
        authorizeCourse,
        foundationDirectory(config, auth.tokens.accessToken, principal.subject),
      );
      if (path === '/api/lms/media' && request.method === 'POST')
        return json(await uploadMedia(courses, env.LMS_DB, env.LMS_MEDIA, request, scan));
      if (path === '/api/lms/media' && request.method === 'GET')
        return json(await courses.mediaList(url.searchParams.get('cursor') ?? undefined));
      if (path.startsWith('/api/lms/media/') && ['GET', 'HEAD'].includes(request.method))
        return await serveMedia(
          courses,
          env.LMS_MEDIA,
          request,
          outputHeaders,
          scan && { scan, cache: lmsMediaScanCache(config.instanceId) },
        );
      return json(await courseRoute(courses, request, requestBody));
    }
    if (path === '/api/v1/me' && request.method === 'GET')
      return json({
        accountId: principal.accountId,
        personId: principal.personId,
        displayName: principal.displayName,
        unit: principal.units.find(
          (unit) => unit.tenantId === link.tenant_id && unit.orgUnitId === link.org_unit_id,
        ),
        appCode: config.clientId,
        csrfToken: await csrf(config, sessionHash),
        permissions: principal.permissions,
        memberships: principal.tenantIds.map((id) => ({
          id,
          code: id,
          name: 'Không gian được cấp',
        })),
        assignments: [],
        legacy: {
          id: link.employee_id,
          name: link.name,
          code: link.code,
          department: link.department,
          role: link.role,
          authSource: 'aio',
        },
        capabilities: Object.fromEntries(
          ['lms:learn', 'lms:review', 'lms:admin'].map((permission) => {
            try {
              requirePermission(
                principal,
                link,
                permission as 'lms:learn' | 'lms:review' | 'lms:admin',
              );
              return [permission, true];
            } catch {
              return [permission, false];
            }
          }),
        ),
      });
    if (path === '/api/v1/applications' && request.method === 'GET')
      return json({
        items: [{ code: config.clientId, name: 'LMS — Sandbox SSO', launchUrl: config.baseUrl }],
      });
    if (path === '/api/learning' && request.method === 'GET') {
      requirePermission(principal, link, 'lms:learn');
      if (url.searchParams.has('userId') && url.searchParams.get('userId') !== link.employee_id)
        throw new LmsError(403, 'LMS_PERMISSION_DENIED');
      const progress = await env.LMS_DB.prepare(
        'SELECT p.id,p.user_id,p.lesson_id,p.position,p.watched,p.finished,l.title,l.subtitle,l.series,l.duration,l.deadline,l.is_mandatory FROM learning_progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=? ORDER BY l.order_index',
      )
        .bind(link.employee_id)
        .all();
      const attempts = await env.LMS_DB.prepare(
        'SELECT a.id,a.user_id,a.lesson_id,a.score,a.created_at,l.title FROM learning_attempts a LEFT JOIN lessons l ON l.id=a.lesson_id WHERE a.user_id=? ORDER BY a.created_at DESC',
      )
        .bind(link.employee_id)
        .all();
      const notes = await env.LMS_DB.prepare(
        'SELECT n.id,n.user_id,n.lesson_id,n.time,n.content,n.created_at,l.title FROM learning_notes n LEFT JOIN lessons l ON l.id=n.lesson_id WHERE n.user_id=? ORDER BY n.created_at DESC',
      )
        .bind(link.employee_id)
        .all();
      return json({
        employeeId: link.employee_id,
        name: link.name,
        progress: progress.results,
        attempts: attempts.results,
        notes: notes.results,
      });
    }
    if ((path === '/api/review' || path === '/api/admin') && request.method === 'GET') {
      const after = legacyCursor(url.searchParams.get('cursor') ?? undefined);
      requirePermission(principal, link, path === '/api/admin' ? 'lms:admin' : 'lms:review');
      const requestedUnit = url.searchParams.get('orgUnitId');
      const permission = path === '/api/admin' ? 'lms:admin' : 'lms:review';
      if (requestedUnit && !allowed(principal, permission, link.tenant_id, requestedUnit))
        throw new LmsError(403, 'LMS_PERMISSION_DENIED');
      const permissions = principal.permissions.filter(
        (entry) => entry.tenantId === link.tenant_id && entry.permission === permission,
      );
      const units = requestedUnit
        ? [requestedUnit]
        : permissions.flatMap((entry) => (entry.orgUnitId ? [entry.orgUnitId] : []));
      const all = !requestedUnit && permissions.some((entry) => entry.orgUnitId === null);
      const scope = all
        ? '1=1'
        : units.length
          ? 'a.org_unit_id IN (' + units.map(() => '?').join(',') + ')'
          : '0=1';
      const result = await env.LMS_DB.prepare(
        "SELECT a.account_id,a.person_id,e.id,e.code,e.name,e.department,e.role,a.org_unit_id,p.id AS progress_id,p.lesson_id,p.position,p.watched,p.finished,l.title,l.duration FROM aio_account_links a JOIN employees e ON e.id=a.employee_id LEFT JOIN learning_progress p ON p.user_id=e.id LEFT JOIN lessons l ON l.id=p.lesson_id WHERE a.tenant_id=? AND a.active=1 AND e.is_active=1 AND (? IS NULL OR e.id>? OR (e.id=? AND COALESCE(p.id,'')>?)) AND " +
          scope +
          " ORDER BY e.id,COALESCE(p.id,'') LIMIT ?",
      )
        .bind(
          link.tenant_id,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[1] ?? null,
          ...(all ? [] : units),
          LMS_PAGE_SIZE + 1,
        )
        .all();
      const eligible = await subjectUnits(
        config,
        auth.tokens.accessToken,
        principal.subject,
        result.results.slice(0, LMS_PAGE_SIZE).map((row) => row.account_id as string),
      );
      return json({
        nextCursor:
          result.results.length > LMS_PAGE_SIZE
            ? encodeListCursor('legacy', [
                result.results[LMS_PAGE_SIZE - 1]!.id as string,
                (result.results[LMS_PAGE_SIZE - 1]!.progress_id as string | null) ?? '',
              ])
            : null,
        items: result.results
          .slice(0, LMS_PAGE_SIZE)
          .filter((row) =>
            eligible.some(
              (current) =>
                current.accountId === row.account_id &&
                current.personId === row.person_id &&
                current.tenantId === link.tenant_id &&
                current.orgUnitId === row.org_unit_id,
            ),
          ),
      });
    }
    if (path === '/api/auth/change-password')
      throw new LmsError(403, 'SSO_PASSWORD_MANAGED_BY_IDP');
    throw new LmsError(404, 'NOT_FOUND');
  } catch (error) {
    if (
      ['/api/lms/media', '/api/lms/question-imports/preview'].includes(
        new URL(request.url).pathname,
      ) &&
      request.body &&
      !request.bodyUsed
    )
      await request.body.cancel().catch(() => {});
    if (error instanceof CourseValidationError)
      return json({ error: error.code, issues: error.issues, requestId }, error.status);
    const known = error instanceof LmsError;
    const rejected = String((error as Error).message).includes('LMS_SESSION_REJECTED');
    const status = known ? error.status : rejected ? 401 : 503,
      code = known ? error.code : rejected ? 'SESSION_REVOKED' : 'LMS_DEPENDENCY_UNAVAILABLE';
    // A stale browser callback can start a new transaction, never reuse the old code.
    // Leave API failures and an existing application session unchanged.
    if (
      known &&
      code === 'LOGIN_TRANSACTION_INVALID' &&
      request.method === 'GET' &&
      new URL(request.url).pathname === '/auth/callback'
    ) {
      const acceptsHtml = (request.headers.get('accept') ?? '').split(',').some((entry) => {
        const [mediaType, ...parameters] = entry.trim().toLowerCase().split(';');
        const quality = parameters
          .map((value) => value.trim())
          .find((value) => value.startsWith('q='));
        return mediaType === 'text/html' && (quality === undefined || Number(quality.slice(2)) > 0);
      });
      if (acceptsHtml) {
        outputHeaders.set('location', '/#login-recovery');
        return new Response(null, { status: 303, headers: outputHeaders });
      }
    }
    return json({ error: code, requestId }, status);
  }
}

let pendingTelemetry = 0;
let pendingIngressAudit = 0;
export default {
  async fetch(request: Request, env: Env, context?: { waitUntil(work: Promise<unknown>): void }) {
    const requestId = crypto.randomUUID();
    const sink = env.AIO_TELEMETRY;
    const operation =
      sink && context ? classifyHttp(request.method, new URL(request.url).pathname) : undefined;
    const span = operation ? new HttpSpan() : undefined;
    const response = await handle(request, env, requestId, span);
    const audit = env.AIO_INGRESS_AUDIT;
    if (audit && context) {
      const path = new URL(request.url).pathname;
      const status = response.status;
      const action =
        status >= 500
          ? 'http.error'
          : status === 401 || status === 403
            ? 'http.denied'
            : path === '/auth/callback' && status >= 200 && status < 400
              ? 'auth.callback'
              : undefined;
      if (action) {
        if (pendingIngressAudit >= 64) console.error('LMS ingress audit queue is full.');
        else {
          pendingIngressAudit++;
          context.waitUntil(
            Promise.resolve()
              .then(async () => {
                const result = await audit.fetch(
                  new Request('https://audit.invalid/ingress', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action, status, requestId, at: Date.now() }),
                  }),
                );
                await result.body?.cancel();
                if (result.status !== 204) throw new Error('Audit delivery failed');
              })
              .catch(() => console.error('LMS ingress audit delivery failed.'))
              .finally(() => {
                pendingIngressAudit--;
              }),
          );
        }
      }
    }
    if (span && operation && sink && context) {
      if (pendingTelemetry < 64) {
        const event = span.finish('aio-lms-sandbox', operation, requestId, response.status);
        const delivery = new Request('https://telemetry.invalid/observations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
        });
        pendingTelemetry++;
        context.waitUntil(
          Promise.resolve()
            .then(() => sink.fetch(delivery))
            .then((ack) => ack.body?.cancel())
            .catch(() => {})
            .finally(() => {
              pendingTelemetry--;
            }),
        );
      }
    }
    return response;
  },
};
