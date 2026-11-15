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
import type { OperationItem } from '../src/workflows/operations-options.js';

const [release, digest, ...extra] = process.argv.slice(2);
if (
  !release ||
  !/^[a-z0-9][a-z0-9-]{0,39}$/.test(release) ||
  !digest ||
  !/^[0-9a-f]{64}$/.test(digest) ||
  extra.length
)
  throw new Error('Use workflow-operations-ui-drill.ts <release-name> <artifact-sha256>.');
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
const run = randomUUID();
const stamp = new Date().toISOString();
const job: OperationItem = {
  id: randomUUID(),
  runId: randomUUID(),
  configurationId: randomUUID(),
  unitId: ids.unitA,
  workflowName: 'Đề nghị đào tạo E4',
  version: 1,
  status: 'blocked',
  attempts: 1,
  errorCode: 'WORKFLOW_INTAKE_RECIPIENT_DENIED',
  updatedAt: stamp,
  nextAttemptAt: null,
  overdue: false,
  canRetry: true,
  history: [
    {
      attempt: 1,
      status: 'blocked',
      errorCode: 'WORKFLOW_INTAKE_RECIPIENT_DENIED',
      recordedAt: stamp,
    },
  ],
};
const server = Fastify();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let queued = false;
try {
  await server.register(staticFiles, { root: join(frontend, 'assets'), prefix: '/assets/' });
  server.get('/', (_req, reply) => reply.type('text/html').send(html));
  server.get('/api/v1/me', () => ({
    accountId: ids.admin,
    personId: ids.admin,
    appCode: 'aio-workflows',
    displayName: 'Quản trị giả lập',
    csrfToken: 'fixture-only',
    memberships: [{ id: ids.tenantA, code: 'A', name: 'Đơn vị thử' }],
    assignments: [],
    permissions: [
      {
        tenantId: ids.tenantA,
        permission: 'workflows:publish',
        managedAppCode: null,
        orgUnitId: ids.unitA,
      },
    ],
  }));
  server.get('/api/v1/runtime-info', () => ({
    appCode: 'aio-workflows',
    name: 'Quy trình',
    environment: 'test',
    loginUrl: '/auth/login',
    logoutUrl: '/',
    accountUrl: '/',
  }));
  for (const path of [
    '/api/v1/applications',
    '/api/v1/workflows/definitions',
    '/api/v1/workflows/link-rules',
  ])
    server.get(path, () => ({ items: [] }));
  server.get('/api/v1/workflows/lookups', () => ({ units: [], ownUnits: [], accounts: [] }));
  server.get<{ Querystring: { view: string } }>('/api/v1/workflows/operations', ({ query }) => ({
    items:
      query.view === 'attention' && !queued
        ? [job]
        : query.view === 'resolved' && queued
          ? [{ ...job, status: 'done', canRetry: false, errorCode: null, attempts: 2 }]
          : [],
    nextCursor: null,
  }));
  server.post<{ Body: { expectedRevision: number; tenantId: string; reason: string } }>(
    '/api/v1/workflows/intake-jobs/' + job.id + '/retry',
    (request) => {
      assert.deepEqual(request.body, {
        expectedRevision: 1,
        tenantId: ids.tenantA,
        reason: 'Đã khôi phục người tiếp nhận',
      });
      assert.equal(request.headers['x-csrf-token'], 'fixture-only');
      assert.match(String(request.headers['idempotency-key']), /^[a-f0-9-]{36}$/);
      queued = true;
      return { id: job.id, status: 'queued' };
    },
  );
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(url + '/#workflows/automation');
  await page.getByRole('tab', { name: 'Vận hành job', exact: true }).press('Enter');
  const panel = page.getByRole('region', { name: 'Vận hành job Quy trình' });
  await expect(panel.getByRole('heading', { name: 'Đề nghị đào tạo E4 · v1' })).toBeVisible();
  await panel.getByText('Lịch sử xử lý', { exact: true }).press('Enter');
  await expect(panel.getByText(/Lần 1 · Đã dừng/)).toBeVisible();
  await panel.getByRole('button', { name: 'Thử lại job', exact: true }).press('Enter');
  await panel.getByRole('textbox', { name: 'Lý do thử lại' }).fill('Đã khôi phục người tiếp nhận');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const scan = await new AxeBuilder({ page })
    .include('section[aria-label="Vận hành job Quy trình"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  assert.deepEqual(
    scan.violations.map(({ id }) => id),
    [],
  );
  await panel.getByRole('button', { name: 'Đưa vào hàng chờ', exact: true }).press('Enter');
  await expect(
    panel.getByRole('status').filter({ hasText: 'Đã đưa job vào hàng chờ' }),
  ).toBeVisible();
  await panel.getByRole('combobox', { name: 'Trạng thái vận hành' }).press('Enter');
  const done = page.getByRole('option', { name: 'Đã xử lý', exact: true });
  await done.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByText('Hoàn thành', { exact: true })).toBeVisible();
  assert.equal(queued, true);
  const evidence = join(root, '.local', 'evidence');
  await mkdir(evidence, { recursive: true });
  assert.equal(await realpath(evidence), evidence);
  const now = new Date();
  const receipt = {
    status: 'pass',
    scope: 'workflow-operations-browser-component',
    release,
    artifactDigest: digest,
    run,
    checkedAt: now.toISOString(),
    checkedAtVietnam: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    viewport: 390,
    chromium: browser.version(),
    keyboard: true,
    scopedAxeViolations: 0,
    retryReasonAndCsrfSent: true,
    completionShown: true,
    httpFixtures: true,
  };
  await writeFile(
    join(evidence, 'enterprise-e4-workflow-operations-ui-' + run + '.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify(receipt));
} finally {
  await browser?.close();
  await server.close();
}
