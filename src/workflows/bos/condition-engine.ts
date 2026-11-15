/** Adapted condition-only subset from BOS. See docs/decisions/0005-workflows-bos-reuse.md. */
import { isTemporalValue } from '../../forms/field-types.js';

export const CONDITION_SCHEMA_VERSION = 1 as const;

export type ConditionLogicalOperator = 'AND' | 'OR';
export type ConditionOperator =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'GREATER_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN'
  | 'LESS_THAN_OR_EQUAL'
  | 'IN'
  | 'NOT_IN'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'STARTS_WITH'
  | 'ENDS_WITH'
  | 'IS_EMPTY'
  | 'IS_NOT_EMPTY';

export interface ConditionRuleV1 {
  fieldCode: string;
  operator: ConditionOperator;
  value?: unknown;
}

export interface NestedConditionGroupV1 {
  logicalOperator: ConditionLogicalOperator;
  rules: Array<ConditionRuleV1 | NestedConditionGroupV1>;
}

export interface ConditionGroupV1 extends NestedConditionGroupV1 {
  schemaVersion: 1;
}

export interface RuleFieldDefinition {
  code: string;
  type: string;
}

export class ConfigurationRuleError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigurationRuleError';
  }
}

const CONDITION_OPERATOR_ALIASES: Record<string, ConditionOperator> = {
  '=': 'EQUALS',
  '==': 'EQUALS',
  EQUALS: 'EQUALS',
  '!=': 'NOT_EQUALS',
  '<>': 'NOT_EQUALS',
  NOT_EQUALS: 'NOT_EQUALS',
  '>': 'GREATER_THAN',
  GREATER_THAN: 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
  GREATER_THAN_OR_EQUAL: 'GREATER_THAN_OR_EQUAL',
  '<': 'LESS_THAN',
  LESS_THAN: 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  LESS_THAN_OR_EQUAL: 'LESS_THAN_OR_EQUAL',
  IN: 'IN',
  NOT_IN: 'NOT_IN',
  CONTAINS: 'CONTAINS',
  NOT_CONTAINS: 'NOT_CONTAINS',
  STARTS_WITH: 'STARTS_WITH',
  ENDS_WITH: 'ENDS_WITH',
  IS_EMPTY: 'IS_EMPTY',
  IS_NULL: 'IS_EMPTY',
  IS_NOT_EMPTY: 'IS_NOT_EMPTY',
  IS_NOT_NULL: 'IS_NOT_EMPTY',
};

const ORDERED_OPERATORS = new Set<ConditionOperator>([
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL',
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL',
]);
const CONTAINMENT_OPERATORS = new Set<ConditionOperator>(['CONTAINS', 'NOT_CONTAINS']);
const STRING_BOUNDARY_OPERATORS = new Set<ConditionOperator>(['STARTS_WITH', 'ENDS_WITH']);
const STRING_TYPES = new Set(['TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'SELECT']);
const NUMBER_TYPES = new Set(['NUMBER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE', 'FORMULA', 'ROLLUP']);
const DATE_TYPES = new Set(['DATE', 'DATETIME', 'TIME', 'MONTH', 'LOCAL_DATETIME']);

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigurationRuleError('RULE_OBJECT_REQUIRED', '', 'Cấu hình phải là object.');
  }
  return value as Record<string, unknown>;
}

function normalizeFieldCode(value: unknown, path: string): string {
  const code = String(value ?? '').trim();
  if (
    !/^[a-z][a-z0-9_]*$/.test(code) &&
    !/^step\.[a-z][a-z0-9_]{0,59}\.[a-z][a-z0-9_]{0,119}$/.test(code)
  ) {
    throw new ConfigurationRuleError(
      'FIELD_CODE_INVALID',
      path,
      `Field code không hợp lệ: ${code || '(trống)'}.`,
    );
  }
  return code;
}

export function isEmptyRuleValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function normalizeCondition(
  input: unknown,
  options: {
    fieldDefinitions?: RuleFieldDefinition[];
    targetFieldCode?: string;
    path?: string;
    maxDepth?: number;
    maxLeaves?: number;
  } = {},
): ConditionGroupV1 {
  const path = options.path ?? 'condition';
  const fields = new Map((options.fieldDefinitions ?? []).map((field) => [field.code, field.type]));
  let leafCount = 0;
  const maxDepth = options.maxDepth ?? 4;
  const maxLeaves = options.maxLeaves ?? 100;

  const normalizeNode = (
    value: unknown,
    nodePath: string,
    depth: number,
  ): ConditionRuleV1 | NestedConditionGroupV1 => {
    if (depth > maxDepth) {
      throw new ConfigurationRuleError(
        'CONDITION_DEPTH_EXCEEDED',
        nodePath,
        `Điều kiện vượt quá ${maxDepth} cấp lồng nhau.`,
      );
    }
    const raw = asObject(value);
    if (Array.isArray(raw.rules)) {
      const logicalRaw = String(
        raw.logicalOperator ??
          (raw.operator === 'AND' || raw.operator === 'OR' ? raw.operator : 'AND'),
      ).toUpperCase();
      if (logicalRaw !== 'AND' && logicalRaw !== 'OR') {
        throw new ConfigurationRuleError(
          'LOGICAL_OPERATOR_INVALID',
          `${nodePath}.logicalOperator`,
          'logicalOperator phải là AND hoặc OR.',
        );
      }
      if (raw.rules.length === 0) {
        throw new ConfigurationRuleError(
          'CONDITION_GROUP_EMPTY',
          `${nodePath}.rules`,
          'Nhóm điều kiện phải có ít nhất một rule.',
        );
      }
      return {
        logicalOperator: logicalRaw,
        rules: raw.rules.map((rule, index) =>
          normalizeNode(rule, `${nodePath}.rules[${index}]`, depth + 1),
        ),
      };
    }

    leafCount += 1;
    if (leafCount > maxLeaves) {
      throw new ConfigurationRuleError(
        'CONDITION_RULE_LIMIT_EXCEEDED',
        nodePath,
        `Điều kiện vượt quá ${maxLeaves} rule.`,
      );
    }
    const fieldCode = normalizeFieldCode(raw.fieldCode ?? raw.field, `${nodePath}.fieldCode`);
    if (options.targetFieldCode === fieldCode) {
      throw new ConfigurationRuleError(
        'CONDITION_SELF_REFERENCE',
        `${nodePath}.fieldCode`,
        `Trường ${fieldCode} không được tự tham chiếu.`,
      );
    }
    const type = fields.get(fieldCode);
    if (options.fieldDefinitions && !type) {
      throw new ConfigurationRuleError(
        'CONDITION_FIELD_UNKNOWN',
        `${nodePath}.fieldCode`,
        `Không tìm thấy trường ${fieldCode} trong metadata bundle.`,
      );
    }
    const operator =
      CONDITION_OPERATOR_ALIASES[
        String(raw.operator ?? '')
          .trim()
          .toUpperCase()
      ];
    if (!operator) {
      throw new ConfigurationRuleError(
        'CONDITION_OPERATOR_INVALID',
        `${nodePath}.operator`,
        `Toán tử ${String(raw.operator ?? '(trống)')} không được hỗ trợ.`,
      );
    }
    if (
      type &&
      ORDERED_OPERATORS.has(operator) &&
      !NUMBER_TYPES.has(type) &&
      !DATE_TYPES.has(type) &&
      type !== 'TEXT'
    ) {
      throw new ConfigurationRuleError(
        'CONDITION_OPERATOR_TYPE_MISMATCH',
        `${nodePath}.operator`,
        `Toán tử ${operator} không phù hợp với kiểu ${type}.`,
      );
    }
    if (type && STRING_BOUNDARY_OPERATORS.has(operator) && !STRING_TYPES.has(type)) {
      throw new ConfigurationRuleError(
        'CONDITION_OPERATOR_TYPE_MISMATCH',
        `${nodePath}.operator`,
        `Toán tử ${operator} chỉ áp dụng cho dữ liệu chuỗi.`,
      );
    }
    if (
      type &&
      CONTAINMENT_OPERATORS.has(operator) &&
      !STRING_TYPES.has(type) &&
      type !== 'MULTI_SELECT'
    ) {
      throw new ConfigurationRuleError(
        'CONDITION_OPERATOR_TYPE_MISMATCH',
        `${nodePath}.operator`,
        `Toán tử ${operator} chỉ áp dụng cho dữ liệu chuỗi hoặc lựa chọn nhiều.`,
      );
    }
    if ((operator === 'IN' || operator === 'NOT_IN') && !Array.isArray(raw.value)) {
      throw new ConfigurationRuleError(
        'CONDITION_ARRAY_VALUE_REQUIRED',
        `${nodePath}.value`,
        `${operator} yêu cầu value là mảng.`,
      );
    }
    if (operator !== 'IS_EMPTY' && operator !== 'IS_NOT_EMPTY' && raw.value === undefined) {
      throw new ConfigurationRuleError(
        'CONDITION_VALUE_REQUIRED',
        `${nodePath}.value`,
        `${operator} yêu cầu value.`,
      );
    }
    return {
      fieldCode,
      operator,
      ...(operator === 'IS_EMPTY' || operator === 'IS_NOT_EMPTY' ? {} : { value: raw.value }),
    };
  };

  const raw = asObject(input);
  if (raw.schemaVersion !== undefined && Number(raw.schemaVersion) !== CONDITION_SCHEMA_VERSION) {
    throw new ConfigurationRuleError(
      'CONDITION_SCHEMA_UNSUPPORTED',
      `${path}.schemaVersion`,
      'Condition schemaVersion phải là 1.',
    );
  }
  const normalized = normalizeNode(raw, path, 1);
  if (!('rules' in normalized)) {
    return {
      schemaVersion: CONDITION_SCHEMA_VERSION,
      logicalOperator: 'AND',
      rules: [normalized],
    };
  }
  return {
    schemaVersion: CONDITION_SCHEMA_VERSION,
    ...normalized,
  };
}

function strictNumber(value: unknown, path: string): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    throw new ConfigurationRuleError(
      'CONDITION_NUMBER_INVALID',
      path,
      'Giá trị không phải số hữu hạn.',
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ConfigurationRuleError(
      'CONDITION_NUMBER_INVALID',
      path,
      'Giá trị không phải số hữu hạn.',
    );
  }
  return parsed;
}

function strictBoolean(value: unknown, path: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigurationRuleError(
    'CONDITION_BOOLEAN_INVALID',
    path,
    'Giá trị boolean phải là true hoặc false.',
  );
}

function comparable(
  value: unknown,
  type: string | undefined,
  path: string,
): string | number | boolean {
  if (type && NUMBER_TYPES.has(type)) return strictNumber(value, path);
  if (type === 'BOOLEAN' || type === 'CHECKBOX') return strictBoolean(value, path);
  if (type === 'DATE') {
    const text = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
      throw new ConfigurationRuleError(
        'CONDITION_DATE_INVALID',
        path,
        'DATE phải dùng định dạng YYYY-MM-DD.',
      );
    }
    return text;
  }
  if (type === 'DATETIME') {
    const text = String(value);
    if (
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) ||
      Number.isNaN(Date.parse(text))
    ) {
      throw new ConfigurationRuleError(
        'CONDITION_DATETIME_INVALID',
        path,
        'DATETIME phải là ISO-8601 có timezone.',
      );
    }
    return Date.parse(text);
  }
  if (type === 'TIME') {
    const match = String(value).match(/^(\d{2}):([0-5]\d)(?::([0-5]\d))?$/);
    if (!match || Number(match[1]) > 23) {
      throw new ConfigurationRuleError(
        'CONDITION_TIME_INVALID',
        path,
        'TIME phải dùng HH:mm hoặc HH:mm:ss.',
      );
    }
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
  }
  if (type === 'MONTH' || type === 'LOCAL_DATETIME') {
    if (!isTemporalValue(type === 'MONTH' ? 'month' : 'dateTime', value))
      throw new ConfigurationRuleError(
        'CONDITION_DATE_INVALID',
        path,
        'Kiểm tra định dạng thời gian.',
      );
    return value;
  }
  if (typeof value === 'string') return value;
  if (!type && ['number', 'boolean'].includes(typeof value)) {
    return value as number | boolean;
  }
  return String(value);
}

function typedEquals(
  actual: unknown,
  target: unknown,
  type: string | undefined,
  path: string,
): boolean {
  if (isEmptyRuleValue(actual) || isEmptyRuleValue(target)) {
    return isEmptyRuleValue(actual) && isEmptyRuleValue(target);
  }
  return comparable(actual, type, `${path}.actual`) === comparable(target, type, `${path}.value`);
}

export function evaluateCondition(
  condition: ConditionGroupV1,
  context: Record<string, unknown>,
  fieldDefinitions: RuleFieldDefinition[] = [],
): boolean {
  const types = new Map(fieldDefinitions.map((field) => [field.code, field.type]));
  const evaluateNode = (node: ConditionRuleV1 | NestedConditionGroupV1, path: string): boolean => {
    if ('rules' in node) {
      const results = node.rules.map((child, index) =>
        evaluateNode(child, `${path}.rules[${index}]`),
      );
      return node.logicalOperator === 'AND' ? results.every(Boolean) : results.some(Boolean);
    }
    const actual = context[node.fieldCode];
    const type = types.get(node.fieldCode);
    switch (node.operator) {
      case 'IS_EMPTY':
        return isEmptyRuleValue(actual);
      case 'IS_NOT_EMPTY':
        return !isEmptyRuleValue(actual);
      case 'EQUALS':
        return typedEquals(actual, node.value, type, path);
      case 'NOT_EQUALS':
        return !typedEquals(actual, node.value, type, path);
      case 'IN':
      case 'NOT_IN': {
        const matched = (node.value as unknown[]).some((candidate, index) =>
          typedEquals(actual, candidate, type, `${path}.value[${index}]`),
        );
        return node.operator === 'IN' ? matched : !matched;
      }
      case 'CONTAINS':
      case 'NOT_CONTAINS': {
        const matched = Array.isArray(actual)
          ? actual.some((candidate, index) =>
              typedEquals(candidate, node.value, undefined, `${path}.actual[${index}]`),
            )
          : String(actual ?? '').includes(String(node.value ?? ''));
        return node.operator === 'NOT_CONTAINS' ? !matched : matched;
      }
      case 'STARTS_WITH':
      case 'ENDS_WITH': {
        const left = String(actual ?? '');
        const right = String(node.value ?? '');
        const matched =
          node.operator === 'STARTS_WITH' ? left.startsWith(right) : left.endsWith(right);
        return matched;
      }
      default: {
        const left = comparable(actual, type, `${path}.actual`);
        const right = comparable(node.value, type, `${path}.value`);
        if (typeof left !== typeof right) return false;
        if (node.operator === 'GREATER_THAN') return left > right;
        if (node.operator === 'GREATER_THAN_OR_EQUAL') return left >= right;
        if (node.operator === 'LESS_THAN') return left < right;
        if (node.operator === 'LESS_THAN_OR_EQUAL') return left <= right;
        return false;
      }
    }
  };
  return evaluateNode(condition, 'condition');
}
