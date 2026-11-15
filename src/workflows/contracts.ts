import { parseFormSchema, schemaFields, isDate } from '../forms/contracts.js';
import type { FormSchema, FormField, Answers } from '../forms/contracts.js';
import { isTableAnswer } from '../forms/business.js';
import { parseFieldReaders, FieldAccessError } from './field-access.js';
import type { FieldReaders } from './field-access.js';
import { normalizeCondition, evaluateCondition } from './bos/condition-engine.js';
import type { ConditionGroupV1, RuleFieldDefinition } from './bos/condition-engine.js';
import { parseCalendar } from './calendar.js';
import type { BusinessCalendar } from './calendar.js';
import { stepInputCandidates, stepInputModes } from './step-input.js';
import type { StepInputMode } from './step-input.js';
import { guaranteedHumanSteps, nextSteps, parallelGraphIssue } from './execution-graph.js';
import type { ParallelJoin, ParallelSplit } from './execution-graph.js';
export { nextSteps } from './execution-graph.js';

export type AssigneeRule =
  | { kind: 'group'; groupId: string; selectionTiming?: 'handoff' }
  | { kind: 'previous'; stepId: string }
  | { kind: 'organization'; relation: 'manager' | 'unit-head' }
  | { kind: 'pool'; groupId: string; mode: 'all' | 'any' | 'quorum'; quorum?: number };
export const delegatedReassignmentRoles = ['assignee', 'sender'] as const;
export type DelegatedReassignmentRole = (typeof delegatedReassignmentRoles)[number];
export type WorkflowAction = 'approve' | 'reject' | 'complete' | 'return';
export type PriorStepMode = 'previous' | 'choose';
export type HumanStep = {
  id: string;
  label: string;
  kind: 'approval' | 'task';
  assignee: string;
  assigneeRule?: AssigneeRule;
  dueHours: number;
  deadlineMinutes?: number;
  deadlineMode?: 'elapsed' | 'business';
  allowReturn?: boolean;
  rejectNext?: string;
  returnMode?: PriorStepMode | 'end';
  rejectReturnMode?: PriorStepMode;
  reassignRoles?: DelegatedReassignmentRole[];
  next: string;
  form: FormSchema | null;
  inputFields?: Record<string, StepInputMode>;
};
export type WorkflowNode =
  | HumanStep
  | ParallelSplit
  | ParallelJoin
  | { id: string; label: string; kind: 'start'; next: string }
  | { id: string; label: string; kind: 'end' }
  | {
      id: string;
      label: string;
      kind: 'condition';
      condition: ConditionGroupV1;
      yes: string;
      no: string;
    };
export type WorkflowSpec = {
  fieldReaders?: FieldReaders;
  schemaVersion: 1 | 2 | 3 | 4 | 5;
  calendar?: BusinessCalendar;
  name: string;
  description: string;
  category: string;
  input: FormSchema;
  audienceUnits: string[];
  nodes: WorkflowNode[];
  positions: Record<string, { x: number; y: number }>;
};
export class WorkflowValidationError extends Error {
  readonly code = 'WORKFLOW_INVALID_DEFINITION';
  constructor(readonly issues: { path: string; code: string }[]) {
    super('WORKFLOW_INVALID_DEFINITION');
  }
}
const fail = (path: string, code: string): never => {
  throw new WorkflowValidationError([{ path, code }]);
};
const object = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'OBJECT_REQUIRED');
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: string[], path: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(path, 'UNKNOWN_PROPERTY');
}
function text(value: unknown, path: string, max = 200, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()))
    fail(path, 'TEXT_REQUIRED');
  return (value as string).trim();
}
export function workflowUuid(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    fail('id', 'UUID_REQUIRED');
}
const identifier = (value: unknown, path: string, empty = false) => {
  const result = text(value, path, 60, empty);
  if (result && !/^[a-z][a-z0-9_]{0,59}$/.test(result)) fail(path, 'INVALID_STEP_ID');
  return result;
};
export function workflowConditionFields(schema: FormSchema): FormField[] {
  return schemaFields(schema)
    .filter((field) => !['person', 'orgUnit'].includes(field.type))
    .flatMap<FormField>((field) =>
      field.type === 'table'
        ? (field.columns ?? [])
            .filter((c) => c.summarize)
            .map((c) => ({
              id: field.id + '__total_' + c.id,
              label: field.label + ' · Tổng ' + c.label,
              type: 'number' as const,
              required: false,
            }))
        : [
            {
              ...field,
              type:
                field.type === 'money'
                  ? 'number'
                  : field.type === 'attachment'
                    ? 'boolean'
                    : field.type,
            },
          ],
    );
}
export function workflowFields(schema: FormSchema): RuleFieldDefinition[] {
  return ruleFieldDefinitions(workflowConditionFields(schema));
}
function ruleFieldDefinitions(fields: FormField[]): RuleFieldDefinition[] {
  return fields.map((field) => ({
    code: field.id,
    type: (
      {
        shortText: 'TEXT',
        longText: 'TEXTAREA',
        number: 'NUMBER',
        integer: 'NUMBER',
        percentage: 'NUMBER',
        date: 'DATE',
        month: 'MONTH',
        time: 'TIME',
        dateTime: 'LOCAL_DATETIME',
        singleChoice: 'SELECT',
        multipleChoice: 'MULTI_SELECT',
        boolean: 'CHECKBOX',
        money: 'NUMBER',
        table: 'TEXT',
        person: 'TEXT',
        orgUnit: 'TEXT',
        attachment: 'CHECKBOX',
      } as const
    )[field.type],
  }));
}
export function actionDestination(step: HumanStep, action: WorkflowAction) {
  if (action === 'return') return undefined;
  return action === 'reject' ? step.rejectNext : step.next;
}

export function priorStepMode(step: HumanStep, action: WorkflowAction): PriorStepMode | undefined {
  if (action === 'reject') return step.rejectReturnMode;
  if (action === 'return' && step.allowReturn !== false && step.returnMode !== 'end')
    return step.returnMode;
  return undefined;
}

/** Collect potential next work across automatic transitions. */
export function decisionPath(nodes: WorkflowNode[], from?: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const reached = new Map<string, WorkflowNode>();
  const pending = from ? [from] : [];
  while (pending.length) {
    const node = byId.get(pending.pop()!);
    if (!node || reached.has(node.id)) continue;
    reached.set(node.id, node);
    if (!('form' in node)) pending.push(...nextSteps(node));
  }
  return [...reached.values()];
}

export const selectsAtHandoff = (node: WorkflowNode): node is HumanStep =>
  'assigneeRule' in node &&
  node.assigneeRule?.kind === 'group' &&
  node.assigneeRule.selectionTiming === 'handoff';
export function previousAssigneeSteps(nodes: WorkflowNode[], targetId: string) {
  return guaranteedHumanSteps(nodes, targetId);
}

function branchResultSources(nodes: WorkflowNode[], before?: string) {
  const candidates = before ? previousAssigneeSteps(nodes, before) : nodes;
  return candidates.filter(
    (node): node is HumanStep =>
      'form' in node && !!node.form && node.assigneeRule?.kind !== 'pool',
  );
}

export function workflowBranchFields(
  input: FormSchema,
  nodes: WorkflowNode[],
  before?: string,
  readers?: FieldReaders,
): FormField[] {
  return [
    ...workflowConditionFields(input),
    ...branchResultSources(nodes, before).flatMap((node) => {
      const form = node.form!;
      const publicForm = {
        ...form,
        sections: form.sections.map((section) => ({
          ...section,
          fields: section.fields.filter(
            (field) => readers?.[node.id + '.' + field.id] === undefined,
          ),
        })),
      };
      return workflowConditionFields(publicForm).map((field) => ({
        ...field,
        id: 'step.' + node.id + '.' + field.id,
        label: node.label + ' · ' + field.label,
      }));
    }),
  ];
}

export function hasStepBranchSources(spec: WorkflowSpec) {
  function references(group: Pick<ConditionGroupV1, 'rules'>): boolean {
    return group.rules.some((rule) =>
      'rules' in rule ? references(rule) : rule.fieldCode.startsWith('step.'),
    );
  }
  return spec.nodes.some((node) => node.kind === 'condition' && references(node.condition));
}
export function parseWorkflow(value: unknown, complete = true): WorkflowSpec {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144)
    fail('definition', 'DEFINITION_TOO_LARGE');
  const source = object(value, 'definition');
  keys(
    source,
    [
      'schemaVersion',
      'name',
      'description',
      'category',
      'input',
      'audienceUnits',
      'nodes',
      'positions',
      'calendar',
      'fieldReaders',
    ],
    'definition',
  );
  if (
    ![1, 2, 3, 4, 5].includes(Number(source.schemaVersion)) ||
    typeof source.schemaVersion !== 'number'
  )
    fail('schemaVersion', 'UNSUPPORTED_VERSION');
  const input = parseFormSchema(source.input, source.schemaVersion === 5);
  const stepInputIds = new Set(stepInputCandidates(input).map((field) => field.id));
  const codes = workflowFields(input).map((f) => f.code);
  if (codes.some((code) => code.length > 120) || new Set(codes).size !== codes.length)
    fail('input', 'DUPLICATE_CONDITION_FIELD');
  let calendar: BusinessCalendar | undefined;
  if (source.calendar !== undefined) {
    if (Number(source.schemaVersion) < 4) fail('calendar', 'VERSION_REQUIRED');
    try {
      calendar = parseCalendar(source.calendar);
    } catch {
      fail('calendar', 'INVALID_CALENDAR');
    }
  }
  if (!Array.isArray(source.audienceUnits) || source.audienceUnits.length > 100)
    fail('audienceUnits', 'INVALID_LIST');
  const units = (source.audienceUnits as unknown[]).map((value) => {
    workflowUuid(value);
    return value;
  });
  if (new Set(units).size !== units.length) fail('audienceUnits', 'DUPLICATE_UNIT');
  if (complete && !units.length) fail('audienceUnits', 'AUDIENCE_REQUIRED');
  if (!Array.isArray(source.nodes) || source.nodes.length < 2 || source.nodes.length > 30)
    fail('nodes', 'INVALID_STEP_COUNT');
  const branchConditions = new Map<string, { value: unknown; path: string }>();
  const nodes = (source.nodes as unknown[]).map((value, index): WorkflowNode => {
    const path = 'nodes.' + index,
      raw = object(value, path),
      id = identifier(raw.id, path + '.id'),
      label = text(raw.label, path + '.label', 120);
    const base = ['id', 'kind', 'label'];
    if (raw.kind === 'start') {
      keys(raw, [...base, 'next'], path);
      return { id, label, kind: 'start', next: identifier(raw.next, path + '.next', !complete) };
    }
    if (raw.kind === 'end') {
      keys(raw, base, path);
      return { id, label, kind: 'end' };
    }
    if (raw.kind === 'parallel' || raw.kind === 'join') {
      if (source.schemaVersion !== 5) fail(path + '.kind', 'VERSION_REQUIRED');
      if (raw.kind === 'join') {
        keys(raw, [...base, 'next'], path);
        return { id, label, kind: 'join', next: identifier(raw.next, path + '.next', !complete) };
      }
      keys(raw, [...base, 'branches', 'join'], path);
      if (!Array.isArray(raw.branches) || raw.branches.length < 2 || raw.branches.length > 28)
        fail(path + '.branches', 'PARALLEL_BRANCH_COUNT');
      const branches = (raw.branches as unknown[]).map((target, index) =>
        identifier(target, path + '.branches.' + index, !complete),
      );
      const connected = branches.filter(Boolean);
      if (connected.length !== new Set(connected).size)
        fail(path + '.branches', 'PARALLEL_BRANCH_DUPLICATE');
      return {
        id,
        label,
        kind: 'parallel',
        branches,
        join: identifier(raw.join, path + '.join', !complete),
      };
    }
    if (raw.kind === 'condition') {
      keys(raw, [...base, 'condition', 'yes', 'no'], path);
      branchConditions.set(id, { value: raw.condition, path: path + '.condition' });
      return {
        id,
        label,
        kind: 'condition',
        condition: { schemaVersion: 1, logicalOperator: 'AND', rules: [] },
        yes: identifier(raw.yes, path + '.yes', !complete),
        no: identifier(raw.no, path + '.no', !complete),
      };
    }
    if (raw.kind !== 'approval' && raw.kind !== 'task') fail(path + '.kind', 'UNSUPPORTED_STEP');
    keys(
      raw,
      [
        ...base,
        'assignee',
        'assigneeRule',
        'dueHours',
        'next',
        'form',
        'deadlineMinutes',
        'deadlineMode',
        'allowReturn',
        'rejectNext',
        'returnMode',
        'rejectReturnMode',
        'reassignRoles',
        'inputFields',
      ],
      path,
    );
    if (
      ['deadlineMinutes', 'deadlineMode', 'allowReturn'].some((k) => raw[k] !== undefined) &&
      Number(source.schemaVersion) < 4
    )
      fail(path, 'VERSION_REQUIRED');
    if (
      raw.deadlineMinutes !== undefined &&
      (!Number.isInteger(raw.deadlineMinutes) ||
        Number(raw.deadlineMinutes) < 1 ||
        Number(raw.deadlineMinutes) > 525600)
    )
      fail(path, 'INVALID_DEADLINE');
    if (
      raw.deadlineMode !== undefined &&
      !['elapsed', 'business'].includes(String(raw.deadlineMode))
    )
      fail(path, 'INVALID_DEADLINE');
    if (raw.deadlineMode === 'business' && !calendar) fail(path, 'CALENDAR_REQUIRED');
    if (raw.allowReturn !== undefined && typeof raw.allowReturn !== 'boolean')
      fail(path, 'INVALID_RETURN_POLICY');
    let inputFields: HumanStep['inputFields'];
    if (raw.inputFields !== undefined) {
      const fieldPath = path + '.inputFields';
      if (source.schemaVersion !== 5) fail(fieldPath, 'VERSION_REQUIRED');
      if (id === 'input') fail(path + '.id', 'RESERVED_STEP_ID');
      const configured = Object.entries(object(raw.inputFields, fieldPath));
      for (const [id, mode] of configured)
        if (!stepInputIds.has(id) || !stepInputModes.some((allowed) => mode === allowed))
          fail(fieldPath + '.' + id, 'INVALID_STEP_INPUT_FIELD');
      if (configured.length)
        inputFields = Object.fromEntries(configured) as HumanStep['inputFields'];
    }
    let assigneeRule: AssigneeRule | undefined;
    if (raw.assigneeRule !== undefined) {
      if (![2, 3, 4, 5].includes(Number(source.schemaVersion)))
        fail(path + '.assigneeRule', 'ASSIGNMENT_VERSION_REQUIRED');
      const rule = object(raw.assigneeRule, path + '.assigneeRule');
      if (rule.kind === 'group') {
        keys(rule, ['kind', 'groupId', 'selectionTiming'], path + '.assigneeRule');
        if (
          rule.selectionTiming !== undefined &&
          (rule.selectionTiming !== 'handoff' || source.schemaVersion !== 5)
        )
          fail(path + '.assigneeRule.selectionTiming', 'INVALID_SELECTION_TIMING');
        const groupId = text(rule.groupId, path + '.assigneeRule.groupId', 36, !complete);
        if (groupId) workflowUuid(groupId);
        assigneeRule = {
          kind: 'group',
          groupId,
          ...(rule.selectionTiming === 'handoff' ? { selectionTiming: 'handoff' as const } : {}),
        };
      } else if (rule.kind === 'previous') {
        keys(rule, ['kind', 'stepId'], path + '.assigneeRule');
        assigneeRule = {
          kind: 'previous',
          stepId: identifier(rule.stepId, path + '.assigneeRule.stepId', !complete),
        };
      } else if (rule.kind === 'pool' && Number(source.schemaVersion) >= 4) {
        keys(rule, ['kind', 'groupId', 'mode', 'quorum'], path + '.assigneeRule');
        if (raw.kind !== 'approval' || !['all', 'any', 'quorum'].includes(String(rule.mode)))
          fail(path, 'INVALID_APPROVAL_POLICY');
        const groupId = text(rule.groupId, path + '.assigneeRule.groupId', 36, !complete);
        if (groupId) workflowUuid(groupId);
        if (
          rule.mode === 'quorum' &&
          (!Number.isInteger(rule.quorum) || Number(rule.quorum) < 1 || Number(rule.quorum) > 50)
        )
          fail(path, 'INVALID_QUORUM');
        if (rule.mode !== 'quorum' && rule.quorum !== undefined) fail(path, 'INVALID_QUORUM');
        assigneeRule = {
          kind: 'pool',
          groupId,
          mode: rule.mode as 'all' | 'any' | 'quorum',
          ...(rule.mode === 'quorum' ? { quorum: Number(rule.quorum) } : {}),
        };
      } else if (rule.kind === 'organization' && [3, 4, 5].includes(Number(source.schemaVersion))) {
        keys(rule, ['kind', 'relation'], path + '.assigneeRule');
        if (rule.relation !== 'manager' && rule.relation !== 'unit-head')
          fail(path + '.assigneeRule', 'UNSUPPORTED_ASSIGNEE_RULE');
        assigneeRule = { kind: 'organization', relation: rule.relation as 'manager' | 'unit-head' };
      } else fail(path + '.assigneeRule', 'UNSUPPORTED_ASSIGNEE_RULE');
    }
    let reassignRoles: HumanStep['reassignRoles'];
    if (raw.reassignRoles !== undefined) {
      if (source.schemaVersion !== 5 || assigneeRule?.kind !== 'group')
        fail(path + '.reassignRoles', 'REASSIGNMENT_GROUP_REQUIRED');
      const roles = raw.reassignRoles;
      if (
        !Array.isArray(roles) ||
        roles.length > delegatedReassignmentRoles.length ||
        new Set(roles).size !== roles.length ||
        roles.some((role) => !delegatedReassignmentRoles.includes(role))
      )
        fail(path + '.reassignRoles', 'INVALID_REASSIGNMENT_POLICY');
      reassignRoles = delegatedReassignmentRoles.filter((role) =>
        (roles as unknown[]).includes(role),
      );
    }
    const assignee = text(raw.assignee, path + '.assignee', 36, !complete || !!assigneeRule);
    if (assignee) workflowUuid(assignee);
    if (assigneeRule && assignee) fail(path + '.assignee', 'AMBIGUOUS_ASSIGNEE');
    if (
      !Number.isInteger(raw.dueHours) ||
      (raw.dueHours as number) < 1 ||
      (raw.dueHours as number) > 8760
    )
      fail(path + '.dueHours', 'INVALID_DEADLINE');
    if (raw.rejectNext !== undefined && (raw.kind !== 'approval' || source.schemaVersion !== 5))
      fail(path + '.rejectNext', 'INVALID_REJECTION_TARGET');
    const rejectNext =
      raw.rejectNext === undefined
        ? undefined
        : identifier(raw.rejectNext, path + '.rejectNext', false);
    const returnMode = raw.returnMode;
    const supportedReturnMode =
      returnMode === 'previous' || returnMode === 'choose' || returnMode === 'end';
    if (
      returnMode !== undefined &&
      (source.schemaVersion !== 5 || raw.allowReturn === false || !supportedReturnMode)
    )
      fail(path + '.returnMode', 'INVALID_RETURN_MODE');
    const rejectReturnMode = raw.rejectReturnMode;
    if (
      rejectReturnMode !== undefined &&
      (source.schemaVersion !== 5 ||
        raw.kind !== 'approval' ||
        rejectNext ||
        (rejectReturnMode !== 'previous' && rejectReturnMode !== 'choose'))
    )
      fail(path + '.rejectReturnMode', 'INVALID_RETURN_MODE');
    return {
      id,
      label,
      kind: raw.kind as 'approval' | 'task',
      assignee,
      ...(assigneeRule ? { assigneeRule } : {}),
      dueHours: raw.dueHours as number,
      ...(raw.deadlineMinutes !== undefined
        ? { deadlineMinutes: Number(raw.deadlineMinutes) }
        : {}),
      ...(raw.deadlineMode !== undefined
        ? { deadlineMode: raw.deadlineMode as 'elapsed' | 'business' }
        : {}),
      ...(raw.allowReturn !== undefined ? { allowReturn: raw.allowReturn as boolean } : {}),
      ...(rejectNext ? { rejectNext } : {}),
      ...(supportedReturnMode && { returnMode }),
      ...(rejectReturnMode !== undefined && {
        rejectReturnMode: rejectReturnMode as PriorStepMode,
      }),
      ...(reassignRoles?.length ? { reassignRoles } : {}),
      next: identifier(raw.next, path + '.next', !complete),
      form: raw.form === null ? null : parseFormSchema(raw.form, source.schemaVersion === 5),
      ...(inputFields ? { inputFields } : {}),
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) fail('nodes', 'DUPLICATE_STEP');
  if (
    nodes.filter((node) => node.kind === 'start').length !== 1 ||
    !nodes.some((node) => node.kind === 'end')
  )
    fail('nodes', 'START_END_REQUIRED');
  if (complete) {
    const visiting = new Set<string>(),
      visited = new Set<string>();
    // Adapted DFS cycle/reachability checks from BOS governance-approval-engine.ts; ADR 0005.
    const visit = (id: string) => {
      if (visiting.has(id)) fail('nodes.' + id, 'GRAPH_CYCLE');
      if (visited.has(id)) return;
      const node = byId.get(id);
      if (!node) fail('nodes.' + id, 'UNKNOWN_TARGET');
      visiting.add(id);
      for (const next of nextSteps(node!)) {
        if (byId.get(next)?.kind === 'start') fail('nodes.' + id, 'START_INCOMING_EDGE');
        visit(next);
      }
      visiting.delete(id);
      visited.add(id);
    };
    visit(nodes.find((node) => node.kind === 'start')!.id);
    if (visited.size !== nodes.length) fail('nodes', 'UNREACHABLE_STEP');
    const startId = nodes.find((node) => node.kind === 'start')!.id;
    const parallelIssue = parallelGraphIssue(nodes, startId);
    if (parallelIssue) fail('nodes.' + parallelIssue.nodeId, parallelIssue.code);
    for (const node of nodes) {
      if (
        (node.kind !== 'approval' && node.kind !== 'task') ||
        node.assigneeRule?.kind !== 'previous'
      )
        continue;
      const prior = byId.get(node.assigneeRule.stepId);
      if (!prior || !['approval', 'task'].includes(prior.kind) || prior.id === node.id)
        fail('nodes.' + node.id, 'INVALID_PREVIOUS_ASSIGNEE_STEP');
      if (!guaranteedHumanSteps(nodes, node.id).some((step) => step.id === prior!.id))
        fail('nodes.' + node.id, 'PREVIOUS_STEP_NOT_GUARANTEED');
    }
  }
  const positions: WorkflowSpec['positions'] = {};
  for (const [id, value] of Object.entries(object(source.positions, 'positions'))) {
    if (!byId.has(id)) continue;
    const pos = object(value, 'positions.' + id);
    keys(pos, ['x', 'y'], 'positions.' + id);
    if (
      typeof pos.x !== 'number' ||
      typeof pos.y !== 'number' ||
      !Number.isFinite(pos.x) ||
      !Number.isFinite(pos.y) ||
      Math.abs(pos.x) > 100000 ||
      Math.abs(pos.y) > 100000
    )
      fail('positions.' + id, 'INVALID_POSITION');
    positions[id] = { x: pos.x as number, y: pos.y as number };
  }
  let fieldReaders: FieldReaders | undefined;
  if (source.fieldReaders !== undefined) {
    if (source.schemaVersion !== 5) fail('fieldReaders', 'VERSION_REQUIRED');
    if (nodes.some((n) => ['input', 'owner', 'manager'].includes(n.id)))
      fail('nodes', 'RESERVED_STEP_ID');
    try {
      fieldReaders = parseFieldReaders(source.fieldReaders, input, nodes);
    } catch (error) {
      if (error instanceof FieldAccessError) fail('fieldReaders', error.code);
      throw error;
    }
  }
  for (const node of nodes) {
    if (!('inputFields' in node) || !node.inputFields) continue;
    for (const id of Object.keys(node.inputFields)) {
      const readers = fieldReaders?.['input.' + id];
      if (readers && !readers.includes(node.id))
        fail('nodes.' + node.id + '.inputFields.' + id, 'STEP_INPUT_ACCESS_REQUIRED');
    }
  }
  for (const node of nodes) {
    if (node.kind !== 'condition') continue;
    const { value, path } = branchConditions.get(node.id)!;
    const fields = workflowBranchFields(
      input,
      source.schemaVersion === 5 ? nodes : [],
      complete ? node.id : undefined,
      fieldReaders,
    );
    const codes = fields.map((field) => field.id);
    if (
      codes.some((code) => code.split('.').at(-1)!.length > 120) ||
      new Set(codes).size !== codes.length
    )
      fail(path, 'DUPLICATE_CONDITION_FIELD');
    try {
      node.condition = normalizeCondition(value, {
        fieldDefinitions: ruleFieldDefinitions(fields),
        maxDepth: 4,
        maxLeaves: 20,
      });
      const dateIds = new Set(
        fields.filter((field) => field.type === 'date').map((field) => field.id),
      );
      const validateDates = (group: Pick<ConditionGroupV1, 'rules'>) => {
        for (const rule of group.rules) {
          if ('rules' in rule) validateDates(rule);
          else if (dateIds.has(rule.fieldCode) && rule.value !== undefined) {
            const values = Array.isArray(rule.value) ? rule.value : [rule.value];
            if (!values.every(isDate)) fail(path, 'INVALID_BRANCH_DATE');
          }
        }
      };
      validateDates(node.condition);
    } catch {
      fail(path, 'INVALID_BRANCH_CONDITION');
    }
  }
  if (complete && fieldReaders && nodes.some(selectsAtHandoff)) {
    for (const node of nodes) {
      if (node.kind !== 'approval' && node.kind !== 'task') continue;
      const hiddenCodes = new Set(
        workflowConditionFields({
          ...input,
          sections: input.sections.map((section) => ({
            ...section,
            fields: section.fields.filter((field) => {
              const readers = fieldReaders['input.' + field.id];
              return readers && !readers.includes(node.id);
            }),
          })),
        }).map((field) => field.id),
      );
      const usesHiddenInput = (group: Pick<ConditionGroupV1, 'rules'>): boolean =>
        group.rules.some((rule) =>
          'rules' in rule ? usesHiddenInput(rule) : hiddenCodes.has(rule.fieldCode),
        );
      // The presence or absence of a recipient can disclose a branch, so check every
      // traversable condition before the next human step, including alternate paths.
      for (const target of nextSteps(node)) {
        const path = decisionPath(nodes, target);
        if (
          path.some(selectsAtHandoff) &&
          path.some((step) => step.kind === 'condition' && usesHiddenInput(step.condition))
        )
          fail('nodes.' + node.id, 'HANDOFF_PROTECTED_CONDITION');
      }
    }
  }
  return {
    schemaVersion: source.schemaVersion as 1 | 2 | 3 | 4 | 5,
    ...(fieldReaders ? { fieldReaders } : {}),
    ...(calendar ? { calendar } : {}),
    name: text(source.name, 'name'),
    description: text(source.description, 'description', 2000, true),
    category: text(source.category, 'category', 80),
    input,
    audienceUnits: units,
    nodes,
    positions,
  };
}
function branchValues(schema: FormSchema, answers: Answers, prefix = '') {
  const values: Record<string, unknown> = {};
  for (const field of schemaFields(schema)) {
    const value = answers[field.id];
    const key = prefix + field.id;
    if (field.type === 'attachment') values[key] = Array.isArray(value) && value.length > 0;
    else if (field.type === 'money' && typeof value === 'string') values[key] = Number(value);
    else if (field.type === 'table' && isTableAnswer(value)) {
      for (const c of field.columns ?? [])
        if (c.summarize && value.totals[c.id] !== undefined)
          values[key + '__total_' + c.id] = Number(value.totals[c.id]);
    } else if (value !== undefined) values[key] = value;
  }
  return values;
}

export function advanceWorkflow(
  spec: WorkflowSpec,
  from: string,
  inputs: Answers,
  stepResults: Record<string, Answers> = {},
) {
  const conditionInputs = branchValues(spec.input, inputs);
  for (const node of branchResultSources(spec.nodes))
    if (Object.hasOwn(stepResults, node.id))
      Object.assign(
        conditionInputs,
        branchValues(node.form!, stepResults[node.id]!, 'step.' + node.id + '.'),
      );
  const definitions = ruleFieldDefinitions(
    workflowBranchFields(
      spec.input,
      spec.schemaVersion === 5 ? spec.nodes : [],
      undefined,
      spec.fieldReaders,
    ),
  );
  const traversed: string[] = [];
  let id = from;
  for (let limit = 0; limit < spec.nodes.length; limit++) {
    const step = spec.nodes.find((node) => node.id === id);
    if (!step) fail('runtime', 'UNKNOWN_TARGET');
    traversed.push(id);
    if (step!.kind !== 'start' && step!.kind !== 'condition')
      return { step: step as Exclude<WorkflowNode, { kind: 'start' | 'condition' }>, traversed };
    if (step!.kind === 'start') id = step!.next;
    else {
      const branch = step as Extract<WorkflowNode, { kind: 'condition' }>;
      let matches: boolean;
      try {
        matches = evaluateCondition(branch.condition, conditionInputs, definitions);
      } catch {
        fail('runtime', 'BRANCH_INPUT_INVALID');
      }
      id = matches! ? branch.yes : branch.no;
    }
  }
  return fail('runtime', 'GRAPH_CYCLE');
}
