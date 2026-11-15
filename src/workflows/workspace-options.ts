export const workflowRunViews = ['mine', 'inbox', 'all', 'followed', 'done'] as const;
export type WorkflowRunView = (typeof workflowRunViews)[number];
export const workflowRunStatuses = [
  'running',
  'needs_revision',
  'completed',
  'rejected',
  'cancelled',
] as const;
export const workflowDueFilters = ['overdue', 'today', 'upcoming'] as const;
export const workspaceColumns = [
  'step',
  'assignee',
  'status',
  'due',
  'unit',
  'created',
  'handled',
] as const;
export const defaultWorkspaceColumns = ['step', 'assignee', 'status', 'due'];
export const workspaceColumnPattern =
  '^(?:' +
  workspaceColumns.join('|') +
  '|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[a-z][a-z0-9_]{0,63})$';
export type WorkspaceFilters = {
  search?: string;
  status?: (typeof workflowRunStatuses)[number];
  unitId?: string;
  due?: (typeof workflowDueFilters)[number];
};
export type WorkspaceSettings = WorkspaceFilters & { columns: string[] };
export type WorkspacePreset = {
  id: string;
  name: string;
  settings: WorkspaceSettings;
  revision: number;
};
