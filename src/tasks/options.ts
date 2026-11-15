export const taskStatuses = ['todo', 'doing', 'done'] as const;
export const projectRoles = ['manager', 'member', 'viewer'] as const;
export const reminderOffsets = [0, 1, 3, 7] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export type ProjectRole = (typeof projectRoles)[number];
export type TaskStage = { code: string; name: string; phase: TaskStatus };
export type TaskTransition = { from: string; to: string; roles: Exclude<ProjectRole, 'viewer'>[] };
export type TaskWorkflow = { stages: TaskStage[]; transitions: TaskTransition[] };
export const defaultTaskStages: readonly TaskStage[] = [
  { code: 'todo', name: 'Cần thực hiện', phase: 'todo' },
  { code: 'doing', name: 'Đang thực hiện', phase: 'doing' },
  { code: 'done', name: 'Hoàn thành', phase: 'done' },
];
export const taskStagePattern = '^[a-z][a-z0-9-]{0,31}$';
export type TaskPerson = { accountId: string; personId: string; name: string };
export type ProjectMember = TaskPerson & { role: ProjectRole; active: boolean };
export type ProjectItem = {
  id: string;
  unitId: string;
  name: string;
  description: string;
  archived: boolean;
  revision: number;
  ownerAccountId: string;
  canManage: boolean;
  canCreateTask: boolean;
  canReport: boolean;
  workflow?: TaskWorkflow;
};
export type TaskItem = {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  description: string;
  creator: TaskPerson;
  assignee: TaskPerson | null;
  status: TaskStatus;
  stageCode?: string;
  stageName?: string;
  allowedStages?: string[];
  progress: number;
  dueOn: string | null;
  remindDays: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  overdue: boolean;
  canEdit: boolean;
  canProgress: boolean;
  canHandoff: boolean;
  canComment: boolean;
};
export type TaskInput = {
  title: string;
  description: string;
  dueOn: string | null;
  remindDays: number | null;
  assigneeId: string | null;
  participantIds: string[];
};
export type TaskDetail = {
  item: TaskItem;
  participants: TaskPerson[];
  children: TaskItem[];
  comments: { id: string; author: string; body: string; createdAt: string }[];
  history: {
    id: string;
    actor: string;
    action: string;
    reason: string;
    occurredAt: string;
    details: Record<string, unknown>;
  }[];
};
export type TaskFilters = {
  search?: string;
  status?: TaskStatus;
  stageCode?: string;
  assigneeId?: string;
  overdue?: boolean;
  mine?: boolean;
  after?: string;
};
export type TaskWorkItem = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: Exclude<TaskStatus, 'done'>;
  stageName?: string;
  dueOn: string | null;
  overdue: boolean;
};
export type TaskWorkReminder = {
  id: string;
  taskId: string;
  projectId: string;
  title: string;
  dueOn: string;
  kind: 'due' | 'overdue';
  createdAt: string;
};
export type TaskWorkPage = { items: TaskWorkItem[]; nextAfter: string | null };
export type TaskReport = {
  total: number;
  overdue: number;
  completedOnTime: number;
  percentDone: number;
  statuses: Record<TaskStatus, number>;
  people: {
    accountId: string | null;
    name: string;
    total: number;
    done: number;
    overdue: number;
  }[];
};
