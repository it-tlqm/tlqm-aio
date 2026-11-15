import * as XLSX from 'xlsx';
import type { ReportData } from './report-contracts.js';
export function reportWorkbook(data: ReportData, issuedAt: number) {
  const workbook = XLSX.utils.book_new();
  const add = (name: string, rows: (string | number | null)[][], widths: number[]) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  };
  add(
    'Tong_quan',
    [
      ['BÁO CÁO ĐÀO TẠO TLQM AIO'],
      ['Dữ liệu', 'Phiên bản đang phát hành, theo phân công hiện hành'],
      ['Thời điểm xuất UTC', new Date(issuedAt).toISOString()],
      [
        'Đơn vị',
        data.filters.orgUnitId
          ? (data.units.find((unit) => unit.id === data.filters.orgUnitId)?.name ??
            'Đơn vị được chọn')
          : 'Toàn bộ phạm vi được cấp',
      ],
      [
        'Khóa học',
        data.filters.courseId
          ? (data.courseOptions.find((course) => course.id === data.filters.courseId)?.title ??
            'Khóa học được chọn')
          : 'Tất cả khóa được phân',
      ],
      ['Từ khóa', data.filters.search ?? ''],
      [
        'Trạng thái',
        {
          all: 'Tất cả',
          completed: 'Hoàn thành yêu cầu',
          pending: 'Chưa hoàn thành',
          'not-started': 'Chưa bắt đầu',
          'not-required': 'Không có môn bắt buộc',
        }[data.filters.status ?? 'all'],
      ],
      ['Chỉ môn bắt buộc', data.filters.mandatoryOnly ? 'Có' : 'Không'],
      ['Học viên', data.summary.learners],
      ['Có yêu cầu bắt buộc', data.summary.withRequired],
      ['Hoàn thành yêu cầu', data.summary.completed],
      ['Chưa hoàn thành', data.summary.pending],
      ['Không có môn bắt buộc', data.summary.notRequired],
      ['Tỷ lệ hoàn thành (%)', data.summary.completionRate],
      ['Điểm tốt nhất trung bình', data.summary.averageBestScore],
      ['Lượt thi', data.summary.attempts],
      ['Môn bắt buộc quá hạn chưa đạt', data.summary.overdue],
      ['Quy tắc', 'Điểm phiên bản cũ giữ trong lịch sử, không tự tính cho phiên bản mới.'],
      ['Không có yêu cầu', 'Không được tính thành hoàn thành 100%.'],
      ['Bản dùng thử', 'Dữ liệu giả lập; chưa kết nối LMS hiện hữu.'],
    ],
    [34, 100],
  );
  add(
    'Bang_diem',
    [
      [
        'Mã học viên',
        'Họ tên',
        'Đơn vị',
        'Môn bắt buộc',
        'Đã đạt bắt buộc',
        'Trạng thái',
        ...data.courses.map((course) => course.title + ' (v' + course.version + ')'),
      ],
      ...data.rows.map((row) => [
        row.code,
        row.name,
        row.unitName,
        row.required,
        row.passedRequired,
        row.status === 'completed'
          ? 'Hoàn thành'
          : row.status === 'pending'
            ? 'Chưa hoàn thành'
            : 'Không có yêu cầu',
        ...row.cells.map((cell) =>
          !cell.assigned
            ? 'Không phân công'
            : (cell.bestScore ?? (cell.state === 'learning' ? 'Đang học' : 'Chưa thi')),
        ),
      ]),
    ],
    [20, 32, 26, 16, 18, 24, ...data.courses.map(() => 26)],
  );
  add(
    'Chi_tiet',
    [
      [
        'Mã học viên',
        'Họ tên',
        'Đơn vị',
        'Khóa học',
        'Phiên bản',
        'Bắt buộc',
        'Hạn học',
        'Điểm tốt nhất',
        'Lượt thi',
        'Đã xem (%)',
        'Nguồn tiến độ',
        'Nộp gần nhất UTC',
        'Kết quả',
        'Quá hạn chưa đạt',
      ],
      ...data.rows.flatMap((row) =>
        row.cells
          .filter((cell) => cell.assigned)
          .map((cell) => {
            const course = data.courses.find((course) => course.id === cell.courseId)!;
            return [
              row.code,
              row.name,
              row.unitName,
              course.title,
              course.version,
              course.mandatory ? 'Có' : 'Không',
              course.deadline,
              cell.bestScore,
              cell.attempts,
              cell.watchedPct,
              course.tracking === 'self-confirmed'
                ? 'Người học tự xác nhận'
                : 'Trình phát ghi nhận',
              cell.lastAttemptAt ? new Date(cell.lastAttemptAt).toISOString() : '',
              cell.state === 'passed'
                ? 'Đạt'
                : cell.state === 'failed'
                  ? 'Chưa đạt'
                  : cell.state === 'learning'
                    ? 'Đang học'
                    : 'Chưa học',
              cell.overdue ? 'Có' : 'Không',
            ];
          }),
      ),
    ],
    [20, 32, 26, 48, 12, 14, 16, 18, 14, 16, 26, 28, 18, 20],
  );
  add(
    'Don_vi',
    [
      [
        'Đơn vị',
        'Học viên',
        'Có yêu cầu',
        'Hoàn thành',
        'Chưa hoàn thành',
        'Không có yêu cầu',
        'Hoàn thành (%)',
        'Điểm tốt nhất trung bình',
        'Lượt thi',
      ],
      ...data.byUnit.map((unit) => [
        unit.name,
        unit.learners,
        unit.withRequired,
        unit.completed,
        unit.pending,
        unit.notRequired,
        unit.completionRate,
        unit.averageBestScore,
        unit.attempts,
      ]),
    ],
    [32, 16, 16, 18, 22, 22, 20, 28, 16],
  );
  return new Uint8Array(
    XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true }),
  );
}
