export const httpServices = [
  'aio-foundation',
  'aio-probe',
  'aio-forms',
  'aio-workflows',
  'aio-tasks',
  'aio-lms-sandbox',
] as const;
export type HttpService = (typeof httpServices)[number];
export type HttpOperation =
  'health' | 'auth' | 'read' | 'write' | 'report' | 'transfer' | 'integration';
export const httpOperations: readonly HttpOperation[] = [
  'health',
  'auth',
  'read',
  'write',
  'report',
  'transfer',
  'integration',
];
export const queueKinds = ['link', 'schedule', 'email', 'intake'] as const;
export type QueueKind = (typeof queueKinds)[number];

export type HttpObservation = {
  kind: 'http';
  at: number;
  service: HttpService;
  operation: HttpOperation;
  status: number;
  durationMs: number;
  requestId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
};
export type QueueObservation = {
  kind: 'queue';
  at: number;
  service: 'aio-workflows';
  queue: QueueKind;
  due: number;
  oldestDueMs: number;
  blocked: number;
};
export type Observation = HttpObservation | QueueObservation;
export type Observe = (observation: Observation) => void;

const traceParent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const traceIdPattern = /^(?!0+$)[0-9a-f]{32}$/;
const spanIdPattern = /^(?!0+$)[0-9a-f]{16}$/;
export const isHttpService = (value: string): value is HttpService =>
  (httpServices as readonly string[]).includes(value);

export function classifyHttp(method: string, path: string): HttpOperation | undefined {
  if (path === '/health/live' || path === '/health/ready') return 'health';
  if (path.startsWith('/auth/')) return 'auth';
  if (path.startsWith('/api/integrations/') || path.startsWith('/api/v1/integrations/'))
    return 'integration';
  if (!path.startsWith('/api/')) return undefined;
  const parts = path.split('/');
  if (
    parts.some((part) => /^(?:export(?:-csv)?|report-export|media|attachments|files)$/.test(part))
  )
    return 'transfer';
  if (
    parts.some((part) =>
      /^(?:reports?|report-learner|performance-report|analytics|summary)$/.test(part),
    )
  )
    return 'report';
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

export class HttpSpan {
  private traceId = crypto.randomUUID().replaceAll('-', '');
  private readonly spanId = this.traceId.slice(0, 16);
  private parentSpanId: string | null = null;
  private readonly start = performance.now();

  // Callers adopt an inbound parent only after verifying the service proof.
  acceptParent(value: unknown) {
    if (typeof value !== 'string' || this.parentSpanId !== null) return;
    const parsed = traceParent.exec(value);
    if (!parsed || !traceIdPattern.test(parsed[1]!) || !spanIdPattern.test(parsed[2]!)) return;
    this.traceId = parsed[1]!;
    this.parentSpanId = parsed[2]!;
  }

  header() {
    return '00-' + this.traceId + '-' + this.spanId + '-01';
  }

  finish(
    service: HttpService,
    operation: HttpOperation,
    requestId: string,
    status: number,
  ): HttpObservation {
    return {
      kind: 'http',
      at: Date.now(),
      service,
      operation,
      status,
      durationMs: Math.round((performance.now() - this.start) * 1000) / 1000,
      requestId,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
    };
  }
}

const nonnegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

// Reconstruct from an allowlist. Unknown fields and transport bodies never reach the collector.
export function parseObservation(input: unknown): Observation | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  const { at, service } = value;
  if (!nonnegative(at) || typeof service !== 'string' || !isHttpService(service)) return;
  if (value.kind === 'queue' && service === 'aio-workflows') {
    const { queue, due, oldestDueMs, blocked } = value;
    if (
      !(queueKinds as readonly unknown[]).includes(queue) ||
      !nonnegative(due) ||
      !nonnegative(oldestDueMs) ||
      !nonnegative(blocked)
    )
      return;
    return { kind: 'queue', at, service, queue: queue as QueueKind, due, oldestDueMs, blocked };
  }
  if (value.kind !== 'http') return;
  const { operation, status, durationMs, requestId: id, traceId, spanId, parentSpanId } = value;
  if (
    !(httpOperations as readonly unknown[]).includes(operation) ||
    !nonnegative(status) ||
    status < 100 ||
    status > 599 ||
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    typeof id !== 'string' ||
    !requestId.test(id) ||
    typeof traceId !== 'string' ||
    !traceIdPattern.test(traceId) ||
    typeof spanId !== 'string' ||
    !spanIdPattern.test(spanId) ||
    (parentSpanId !== null &&
      (typeof parentSpanId !== 'string' || !spanIdPattern.test(parentSpanId)))
  )
    return;
  return {
    kind: 'http',
    at,
    service,
    operation: operation as HttpOperation,
    status,
    durationMs,
    requestId: id,
    traceId,
    spanId,
    parentSpanId,
  };
}
