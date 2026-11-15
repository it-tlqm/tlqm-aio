import * as XLSX from 'xlsx';
import { LmsError } from './security.js';
import { parseQuestionEntry } from './question-contracts.js';
import type { QuestionEntry, QuestionKind, QuestionPreview } from './question-contracts.js';
import type { Answer, Checkpoint, QuestionType } from './course-contracts.js';
export const spreadsheetMaxBytes = 2 * 1024 * 1024;
const maxRows = 100,
  maxColumns = 22;
const options = Array.from({ length: 12 }, (_, i) => 'Phuong_An_' + String.fromCharCode(65 + i));
export const questionHeaders = (kind: QuestionKind) => [
  'STT',
  'Loai_Cau_Hoi',
  ...(kind === 'checkpoint' ? ['Thoi_Gian_Giay', 'Tieu_De'] : []),
  'Cau_Hoi',
  ...options,
  'Dap_An_Dung',
  'Giai_Thich',
];
const canonical = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[_\s-]+/g, ' ')
    .trim();
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
/** Check actual inflation, not just attacker-controlled declared ZIP sizes. No paths are written. */
export async function verifySpreadsheetZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    max = 16 * 1024 * 1024;
  const fail = () => {
    throw new LmsError(400, 'LMS_WORKBOOK_INVALID');
  };
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) fail();
  const count = view.getUint16(end + 10, true),
    central = view.getUint32(end + 16, true);
  if (
    view.getUint32(end + 4, true) !== 0 ||
    count < 1 ||
    count > 128 ||
    view.getUint16(end + 8, true) !== count ||
    central + view.getUint32(end + 12, true) !== end
  )
    fail();
  let offset = central,
    total = 0;
  const names = new Set<string>(),
    locations = new Set<number>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail();
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true),
      crc = view.getUint32(offset + 16, true),
      compressed = view.getUint32(offset + 20, true),
      size = view.getUint32(offset + 24, true),
      nameLength = view.getUint16(offset + 28, true),
      extra = view.getUint16(offset + 30, true),
      comment = view.getUint16(offset + 32, true),
      local = view.getUint32(offset + 42, true);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (
      offset + 46 + nameLength + extra + comment > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      size > max ||
      total + size > max ||
      names.has(name) ||
      locations.has(local) ||
      name.includes('..') ||
      name.startsWith('/') ||
      name.includes('\\') ||
      local + 30 > central
    )
      fail();
    names.add(name);
    locations.add(local);
    if (
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint16(local + 6, true) !== flags
    )
      fail();
    const localName = view.getUint16(local + 26, true),
      start = local + 30 + localName + view.getUint16(local + 28, true);
    if (
      start + compressed > central ||
      new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + localName)) !== name
    )
      fail();
    const data = bytes.slice(start, start + compressed);
    const input = new Blob([data]).stream();
    const stream = method === 0 ? input : input.pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    let actual = 0,
      check = 0xffffffff;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        actual += chunk.value.byteLength;
        total += chunk.value.byteLength;
        if (actual > size || total > max) fail();
        for (const byte of chunk.value) check = crcTable[(check ^ byte) & 255]! ^ (check >>> 8);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (actual !== size || (check ^ 0xffffffff) >>> 0 !== crc) fail();
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end || !names.has('[Content_Types].xml')) fail();
}
export async function parseQuestionWorkbook(
  bytes: Uint8Array,
  name: string,
  kind: QuestionKind,
): Promise<Pick<QuestionPreview, 'items' | 'errors'>> {
  if (
    !['quiz', 'checkpoint'].includes(kind) ||
    typeof name !== 'string' ||
    name.length > 180 ||
    /[\\/\x00-\x1f]/.test(name)
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  if (!bytes.length || bytes.length > spreadsheetMaxBytes)
    throw new LmsError(413, 'LMS_WORKBOOK_TOO_LARGE');
  const extension = name.split('.').at(-1)?.toLowerCase();
  if (!['xlsx', 'xls', 'csv'].includes(extension ?? ''))
    throw new LmsError(415, 'LMS_WORKBOOK_FORMAT');
  let workbook: XLSX.WorkBook;
  try {
    if (extension === 'xlsx') await verifySpreadsheetZip(bytes);
    if (extension === 'xls' && ![0xd0, 0x09].includes(bytes[0]!))
      throw new LmsError(400, 'LMS_WORKBOOK_INVALID');
    const source =
      extension === 'csv' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
    if (typeof source === 'string' && source.includes('\0'))
      throw new LmsError(400, 'LMS_WORKBOOK_INVALID');
    workbook = XLSX.read(source, {
      type: extension === 'csv' ? 'string' : 'array',
      raw: true,
      nodim: true,
      cellFormula: true,
      cellHTML: false,
      cellText: false,
      cellDates: false,
      bookVBA: true,
      sheets: 0,
      sheetRows: maxRows + 2,
    });
    if (workbook.vbaraw) throw new LmsError(400, 'LMS_WORKBOOK_MACROS');
  } catch (error) {
    if (error instanceof LmsError) throw error;
    throw new LmsError(400, 'LMS_WORKBOOK_INVALID');
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  if (!sheet || !sheet['!ref']) throw new LmsError(400, 'LMS_WORKBOOK_EMPTY');
  const range = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref']);
  if (range.s.r !== 0 || range.e.r > maxRows || range.e.c >= maxColumns)
    throw new LmsError(400, 'LMS_WORKBOOK_LIMIT');
  const errors: QuestionPreview['errors'] = [],
    items: QuestionPreview['items'] = [];
  const cell = (row: number, column: number) => {
    const value = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
    if (!value) return '';
    if (value.f || value.F) {
      errors.push({
        row: row + 1,
        column: XLSX.utils.encode_col(column),
        message: 'Không nhận ô công thức. Hãy dán giá trị văn bản.',
      });
      return '';
    }
    if (
      value.t === 'e' ||
      value.t === 'd' ||
      (typeof value.v !== 'string' && typeof value.v !== 'number' && typeof value.v !== 'boolean')
    ) {
      errors.push({
        row: row + 1,
        column: XLSX.utils.encode_col(column),
        message: 'Giá trị ô không hợp lệ.',
      });
      return '';
    }
    const text = String(value.v ?? '').trim();
    if (text.length > 4000) {
      errors.push({
        row: row + 1,
        column: XLSX.utils.encode_col(column),
        message: 'Nội dung ô quá dài.',
      });
      return '';
    }
    return text;
  };
  const headers = Array.from({ length: range.e.c + 1 }, (_, i) => canonical(cell(0, i)));
  const columns = new Map<string, number>();
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!;
    if (header && columns.has(header))
      errors.push({ row: 1, column: XLSX.utils.encode_col(i), message: 'Cột tiêu đề bị trùng.' });
    columns.set(header, i);
  }
  const required = [
    'Loai_Cau_Hoi',
    'Cau_Hoi',
    'Dap_An_Dung',
    ...(kind === 'checkpoint' ? ['Thoi_Gian_Giay', 'Tieu_De'] : []),
  ];
  for (const header of required)
    if (!columns.has(canonical(header)))
      errors.push({ row: 1, column: header, message: 'Thiếu cột bắt buộc: ' + header });
  if (errors.length) return { items, errors };
  for (let row = 1; row <= range.e.r; row++) {
    if (
      Array.from(
        { length: range.e.c + 1 },
        (_, column) => sheet[XLSX.utils.encode_cell({ r: row, c: column })],
      ).every((cell) => !cell || ((cell.v == null || cell.v === '') && !cell.f && !cell.F))
    )
      continue;
    const before = errors.length;
    const rowValues = Array.from({ length: range.e.c + 1 }, (_, column) => cell(row, column));
    const value = (_row: number, header: string) => {
      const column = columns.get(canonical(header));
      return column === undefined ? '' : (rowValues[column] ?? '');
    };
    const issue = (column: string, message: string) =>
      errors.push({ row: row + 1, column, message });
    const rawType = canonical(value(row, 'Loai_Cau_Hoi'));
    const type = (
      {
        single: 'single',
        'chon mot': 'single',
        multiple: 'multiple',
        'chon nhieu': 'multiple',
        text: 'text',
        'tu luan': 'text',
      } as Record<string, QuestionType>
    )[rawType];
    if (!type) issue('Loai_Cau_Hoi', 'Loại phải là single, multiple hoặc text.');
    const optionValues = options.map((header) => value(row, header));
    while (optionValues.at(-1) === '') optionValues.pop();
    if (type !== 'text' && optionValues.some((option) => !option))
      issue('Phuong_An', 'Không để trống lựa chọn ở giữa; vị trí A–L phải giữ nguyên.');
    if (type === 'text' && optionValues.length)
      issue('Phuong_An', 'Câu nhập chữ không có phương án lựa chọn.');
    const rawAnswer = value(row, 'Dap_An_Dung');
    let answer: Answer = rawAnswer;
    if (type !== 'text') {
      const parts = rawAnswer.split(/[;,\s]+/).filter(Boolean);
      const indexes = parts.map((part) =>
        /^[A-L]$/i.test(part)
          ? part.toUpperCase().charCodeAt(0) - 65
          : /^(0|[1-9]|1[01])$/.test(part)
            ? Number(part)
            : -1,
      );
      if (
        !indexes.length ||
        (type === 'single' && indexes.length !== 1) ||
        new Set(indexes).size !== indexes.length ||
        indexes.some((i) => i < 0 || i >= optionValues.length)
      )
        issue(
          'Dap_An_Dung',
          'Đáp án phải trỏ tới lựa chọn có thật, không lặp (A;C hoặc chỉ số từ 0).',
        );
      answer = type === 'multiple' ? indexes : (indexes[0] ?? -1);
    } else if (!rawAnswer) issue('Dap_An_Dung', 'Nhập đáp án chuẩn, không để trống.');
    const time = kind === 'checkpoint' ? Number(value(row, 'Thoi_Gian_Giay')) : 0;
    if (
      kind === 'checkpoint' &&
      (!value(row, 'Thoi_Gian_Giay') || !Number.isFinite(time) || time < 0 || time > 86400)
    )
      issue('Thoi_Gian_Giay', 'Thời gian phải là số giây từ 0 đến 86400.');
    const entry: QuestionEntry = {
      kind,
      question: {
        id: 'import-' + row,
        type: type ?? 'single',
        question: value(row, 'Cau_Hoi'),
        options: optionValues,
        ...(kind === 'checkpoint' ? { time, title: value(row, 'Tieu_De') } : {}),
      },
      key: { answer, explanation: value(row, 'Giai_Thich') },
    };
    if (errors.length === before) {
      try {
        items.push({ row: row + 1, entry: parseQuestionEntry(entry) });
      } catch {
        issue('Cau_Hoi', 'Kiểm tra nội dung, độ dài, lựa chọn trùng và đáp án theo mẫu.');
      }
    }
  }
  if (!items.length && !errors.length)
    errors.push({ row: 2, column: 'Cau_Hoi', message: 'Chưa có câu hỏi trong tệp.' });
  return { items, errors };
}
export function exportQuestionWorkbook(entries: QuestionEntry[], kind: QuestionKind): Uint8Array {
  const rows: (string | number)[][] = [questionHeaders(kind)];
  entries.forEach((raw, index) => {
    const entry = parseQuestionEntry(raw),
      q = entry.question,
      key = entry.key;
    if (entry.kind !== kind) throw new LmsError(400, 'INVALID_REQUEST');
    const answer =
      q.type === 'text'
        ? String(key.answer)
        : (Array.isArray(key.answer) ? key.answer : [Number(key.answer)])
            .map((i) => String.fromCharCode(65 + i))
            .join(';');
    rows.push([
      index + 1,
      q.type,
      ...(kind === 'checkpoint' ? [(q as Checkpoint).time, (q as Checkpoint).title] : []),
      q.question,
      ...options.map((_, i) => q.options[i] ?? ''),
      answer,
      key.explanation,
    ]);
  });
  const workbook = XLSX.utils.book_new(),
    sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = questionHeaders(kind).map((name) => ({
    wch: name === 'Cau_Hoi' || name === 'Giai_Thich' ? 55 : name.startsWith('Phuong') ? 25 : 20,
  }));
  // Strings remain typed strings, including values starting with '='. No formulas are generated.
  XLSX.utils.book_append_sheet(
    workbook,
    sheet,
    kind === 'quiz' ? 'De_Thi_Sat_Hach' : 'Diem_Dung_Video',
  );
  return new Uint8Array(
    XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true }),
  );
}
export function questionTemplate(kind: QuestionKind) {
  return exportQuestionWorkbook(
    (['single', 'multiple', 'text'] as const).map((type, index) => ({
      kind,
      question: {
        id: 'sample-' + index,
        type,
        question:
          type === 'single'
            ? '[Mẫu] Chọn một phương án'
            : type === 'multiple'
              ? '[Mẫu] Chọn cả hai phương án'
              : '[Mẫu] Nhập từ SSO',
        options: type === 'text' ? [] : ['Phương án A', 'Phương án B'],
        ...(kind === 'checkpoint'
          ? { time: (index + 1) * 10, title: '[Mẫu] Điểm dừng ' + (index + 1) }
          : {}),
      },
      key: {
        answer: type === 'text' ? 'SSO' : type === 'multiple' ? [0, 1] : 0,
        explanation: 'Nội dung giả lập để minh họa cấu trúc tệp.',
      },
    })),
    kind,
  );
}
