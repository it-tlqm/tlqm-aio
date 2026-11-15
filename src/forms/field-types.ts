export const temporalFieldTypes = ['date', 'month', 'time', 'dateTime'] as const;
export type TemporalFieldType = (typeof temporalFieldTypes)[number];
export const numericFieldTypes = ['number', 'integer', 'percentage'] as const;
export const businessFieldTypes = [
  'money',
  'table',
  'person',
  'orgUnit',
  'attachment',
  'month',
  'time',
  'dateTime',
  'integer',
  'percentage',
] as const;

export function isTemporalField(type: string): type is TemporalFieldType {
  return temporalFieldTypes.some((item) => item === type);
}

export function isNumericField(type: string) {
  return numericFieldTypes.some((item) => item === type);
}

export function isBusinessField(type: string) {
  return businessFieldTypes.some((item) => item === type);
}

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000'))
    return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isTemporalValue(type: TemporalFieldType, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (type === 'date') return isDate(value);
  if (type === 'month') return /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
  if (type === 'time') return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  return (
    value.length === 16 &&
    value[10] === 'T' &&
    isDate(value.slice(0, 10)) &&
    isTemporalValue('time', value.slice(11))
  );
}

export function temporalInputType(
  type: TemporalFieldType,
): 'date' | 'month' | 'time' | 'datetime-local' {
  return type === 'dateTime' ? 'datetime-local' : type;
}
