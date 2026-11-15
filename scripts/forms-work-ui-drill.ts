import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect } from '@playwright/test';
import { ids } from '../src/fixtures.js';
import { formTarget } from '../frontend/src/lib/form-target.js';

const [release, digest, ...extra] = process.argv.slice(2);
if (
  !release ||
  !/^[a-z0-9][a-z0-9-]{0,39}$/.test(release) ||
  !digest ||
  !/^[a-f0-9]{64}$/.test(digest) ||
  extra.length
)
  throw new Error('Use forms-work-ui-drill.ts <release-name> <artifact-sha256>.');
const root = await realpath('.');
const artifact = join(root, '.local', 'releases', release, 'artifact');
assert.equal(
  spawnSync(process.execPath, ['scripts/release.mjs', 'verify', artifact, digest], {
    stdio: 'ignore',
    windowsHide: true,
  }).status,
  0,
);
const frontend = join(artifact, 'frontend', 'dist');
const html = (await readFile(join(frontend, 'index.html'), 'utf8')).replace(
  '__AIO_STYLE_NONCE__',
  'fixture-only',
);
const tenant = ids.tenantA,
  unit = ids.unitA;
const form = randomUUID(),
  version = randomUUID(),
  submission = randomUUID();
const title = 'Phiếu phản hồi E4';
const schema = {
  schemaVersion: 1,
  title,
  sections: [
    {
      id: 'main',
      title: 'Thông tin',
      fields: [{ id: 'feedback', type: 'shortText', label: 'Phản hồi', required: true }],
    },
  ],
};
const formRow = {
  id: form,
  title,
  code: 'e4-fixture',
  status: 'open',
  org_unit_id: unit,
  latest_version: 1,
  max_submissions: 1,
  revision: 1,
  hasDraft: false,
};
const stamp = new Date().toISOString();
let signedIn = false;
let status: 'draft' | 'submitted' = 'draft';
let sent = 0;
const row = () => ({
  id: submission,
  status,
  version_id: version,
  org_unit_id: unit,
  answers: { feedback: 'Nội dung nháp giả lập' },
  revision: sent + 1,
  version: 1,
  version_schema: schema,
  created_at: stamp,
  updated_at: stamp,
  submitted_at: status === 'submitted' ? stamp : null,
});
const servers: ReturnType<typeof Fastify>[] = [];
async function server(code: 'aio-forms' | 'aio-foundation') {
  const app = Fastify();
  servers.push(app);
  await app.register(staticFiles, { root: join(frontend, 'assets'), prefix: '/assets/' });
  app.get('/', (_req, reply) => reply.type('text/html').send(html));
  app.get('/api/v1/me', (_req, reply) =>
    code === 'aio-forms' && !signedIn
      ? reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' })
      : {
          accountId: ids.learner,
          personId: ids.learner,
          appCode: code,
          displayName: 'Người trả lời thử',
          csrfToken: 'fixture-only',
          assignments: [],
          memberships: [
            ...(code === 'aio-forms' ? [{ id: ids.tenantB, code: 'B', name: 'Không gian B' }] : []),
            { id: tenant, code: 'A', name: 'Không gian A' },
          ],
          permissions: [
            {
              tenantId: tenant,
              permission: 'forms:respond',
              orgUnitId: unit,
              managedAppCode: null,
            },
          ],
        },
  );
  app.get('/api/v1/runtime-info', () => ({
    appCode: code,
    name: 'TLQM AIO',
    environment: 'test',
    loginUrl: '/auth/login',
    logoutUrl: '/',
    accountUrl: '/',
  }));
  app.get('/api/v1/applications', () => ({ items: [] }));
  return app;
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const forms = await server('aio-forms');
  forms.get('/auth/login', (_req, reply) => {
    signedIn = true;
    return reply.redirect('/');
  });
  forms.get('/api/v1/forms/pages', () => ({ items: [formRow], nextCursor: null }));
  forms.get('/api/v1/forms/lookups', () => ({
    units: [{ id: unit, name: 'Đơn vị A' }],
    ownUnits: [unit],
    accounts: [],
  }));
  forms.get<{ Querystring: { tenantId: string } }>('/api/v1/forms/' + form, (req, reply) => {
    if (req.query.tenantId !== tenant)
      return reply.code(403).send({ error: 'FORMS_PERMISSION_DENIED' });
    return {
      form: formRow,
      versions: [{ id: version, version: 1, schema, closed_at: null }],
      responseUnits: [unit],
      audiences: [],
    };
  });
  forms.get('/api/v1/forms/' + form + '/submissions/page', () => ({
    items: [row()],
    nextCursor: null,
    submittedCount: sent,
  }));
  forms.patch('/api/v1/forms/' + form + '/submissions/' + submission, (req) => {
    assert.equal(req.headers['x-csrf-token'], 'fixture-only');
    assert.match(String(req.headers['idempotency-key']), /^[a-f0-9-]{36}$/);
    const body = req.body as Record<string, unknown>;
    assert.deepEqual(
      [body.tenantId, body.versionId, body.orgUnitId, body.expectedRevision, body.submit],
      [tenant, version, unit, 1, true],
    );
    assert.deepEqual(body.answers, row().answers);
    status = 'submitted';
    sent++;
    return row();
  });
  const source = {
    code: 'aio-forms',
    name: 'Biểu mẫu',
    baseUrl: await forms.listen({ host: '127.0.0.1', port: 0 }),
  };
  const portal = await server('aio-foundation');
  portal.get('/api/v1/work-center/sources', () => ({ items: [source] }));
  portal.get('/api/v1/work-center/forms', () => ({
    source,
    nextCursor: null,
    items: status === 'draft' ? [{ id: form, title, version: 1, action: 'resume' }] : [],
  }));
  const base = await portal.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(base + '/#work-center');
  const panel = page.getByRole('region', { name: 'Biểu mẫu cần trả lời' });
  const link = panel.getByRole('link', { name: 'Tiếp tục bản nháp ' + title });
  await expect(link).toHaveAttribute('href', source.baseUrl + '/' + formTarget(tenant, form));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const scan = await new AxeBuilder({ page })
    .include('section[aria-label="Biểu mẫu cần trả lời"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  assert.deepEqual(
    scan.violations.map(({ id }) => id),
    [],
  );
  await link.press('Enter');
  await page.getByRole('link', { name: 'Đăng nhập SSO' }).press('Enter');
  await expect(page.getByRole('tab', { name: 'Trả lời', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#answer-feedback')).toHaveValue('Nội dung nháp giả lập');
  await page.getByRole('button', { name: 'Gửi phiếu', exact: true }).press('Enter');
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Xác nhận', exact: true })
    .press('Enter');
  await expect(
    page.getByText('Đã gửi phiếu. Nội dung đã gửi được giữ nguyên.', { exact: true }),
  ).toBeVisible();
  assert.equal(sent, 1);
  await page.goto(base + '/#work-center');
  await expect(panel.getByText('Không có biểu mẫu cần trả lời.')).toBeVisible();
  const evidence = join(root, '.local', 'evidence');
  await mkdir(evidence, { recursive: true });
  assert.equal(await realpath(evidence), evidence);
  const run = randomUUID(),
    now = new Date();
  const receipt = {
    status: 'pass',
    scope: 'forms-work-browser-component',
    release,
    artifactDigest: digest,
    run,
    checkedAt: now.toISOString(),
    checkedAtVietnam: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    viewport: 390,
    chromium: browser.version(),
    keyboard: true,
    scopedAxeViolations: 0,
    draftResumed: true,
    submittedWithCsrfAndRevision: true,
    removedFromPortal: true,
    httpFixtures: true,
  };
  await writeFile(
    join(evidence, 'enterprise-e4-forms-work-ui-' + run + '.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify(receipt));
} finally {
  await browser?.close();
  await Promise.all(servers.map((app) => app.close()));
}
