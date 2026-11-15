import { LmsError } from './security.js';
import type { QuestionBank } from './question-bank.js';
import type { CourseCommand } from './courses.js';
import { questionTemplate, exportQuestionWorkbook } from './question-spreadsheet.js';
import type { UploadScan } from '../upload-scan.js';
export async function questionRoute(
  bank: QuestionBank,
  request: Request,
  bodyText: string,
  headers: Headers,
  scan?: UploadScan,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  const json = (body: unknown) => {
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body), { headers });
  };
  const command: CourseCommand = {
    key: request.headers.get('idempotency-key') ?? '',
    reason: 'Quản lý câu hỏi đào tạo từ bảng tính và ngân hàng',
  };
  const kind = url.searchParams.get('kind');
  const binary = (bytes: Uint8Array, kind: string) => {
    headers.set(
      'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    headers.set('content-disposition', 'attachment; filename="TLQM-' + kind + '.xlsx"');
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers });
  };
  if (request.method === 'GET' && path === '/api/lms/question-bank')
    return json(
      await bank.listBank({
        search: url.searchParams.get('search') ?? undefined,
        kind: url.searchParams.get('kind') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
      }),
    );
  if (path === '/api/lms/question-template' && request.method === 'GET') {
    await bank.mediaUploadActor();
    if (kind !== 'quiz' && kind !== 'checkpoint') throw new LmsError(400, 'INVALID_REQUEST');
    return binary(questionTemplate(kind), kind + '-mau');
  }
  if (path === '/api/lms/question-imports/preview' && request.method === 'POST') {
    if (kind !== 'quiz' && kind !== 'checkpoint') throw new LmsError(400, 'INVALID_REQUEST');
    return json(await bank.preview(request, kind, command, scan));
  }
  if (request.method !== 'POST') throw new LmsError(404, 'NOT_FOUND');
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new LmsError(415, 'UNSUPPORTED_MEDIA_TYPE');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(bodyText);
  } catch {
    throw new LmsError(400, 'INVALID_REQUEST');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['action', 'data', 'reason'].includes(key)) ||
    !value.data ||
    typeof value.data !== 'object' ||
    Array.isArray(value.data) ||
    typeof value.reason !== 'string'
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  command.reason = value.reason;
  const data = value.data as Record<string, unknown>;
  if (path === '/api/lms/question-export') {
    if (
      value.action !== 'export-questions' ||
      Object.keys(data).some((key) => !['source', 'kind', 'courseId', 'items'].includes(key))
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    const result = await bank.exportQuestions(
      data as Parameters<QuestionBank['exportQuestions']>[0],
      command,
    );
    return binary(exportQuestionWorkbook(result.entries, result.kind), result.kind);
  }
  if (path !== '/api/lms/question-commands') throw new LmsError(404, 'NOT_FOUND');
  const fields: Record<string, string[]> = {
    'save-question': ['id', 'expectedRevision', 'category', 'entry', 'status'],
    'apply-import': [
      'previewId',
      'destination',
      'category',
      'courseId',
      'expectedRevision',
      'mode',
    ],
    'attach-questions': ['courseId', 'expectedRevision', 'kind', 'mode', 'items'],
  };
  if (
    typeof value.action !== 'string' ||
    !Object.hasOwn(fields, value.action) ||
    Object.keys(data).some((key) => !fields[value.action as string]!.includes(key))
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  if (value.action === 'save-question')
    return json(
      await bank.saveQuestion(data as Parameters<QuestionBank['saveQuestion']>[0], command),
    );
  if (value.action === 'apply-import')
    return json(
      await bank.applyImport(data as Parameters<QuestionBank['applyImport']>[0], command),
    );
  return json(await bank.attach(data as Parameters<QuestionBank['attach']>[0], command));
}
