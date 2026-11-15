import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { normalizeCondition, evaluateCondition } from '../src/workflows/bos/condition-engine.js';
import type { RuleFieldDefinition } from '../src/workflows/bos/condition-engine.js';
import {
  parseWorkflow,
  advanceWorkflow,
  previousAssigneeSteps,
  WorkflowValidationError,
} from '../src/workflows/contracts.js';
import type { HumanStep } from '../src/workflows/contracts.js';
import { workflowTemplate } from '../src/workflows/templates.js';
const complete = () => {
  const spec = workflowTemplate();
  spec.audienceUnits = [randomUUID()];
  for (const node of spec.nodes)
    if (node.kind === 'approval' || node.kind === 'task') node.assignee = randomUUID();
  return parseWorkflow(spec);
};
test('BOS condition subset retains shared conformance semantics without importing runtime dependencies', async () => {
  const cases = JSON.parse(
    await readFile('tests/fixtures/bos-workflow-conditions.json', 'utf8'),
  ) as {
    conditionCases: {
      name: string;
      condition: unknown;
      context: Record<string, unknown>;
      fieldDefinitions: RuleFieldDefinition[];
      expected: boolean;
    }[];
  };
  assert.ok(cases.conditionCases.length > 5);
  for (const fixture of cases.conditionCases) {
    const condition = normalizeCondition(fixture.condition, {
      fieldDefinitions: fixture.fieldDefinitions,
    });
    assert.equal(
      evaluateCondition(condition, fixture.context, fixture.fieldDefinitions),
      fixture.expected,
      fixture.name,
    );
  }
});
test('Workflow draft can be incomplete; publication requires explicit audience, actors and complete acyclic graph', () => {
  assert.doesNotThrow(() => parseWorkflow(workflowTemplate(), false));
  assert.throws(() => parseWorkflow(workflowTemplate()));
  const original = complete();
  for (const change of [
    (spec: typeof original) => {
      (spec.nodes.find((n) => n.kind === 'approval')! as HumanStep).next = 'start';
    },
    (spec: typeof original) => {
      spec.nodes.find((n) => n.kind === 'start')!.next = 'missing';
    },
    (spec: typeof original) => {
      spec.nodes.push({ id: 'unused', kind: 'end', label: 'Unreachable' });
    },
    (spec: typeof original) => {
      (spec.nodes.find((n) => n.kind === 'approval')! as HumanStep).assignee = 'someone';
    },
    (spec: typeof original) => {
      spec.nodes.find((n) => n.kind === 'condition')!.condition.rules = [
        { fieldCode: 'unknown', operator: 'EQUALS', value: 'yes' },
      ];
    },
  ]) {
    const next = structuredClone(original);
    change(next);
    assert.throws(() => parseWorkflow(next));
  }
  assert.throws(() => parseWorkflow({ ...original, execute: 'arbitrary code' }));
});
test('Workflow branches use trusted typed input and never execute expressions', () => {
  const spec = complete();
  assert.equal(advanceWorkflow(spec, 'budget', { amount: 9999999 }).step.id, 'fulfil');
  assert.equal(advanceWorkflow(spec, 'budget', { amount: 10000000 }).step.id, 'director');
  assert.equal(advanceWorkflow(spec, 'start', { amount: 10000000 }).step.id, 'review');
  assert.throws(() => advanceWorkflow(spec, 'budget', {}));
  const branch = spec.nodes.find((node) => node.kind === 'condition')!;
  branch.condition.rules = [{ fieldCode: 'amount', operator: 'arbitrary' as never, value: 1 }];
  assert.throws(() => parseWorkflow(spec));
});
test('Handoff preview requires the transferring step to read conditions on every reachable alternative', () => {
  const spec = complete();
  spec.schemaVersion = 5;
  const review = spec.nodes.find((n) => n.id === 'review') as HumanStep;
  const director = spec.nodes.find((n) => n.id === 'director') as HumanStep;
  const branch = spec.nodes.find((n) => n.kind === 'condition')!;
  director.assignee = '';
  director.assigneeRule = { kind: 'group', groupId: randomUUID(), selectionTiming: 'handoff' };
  review.rejectNext = branch.id;
  spec.nodes.push({
    id: 'alternative',
    kind: 'condition',
    label: 'Điều kiện bổ sung',
    yes: 'fulfil',
    no: 'end',
    condition: {
      schemaVersion: 1,
      logicalOperator: 'AND',
      rules: [{ fieldCode: 'purpose', operator: 'CONTAINS', value: 'đối soát' }],
    },
  });
  branch.no = 'alternative';
  spec.fieldReaders = { 'input.amount': [review.id], 'input.purpose': ['manager'] };
  assert.throws(
    () => parseWorkflow(spec),
    (error: unknown) =>
      error instanceof WorkflowValidationError &&
      error.issues.some((issue) => issue.code === 'HANDOFF_PROTECTED_CONDITION'),
  );
  spec.fieldReaders['input.purpose'] = [review.id, 'manager'];
  const parsed = parseWorkflow(spec);
  assert.deepEqual(parsed.fieldReaders?.['input.amount'], [review.id]);
  const parsedReview = parsed.nodes.find((n) => n.id === review.id);
  assert.equal(parsedReview?.kind === 'approval' && parsedReview.rejectNext, branch.id);
});
test('Workflow adapter validates real date operands while preserving compound BOS conditions', () => {
  const spec = complete(),
    branch = spec.nodes.find((node) => node.kind === 'condition')!;
  branch.condition = {
    schemaVersion: 1,
    logicalOperator: 'AND',
    rules: [
      { fieldCode: 'amount', operator: 'GREATER_THAN_OR_EQUAL', value: 10000000 },
      {
        logicalOperator: 'OR',
        rules: [
          { fieldCode: 'needed_on', operator: 'EQUALS', value: '2026-12-01' },
          { fieldCode: 'purpose', operator: 'CONTAINS', value: 'khẩn' },
        ],
      },
    ],
  };
  const parsed = parseWorkflow(spec);
  assert.equal(
    advanceWorkflow(parsed, 'budget', {
      amount: 20000000,
      needed_on: '2026-12-01',
      purpose: 'Mua sắm',
    }).step.id,
    'director',
  );
  assert.equal(
    advanceWorkflow(parsed, 'budget', {
      amount: 20000000,
      needed_on: '2026-12-02',
      purpose: 'Mua sắm',
    }).step.id,
    'fulfil',
  );
  branch.condition.rules = [{ fieldCode: 'needed_on', operator: 'EQUALS', value: '2026-02-30' }];
  assert.throws(() => parseWorkflow(spec));
});
test('Prior step modes require v5 and cannot be combined with a second destination for the same action', () => {
  const spec = complete();
  const review = spec.nodes.find((n) => n.id === 'review') as HumanStep;
  review.returnMode = 'choose';
  assert.throws(() => parseWorkflow(spec), WorkflowValidationError);
  spec.schemaVersion = 5;
  review.allowReturn = false;
  assert.throws(() => parseWorkflow(spec), WorkflowValidationError);
  delete review.allowReturn;
  review.rejectReturnMode = 'previous';
  review.rejectNext = 'end';
  assert.throws(() => parseWorkflow(spec), WorkflowValidationError);
  delete review.rejectNext;
  const parsed = parseWorkflow(spec).nodes.find((n) => n.id === review.id) as HumanStep;
  assert.equal(parsed.returnMode, 'choose');
  assert.equal(parsed.rejectReturnMode, 'previous');
});

test('Parallel joins guarantee sources from every required branch, including nested splits', () => {
  const spec = complete();
  spec.schemaVersion = 5;
  const assigned = { assignee: randomUUID(), dueHours: 24, form: null };
  spec.nodes = [
    { id: 'start', label: 'Gửi', kind: 'start', next: 'split' },
    {
      id: 'split',
      label: 'Đồng thời',
      kind: 'parallel',
      branches: ['finance', 'nested'],
      join: 'join',
    },
    { ...assigned, id: 'finance', label: 'Tài chính', kind: 'task', next: 'join' },
    {
      id: 'nested',
      label: 'Kỹ thuật',
      kind: 'parallel',
      branches: ['it', 'admin'],
      join: 'nested_join',
    },
    { ...assigned, id: 'it', label: 'IT', kind: 'task', next: 'nested_join' },
    { ...assigned, id: 'admin', label: 'Hành chính', kind: 'task', next: 'nested_join' },
    { id: 'nested_join', label: 'Hợp kỹ thuật', kind: 'join', next: 'join' },
    { id: 'join', label: 'Đủ nhánh', kind: 'join', next: 'approve' },
    {
      ...assigned,
      id: 'approve',
      label: 'Phê duyệt',
      kind: 'approval',
      next: 'end',
      assignee: '',
      assigneeRule: { kind: 'previous', stepId: 'it' },
    },
    { id: 'end', label: 'Xong', kind: 'end' },
  ];
  const parsed = parseWorkflow(spec);
  assert.equal(advanceWorkflow(parsed, 'start', {}).step.kind, 'parallel');
  assert.deepEqual(
    previousAssigneeSteps(parsed.nodes, 'approve').map((step) => step.id),
    ['finance', 'it', 'admin'],
  );
  assert.deepEqual(previousAssigneeSteps(parsed.nodes, 'admin'), []);
  const finance = spec.nodes.find((node) => node.id === 'finance') as HumanStep;
  finance.next = 'end';
  assert.throws(
    () => parseWorkflow(spec),
    (error: unknown) =>
      error instanceof WorkflowValidationError &&
      error.issues.some((issue) => issue.code === 'PARALLEL_BRANCH_MISSES_JOIN'),
  );
  finance.next = 'it';
  assert.throws(
    () => parseWorkflow(spec),
    (error: unknown) =>
      error instanceof WorkflowValidationError &&
      error.issues.some(
        (issue) =>
          issue.code === 'PARALLEL_BRANCH_CROSSES' || issue.code === 'PARALLEL_JOIN_UNEXPECTED',
      ),
  );
});
