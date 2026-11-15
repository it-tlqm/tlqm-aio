import assert from 'node:assert/strict';
import { get } from 'node:https';
import type { BrowserContext } from '@playwright/test';
import { stagingAppOrigin, stagingTarget } from '../src/staging-endpoints.js';

type Budget = { status: number; remaining: number; reset: number };
async function reserve(probe: () => Promise<Budget>, minimum: number) {
  const ready = await probe();
  if (ready.status === 200 && ready.remaining >= minimum) return;
  assert([200, 429].includes(ready.status));
  const seconds = ready.reset;
  assert(Number.isFinite(seconds) && seconds >= 0 && seconds <= 60);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 100));
  const fresh = await probe();
  assert.equal(fresh.status, 200);
  assert(fresh.remaining >= minimum);
}

export async function reserveTestRequests(context: BrowserContext, origin: string, minimum = 70) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:410[0-6]$/);
  await reserve(async () => {
    const response = await context.request.get(origin + '/health/ready');
    try {
      const headers = response.headers();
      return {
        status: response.status(),
        remaining: Number(headers['x-ratelimit-remaining']),
        reset: Number(headers['retry-after'] ?? headers['x-ratelimit-reset']),
      };
    } finally {
      await response.dispose();
    }
  }, minimum);
}

export async function reserveStagingRequests(origin: string, ca: string, minimum: number) {
  assert.ok(
    (['a', 'b'] as const).some((slot) => {
      const target = stagingTarget(slot);
      return (['foundation', 'probe', 'forms', 'workflows', 'tasks'] as const).some((client) =>
        [false, true].some(
          (namedHosts) =>
            origin === stagingAppOrigin(slot, 'aio-' + client, target[client], namedHosts),
        ),
      );
    }),
    'Expected an isolated staging BFF origin.',
  );
  await reserve(
    () =>
      new Promise((resolve, reject) => {
        get(
          origin + '/health/live',
          { ca, rejectUnauthorized: true, signal: AbortSignal.timeout(5000) },
          (response) => {
            response.resume();
            resolve({
              status: response.statusCode ?? 0,
              remaining: Number(response.headers['x-ratelimit-remaining']),
              reset: Number(
                response.headers['retry-after'] ?? response.headers['x-ratelimit-reset'],
              ),
            });
          },
        ).on('error', reject);
      }),
    minimum,
  );
}
