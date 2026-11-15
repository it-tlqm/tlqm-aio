import {
  BusinessValueError,
  isTableAnswer,
  moneyValue,
  parseBusinessColumns,
  parseTableAnswer,
} from './business.js';
import type { BusinessColumn, TableAnswer } from './business.js';
import { isReferenceAnswer } from './references.js';
import type { ReferenceAnswer } from './references.js';
import {
  attachmentFormats,
  defaultAttachmentField,
  maxAttachmentBytes,
} from './attachment-fields.js';
import type { AttachmentField, AttachmentFormat } from './attachment-fields.js';
import {
  businessFieldTypes,
  isBusinessField,
  isNumericField,
  isTemporalField,
  isTemporalValue,
} from './field-types.js';
export { isDate } from './field-types.js';
/** A bounded data language, interpreted as data on the server and in the preview. */
export const fieldTypes = [
  'shortText',
  'longText',
  'number',
  'date',
  'singleChoice',
  'multipleChoice',
  'boolean',
  ...businessFieldTypes,
] as const;
export type FieldType = (typeof fieldTypes)[number];
export type Scalar = string | number | boolean;
export type Answers = Record<string, Scalar | string[] | TableAnswer | ReferenceAnswer>;
export type Condition = {
  mode: 'all' | 'any';
  rules: {
    fieldId: string;
    operator: 'eq' | 'neq' | 'includes' | 'answered' | 'blank' | 'gt' | 'gte' | 'lt' | 'lte';
    value?: Scalar;
  }[];
  groups?: Condition[];
};
export type OptionRule = { when: Condition; optionIds: string[] };
export type FormField = {
  id: string;
  type: FieldType;
  label: string;
  description?: string;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  minDate?: string;
  maxDate?: string;
  options?: { id: string; label: string }[];
  optionRules?: OptionRule[];
  visibleWhen?: Condition;
  requiredWhen?: Condition;
  columns?: BusinessColumn[];
  maxRows?: number;
  currency?: 'VND' | 'USD';
  attachments?: AttachmentField;
};
export type FormSchema = {
  schemaVersion: 1 | 2;
  title: string;
  description?: string;
  sections: { id: string; title: string; description?: string; fields: FormField[] }[];
};
export type FormIssue = { path: string; code: string };
export class FormValidationError extends Error {
  readonly code = 'FORM_VALIDATION_FAILED';
  constructor(public readonly issues: FormIssue[]) {
    super('Invalid form data.');
  }
}
function fail(path: string, code: string): never {
  throw new FormValidationError([{ path, code }]);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(path, 'OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], path: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(path, 'UNKNOWN_PROPERTY');
}
function text(value: unknown, path: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()))
    fail(path, 'INVALID_TEXT');
  return value;
}
function identifier(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(value) ||
    ['constructor', 'prototype', '__proto__'].includes(value)
  )
    fail(path, 'INVALID_IDENTIFIER');
  return value;
}
function array(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(path, 'INVALID_LIST_SIZE');
  return value;
}
function number(value: unknown, path: string, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value))
  )
    fail(path, 'INVALID_NUMBER');
  return value;
}
function condition(
  value: unknown,
  path: string,
  advanced: boolean,
  depth = 1,
  budget = { left: 30 },
): Condition {
  if (depth > 3 || --budget.left < 0) fail(path, 'CONDITION_LIMIT');
  const input = object(value, path);
  keys(input, advanced ? ['mode', 'rules', 'groups'] : ['mode', 'rules'], path);
  if (input.mode !== 'all' && input.mode !== 'any') fail(path + '.mode', 'INVALID_CONDITION_MODE');
  const groups =
    input.groups === undefined
      ? []
      : array(input.groups, path + '.groups', 1, 4).map((group, index) =>
          condition(group, path + '.groups.' + index, advanced, depth + 1, budget),
        );
  const rules = array(input.rules, path + '.rules', groups.length ? 0 : 1, 10).map(
    (item, index) => {
      const p = path + '.rules.' + index;
      if (--budget.left < 0) fail(p, 'CONDITION_LIMIT');
      const rule = object(item, p);
      keys(rule, ['fieldId', 'operator', 'value'], p);
      const fieldId = identifier(rule.fieldId, p + '.fieldId');
      const operators = ['eq', 'neq', 'includes', 'answered', 'gt', 'gte', 'lt', 'lte'];
      if (advanced) operators.push('blank');
      if (typeof rule.operator !== 'string' || !operators.includes(rule.operator))
        fail(p + '.operator', 'INVALID_OPERATOR');
      const operator = rule.operator as Condition['rules'][number]['operator'];
      if (operator === 'answered' || operator === 'blank') {
        if (Object.hasOwn(rule, 'value')) fail(p + '.value', 'UNEXPECTED_VALUE');
        return { fieldId, operator };
      }
      if (
        !['string', 'number', 'boolean'].includes(typeof rule.value) ||
        (typeof rule.value === 'number' && !Number.isFinite(rule.value)) ||
        (typeof rule.value === 'string' && rule.value.length > 4000)
      )
        fail(p + '.value', 'INVALID_CONDITION_VALUE');
      return { fieldId, operator, value: rule.value as Scalar };
    },
  );
  return { mode: input.mode, rules, ...(groups.length ? { groups } : {}) };
}

export function conditionRules(value: Condition): Condition['rules'] {
  return [...value.rules, ...(value.groups ?? []).flatMap(conditionRules)];
}

export function fieldConditions(field: FormField): Condition[] {
  return [
    field.visibleWhen,
    field.requiredWhen,
    ...(field.optionRules ?? []).map((rule) => rule.when),
  ].filter((value): value is Condition => !!value);
}

export function requiresBusinessSchema(field: FormField) {
  return (
    isBusinessField(field.type) ||
    !!field.optionRules?.length ||
    fieldConditions(field).some(
      (value) => !!value.groups?.length || value.rules.some((rule) => rule.operator === 'blank'),
    )
  );
}
function field(value: unknown, path: string, version: number): FormField {
  const input = object(value, path);
  if (!fieldTypes.includes(input.type as FieldType)) fail(path + '.type', 'INVALID_FIELD_TYPE');
  const type = input.type as FieldType;
  if (isBusinessField(type) && version !== 2) fail(path, 'BUSINESS_VERSION_REQUIRED');
  const extra =
    type === 'attachment'
      ? ['attachments']
      : type === 'table'
        ? ['columns', 'maxRows', 'currency']
        : type === 'money'
          ? ['currency']
          : type === 'shortText' || type === 'longText'
            ? ['minLength', 'maxLength']
            : isNumericField(type)
              ? ['min', 'max']
              : isTemporalField(type)
                ? ['minDate', 'maxDate']
                : type === 'singleChoice' || type === 'multipleChoice'
                  ? ['options', ...(version === 2 ? ['optionRules'] : [])]
                  : [];
  keys(
    input,
    ['id', 'type', 'label', 'description', 'required', 'visibleWhen', 'requiredWhen', ...extra],
    path,
  );
  if (input.required !== undefined && typeof input.required !== 'boolean')
    fail(path + '.required', 'BOOLEAN_REQUIRED');
  const result: FormField = {
    id: identifier(input.id, path + '.id'),
    type,
    label: text(input.label, path + '.label', 200),
    required: input.required === true,
  };
  if (type === 'attachment') {
    const policy =
      input.attachments === undefined
        ? defaultAttachmentField()
        : object(input.attachments, path + '.attachments');
    keys(policy, ['formats', 'maxFiles', 'maxBytes'], path + '.attachments');
    const formats = array(
      policy.formats,
      path + '.attachments.formats',
      1,
      attachmentFormats.length,
    );
    if (
      formats.some((format) => !attachmentFormats.includes(format as AttachmentFormat)) ||
      new Set(formats).size !== formats.length
    )
      fail(path + '.attachments.formats', 'ATTACHMENT_FORMAT_INVALID');
    const maxFiles = number(policy.maxFiles, path + '.attachments.maxFiles', true);
    const maxBytes = number(policy.maxBytes, path + '.attachments.maxBytes', true);
    if (maxFiles < 1 || maxFiles > 10 || maxBytes < 1 || maxBytes > maxAttachmentBytes)
      fail(path + '.attachments', 'ATTACHMENT_LIMIT');
    result.attachments = { formats: formats as AttachmentFormat[], maxFiles, maxBytes };
  }
  if (type === 'money' || type === 'table') {
    if (!['VND', 'USD'].includes(String(input.currency))) fail(path, 'INVALID_CURRENCY');
    result.currency = input.currency as 'VND' | 'USD';
  }
  if (type === 'table') {
    result.maxRows =
      input.maxRows === undefined ? 50 : number(input.maxRows, path + '.maxRows', true);
    if (result.maxRows < 1 || result.maxRows > 100) fail(path, 'TABLE_ROW_LIMIT');
    try {
      result.columns = parseBusinessColumns(input.columns, path + '.columns');
    } catch (error) {
      if (error instanceof BusinessValueError) fail(error.path, error.code);
      throw error;
    }
  }
  if (input.description !== undefined)
    result.description = text(input.description, path + '.description', 2000, true);
  if (type === 'shortText' || type === 'longText') {
    const cap = type === 'shortText' ? 500 : 4000;
    result.minLength =
      input.minLength === undefined ? 0 : number(input.minLength, path + '.minLength', true);
    result.maxLength =
      input.maxLength === undefined ? cap : number(input.maxLength, path + '.maxLength', true);
    if (
      result.minLength < 0 ||
      result.maxLength < 1 ||
      result.minLength > result.maxLength ||
      result.maxLength > cap
    )
      fail(path, 'INVALID_TEXT_BOUNDS');
  }
  if (isNumericField(type)) {
    if (input.min !== undefined) result.min = number(input.min, path + '.min', type === 'integer');
    if (input.max !== undefined) result.max = number(input.max, path + '.max', type === 'integer');
    if (type === 'percentage') {
      result.min ??= 0;
      result.max ??= 100;
    }
    if (
      (result.min !== undefined && result.max !== undefined && result.min > result.max) ||
      (type === 'percentage' && (result.min! < 0 || result.max! > 100))
    )
      fail(path, 'INVALID_NUMBER_BOUNDS');
  }
  if (isTemporalField(type)) {
    for (const key of ['minDate', 'maxDate'] as const) {
      if (input[key] === undefined) continue;
      if (!isTemporalValue(type, input[key])) fail(path + '.' + key, 'INVALID_DATE');
      result[key] = input[key];
    }
    if (result.minDate && result.maxDate && result.minDate > result.maxDate)
      fail(path, 'INVALID_DATE_BOUNDS');
  }
  if (type === 'singleChoice' || type === 'multipleChoice') {
    result.options = array(input.options, path + '.options', 1, 50).map((item, index) => {
      const p = path + '.options.' + index;
      const option = object(item, p);
      keys(option, ['id', 'label'], p);
      return { id: identifier(option.id, p + '.id'), label: text(option.label, p + '.label', 200) };
    });
    if (new Set(result.options.map((option) => option.id)).size !== result.options.length)
      fail(path + '.options', 'DUPLICATE_OPTION_ID');
    if (input.optionRules !== undefined) {
      const available = new Set(result.options.map((option) => option.id));
      result.optionRules = array(input.optionRules, path + '.optionRules', 1, 10).map(
        (value, i) => {
          const p = path + '.optionRules.' + i;
          const rule = object(value, p);
          keys(rule, ['when', 'optionIds'], p);
          const optionIds = array(rule.optionIds, p + '.optionIds', 1, available.size).map((id) =>
            identifier(id, p + '.optionIds'),
          );
          if (
            new Set(optionIds).size !== optionIds.length ||
            optionIds.some((id) => !available.has(id))
          )
            fail(p + '.optionIds', 'INVALID_OPTION_RULE');
          return { when: condition(rule.when, p + '.when', true), optionIds };
        },
      );
    }
  }
  for (const key of ['visibleWhen', 'requiredWhen'] as const)
    if (input[key] !== undefined)
      result[key] = condition(input[key], path + '.' + key, version === 2);
  return result;
}
function checkRule(
  rule: Condition['rules'][number],
  source: FormField,
  path: string,
  advanced: boolean,
) {
  if (rule.operator === 'answered' || rule.operator === 'blank') return;
  if (['table', 'money', 'person', 'orgUnit', 'attachment'].includes(source.type))
    fail(path, 'CONDITION_TYPE_MISMATCH');
  if (rule.operator === 'includes') {
    if (
      source.type !== 'multipleChoice' ||
      !source.options?.some((option) => option.id === rule.value)
    )
      fail(path, 'CONDITION_TYPE_MISMATCH');
    return;
  }
  if (['gt', 'gte', 'lt', 'lte'].includes(rule.operator)) {
    if (
      !(isNumericField(source.type) && typeof rule.value === 'number') &&
      !(advanced && isTemporalField(source.type) && isTemporalValue(source.type, rule.value))
    )
      fail(path, 'CONDITION_TYPE_MISMATCH');
    return;
  }
  const valid =
    source.type === 'boolean'
      ? typeof rule.value === 'boolean'
      : isNumericField(source.type)
        ? typeof rule.value === 'number'
        : isTemporalField(source.type)
          ? isTemporalValue(source.type, rule.value)
          : source.type === 'singleChoice'
            ? source.options?.some((option) => option.id === rule.value)
            : source.type === 'multipleChoice'
              ? false
              : typeof rule.value === 'string';
  if (!valid) fail(path, 'CONDITION_TYPE_MISMATCH');
}
export function schemaFields(schema: FormSchema): FormField[] {
  return schema.sections.flatMap((section) => section.fields);
}
/** Validate structure, references, operand types and an acyclic dependency graph. */
export function parseFormSchema(value: unknown, business = false): FormSchema {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536)
    fail('schema', 'SCHEMA_TOO_LARGE');
  const input = object(value, 'schema');
  keys(input, ['schemaVersion', 'title', 'description', 'sections'], 'schema');
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2)
    fail('schema.schemaVersion', 'UNSUPPORTED_SCHEMA_VERSION');
  if (input.schemaVersion === 2 && !business)
    fail('schema.schemaVersion', 'BUSINESS_VERSION_REQUIRED');
  const result: FormSchema = {
    schemaVersion: input.schemaVersion as 1 | 2,
    title: text(input.title, 'schema.title', 200),
    sections: array(input.sections, 'schema.sections', 1, 20).map((item, index) => {
      const p = 'schema.sections.' + index;
      const section = object(item, p);
      keys(section, ['id', 'title', 'description', 'fields'], p);
      return {
        id: identifier(section.id, p + '.id'),
        title: text(section.title, p + '.title', 200),
        ...(section.description !== undefined
          ? { description: text(section.description, p + '.description', 2000, true) }
          : {}),
        fields: array(section.fields, p + '.fields', 1, 50).map((item, i) =>
          field(item, p + '.fields.' + i, input.schemaVersion as number),
        ),
      };
    }),
  };
  if (input.description !== undefined)
    result.description = text(input.description, 'schema.description', 2000, true);
  if (new Set(result.sections.map((section) => section.id)).size !== result.sections.length)
    fail('schema.sections', 'DUPLICATE_SECTION_ID');
  const fields = schemaFields(result);
  if (fields.length > 100) fail('schema.sections', 'TOO_MANY_FIELDS');
  const byId = new Map(fields.map((field) => [field.id, field]));
  if (byId.size !== fields.length) fail('schema.sections', 'DUPLICATE_FIELD_ID');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(target: FormField) {
    if (visiting.has(target.id)) fail('fields.' + target.id, 'CONDITION_CYCLE');
    if (visited.has(target.id)) return;
    visiting.add(target.id);
    for (const condition of fieldConditions(target)) {
      for (const rule of conditionRules(condition)) {
        const source = byId.get(rule.fieldId);
        if (!source) fail('fields.' + target.id, 'UNKNOWN_CONDITION_FIELD');
        checkRule(rule, source, 'fields.' + target.id, result.schemaVersion === 2);
        visit(source);
      }
    }
    visiting.delete(target.id);
    visited.add(target.id);
  }
  fields.forEach(visit);
  return result;
}
export function isAnswered(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== 'string' || value.trim().length > 0) &&
    (!Array.isArray(value) || value.length > 0) &&
    (!isTableAnswer(value) || value.rows.length > 0)
  );
}
function matches(
  condition: Condition,
  answers: Answers,
  visible: Record<string, boolean>,
): boolean {
  const outcomes = condition.rules.map((rule) => {
    const answer = answers[rule.fieldId];
    if (!visible[rule.fieldId]) return false;
    if (rule.operator === 'blank') return !isAnswered(answer);
    if (!isAnswered(answer)) return false;
    const target = rule.value;
    const ordered =
      (typeof answer === 'number' && typeof target === 'number') ||
      (typeof answer === 'string' && typeof target === 'string');
    switch (rule.operator) {
      case 'answered':
        return true;
      case 'eq':
        return answer === rule.value;
      case 'neq':
        return answer !== rule.value;
      case 'includes':
        return Array.isArray(answer) && answer.includes(rule.value as string);
      case 'gt':
        return ordered && answer > target;
      case 'gte':
        return ordered && answer >= target;
      case 'lt':
        return ordered && answer < target;
      case 'lte':
        return ordered && answer <= target;
    }
  });
  outcomes.push(...(condition.groups ?? []).map((group) => matches(group, answers, visible)));
  return condition.mode === 'all' ? outcomes.every(Boolean) : outcomes.some(Boolean);
}
/** Only pass a schema returned by parseFormSchema. */
export function fieldState(schema: FormSchema, answers: Answers) {
  const fields = schemaFields(schema);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const visible: Record<string, boolean> = {};
  const required: Record<string, boolean> = {};
  const options: Record<string, NonNullable<FormField['options']>> = {};
  const effectiveAnswers = { ...answers };
  function resolve(field: FormField) {
    if (Object.hasOwn(visible, field.id)) return;
    for (const condition of fieldConditions(field))
      for (const rule of conditionRules(condition)) resolve(byId.get(rule.fieldId)!);
    visible[field.id] = !field.visibleWhen || matches(field.visibleWhen, effectiveAnswers, visible);
    if (!visible[field.id]) delete effectiveAnswers[field.id];
    if (field.options) {
      const rule = field.optionRules?.find((item) => matches(item.when, effectiveAnswers, visible));
      options[field.id] = rule
        ? field.options.filter((option) => rule.optionIds.includes(option.id))
        : field.options;
      if (rule) {
        const value = effectiveAnswers[field.id];
        if (Array.isArray(value))
          effectiveAnswers[field.id] = value.filter((id) => rule.optionIds.includes(id));
        else if (typeof value === 'string' && !rule.optionIds.includes(value))
          delete effectiveAnswers[field.id];
      }
    }
    required[field.id] =
      visible[field.id] === true &&
      (field.required ||
        (!!field.requiredWhen && matches(field.requiredWhen, effectiveAnswers, visible)));
  }
  fields.forEach(resolve);
  return { visible, required, options, answers: effectiveAnswers };
}
/** Unknown/hidden keys and wrong types fail for drafts too; only completeness is deferred. */
export function parseAnswers(
  schema: FormSchema,
  value: unknown,
  mode: 'draft' | 'submit',
): Answers {
  const input = object(value, 'answers');
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144)
    fail('answers', 'ANSWERS_TOO_LARGE');
  const fields = schemaFields(schema);
  const ids = new Set(fields.map((field) => field.id));
  if (Object.keys(input).some((id) => !ids.has(id))) fail('answers', 'UNKNOWN_FIELD');
  const normalized: Answers = {};
  const issues: FormIssue[] = [];
  for (const field of fields) {
    const value = input[field.id];
    if (!Object.hasOwn(input, field.id)) continue;
    if (field.type === 'attachment') {
      const ids =
        Array.isArray(value) &&
        value.length <= field.attachments!.maxFiles &&
        value.every(
          (id) =>
            typeof id === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
        )
          ? value.map((id: string) => id.toLowerCase())
          : null;
      if (!ids || new Set(ids).size !== ids.length)
        issues.push({ path: 'answers.' + field.id, code: 'ATTACHMENT_REFERENCE_INVALID' });
      else normalized[field.id] = ids;
      continue;
    }
    if (field.type === 'person' || field.type === 'orgUnit') {
      if (!isReferenceAnswer(value))
        issues.push({ path: 'answers.' + field.id, code: 'INVALID_REFERENCE' });
      else normalized[field.id] = { id: value.id.toLowerCase(), label: value.label };
      continue;
    }
    if (field.type === 'money' || field.type === 'table') {
      try {
        normalized[field.id] =
          field.type === 'money'
            ? moneyValue(value, 'answers.' + field.id)
            : parseTableAnswer(field.columns!, field.maxRows!, value, mode, 'answers.' + field.id);
      } catch (error) {
        if (error instanceof BusinessValueError)
          issues.push({ path: error.path, code: error.code });
        else throw error;
      }
      continue;
    }
    let valid = false;
    switch (field.type) {
      case 'shortText':
      case 'longText':
        valid =
          typeof value === 'string' &&
          value.length <= field.maxLength! &&
          (!isAnswered(value) || value.length >= field.minLength!);
        break;
      case 'number':
      case 'integer':
      case 'percentage':
        valid =
          typeof value === 'number' &&
          Number.isFinite(value) &&
          (field.type !== 'integer' || Number.isSafeInteger(value)) &&
          (field.min === undefined || value >= field.min) &&
          (field.max === undefined || value <= field.max);
        break;
      case 'date':
      case 'month':
      case 'time':
      case 'dateTime':
        valid =
          isTemporalValue(field.type, value) &&
          (!field.minDate || value >= field.minDate) &&
          (!field.maxDate || value <= field.maxDate);
        break;
      case 'boolean':
        valid = typeof value === 'boolean';
        break;
      case 'singleChoice':
        valid = typeof value === 'string' && field.options!.some((option) => option.id === value);
        break;
      case 'multipleChoice':
        valid =
          Array.isArray(value) &&
          value.length <= field.options!.length &&
          new Set(value).size === value.length &&
          value.every(
            (item) =>
              typeof item === 'string' && field.options!.some((option) => option.id === item),
          );
        break;
    }
    if (!valid) issues.push({ path: 'answers.' + field.id, code: 'INVALID_ANSWER' });
    else normalized[field.id] = Array.isArray(value) ? ([...value] as string[]) : (value as Scalar);
  }
  if (issues.length) throw new FormValidationError(issues);
  const state = fieldState(schema, normalized);
  for (const field of fields) {
    const value = normalized[field.id];
    const effective = state.answers[field.id];
    if (!state.visible[field.id] && Object.hasOwn(input, field.id)) {
      issues.push({ path: 'answers.' + field.id, code: 'HIDDEN_FIELD_ANSWER' });
    } else if (
      field.optionRules &&
      Object.hasOwn(input, field.id) &&
      (Array.isArray(value)
        ? !Array.isArray(effective) || effective.length !== value.length
        : value !== effective)
    ) {
      issues.push({ path: 'answers.' + field.id, code: 'OPTION_NOT_AVAILABLE' });
    } else if (mode === 'submit' && state.required[field.id] && !isAnswered(effective))
      issues.push({ path: 'answers.' + field.id, code: 'REQUIRED_ANSWER' });
  }
  if (issues.length) throw new FormValidationError(issues);
  return normalized;
}
