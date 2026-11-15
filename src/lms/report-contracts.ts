export type ReportFilters = {
  orgUnitId?: string;
  courseId?: string;
  search?: string;
  status?: 'all' | 'completed' | 'pending' | 'not-started' | 'not-required';
  mandatoryOnly?: boolean;
  page?: number;
};
export type ReportCourse = {
  id: string;
  versionId: string;
  version: number;
  title: string;
  series: string;
  duration: number;
  mandatory: boolean;
  deadline: string;
  audienceUnits: string[];
  tracking: 'self-confirmed' | 'player-reported';
};
export type ReportCell = {
  courseId: string;
  versionId: string;
  assigned: boolean;
  state: 'unassigned' | 'not-started' | 'learning' | 'failed' | 'passed';
  bestScore: number | null;
  attempts: number;
  watchedPct: number;
  lastAttemptAt: number | null;
  overdue: boolean;
};
export type ReportLearner = {
  employeeId: string;
  accountId: string;
  name: string;
  code: string;
  orgUnitId: string;
  unitName: string;
  required: number;
  passedRequired: number;
  assigned: number;
  passed: number;
  attempts: number;
  status: 'completed' | 'pending' | 'not-required';
  started: boolean;
  cells: ReportCell[];
};
export type ReportSummary = {
  learners: number;
  withRequired: number;
  completed: number;
  pending: number;
  notRequired: number;
  completionRate: number | null;
  attempts: number;
  averageBestScore: number | null;
  overdue: number;
};
export type ReportData = {
  scope: 'current-publication';
  filters: ReportFilters;
  courses: ReportCourse[];
  courseOptions: { id: string; title: string; version: number }[];
  units: { id: string; name: string }[];
  rows: ReportLearner[];
  summary: ReportSummary;
  byUnit: ({ id: string; name: string } & ReportSummary)[];
};
export type GradebookPage = Omit<ReportData, 'rows'> & {
  items: ReportLearner[];
  total: number;
  page: number;
  pageSize: number;
};
export function reportSummary(rows: ReportLearner[]): ReportSummary {
  const withRequired = rows.filter((row) => row.required > 0).length,
    completed = rows.filter((row) => row.status === 'completed').length,
    scores = rows.flatMap((row) =>
      row.cells.flatMap((cell) =>
        cell.assigned && cell.bestScore !== null ? [cell.bestScore] : [],
      ),
    );
  return {
    learners: rows.length,
    withRequired,
    completed,
    pending: rows.filter((row) => row.status === 'pending').length,
    notRequired: rows.filter((row) => row.status === 'not-required').length,
    completionRate: withRequired ? Math.round((completed / withRequired) * 100) : null,
    attempts: rows.reduce((sum, row) => sum + row.attempts, 0),
    averageBestScore: scores.length
      ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : null,
    overdue: rows.reduce((sum, row) => sum + row.cells.filter((cell) => cell.overdue).length, 0),
  };
}
