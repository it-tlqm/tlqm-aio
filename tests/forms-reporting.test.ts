import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvExport, summarizeVersion } from '../src/forms/reporting.js';
import { parseFormSchema } from '../src/forms/contracts.js';

test('Forms CSV quotes separators/quotes/newlines and neutralizes formula-like text including hidden and full-width prefixes', () => {
  for (const value of [
    '=1+1',
    '+cmd',
    '-1+1',
    '@SUM(A1)',
    ' \t=cmd',
    '\u200b=cmd',
    '\uFEFF=cmd',
    '＝1+1',
    '＋1',
    '－1',
    '＠SUM(A1)',
    '\rpayload',
    '\npayload',
  ])
    assert.ok(csvCell(value).startsWith('"text: '));
  assert.equal(csvCell('safe,"label"\nnext'), '"safe,""label""\nnext"');
  assert.equal(csvCell(-3), '"-3"');
  assert.equal(csvCell(false), '"false"');
  assert.equal(csvCell(null), '""');
});

test('Forms report counts answers rather than truthiness, keeps version labels and never exposes free text', () => {
  const schema = parseFormSchema({
    schemaVersion: 1,
    title: 'Report',
    sections: [
      {
        id: 'main',
        title: 'Main',
        fields: [
          { id: 'text', type: 'shortText', label: 'Nội dung' },
          { id: 'count', type: 'number', label: 'Số' },
          { id: 'yes', type: 'boolean', label: 'Có/không' },
          {
            id: 'choice',
            type: 'multipleChoice',
            label: 'Chọn',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          },
          { id: 'date', type: 'date', label: 'Ngày' },
        ],
      },
    ],
  });
  const rows = [
    { answers: { text: 'Do not leak', count: 0, yes: false, choice: ['a'], date: '2024-02-29' } },
    { answers: { text: '', count: 10, yes: true, choice: ['a', 'b'], date: '2024-03-01' } },
  ];
  const result = summarizeVersion(schema, rows);
  assert.equal(result[0]!.answered, 1);
  assert.deepEqual(result[1]!.numeric, { min: 0, max: 10, mean: 5 });
  assert.deepEqual(
    result[2]!.counts?.map((row) => row.count),
    [1, 1],
  );
  assert.deepEqual(
    result[3]!.counts?.map((row) => row.count),
    [2, 1],
  );
  assert.deepEqual(result[4]!.dates, { earliest: '2024-02-29', latest: '2024-03-01' });
  assert.ok(!JSON.stringify(result).includes('Do not leak'));
  const extremes = summarizeVersion(schema, [
    { answers: { count: Number.MAX_VALUE } },
    { answers: { count: -Number.MAX_VALUE } },
  ]);
  assert.equal(extremes[1]!.numeric?.mean, 0);
  const exported = csvExport(schema, [
    {
      id: 'submission',
      version_id: 'version-1',
      account_id: 'account',
      org_unit_id: 'unit',
      submitted_at: '2026-01-01T00:00:00Z',
      answers: { text: '=1+2' },
    },
  ]);
  assert.ok(exported.startsWith('\uFEFF'));
  assert.ok(exported.includes('"text: =1+2"'));
  assert.ok(exported.includes('"text — Nội dung"'));
});
