import type { TrainingNotices as Training } from './training-notices.js';
import type { CourseCommand } from './courses.js';
import { LmsError } from './security.js';
export async function trainingRoute(service: Training, request: Request, bodyText: string) {
  const url = new URL(request.url),
    path = url.pathname;
  if (request.method === 'GET') {
    if (path === '/api/lms/training-intakes') {
      if (url.search) throw new LmsError(400, 'INVALID_REQUEST');
      return service.intakeDrafts();
    }
    if (path === '/api/lms/training-work' || path === '/api/lms/training-reminder-policies') {
      if ([...url.searchParams.keys()].length) throw new LmsError(400, 'INVALID_REQUEST');
      return path === '/api/lms/training-work' ? service.work() : service.policies();
    }
    if (
      [...url.searchParams.keys()].some((k) => !['cursor', 'manage', 'id', 'unitId'].includes(k)) ||
      (url.searchParams.has('manage') &&
        !['true', 'false'].includes(url.searchParams.get('manage')!))
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    if (path === '/api/lms/training-paths')
      return service.paths(url.searchParams.get('cursor') ?? undefined);
    if (path === '/api/lms/training-candidates')
      return service.candidates(url.searchParams.get('unitId') ?? undefined);
    if (path === '/api/lms/training-batches')
      return service.batches(
        url.searchParams.get('manage') === 'true',
        url.searchParams.get('cursor') ?? undefined,
      );
    if (path === '/api/lms/training-batch')
      return service.batch(
        url.searchParams.get('id') ?? '',
        url.searchParams.get('manage') === 'true',
      );
    throw new LmsError(404, 'NOT_FOUND');
  }
  if (request.method !== 'POST' || path !== '/api/lms/training-commands')
    throw new LmsError(404, 'NOT_FOUND');
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new LmsError(415, 'UNSUPPORTED_MEDIA_TYPE');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as typeof body;
  } catch {
    throw new LmsError(400, 'INVALID_REQUEST');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !['action', 'data', 'reason'].includes(k)) ||
    typeof body.reason !== 'string' ||
    typeof body.action !== 'string' ||
    !body.data ||
    typeof body.data !== 'object' ||
    Array.isArray(body.data)
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  const data = body.data as Record<string, unknown>,
    command: CourseCommand = {
      key: request.headers.get('idempotency-key') ?? '',
      reason: body.reason,
    };
  const fields: Record<string, string[]> = {
    'save-path': ['id', 'expectedRevision', 'spec'],
    'publish-path': ['id', 'expectedRevision'],
    'create-batch': [
      'pathVersionId',
      'ownerUnitId',
      'title',
      'startsAt',
      'dueAt',
      'accountIds',
      'workflowIntakeId',
    ],
    'update-batch': ['id', 'expectedRevision', 'title', 'startsAt', 'dueAt', 'status'],
    'mark-notice': ['id', 'read', 'expectedRevision'],
    'save-reminder-policy': [
      'unitId',
      'enabled',
      'beforeMinutes',
      'overdueMinutes',
      'expectedRevision',
    ],
  };
  if (
    !Object.hasOwn(fields, body.action) ||
    Object.keys(data).some((k) => !fields[body.action as string]!.includes(k))
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  switch (body.action) {
    case 'mark-notice':
      return service.mark(
        data.id as string,
        data.read as boolean,
        data.expectedRevision as number,
        command,
      );
    case 'save-reminder-policy':
      return service.savePolicy(data as Parameters<Training['savePolicy']>[0], command);
    case 'save-path':
      return service.savePath(data as Parameters<Training['savePath']>[0], command);
    case 'publish-path':
      return service.publishPath(data.id as string, data.expectedRevision as number, command);
    case 'create-batch':
      return service.createBatch(data as Parameters<Training['createBatch']>[0], command);
    case 'update-batch':
      return service.updateBatch(data as Parameters<Training['updateBatch']>[0], command);
    default:
      throw new LmsError(404, 'NOT_FOUND');
  }
}
