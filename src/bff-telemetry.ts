import type { FastifyInstance, FastifyRequest } from 'fastify';
import { classifyHttp, HttpSpan } from './telemetry.js';
import type { HttpService, Observe } from './telemetry.js';

const spans = new WeakMap<FastifyRequest, HttpSpan>();
export const bffSpan = (request: FastifyRequest) => spans.get(request);

export function registerBffTelemetry(app: FastifyInstance, service: HttpService, observe: Observe) {
  app.addHook('onRequest', (request, _reply, done) => {
    if (classifyHttp(request.method, request.url.split('?', 1)[0] ?? ''))
      spans.set(request, new HttpSpan());
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const span = bffSpan(request);
    // Fastify provides a registered route template. Do not export raw paths or parameters.
    const operation = classifyHttp(request.method, request.routeOptions.url ?? '');
    if (span && operation) {
      try {
        observe(span.finish(service, operation, request.id, reply.statusCode));
      } catch {
        app.log.warn({ code: 'TELEMETRY_DELIVERY_FAILED' }, 'HTTP observation dropped');
      }
    }
    done();
  });
}
