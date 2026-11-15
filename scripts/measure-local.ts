import { bffClients } from '../src/config.js';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { loadLocalConfig } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import { localStats } from './local-docker.js';

const execute = promisify(execFile);
const runtime = await loadLocalConfig();
const serverPath = resolve('dist/scripts/measure-server.js');
await access(serverPath);
const started = performance.now();
const child = spawn(process.execPath, [serverPath], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
child.stdout?.resume();
child.stderr?.resume();
let ownershipVerified = false;
type Metrics = {
  kind: 'metrics';
  id: string;
  pid: number;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  cpu: { user: number; system: number };
  uptime: number;
};
type Ready = {
  kind: 'ready';
  pid: number;
  argv: string[];
  node: string;
  clients: { code: string; port: number; baseUrl: string }[];
};
const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
function metrics() {
  const id = randomUUID();
  return new Promise<Metrics>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', listener);
      reject(new Error('API metrics IPC timed out.'));
    }, 5000);
    function listener(message: unknown) {
      const value = message as Metrics;
      if (value?.kind === 'metrics' && value.id === id) {
        clearTimeout(timer);
        child.off('message', listener);
        resolve(value);
      }
    }
    child.on('message', listener);
    child.send({ kind: 'metrics', id });
  });
}
async function verifyOwnership(ready: Ready) {
  assert.equal(child.exitCode, null);
  assert.equal(ready.pid, child.pid);
  assert.equal(resolve(ready.argv[1]!), serverPath);
  assert.deepEqual(
    ready.clients.map((c) => c.port).sort(),
    bffClients(runtime)
      .map((c) => c.port)
      .sort(),
  );
  const command =
    '$aioProcess=Get-CimInstance Win32_Process -Filter "ProcessId=' +
    String(child.pid) +
    '"; $aioPorts=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq ' +
    String(child.pid) +
    ' | Select-Object -ExpandProperty LocalPort); [pscustomobject]@{pid=$aioProcess.ProcessId;parent=$aioProcess.ParentProcessId;commandLine=$aioProcess.CommandLine;ports=$aioPorts} | ConvertTo-Json -Compress';
  const data = JSON.parse(
    (
      await execute('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        timeout: 15000,
      })
    ).stdout,
  ) as { pid: number; parent: number; commandLine: string; ports: number[] };
  assert.equal(data.pid, child.pid);
  assert.equal(data.parent, process.pid);
  assert.ok(data.commandLine.includes(serverPath));
  for (const client of bffClients(runtime)) {
    assert.ok(data.ports.includes(client.port));
    const response = await fetch(client.baseUrl + '/health/live');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).service, client.code);
  }
}
const ready = await new Promise<Ready>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Measurement API startup timed out.')), 20000);
  child.on('message', (message) => {
    const value = message as Ready | { kind: 'failed' };
    if (value.kind === 'ready') {
      clearTimeout(timer);
      resolve(value);
    } else if (value.kind === 'failed') {
      clearTimeout(timer);
      reject(new Error('Measurement API startup failed.'));
    }
  });
  child.once('error', () => {
    clearTimeout(timer);
    reject(new Error('Measurement API process unavailable.'));
  });
});
const browser = await chromium.launch({ headless: true });
let stage = 'verify API process ownership';
const round = (value: number) => Math.round(value * 100) / 100;
const cpuPercent = (start: Metrics, end: Metrics, wallMs: number) =>
  round(
    ((end.cpu.user - start.cpu.user + (end.cpu.system - start.cpu.system)) / (wallMs * 1000)) * 100,
  );
try {
  const startupMs = performance.now() - started;
  await verifyOwnership(ready);
  ownershipVerified = true;
  const foundation = runtime.clients.find((client) => client.code === 'aio-foundation')!;
  const A = foundation.baseUrl;
  async function login(username: string): Promise<BrowserContext> {
    const context = await browser.newContext();
    await context.route(A + '/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>API measurement fixture</p>' }),
    );
    const user = runtime.users.find((user) => user.username === username)!;
    const page = await context.newPage();
    await page.goto(A + '/auth/login');
    await page.locator('#username').fill(user.username);
    await page.locator('#password').fill(user.password);
    await page.locator('#kc-login').click();
    if (username === 'demo.admin') {
      await page.locator('#otp').fill(await nextFixtureOtp(user.id));
      await page.locator('#kc-login').click();
    }
    await page.waitForURL(A + '/', { timeout: 15000 });
    assert.equal((await context.request.get(A + '/api/v1/me')).status(), 200);
    return context;
  }
  stage = 'warm authentication';
  const learner = await login('demo.learner');
  const admin = await login('demo.admin');
  const endpoints = [
    { name: 'health/live', path: '/health/live', context: learner },
    { name: 'me', path: '/api/v1/me', context: learner },
    { name: 'directory', path: '/api/v1/directory?tenantId=' + ids.tenantA, context: learner },
    {
      name: 'roles',
      path: '/api/v1/manage/roles?tenantId=' + ids.tenantA + '&appCode=aio-foundation',
      context: admin,
    },
    { name: 'audit', path: '/api/v1/audit?tenantId=' + ids.tenantA, context: admin },
  ];
  for (const endpoint of endpoints)
    for (let i = 0; i < 3; i++)
      assert.equal((await endpoint.context.request.get(A + endpoint.path)).status(), 200);
  stage = 'idle resource sample';
  const idleStart = await metrics();
  const idleWall = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const idleEnd = await metrics();
  const idleDuration = performance.now() - idleWall;
  const containersIdle = await localStats();
  stage = 'serial API workload';
  const samples: Record<
    string,
    {
      count: number;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
      meanMs: number;
      responseBytes: number;
    }
  > = {};
  const workStart = await metrics();
  let peakRss = workStart.memory.rss;
  const workWall = performance.now();
  const containerSample = localStats();
  for (const endpoint of endpoints) {
    const timings: number[] = [];
    let responseBytes = 0;
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const response = await endpoint.context.request.get(A + endpoint.path);
      assert.equal(response.status(), 200);
      responseBytes = (await response.body()).byteLength;
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    samples[endpoint.name] = {
      count: timings.length,
      p50Ms: round(timings[Math.ceil(timings.length * 0.5) - 1]!),
      p95Ms: round(timings[Math.ceil(timings.length * 0.95) - 1]!),
      maxMs: round(timings.at(-1)!),
      meanMs: round(timings.reduce((a, b) => a + b, 0) / timings.length),
      responseBytes,
    };
    peakRss = Math.max(peakRss, (await metrics()).memory.rss);
  }
  const workEnd = await metrics();
  const workDuration = performance.now() - workWall;
  const containersDuringWork = await containerSample;
  const report = {
    checkedAt: new Date().toISOString(),
    node: ready.node,
    environment: 'Windows local Docker Desktop, synthetic aio_foundation_test',
    api: {
      process: 'compiled Node process; all A/B/C BFF instances, browser runner excluded',
      startupMs: round(startupMs),
      idle: {
        wallMs: round(idleDuration),
        cpuPercentOfOneCore: cpuPercent(idleStart, idleEnd, idleDuration),
        rssMiB: round(idleEnd.memory.rss / 1024 ** 2),
        heapUsedMiB: round(idleEnd.memory.heapUsed / 1024 ** 2),
      },
      workload: {
        requests: 100,
        concurrency: 1,
        warmupRequests: 15,
        wallMs: round(workDuration),
        cpuPercentOfOneCore: cpuPercent(workStart, workEnd, workDuration),
        sampledPeakRssMiB: round(peakRss / 1024 ** 2),
        heapUsedMiB: round(workEnd.memory.heapUsed / 1024 ** 2),
      },
    },
    endpoints: samples,
    containersIdle: containersIdle.map((row) => ({
      name: row.Name,
      cpu: row.CPUPerc,
      memory: row.MemUsage,
      pids: row.PIDs,
    })),
    containersDuringWork: containersDuringWork.map((row) => ({
      name: row.Name,
      cpu: row.CPUPerc,
      memory: row.MemUsage,
      pids: row.PIDs,
    })),
    limits: [
      'Single local run, not a production SLA or concurrency benchmark',
      'Docker CPU is a point sample; Node CPU is process time divided by wall time',
      'API RSS includes three BFF instances and pg pools, excludes browser process',
      'Warm cache, small synthetic dataset; audit returns at most 100 events',
    ],
  };
  await mkdir('.local/evidence', { recursive: true });
  await writeFile('.local/evidence/measurements.json', JSON.stringify(report, null, 2) + '\n');
  const lines = [
    '# Số đo Foundation local',
    '',
    'Lượt đo: ' +
      report.checkedAt +
      '. Node ' +
      ready.node +
      '. Database aio_foundation_test, dữ liệu giả lập.',
    '',
    'API được chạy bằng JavaScript đã build trong process riêng, gồm ba BFF A/B/C; không tính process Chromium/runner. PID, command line, cổng và health identity được đối chiếu trước/sau đo.',
    '',
    '| Chỉ số API | Giá trị |',
    '| --- | --- |',
    '| Khởi động API (IdP/DB đã chạy) | ' + report.api.startupMs + ' ms |',
    '| RSS khi nghỉ sau warmup | ' + report.api.idle.rssMiB + ' MiB |',
    '| CPU lúc nghỉ / một core | ' + report.api.idle.cpuPercentOfOneCore + '% |',
    '| RSS cao nhất trong các mẫu workload | ' + report.api.workload.sampledPeakRssMiB + ' MiB |',
    '| CPU workload / một core | ' + report.api.workload.cpuPercentOfOneCore + '% |',
    '',
    '100 request tuần tự, concurrency 1, sau 15 warmup request; ' +
      report.api.workload.wallMs +
      ' ms. Access được introspect và quyền được đọc từ DB trên mỗi request.',
    '',
    '| Endpoint | n | p50 ms | p95 ms | max ms | Bytes cuối |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(samples).map(
      ([name, value]) =>
        '| ' +
        name +
        ' | ' +
        value.count +
        ' | ' +
        value.p50Ms +
        ' | ' +
        value.p95Ms +
        ' | ' +
        value.maxMs +
        ' | ' +
        value.responseBytes +
        ' |',
    ),
    '',
    'Docker stats trong lúc workload (snapshot, không phải CPU trung bình toàn lượt):',
    '',
    '| Container | CPU | RAM sử dụng / giới hạn | PIDs |',
    '| --- | --- | --- | --- |',
    ...report.containersDuringWork.map(
      (row) => '| ' + row.name + ' | ' + row.cpu + ' | ' + row.memory + ' | ' + row.pids + ' |',
    ),
    '',
    'Đây là số đo một máy local, warm cache và fixture nhỏ. Không suy ra SLA production, capacity hoặc kết luận “nhẹ” từ lượt đo này. RSS khác heap; giới hạn memory container khác mức RAM thực dùng. Keycloak/PostgreSQL nằm trong Docker Desktop VM, không cộng thẳng các số này để suy ra RAM toàn máy.',
    '',
    'Lệnh tái lập: npm run build rồi npm run measure:local, khi API dev/E2E đã dừng. Báo cáo JSON chi tiết trong .local/evidence/measurements.json. Không chứa token/cookie hoặc response dữ liệu người dùng.',
    '',
  ];
  await writeFile('docs/LOCAL_MEASUREMENTS.md', lines.join('\n'));
  console.log(
    'PASS: measured isolated compiled API process and owned Docker services; report saved without response data or credentials.',
  );
} catch {
  console.error(
    'Local measurement failed at: ' + stage + '. No credentials or response payloads logged.',
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  if (child.connected) {
    if (ownershipVerified) await verifyOwnership(ready);
    child.send({ kind: 'shutdown' });
    await Promise.race([
      exit,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Owned measurement API did not shut down.')), 10000),
      ),
    ]);
  }
}
