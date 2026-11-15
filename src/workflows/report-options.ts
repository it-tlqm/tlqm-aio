export const reportDatasets = ['runs', 'attempts', 'decisions'] as const;
export const reportGroups = ['version', 'unit', 'step', 'status', 'person', 'field'] as const;
export const reportMeasures = [
  'rows',
  'runs',
  'attempts',
  'people',
  'averageSeconds',
  'late',
  'lateRate',
  'openOverdue',
  'fieldValue',
] as const;
export const reportHistory = ['effective', 'all', 'superseded'] as const;
export const fieldAggregates = ['sum', 'average', 'min', 'max'] as const;
export type ReportDataset = (typeof reportDatasets)[number];
export type ReportGroup = (typeof reportGroups)[number];
export type ReportMeasure = (typeof reportMeasures)[number];
export type ReportHistory = (typeof reportHistory)[number];
export type FieldAggregate = (typeof fieldAggregates)[number];
export const reportOptions = {
  runs: {
    groups: ['version', 'unit', 'status', 'field'],
    measures: ['rows', 'averageSeconds'],
    states: ['running', 'needs_revision', 'completed', 'rejected', 'cancelled'],
  },
  attempts: {
    groups: ['step', 'version', 'unit', 'status', 'field'],
    measures: ['rows', 'runs', 'averageSeconds', 'late', 'lateRate', 'openOverdue'],
    states: ['pending', 'completed', 'rejected', 'returned', 'cancelled'],
  },
  decisions: {
    groups: ['person', 'step', 'version', 'unit', 'status', 'field'],
    measures: ['rows', 'runs', 'attempts', 'people', 'averageSeconds', 'late', 'lateRate'],
    states: ['approve', 'complete', 'reject', 'return'],
  },
} as const satisfies Record<
  ReportDataset,
  {
    groups: readonly ReportGroup[];
    measures: readonly ReportMeasure[];
    states: readonly string[];
  }
>;

export type PerformanceReportQuery = {
  dataset: ReportDataset;
  groupBy: ReportGroup;
  measure: ReportMeasure;
  from: string;
  to: string;
  history?: ReportHistory;
  unitId?: string;
  versionId?: string;
  status?: string;
  columns?: string;
  groupField?: string;
  filterField?: string;
  match?: string;
  metricField?: string;
  aggregate?: FieldAggregate;
};
export const reportUsesFields = (query: PerformanceReportQuery) =>
  Boolean(query.columns || query.groupField || query.filterField || query.metricField);
export type ReportMetrics = Record<Exclude<ReportMeasure, 'fieldValue'>, number | null> & {
  assessed: number;
  fieldValue?: string | null;
};
export type ReportFieldChoice = {
  id: string;
  label: string;
  numeric: boolean;
  currency?: 'VND' | 'USD';
};
export type ReportFieldValue = { id: string; label: string };
export type ReportBucket = { key: string; label: string; metrics: ReportMetrics };
export type ReportObservation = {
  runId: string;
  taskId: string | null;
  title: string;
  unitId: string;
  workflow: string;
  version: number;
  step: string | null;
  round: number;
  attempt: number | null;
  person: string | null;
  status: string;
  startedAt: string;
  dueAt: string | null;
  finishedAt: string | null;
  elapsedSeconds: number | null;
  late: boolean | null;
  overdue: boolean;
  superseded: boolean;
  fields?: Record<string, string | null>;
};
export const reportStateLabels: Record<string, string> = {
  running: 'Đang xử lý',
  needs_revision: 'Cần bổ sung',
  pending: 'Đang chờ',
  completed: 'Hoàn thành',
  rejected: 'Từ chối',
  returned: 'Trả lại',
  cancelled: 'Đã hủy',
  approve: 'Phê duyệt',
  complete: 'Hoàn tất',
  reject: 'Từ chối',
  return: 'Trả lại',
};
