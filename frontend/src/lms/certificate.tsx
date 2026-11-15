import { useEffect, useState } from 'react';
import { Award, Download, Printer } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import emblem from '@/assets/brand/emblem-color.png';
import { useCourseCommands } from './course-api';
import type { Certificate } from '../../../src/lms/achievement-contracts';

const date = (time: number) => new Date(time).toLocaleDateString('vi-VN');
async function downloadCertificate(value: Certificate) {
  await document.fonts.ready;
  const logo = new Image();
  logo.src = emblem;
  await logo.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1132;
  const draw = canvas.getContext('2d')!;
  draw.fillStyle = '#FFFFFF';
  draw.fillRect(0, 0, 1600, 1132);
  draw.strokeStyle = '#223873';
  draw.lineWidth = 3;
  draw.strokeRect(28, 28, 1544, 1076);
  draw.fillStyle = '#087C3C';
  draw.fillRect(28, 28, 1544, 10);
  draw.drawImage(logo, 750, 65, 100, 100);
  draw.textAlign = 'center';
  const line = (text: string, y: number, size = 24, color = '#475467', weight = 400) => {
    draw.fillStyle = color;
    draw.font = `${weight} ${size}px "Be Vietnam Pro", Arial`;
    draw.fillText(text, 800, y, 1420);
  };
  const wrap = (text: string, start: number, size: number, color: string) => {
    draw.font = `600 ${size}px "Be Vietnam Pro", Arial`;
    const words = text.split(/\s+/),
      lines: string[] = [];
    let row = '';
    for (const word of words) {
      if (row && draw.measureText(row + ' ' + word).width > 1360) {
        lines.push(row);
        row = word;
      } else row += (row ? ' ' : '') + word;
    }
    if (row) lines.push(row);
    lines.forEach((text, index) => line(text, start + index * (size + 12), size, color, 600));
    return start + lines.length * (size + 12);
  };
  line('CÔNG TY CỔ PHẦN TÀ LÙNG QUANG MINH', 210, 25, '#223873', 600);
  line('CHỨNG NHẬN HOÀN THÀNH KHÓA HỌC', 285, 40, '#223873', 700);
  line('Hệ thống đào tạo nội bộ · TLQM AIO', 330);
  let y = wrap(value.recipientName, 415, 42, '#087C3C');
  line('Mã học viên: ' + value.employeeCode, y + 10, 22);
  line('Đã hoàn thành bài học và đạt yêu cầu bài kiểm tra', y + 58, 24);
  y = wrap(value.courseTitle, y + 120, 32, '#223873');
  y = wrap(value.series + ' · Phiên bản ' + value.version, y + 10, 22, '#475467');
  line(
    'Kết quả: ' + value.score + '/100 · Ngày hoàn thành: ' + date(value.completedAt),
    y + 35,
    25,
    '#087C3C',
    600,
  );
  line('Ngày cấp: ' + date(value.issuedAt), y + 78, 22);
  line(
    value.tracking === 'self-confirmed'
      ? 'Tiến độ video do học viên tự xác nhận.'
      : 'Tiến độ do trình phát ghi nhận.',
    932,
    20,
  );
  line(value.code, 984, 22, '#223873', 600);
  line('Tra cứu mã trong mục Thành tích của LMS bằng tài khoản được cấp quyền.', 1025, 19);
  line('BẢN DÙNG THỬ · DỮ LIỆU GIẢ LẬP', 1066, 18);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('Export failed'))),
      'image/png',
    ),
  );
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = value.code + '.png';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function CertificateView({ value }: { value: Certificate }) {
  return (
    <article
      className="lms-certificate rounded-xl border border-[var(--brand-navy)] border-t-4 border-t-primary bg-white p-5 text-center sm:p-8"
      aria-label="Nội dung chứng nhận"
    >
      <img
        src={emblem}
        width={64}
        height={64}
        alt="Tà Lùng Quang Minh"
        className="mx-auto mb-3 size-16 object-contain"
      />
      <p className="text-xs font-semibold tracking-wide text-[var(--brand-navy)]">
        CÔNG TY CỔ PHẦN TÀ LÙNG QUANG MINH
      </p>
      <h3 className="mt-6 text-2xl font-semibold leading-snug">Chứng nhận hoàn thành khóa học</h3>
      <p className="mt-2 text-sm text-muted-foreground">Hệ thống đào tạo nội bộ · TLQM AIO</p>
      <p className="mt-7 break-words text-2xl font-semibold text-primary">{value.recipientName}</p>
      <p className="mt-2 break-words text-sm">Mã học viên: {value.employeeCode}</p>
      <p className="mt-6 text-sm text-muted-foreground">
        Đã hoàn thành bài học và đạt yêu cầu bài kiểm tra
      </p>
      <p className="mt-3 break-words text-xl font-semibold text-[var(--brand-navy)]">
        {value.courseTitle}
      </p>
      <p className="mt-2 break-words text-sm text-muted-foreground">
        {value.series} · Phiên bản {value.version}
      </p>
      <div className="my-6 grid gap-4 rounded-lg bg-secondary p-4 text-sm sm:grid-cols-3">
        <p>
          Kết quả<strong className="mt-1 block text-xl text-primary">{value.score}/100</strong>
        </p>
        <p>
          Ngày hoàn thành<strong className="mt-1 block">{date(value.completedAt)}</strong>
        </p>
        <p>
          Ngày cấp<strong className="mt-1 block">{date(value.issuedAt)}</strong>
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {value.tracking === 'self-confirmed'
          ? 'Tiến độ video do học viên tự xác nhận.'
          : 'Tiến độ do trình phát ghi nhận.'}
      </p>
      <p className="mt-5 break-all font-mono text-xs font-semibold text-[var(--brand-navy)]">
        {value.code}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Tra cứu mã trong mục Thành tích bằng tài khoản được cấp quyền.
      </p>
      <p className="mt-4 text-xs font-medium text-muted-foreground">
        Bản dùng thử · Dữ liệu giả lập
      </p>
    </article>
  );
}
export function CertificateButton({
  attemptId,
  code,
  csrfToken = '',
  onAccessError,
}: {
  attemptId?: string;
  code?: string;
  csrfToken?: string;
  onAccessError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false),
    [value, setValue] = useState<Certificate | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const command = useCourseCommands(csrfToken);
  const fail = (error: unknown) => {
    setValue(null);
    setError(error);
    if (error instanceof ApiError && [401, 403].includes(error.status)) onAccessError(error);
  };
  async function load() {
    setBusy(true);
    setError(null);
    setValue(null);
    try {
      const issued = attemptId
        ? await command<{ code: string }>('issue-certificate', { attemptId })
        : { code: code! };
      setValue(
        await api<Certificate>('/api/lms/certificate?code=' + encodeURIComponent(issued.code)),
      );
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!open) setValue(null);
  }, [open]);
  async function output(kind: 'print' | 'png') {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const current = await api<Certificate>(
        '/api/lms/certificate?code=' + encodeURIComponent(value.code),
      );
      if (kind === 'png') await downloadCertificate(current);
      else {
        await document.fonts.ready;
        window.print();
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Award aria-hidden="true" />
          {attemptId ? 'Chứng nhận' : 'Tra cứu chứng nhận'}
        </Button>
      </DialogTrigger>
      <DialogContent className="lms-certificate-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader className="lms-certificate-controls">
          <DialogTitle>Chứng nhận học tập</DialogTitle>
          <DialogDescription>
            Kết quả được cấp từ bài kiểm tra đạt ngưỡng của phiên bản đã học và giữ nguyên lịch sử.
          </DialogDescription>
        </DialogHeader>
        {busy && !value && <p role="status">Đang kiểm tra và tải chứng nhận…</p>}
        {Boolean(error) && (
          <Alert variant="destructive">
            <AlertDescription>
              {errorMessage(error)}
              <Button variant="outline" disabled={busy} onClick={() => void load()}>
                Thử lại
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {value && (
          <>
            <CertificateView value={value} />
            <div className="lms-certificate-controls flex flex-wrap justify-end gap-3">
              <Button variant="outline" disabled={busy} onClick={() => void output('png')}>
                <Download aria-hidden="true" />
                Tải ảnh PNG
              </Button>
              <Button disabled={busy} onClick={() => void output('print')}>
                <Printer aria-hidden="true" />
                In / Lưu PDF
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
