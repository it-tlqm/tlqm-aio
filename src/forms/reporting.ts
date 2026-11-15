import { isAnswered, schemaFields } from './contracts.js';
import type { FormSchema, Answers } from './contracts.js';

/** Quote every field. Dangerous text gets a visible prefix that survives a CSV save/reopen. */
export function csvCell(input: unknown): string {
  let value = Array.isArray(input)
    ? input.join(' | ')
    : input === null || input === undefined
      ? ''
      : String(input);
  if (
    typeof input !== 'number' &&
    (/^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u.test(value) || /^[\p{Cc}\p{Cf}]/u.test(value))
  )
    value = 'text: ' + value;
  return '"' + value.replace(/"/g, '""') + '"';
}
export function csvExport(
  schema: FormSchema,
  rows: {
    id: string;
    version_id: string;
    account_id: string;
    org_unit_id: string;
    submitted_at: string | Date;
    answers: Answers;
  }[],
) {
  const fields = schemaFields(schema);
  const header = [
    'submission_id',
    'version_id',
    'account_id',
    'org_unit_id',
    'submitted_at',
    ...fields.map((field) => field.id + ' — ' + field.label),
  ];
  const values = rows.map((row) => [
    row.id,
    row.version_id,
    row.account_id,
    row.org_unit_id,
    new Date(row.submitted_at).toISOString(),
    ...fields.map((field) => row.answers[field.id]),
  ]);
  return (
    '\uFEFF' + [header, ...values].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}
export function summarizeVersion(schema: FormSchema, rows: { answers: Answers }[]) {
  return schemaFields(schema).map((field) => {
    const values = rows.map((row) => row.answers[field.id]).filter(isAnswered);
    const summary: {
      id: string;
      label: string;
      type: string;
      answered: number;
      counts?: { id: string; label: string; count: number }[];
      numeric?: { min: number; max: number; mean: number };
      dates?: { earliest: string; latest: string };
    } = {
      id: field.id,
      label: field.label,
      type: field.type,
      answered: values.length,
    };
    if (field.type === 'singleChoice' || field.type === 'multipleChoice')
      summary.counts = field.options!.map((option) => ({
        ...option,
        count: values.filter((value) =>
          Array.isArray(value) ? value.includes(option.id) : value === option.id,
        ).length,
      }));
    if (field.type === 'boolean')
      summary.counts = [true, false].map((value) => ({
        id: String(value),
        label: value ? 'Có' : 'Không',
        count: values.filter((answer) => answer === value).length,
      }));
    if (field.type === 'number' && values.length) {
      const numbers = values as number[];
      const scale = Math.max(...numbers.map(Math.abs));
      summary.numeric = {
        min: Math.min(...numbers),
        max: Math.max(...numbers),
        mean:
          scale === 0
            ? 0
            : Math.max(
                -1,
                Math.min(
                  1,
                  numbers.reduce((sum, value) => sum + value / scale / numbers.length, 0),
                ),
              ) * scale,
      };
    }
    if (field.type === 'date' && values.length) {
      const dates = (values as string[]).slice().sort();
      summary.dates = { earliest: dates[0]!, latest: dates[dates.length - 1]! };
    }
    return summary;
  });
}
