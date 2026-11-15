import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium, expect } from '@playwright/test';
import { ids } from '../src/fixtures.js';
import { defaultTaskStages } from '../src/tasks/options.js';
import type { TaskWorkflow } from '../src/tasks/options.js';
import { verifyPortalTaskUi } from './staging-access-ui.js';

const [release, digest, profile, ...extra] = process.argv.slice(2);
const withWorkflow = profile === '--workflow';
if (
  !release ||
  !/^[a-z0-9][a-z0-9-]{0,39}$/.test(release) ||
  !digest ||
  !/^[0-9a-f]{64}$/.test(digest) ||
  (profile !== undefined && !withWorkflow) ||
  extra.length
)
  throw new Error('Use task-work-ui-drill.ts <release-name> <artifact-sha256> [--workflow].');
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
const project = randomUUID(),
  task = randomUUID();
const title = 'Kiểm tra công việc từ Portal';
const projectName = 'Dự án nghiệm thu giả lập';
const workflow: TaskWorkflow = {
  stages: [
    ...defaultTaskStages.slice(0, 2),
    { code: 'review', name: 'Chờ duyệt', phase: 'doing' },
    defaultTaskStages[2]!,
  ],
  transitions: [{ from: 'review', to: 'done', roles: ['manager'] }],
};
const memberships = [
  { id: ids.tenantB, name: 'Tenant B', code: 'B' },
  { id: ids.tenantA, name: 'Tenant A', code: 'A' },
];
const person = { accountId: ids.learner, personId: ids.learner, name: 'Người dùng thử' };
const taskItem = {
  id: task,
  projectId: project,
  title,
  description: '',
  parentId: null,
  creator: person,
  assignee: person,
  status: 'todo',
  progress: 0,
  dueOn: '2026-11-30',
  remindDays: null,
  overdue: false,
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  canEdit: true,
  canProgress: true,
  canHandoff: true,
  canComment: true,
  ...(withWorkflow && {
    status: 'doing',
    stageCode: 'review',
    stageName: 'Chờ duyệt',
    allowedStages: ['done'],
  }),
};
const projectItem = {
  id: project,
  unitId: ids.unitA,
  name: projectName,
  description: '',
  archived: false,
  revision: 1,
  ownerAccountId: ids.learner,
  canManage: true,
  canCreateTask: true,
  canReport: false,
  ...(withWorkflow && { workflow }),
};
let signedInToTasks = false;
let openedTenant: string | undefined;
const servers: ReturnType<typeof Fastify>[] = [];
async function server(code: string) {
  const app = Fastify();
  servers.push(app);
  await app.register(fastifyStatic, { root: join(frontend, 'assets'), prefix: '/assets/' });
  app.get('/', (_req, reply) => reply.type('text/html').send(html));
  app.get('/api/v1/me', (_req, reply) =>
    code === 'aio-tasks' && !signedInToTasks
      ? reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' })
      : {
          accountId: person.accountId,
          personId: person.personId,
          displayName: person.name,
          appCode: code,
          csrfToken: 'synthetic',
          permissions: [],
          memberships: code === 'aio-tasks' ? memberships : [memberships[1]],
          assignments: [],
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
  const tasks = await server('aio-tasks');
  tasks.get('/auth/login', (_req, reply) => {
    signedInToTasks = true;
    return reply.redirect('/');
  });
  tasks.get('/api/v1/tasks/lookups', () => ({ units: [] }));
  tasks.get('/api/v1/tasks/projects', () => ({ items: [projectItem] }));
  tasks.get('/api/v1/tasks/projects/' + project, () => ({ project: projectItem, members: [] }));
  tasks.get('/api/v1/tasks/projects/' + project + '/items', () => ({
    items: [taskItem],
    nextAfter: null,
  }));
  tasks.get<{ Querystring: { tenantId?: string } }>('/api/v1/tasks/items/' + task, (req, reply) => {
    openedTenant = req.query.tenantId;
    if (!signedInToTasks || openedTenant !== ids.tenantA)
      return reply.code(403).send({ error: 'TASKS_PERMISSION_DENIED' });
    return { item: taskItem, participants: [], children: [], comments: [], history: [] };
  });
  const source = {
    code: 'aio-tasks',
    name: 'Công việc',
    baseUrl: await tasks.listen({ host: '127.0.0.1', port: 0 }),
  };
  const portal = await server('aio-foundation');
  portal.get('/api/v1/work-center/sources', () => ({ items: [source] }));
  portal.get('/api/v1/work-center/tasks/assigned', () => ({
    source,
    nextAfter: null,
    items: [
      {
        id: task,
        projectId: project,
        projectName,
        title,
        status: 'todo',
        dueOn: '2026-11-30',
        overdue: false,
      },
    ],
  }));
  const baseUrl = await portal.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);
  await verifyPortalTaskUi(page, { baseUrl: source.baseUrl, project, task, title }, async () => {
    await page.getByRole('link', { name: 'Đăng nhập SSO' }).press('Enter');
  });
  assert.equal(openedTenant, ids.tenantA);
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog.getByRole('button', { name: 'Cập nhật tiến độ' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeFocused();
  if (withWorkflow) {
    await page.getByRole('button', { name: 'Bảng Kanban', exact: true }).press('Enter');
    const column = page
      .getByRole('region', { name: 'Bảng công việc' })
      .getByRole('region', { name: 'Chờ duyệt' });
    await expect(column.getByRole('button', { name: title, exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Việc giao cho tôi' }).check();
    await page.getByRole('button', { name: 'Lưu góc nhìn', exact: true }).press('Enter');
    await expect(page.getByText('Đã lưu góc nhìn trên trình duyệt này.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Bảng Kanban', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('checkbox', { name: 'Việc giao cho tôi' })).toBeChecked();
    await page.getByRole('button', { name: 'Trạng thái dự án', exact: true }).press('Enter');
    const editor = page.getByRole('dialog', { name: 'Trạng thái dự án' });
    await expect(editor.getByLabel('review · Đang thực hiện', { exact: true })).toHaveValue(
      'Chờ duyệt',
    );
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
  }
  const run = randomUUID();
  const evidence = join(root, '.local', 'evidence');
  await mkdir(evidence, { recursive: true });
  assert.equal(await realpath(evidence), evidence);
  const now = new Date();
  const receipt = {
    status: 'pass',
    scope: 'task-work-browser-component',
    release,
    artifactDigest: digest,
    run,
    checkedAt: now.toISOString(),
    checkedAtVietnam: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    chromium: browser.version(),
    viewport: 390,
    keyboardNavigation: true,
    scopedAxeViolations: 0,
    simulatedLoginRedirect: true,
    correctTenantAndTask: true,
    dialogFocusRestored: true,
    httpFixtures: true,
    ...(withWorkflow && {
      customKanbanColumn: true,
      configurationDialog: true,
      savedViewAfterReload: true,
    }),
  };
  const file = join(evidence, 'enterprise-e4-task-work-ui-' + run + '.json');
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally {
  await browser?.close();
  await Promise.all(servers.map((app) => app.close()));
}
