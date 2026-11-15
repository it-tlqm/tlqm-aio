import { constants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { parseObservation, queueKinds } from '../src/telemetry.js';
import type {
  HttpObservation,
  HttpOperation,
  HttpService,
  Observation,
  QueueObservation,
} from '../src/telemetry.js';

const prefix = 'AIO_TELEMETRY ';
const limits: Partial<Record<HttpOperation, number>> = { read: 500, write: 800, report: 3000 };
const bucketBounds = [
  10,
  25,
  50,
  100,
  200,
  300,
  400,
  500,
  600,
  700,
  800,
  1000,
  1500,
  2000,
  2500,
  3000,
  5000,
  10000,
  30000,
  Infinity,
];
const queueAgeLimitMs = 120000;
const slo = {
  target: 0.999,
  shortMs: 5 * 60000,
  longMs: 60 * 60000,
  burnRate: 14.4,
  minimumRequestsPerWindow: 100,
};

function percentile(buckets: number[], count: number, fraction: number) {
  const rank = Math.ceil(count * fraction);
  let seen = 0;
  for (const [index, observations] of buckets.entries()) {
    seen += observations;
    if (seen >= rank) return Number.isFinite(bucketBounds[index]) ? bucketBounds[index]! : null;
  }
  return null;
}

function alert(name: string, service: HttpService, detail: object) {
  return { name, service, ...detail };
}

type Series = {
  service: HttpService;
  operation: HttpOperation;
  requests: number;
  errors: number;
  denied: number;
  rateLimited: number;
  maxMs: number;
  buckets: number[];
};
type Minute = { minute: number; valid: number; errors: number };

export async function createStagingTelemetry(path: string, now = Date.now) {
  const parent = await lstat(dirname(path));
  // The caller supplies a unique file under its verified staging or drill directory.
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error('Invalid telemetry directory.');
  const log = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const writer = log.createWriteStream();
  let failed = false;
  let dropped = 0;
  let closed = false;
  writer.on('error', () => {
    failed = true;
  });
  const series = new Map<string, Series>();
  const minutes = new Map<HttpService, Map<number, Minute>>();
  const queue = new Map<string, QueueObservation>();
  const traces = new Map<string, HttpObservation[]>();
  const completeTraces: { traceId: string; spans: HttpObservation[] }[] = [];

  function observe(input: Observation) {
    const event = parseObservation(input);
    if (!event || closed) return;
    if (failed || writer.writableNeedDrain) dropped++;
    else writer.write(JSON.stringify(event) + '\n');
    if (event.kind === 'queue') {
      const prior = queue.get(event.queue);
      if (!prior || event.at >= prior.at) queue.set(event.queue, event);
      return;
    }
    const key = event.service + '/' + event.operation;
    let row = series.get(key);
    if (!row) {
      row = {
        service: event.service,
        operation: event.operation,
        requests: 0,
        errors: 0,
        denied: 0,
        rateLimited: 0,
        maxMs: 0,
        buckets: bucketBounds.map(() => 0),
      };
      series.set(key, row);
    }
    row.requests++;
    if (event.status >= 500) row.errors++;
    if (event.status === 401 || event.status === 403) row.denied++;
    if (event.status === 429) row.rateLimited++;
    row.maxMs = Math.max(row.maxMs, event.durationMs);
    const bucket = bucketBounds.findIndex((bound) => event.durationMs <= bound);
    row.buckets[bucket] = (row.buckets[bucket] ?? 0) + 1;

    if (
      event.operation in limits &&
      (event.status < 400 || event.status === 429 || event.status >= 500)
    ) {
      let service = minutes.get(event.service);
      if (!service) minutes.set(event.service, (service = new Map()));
      const minute = Math.floor(event.at / 60000);
      const current = Math.floor(now() / 60000);
      if (minute >= current - 60 && minute <= current) {
        let sample = service.get(minute);
        if (!sample) service.set(minute, (sample = { minute, valid: 0, errors: 0 }));
        sample.valid++;
        if (event.status >= 500 || event.status === 429) sample.errors++;
      }
      for (const time of service.keys()) if (time < current - 60) service.delete(time);
    }

    if (
      event.operation !== 'integration' &&
      !(event.service === 'aio-foundation' && event.operation === 'read')
    )
      return;
    let events = traces.get(event.traceId);
    if (!events) {
      if (traces.size >= 2048) traces.delete(traces.keys().next().value!);
      traces.set(event.traceId, (events = []));
    }
    if (events.length >= 16 || events.some((sample) => sample.spanId === event.spanId)) return;
    events.push(event);
    const portal = events.find(
      (sample) =>
        sample.service === 'aio-foundation' &&
        sample.operation === 'read' &&
        sample.status === 200 &&
        sample.parentSpanId === null,
    );
    const worker =
      portal &&
      events.find(
        (sample) =>
          sample.service === 'aio-lms-sandbox' &&
          sample.operation === 'integration' &&
          sample.status === 200 &&
          sample.parentSpanId === portal.spanId,
      );
    if (
      portal &&
      worker &&
      events.some(
        (sample) =>
          sample.service === 'aio-foundation' &&
          sample.operation === 'integration' &&
          sample.status === 200 &&
          sample.parentSpanId === worker.spanId,
      )
    ) {
      if (completeTraces.length < 8)
        completeTraces.push({ traceId: event.traceId, spans: [...events] });
      traces.delete(event.traceId);
    }
  }

  function attach(stream: Readable) {
    let pending = '';
    let overlong = false;
    const read = (chunk: Buffer | string) => {
      const lines = chunk.toString().split('\n');
      for (const [index, line] of lines.entries()) {
        if (!overlong) {
          if (pending.length + line.length <= 1024) pending += line;
          else overlong = true;
        }
        if (index === lines.length - 1) break;
        if (!overlong) {
          const start = pending.indexOf(prefix);
          // Supports plain stdout and Docker's optional timestamp prefix.
          if (
            start === 0 ||
            (start > 0 && /^\d{4}-\d\d-\d\dT[0-9:.]+Z $/.test(pending.slice(0, start)))
          ) {
            try {
              const event = parseObservation(JSON.parse(pending.slice(start + prefix.length)));
              if (event) observe(event);
            } catch {
              /* Ignore malformed or unrelated process output. */
            }
          }
        }
        pending = '';
        overlong = false;
      }
    };
    stream.on('data', read);
    return () => stream.off('data', read);
  }

  return {
    observe,
    attach,
    report() {
      const at = now();
      const currentMinute = Math.floor(at / 60000);
      const alarms = [];
      for (const [service, samples] of minutes) {
        const window = (duration: number) => {
          const start = currentMinute - duration / 60000 + 1;
          let valid = 0,
            errors = 0;
          for (const sample of samples.values())
            if (sample.minute >= start) {
              valid += sample.valid;
              errors += sample.errors;
            }
          return { valid, errors, burnRate: valid ? errors / valid / (1 - slo.target) : null };
        };
        const short = window(slo.shortMs),
          long = window(slo.longMs);
        if (
          [short, long].every(
            ({ valid, burnRate }) =>
              valid >= slo.minimumRequestsPerWindow &&
              burnRate !== null &&
              burnRate >= slo.burnRate,
          )
        )
          alarms.push(alert('availability-budget-burn', service, { short, long }));
      }
      for (const kind of queueKinds) {
        const sample = queue.get(kind);
        if (!sample) continue;
        if (at - sample.at > 90000)
          alarms.push(alert('queue-sample-stale', sample.service, { queue: kind }));
        else if (sample.oldestDueMs >= queueAgeLimitMs || sample.blocked > 0)
          alarms.push(
            alert('queue-needs-attention', sample.service, {
              queue: kind,
              due: sample.due,
              oldestDueMs: sample.oldestDueMs,
              blocked: sample.blocked,
            }),
          );
      }
      if (failed || dropped) alarms.push({ name: 'telemetry-delivery-loss', dropped, failed });
      const http = [...series.values()].map(({ buckets, ...row }) => ({
        ...row,
        p95UpperMs: percentile(buckets, row.requests, 0.95),
        p99UpperMs: percentile(buckets, row.requests, 0.99),
        targetMs: limits[row.operation] ?? null,
      }));
      return {
        at: new Date(at).toISOString(),
        slo,
        http,
        queues: [...queue.values()],
        alerts: alarms,
        completeTraces: [...completeTraces],
        log: { dropped, failed },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!writer.closed)
        await new Promise<void>((resolve) => {
          writer.once('close', resolve);
          writer.end();
        });
    },
  };
}

type Report = ReturnType<Awaited<ReturnType<typeof createStagingTelemetry>>['report']>;

export async function writeTelemetryDashboard(path: string, report: Report) {
  const escape = (value: unknown) =>
    String(value ?? '—').replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character]!,
    );
  const table = (columns: string[], rows: unknown[][]) =>
    '<table><thead><tr>' +
    columns.map((name) => '<th scope="col">' + escape(name) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows
      .map((row) => '<tr>' + row.map((cell) => '<td>' + escape(cell) + '</td>').join('') + '</tr>')
      .join('') +
    '</tbody></table>';
  const http = report.http.map((row) => [
    row.service,
    row.operation,
    row.requests,
    row.errors,
    row.denied,
    row.rateLimited,
    row.p95UpperMs,
    row.p99UpperMs,
    row.targetMs,
    row.maxMs,
  ]);
  const queues = report.queues.map((row) => [row.queue, row.due, row.blocked, row.oldestDueMs]);
  const vietnam = new Date(report.at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  await writeFile(
    path,
    `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TLQM AIO · Telemetry staging</title>
    <style>body{font:16px/1.5 "Be Vietnam Pro",system-ui,sans-serif;margin:2rem auto;padding:0 1rem;max-width:76rem;color:#223873;background:#fff}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #cdd6e2;text-align:left;padding:.6rem;white-space:nowrap}th{background:#eef2f8}section{overflow:auto;margin:1.5rem 0}h2{font-size:1.2rem}.alarms{color:#8a3200}</style>
    <main><h1>TLQM AIO · Telemetry staging</h1><p>${escape(vietnam)} (UTC+7)</p>
    <section><h2>Cảnh báo đang mở</h2><ul class="alarms">${report.alerts.map((entry) => '<li>' + escape(JSON.stringify(entry)) + '</li>').join('') || '<li>Không có cảnh báo.</li>'}</ul></section>
    <section><h2>HTTP</h2>${table(['Dịch vụ', 'Nhóm', 'Yêu cầu', '5xx', '401/403', '429', 'p95 ≤ ms', 'p99 ≤ ms', 'Mục tiêu ms', 'Max ms'], http)}</section>
    <section><h2>Hàng đợi Quy trình</h2>${table(['Hàng đợi', 'Đến hạn', 'Bị chặn', 'Tuổi job đến hạn cũ nhất (ms)'], queues)}</section>
    <p>Trace Portal–LMS–Foundation đã lưu: ${report.completeTraces.length}. Mẫu log bị rơi: ${report.log.dropped}.</p></main></html>`,
    { flag: 'wx', mode: 0o600 },
  );
}

export async function openTelemetryAlerts(
  path: string,
  collector: Pick<Awaited<ReturnType<typeof createStagingTelemetry>>, 'report'>,
) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let active = new Map<string, Report['alerts'][number]>();
  let pending: Promise<void> | undefined;
  let failure: unknown;
  let closed = false;
  const update = async () => {
    const { at, alerts } = collector.report();
    const next = new Map(
      alerts.map((event) => [
        JSON.stringify([
          event.name,
          'service' in event ? event.service : null,
          'queue' in event ? event.queue : null,
        ]),
        event,
      ]),
    );
    const records = [];
    for (const [key, event] of next)
      if (!active.has(key)) records.push({ at, state: 'firing', ...event });
    for (const [key, event] of active)
      if (!next.has(key)) records.push({ at, state: 'resolved', ...event });
    if (records.length)
      await file.writeFile(records.map((entry) => JSON.stringify(entry) + '\n').join(''));
    active = next;
  };
  const tick = () => {
    if (closed || failure) return Promise.resolve();
    return (pending ??= update()
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        pending = undefined;
      }));
  };
  const timer = setInterval(() => void tick(), 5000).unref();
  return {
    tick,
    async close() {
      if (closed) return;
      clearInterval(timer);
      await tick();
      closed = true;
      await file.close();
      if (failure) throw new Error('Could not write staging alert transitions.');
    },
  };
}
