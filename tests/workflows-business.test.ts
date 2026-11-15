import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseFormSchema, parseAnswers, FormValidationError } from '../src/forms/contracts.js';
import {
  moneyValue,
  parseTableAnswer,
  purchaseColumns,
  BusinessValueError,
} from '../src/forms/business.js';
import { advanceWorkflow, parseWorkflow, workflowFields } from '../src/workflows/contracts.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { parseFieldReaders, FieldAccessError } from '../src/workflows/field-access.js';
import {
  initialStepAnswers,
  stepActionForm,
  stepReadbackSchema,
} from '../src/workflows/step-input.js';

const schema = () =>
  parseFormSchema(
    {
      schemaVersion: 2,
      title: 'Đề nghị mua sắm',
      sections: [
        {
          id: 'content',
          title: 'Chi tiết',
          fields: [
            {
              id: 'items',
              label: 'Hàng hóa',
              type: 'table',
              required: true,
              currency: 'VND',
              maxRows: 10,
              columns: purchaseColumns(),
            },
            { id: 'advance', label: 'Tạm ứng', type: 'money', required: false, currency: 'VND' },
          ],
        },
      ],
    },
    true,
  );
const rows = () => ({
  rows: [
    {
      id: 'row_a',
      cells: { description: 'Vật tư A', quantity: '3', unit_price: '0.10', amount: '999' },
    },
    { id: 'row_b', cells: { description: 'Vật tư B', quantity: '1.005', unit_price: '1.00' } },
    { id: 'row_c', cells: { description: 'Hoàn lại', quantity: '-1.005', unit_price: '1.00' } },
  ],
  totals: { amount: '999999' },
});

test('Step input modes inherit source access and validate required fields only on forward actions', () => {
  const spec = workflowTemplate();
  spec.schemaVersion = 5;
  spec.input = schema();
  spec.audienceUnits = [randomUUID()];
  const condition = spec.nodes.find((node) => node.kind === 'condition')!;
  condition.condition.rules = [
    { fieldCode: 'advance', operator: 'GREATER_THAN_OR_EQUAL', value: 100 },
  ];
  const review = spec.nodes.find((node) => node.kind === 'approval' && node.id === 'review')!;
  if (!('form' in review)) throw new Error('Review step missing');
  review.inputFields = { items: 'read', advance: 'required' };
  spec.fieldReaders = { 'input.advance': [] };
  assert.throws(() => parseWorkflow(spec, false), {
    issues: [{ path: 'nodes.review.inputFields.advance', code: 'STEP_INPUT_ACCESS_REQUIRED' }],
  });
  spec.fieldReaders['input.advance'] = ['review'];
  const step = parseWorkflow(spec, false).nodes.find((node) => node.id === 'review')!;
  if (!('form' in step)) throw new Error('Review step missing');
  assert.equal(stepReadbackSchema(spec.input, step)?.sections[0]?.fields[0]?.id, 'items');
  const actionForm = stepActionForm(spec.input, step)!;
  const original = parseAnswers(spec.input, { items: rows(), advance: '40' }, 'submit');
  assert.deepEqual(initialStepAnswers(step, original), { 'input.advance': '40.00' });
  assert.deepEqual(parseAnswers(actionForm, {}, 'draft'), {});
  assert.throws(() => parseAnswers(actionForm, {}, 'submit'), FormValidationError);
  assert.throws(
    () => parseAnswers(actionForm, { 'input.items': rows() }, 'draft'),
    FormValidationError,
  );
  assert.deepEqual(parseAnswers(actionForm, { 'input.advance': '50' }, 'submit'), {
    'input.advance': '50.00',
  });
  assert.equal(original.advance, '40.00');
  review.inputFields = { missing: 'edit' };
  assert.throws(() => parseWorkflow(spec, false), { code: 'WORKFLOW_INVALID_DEFINITION' });
});

test('Business tables calculate and round decimal lines on server, ignore forged totals and retain row identities', () => {
  const result = parseTableAnswer(purchaseColumns(), 10, rows(), 'submit');
  assert.equal(result.rows[0]!.cells.amount, '0.30');
  assert.equal(result.rows[1]!.cells.amount, '1.01');
  assert.equal(result.rows[2]!.cells.amount, '-1.01');
  assert.equal(result.totals.amount, '0.30');
  assert.deepEqual(parseTableAnswer(purchaseColumns(), 10, result, 'submit'), result);
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ['row_a', 'row_b', 'row_c'],
  );
  assert.equal(moneyValue('-0.00'), '0.00');
  assert.equal(moneyValue('999999999999.99'), '999999999999.99');
});
test('Business validation rejects precision, overflow, duplicate rows, unknown cells and malformed objects', () => {
  for (const value of [1.1, '1e2', '1,23', 'Infinity', '0.001', '1000000000000', '01.00'])
    assert.throws(() => moneyValue(value), BusinessValueError);
  const malformed = rows();
  malformed.rows[1]!.id = 'row_a';
  assert.throws(() => parseTableAnswer(purchaseColumns(), 10, malformed, 'submit'), {
    code: 'DUPLICATE_ROW',
  });
  assert.throws(() => parseTableAnswer(purchaseColumns(), 1, rows(), 'submit'), {
    code: 'TABLE_ROW_LIMIT',
  });
  assert.throws(
    () =>
      parseTableAnswer(
        purchaseColumns(),
        10,
        {
          rows: [
            { id: 'a', cells: { description: 'x', quantity: '999999999999', unit_price: '2' } },
          ],
        },
        'submit',
      ),
    { code: 'BUSINESS_TOTAL_OVERFLOW' },
  );
  assert.throws(
    () =>
      parseTableAnswer(
        purchaseColumns(),
        10,
        { rows: [{ id: 'a', cells: { unlisted: 'x' } }] },
        'draft',
      ),
    BusinessValueError,
  );
  assert.throws(
    () =>
      parseTableAnswer(purchaseColumns(), 10, JSON.parse('{"rows":[],"__proto__":{}}'), 'draft'),
    BusinessValueError,
  );
});
test('Draft defers completeness only; empty required tables and invalid decimals cannot be submitted', () => {
  const s = schema();
  assert.deepEqual(parseAnswers(s, { items: { rows: [{ id: 'r', cells: {} }] } }, 'draft').items, {
    rows: [{ id: 'r', cells: {} }],
    totals: { amount: '0.00' },
  });
  for (const items of [
    { rows: [] },
    { rows: [{ id: 'r', cells: {} }] },
    { rows: [{ id: 'r', cells: { quantity: 'bad' } }] },
  ])
    assert.throws(() => parseAnswers(s, { items }, 'submit'), FormValidationError);
  assert.throws(
    () =>
      parseAnswers(s, { items: { rows: [{ id: 'r', cells: { unit_price: '1.001' } }] } }, 'draft'),
    FormValidationError,
  );
  assert.equal(parseAnswers(s, { items: rows(), advance: '100' }, 'submit').advance, '100.00');
});
test('Schema v2 business fields require explicit workflow opt-in; bounded formulas cannot use text, cycles or code', () => {
  const s = schema();
  assert.throws(() => parseFormSchema(s), FormValidationError);
  assert.throws(() => parseFormSchema({ ...s, schemaVersion: 1 }, true), FormValidationError);
  for (const factors of [
    ['amount', 'quantity'],
    ['description', 'quantity'],
    ['missing', 'quantity'],
  ]) {
    const invalid = structuredClone(s);
    invalid.sections[0]!.fields[0]!.columns![3]!.factors = factors as [string, string];
    assert.throws(() => parseFormSchema(invalid, true), FormValidationError);
  }
  const malicious = structuredClone(s) as any;
  malicious.sections[0].fields[0].columns[3].expression = 'process.exit()';
  assert.throws(() => parseFormSchema(malicious, true), FormValidationError);
  const over = structuredClone(s);
  over.sections[0]!.fields[0]!.maxRows = 101;
  assert.throws(() => parseFormSchema(over, true), FormValidationError);
});
test('Workflow v5 can route by calculated table totals, without trusting client numbers; older definitions remain gated', () => {
  const spec = workflowTemplate();
  spec.schemaVersion = 5;
  spec.input = schema();
  spec.audienceUnits = [randomUUID()];
  for (const node of spec.nodes) if ('assignee' in node) node.assignee = randomUUID();
  const branch = spec.nodes.find((n) => n.kind === 'condition')!;
  branch.condition.rules = [
    { fieldCode: 'items__total_amount', operator: 'GREATER_THAN_OR_EQUAL', value: 100 },
  ];
  const parsed = parseWorkflow(spec);
  assert(workflowFields(parsed.input).some((f) => f.code === 'items__total_amount'));
  const low = parseAnswers(parsed.input, { items: rows() }, 'submit');
  assert.equal(
    advanceWorkflow(parsed, branch.id, low).step.id,
    advanceWorkflow(parsed, branch.no, low).step.id,
  );
  const high = parseAnswers(
    parsed.input,
    {
      items: {
        rows: [{ id: 'r', cells: { description: 'A', quantity: '3', unit_price: '50' } }],
        totals: { amount: '0' },
      },
    },
    'submit',
  );
  assert.equal(
    advanceWorkflow(parsed, branch.id, high).step.id,
    advanceWorkflow(parsed, branch.yes, high).step.id,
  );
  assert.throws(() => parseWorkflow({ ...spec, schemaVersion: 4 }), FormValidationError);
});

test('Field policy rejects absent fields, invalid readers and indirect disclosure through conditional fields', () => {
  const s = schema(),
    spec = workflowTemplate();
  assert.throws(
    () => parseFieldReaders({ 'input.missing': ['owner'] }, s, spec.nodes),
    FieldAccessError,
  );
  assert.throws(
    () => parseFieldReaders({ 'input.items': ['not_a_step'] }, s, spec.nodes),
    FieldAccessError,
  );
  s.sections[0]!.fields.push({
    id: 'dependent',
    type: 'shortText',
    label: 'Phụ thuộc',
    required: false,
    visibleWhen: { mode: 'all', rules: [{ fieldId: 'items', operator: 'answered' }] },
  });
  assert.throws(
    () => parseFieldReaders({ 'input.items': ['review'] }, s, spec.nodes),
    FieldAccessError,
  );
  assert.deepEqual(
    parseFieldReaders({ 'input.items': ['review'], 'input.dependent': ['review'] }, s, spec.nodes),
    { 'input.items': ['review'], 'input.dependent': ['review'] },
  );
});
