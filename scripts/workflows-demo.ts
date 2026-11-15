import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { loadLocalConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { ids } from '../src/fixtures.js';
import { clientLoginProof } from './client-login-proof.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { WorkflowsService } from '../src/workflows/service.js';
type Definition = Awaited<ReturnType<WorkflowsService['definitions']>>['items'][number];
const runtime = await loadLocalConfig(),
  client = runtime.clients.find((client) => client.code === 'aio-workflows')!;
const dynamic = process.argv.includes('--assignments');
let app: Awaited<ReturnType<typeof createApp>> | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let stage = 'preflight';
try {
  assert.ok(client);
  const forms = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
    instanceId: string;
    users: FormsFixture[];
  };
  assert.equal(forms.instanceId, runtime.instanceId);
  const role = (name: FormsFixture['role']) => forms.users.find((user) => user.role === name)!;
  const receiptPath = dynamic
      ? '.local/workflows-assignments-demo.json'
      : '.local/workflows-demo.json',
    code = dynamic ? 'de-nghi-mua-sam-chon-nhom' : 'de-nghi-mua-sam-mau';
  let prior:
    { instanceId: string; definitionId?: string; groupId?: string; code: string } | undefined;
  try {
    prior = JSON.parse(await readFile(receiptPath, 'utf8')) as typeof prior;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  app = await createApp({ runtime, client, logger: false });
  await app.listen({ host: '127.0.0.1', port: client.port });
  browser = await chromium.launch({ headless: true });
  stage = 'designer proof';
  const designer = await clientLoginProof(browser, runtime, client, role('designer'), true);
  const request = async <T>(
    token: string,
    path: string,
    data?: Record<string, unknown>,
  ): Promise<T> => {
    const response = await fetch(client.baseUrl + '/api/v1/workflows' + path, {
      method: data ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        ...(data ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
      },
      ...(data
        ? {
            body: JSON.stringify({
              ...data,
              tenantId: ids.tenantA,
              reason: 'Tạo mẫu Quy trình local để dùng thử',
            }),
          }
        : {}),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Guarded demo request failed');
    return response.json() as Promise<T>;
  };
  const definitions = await request<{ items: Definition[] }>(
    designer.accessToken,
    '/definitions?tenantId=' + ids.tenantA,
  );
  const existing = definitions.items.find((item) => item.code === code);
  if (existing) {
    assert.ok(
      prior &&
        prior.instanceId === runtime.instanceId &&
        prior.definitionId === existing.id &&
        prior.code === code,
    );
    console.log(
      'PASS: existing owned Workflow demo retained; no draft, version or publication status changed.',
    );
  } else {
    if (prior)
      assert.ok(
        dynamic &&
          prior.instanceId === runtime.instanceId &&
          prior.code === code &&
          !prior.definitionId &&
          prior.groupId,
      );
    const spec = workflowTemplate();
    spec.name = dynamic ? 'Đề nghị mua sắm · Chọn người trong nhóm' : 'Đề nghị mua sắm · Mẫu TLQM';
    spec.input.title = spec.name;
    spec.audienceUnits = [ids.unitA];
    for (const node of spec.nodes)
      if (node.kind === 'approval' || node.kind === 'task')
        node.assignee = node.id === 'review' ? role('reviewer').id : role('analyst').id;
    let publisher: Awaited<ReturnType<typeof clientLoginProof>> | undefined;
    if (dynamic) {
      stage = 'group operator proof';
      publisher = await clientLoginProof(browser, runtime, client, role('publisher'), true);
      let groupId = prior?.groupId;
      if (groupId) {
        const groups = await request<{ items: { id: string }[] }>(
          publisher.accessToken,
          '/groups?tenantId=' + ids.tenantA,
        );
        assert.ok(groups.items.some((group) => group.id === groupId));
      } else {
        const group = await request<{ id: string }>(publisher.accessToken, '/groups', {
          name: 'Tổ xử lý mẫu TLQM',
          orgUnitId: ids.unitA,
          accountIds: [role('reviewer').id, role('analyst').id],
          active: true,
        });
        groupId = group.id;
        prior = { instanceId: runtime.instanceId, code, groupId };
        await writeFile(receiptPath, JSON.stringify(prior, null, 2) + '\n', {
          flag: 'wx',
          mode: 0o600,
        });
      }
      spec.schemaVersion = 2;
      for (const node of spec.nodes)
        if (node.kind === 'approval' || node.kind === 'task') {
          if (node.id === 'review') {
            node.assignee = '';
            node.assigneeRule = { kind: 'group', groupId };
          }
          if (node.id === 'fulfil') {
            node.assignee = '';
            node.assigneeRule = { kind: 'previous', stepId: 'review' };
          }
        }
    }
    stage = 'create local demo draft';
    const saved = await request<{ id: string; revision: number }>(
      designer.accessToken,
      '/definitions',
      { code, orgUnitId: ids.unitA, spec },
    );
    await writeFile(
      receiptPath,
      JSON.stringify(
        { ...prior, instanceId: runtime.instanceId, definitionId: saved.id, code },
        null,
        2,
      ) + '\n',
      { flag: prior ? 'w' : 'wx', mode: 0o600 },
    );
    stage = 'publisher proof';
    publisher ??= await clientLoginProof(browser, runtime, client, role('publisher'), true);
    await request(publisher.accessToken, '/definitions/' + saved.id + '/publish', {
      expectedRevision: saved.revision,
    });
    console.log(
      'PASS: local purchase workflow published through real designer/publisher MFA and API; synthetic sample only.',
    );
  }
} catch {
  console.error('Workflows demo setup failed at ' + stage + '. Sensitive details omitted.');
  process.exitCode = 1;
} finally {
  await browser?.close();
  app?.server.closeAllConnections();
  await app?.close();
}
