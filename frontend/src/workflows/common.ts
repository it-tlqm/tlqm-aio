import type { WorkflowSpec } from '../../../src/workflows/contracts';
import type { Answers } from '../../../src/forms/contracts';
import type { AttachmentSummary } from '../../../src/workflows/attachments';
import { api } from '@/lib/api';
import type { Me } from '@/lib/api';
export type WorkflowLookup = {
  units: { id: string; name: string }[];
  ownUnits: string[];
  accounts: { id: string; name: string; unitIds: string[] }[];
  groups?: WorkflowGroup[];
};
export type WorkflowGroup = {
  id: string;
  name: string;
  org_unit_id: string | null;
  active: boolean;
  revision: number;
  account_ids?: string[];
  canManage: boolean;
};
export type WorkflowSelection = {
  stepId: string;
  label: string;
  groupId: string;
  groupName: string;
  groupRevision: number;
  candidates: { id: string; name: string }[];
};
export type DefinitionItem = {
  id: string;
  code: string;
  name: string;
  category: string;
  org_unit_id: string;
  revision: number;
  status: string;
  draft: WorkflowSpec | null;
  latest_version: number;
  version: { id: string; version: number; spec: WorkflowSpec } | null;
  startUnits: string[];
  canDesign: boolean;
  canPublish: boolean;
};
export type WorkflowRun = {
  source_context?: import('../../../src/workflows/source').WorkflowSource | null;
  id: string;
  title: string;
  definition_id: string;
  version_id: string;
  org_unit_id: string;
  owner_account_id: string;
  owner_person_id: string;
  status: string;
  revision: number;
  round: number;
  inputs: Answers;
  current_step: string | null;
  created_at: string;
  updated_at: string;
};
export type WorkflowTask = {
  id: string;
  node_id: string;
  round: number;
  label: string;
  attempt: number;
  superseded_by_task_id: string | null;
  kind: 'task' | 'approval';
  assignee_account_id: string;
  assignee_name: string;
  assignment_group_id: string | null;
  approval_policy: { mode: 'all' | 'any' | 'quorum'; required: number } | null;
  members: {
    account_id: string;
    name: string;
    active: boolean;
    revision: number;
    action: 'approve' | 'reject' | 'return' | null;
    answers: Answers | null;
    reason: string | null;
    voted_at: string | null;
  }[];
  status: string;
  revision: number;
  due_at: string;
  overdue: boolean;
  answers: Answers | null;
  reason: string | null;
  action: string | null;
  decided_at: string | null;
};
export type RunDetail = {
  run: WorkflowRun;
  attachments: AttachmentSummary[];
  version: { id: string; version: number; spec: WorkflowSpec };
  tasks: WorkflowTask[];
  history: {
    id: number;
    action: string;
    reason: string;
    occurred_at: string;
    details: Record<string, unknown>;
  }[];
  inputs: { round: number; inputs: Answers; created_at: string }[];
  canAct: boolean;
  activeTaskId: string | null;
  canRecallSubmission: boolean;
  recallTargets: { taskId: string; label: string }[];
  taskActions: {
    taskId: string;
    canAct: boolean;
    canReassign: boolean;
    assignmentUnavailable: boolean;
    returnTargets: { id: string; stepId: string | null; name: string }[];
  }[];
  returnTargets: { id: string; stepId: string | null; name: string }[];
  canReassign: boolean;
  canManage: boolean;
  following: boolean;
  relatedTaskId: string | null;
  discussionSteps: { id: string; label: string; round: number; attempt: number }[];
  assignmentUnavailable: boolean;
  selections: {
    round: number;
    choices: Record<string, string>;
    group_revisions: Record<string, number>;
  }[];
};
export type RunListItem = WorkflowRun & {
  workflow_name: string;
  task_id: string | null;
  task_label: string | null;
  assignee_name: string | null;
  due_at: string | null;
  overdue: boolean;
  handled_at?: string | null;
  handled_action?: string | null;
  related_task_id?: string | null;
  cells?: Record<string, string>;
};
export const stateLabels: Record<string, string> = {
  draft: 'Bản nháp',
  published: 'Đang phát hành',
  paused: 'Ngừng phát hành',
  running: 'Đang xử lý',
  needs_revision: 'Cần bổ sung',
  completed: 'Hoàn thành',
  rejected: 'Từ chối',
  cancelled: 'Đã hủy',
  pending: 'Chờ xử lý',
  returned: 'Đã trả về',
};
export const actionLabels: Record<string, string> = {
  'run.follower_added': 'Thêm người theo dõi',
  'run.follower_removed': 'Bỏ người theo dõi',
  'run.comment_posted': 'Gửi bình luận',
  'run.started': 'Khởi tạo lượt chạy',
  'run.resubmitted': 'Bổ sung và gửi lại',
  'run.cancelled': 'Hủy lượt chạy',
  'run.completed': 'Hoàn thành quy trình',
  'run.step_returned': 'Mở lại bước đã xử lý',
  'run.recalled': 'Thu hồi để xử lý lại',
  'run.parallel_opened': 'Mở các nhánh song song',
  'run.parallel_arrived': 'Một nhánh đã xử lý xong',
  'run.parallel_joined': 'Đã hợp đủ nhánh',
  'task.assigned': 'Giao bước xử lý',
  'task.vote': 'Ghi nhận phiếu phê duyệt',
  'task.approve': 'Phê duyệt',
  'task.reject': 'Từ chối',
  'task.return': 'Trả về',
  'task.complete': 'Hoàn tất công việc',
  'task.reassigned': 'Phân công lại',
};
export function workflowWrite(me: Me, tenantId: string) {
  const keys = new Map<string, string>();
  return async <T>(path: string, data: Record<string, unknown>, reason: string) => {
    const body = { ...data, tenantId, reason },
      signature = JSON.stringify([path, body]);
    const key = keys.get(signature) ?? crypto.randomUUID();
    keys.set(signature, key);
    const result = await api<T>('/api/v1/workflows' + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': me.csrfToken,
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
    keys.delete(signature);
    return result;
  };
}
