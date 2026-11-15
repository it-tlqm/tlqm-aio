export const operationKinds = ['link', 'schedule', 'email', 'intake'] as const;
export const operationViews = ['attention', 'active', 'resolved'] as const;
export type OperationKind = (typeof operationKinds)[number];
export type OperationView = (typeof operationViews)[number];
export type OperationStatus = 'queued' | 'retry' | 'blocked' | 'done' | 'skipped';
export type OperationQuery = {
  kind: OperationKind;
  view: OperationView;
  after?: string;
  runId?: string;
};
export type OperationAttempt = {
  attempt: number;
  status: Exclude<OperationStatus, 'queued'>;
  errorCode: string | null;
  recordedAt: string;
};
export type OperationItem = {
  id: string;
  configurationId: string;
  unitId: string;
  workflowName: string;
  version: number;
  status: OperationStatus;
  attempts: number;
  errorCode: string | null;
  updatedAt: string;
  nextAttemptAt: string | null;
  overdue: boolean;
  canRetry: boolean;
  runId: string | null;
  history: OperationAttempt[];
};
