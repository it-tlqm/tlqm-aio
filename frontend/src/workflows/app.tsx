import { UnitPicker } from '@/components/unit-picker';
import { ConfigurationTransferControls } from '@/components/configuration-transfer';
import { CalendarEditor } from './calendar-editor';
import { PoolProgress } from './pool-progress';
import { FieldAccessEditor } from './field-access-editor';
import { RequestDraftList } from './request-drafts';
import type { RequestDraft, RequestDraftDetail } from './request-drafts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GitBranch,
  Inbox,
  Send,
  Layers,
  ChartNoAxesCombined,
  LogOut,
  ArrowLeft,
  Plus,
  Play,
  Save,
  RefreshCw,
  Pause,
  CheckCheck,
  Clock3,
  FileText,
  ArrowUpRight,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Brand } from '@/components/brand';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { FormDesigner } from '../forms/designer';
import { FormRenderer, AnswerReadback } from '../forms/renderer';
import { AttachmentLinks } from '../forms/attachment-field';
import type { AttachmentContext } from '../forms/attachment-field';
import type { AttachmentSummary } from '../../../src/workflows/attachments';
import { Choice, can, formError } from '../forms/common';
import {
  actionDestination,
  decisionPath,
  hasStepBranchSources,
  parseWorkflow,
  selectsAtHandoff,
  priorStepMode,
  WorkflowValidationError,
} from '../../../src/workflows/contracts';
import type { WorkflowSpec, HumanStep, WorkflowAction } from '../../../src/workflows/contracts';
import type { Answers } from '../../../src/forms/contracts';
import { workflowTemplate, businessPurchaseTemplate } from '../../../src/workflows/templates';
import {
  initialStepAnswers,
  stepActionForm,
  stepInputCandidates,
  stepReadbackSchema,
} from '../../../src/workflows/step-input';
import { WorkflowCanvas } from './designer';
import { workflowWrite, stateLabels, actionLabels } from './common';
import type {
  DefinitionItem,
  RunDetail,
  WorkflowLookup,
  WorkflowRun,
  WorkflowTask,
  WorkflowGroup,
  WorkflowSelection,
} from './common';
import { WorkflowGroups } from './groups';
import { WorkflowSelectionFields } from './selection-fields';
import { DiscussionPanel } from './discussion';
import { WorkflowWorkspace } from './workspace';
import { RelatedWorkflowRequests, WorkflowLinks } from './linked-requests';
import { WorkflowSchedules } from './scheduled-requests';
import { WorkflowOperations } from './operations';
import { WorkflowOutputs, WorkflowMailbox, RunPrintTemplates } from './output-templates';
import { WorkflowModuleIntakes, WorkflowTrainingIntake } from './module-intakes';
import { WorkflowPerformanceReport, reportHashTenant } from './performance-report';
import { WorkflowVersionHistory } from './version-history';
import { documentHashTenant, LinkedWorkflowDocuments, WorkflowDocuments } from './document-library';
import { workflowRunViews } from '../../../src/workflows/workspace-options';
import type { WorkflowRunView } from '../../../src/workflows/workspace-options';
const views = [
  'definitions',
  'documents',
  ...workflowRunViews,
  'report',
  'groups',
  'requests',
  'automation',
  'mailbox',
] as const;
type View = (typeof views)[number];
function initialView(): View {
  return (
    views.find((view) => location.hash.split('?')[0] === '#workflows/' + view) ?? 'definitions'
  );
}
const isWorkspaceView = (view: View): view is WorkflowRunView =>
  workflowRunViews.some((item) => item === view);
function fileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]!);
    reader.readAsDataURL(file);
  });
}
const runLocation = () =>
  location.hash.startsWith('#workflow-run/') ? location.hash.slice(14).split('/') : [];
type Confirmation = {
  title: string;
  description: string;
  returnTargets?: RunDetail['returnTargets'];
  preview?: (signal: AbortSignal, returnTarget?: string) => Promise<HandoffPreview>;
  action: (
    reason: string,
    handoffs?: { stepId: string; accountId: string }[],
    returnTarget?: string,
  ) => Promise<string | void>;
};
type HandoffSelection = {
  stepId: string;
  label: string;
  groupName: string;
  candidates: { id: string; name: string }[];
};
type HandoffPreview = { selection: HandoffSelection | null; selections?: HandoffSelection[] };
function explain(error: unknown) {
  if (
    error instanceof WorkflowValidationError ||
    (error instanceof ApiError && error.code === 'WORKFLOW_INVALID_DEFINITION' && error.issues)
  )
    return (
      'Chưa thể phát hành: ' +
      error
        .issues!.map(
          (issue) =>
            (
              ({
                WORKFLOW_FIELD_POLICY_INVALID:
                  'kiểm tra quyền trường và quyền xem các trường điều kiện liên quan',
                STEP_INPUT_ACCESS_REQUIRED: 'cấp quyền xem cho bước dùng trường khởi tạo',
                INVALID_STEP_INPUT_FIELD: 'kiểm tra trường khởi tạo được dùng trong bước',
                REASSIGNMENT_GROUP_REQUIRED:
                  'chọn cách giao cho một người trong nhóm để thiết lập phân công lại',
                INVALID_REASSIGNMENT_POLICY: 'kiểm tra người được phép phân công lại',
                HANDOFF_PROTECTED_CONDITION:
                  'cấp quyền xem trường điều kiện cho bước chuyển có chọn người bàn giao',
                INVALID_RETURN_MODE: 'kiểm tra cách trả về hoặc từ chối của bước',
                PARALLEL_JOIN_INVALID: 'mỗi cụm song song cần một điểm hợp riêng',
                PARALLEL_JOIN_UNEXPECTED: 'kiểm tra đường dẫn vào điểm hợp nhánh',
                PARALLEL_BRANCH_CROSSES: 'mỗi nhánh cần đường xử lý riêng tới điểm hợp',
                PARALLEL_BRANCH_MISSES_JOIN: 'nối mọi đường của nhánh tới điểm hợp',
                PARALLEL_BRANCH_EMPTY: 'thêm bước đầu cho nhánh song song',
                PARALLEL_BRANCH_COUNT: 'cụm song song cần ít nhất hai nhánh',
                PARALLEL_BRANCH_DUPLICATE: 'chọn bước đầu khác nhau cho từng nhánh',
                RESERVED_STEP_ID: 'mã bước trùng tên dành riêng cho quyền trường',
                INVALID_CALENDAR: 'kiểm tra ngày làm việc, ca không chồng giờ và ngày nghỉ hợp lệ',
                CALENDAR_REQUIRED: 'bật lịch làm việc tại Thông tin & đối tượng',
                INVALID_QUORUM: 'số người duyệt tối thiểu phải từ 1 đến 50',
                INVALID_DEADLINE: 'thời hạn phải là số nguyên dương trong giới hạn cho phép',
                PREVIOUS_STEP_NOT_GUARANTEED: 'bước tham chiếu phải xuất hiện trước trên mọi nhánh',
                INVALID_PREVIOUS_ASSIGNEE_STEP: 'hãy chọn một bước xử lý trước hợp lệ',
                AMBIGUOUS_ASSIGNEE: 'mỗi bước chỉ dùng một cách giao nhiệm vụ',
                ASSIGNMENT_VERSION_REQUIRED: 'hãy lưu lại bản thiết kế trước khi phát hành',
                GRAPH_CYCLE: 'luồng có vòng lặp, hãy kiểm tra các đường nối',
                UNREACHABLE_STEP: 'có bước chưa được nối từ điểm bắt đầu',
                UNKNOWN_TARGET: 'có đường nối tới bước không tồn tại',
                AUDIENCE_REQUIRED: 'hãy chọn đơn vị được khởi chạy',
                TEXT_REQUIRED: 'cần điền đủ tên, người xử lý hoặc nhóm được yêu cầu',
              }) as Record<string, string>
            )[issue.code] ?? 'hãy kiểm tra cấu hình bước và điều kiện',
        )
        .join('; ')
    );
  return formError(error);
}
export function WorkflowsApp({ me, portalUrl }: { me: Me; portalUrl: string | undefined }) {
  const [requestDraft, setRequestDraft] = useState<RequestDraft | null>(null);
  const draftCreation = useRef<Promise<RequestDraft> | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<Record<string, AttachmentSummary>>({});
  const [draftCanSubmit, setDraftCanSubmit] = useState(true);
  const [draftNotice, setDraftNotice] = useState('');
  const [tenantId, setTenantId] = useState(
      () =>
        me.memberships.find((entry) => entry.id === (reportHashTenant() ?? documentHashTenant()))
          ?.id ??
        me.memberships[0]?.id ??
        '',
    ),
    [view, setView] = useState<View>(initialView);
  const [definitions, setDefinitions] = useState<DefinitionItem[]>([]),
    [lookup, setLookup] = useState<WorkflowLookup>({ units: [], ownUnits: [], accounts: [] });
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const [search, setSearch] = useState(''),
    [runId, setRunId] = useState(runLocation()[0] ?? ''),
    [activeTaskId, setActiveTaskId] = useState<string | null>(null),
    [detail, setDetail] = useState<RunDetail | null>(null);
  const [discussionScope, setDiscussionScope] = useState('');
  const workspaceRoute = useRef<{
    tenantId: string;
    view: WorkflowRunView | 'report';
    hash: string;
  } | null>(null);
  const [report, setReport] = useState<{
    states: { status: string; count: number }[];
    overdue: number;
  } | null>(null);
  useEffect(() => {
    const [, taskId, section] = runLocation();
    if (loading || !detail || detail.relatedTaskId || !taskId || section !== 'history') return;
    const frame = requestAnimationFrame(() =>
      document.getElementById('workflow-task-history-' + taskId)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [detail, loading]);
  const [editing, setEditing] = useState<DefinitionItem | null>(null),
    [spec, setSpec] = useState<WorkflowSpec | null>(null),
    [code, setCode] = useState(''),
    [unit, setUnit] = useState(''),
    [dirty, setDirty] = useState(false),
    [editorTab, setEditorTab] = useState('flow'),
    [formNode, setFormNode] = useState('input');
  const [templates, setTemplates] = useState(false),
    [starting, setStarting] = useState<DefinitionItem | null>(null),
    [startTitle, setStartTitle] = useState(''),
    [startUnit, setStartUnit] = useState(''),
    [startAnswers, setStartAnswers] = useState<Answers>({});
  const [versionHistory, setVersionHistory] = useState<DefinitionItem | null>(null);
  const versionHistoryTrigger = useRef<HTMLButtonElement | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [reason, setReason] = useState(''),
    [confirmationError, setConfirmationError] = useState<unknown>(null);
  const [handoffs, setHandoffs] = useState<HandoffSelection[]>([]);
  const [handoffAccounts, setHandoffAccounts] = useState<Record<string, string>>({});
  const [returnTarget, setReturnTarget] = useState('');
  const [previewReady, setPreviewReady] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  useEffect(() => {
    if (!confirmation?.preview || (confirmation.returnTargets && !returnTarget)) return;
    const controller = new AbortController();
    void confirmation
      .preview(controller.signal, returnTarget || undefined)
      .then(({ selection, selections }) => {
        if (controller.signal.aborted) return;
        setHandoffs(selections ?? (selection ? [selection] : []));
        setPreviewReady(true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setConfirmationError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [confirmation, returnTarget]);
  const [taskAnswers, setTaskAnswers] = useState<Answers>({}),
    [revisedAnswers, setRevisedAnswers] = useState<Answers>({}),
    [reassigning, setReassigning] = useState<WorkflowTask | null>(null),
    [newAssignee, setNewAssignee] = useState('');
  const write = useMemo(() => workflowWrite(me, tenantId), [me, tenantId]);
  const [groups, setGroups] = useState<WorkflowGroup[]>([]);
  const [startOptions, setStartOptions] = useState<WorkflowSelection[]>([]),
    [startSelections, setStartSelections] = useState<Record<string, string>>({}),
    [startSelectionLoading, setStartSelectionLoading] = useState(false),
    [startSelectionError, setStartSelectionError] = useState<unknown>(null);
  const [revisionOptions, setRevisionOptions] = useState<WorkflowSelection[]>([]),
    [revisionSelections, setRevisionSelections] = useState<Record<string, string>>({}),
    [revisionLoading, setRevisionLoading] = useState(false),
    [revisionError, setRevisionError] = useState<unknown>(null);
  const [replaceAccountId, setReplaceAccountId] = useState('');
  const [reassignCandidates, setReassignCandidates] = useState<{ id: string; name: string }[]>([]),
    [candidateLoading, setCandidateLoading] = useState(false),
    [candidateError, setCandidateError] = useState<unknown>(null);
  const has = (permission: string) => can(me, tenantId, permission);
  const catalogLoad = useRef<AbortController | null>(null);
  const loadDefinitions = useCallback(
    async (unitsOnly = false) => {
      catalogLoad.current?.abort();
      const controller = new AbortController();
      catalogLoad.current = controller;
      const { signal } = controller;
      try {
        const [list, refs, groupResult] = await Promise.all([
          api<{ items: DefinitionItem[] }>('/api/v1/workflows/definitions?tenantId=' + tenantId, {
            signal,
          }),
          api<WorkflowLookup>(
            '/api/v1/workflows/lookups?tenantId=' + tenantId + (unitsOnly ? '&unitsOnly=true' : ''),
            { signal },
          ),
          !unitsOnly &&
          ['workflows:design', 'workflows:publish', 'workflows:manage'].some((permission) =>
            can(me, tenantId, permission),
          )
            ? api<{ items: WorkflowGroup[] }>('/api/v1/workflows/groups?tenantId=' + tenantId, {
                signal,
              })
            : Promise.resolve({ items: [] as WorkflowGroup[] }),
        ]);
        if (signal.aborted) return;
        setDefinitions(list.items);
        setLookup({ ...refs, groups: groupResult.items });
        setGroups(groupResult.items);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    },
    [tenantId, me],
  );
  useEffect(() => () => catalogLoad.current?.abort(), []);
  useEffect(() => {
    setStartOptions([]);
    setStartSelections({});
    setStartSelectionError(null);
    setStartSelectionLoading(false);
    if (
      !starting?.version ||
      !startUnit ||
      !starting.version.spec.nodes.some(
        (node) => 'assigneeRule' in node && node.assigneeRule?.kind === 'group',
      )
    )
      return;
    const controller = new AbortController();
    setStartSelectionLoading(true);
    void api<{ items: WorkflowSelection[] }>(
      '/api/v1/workflows/definitions/' +
        starting.id +
        '/selections?' +
        new URLSearchParams({ tenantId, unitId: startUnit, versionId: starting.version.id }),
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setStartOptions(result.items);
          const prior = requestDraft?.selections ?? {};
          setStartSelections(
            Object.fromEntries(
              result.items
                .filter((o) => o.candidates.some((c) => c.id === prior[o.stepId]))
                .map((o) => [o.stepId, prior[o.stepId]!]),
            ),
          );
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStartSelectionError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setStartSelectionLoading(false);
      });
    return () => controller.abort();
  }, [starting, startUnit, tenantId]);
  useEffect(() => {
    setRevisionOptions([]);
    setRevisionSelections({});
    setRevisionError(null);
    setRevisionLoading(false);
    if (
      !detail ||
      detail.run.status !== 'needs_revision' ||
      detail.run.owner_account_id !== me.accountId ||
      !detail.version.spec.nodes.some(
        (node) => 'assigneeRule' in node && node.assigneeRule?.kind === 'group',
      )
    )
      return;
    const controller = new AbortController();
    setRevisionLoading(true);
    void api<{ items: WorkflowSelection[] }>(
      '/api/v1/workflows/runs/' + detail.run.id + '/selections?tenantId=' + tenantId,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setRevisionOptions(result.items);
        const prior =
          detail.selections?.find((item) => item.round === detail.run.round)?.choices ?? {};
        setRevisionSelections(
          Object.fromEntries(
            result.items
              .filter((option) =>
                option.candidates.some((candidate) => candidate.id === prior[option.stepId]),
              )
              .map((option) => [option.stepId, prior[option.stepId]!]),
          ),
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setRevisionError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRevisionLoading(false);
      });
    return () => controller.abort();
  }, [detail, tenantId, me.accountId]);
  useEffect(() => {
    setReassignCandidates([]);
    setNewAssignee('');
    setCandidateError(null);
    setCandidateLoading(false);
    if (!reassigning) return;
    const controller = new AbortController();
    setCandidateLoading(true);
    void api<{ candidates: { id: string; name: string }[] }>(
      '/api/v1/workflows/tasks/' + reassigning.id + '/candidates?tenantId=' + tenantId,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setReassignCandidates(result.candidates);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCandidateError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCandidateLoading(false);
      });
    return () => controller.abort();
  }, [reassigning, tenantId]);
  const activateTask = useCallback((result: RunDetail, preferredId?: string | null) => {
    const action =
      result.taskActions.find((item) => item.taskId === preferredId) ??
      result.taskActions.find((item) => item.taskId === result.activeTaskId);
    const pending = result.tasks.find((task) => task.id === action?.taskId);
    const active = result.version.spec.nodes.find((node) => node.id === pending?.node_id);
    setActiveTaskId(action?.taskId ?? null);
    const prior =
      pending && pending.attempt > 1 && !pending.approval_policy
        ? result.tasks.find(
            (task) =>
              task.node_id === pending.node_id &&
              task.round === pending.round &&
              task.attempt === pending.attempt - 1 &&
              task.superseded_by_task_id,
          )
        : undefined;
    setTaskAnswers(
      action?.canAct && active && 'form' in active
        ? { ...initialStepAnswers(active, result.run.inputs), ...prior?.answers }
        : {},
    );
  }, []);
  const loadRun = useCallback(
    async (id: string, taskId?: string) => {
      setDetail(null);
      const preferred = taskId ?? (runLocation()[0] === id ? runLocation()[1] : undefined);
      const query = new URLSearchParams({ tenantId, ...(preferred && { taskId: preferred }) });
      const result = await api<RunDetail>('/api/v1/workflows/runs/' + id + '?' + query);
      setDetail(result);
      setDiscussionScope(
        result.relatedTaskId ??
          (result.discussionSteps.some((step) => step.id === preferred) ? preferred! : ''),
      );
      activateTask(result, preferred);
      setRevisedAnswers(result.run.inputs);
      return result;
    },
    [tenantId, activateTask],
  );
  const loadList = useCallback(
    async (target: View) => {
      setError(null);
      if (target === 'automation' || target === 'documents') return loadDefinitions(true);
      if (target === 'definitions' || target === 'groups') return loadDefinitions();
      if (target === 'requests') return;
      if (target === 'report') {
        setReport(null);
        setReport(await api('/api/v1/workflows/report?tenantId=' + tenantId));
        return;
      }
    },
    [tenantId, loadDefinitions],
  );
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loadInitial = async () => {
      if (runId) {
        const initial = await loadRun(runId);
        if (cancelled) return;
        setLoading(false);
        if (!initial.relatedTaskId) await loadDefinitions();
        return;
      }
      await loadDefinitions(view === 'automation' || view === 'documents');
      if (view === 'report') await loadList(view);
    };
    void loadInitial()
      .catch((e) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, loadDefinitions, loadList]);
  useEffect(() => {
    const update = () => {
      const [run, taskId] = runLocation();
      const id = run ?? '';
      const target = initialView();
      if (!id && target === view && !runId) return;
      if (dirty && !window.confirm('Bản thiết kế chưa lưu. Rời màn hình này?')) {
        window.history.replaceState(null, '', '#workflows/' + view);
        return;
      }
      setDirty(false);
      setSpec(null);
      setEditing(null);
      setRunId(id);
      setDetail(null);
      if (!id) setView(target);
      setLoading(true);
      void (id ? loadRun(id, taskId) : loadList(target))
        .catch(setError)
        .finally(() => setLoading(false));
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [dirty, runId, view, loadRun, loadList]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const confirm = (value: Confirmation) => {
    setHandoffs([]);
    setHandoffAccounts({});
    setReturnTarget('');
    setPreviewReady(!value.preview);
    setPreviewLoading(!!value.preview && !value.returnTargets);
    setConfirmation(value);
    setReason('');
    setConfirmationError(null);
  };
  function confirmRecall(current: RunDetail, sourceTaskId?: string) {
    confirm({
      title: sourceTaskId ? 'Thu hồi bước đã chuyển?' : 'Thu hồi hồ sơ?',
      description: sourceTaskId
        ? 'Bạn sẽ nhận lại bước đã chuyển để sửa và gửi tiếp. Hệ thống giữ lịch sử xử lý.'
        : 'Hồ sơ sẽ về mục bổ sung để bạn chỉnh sửa rồi gửi lại.',
      action: async (reason) => {
        await write(
          '/runs/' + current.run.id + '/recall',
          { expectedRevision: current.run.revision, ...(sourceTaskId && { sourceTaskId }) },
          reason,
        );
        await loadRun(current.run.id);
      },
    });
  }
  async function navigate(target: View) {
    if (dirty && !window.confirm('Bản thiết kế chưa lưu. Rời màn hình này?')) return;
    setDirty(false);
    setSpec(null);
    setEditing(null);
    setRunId('');
    setDetail(null);
    setView(target);
    const back = workspaceRoute.current;
    const hash =
      location.hash.split('?')[0] === '#workflows/' + target
        ? location.hash
        : back?.tenantId === tenantId && back.view === target
          ? back.hash
          : '#workflows/' + target;
    window.history.pushState(null, '', hash);
    setLoading(true);
    try {
      await loadList(target);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  async function openRun(id: string, taskId?: string, history = false) {
    if ((isWorkspaceView(view) || view === 'report') && initialView() === view)
      workspaceRoute.current = { tenantId, view, hash: location.hash };
    setRunId(id);
    setSpec(null);
    setError(null);
    window.history.pushState(
      null,
      '',
      '#workflow-run/' + id + (taskId ? '/' + taskId + (history ? '/history' : '') : ''),
    );
    setLoading(true);
    try {
      await loadRun(id, taskId);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  const updateSpec = (value: WorkflowSpec) => {
    if (value.nodes.some((node) => 'inputFields' in node && node.inputFields)) {
      const sourceIds = new Set(stepInputCandidates(value.input).map((field) => field.id));
      value = {
        ...value,
        schemaVersion: 5,
        nodes: value.nodes.map((node) => {
          if (!('inputFields' in node) || !node.inputFields) return node;
          const entries = Object.entries(node.inputFields).filter(([id]) => sourceIds.has(id));
          return { ...node, inputFields: entries.length ? Object.fromEntries(entries) : undefined };
        }),
      };
    }
    if (value.fieldReaders) {
      const sources = [
        { id: 'input', schema: value.input },
        ...value.nodes.flatMap((n) =>
          'form' in n && n.form ? [{ id: n.id, schema: n.form }] : [],
        ),
      ];
      const fields = new Set(
        sources.flatMap((s) =>
          s.schema.sections.flatMap((section) => section.fields.map((f) => s.id + '.' + f.id)),
        ),
      );
      const readers = new Set([
        'owner',
        'manager',
        ...value.nodes.filter((n) => n.kind === 'approval' || n.kind === 'task').map((n) => n.id),
      ]);
      value = {
        ...value,
        fieldReaders: Object.fromEntries(
          Object.entries(value.fieldReaders)
            .filter(([address]) => fields.has(address))
            .map(([address, allowed]) => [address, allowed.filter((r) => readers.has(r))]),
        ),
      };
    }
    setSpec({
      ...value,
      schemaVersion:
        value.fieldReaders !== undefined ||
        hasStepBranchSources(value) ||
        value.input.schemaVersion === 2 ||
        value.nodes.some(
          (n) =>
            'form' in n &&
            (n.form?.schemaVersion === 2 ||
              n.reassignRoles?.length ||
              n.rejectNext ||
              n.returnMode ||
              n.rejectReturnMode ||
              selectsAtHandoff(n)),
        )
          ? 5
          : value.schemaVersion,
    });
    setDirty(true);
  };
  function edit(item: DefinitionItem) {
    setEditing(item);
    setSpec(structuredClone(item.draft ?? item.version!.spec));
    setCode(item.code);
    setUnit(item.org_unit_id);
    setDirty(false);
    setEditorTab('flow');
    setFormNode('input');
    setError(null);
  }
  function create(kind: 'purchase' | 'leave' | 'blank' | 'purchase-lines') {
    setEditing(null);
    setSpec(kind === 'purchase-lines' ? businessPurchaseTemplate() : workflowTemplate(kind));
    setCode('quy-trinh-' + crypto.randomUUID().slice(0, 6));
    setUnit(lookup.units.find((unit) => can(me, tenantId, 'workflows:design', unit.id))?.id ?? '');
    setDirty(true);
    setTemplates(false);
    setEditorTab('flow');
    setError(null);
  }
  async function save() {
    if (!spec) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = parseWorkflow(spec, false);
      const result = await write<DefinitionItem>(
        '/definitions' + (editing ? '/' + editing.id : ''),
        {
          code,
          orgUnitId: unit,
          spec: parsed,
          ...(editing ? { expectedRevision: editing.revision } : {}),
        },
        'Lưu bản thiết kế quy trình',
      );
      const updated: DefinitionItem = {
        ...result,
        canDesign: can(me, tenantId, 'workflows:design', unit),
        canPublish: can(me, tenantId, 'workflows:publish', unit),
        draft: result.draft ?? parsed,
        version: editing?.version ?? null,
        startUnits: editing?.startUnits ?? [],
      };
      setDefinitions((items) => [updated, ...items.filter((item) => item.id !== updated.id)]);
      edit(updated);
      setNotice('Đã lưu bản nháp. Lượt chạy cũ vẫn dùng phiên bản của chúng.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function publish() {
    if (!spec || !editing) return;
    try {
      parseWorkflow(spec);
    } catch (e) {
      setError(e);
      return;
    }
    confirm({
      title: 'Phát hành quy trình?',
      description:
        'Phiên bản được khóa sau khi phát hành. Chỉ các đơn vị được chọn mới có thể khởi chạy.',
      action: async (reason) => {
        await write(
          '/definitions/' + editing.id + '/publish',
          { expectedRevision: editing.revision },
          reason,
        );
        await navigate('definitions');
        setNotice('Đã phát hành phiên bản mới.');
      },
    });
  }
  function startDefinition(item: DefinitionItem) {
    setStarting(item);
    setRequestDraft(null);
    setDraftCanSubmit(true);
    setDraftNotice('');
    setStartTitle(item.name);
    setStartUnit(item.startUnits[0]!);
    setStartAnswers({});
    setError(null);
  }

  async function saveRequestDraft() {
    if (!starting?.version) throw new Error('No workflow selected');
    const draft = await write<RequestDraft>(
      '/requests' + (requestDraft ? '/' + requestDraft.id : ''),
      {
        definitionId: starting.id,
        versionId: starting.version.id,
        unitId: startUnit,
        title: startTitle,
        answers: startAnswers,
        selections: startSelections,
        ...(requestDraft ? { expectedRevision: requestDraft.revision } : {}),
      },
      'Lưu nội dung hồ sơ nháp',
    );
    setRequestDraft({
      ...draft,
      ...(requestDraft?.linkedSource && { linkedSource: requestDraft.linkedSource }),
    });
    setStartAnswers(draft.answers);
    return draft;
  }
  function resumeDraft(detail: RequestDraftDetail) {
    const draft = detail.request;
    setUploadedFiles(Object.fromEntries(detail.attachments.map((file) => [file.id, file])));
    setRequestDraft({
      ...draft,
      ...(detail.linkedSource && { linkedSource: detail.linkedSource }),
      ...(detail.blockedReason && { blockedReason: detail.blockedReason }),
    });
    setDraftCanSubmit(detail.canSubmit);
    setDraftNotice('');
    setError(null);
    setStarting({
      id: draft.definition_id,
      code: '',
      name: detail.version.spec.name,
      category: detail.version.spec.category,
      org_unit_id: draft.org_unit_id,
      revision: 1,
      status: 'published',
      draft: null,
      latest_version: detail.version.version,
      version: detail.version,
      startUnits: [draft.org_unit_id],
      canDesign: false,
      canPublish: false,
    });
    setStartTitle(draft.title);
    setStartUnit(draft.org_unit_id);
    setStartAnswers(draft.answers);
    setStartSelections(draft.selections);
  }
  async function logout() {
    try {
      const result = await api<{ redirectTo: string }>('/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
        body: JSON.stringify({ global: true }),
      });
      location.assign(result.redirectTo);
    } catch (e) {
      setError(e);
    }
  }
  const menu = [
    { id: 'groups' as View, label: 'Nhóm xử lý', icon: Layers, show: has('workflows:manage') },
    { id: 'definitions' as View, label: 'Quy trình', icon: Layers, show: true },
    {
      id: 'documents' as View,
      label: 'Tài liệu quy trình',
      icon: FileText,
      show: ['workflows:design', 'workflows:publish', 'workflows:start', 'workflows:act'].some(has),
    },
    {
      id: 'automation' as View,
      label: 'Tự động hóa',
      icon: GitBranch,
      show: has('workflows:publish'),
    },
    { id: 'inbox' as View, label: 'Cần xử lý', icon: Inbox, show: has('workflows:act') },
    { id: 'mailbox' as View, label: 'Hộp thư local', icon: Inbox, show: true },
    { id: 'done' as View, label: 'Đã xử lý', icon: CheckCheck, show: has('workflows:act') },
    { id: 'mine' as View, label: 'Tôi đã gửi', icon: Send, show: has('workflows:start') },
    {
      id: 'followed' as View,
      label: 'Theo dõi',
      icon: GitBranch,
      show: has('workflows:collaborate'),
    },
    { id: 'requests' as View, label: 'Nháp của tôi', icon: FileText, show: has('workflows:start') },
    {
      id: 'all' as View,
      label: 'Theo dõi lượt chạy',
      icon: GitBranch,
      show: has('workflows:manage') || has('workflows:report'),
    },
    {
      id: 'report' as View,
      label: 'Báo cáo',
      icon: ChartNoAxesCombined,
      show: has('workflows:manage') || has('workflows:report'),
    },
  ];
  const selectedAction = detail?.taskActions.find((action) => action.taskId === activeTaskId);
  const pending = detail?.tasks.find((task) => task.id === selectedAction?.taskId),
    currentNode = detail?.version.spec.nodes.find((node) => node.id === pending?.node_id) as
      HumanStep | undefined;
  const actorTask = pending && selectedAction?.canAct;
  const attachmentContext: AttachmentContext = {
    files: {
      ...uploadedFiles,
      ...Object.fromEntries((detail?.attachments ?? []).map((file) => [file.id, file])),
    },
    href: (id) =>
      '/api/v1/workflows/attachments/' +
      encodeURIComponent(id) +
      '?tenantId=' +
      encodeURIComponent(tenantId),
  };
  async function uploadFiles(
    target: () => string | Promise<string>,
    fieldId: string,
    files: File[],
  ) {
    setBusy(true);
    try {
      const path = await target();
      const uploaded: AttachmentSummary[] = [];
      for (const file of files) {
        const saved = await write<AttachmentSummary>(
          path + '/attachments',
          {
            fieldId,
            fileName: file.name,
            content: await fileAsBase64(file),
          },
          'Tải tệp đính kèm cho biểu mẫu',
        );
        uploaded.push(saved);
        setUploadedFiles((current) => ({ ...current, [saved.id]: saved }));
      }
      return uploaded;
    } finally {
      setBusy(false);
    }
  }
  async function attachmentDraftTarget() {
    if (requestDraft) return '/requests/' + requestDraft.id;
    draftCreation.current ??= saveRequestDraft().finally(() => {
      draftCreation.current = null;
    });
    return '/requests/' + (await draftCreation.current).id;
  }
  const currentTaskForm =
    detail && currentNode ? stepActionForm(detail.version.spec.input, currentNode) : null;
  const currentReadback =
    detail && currentNode ? stepReadbackSchema(detail.version.spec.input, currentNode) : null;
  const formSchema = spec
    ? formNode === 'input'
      ? spec.input
      : (spec.nodes.find((node) => node.id === formNode) as HumanStep | undefined)?.form
    : null;
  const readOnly = editing ? !editing.canDesign : false;
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="border-b bg-[var(--sidebar-bg)] lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-r">
        <div className="border-b p-5">
          <Brand module="Quy trình" />
        </div>
        <nav aria-label="Điều hướng Quy trình" className="flex flex-wrap gap-1 p-3 lg:flex-col">
          {menu
            .filter((item) => item.show)
            .map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                className={
                  'justify-start ' +
                  (view === item.id && !spec && !runId
                    ? 'nav-current'
                    : 'text-secondary-foreground')
                }
                onClick={() => void navigate(item.id)}
              >
                <item.icon className="size-4" />
                {item.label}
              </Button>
            ))}
        </nav>
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2 lg:hidden">
          <span className="truncate text-sm">{me.displayName}</span>
          <Button variant="ghost" onClick={() => void logout()} aria-label="Đăng xuất SSO">
            <LogOut />
          </Button>
        </div>
        <div className="mt-auto hidden space-y-3 border-t p-4 lg:block">
          <p className="truncate text-sm font-medium">{me.displayName}</p>
          <p className="text-xs text-muted-foreground">Định danh AIO · Local</p>
          <Button variant="outline" className="w-full" asChild>
            <a href={portalUrl ?? 'http://127.0.0.1:4100/'}>
              Mở Portal <ArrowUpRight />
            </a>
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => void logout()}>
            <LogOut />
            Đăng xuất SSO
          </Button>
        </div>
      </aside>
      <main className="min-w-0 space-y-6 p-4 sm:p-7">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Không gian làm việc / Quy trình</p>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--brand-navy)]">
              {spec
                ? 'Thiết kế quy trình'
                : detail
                  ? detail.run.title
                  : menu.find((item) => item.id === view)?.label}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">Local · Dữ liệu giả lập</Badge>
            {me.memberships.length > 1 && (
              <Choice
                label="Không gian"
                value={tenantId}
                onChange={(id) => {
                  setRunId('');
                  setSpec(null);
                  if (view === 'report') window.history.replaceState(null, '', '#workflows/report');
                  setTenantId(id);
                }}
                options={me.memberships}
              />
            )}
          </div>
        </header>
        {error !== null && (
          <Alert variant="destructive" data-workflow-error>
            <AlertDescription>{explain(error)}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {loading && <p role="status">Đang tải quy trình…</p>}
        {!loading && !spec && !runId && view === 'requests' && (
          <RequestDraftList tenantId={tenantId} onResume={resumeDraft} />
        )}
        {!loading && !spec && !runId && view === 'mailbox' && (
          <WorkflowMailbox tenantId={tenantId} openRun={openRun} />
        )}
        {!loading && !spec && !runId && view === 'automation' && has('workflows:publish') && (
          <Tabs key={tenantId} defaultValue="links">
            <TabsList aria-label="Tự động hóa quy trình">
              <TabsTrigger value="links">Quy trình liên kết</TabsTrigger>
              <TabsTrigger value="schedules">Tạo nháp định kỳ</TabsTrigger>
              <TabsTrigger value="outputs">Mẫu in và email</TabsTrigger>
              <TabsTrigger value="intakes">Chuyển đề nghị</TabsTrigger>
              <TabsTrigger value="operations">Vận hành job</TabsTrigger>
            </TabsList>
            <TabsContent value="links">
              <WorkflowLinks
                tenantId={tenantId}
                me={me}
                definitions={definitions}
                lookup={lookup}
                write={write}
              />
            </TabsContent>
            <TabsContent value="schedules">
              <WorkflowSchedules
                tenantId={tenantId}
                me={me}
                definitions={definitions}
                lookup={lookup}
                write={write}
              />
            </TabsContent>
            <TabsContent value="outputs">
              <WorkflowOutputs
                tenantId={tenantId}
                me={me}
                definitions={definitions}
                lookup={lookup}
                write={write}
              />
            </TabsContent>
            <TabsContent value="intakes">
              <WorkflowModuleIntakes
                tenantId={tenantId}
                me={me}
                definitions={definitions}
                lookup={lookup}
                write={write}
              />
            </TabsContent>
            <TabsContent value="operations">
              <WorkflowOperations
                tenantId={tenantId}
                write={write}
                openRun={(id) => void openRun(id)}
              />
            </TabsContent>
          </Tabs>
        )}
        {!loading && !spec && !runId && view === 'groups' && (
          <WorkflowGroups
            groups={groups}
            lookup={lookup}
            me={me}
            tenantId={tenantId}
            write={write}
            onChanged={loadDefinitions}
          />
        )}
        {spec && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button variant="ghost" onClick={() => void navigate('definitions')}>
                <ArrowLeft />
                Danh sách quy trình
              </Button>
              <div className="flex flex-wrap gap-2">
                {dirty && <Badge variant="outline">Chưa lưu thay đổi</Badge>}
                {editing?.canDesign && (
                  <ConfigurationTransferControls
                    kind="workflow"
                    target={editing.id}
                    tenantId={tenantId}
                    csrfToken={me.csrfToken}
                    disabled={busy || dirty}
                    onImported={async () => {
                      const data = await api<{ items: DefinitionItem[] }>(
                        '/api/v1/workflows/definitions?tenantId=' + tenantId,
                      );
                      setDefinitions(data.items);
                      const current = data.items.find((d) => d.id === editing.id);
                      if (current) edit(current);
                      else throw new Error('Workflow unavailable after import');
                    }}
                  />
                )}
                {!readOnly && (
                  <Button variant="outline" disabled={busy} onClick={() => void save()}>
                    <Save />
                    Lưu bản nháp
                  </Button>
                )}
                {editing?.canPublish && (
                  <Button disabled={busy || dirty} onClick={publish}>
                    <CheckCheck />
                    Phát hành
                  </Button>
                )}
              </div>
            </div>
            <Tabs value={editorTab} onValueChange={setEditorTab}>
              <TabsList className="w-fit max-w-full">
                <TabsTrigger value="info">Thông tin & đối tượng</TabsTrigger>
                <TabsTrigger value="flow">Luồng xử lý</TabsTrigger>
                <TabsTrigger value="form">Biểu mẫu</TabsTrigger>
                <TabsTrigger value="field-access">Quyền dữ liệu</TabsTrigger>
              </TabsList>
              <TabsContent value="field-access" className="mt-5">
                <FieldAccessEditor spec={spec} onChange={updateSpec} disabled={readOnly} />
              </TabsContent>
              <TabsContent value="info" className="mt-5">
                <Card>
                  <CardContent className="grid gap-5 pt-6 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="workflow-name">Tên quy trình</Label>
                      <Input
                        id="workflow-name"
                        value={spec.name}
                        disabled={readOnly}
                        onChange={(event) => updateSpec({ ...spec, name: event.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="workflow-code">Mã quy trình</Label>
                      <Input
                        id="workflow-code"
                        value={code}
                        disabled={!!editing || readOnly}
                        onChange={(event) => setCode(event.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="workflow-category">Nhóm quy trình</Label>
                      <Input
                        id="workflow-category"
                        value={spec.category}
                        disabled={readOnly}
                        onChange={(event) => updateSpec({ ...spec, category: event.target.value })}
                      />
                    </div>
                    <Choice
                      label="Đơn vị quản lý"
                      value={unit}
                      onChange={setUnit}
                      disabled={!!editing || readOnly}
                      options={lookup.units}
                    />
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="workflow-description">Hướng dẫn</Label>
                      <Textarea
                        id="workflow-description"
                        value={spec.description}
                        disabled={readOnly}
                        onChange={(event) =>
                          updateSpec({ ...spec, description: event.target.value })
                        }
                      />
                    </div>
                    <fieldset className="space-y-3 md:col-span-2">
                      <legend className="mb-2 font-medium">Đơn vị được khởi chạy</legend>
                      <UnitPicker
                        options={lookup.units}
                        value={spec.audienceUnits}
                        disabled={readOnly}
                        onChange={(audienceUnits) => updateSpec({ ...spec, audienceUnits })}
                      />
                      <p className="text-sm text-muted-foreground">
                        Nhân viên còn cần quyền khởi tạo của ứng dụng và quan hệ công tác hiện hành.
                      </p>
                    </fieldset>
                  </CardContent>
                </Card>
                <CalendarEditor spec={spec} onChange={updateSpec} disabled={readOnly} />
              </TabsContent>
              <TabsContent value="flow" className="mt-5">
                <WorkflowCanvas
                  spec={spec}
                  onChange={updateSpec}
                  lookup={lookup}
                  readOnly={readOnly}
                  onEditForm={(id) => {
                    setFormNode(id);
                    setEditorTab('form');
                  }}
                />
                <p className="mt-3 text-sm text-muted-foreground">
                  Kéo bước từ thanh công cụ hoặc chọn bước đích trong bảng cấu hình. Thiết lập đường
                  quay lại ở mục Khi trả về hoặc Khi từ chối.
                </p>
              </TabsContent>
              <TabsContent value="form" className="mt-5 space-y-4">
                <Choice
                  label="Biểu mẫu của bước"
                  value={formNode}
                  onChange={setFormNode}
                  options={[
                    { id: 'input', name: 'Khởi tạo lượt chạy' },
                    ...spec.nodes
                      .filter(
                        (node) => (node.kind === 'task' || node.kind === 'approval') && node.form,
                      )
                      .map((node) => ({ id: node.id, name: node.label })),
                  ]}
                />
                {formSchema &&
                  (readOnly ? (
                    <AnswerReadback schema={formSchema} answers={{}} />
                  ) : (
                    <FormDesigner
                      business
                      schema={formSchema}
                      onSave={() => void save()}
                      busy={busy}
                      onChange={(schema) =>
                        updateSpec(
                          formNode === 'input'
                            ? { ...spec, input: schema }
                            : {
                                ...spec,
                                nodes: spec.nodes.map((node) =>
                                  node.id === formNode
                                    ? ({ ...node, form: schema } as HumanStep)
                                    : node,
                                ),
                              },
                        )
                      }
                    />
                  ))}
              </TabsContent>
            </Tabs>
          </>
        )}
        {!loading && !spec && !runId && view === 'definitions' && (
          <>
            <div className="flex flex-wrap justify-between gap-4">
              <div className="max-w-md flex-1 space-y-2">
                <Label htmlFor="workflow-search">Tìm quy trình</Label>
                <Input
                  id="workflow-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Tên hoặc mã quy trình"
                />
              </div>
              <div className="flex items-end gap-2">
                <Button variant="outline" onClick={() => void loadDefinitions().catch(setError)}>
                  <RefreshCw />
                  Tải lại
                </Button>
                {has('workflows:design') && (
                  <Button onClick={() => setTemplates(true)}>
                    <Plus />
                    Tạo quy trình
                  </Button>
                )}
              </div>
            </div>
            <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
              {definitions
                .filter((item) =>
                  (item.name + ' ' + item.code).toLowerCase().includes(search.toLowerCase()),
                )
                .map((item) => (
                  <Card key={item.id} className="border-t-4 border-t-primary">
                    <CardHeader>
                      <div className="mb-3 flex items-center justify-between">
                        <span className="rounded-lg bg-secondary p-3">
                          <GitBranch className="size-5 text-[var(--brand-navy)]" />
                        </span>
                        <Badge variant="outline">{stateLabels[item.status]}</Badge>
                      </div>
                      <CardTitle>{item.name}</CardTitle>
                      <CardDescription>
                        {item.category} · {item.code}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <p className="text-sm text-muted-foreground">
                        {item.version
                          ? 'Phiên bản ' +
                            item.version.version +
                            ' · ' +
                            item.version.spec.nodes.length +
                            ' bước'
                          : 'Chưa phát hành'}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {(item.canDesign || item.canPublish) && (
                          <Button variant="outline" onClick={() => edit(item)}>
                            {item.canDesign ? 'Thiết kế' : 'Xem & phát hành'}
                          </Button>
                        )}
                        {(item.canDesign || item.canPublish) && item.latest_version > 0 && (
                          <Button
                            variant="outline"
                            onClick={(event) => {
                              versionHistoryTrigger.current = event.currentTarget;
                              setVersionHistory(item);
                            }}
                          >
                            Lịch sử phiên bản
                          </Button>
                        )}
                        {item.startUnits.length > 0 && (
                          <Button onClick={() => startDefinition(item)}>
                            <Play />
                            Khởi chạy
                          </Button>
                        )}
                        {item.canPublish && item.latest_version > 0 && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              confirm({
                                title:
                                  item.status === 'paused'
                                    ? 'Mở phát hành lại?'
                                    : 'Ngừng phát hành?',
                                description:
                                  'Lượt chạy đang xử lý vẫn giữ phiên bản hiện tại. Thao tác chỉ thay đổi khả năng tạo lượt chạy mới.',
                                action: async (reason) => {
                                  await write(
                                    '/definitions/' + item.id + '/status',
                                    {
                                      expectedRevision: item.revision,
                                      status: item.status === 'paused' ? 'published' : 'paused',
                                    },
                                    reason,
                                  );
                                  await loadDefinitions();
                                },
                              })
                            }
                          >
                            <Pause />
                            {item.status === 'paused' ? 'Mở lại' : 'Ngừng phát hành'}
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </div>
            {!definitions.length && (
              <Card>
                <CardContent className="space-y-3 py-12 text-center">
                  <GitBranch className="mx-auto size-10 text-primary" />
                  <h2 className="text-lg font-semibold">Bắt đầu từ một quy trình rõ ràng</h2>
                  <p className="text-muted-foreground">
                    Tạo từ mẫu, xác định người xử lý và phát hành cho đơn vị phù hợp.
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}
        {!loading && !spec && !runId && isWorkspaceView(view) && (
          <WorkflowWorkspace
            key={tenantId + ':' + view}
            tenantId={tenantId}
            view={view}
            units={lookup.units}
            write={write}
            onOpen={openRun}
          />
        )}
        {!loading && !spec && !runId && view === 'documents' && (
          <WorkflowDocuments
            key={tenantId}
            tenantId={tenantId}
            me={me}
            units={lookup.units}
            definitions={definitions}
            write={write}
            start={startDefinition}
          />
        )}
        {!loading && !spec && !runId && view === 'report' && report && (
          <>
            <p className="text-sm text-muted-foreground">
              Tổng hợp theo phạm vi đơn vị được cấp; quá hạn vẫn được xử lý và giữ dấu thời gian.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[...report.states, { status: 'overdue', count: report.overdue }].map((row) => (
                <Card key={row.status}>
                  <CardHeader>
                    <CardDescription>
                      {stateLabels[row.status] ?? 'Nhiệm vụ quá hạn'}
                    </CardDescription>
                    <CardTitle className="text-3xl text-[var(--brand-navy)]">{row.count}</CardTitle>
                  </CardHeader>
                </Card>
              ))}
            </div>
            <WorkflowPerformanceReport
              key={tenantId}
              tenantId={tenantId}
              me={me}
              units={lookup.units}
              onOpen={openRun}
            />
          </>
        )}
        {!loading && !spec && detail && (
          <>
            <div className="flex flex-wrap justify-between gap-3">
              <Button
                variant="ghost"
                onClick={() =>
                  void navigate(
                    isWorkspaceView(view) || view === 'report'
                      ? view
                      : detail.following
                        ? 'followed'
                        : has('workflows:act')
                          ? 'inbox'
                          : has('workflows:start')
                            ? 'mine'
                            : 'all',
                  )
                }
              >
                <ArrowLeft />
                {view === 'report' ? 'Về báo cáo' : 'Danh sách lượt chạy'}
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => void loadRun(detail.run.id).catch(setError)}
                >
                  <RefreshCw />
                  Tải lại lượt chạy
                </Button>
                {detail.canRecallSubmission && (
                  <Button variant="outline" onClick={() => confirmRecall(detail)}>
                    Thu hồi hồ sơ
                  </Button>
                )}
                {['running', 'needs_revision'].includes(detail.run.status) &&
                  (detail.run.owner_account_id === me.accountId || detail.canManage) && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        confirm({
                          title: 'Hủy lượt chạy?',
                          description:
                            'Dừng nhiệm vụ đang chờ. Lịch sử và thông tin đã gửi vẫn được giữ.',
                          action: async (reason) => {
                            await write(
                              '/runs/' + detail.run.id + '/cancel',
                              { expectedRevision: detail.run.revision },
                              reason,
                            );
                            await loadRun(detail.run.id);
                          },
                        })
                      }
                    >
                      Hủy lượt chạy
                    </Button>
                  )}
              </div>
            </div>
            <Card>
              <CardContent className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold break-words">{detail.version.spec.name}</p>
                    <Badge variant="secondary">{stateLabels[detail.run.status]}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Phiên bản {detail.version.version} · Lần gửi {detail.run.round}
                  </p>
                  <dl className="mt-3 text-sm">
                    <dt className="text-muted-foreground">Mã hồ sơ</dt>
                    <dd className="mt-1 font-mono break-all">{detail.run.id}</dd>
                  </dl>
                </div>
                {pending && (
                  <div className="text-sm">
                    <p className="font-medium">
                      {pending.label} · {pending.assignee_name}
                    </p>
                    <p className={pending.overdue ? 'text-destructive' : 'text-muted-foreground'}>
                      <Clock3 className="mr-1 inline size-4" />
                      {pending.overdue ? 'Quá hạn · ' : ''}
                      {new Date(pending.due_at).toLocaleString('vi-VN')}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
            {!detail.relatedTaskId && (
              <LinkedWorkflowDocuments
                tenantId={tenantId}
                versionId={detail.version.id}
                refreshOn={detail.run}
              />
            )}
            {!detail.relatedTaskId && (
              <RelatedWorkflowRequests
                key={detail.run.id + ':' + detail.run.revision}
                runId={detail.run.id}
                tenantId={tenantId}
                openRun={openRun}
                openDraft={async (id) =>
                  resumeDraft(
                    await api<RequestDraftDetail>(
                      '/api/v1/workflows/requests/' + id + '?' + new URLSearchParams({ tenantId }),
                    ),
                  )
                }
              />
            )}
            <Tabs
              defaultValue={
                detail.relatedTaskId
                  ? 'discussion'
                  : runLocation()[2] === 'history'
                    ? 'history'
                    : 'content'
              }
            >
              <TabsList
                className="grid w-full grid-cols-2 sm:inline-flex sm:w-fit"
                aria-label="Nội dung hồ sơ"
              >
                <TabsTrigger value="content">Thông tin & xử lý</TabsTrigger>
                <TabsTrigger value="files">Tệp đính kèm</TabsTrigger>
                <TabsTrigger value="flow">Sơ đồ tiến độ</TabsTrigger>
                <TabsTrigger value="history">Lịch sử</TabsTrigger>
                {!detail.relatedTaskId && <TabsTrigger value="print">Mẫu in</TabsTrigger>}
                <TabsTrigger value="discussion" className="col-span-2">
                  Trao đổi
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="content"
                className="grid min-w-0 grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]"
              >
                <Card className="min-w-0">
                  <CardHeader>
                    <CardTitle>Thông tin đề nghị</CardTitle>
                    <CardDescription>{detail.version.spec.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {detail.run.status === 'completed' && !detail.relatedTaskId && (
                      <WorkflowTrainingIntake
                        key={detail.run.id}
                        tenantId={tenantId}
                        runId={detail.run.id}
                      />
                    )}
                    {detail.run.source_context && (
                      <section
                        className="mb-5 space-y-3 rounded-lg border bg-secondary p-4"
                        aria-label="Đề xuất hồ sơ nhân sự"
                      >
                        <h3 className="font-semibold">
                          Đề xuất hồ sơ · {detail.run.source_context.subjectName}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          Duyệt nội dung chốt dưới đây. HR sẽ kiểm tra và áp dụng sau khi quy trình
                          hoàn thành.
                        </p>
                        <dl className="space-y-3 text-sm">
                          {detail.run.source_context.changes.map((change, i) => (
                            <div key={i}>
                              <dt className="font-medium">{change.label}</dt>
                              <dd className="break-words">Trước: {change.before}</dd>
                              <dd className="break-words">Đề xuất: {change.after}</dd>
                            </div>
                          ))}
                        </dl>
                      </section>
                    )}
                    <AnswerReadback
                      schema={detail.version.spec.input}
                      answers={detail.run.inputs}
                      attachmentContext={attachmentContext}
                    />
                  </CardContent>
                </Card>
                <div className="min-w-0 space-y-5">
                  {detail.taskActions.length > 1 && (
                    <Choice
                      label="Nhiệm vụ đang mở"
                      value={pending?.id ?? ''}
                      onChange={(taskId) => {
                        window.history.replaceState(
                          null,
                          '',
                          '#workflow-run/' + detail.run.id + '/' + taskId,
                        );
                        activateTask(detail, taskId);
                      }}
                      options={detail.taskActions.flatMap((action) => {
                        const task = detail.tasks.find((item) => item.id === action.taskId);
                        return task ? [{ id: task.id, name: task.label }] : [];
                      })}
                    />
                  )}
                  {detail.run.status === 'needs_revision' &&
                    detail.run.owner_account_id === me.accountId && (
                      <Card>
                        <CardHeader>
                          <CardTitle>Bổ sung và gửi lại</CardTitle>
                          <CardDescription>
                            Luồng được chạy lại theo phiên bản gốc; thông tin và quyết định trước đó
                            vẫn được giữ.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <FormRenderer
                            schema={detail.version.spec.input}
                            referenceContext={{ tenantId, unitId: detail.run.org_unit_id }}
                            attachmentContext={{
                              ...attachmentContext,
                              ...(!detail.run.source_context && {
                                upload: (field, files) =>
                                  uploadFiles(() => '/runs/' + detail.run.id, field, files),
                              }),
                            }}
                            answers={revisedAnswers}
                            onChange={setRevisedAnswers}
                            disabled={busy || !!detail.run.source_context}
                          />
                          {detail.run.source_context && (
                            <p className="text-sm text-muted-foreground">
                              Đề xuất liên kết giữ nguyên nội dung đã chốt. Muốn sửa thông tin hồ
                              sơ, hãy rút đề xuất và tạo đề xuất mới.
                            </p>
                          )}
                          <WorkflowSelectionFields
                            options={revisionOptions}
                            values={revisionSelections}
                            onChange={setRevisionSelections}
                            loading={revisionLoading}
                          />
                          {Boolean(revisionError) && (
                            <Alert variant="destructive">
                              <AlertDescription>{explain(revisionError)}</AlertDescription>
                            </Alert>
                          )}
                          <Button
                            disabled={
                              revisionLoading ||
                              !!revisionError ||
                              revisionOptions.some((option) => !revisionSelections[option.stepId])
                            }
                            onClick={() =>
                              confirm({
                                title: 'Gửi lại đề nghị?',
                                description: 'Tạo một vòng xử lý mới theo thông tin đã bổ sung.',
                                action: async (reason) => {
                                  await write(
                                    '/runs/' + detail.run.id + '/resubmit',
                                    {
                                      expectedRevision: detail.run.revision,
                                      answers: revisedAnswers,
                                      selections: revisionSelections,
                                    },
                                    reason,
                                  );
                                  await loadRun(detail.run.id);
                                },
                              })
                            }
                          >
                            Gửi lại đề nghị
                          </Button>
                        </CardContent>
                      </Card>
                    )}
                  {pending?.approval_policy && (
                    <PoolProgress
                      task={pending}
                      node={currentNode}
                      form={currentTaskForm}
                      attachmentContext={attachmentContext}
                    />
                  )}
                  {actorTask && currentNode && (
                    <Card>
                      <CardHeader>
                        <CardTitle>
                          {pending.kind === 'approval' ? 'Ý kiến phê duyệt' : 'Thực hiện công việc'}
                        </CardTitle>
                        <CardDescription>
                          Nội dung đã gửi được giữ nguyên; thao tác xử lý được ghi vào lịch sử.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {currentReadback && (
                          <section
                            aria-label="Thông tin đề nghị chỉ xem"
                            className="space-y-3 rounded-lg border bg-muted/30 p-4"
                          >
                            <h3 className="font-medium">Thông tin đề nghị chỉ xem</h3>
                            <AnswerReadback
                              schema={currentReadback}
                              answers={detail.run.inputs}
                              attachmentContext={attachmentContext}
                            />
                          </section>
                        )}
                        {currentTaskForm && (
                          <FormRenderer
                            key={pending.id}
                            schema={currentTaskForm}
                            disabled={busy}
                            referenceContext={{ tenantId, unitId: detail.run.org_unit_id }}
                            attachmentContext={{
                              ...attachmentContext,
                              upload: (field, files) =>
                                uploadFiles(() => '/tasks/' + pending.id, field, files),
                            }}
                            answers={taskAnswers}
                            onChange={setTaskAnswers}
                          />
                        )}
                        <div className="flex flex-wrap gap-2">
                          {(pending.kind === 'approval'
                            ? ['approve', 'reject', 'return']
                            : ['complete', 'return']
                          )
                            .filter(
                              (action) => action !== 'return' || currentNode.allowReturn !== false,
                            )
                            .map((value) => {
                              const action = value as WorkflowAction;
                              const data = {
                                expectedRevision: pending.revision,
                                action,
                                answers: taskAnswers,
                              };
                              const mode = priorStepMode(currentNode, action);
                              const previous =
                                mode === 'previous' ? selectedAction?.returnTargets[0] : undefined;
                              const ends = action === 'return' && currentNode.returnMode === 'end';
                              const needsPreview =
                                !!mode ||
                                decisionPath(
                                  detail.version.spec.nodes,
                                  actionDestination(currentNode, action),
                                ).some(selectsAtHandoff);
                              return (
                                <Button
                                  key={action}
                                  variant={
                                    ['approve', 'complete'].includes(action) ? 'default' : 'outline'
                                  }
                                  onClick={() =>
                                    confirm({
                                      title: (
                                        {
                                          approve: 'Phê duyệt đề nghị?',
                                          reject: 'Từ chối đề nghị?',
                                          complete: 'Hoàn tất công việc?',
                                          return: ends
                                            ? 'Kết thúc lượt chạy?'
                                            : mode
                                              ? 'Trả về bước xử lý?'
                                              : 'Trả về người khởi tạo?',
                                        } as Record<string, string>
                                      )[action]!,
                                      description:
                                        mode === 'choose'
                                          ? 'Chọn một bước đã xử lý hoặc người khởi tạo. Các quyết định cũ được giữ trong nhật ký.'
                                          : previous?.stepId
                                            ? 'Hồ sơ sẽ quay về bước ' +
                                              previous.name +
                                              ' để xử lý lại.'
                                            : ends
                                              ? 'Lượt chạy sẽ dừng và lưu quyết định vào nhật ký.'
                                              : action === 'return' || previous
                                                ? 'Người gửi sẽ bổ sung thông tin và gửi lại. Các quyết định của vòng cũ được giữ.'
                                                : 'Quyết định gắn với nhiệm vụ hiện tại và không được sửa sau khi lưu.',
                                      returnTargets:
                                        mode === 'choose'
                                          ? selectedAction?.returnTargets
                                          : undefined,
                                      preview: needsPreview
                                        ? (signal, target) =>
                                            api<HandoffPreview>(
                                              '/api/v1/workflows/tasks/' +
                                                pending.id +
                                                '/handoff-preview',
                                              {
                                                method: 'POST',
                                                signal,
                                                headers: {
                                                  'content-type': 'application/json',
                                                  'x-csrf-token': me.csrfToken,
                                                },
                                                body: JSON.stringify({
                                                  ...data,
                                                  tenantId,
                                                  ...(target && { returnTarget: target }),
                                                }),
                                              },
                                            )
                                        : undefined,
                                      action: async (reason, recipients, target) => {
                                        await write(
                                          '/tasks/' + pending.id + '/action',
                                          {
                                            ...data,
                                            ...(recipients?.length === 1 && {
                                              handoff: recipients[0],
                                            }),
                                            ...(recipients &&
                                              recipients.length > 1 && { handoffs: recipients }),
                                            ...(target && { returnTarget: target }),
                                          },
                                          reason,
                                        );
                                        await loadRun(detail.run.id);
                                      },
                                    })
                                  }
                                >
                                  {
                                    (
                                      {
                                        approve: 'Phê duyệt',
                                        reject: 'Từ chối',
                                        complete: 'Hoàn tất bước',
                                        return: 'Trả về',
                                      } as Record<string, string>
                                    )[action]
                                  }
                                </Button>
                              );
                            })}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  {pending && selectedAction?.canReassign && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Điều phối</CardTitle>
                        <CardDescription>
                          Chuyển nhiệm vụ cho người có quyền phù hợp; không thay đổi thời hạn hoặc
                          kết quả.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setReassigning(pending);
                            setNewAssignee('');
                            setReplaceAccountId('');
                          }}
                        >
                          Phân công lại
                        </Button>
                      </CardContent>
                    </Card>
                  )}
                  {!actorTask &&
                    detail.run.status === 'running' &&
                    (!detail.relatedTaskId || pending) && (
                      <Alert>
                        <AlertDescription>
                          {selectedAction?.assignmentUnavailable
                            ? 'Người được giao hoặc nhóm xử lý không còn đủ điều kiện. Điều phối viên cần đối soát quyền hoặc phân công lại.'
                            : 'Lượt chạy đang chờ ' +
                              (pending?.assignee_name ?? 'người được giao') +
                              ' xử lý.'}
                        </AlertDescription>
                      </Alert>
                    )}
                  {detail.recallTargets.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Bước có thể thu hồi</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-3">
                          {detail.recallTargets.map((target) => (
                            <li
                              key={target.taskId}
                              className="flex flex-wrap items-center justify-between gap-2"
                            >
                              <span className="text-sm font-medium">{target.label}</span>
                              <Button
                                variant="outline"
                                aria-label={'Thu hồi bước ' + target.label}
                                onClick={() => confirmRecall(detail, target.taskId)}
                              >
                                Thu hồi bước
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}
                </div>
              </TabsContent>
              <TabsContent value="discussion" className="space-y-4">
                {detail.discussionSteps.length > 0 && (
                  <div className="max-w-lg">
                    <Choice
                      label="Phạm vi trao đổi"
                      value={discussionScope || '_run'}
                      options={[
                        ...(!detail.relatedTaskId ? [{ id: '_run', name: 'Toàn hồ sơ' }] : []),
                        ...detail.discussionSteps.map((step) => ({
                          id: step.id,
                          name:
                            step.label + ' · Lần gửi ' + step.round + ', lần xử lý ' + step.attempt,
                        })),
                      ]}
                      onChange={(scope) => {
                        if (detail.relatedTaskId && scope !== detail.relatedTaskId) {
                          void openRun(detail.run.id, scope);
                        } else {
                          setDiscussionScope(scope === '_run' ? '' : scope);
                        }
                      }}
                    />
                  </div>
                )}
                <DiscussionPanel
                  key={tenantId + ':' + detail.run.id + ':' + discussionScope}
                  tenantId={tenantId}
                  runId={detail.run.id}
                  taskId={discussionScope || undefined}
                  write={write}
                />
              </TabsContent>
              {!detail.relatedTaskId && (
                <TabsContent value="print">
                  <RunPrintTemplates
                    key={detail.run.id}
                    tenantId={tenantId}
                    runId={detail.run.id}
                  />
                </TabsContent>
              )}
              <TabsContent value="files">
                <Card>
                  <CardContent>
                    {detail.attachments.length ? (
                      <AttachmentLinks
                        ids={detail.attachments.map((file) => file.id)}
                        context={attachmentContext}
                      />
                    ) : (
                      <p className="text-muted-foreground">Không có tệp để hiển thị.</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="flow" className="space-y-5">
                {detail.taskActions.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Các bước đang chờ</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="grid gap-3 sm:grid-cols-2">
                        {detail.tasks
                          .filter((task) =>
                            detail.taskActions.some((item) => item.taskId === task.id),
                          )
                          .map((task) => (
                            <li key={task.id} className="min-w-0 rounded-md border p-3 break-words">
                              <p className="font-medium">{task.label}</p>
                              <p className="mt-1 text-muted-foreground">{task.assignee_name}</p>
                              <time
                                className={
                                  task.overdue ? 'text-destructive' : 'text-muted-foreground'
                                }
                                dateTime={task.due_at}
                              >
                                {task.overdue ? 'Quá hạn · ' : 'Hạn '}
                                {new Date(task.due_at).toLocaleString('vi-VN')}
                              </time>
                            </li>
                          ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}
                {!detail.following && (
                  <WorkflowCanvas
                    spec={detail.version.spec}
                    onChange={() => {}}
                    lookup={lookup}
                    readOnly
                    activeStep={detail.run.current_step}
                  />
                )}
                {detail.following && detail.taskActions.length === 0 && (
                  <p className="text-muted-foreground">Không có bước đang chờ.</p>
                )}
              </TabsContent>
              <TabsContent value="history" className="space-y-5">
                <Card>
                  <CardHeader>
                    <CardTitle>Nhật ký xử lý</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ol className="space-y-5 border-l-2 border-border pl-5">
                      {detail.history.map((event) => (
                        <li key={event.id}>
                          <p className="font-medium">
                            {actionLabels[event.action] ?? event.action}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-sm">{event.reason}</p>
                          <time className="mt-1 block text-xs text-muted-foreground">
                            {new Date(event.occurred_at).toLocaleString('vi-VN')}
                          </time>
                        </li>
                      ))}
                    </ol>
                  </CardContent>
                </Card>
                {detail.tasks
                  .filter(
                    (task) =>
                      (task.answers && task.action) ||
                      task.approval_policy ||
                      (runLocation()[2] === 'history' && task.id === runLocation()[1]),
                  )
                  .map((task) => {
                    const node = detail.version.spec.nodes.find(
                      (node) => node.id === task.node_id,
                    ) as HumanStep;
                    const form = stepActionForm(detail.version.spec.input, node);
                    const targeted = runLocation()[2] === 'history' && task.id === runLocation()[1];
                    return (
                      <div
                        key={task.id}
                        id={targeted ? 'workflow-task-history-' + task.id : undefined}
                        tabIndex={targeted ? -1 : undefined}
                        className={
                          targeted
                            ? 'rounded-xl focus-visible:ring-2 focus-visible:ring-ring'
                            : undefined
                        }
                      >
                        {task.approval_policy ? (
                          <PoolProgress
                            task={task}
                            node={node}
                            form={form}
                            attachmentContext={attachmentContext}
                          />
                        ) : (
                          <Card>
                            <CardHeader>
                              <CardTitle>
                                {task.label} · lần gửi {task.round} · lần xử lý {task.attempt}
                              </CardTitle>
                              <CardDescription>
                                {stateLabels[task.status]} ·{' '}
                                {(task.superseded_by_task_id || task.round !== detail.run.round) &&
                                  'Đã thay thế · '}
                                {task.reason}
                              </CardDescription>
                            </CardHeader>
                            {form && task.answers && (
                              <CardContent>
                                <AnswerReadback
                                  schema={form}
                                  answers={task.answers}
                                  attachmentContext={attachmentContext}
                                />
                              </CardContent>
                            )}
                          </Card>
                        )}
                      </div>
                    );
                  })}
                {detail.inputs
                  .filter((input) => input.round !== detail.run.round)
                  .map((input) => (
                    <Card key={input.round}>
                      <CardHeader>
                        <CardTitle>Đề nghị lần {input.round}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <AnswerReadback
                          schema={detail.version.spec.input}
                          answers={input.inputs}
                          attachmentContext={attachmentContext}
                        />
                      </CardContent>
                    </Card>
                  ))}
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>
      {versionHistory && (
        <WorkflowVersionHistory
          definition={versionHistory}
          tenantId={tenantId}
          onClose={() => {
            setVersionHistory(null);
            requestAnimationFrame(() => versionHistoryTrigger.current?.focus());
          }}
          onRestore={(version, expectedRevision) => {
            const definitionId = versionHistory.id;
            setVersionHistory(null);
            confirm({
              title: 'Khôi phục phiên bản v' + version.version + '?',
              description:
                'Cấu hình đã chọn sẽ được phát hành thành một phiên bản mới cho các hồ sơ khởi chạy tiếp theo.',
              action: async (reason) => {
                const restored = await write<{ version: { version: number } }>(
                  '/definitions/' + definitionId + '/versions/restore',
                  { expectedRevision, sourceVersionId: version.id },
                  reason,
                );
                await navigate('definitions');
                return (
                  'Đã phát hành v' +
                  restored.version.version +
                  ' từ cấu hình v' +
                  version.version +
                  '.'
                );
              },
            });
          }}
        />
      )}
      <Dialog open={templates} onOpenChange={setTemplates}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Thư viện quy trình</DialogTitle>
            <DialogDescription>
              Chọn mẫu rồi thiết lập người xử lý, đối tượng và điều kiện phù hợp.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                {
                  kind: 'purchase-lines',
                  name: 'Mua sắm — Bảng chi tiết',
                  description:
                    'Nhập từng mặt hàng, tự tính thành tiền và phân cấp duyệt theo tổng.',
                },
                {
                  kind: 'purchase',
                  name: 'Đề nghị mua sắm',
                  description: 'Duyệt nhiều bước, rẽ nhánh theo giá trị và thực hiện mua sắm.',
                },
                {
                  kind: 'leave',
                  name: 'Đề nghị nghỉ phép',
                  description: 'Gửi đề nghị, xem xét và trả kết quả.',
                },
                {
                  kind: 'blank',
                  name: 'Tự thiết kế',
                  description: 'Bắt đầu từ luồng ngắn và bổ sung bước.',
                },
              ] as const
            ).map((item) => (
              <Card key={item.kind}>
                <CardHeader>
                  <FileText className="mb-2 text-primary" />
                  <CardTitle>{item.name}</CardTitle>
                  <CardDescription>{item.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button variant="outline" onClick={() => create(item.kind)}>
                    Dùng mẫu
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!starting}
        onOpenChange={(open) => {
          if (!open) setStarting(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto overflow-x-hidden grid-cols-[minmax(0,1fr)] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Khởi chạy quy trình</DialogTitle>
            <DialogDescription>
              {starting?.name} · Hồ sơ nháp chỉ mình bạn xem.
              {!requestDraft?.blockedReason &&
                ' Khi gửi, dữ liệu được chia sẻ theo quyền hồ sơ và quyền từng trường.'}
            </DialogDescription>
          </DialogHeader>
          {starting?.version && (
            <div className="space-y-5">
              <LinkedWorkflowDocuments tenantId={tenantId} versionId={starting.version.id} />
              {!draftCanSubmit && (
                <Alert>
                  <AlertDescription>
                    {requestDraft?.blockedReason
                      ? errorMessage(new ApiError(409, requestDraft.blockedReason))
                      : 'Phiên bản này đã ngừng nhận hồ sơ mới. Tạo hồ sơ từ phiên bản đang phát hành để gửi.'}
                  </AlertDescription>
                </Alert>
              )}
              <div className="space-y-2">
                <Label htmlFor="run-title">Tiêu đề lượt chạy</Label>
                <Input
                  id="run-title"
                  value={startTitle}
                  disabled={!!requestDraft?.blockedReason}
                  onChange={(event) => setStartTitle(event.target.value)}
                />
              </div>
              <Choice
                label="Đơn vị khởi tạo"
                value={startUnit}
                onChange={(unit) => {
                  if (!requestDraft) setStartUnit(unit);
                }}
                options={lookup.units.filter((unit) => starting.startUnits.includes(unit.id))}
                disabled={!!requestDraft?.blockedReason}
              />
              <FormRenderer
                schema={starting.version.spec.input}
                referenceContext={{ tenantId, unitId: startUnit }}
                attachmentContext={{
                  ...attachmentContext,
                  ...(requestDraft?.blockedReason
                    ? { unavailableMessage: 'Có thể xem tệp đã lưu.' }
                    : startTitle.trim() && startUnit
                      ? {
                          upload: (field, files) =>
                            uploadFiles(attachmentDraftTarget, field, files),
                        }
                      : { unavailableMessage: 'Nhập tiêu đề và chọn đơn vị để đính kèm tệp.' }),
                }}
                answers={startAnswers}
                disabled={busy || !!requestDraft?.blockedReason}
                onChange={setStartAnswers}
              />
              {requestDraft && (
                <p className="text-sm text-muted-foreground">
                  Nháp đã lưu · Phiên bản {starting.version.version}. Đơn vị của nháp được giữ
                  nguyên.
                </p>
              )}
              {requestDraft?.linkedSource && (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto max-w-full whitespace-normal break-words text-left"
                  onClick={() => {
                    setStarting(null);
                    const { runId, taskId } = requestDraft.linkedSource!;
                    void openRun(runId, taskId);
                  }}
                >
                  Hồ sơ nguồn · {requestDraft.linkedSource.title}
                </Button>
              )}
              {draftNotice && (
                <p role="status" className="text-sm text-[var(--success)]">
                  {draftNotice}
                </p>
              )}
              <Button
                variant="outline"
                disabled={busy || !!requestDraft?.blockedReason}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await saveRequestDraft();
                    setDraftNotice('Đã lưu nháp hồ sơ. Có thể đóng và mở lại từ Nháp của tôi.');
                  } catch (e) {
                    setError(e);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Save />
                Lưu nháp hồ sơ
              </Button>
              <WorkflowSelectionFields
                options={startOptions}
                values={startSelections}
                onChange={setStartSelections}
                loading={startSelectionLoading}
              />
              {Boolean(startSelectionError) && (
                <Alert variant="destructive">
                  <AlertDescription>{explain(startSelectionError)}</AlertDescription>
                </Alert>
              )}
              {error !== null && (
                <Alert variant="destructive">
                  <AlertDescription>{explain(error)}</AlertDescription>
                </Alert>
              )}
              <Button
                disabled={
                  busy ||
                  !draftCanSubmit ||
                  startSelectionLoading ||
                  !!startSelectionError ||
                  startOptions.some((option) => !startSelections[option.stepId])
                }
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    if (requestDraft) {
                      const current = await api<RequestDraftDetail>(
                        '/api/v1/workflows/requests/' + requestDraft.id + '?tenantId=' + tenantId,
                      );
                      if (current.request.status === 'submitted' && current.request.run_id) {
                        setStarting(null);
                        await openRun(current.request.run_id);
                        return;
                      }
                    }
                    const draft = await saveRequestDraft();
                    const run = await write<WorkflowRun>(
                      '/requests/' + draft.id + '/submit',
                      { expectedRevision: draft.revision },
                      'Gửi hồ sơ đã kiểm tra',
                    );
                    setStarting(null);
                    await openRun(run.id);
                  } catch (e) {
                    setError(e);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Send />
                Gửi đề nghị
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogDescription>{confirmation?.description}</DialogDescription>
          </DialogHeader>
          {confirmation?.returnTargets && (
            <Choice
              label="Trả về"
              value={returnTarget || '_none'}
              onChange={(value) => {
                const target = value === '_none' ? '' : value;
                setReturnTarget(target);
                setHandoffs([]);
                setHandoffAccounts({});
                setPreviewReady(!confirmation.preview);
                setPreviewLoading(!!confirmation.preview && !!target);
                setConfirmationError(null);
              }}
              options={[{ id: '_none', name: 'Chọn đích trả về' }, ...confirmation.returnTargets]}
            />
          )}
          {previewLoading && (
            <p role="status" className="text-sm text-muted-foreground">
              Đang xác định người nhận bàn giao…
            </p>
          )}
          {handoffs.map((handoff) => (
            <div className="space-y-2" key={handoff.stepId}>
              <p className="text-sm">
                Bước tiếp theo là <strong>{handoff.label}</strong> · {handoff.groupName}
              </p>
              <Choice
                label={
                  handoffs.length === 1 ? 'Người nhận bàn giao' : 'Người nhận · ' + handoff.label
                }
                value={handoffAccounts[handoff.stepId] || '_none'}
                onChange={(value) =>
                  setHandoffAccounts((accounts) => ({
                    ...accounts,
                    [handoff.stepId]: value === '_none' ? '' : value,
                  }))
                }
                options={[{ id: '_none', name: 'Chọn người nhận' }, ...handoff.candidates]}
              />
              {!handoff.candidates.length && (
                <p role="alert" className="text-sm text-destructive">
                  Nhóm chưa có người đủ quyền nhận bàn giao.
                </p>
              )}
            </div>
          ))}
          <div className="space-y-2">
            <Label htmlFor="workflow-reason">Ý kiến / lý do</Label>
            <Textarea
              id="workflow-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={240}
              placeholder="Nhập ít nhất 5 ký tự"
            />
          </div>
          {confirmationError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{explain(confirmationError)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
              Quay lại
            </Button>
            <Button
              disabled={
                busy ||
                !previewReady ||
                (!!confirmation?.returnTargets && !returnTarget) ||
                handoffs.some((handoff) => !handoffAccounts[handoff.stepId]) ||
                reason.trim().length < 5
              }
              onClick={async () => {
                if (!confirmation) return;
                setBusy(true);
                try {
                  const success = await confirmation.action(
                    reason,
                    handoffs.map(({ stepId }) => ({ stepId, accountId: handoffAccounts[stepId]! })),
                    returnTarget || undefined,
                  );
                  setConfirmation(null);
                  setNotice(success ?? 'Đã ghi nhận thao tác.');
                } catch (e) {
                  setConfirmationError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Xác nhận
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!reassigning}
        onOpenChange={(open) => {
          if (!open) setReassigning(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Phân công lại nhiệm vụ</DialogTitle>
            <DialogDescription>
              Chọn người đủ quyền xử lý trong đơn vị của lượt chạy.
            </DialogDescription>
          </DialogHeader>
          {reassigning?.approval_policy && (
            <Choice
              label="Thành viên cần thay thế"
              value={replaceAccountId || '_none'}
              onChange={(v) => setReplaceAccountId(v === '_none' ? '' : v)}
              options={[
                { id: '_none', name: 'Chọn người chưa bỏ phiếu' },
                ...reassigning.members
                  .filter((m) => m.active && !m.action)
                  .map((m) => ({ id: m.account_id, name: m.name })),
              ]}
            />
          )}
          <Choice
            label="Người nhận nhiệm vụ"
            value={newAssignee || '_none'}
            onChange={(value) => setNewAssignee(value === '_none' ? '' : value)}
            options={[{ id: '_none', name: 'Chọn người nhận' }, ...reassignCandidates]}
          />
          {candidateLoading && <p role="status">Đang kiểm tra người có thể nhận…</p>}
          {Boolean(candidateError) && (
            <Alert variant="destructive">
              <AlertDescription>{explain(candidateError)}</AlertDescription>
            </Alert>
          )}
          <Button
            disabled={
              !newAssignee ||
              candidateLoading ||
              !!candidateError ||
              (!!reassigning?.approval_policy && !replaceAccountId)
            }
            onClick={() => {
              const task = reassigning!;
              setReassigning(null);
              confirm({
                title: 'Xác nhận phân công lại?',
                description: 'Người nhận cũ sẽ không còn được thao tác nhiệm vụ này.',
                action: async (reason) => {
                  await write(
                    '/tasks/' + task.id + '/reassign',
                    {
                      expectedRevision: task.revision,
                      accountId: newAssignee,
                      ...(task.approval_policy ? { replaceAccountId } : {}),
                    },
                    reason,
                  );
                  try {
                    await loadRun(detail!.run.id);
                  } catch (error) {
                    if (!(error instanceof ApiError && error.status === 403 && !detail!.canManage))
                      throw error;
                    await navigate(has('workflows:act') ? 'inbox' : 'mine');
                  }
                },
              });
            }}
          >
            Tiếp tục
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
