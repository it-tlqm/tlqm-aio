import type { Reports } from './reports.js';
import type { ReportFilters } from './report-contracts.js';
import { reportWorkbook } from './report-export.js';
import { LmsError } from './security.js';
export async function reportRoute(
  reports: Reports,
  request: Request,
  bodyText: string,
  headers: Headers,
) {
  const url = new URL(request.url),
    path = url.pathname;
  const json = (data: unknown) => {
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), { headers });
  };
  if (request.method === 'GET') {
    if (
      [...url.searchParams.keys()].some(
        (key) =>
          ![
            'orgUnitId',
            'courseId',
            'search',
            'status',
            'mandatoryOnly',
            'page',
            'employeeId',
          ].includes(key),
      )
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    if (
      url.searchParams.has('mandatoryOnly') &&
      !['true', 'false'].includes(url.searchParams.get('mandatoryOnly')!)
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    const filters: ReportFilters = {};
    for (const key of ['orgUnitId', 'courseId', 'search', 'status'] as const)
      if (url.searchParams.has(key))
        (filters as Record<string, unknown>)[key] = url.searchParams.get(key);
    if (url.searchParams.has('mandatoryOnly'))
      filters.mandatoryOnly = url.searchParams.get('mandatoryOnly') === 'true';
    if (url.searchParams.has('page')) filters.page = Number(url.searchParams.get('page'));
    if (path === '/api/lms/report') return json(await reports.gradebook(filters));
    if (path === '/api/lms/report-learner')
      return json(await reports.learnerDetail(url.searchParams.get('employeeId') ?? '', filters));
    throw new LmsError(404, 'NOT_FOUND');
  }
  if (request.method !== 'POST' || path !== '/api/lms/report-export')
    throw new LmsError(404, 'NOT_FOUND');
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new LmsError(415, 'UNSUPPORTED_MEDIA_TYPE');
  let body: { filters: ReportFilters; reason: string };
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new LmsError(400, 'INVALID_REQUEST');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !['filters', 'reason'].includes(key)) ||
    typeof body.reason !== 'string' ||
    !body.filters
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  const result = await reports.exportReport(body.filters, {
    reason: body.reason,
    key: request.headers.get('idempotency-key') ?? '',
  });
  headers.set('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  headers.set('content-disposition', 'attachment; filename="TLQM-bao-cao-dao-tao.xlsx"');
  return new Response(reportWorkbook(result.data, result.issuedAt), { headers });
}
