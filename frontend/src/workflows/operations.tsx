import { useEffect, useId, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Choice } from '../forms/common';
import type { workflowWrite } from './common';
import type {
  OperationItem,
  OperationKind,
  OperationStatus,
  OperationView,
} from '../../../src/workflows/operations-options';

const sources = {
  link: 'Quy trình liên kết',
  schedule: 'Nháp định kỳ',
  email: 'Email',
  intake: 'Chuyển đề nghị',
};
const views = { attention: 'Cần kiểm tra', active: 'Đang chờ xử lý', resolved: 'Đã xử lý' };
const statuses: Record<OperationStatus, string> = {
  queued: 'Đang chờ',
  retry: 'Chờ thử lại',
  blocked: 'Đã dừng',
  done: 'Hoàn thành',
  skipped: 'Bỏ qua',
};
const retryPaths = {
  link: '/link-jobs/',
  schedule: '/draft-schedule-jobs/',
  email: '/output-jobs/',
  intake: '/intake-jobs/',
};
const date = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'Asia/Ho_Chi_Minh',
});
const choices = (values: Record<string, string>) =>
  Object.entries(values).map(([id, name]) => ({ id, name }));

export function WorkflowOperations({
  tenantId,
  write,
  openRun,
}: {
  tenantId: string;
  write: ReturnType<typeof workflowWrite>;
  openRun: (id: string) => void;
}) {
  const [kind, setKind] = useState<OperationKind>('intake');
  const [view, setView] = useState<OperationView>('attention');
  const [runInput, setRunInput] = useState('');
  const [runId, setRunId] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data?: { items: OperationItem[]; nextCursor: string | null };
    error?: unknown;
  }>();
  const [retry, setRetry] = useState<OperationItem | null>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const runLabel = useId(),
    reasonLabel = useId();
  const after = cursors.at(-1);
  const endpoint =
    '/api/v1/workflows/operations?' +
    new URLSearchParams({ tenantId, kind, view, ...(runId && { runId }), ...(after && { after }) });
  const key = endpoint + '#' + refresh;
  const current = state?.key === key ? state : undefined;
  useEffect(() => {
    const request = new AbortController();
    void api<{ items: OperationItem[]; nextCursor: string | null }>(endpoint, {
      signal: request.signal,
    })
      .then((data) => {
        if (!request.signal.aborted) setState({ key, data });
      })
      .catch((error: unknown) => {
        if (!request.signal.aborted) setState({ key, error });
      });
    return () => request.abort();
  }, [endpoint, key]);
  const reset = () => {
    setCursors([]);
    setRetry(null);
    setFailure(null);
    setNotice('');
  };

  async function requeue() {
    if (busy || !retry || reason.trim().length < 5) return;
    setBusy(true);
    setFailure(null);
    setNotice('');
    try {
      await write(
        retryPaths[kind] + retry.id + '/retry',
        { expectedRevision: retry.attempts },
        reason.trim(),
      );
      reset();
      setView('active');
      setRefresh((value) => value + 1);
      setNotice('Đã đưa job vào hàng chờ. Xem kết quả trong nhóm Đã xử lý sau khi worker chạy.');
    } catch (error) {
      setFailure(error);
      if (error instanceof ApiError && [401, 403, 409].includes(error.status)) {
        setRetry(null);
        setRefresh((value) => value + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Vận hành job Quy trình" className="min-w-0 space-y-4 py-4">
      <h2 className="text-xl font-semibold">Vận hành job</h2>
      <fieldset disabled={busy} className="flex min-w-0 flex-wrap items-end gap-3">
        <Choice
          label="Loại job"
          value={kind}
          options={choices(sources)}
          onChange={(value) => {
            reset();
            setKind(value as OperationKind);
          }}
        />
        <Choice
          label="Trạng thái vận hành"
          value={view}
          options={choices(views)}
          onChange={(value) => {
            reset();
            setView(value as OperationView);
          }}
        />
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            reset();
            setRunId(runInput.trim());
          }}
        >
          <div className="min-w-0 space-y-1">
            <Label htmlFor={runLabel}>Mã lượt chạy</Label>
            <Input
              id={runLabel}
              maxLength={36}
              value={runInput}
              onChange={(event) => setRunInput(event.target.value)}
            />
          </div>
          <Button variant="outline" type="submit">
            Lọc lượt chạy
          </Button>
        </form>
        <Button
          variant="outline"
          onClick={() => {
            reset();
            setRefresh((value) => value + 1);
          }}
        >
          Tải lại job
        </Button>
      </fieldset>
      {notice && <p role="status">{notice}</p>}
      {failure != null && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(failure)}</AlertDescription>
        </Alert>
      )}
      {!current && <p role="status">Đang tải job…</p>}
      {current?.error != null && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(current.error)}</AlertDescription>
        </Alert>
      )}
      {current?.data && (
        <>
          {!current.data.items.length && (
            <p role="status" className="text-muted-foreground">
              Không có job trong phạm vi này.
            </p>
          )}
          <ul className="divide-y rounded-md border bg-card">
            {current.data.items.map((item) => (
              <li key={item.id} className="min-w-0 space-y-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-words font-medium">
                    {item.workflowName} · v{item.version}
                  </h3>
                  <Badge
                    variant={item.overdue || item.status === 'blocked' ? 'destructive' : 'outline'}
                  >
                    {item.overdue ? 'Quá hạn xử lý' : statuses[item.status]}
                  </Badge>
                </div>
                <p className="break-all text-sm text-muted-foreground">{item.id}</p>
                <p className="text-sm">
                  {item.attempts} lần xử lý · {date.format(new Date(item.updatedAt))}
                </p>
                {item.nextAttemptAt && (
                  <p className="text-sm">Đến hạn {date.format(new Date(item.nextAttemptAt))}</p>
                )}
                {item.errorCode && (
                  <p className="break-words text-sm">
                    {errorMessage(new ApiError(409, item.errorCode))}
                  </p>
                )}
                {item.history.length > 0 && (
                  <details className="text-sm">
                    <summary>Lịch sử xử lý</summary>
                    <ol className="mt-2 space-y-1">
                      {item.history.map((entry) => (
                        <li key={entry.attempt}>
                          Lần {entry.attempt} · {statuses[entry.status]} ·{' '}
                          {date.format(new Date(entry.recordedAt))}
                          {entry.errorCode && (
                            <> · {errorMessage(new ApiError(409, entry.errorCode))}</>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                <div className="flex flex-wrap gap-2">
                  {item.runId && (
                    <Button variant="outline" disabled={busy} onClick={() => openRun(item.runId!)}>
                      Mở lượt chạy
                    </Button>
                  )}
                  {item.canRetry && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setRetry(item);
                        setReason('');
                        setFailure(null);
                      }}
                    >
                      Thử lại job
                    </Button>
                  )}
                </div>
                {retry?.id === item.id && (
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void requeue();
                    }}
                  >
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={reasonLabel}>Lý do thử lại</Label>
                      <Input
                        id={reasonLabel}
                        required
                        minLength={5}
                        maxLength={240}
                        disabled={busy}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </div>
                    <Button type="submit" disabled={busy || reason.trim().length < 5}>
                      Đưa vào hàng chờ
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRetry(null)}
                    >
                      Hủy
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {(after || current.data.nextCursor) && (
            <nav className="flex flex-wrap gap-2" aria-label="Phân trang job">
              <Button
                variant="outline"
                disabled={!after || busy}
                onClick={() => {
                  setRetry(null);
                  setCursors(cursors.slice(0, -1));
                }}
              >
                Trang trước
              </Button>
              <Button
                variant="outline"
                disabled={!current.data.nextCursor || busy}
                onClick={() => {
                  setRetry(null);
                  setCursors([...cursors, current.data!.nextCursor!]);
                }}
              >
                Trang sau
              </Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
