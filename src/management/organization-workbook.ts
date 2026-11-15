import * as XLSX from 'xlsx';
import { HttpError } from '../security.js';
import { verifyOrganizationZip } from './workbook-zip.js';
export const organizationHeaders = {
  DonVi: ['Ma', 'Ten', 'MaPhapNhan', 'MaDonViCha'],
  ChucDanh: ['Ma', 'Ten'],
  ViTri: ['MaNhap', 'Ten', 'MaPhapNhan', 'MaDonVi', 'MaChucDanh'],
  NhanSu: ['MaNhanSu', 'HoTen', 'MaPhapNhan', 'ViTri', 'NgayBatDau', 'NhanSuId'],
} as const;
export type ImportSheet = keyof typeof organizationHeaders;
export type ImportRow = { sheet: ImportSheet; row: number; values: Record<string, string> };
export type ImportIssue = { sheet: string; row: number; column: string; message: string };
export function organizationTemplate() {
  const workbook = XLSX.utils.book_new();
  for (const [name, columns] of Object.entries(organizationHeaders)) {
    const sheet = XLSX.utils.aoa_to_sheet([[...columns]]);
    sheet['!cols'] = columns.map((c) => ({
      wch: c === 'HoTen' || c === 'Ten' ? 32 : c === 'NhanSuId' || c === 'ViTri' ? 40 : 22,
    }));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return new Uint8Array(
    XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', compression: true }),
  );
}
export async function parseOrganizationWorkbook(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 2 * 1024 * 1024)
    throw new HttpError(413, 'ORGANIZATION_WORKBOOK_TOO_LARGE');
  let workbook: XLSX.WorkBook;
  try {
    await verifyOrganizationZip(bytes);
    workbook = XLSX.read(bytes, {
      type: 'array',
      raw: true,
      nodim: true,
      sheetRows: 502,
      cellFormula: true,
      cellHTML: false,
      cellText: false,
      cellDates: false,
      bookVBA: true,
    });
    if (workbook.vbaraw) throw new Error('macro');
  } catch {
    throw new HttpError(400, 'ORGANIZATION_WORKBOOK_INVALID');
  }
  const rows: ImportRow[] = [],
    errors: ImportIssue[] = [];
  if (
    workbook.SheetNames.length > 4 ||
    workbook.SheetNames.some((s) => !Object.hasOwn(organizationHeaders, s))
  )
    throw new HttpError(400, 'ORGANIZATION_WORKBOOK_SHEETS');
  for (const name of workbook.SheetNames) {
    const key = name as ImportSheet,
      headers = organizationHeaders[key],
      sheet = workbook.Sheets[name]!;
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref']);
    if (range.s.r !== 0 || range.s.c !== 0 || range.e.r > 500 || range.e.c >= headers.length)
      throw new HttpError(400, 'ORGANIZATION_WORKBOOK_LIMIT');
    const cell = (r: number, c: number) => {
      const value = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!value) return '';
      if (
        value.f ||
        value.F ||
        value.l ||
        value.t === 'e' ||
        !['s', 'n'].includes(value.t) ||
        String(value.v ?? '').length > 160
      ) {
        errors.push({
          sheet: name,
          row: r + 1,
          column: headers[c]!,
          message: 'Chỉ nhận văn bản/số, tối đa 160 ký tự; không nhận công thức hoặc liên kết.',
        });
        return '';
      }
      return String(value.v ?? '').trim();
    };
    if (headers.some((h, c) => cell(0, c) !== h)) {
      errors.push({ sheet: name, row: 1, column: '', message: 'Tiêu đề không khớp tệp mẫu.' });
      continue;
    }
    for (let r = 1; r <= range.e.r; r++) {
      const values = Object.fromEntries(headers.map((h, c) => [h, cell(r, c)]));
      if (Object.values(values).some(Boolean)) rows.push({ sheet: key, row: r + 1, values });
    }
  }
  if (rows.length > 500) throw new HttpError(400, 'ORGANIZATION_WORKBOOK_LIMIT');
  if (!rows.length && !errors.length)
    errors.push({ sheet: '', row: 0, column: '', message: 'Tệp chưa có dòng dữ liệu.' });
  return { rows, errors };
}
