import type { Learners, LearnerAction, LearnerChange } from './learners.js';
import { LmsError } from './security.js';
export async function learnerRoute(
  learners: Learners,
  request: Request,
  body: string,
  headers: Headers,
) {
  const url = new URL(request.url),
    path = url.pathname;
  let result: unknown;
  if (request.method === 'GET' && path === '/api/lms/learners') {
    if ([...url.searchParams.keys()].some((key) => key !== 'cursor'))
      throw new LmsError(400, 'INVALID_REQUEST');
    result = await learners.mappings(url.searchParams.get('cursor') ?? undefined);
  } else if (request.method === 'GET' && path === '/api/lms/learner-candidates') {
    if (
      [...url.searchParams.keys()].some((key) => !['cursor', 'search', 'orgUnitId'].includes(key))
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    result = await learners.discover(Object.fromEntries(url.searchParams));
  } else if (request.method === 'POST' && path === '/api/lms/learner-commands') {
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw new LmsError(415, 'UNSUPPORTED_MEDIA_TYPE');
    let command: { action: LearnerAction; data: LearnerChange; reason: string };
    try {
      command = JSON.parse(body) as typeof command;
    } catch {
      throw new LmsError(400, 'INVALID_REQUEST');
    }
    if (
      !command ||
      typeof command !== 'object' ||
      Array.isArray(command) ||
      Object.keys(command).some((key) => !['action', 'data', 'reason'].includes(key))
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    result = await learners.change(command.action, command.data, {
      key: request.headers.get('idempotency-key') ?? '',
      reason: command.reason,
    });
  } else throw new LmsError(404, 'NOT_FOUND');
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(result), { headers });
}
