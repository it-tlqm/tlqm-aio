import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Choice } from '../forms/common';
import { useCourseCommands } from './course-api';
type Policy = {
  unit_id: string;
  enabled: number;
  before_minutes: number;
  overdue_minutes: number;
  revision: number;
};
type Data = {
  items: Policy[];
  units: { id: string; name: string }[];
  worker: {
    last_completed_at: number | null;
    last_error_code: string | null;
    delivered: number;
  } | null;
};
export function TrainingReminderSettings({
  csrfToken,
  onDirtyChange,
}: {
  csrfToken: string;
  onDirtyChange: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Data | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [unit, setUnit] = useState(''),
    [enabled, setEnabled] = useState(false),
    [before, setBefore] = useState('1440'),
    [overdue, setOverdue] = useState('60'),
    [reason, setReason] = useState(''),
    [dirty, setDirty] = useState(false),
    [message, setMessage] = useState('');
  const command = useCourseCommands(csrfToken, '/api/lms/training-commands');
  useEffect(() => {
    onDirtyChange(open && dirty);
    return () => onDirtyChange(false);
  }, [open, dirty, onDirtyChange]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setData(null);
    setUnit('');
    setReason('');
    setDirty(false);
    setError(null);
    setMessage('');
    void api<Data>('/api/lms/training-reminder-policies', { signal: controller.signal })
      .then((r) => {
        if (!controller.signal.aborted) setData(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      });
    return () => controller.abort();
  }, [open]);
  function choose(id: string) {
    setUnit(id);
    const p = data?.items.find((p) => p.unit_id === id);
    setEnabled(!!p?.enabled);
    setBefore(String(p?.before_minutes ?? 1440));
    setOverdue(String(p?.overdue_minutes ?? 60));
    setDirty(false);
    setMessage('');
  }
  async function save() {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await command(
        'save-reminder-policy',
        {
          unitId: unit,
          enabled,
          beforeMinutes: Number(before),
          overdueMinutes: Number(overdue),
          expectedRevision: data?.items.find((p) => p.unit_id === unit)?.revision ?? 0,
        },
        { reason },
      );
      setData(await api<Data>('/api/lms/training-reminder-policies'));
      setDirty(false);
      setMessage('Đã lưu chính sách nhắc hạn đào tạo.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
      <DialogTrigger asChild>
        <Button variant="outline">Nhắc hạn đào tạo</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Cấu hình nhắc hạn đào tạo</DialogTitle>
          <DialogDescription>
            Áp dụng theo đơn vị phụ trách đợt. Đơn vị chưa cấu hình mặc định tắt.
          </DialogDescription>
        </DialogHeader>
        {Boolean(error) && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        )}
        {message && (
          <p role="status" className="rounded-lg bg-secondary p-3">
            {message}
          </p>
        )}
        {!data && !error && <p role="status">Đang tải chính sách nhắc hạn…</p>}
        {data && (
          <div className="space-y-4">
            <Choice
              label="Đơn vị nhắc hạn đào tạo"
              value={unit || '_none'}
              onChange={(v) => choose(v === '_none' ? '' : v)}
              options={[{ id: '_none', name: 'Chọn đơn vị phụ trách' }, ...data.units]}
            />
            {unit && (
              <>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={enabled}
                    disabled={busy}
                    onCheckedChange={(v) => {
                      setEnabled(v === true);
                      setDirty(true);
                    }}
                  />
                  <span>Bật nhắc hạn cho đơn vị</span>
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="training-before">Phút trước hạn</Label>
                    <Input
                      id="training-before"
                      type="number"
                      min="0"
                      max="10080"
                      value={before}
                      disabled={busy}
                      onChange={(e) => {
                        setBefore(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="training-overdue">Phút sau khi quá hạn</Label>
                    <Input
                      id="training-overdue"
                      type="number"
                      min="1"
                      max="10080"
                      value={overdue}
                      disabled={busy}
                      onChange={(e) => {
                        setOverdue(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  0 phút trước hạn để chỉ nhắc khi quá hạn. Mỗi loại nhắc một lần cho mỗi học viên
                  và phiên bản lịch đợt; sửa lịch sẽ đối soát lại.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="training-reminder-reason">Lý do thay đổi nhắc hạn</Label>
                  <Input
                    id="training-reminder-reason"
                    value={reason}
                    maxLength={240}
                    disabled={busy}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              </>
            )}
            <p className="text-sm text-muted-foreground">
              Lần đối soát gần nhất:{' '}
              {data.worker?.last_completed_at
                ? new Date(data.worker.last_completed_at).toLocaleString('vi-VN')
                : 'Chưa có'}
              .{' '}
              {data.worker?.last_error_code ? 'Lần chạy gần nhất có lỗi; hệ thống sẽ thử lại.' : ''}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Đóng
          </Button>
          <Button
            disabled={
              busy ||
              !data ||
              !unit ||
              reason.trim().length < 5 ||
              !Number.isInteger(Number(before)) ||
              !Number.isInteger(Number(overdue)) ||
              Number(before) < 0 ||
              Number(before) > 10080 ||
              Number(overdue) < 1 ||
              Number(overdue) > 10080
            }
            onClick={() => void save()}
          >
            Lưu nhắc hạn đào tạo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
