import { bffClients } from '../src/config.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import type { BrowserContext, APIResponse } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import type { FormsFixture } from './forms-fixtures.js';
import { hashToken, unseal } from '../src/security.js';

const runtime = await loadLocalConfig();
const testRuntime = { ...runtime, databaseUrl: testDatabaseUrl(runtime) };
const receipt = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  purpose: string;
  users: FormsFixture[];
};
assert.equal(receipt.instanceId, runtime.instanceId);
assert.equal(receipt.purpose, 'tlqm-aio-forms-fixtures');
const F = runtime.clients.find((client) => client.code === 'aio-forms')!.baseUrl;
const A = runtime.clients.find((client) => client.code === 'aio-foundation')!.baseUrl;
const browser = await chromium.launch({ headless: true });
const servers: FastifyInstance[] = [];
const pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 1 });
let stage = 'startup';
type Session = { context: BrowserContext; csrf: string; base: string };
async function status(response: APIResponse, expected: number) {
  if (response.status() !== expected) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    console.error(
      'Forms HTTP status: ' +
        response.status() +
        '/' +
        expected +
        (body.error && /^[A-Z0-9_]{1,80}$/.test(body.error) ? ' ' + body.error : ''),
    );
  }
  assert.equal(response.status(), expected);
}
async function login(
  user: { id: string; username: string; password: string },
  base = F,
  mfa = false,
): Promise<Session> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === base && url.pathname === '/', { timeout: 20000 });
  const response = await context.request.get(base + '/api/v1/me');
  await status(response, 200);
  return { context, base, csrf: ((await response.json()) as { csrfToken: string }).csrfToken };
}
async function write(
  session: Session,
  path: string,
  body: unknown,
  method = 'POST',
  key = randomUUID(),
) {
  return session.context.request.fetch(session.base + path, {
    method,
    data: body,
    headers: { origin: session.base, 'x-csrf-token': session.csrf, 'idempotency-key': key },
  });
}
const body = (data: Record<string, unknown>) => ({
  tenantId: ids.tenantA,
  reason: 'Forms HTTP acceptance',
  ...data,
});
const roleUser = (role: FormsFixture['role']) => receipt.users.find((user) => user.role === role)!;
let admin: Session | undefined;
let grantRestore: { id: string; active: boolean } | undefined;
let bindingRestore: { id: string; active: boolean } | undefined;
let revocationMs = 0;
try {
  for (const client of bffClients(runtime)) {
    const app = await createApp({ runtime: testRuntime, client, test: true, logger: false });
    await app.listen({ host: '127.0.0.1', port: client.port });
    servers.push(app);
  }
  stage = 'MFA designer and publisher';
  const designer = await login(roleUser('designer'), F, true);
  const publisher = await login(roleUser('publisher'), F, true);
  stage = 'Portal to Forms SSO in one browser';
  const learner = await login(
    runtime.users.find((user) => user.id === ids.learner)!,
    A,
  );
  const portalApps = await learner.context.request.get(A + '/api/v1/applications');
  await status(portalApps, 200);
  assert.ok(
    ((await portalApps.json()) as { items: { code: string; launchUrl: string }[] }).items.some(
      (app) => app.code === 'aio-forms' && app.launchUrl === F,
    ),
  );
  const ssoPage = await learner.context.newPage();
  await ssoPage.goto(F + '/auth/login');
  await ssoPage.waitForURL((url) => url.origin === F && url.pathname === '/', { timeout: 15000 });
  assert.equal(await ssoPage.locator('#username, #password, #otp').count(), 0);
  const formsMe = await learner.context.request.get(F + '/api/v1/me');
  await status(formsMe, 200);
  const formsIdentity = (await formsMe.json()) as { accountId: string; csrfToken: string };
  assert.equal(formsIdentity.accountId, ids.learner);
  learner.base = F;
  learner.csrf = formsIdentity.csrfToken;
  const second = await login(roleUser('respondent'));
  const reviewer = await login(roleUser('reviewer'));
  const analyst = await login(roleUser('analyst'));
  const stranger = await browser.newContext();
  await status(await stranger.request.get(F + '/api/v1/forms?tenantId=' + ids.tenantA), 401);
  stage = 'create schema and HTTP role separation';
  const schema = {
    schemaVersion: 1,
    title: 'Khảo sát HTTP ' + randomUUID().slice(0, 6),
    sections: [
      {
        id: 'main',
        title: 'Công việc',
        fields: [
          { id: 'used', type: 'boolean', label: 'Đã sử dụng', required: true },
          {
            id: 'detail',
            type: 'shortText',
            label: 'Chi tiết',
            required: true,
            visibleWhen: { mode: 'all', rules: [{ fieldId: 'used', operator: 'eq', value: true }] },
          },
        ],
      },
    ],
  };
  const createdResponse = await write(
    designer,
    '/api/v1/forms',
    body({ code: 'http-' + randomUUID().slice(0, 8), schema, orgUnitId: null, maxSubmissions: 2 }),
  );
  await status(createdResponse, 200);
  const form = (await createdResponse.json()) as { id: string; revision: number };
  await status(
    await write(
      designer,
      '/api/v1/forms/' + form.id + '/publish',
      body({ expectedRevision: form.revision }),
    ),
    403,
  );
  await status(
    await write(
      publisher,
      '/api/v1/forms/' + form.id + '/draft',
      body({ expectedRevision: form.revision, schema }),
    ),
    403,
  );
  const assigned = await write(
    publisher,
    '/api/v1/forms/' + form.id + '/audience',
    body({
      expectedRevision: form.revision,
      audiences: [ids.unitA, ids.unitC].map((unit) => ({
        kind: 'unit',
        targetId: unit,
        opensAt: '2020-01-01T00:00:00Z',
        closesAt: null,
      })),
    }),
  );
  await status(assigned, 200);
  const assignedForm = ((await assigned.json()) as { form: { revision: number } }).form;
  const published = await write(
    publisher,
    '/api/v1/forms/' + form.id + '/publish',
    body({ expectedRevision: assignedForm.revision }),
  );
  await status(published, 200);
  const firstVersion = (await published.json()) as {
    version: { id: string };
    form: { revision: number };
  };
  stage = 'payload tampering CSRF tenant and client isolation';
  await status(
    await learner.context.request.post(F + '/api/v1/forms/' + form.id + '/submissions', {
      data: body({
        versionId: firstVersion.version.id,
        orgUnitId: ids.unitA,
        answers: { used: false },
        submit: true,
      }),
    }),
    400,
  );
  // A valid envelope without the Origin/CSRF pair must still fail authentication.
  await status(
    await learner.context.request.post(F + '/api/v1/forms/' + form.id + '/submissions', {
      data: body({
        versionId: firstVersion.version.id,
        orgUnitId: ids.unitA,
        answers: { used: false },
        submit: true,
      }),
      headers: { 'idempotency-key': randomUUID() },
    }),
    403,
  );
  await status(await learner.context.request.get(F + '/api/v1/forms?tenantId=' + ids.tenantB), 403);
  await status(
    await write(
      learner,
      '/api/v1/forms/' + form.id + '/submissions',
      body({
        versionId: firstVersion.version.id,
        orgUnitId: ids.unitB,
        answers: { used: false },
        submit: true,
      }),
    ),
    403,
  );
  await status(
    await write(
      learner,
      '/api/v1/forms/' + form.id + '/submissions',
      body({
        versionId: firstVersion.version.id,
        orgUnitId: ids.unitA,
        answers: { used: false, detail: 'Hidden injection' },
        submit: true,
      }),
    ),
    400,
  );
  await status(
    await write(
      learner,
      '/api/v1/forms/' + form.id + '/submissions',
      body({
        versionId: firstVersion.version.id,
        orgUnitId: ids.unitA,
        answers: { used: true, detail: 'OK', role: 'publisher' },
        submit: true,
      }),
    ),
    400,
  );
  const cookie = (await learner.context.cookies()).find(
    (cookie) => cookie.name === 'aio_session_aio-forms',
  );
  assert.ok(cookie);
  const tokenRow = (
    await pool.query('SELECT encrypted_payload FROM sessions WHERE hash=$1 AND app_code=$2', [
      hashToken(cookie.value),
      'aio-forms',
    ])
  ).rows[0];
  const payload = unseal<{ accessToken: string }>(
    tokenRow.encrypted_payload,
    runtime.encryptionKey,
    'session:aio-forms',
  );
  await status(
    await stranger.request.get(A + '/api/v1/me', {
      headers: { authorization: 'Bearer ' + payload.accessToken },
    }),
    401,
  );
  stage = 'idempotent submit reporting and CSV scope';
  const input = body({
    versionId: firstVersion.version.id,
    orgUnitId: ids.unitA,
    answers: { used: true, detail: '=1+2' },
    submit: true,
  });
  const key = randomUUID();
  const sent = await write(
    learner,
    '/api/v1/forms/' + form.id + '/submissions',
    input,
    'POST',
    key,
  );
  await status(sent, 200);
  const retry = await write(
    learner,
    '/api/v1/forms/' + form.id + '/submissions',
    input,
    'POST',
    key,
  );
  await status(retry, 200);
  assert.equal((await sent.json()).id, (await retry.json()).id);
  await status(
    await write(
      second,
      '/api/v1/forms/' + form.id + '/submissions',
      body({
        versionId: firstVersion.version.id,
        orgUnitId: ids.unitC,
        answers: { used: true, detail: 'SECOND-UNIT-ONLY' },
        submit: true,
      }),
    ),
    200,
  );
  const reviewResponse = await reviewer.context.request.get(
    F + '/api/v1/forms/' + form.id + '/submissions?tenantId=' + ids.tenantA,
  );
  await status(reviewResponse, 200);
  const visible = (await reviewResponse.json()) as { org_unit_id: string }[];
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.org_unit_id, ids.unitA);
  await status(
    await designer.context.request.get(
      F + '/api/v1/forms/' + form.id + '/submissions?tenantId=' + ids.tenantA,
    ),
    403,
  );
  const reportResponse = await analyst.context.request.get(
    F + '/api/v1/forms/' + form.id + '/report?tenantId=' + ids.tenantA,
  );
  await status(reportResponse, 200);
  assert.equal((await reportResponse.json()).total, 1);
  const exportResponse = await write(
    analyst,
    '/api/v1/forms/' + form.id + '/versions/' + firstVersion.version.id + '/export',
    body({}),
  );
  await status(exportResponse, 200);
  const csv = await exportResponse.text();
  assert.ok(csv.includes('text: =1+2'));
  assert.ok(!csv.includes('SECOND-UNIT-ONLY'));
  await status(
    await write(
      reviewer,
      '/api/v1/forms/' + form.id + '/versions/' + firstVersion.version.id + '/export',
      body({}),
    ),
    403,
  );
  stage = 'SSO app and role revocation on existing sessions';
  admin = await login(
    runtime.users.find((user) => user.id === ids.admin)!,
    A,
    true,
  );
  const grantPath = '/api/v1/manage/grants';
  const readGrants = async () =>
    (
      (await (
        await admin!.context.request.get(
          A + grantPath + '?tenantId=' + ids.tenantA + '&appCode=aio-forms',
        )
      ).json()) as { items: { accountId: string; active: boolean; revision: number }[] }
    ).items.map((row) => ({ ...row, id: row.accountId }));
  const grant = (await readGrants()).find((row) => row.accountId === ids.learner)!;
  assert.ok(grant);
  grantRestore = { id: grant.id, active: grant.active };
  const started = Date.now();
  await status(
    await write(
      admin,
      grantPath + '/' + grant.id,
      body({
        expectedRevision: grant.revision,
        data: { appCode: 'aio-forms', accountId: ids.learner, active: false },
      }),
      'PATCH',
    ),
    200,
  );
  await status(
    await learner.context.request.get(F + '/api/v1/forms/' + form.id + '?tenantId=' + ids.tenantA),
    403,
  );
  revocationMs = Date.now() - started;
  assert.ok(revocationMs < 60000);
  const revoked = (await readGrants()).find((row) => row.accountId === ids.learner)!;
  await status(
    await write(
      admin,
      grantPath + '/' + revoked.id,
      body({
        expectedRevision: revoked.revision,
        data: { appCode: 'aio-forms', accountId: ids.learner, active: grant.active },
      }),
      'PATCH',
    ),
    200,
  );
  grantRestore = undefined;
  const bindingPath = '/api/v1/manage/bindings';
  const readBindings = async () =>
    (
      (await (
        await admin!.context.request.get(
          A + bindingPath + '?tenantId=' + ids.tenantA + '&appCode=aio-forms',
        )
      ).json()) as { items: { id: string; accountId: string; active: boolean; revision: number }[] }
    ).items;
  const binding = (await readBindings()).find((row) => row.accountId === roleUser('designer').id)!;
  assert.ok(binding);
  bindingRestore = { id: binding.id, active: binding.active };
  await status(
    await write(
      admin,
      bindingPath + '/' + binding.id,
      body({ expectedRevision: binding.revision, data: { appCode: 'aio-forms', active: false } }),
      'PATCH',
    ),
    200,
  );
  await status(
    await write(
      designer,
      '/api/v1/forms/' + form.id + '/draft',
      body({ expectedRevision: firstVersion.form.revision, schema }),
    ),
    403,
  );
  const inactive = (await readBindings()).find((row) => row.id === binding.id)!;
  await status(
    await write(
      admin,
      bindingPath + '/' + binding.id,
      body({
        expectedRevision: inactive.revision,
        data: { appCode: 'aio-forms', active: binding.active },
      }),
      'PATCH',
    ),
    200,
  );
  bindingRestore = undefined;
  await writeFile(
    '.local/evidence/forms-api.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        grantRevocationMs: revocationMs,
        checks: [
          'real OIDC/MFA, Portal to Forms SSO and Forms client isolation',
          'designer/publisher/reviewer/analyst/respondent HTTP permissions',
          'CSRF, tenant/unit, hidden/unknown field rejection',
          'single-effect submit retry',
          'scoped review/report/CSV',
          'live grant and role revocation',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: Forms real SSO/MFA, role/scope separation, HTTP validation, idempotent submission, scoped reporting/CSV and live revocation.',
  );
} catch (error) {
  console.error(
    'Forms API E2E failed at: ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Credentials and browser payloads omitted.',
  );
  process.exitCode = 1;
} finally {
  if (admin) {
    for (const [resource, restore] of [
      ['grants', grantRestore],
      ['bindings', bindingRestore],
    ] as const) {
      if (!restore) continue;
      const response = await admin.context.request.get(
        A + '/api/v1/manage/' + resource + '?tenantId=' + ids.tenantA + '&appCode=aio-forms',
      );
      const row = (
        (await response.json()) as { items: { id?: string; accountId: string; revision: number }[] }
      ).items
        .map((value) => ({ ...value, id: value.id ?? value.accountId }))
        .find((value) => value.id === restore.id);
      if (row)
        await status(
          await write(
            admin,
            '/api/v1/manage/' + resource + '/' + row.id,
            body({
              expectedRevision: row.revision,
              data: {
                appCode: 'aio-forms',
                active: restore.active,
                ...(resource === 'grants' ? { accountId: ids.learner } : {}),
              },
            }),
            'PATCH',
          ),
          200,
        );
    }
  }
  await browser.close();
  await Promise.all(servers.map((server) => server.close()));
  await pool.end();
}
