import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFormSchema,
  parseAnswers,
  fieldState,
  FormValidationError,
} from '../src/forms/contracts.js';
import type { FormField, Condition } from '../src/forms/contracts.js';

const eq = (fieldId: string, value: string | number | boolean): Condition => ({
  mode: 'all',
  rules: [{ fieldId, operator: 'eq', value }],
});
function schema(fields: unknown[]) {
  return parseFormSchema({
    schemaVersion: 1,
    title: 'Khảo sát giả lập',
    sections: [{ id: 'general', title: 'Thông tin', fields }],
  });
}
function rejects(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error) =>
      error instanceof FormValidationError && error.issues.some((issue) => issue.code === code),
  );
}

test('Business fields validate temporal and numeric formats and apply ordered choice conditions with nested groups', () => {
  const form = {
    schemaVersion: 2,
    title: 'Điều phối thiết bị',
    sections: [
      {
        id: 'general',
        title: 'Thông tin',
        fields: [
          { id: 'external', type: 'boolean', label: 'Mua ngoài' },
          { id: 'urgent', type: 'boolean', label: 'Gấp' },
          { id: 'hour', type: 'time', label: 'Giờ nhận', minDate: '07:00', maxDate: '21:00' },
          { id: 'period', type: 'month', label: 'Tháng' },
          { id: 'starts', type: 'dateTime', label: 'Bắt đầu' },
          { id: 'quantity', type: 'integer', label: 'Số bộ' },
          { id: 'ratio', type: 'percentage', label: 'Tỷ lệ' },
          {
            id: 'delivery',
            type: 'multipleChoice',
            label: 'Hình thức nhận',
            options: [
              { id: 'desk', label: 'Tại kho' },
              { id: 'ship', label: 'Giao hàng' },
            ],
            optionRules: [
              {
                when: {
                  mode: 'all',
                  rules: [{ fieldId: 'external', operator: 'eq', value: true }],
                  groups: [
                    {
                      mode: 'any',
                      rules: [
                        { fieldId: 'urgent', operator: 'eq', value: true },
                        { fieldId: 'hour', operator: 'gte', value: '17:00' },
                      ],
                    },
                  ],
                },
                optionIds: ['ship'],
              },
              { when: eq('external', true), optionIds: ['desk'] },
            ],
          },
          {
            id: 'note',
            type: 'shortText',
            label: 'Ghi chú',
            visibleWhen: {
              mode: 'all',
              rules: [{ fieldId: 'delivery', operator: 'includes', value: 'desk' }],
            },
          },
          {
            id: 'reason',
            type: 'shortText',
            label: 'Lý do',
            requiredWhen: { mode: 'all', rules: [{ fieldId: 'hour', operator: 'blank' }] },
          },
        ],
      },
    ],
  };
  const parsed = parseFormSchema(form, true);
  const input = {
    external: true,
    urgent: false,
    hour: '17:00',
    period: '2026-11',
    starts: '2028-02-29T17:00',
    quantity: 0,
    ratio: 12.5,
    delivery: ['ship'],
  };
  assert.deepEqual(parseAnswers(parsed, input, 'submit'), input);
  assert.deepEqual(
    fieldState(parsed, input).options.delivery!.map((item) => item.id),
    ['ship'],
  );
  const stale = { ...input, delivery: ['desk'], note: 'Đã chọn tại kho' };
  const resolved = fieldState(parsed, stale);
  assert.deepEqual(resolved.answers.delivery, []);
  assert.equal(resolved.visible.note, false);
  assert.equal(resolved.answers.note, undefined);
  rejects(() => parseAnswers(parsed, stale, 'draft'), 'OPTION_NOT_AVAILABLE');
  assert.deepEqual(
    fieldState(parsed, { ...input, hour: '09:00' }).options.delivery!.map((item) => item.id),
    ['desk'],
  );
  rejects(() => parseAnswers(parsed, { external: false }, 'submit'), 'REQUIRED_ANSWER');
  for (const value of [
    { hour: '06:59' },
    { period: '2026-13' },
    { starts: '2026-02-29T09:00' },
    { quantity: 1.25 },
    { ratio: 101 },
  ])
    rejects(() => parseAnswers(parsed, value, 'draft'), 'INVALID_ANSWER');
  const invalid = structuredClone(form);
  const choice = invalid.sections[0]!.fields.find((field) => field.id === 'delivery')!;
  choice.optionRules![0]!.when.rules[0] = {
    fieldId: 'delivery',
    operator: 'includes',
    value: 'ship',
  };
  rejects(() => parseFormSchema(invalid, true), 'CONDITION_CYCLE');
  rejects(() => parseFormSchema({ ...form, schemaVersion: 1 }, true), 'BUSINESS_VERSION_REQUIRED');
});
const seven = () =>
  schema([
    { id: 'name', type: 'shortText', label: 'Tên', required: true, maxLength: 50 },
    { id: 'notes', type: 'longText', label: 'Mô tả' },
    { id: 'quantity', type: 'number', label: 'Số lượng', min: 0, max: 10, required: true },
    { id: 'date', type: 'date', label: 'Ngày', minDate: '2024-01-01', maxDate: '2024-12-31' },
    {
      id: 'choice',
      type: 'singleChoice',
      label: 'Chọn một',
      options: [
        { id: 'yes', label: 'Có' },
        { id: 'no', label: 'Không' },
      ],
    },
    {
      id: 'multiple',
      type: 'multipleChoice',
      label: 'Chọn nhiều',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    },
    { id: 'consent', type: 'boolean', label: 'Đồng ý', required: true },
  ]);

test('Forms accepts all seven field types, real leap dates and required false/zero without coercion', () => {
  const form = seven();
  const input = {
    name: 'Nguyễn giả lập',
    notes: '<script>literal text</script>',
    quantity: 0,
    date: '2024-02-29',
    choice: 'yes',
    multiple: ['b', 'a'],
    consent: false,
  };
  assert.deepEqual(parseAnswers(form, input, 'submit'), input);
  assert.notEqual(parseAnswers(form, input, 'submit').multiple, input.multiple);
  for (const [key, value] of [
    ['quantity', '1'],
    ['consent', 'false'],
    ['name', 7],
    ['date', '2024-02-30'],
    ['choice', 'unknown'],
    ['multiple', ['a', 'a']],
    ['quantity', Infinity],
  ] as const)
    rejects(() => parseAnswers(form, { ...input, [key]: value }, 'submit'), 'INVALID_ANSWER');
});

test('Forms drafts defer completeness but still reject invalid types, unknown keys and text bounds', () => {
  const form = seven();
  assert.deepEqual(parseAnswers(form, {}, 'draft'), {});
  rejects(() => parseAnswers(form, {}, 'submit'), 'REQUIRED_ANSWER');
  rejects(() => parseAnswers(form, { name: ' '.repeat(51) }, 'draft'), 'INVALID_ANSWER');
  rejects(() => parseAnswers(form, { quantity: -1 }, 'draft'), 'INVALID_ANSWER');
  rejects(() => parseAnswers(form, { date: '2023-02-29' }, 'draft'), 'INVALID_ANSWER');
  rejects(() => parseAnswers(form, { role: 'admin' }, 'draft'), 'UNKNOWN_FIELD');
  rejects(
    () => parseAnswers(form, JSON.parse('{"__proto__":{"admin":true}}'), 'draft'),
    'UNKNOWN_FIELD',
  );
  assert.equal(({} as { admin?: boolean }).admin, undefined);
});

test('Forms conditional visibility is resolved by dependency graph, not field order; hidden payloads are rejected even in drafts', () => {
  const form = schema([
    {
      id: 'detail',
      type: 'shortText',
      label: 'Chi tiết',
      visibleWhen: eq('gate', true),
      required: true,
    },
    {
      id: 'followup',
      type: 'shortText',
      label: 'Thêm',
      visibleWhen: { mode: 'all', rules: [{ fieldId: 'detail', operator: 'neq', value: 'no' }] },
    },
    { id: 'gate', type: 'boolean', label: 'Hiển thị', required: true },
  ]);
  assert.deepEqual(parseAnswers(form, { gate: false }, 'submit'), { gate: false });
  assert.equal(fieldState(form, { gate: false, detail: 'spoof' }).visible.followup, false);
  for (const mode of ['draft', 'submit'] as const)
    rejects(() => parseAnswers(form, { gate: false, detail: '' }, mode), 'HIDDEN_FIELD_ANSWER');
  rejects(() => parseAnswers(form, { gate: true }, 'submit'), 'REQUIRED_ANSWER');
  assert.deepEqual(parseAnswers(form, { gate: true, detail: 'Nội dung' }, 'submit'), {
    gate: true,
    detail: 'Nội dung',
  });
});

test('Forms finite all/any conditions and required-if interpret typed comparison, includes and answered', () => {
  const source: FormField[] = [
    { id: 'count', type: 'number', label: 'Số', required: false },
    {
      id: 'choices',
      type: 'multipleChoice',
      label: 'Chọn',
      required: false,
      options: [{ id: 'a', label: 'A' }],
    },
  ];
  for (const operator of ['gt', 'gte', 'lt', 'lte'] as const) {
    const form = schema([
      ...source,
      {
        id: 'details',
        type: 'shortText',
        label: 'Chi tiết',
        requiredWhen: {
          mode: 'all',
          rules: [
            { fieldId: 'count', operator, value: 5 },
            { fieldId: 'choices', operator: 'includes', value: 'a' },
          ],
        },
      },
    ]);
    const count = operator === 'gt' ? 6 : operator === 'lt' ? 4 : 5;
    rejects(() => parseAnswers(form, { count, choices: ['a'] }, 'submit'), 'REQUIRED_ANSWER');
    assert.doesNotThrow(() => parseAnswers(form, { count, choices: [] }, 'submit'));
  }
  const any = schema([
    ...source,
    {
      id: 'details',
      type: 'shortText',
      label: 'Chi tiết',
      requiredWhen: {
        mode: 'any',
        rules: [
          { fieldId: 'count', operator: 'eq', value: 0 },
          { fieldId: 'choices', operator: 'answered' },
        ],
      },
    },
  ]);
  rejects(() => parseAnswers(any, { count: 0 }, 'submit'), 'REQUIRED_ANSWER');
  rejects(() => parseAnswers(any, { choices: ['a'] }, 'submit'), 'REQUIRED_ANSWER');
  assert.doesNotThrow(() => parseAnswers(any, {}, 'submit'));
});

test('Forms schema rejects arbitrary code, prototype keys, unknown fields, duplicate identifiers and invalid bounds', () => {
  const base = { id: 'a', label: 'A', type: 'shortText' };
  rejects(() => schema([{ ...base, eval: 'globalThis' }]), 'UNKNOWN_PROPERTY');
  rejects(() => schema([{ ...base, type: 'javascript' }]), 'INVALID_FIELD_TYPE');
  rejects(() => schema([{ ...base, id: 'constructor' }]), 'INVALID_IDENTIFIER');
  rejects(() => schema([base, base]), 'DUPLICATE_FIELD_ID');
  rejects(() => schema([{ ...base, minLength: 5, maxLength: 2 }]), 'INVALID_TEXT_BOUNDS');
  rejects(() => schema([{ ...base, type: 'number', min: 2, max: 1 }]), 'INVALID_NUMBER_BOUNDS');
  rejects(() => schema([{ ...base, type: 'date', minDate: '2026-02-29' }]), 'INVALID_DATE');
  rejects(() => schema([{ ...base, type: 'boolean', minLength: 2 }]), 'UNKNOWN_PROPERTY');
  rejects(
    () =>
      schema([
        {
          ...base,
          type: 'singleChoice',
          options: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' },
          ],
        },
      ]),
    'DUPLICATE_OPTION_ID',
  );
  rejects(() => schema([{ ...base, label: 'x'.repeat(70000) }]), 'SCHEMA_TOO_LARGE');
});

test('Forms conditions reject missing references, cycles through required-if and operand/type mismatches', () => {
  const base = { id: 'a', label: 'A', type: 'shortText' };
  rejects(() => schema([{ ...base, visibleWhen: eq('missing', true) }]), 'UNKNOWN_CONDITION_FIELD');
  rejects(() => schema([{ ...base, requiredWhen: eq('a', 'x') }]), 'CONDITION_CYCLE');
  rejects(
    () =>
      schema([
        { ...base, visibleWhen: eq('b', 'x') },
        { ...base, id: 'b', requiredWhen: eq('a', 'x') },
      ]),
    'CONDITION_CYCLE',
  );
  rejects(
    () => schema([base, { ...base, id: 'b', visibleWhen: eq('a', false) }]),
    'CONDITION_TYPE_MISMATCH',
  );
  rejects(
    () =>
      schema([
        base,
        {
          ...base,
          id: 'b',
          visibleWhen: { mode: 'all', rules: [{ fieldId: 'a', operator: 'includes', value: 'a' }] },
        },
      ]),
    'CONDITION_TYPE_MISMATCH',
  );
  rejects(
    () =>
      schema([
        base,
        {
          ...base,
          id: 'b',
          visibleWhen: { mode: 'all', rules: [{ fieldId: 'a', operator: 'matches', value: '.*' }] },
        },
      ]),
    'INVALID_OPERATOR',
  );
  rejects(
    () =>
      schema([
        base,
        {
          ...base,
          id: 'b',
          visibleWhen: {
            mode: 'all',
            rules: [{ fieldId: 'a', operator: 'answered', value: true }],
          },
        },
      ]),
    'UNEXPECTED_VALUE',
  );
});

test('Forms parsing creates an independent normalized schema and never mutates the submitted definition', () => {
  const input = {
    schemaVersion: 1,
    title: 'Định nghĩa',
    sections: [
      { id: 'a', title: 'Nhóm', fields: [{ id: 'text', type: 'shortText', label: 'Nội dung' }] },
    ],
  };
  const before = structuredClone(input);
  const parsed = parseFormSchema(input);
  assert.deepEqual(input, before);
  parsed.sections[0]!.fields[0]!.label = 'Changed';
  assert.deepEqual(input, before);
  assert.equal(parsed.sections[0]!.fields[0]!.maxLength, 500);
});
