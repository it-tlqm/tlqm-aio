import assert from 'node:assert/strict';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export const loadTargets = {
  sessions: 100,
  durationMs: 30 * 60_000,
  read: 500,
  write: 800,
  report: 3000,
  errorRatio: 0.01,
} as const;
export const loadKinds = ['read', 'write', 'report', 'transfer'] as const;
export type LoadKind = (typeof loadKinds)[number];
export type LoadOutcome = { status: number; expected: boolean; bytes: number };
export type LoadAction = {
  name: string;
  kind: LoadKind;
  run(signal: AbortSignal): Promise<LoadOutcome>;
};
export type LoadSession = { id: string; tenant: string; actions: LoadAction[] };

type Series = {
  samples: number[];
  unexpected: number;
  timeouts: number;
  bytes: number;
  statuses: Record<string, number>;
};
const newSeries = (): Series => ({
  samples: [],
  unexpected: 0,
  timeouts: 0,
  bytes: 0,
  statuses: {},
});
const round = (value: number) => Math.round(value * 1000) / 1000;
function summarize(series: Series) {
  const sorted = [...series.samples].sort((a, b) => a - b);
  const at = (rank: number) =>
    sorted.length ? round(sorted[Math.ceil(rank * sorted.length) - 1]!) : null;
  return {
    requests: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: at(1),
    unexpected: series.unexpected,
    timeouts: series.timeouts,
    bytes: series.bytes,
    statuses: series.statuses,
  };
}

export async function runMixedLoad(
  sessions: LoadSession[],
  options: {
    durationMs: number;
    thinkMs: number;
    timeoutMs: number;
    sampleMs?: number;
    sample?: () => Promise<Record<string, number | null>>;
  },
) {
  assert.equal(sessions.length, loadTargets.sessions);
  assert.equal(new Set(sessions.map(({ id }) => id)).size, sessions.length);
  assert.ok(new Set(sessions.map(({ tenant }) => tenant)).size >= 2);
  assert.ok(sessions.every(({ actions }) => actions.length > 0));
  assert.ok(
    Number.isSafeInteger(options.durationMs) &&
      options.durationMs > 0 &&
      options.durationMs <= loadTargets.durationMs,
  );
  assert.ok(Number.isSafeInteger(options.thinkMs) && options.thinkMs > 0);
  assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0);
  const operations = new Map<string, { kind: LoadKind; series: Series }>();
  for (const { actions } of sessions)
    for (const action of actions) {
      assert.match(action.name, /^[a-z][a-z0-9-]{1,47}$/);
      const entry = operations.get(action.name);
      if (entry) assert.equal(entry.kind, action.kind);
      else operations.set(action.name, { kind: action.kind, series: newSeries() });
    }
  const totals = Object.fromEntries(loadKinds.map((kind) => [kind, newSeries()])) as Record<
    LoadKind,
    Series
  >;
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const startedAt = new Date();
  const started = performance.now();
  const end = started + options.durationMs;
  const cpu = process.cpuUsage();
  let inFlight = 0,
    peakInFlight = 0,
    peakRss = process.memoryUsage().rss,
    sampleFailures = 0;
  const samples: { atMs: number; metrics: Record<string, number | null> }[] = [];
  let sampling: Promise<void> | undefined;
  const takeSample = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (!sampling && options.sample) {
      sampling = options
        .sample()
        .then((metrics) => {
          assert.ok(
            Object.values(metrics).every((value) => value === null || Number.isFinite(value)),
          );
          samples.push({ atMs: round(performance.now() - started), metrics });
        })
        .catch(() => {
          sampleFailures++;
        })
        .finally(() => {
          sampling = undefined;
        });
    }
  };
  const timer = setInterval(takeSample, options.sampleMs ?? 1000).unref();
  takeSample();

  const iterations = await Promise.all(
    sessions.map(async ({ actions }, index) => {
      let completed = 0;
      // Spread already-open sessions over one think interval to model independent user arrivals.
      await delay(
        Math.floor((index * Math.min(options.thinkMs, options.durationMs)) / sessions.length),
      );
      while (performance.now() < end) {
        const action = actions[(index + completed) % actions.length]!;
        const signal = AbortSignal.timeout(options.timeoutMs);
        const begin = performance.now();
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        let outcome: LoadOutcome | undefined;
        try {
          outcome = await action.run(signal);
        } catch {
          /* Transport errors enter the denominator. */
        } finally {
          inFlight--;
        }
        const elapsed = performance.now() - begin;
        const status = outcome ? String(outcome.status) : 'transport';
        for (const series of [totals[action.kind], operations.get(action.name)!.series]) {
          series.samples.push(elapsed);
          series.statuses[status] = (series.statuses[status] ?? 0) + 1;
          if (!outcome?.expected) series.unexpected++;
          if (signal.aborted) series.timeouts++;
          series.bytes += outcome?.bytes ?? 0;
        }
        completed++;
        if (performance.now() < end)
          await delay(Math.min(options.thinkMs, Math.max(0, end - performance.now())));
      }
      return completed;
    }),
  ).finally(() => {
    clearInterval(timer);
    eventLoop.disable();
  });
  await sampling;
  const groups = Object.fromEntries(
    loadKinds.map((kind) => [kind, summarize(totals[kind])]),
  ) as Record<LoadKind, ReturnType<typeof summarize>>;
  const requests = Object.values(groups).reduce((sum, value) => sum + value.requests, 0);
  const unexpected = Object.values(groups).reduce((sum, value) => sum + value.unexpected, 0);
  const errorRatio = requests ? unexpected / requests : 1;
  const latency = (['read', 'write', 'report'] as const).every(
    (kind) => groups[kind].p95Ms !== null && groups[kind].p95Ms <= loadTargets[kind],
  );
  const used = process.cpuUsage(cpu);
  return {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: options.durationMs,
    wallMs: round(performance.now() - started),
    configuredSessions: sessions.length,
    activeSessions: iterations.filter(Boolean).length,
    tenants: new Set(sessions.map(({ tenant }) => tenant)).size,
    minRequestsPerSession: Math.min(...iterations),
    peakInFlight,
    requests,
    unexpected,
    errorRatio,
    groups,
    operations: [...operations].map(([name, { kind, series }]) => ({
      name,
      kind,
      ...summarize(series),
    })),
    meetsDuration: options.durationMs === loadTargets.durationMs,
    meetsThresholds: latency && errorRatio < loadTargets.errorRatio && iterations.every(Boolean),
    generator: {
      peakRssBytes: peakRss,
      cpuMs: round((used.user + used.system) / 1000),
      eventLoopP99Ms: round(eventLoop.percentile(99) / 1e6),
    },
    samples,
    sampleFailures,
  };
}
