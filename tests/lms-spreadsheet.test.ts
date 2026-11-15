import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  parseQuestionWorkbook,
  exportQuestionWorkbook,
  questionTemplate,
  questionHeaders,
  verifySpreadsheetZip,
} from '../src/lms/question-spreadsheet.js';
import { mergeQuestions } from '../src/lms/question-contracts.js';
import type { QuestionEntry } from '../src/lms/question-contracts.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
const workbook = (rows: unknown[][], bookType: 'xlsx' | 'biff8' = 'xlsx') => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Questions');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType, compression: true }));
};
test('Question workbooks roundtrip XLSX and preserve all twelve options, Unicode, literal formula text and answer types', async () => {
  const entries: QuestionEntry[] = [
    {
      kind: 'quiz',
      question: {
        id: 'one',
        type: 'single',
        question: 'Câu hỏi tiếng Việt',
        options: Array.from({ length: 12 }, (_, i) => 'Lựa chọn ' + i),
      },
      key: { answer: 11, explanation: '=DANGEROUS() is plain text' },
    },
    {
      kind: 'quiz',
      question: { id: 'two', type: 'multiple', question: 'Chọn hai', options: ['A', 'B', 'C'] },
      key: { answer: [0, 2], explanation: '' },
    },
    {
      kind: 'quiz',
      question: { id: 'three', type: 'text', question: 'Nhập số có zero đầu', options: [] },
      key: { answer: '0012', explanation: '' },
    },
  ];
  const bytes = exportQuestionWorkbook(entries, 'quiz');
  await verifySpreadsheetZip(bytes);
  const forged = bytes.slice(),
    view = new DataView(forged.buffer),
    central = view.getUint32(forged.length - 6, true);
  view.setUint32(central + 24, 0, true);
  await assert.rejects(() => verifySpreadsheetZip(forged), { code: 'LMS_WORKBOOK_INVALID' });
  const parsed = await parseQuestionWorkbook(bytes, 'de-thi.xlsx', 'quiz');
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(
    parsed.items.map((item) => item.entry.key),
    entries.map((item) => item.key),
  );
  assert.deepEqual(parsed.items[0]!.entry.question.options, entries[0]!.question.options);
  assert.equal(parsed.items[0]!.entry.question.question, 'Câu hỏi tiếng Việt');
  const check = await parseQuestionWorkbook(
    questionTemplate('checkpoint'),
    'diem-dung.xlsx',
    'checkpoint',
  );
  assert.equal(check.items.length, 3);
  assert.deepEqual(check.errors, []);
});
test('Legacy XLS and CSV import keep row numbers and reject missing/invalid keys, option gaps, duplicates and formula cells', async () => {
  const headers = [
    'Loai_Cau_Hoi',
    'Cau_Hoi',
    'Phuong_An_A',
    'Phuong_An_B',
    'Phuong_An_C',
    'Dap_An_Dung',
    'Giai_Thich',
  ];
  const rows = [
    headers,
    ['single', 'Một', 'A', 'B', '', 'B', ''],
    ['multiple', 'Nhiều', 'A', 'B', 'C', 'A;C', ''],
  ];
  assert.equal(
    (await parseQuestionWorkbook(workbook(rows, 'biff8'), 'nguon.xls', 'quiz')).items.length,
    2,
  );
  const csv = new TextEncoder().encode(
    'Loai_Cau_Hoi,Cau_Hoi,Dap_An_Dung\r\ntext,"Một, hai",0012\r\n',
  );
  const parsed = await parseQuestionWorkbook(csv, 'nguon.csv', 'quiz');
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.items[0]!.entry.key.answer, '0012');
  const invalid = await parseQuestionWorkbook(
    workbook([
      headers,
      [],
      ['single', 'Thiếu', 'A', 'B', '', '', ''],
      ['multiple', 'Lặp', 'A', 'B', '', 'A;A', ''],
      ['single', 'Hổng', 'A', '', 'C', 'C', ''],
      ['text', 'Trống', '', '', '', '', ''],
      ['single', { t: 'n', f: '1+1', v: 2 }, 'A', 'B', '', 'B', ''],
    ]),
    'sai.xlsx',
    'quiz',
  );
  assert.deepEqual([...new Set(invalid.errors.map((error) => error.row))], [3, 4, 5, 6, 7]);
  assert.equal(invalid.items.length, 0);
  const duplicate = await parseQuestionWorkbook(
    workbook([
      ['Cau_Hoi', 'Cau_Hoi'],
      ['A', 'B'],
    ]),
    'trung.xlsx',
    'quiz',
  );
  assert.ok(duplicate.errors.every((error) => error.row === 1));
  await assert.rejects(
    () =>
      parseQuestionWorkbook(
        workbook([questionHeaders('quiz'), ...Array.from({ length: 101 }, () => [''])]),
        'nhieu.xlsx',
        'quiz',
      ),
    { code: 'LMS_WORKBOOK_LIMIT' },
  );
  await assert.rejects(
    () => parseQuestionWorkbook(new Uint8Array(2 * 1024 * 1024 + 1), 'lon.xlsx', 'quiz'),
    { code: 'LMS_WORKBOOK_TOO_LARGE' },
  );
  await assert.rejects(() => parseQuestionWorkbook(new Uint8Array([1, 2, 3]), 'gia.xlsx', 'quiz'), {
    code: 'LMS_WORKBOOK_INVALID',
  });
});
test('Course import never changes published snapshots, drops other sections or sorts conflicting checkpoint times', async () => {
  const entries = (
    await parseQuestionWorkbook(questionTemplate('quiz'), 'mau.xlsx', 'quiz')
  ).items.map((row) => row.entry);
  const spec: CourseSpec = {
    schemaVersion: 1,
    title: 'Test',
    subtitle: '',
    series: 'Test',
    duration: 60,
    video: null,
    deadline: '',
    isMandatory: false,
    audienceUnits: [],
    questions: [],
    checkpoints: [
      { id: 'cp', type: 'single', question: 'CP', options: ['A', 'B'], time: 10, title: 'CP' },
    ],
    answerKey: { cp: { answer: 0, explanation: '' } },
    attachments: [],
  };
  const snapshot = JSON.stringify(spec),
    merged = mergeQuestions(spec, entries, 'quiz', 'replace');
  assert.equal(JSON.stringify(spec), snapshot);
  assert.equal(merged.questions.length, 3);
  assert.deepEqual(merged.checkpoints, spec.checkpoints);
  assert.deepEqual(merged.answerKey.cp, spec.answerKey.cp);
  const replaced = mergeQuestions(merged, entries.slice(0, 1), 'quiz', 'replace');
  assert.equal(Object.keys(replaced.answerKey).length, 2);
  assert.throws(
    () =>
      mergeQuestions(
        spec,
        [{ kind: 'checkpoint', question: spec.checkpoints[0]!, key: spec.answerKey.cp! }],
        'checkpoint',
        'append',
      ),
    { code: 'LMS_INVALID_COURSE' },
  );
});
