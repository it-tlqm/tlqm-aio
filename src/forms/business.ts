/** Fixed-scale business values. No user expression is evaluated. */
export type BusinessColumn = {
  id: string;
  label: string;
  type: 'text' | 'quantity' | 'money' | 'calculated';
  required: boolean;
  factors?: [string, string];
  summarize?: boolean;
};
export type BusinessRow = { id: string; cells: Record<string, string> };
export type TableAnswer = { rows: BusinessRow[]; totals: Record<string, string> };
export class BusinessValueError extends Error {
  constructor(
    readonly path: string,
    readonly code = 'BUSINESS_VALUE_INVALID',
  ) {
    super(code);
  }
}
const invalid = (path: string, code?: string): never => {
  throw new BusinessValueError(path, code);
};
const record = (value: unknown, path: string): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(path);
  return value as Record<string, unknown>;
};
const allowed = (value: Record<string, unknown>, keys: string[], path: string) => {
  if (Object.keys(value).some((k) => !keys.includes(k))) invalid(path);
};
const identifier = (value: unknown, path: string) => {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9_]{0,39}$/.test(value) ||
    ['constructor', 'prototype', '__proto__'].includes(value)
  )
    invalid(path);
  return value as string;
};
export function decimalUnits(value: unknown, scale: number, path = 'value'): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 20 ||
    !/^-?(0|[1-9][0-9]{0,11})(\.[0-9]+)?$/.test(value)
  )
    invalid(path);
  const source = value as string;
  const [whole = '', fraction = ''] = source.replace(/^-/, '').split('.');
  if (fraction.length > scale) invalid(path, 'DECIMAL_PRECISION');
  return (source.startsWith('-') ? -1n : 1n) * BigInt(whole + fraction.padEnd(scale, '0'));
}
export function decimalText(units: bigint, scale: number): string {
  const magnitude = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  return (units < 0n ? '-' : '') + magnitude.slice(0, -scale) + '.' + magnitude.slice(-scale);
}
export function moneyValue(value: unknown, path = 'value') {
  return decimalText(decimalUnits(value, 2, path), 2);
}
function boundedCents(value: bigint, path: string) {
  if (value > 99999999999999n || value < -99999999999999n) invalid(path, 'BUSINESS_TOTAL_OVERFLOW');
  return value;
}
export function parseBusinessColumns(value: unknown, path: string): BusinessColumn[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) invalid(path);
  const columns = (value as unknown[]).map((entry, i): BusinessColumn => {
    const p = path + '.' + i,
      raw = record(entry, p);
    allowed(raw, ['id', 'label', 'type', 'required', 'factors', 'summarize'], p);
    if (
      typeof raw.label !== 'string' ||
      !raw.label.trim() ||
      raw.label.length > 120 ||
      !['text', 'quantity', 'money', 'calculated'].includes(String(raw.type)) ||
      typeof raw.required !== 'boolean' ||
      (raw.summarize !== undefined && typeof raw.summarize !== 'boolean')
    )
      invalid(p);
    const result: BusinessColumn = {
      id: identifier(raw.id, p + '.id'),
      label: raw.label as string,
      type: raw.type as BusinessColumn['type'],
      required: raw.required as boolean,
    };
    if (raw.factors !== undefined) {
      if (raw.type !== 'calculated' || !Array.isArray(raw.factors) || raw.factors.length !== 2)
        invalid(p + '.factors');
      result.factors = (raw.factors as unknown[]).map((v) => identifier(v, p)) as [string, string];
    }
    if (raw.type === 'calculated' && !result.factors) invalid(p + '.factors');
    if (raw.summarize !== undefined) {
      if (!['money', 'calculated'].includes(result.type)) invalid(p + '.summarize');
      result.summarize = raw.summarize as boolean;
    }
    return result;
  });
  if (new Set(columns.map((c) => c.id)).size !== columns.length) invalid(path, 'DUPLICATE_COLUMN');
  for (const column of columns)
    for (const factor of column.factors ?? []) {
      const source = columns.find((c) => c.id === factor);
      if (!source || !['money', 'quantity'].includes(source.type))
        invalid(path, 'INVALID_FORMULA_REFERENCE');
    }
  return columns;
}
export function parseTableAnswer(
  columns: BusinessColumn[],
  maxRows: number,
  value: unknown,
  mode: 'draft' | 'submit',
  path = 'table',
): TableAnswer {
  const raw = record(value, path);
  allowed(raw, ['rows', 'totals'], path);
  if (!Array.isArray(raw.rows) || raw.rows.length > maxRows) invalid(path, 'TABLE_ROW_LIMIT');
  const totals: Record<string, string> = {};
  const sums = new Map(columns.filter((c) => c.summarize).map((c) => [c.id, 0n]));
  const rows = (raw.rows as unknown[]).map((entry, index): BusinessRow => {
    const p = path + '.rows.' + index,
      row = record(entry, p);
    allowed(row, ['id', 'cells'], p);
    const id = identifier(row.id, p + '.id'),
      source = record(row.cells, p + '.cells');
    allowed(
      source,
      columns.map((c) => c.id),
      p + '.cells',
    );
    const cells: Record<string, string> = {};
    for (const column of columns.filter((c) => c.type !== 'calculated')) {
      const cell = source[column.id],
        cp = p + '.cells.' + column.id;
      if (cell === undefined || cell === '') {
        if (mode === 'submit' && column.required) invalid(cp, 'REQUIRED_ANSWER');
        continue;
      }
      if (column.type === 'text') {
        if (typeof cell !== 'string' || cell.length > 500 || !cell.trim()) invalid(cp);
        cells[column.id] = cell as string;
      } else {
        const scale = column.type === 'money' ? 2 : 3;
        cells[column.id] = decimalText(decimalUnits(cell, scale, cp), scale);
      }
    }
    for (const column of columns.filter((c) => c.type === 'calculated')) {
      const [left, right] = column.factors!;
      if (cells[left] === undefined || cells[right] === undefined) {
        if (mode === 'submit' && column.required)
          invalid(p + '.cells.' + column.id, 'REQUIRED_ANSWER');
        continue;
      }
      const product = decimalUnits(cells[left], 3, p) * decimalUnits(cells[right], 3, p);
      // Round half away from zero, once per line, to two fractional digits.
      const cents = product < 0n ? -((-product + 5000n) / 10000n) : (product + 5000n) / 10000n;
      cells[column.id] = decimalText(boundedCents(cents, p), 2);
    }
    for (const [column, sum] of sums)
      if (cells[column] !== undefined)
        sums.set(column, boundedCents(sum + decimalUnits(cells[column], 2, p), p));
    return { id, cells };
  });
  if (new Set(rows.map((r) => r.id)).size !== rows.length) invalid(path, 'DUPLICATE_ROW');
  for (const [column, total] of sums) totals[column] = decimalText(total, 2);
  // Client totals and calculated cells are never authoritative, including on resubmission.
  return { rows, totals };
}
export function isTableAnswer(value: unknown): value is TableAnswer {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as TableAnswer).rows)
  );
}
export function purchaseColumns(): BusinessColumn[] {
  return [
    { id: 'description', label: 'Hàng hóa / nội dung', type: 'text', required: true },
    { id: 'quantity', label: 'Số lượng', type: 'quantity', required: true },
    { id: 'unit_price', label: 'Đơn giá', type: 'money', required: true },
    {
      id: 'amount',
      label: 'Thành tiền',
      type: 'calculated',
      required: true,
      factors: ['quantity', 'unit_price'],
      summarize: true,
    },
  ];
}
