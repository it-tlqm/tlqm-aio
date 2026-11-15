import type { Courses, CourseCommand } from './courses.js';
import { LmsError } from './security.js';

/** Fixed route dispatch; course/question data is interpreted, never compiled as a validator. */
export async function courseRoute(courses: Courses, request: Request, bodyText: string) {
  const url = new URL(request.url),
    path = url.pathname;
  if (request.method === 'GET') {
    if (path === '/api/lms/lookups') return courses.lookups();
    if (path === '/api/lms/courses')
      return courses.list(false, url.searchParams.get('cursor') ?? undefined);
    if (path === '/api/lms/manage/courses')
      return courses.list(true, url.searchParams.get('cursor') ?? undefined);
    if (path === '/api/lms/course') return courses.detail(url.searchParams.get('versionId') ?? '');
    if (path === '/api/lms/history')
      return courses.history(url.searchParams.get('cursor') ?? undefined);
    if (path === '/api/lms/attempt') return courses.attempt(url.searchParams.get('id') ?? '');
    throw new LmsError(404, 'NOT_FOUND');
  }
  if (request.method !== 'POST' || path !== '/api/lms/commands')
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
    Object.keys(body).some((key) => !['action', 'data', 'reason'].includes(key)) ||
    typeof body.reason !== 'string' ||
    typeof body.action !== 'string' ||
    !body.data ||
    typeof body.data !== 'object' ||
    Array.isArray(body.data)
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  const data = body.data as Record<string, unknown>;
  const command: CourseCommand = {
    key: request.headers.get('idempotency-key') ?? '',
    reason: body.reason,
  };
  const fields: Record<string, string[]> = {
    'save-course': ['courseId', 'code', 'ownerUnitId', 'expectedRevision', 'spec'],
    'publish-course': ['courseId', 'expectedRevision'],
    'course-status': ['courseId', 'expectedRevision', 'status'],
    progress: ['versionId', 'expectedRevision', 'position', 'acknowledged'],
    checkpoint: ['versionId', 'expectedRevision', 'questionId', 'answer'],
    submit: ['versionId', 'answers', 'tabSwitchCount'],
    'create-note': ['versionId', 'time', 'content'],
    'delete-note': ['noteId'],
    'issue-certificate': ['attemptId'],
  };
  const accepted = Object.hasOwn(fields, body.action) ? fields[body.action] : undefined;
  if (!accepted || Object.keys(data).some((key) => !accepted.includes(key)))
    throw new LmsError(400, 'INVALID_REQUEST');
  switch (body.action) {
    case 'issue-certificate':
      return courses.issueCertificate(data.attemptId as string, command);
    case 'save-course':
      return courses.save(data as Parameters<Courses['save']>[0], command);
    case 'publish-course':
      return courses.publish(data.courseId as string, data.expectedRevision as number, command);
    case 'course-status':
      return courses.setStatus(
        data.courseId as string,
        data.expectedRevision as number,
        data.status as 'active' | 'archived',
        command,
      );
    case 'progress':
      return courses.saveProgress(data as Parameters<Courses['saveProgress']>[0], command);
    case 'checkpoint':
      return courses.checkpoint(data as Parameters<Courses['checkpoint']>[0], command);
    case 'submit':
      return courses.submit(data as Parameters<Courses['submit']>[0], command);
    case 'create-note':
      return courses.addNote(data as Parameters<Courses['addNote']>[0], command);
    case 'delete-note':
      return courses.deleteNote(data.noteId as string, command);
    default:
      throw new LmsError(404, 'NOT_FOUND');
  }
}
