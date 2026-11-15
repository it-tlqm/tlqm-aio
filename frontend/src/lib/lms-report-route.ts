import type { ReportFilters } from '../../../src/lms/report-contracts.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = ['all', 'completed', 'pending', 'not-started', 'not-required'] as const;
const allowedKeys = new Set(['orgUnitId', 'courseId', 'search', 'status', 'mandatoryOnly', 'page']);

export type LmsReportRoute = {
  filters: ReportFilters;
  search: string;
};

function pageValue(value: string | null) {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= 9999 ? page : 1;
}

export function parseLmsReportRoute(hash: string): LmsReportRoute | null {
  if (hash !== '#lms-report' && !hash.startsWith('#lms-report?')) return null;
  const query = new URLSearchParams(hash.startsWith('#lms-report?') ? hash.slice(12) : '');
  for (const key of query.keys()) if (!allowedKeys.has(key)) return null;
  const orgUnitId = query.get('orgUnitId');
  const courseId = query.get('courseId');
  const statusValue = query.get('status') ?? 'all';
  const mandatoryOnly = query.get('mandatoryOnly');
  if ((orgUnitId && !uuid.test(orgUnitId)) || (courseId && !uuid.test(courseId))) return null;
  if (!(statuses as readonly string[]).includes(statusValue)) return null;
  if (mandatoryOnly !== null && mandatoryOnly !== '1') return null;
  const search = (query.get('search') ?? '').trim();
  if (search.length > 160) return null;
  return {
    search,
    filters: {
      ...(orgUnitId ? { orgUnitId } : {}),
      ...(courseId ? { courseId } : {}),
      ...(search ? { search } : {}),
      status: statusValue as NonNullable<ReportFilters['status']>,
      ...(mandatoryOnly === '1' ? { mandatoryOnly: true } : {}),
      page: pageValue(query.get('page')),
    },
  };
}

export function lmsReportHash(route: LmsReportRoute) {
  const query = new URLSearchParams();
  const filters = route.filters;
  if (filters.orgUnitId) query.set('orgUnitId', filters.orgUnitId);
  if (filters.courseId) query.set('courseId', filters.courseId);
  if (route.search.trim()) query.set('search', route.search.trim().slice(0, 160));
  if (filters.status && filters.status !== 'all') query.set('status', filters.status);
  if (filters.mandatoryOnly) query.set('mandatoryOnly', '1');
  if (filters.page && filters.page > 1) query.set('page', String(Math.min(filters.page, 9999)));
  const serialized = query.toString();
  return serialized ? '#lms-report?' + serialized : '#lms-report';
}

export function isLmsReportRoute(hash: string) {
  return parseLmsReportRoute(hash) !== null;
}
