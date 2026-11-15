import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { can, Choice } from '../forms/common';
import type { DefinitionItem, WorkflowLookup, workflowWrite } from './common';
import type { ScheduleTiming } from '../../../src/workflows/scheduled-requests';

type Page<T> = { items: T[]; nextCursor: string | null };
type Recipient = { id: string; name: string };
type Schedule = {
  id: string;
  title: string;
  workflow_name: string;
  version: number;
  revision: number;
  org_unit_id: string;
  next_run_at: string | null;
  enabled: boolean;
  cadence: ScheduleTiming['cadence'];
  every: number;
  start_date: string;
  end_date: string | null;
  local_time: string;
};
type Job = {
  id: string;
  scheduled_for: string;
  status: string;
  attempts: number;
  error_code: string | null;
  history: { attempt: number; status: string; error_code: string | null; recorded_at: string }[];
};
const frequencies: Record<ScheduleTiming['cadence'], string> = {
  once: 'Một lần',
  daily: 'Theo ngày',
  weekly: 'Theo tuần',
  monthly: 'Theo tháng',
  yearly: 'Theo năm',
};
const intervalUnits = { daily: 'ngày', weekly: 'tuần', monthly: 'tháng', yearly: 'năm' } as const;
const states: Record<string, string> = {
  queued: 'Đang chờ',
  retry: 'Chờ thử lại',
  done: 'Đã tạo nháp',
  blocked: 'Đã dừng',
};
const timestamp = (value: string) =>
  new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));

export function WorkflowSchedules({
  me,
  tenantId,
  definitions,
  lookup,
  write,
}: {
  me: Me;
  tenantId: string;
  definitions: DefinitionItem[];
  lookup: WorkflowLookup;
  write: ReturnType<typeof workflowWrite>;
}) {
  const [title, setTitle] = useState('');
  const [definitionId, setDefinition] = useState('');
  const [unitId, setUnit] = useState('');
  const [recipient, setRecipient] = useState('');
  const [search, setSearch] = useState('');
  const [recipientOptions, setRecipientOptions] = useState<Recipient[]>([]);
  const [cadence, setCadence] = useState<ScheduleTiming['cadence']>('once');
  const [every, setEvery] = useState('1');
  const [startDate, setStart] = useState('');
  const [endDate, setEnd] = useState('');
  const [localTime, setTime] = useState('08:00');
  const [reason, setReason] = useState('');
  const [operationReason, setOperationReason] = useState('');
  const [schedules, setSchedules] = useState<Page<Schedule>>({ items: [], nextCursor: null });
  const [jobs, setJobs] = useState<Page<Job> & { recipientName?: string }>({
    items: [],
    nextCursor: null,
  });
  const [selected, select] = useState('');
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const published = definitions.filter(
    (item) => item.canPublish && item.status === 'published' && item.version,
  );
  const version = published.find((item) => item.id === definitionId)?.version;
  const units = lookup.units.filter(
    ({ id }) =>
      version?.spec.audienceUnits.includes(id) && can(me, tenantId, 'workflows:publish', id),
  );
  const schedule = schedules.items.find((item) => item.id === selected);
  const valid = !!(
    title.trim() &&
    version &&
    units.some(({ id }) => id === unitId) &&
    recipient &&
    startDate &&
    localTime &&
    (!endDate || endDate >= startDate) &&
    Number.isInteger(Number(every)) &&
    Number(every) >= 1 &&
    Number(every) <= 365 &&
    reason.trim().length >= 5
  );
  const path = (suffix: string, query: Record<string, string> = {}) =>
    '/api/v1/workflows' + suffix + '?' + new URLSearchParams({ tenantId, ...query });
  useEffect(() => {
    const controller = new AbortController();
    void api<Page<Schedule>>(
      '/api/v1/workflows/draft-schedules?' + new URLSearchParams({ tenantId }),
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setSchedules(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure);
      });
    return () => controller.abort();
  }, [tenantId]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ tenantId });
    void api<Page<Job> & { recipientName?: string }>(
      '/api/v1/workflows/draft-schedules/' + selected + '/jobs?' + query,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setJobs(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure);
      });
    return () => controller.abort();
  }, [tenantId, selected]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await action();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function loadSchedules(after?: string) {
    const result = await api<Page<Schedule>>(path('/draft-schedules', after ? { after } : {}));
    setSchedules((old) => ({
      ...result,
      items: after ? [...old.items, ...result.items] : result.items,
    }));
  }
  async function loadJobs(after?: string) {
    const result = await api<Page<Job> & { recipientName?: string }>(
      path('/draft-schedules/' + selected + '/jobs', after ? { after } : {}),
    );
    setJobs((old) => ({
      ...result,
      items: after ? [...old.items, ...result.items] : result.items,
    }));
  }
  function changeUnit(id: string) {
    setUnit(id);
    setRecipient('');
    setRecipientOptions([]);
    setSearch('');
  }
  async function lookupRecipients() {
    setSearching(true);
    setError(null);
    try {
      const result = await api<{ items: Recipient[] }>(
        path('/draft-schedule-recipients', { unitId, definitionId, search }),
      );
      setRecipientOptions(result.items);
      setRecipient('');
      if (!result.items.length) setNotice('Không tìm thấy người có quyền khởi tạo trong đơn vị.');
    } catch (failure) {
      setError(failure);
    } finally {
      setSearching(false);
    }
  }
  async function createSchedule() {
    if (!version || !valid) return;
    const result = await write<{ id: string }>(
      '/draft-schedules',
      {
        title,
        definitionId,
        versionId: version.id,
        unitId,
        recipientAccountId: recipient,
        cadence,
        every: cadence === 'once' ? 1 : Number(every),
        startDate,
        localTime,
        ...(endDate ? { endDate } : {}),
      },
      reason,
    );
    await loadSchedules();
    select(result.id);
    setJobs({ items: [], nextCursor: null });
    setTitle('');
    setReason('');
    setNotice('Đã lưu lịch tạo nháp.');
  }
  return (
    <div className="space-y-5">
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm text-[var(--success)]">
          {notice}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Tạo lịch nháp</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="schedule-title">Tiêu đề nháp</Label>
            <Input
              id="schedule-title"
              value={title}
              maxLength={160}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Choice
              label="Quy trình theo lịch"
              value={definitionId}
              disabled={busy || searching}
              onChange={(id) => {
                setDefinition(id);
                changeUnit('');
              }}
              options={published.map((item) => ({
                id: item.id,
                name: item.version!.spec.name + ' · v' + item.version!.version,
              }))}
            />
            <Choice
              label="Đơn vị nhận nháp"
              value={unitId}
              onChange={changeUnit}
              options={units}
              disabled={!version || busy || searching}
            />
          </div>
          <div className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label htmlFor="schedule-recipient-search">Tìm người nhận nháp</Label>
              <Input
                id="schedule-recipient-search"
                value={search}
                maxLength={100}
                disabled={!unitId || busy || searching}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && unitId) void lookupRecipients();
                }}
              />
            </div>
            <Button
              variant="outline"
              disabled={!unitId || busy || searching}
              onClick={() => void lookupRecipients()}
            >
              Tìm người nhận
            </Button>
            <Choice
              label="Người nhận nháp"
              value={recipient}
              onChange={setRecipient}
              options={recipientOptions}
              disabled={!recipientOptions.length || searching || busy}
            />
          </div>
          <fieldset className="grid gap-4 rounded-lg border p-4 md:grid-cols-3">
            <legend className="px-1 font-medium">Thời điểm tạo nháp (giờ Việt Nam)</legend>
            <Choice
              label="Tần suất"
              value={cadence}
              onChange={(value) => {
                setCadence(value as ScheduleTiming['cadence']);
                setEvery('1');
                if (value === 'once') setEnd('');
              }}
              options={Object.entries(frequencies).map(([id, name]) => ({ id, name }))}
            />
            {cadence !== 'once' && (
              <div className="space-y-2">
                <Label htmlFor="schedule-every">Lặp lại sau mỗi</Label>
                <Input
                  id="schedule-every"
                  type="number"
                  min={1}
                  max={365}
                  value={every}
                  onChange={(e) => setEvery(e.target.value)}
                />
              </div>
            )}
            <div className="min-w-0 space-y-2">
              <Label htmlFor="schedule-time">Giờ tạo nháp</Label>
              <Input
                id="schedule-time"
                type="time"
                value={localTime}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="schedule-start">Ngày bắt đầu</Label>
              <Input
                id="schedule-start"
                type="date"
                value={startDate}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            {cadence !== 'once' && (
              <div className="min-w-0 space-y-2">
                <Label htmlFor="schedule-end">Ngày kết thúc (tùy chọn)</Label>
                <Input
                  id="schedule-end"
                  type="date"
                  min={startDate || undefined}
                  value={endDate}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </div>
            )}
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="schedule-reason">Lý do tạo lịch</Label>
            <Input
              id="schedule-reason"
              maxLength={240}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            disabled={!valid || busy || searching}
            onClick={() => void perform(createSchedule)}
          >
            Lưu lịch tạo nháp
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Lịch đã lưu</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 grow">
              <Choice
                label="Lịch tạo nháp"
                value={selected}
                onChange={(id) => {
                  select(id);
                  setJobs({ items: [], nextCursor: null });
                }}
                options={schedules.items.map((item) => ({ id: item.id, name: item.title }))}
                disabled={busy}
              />
            </div>
            {schedules.nextCursor && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void perform(() => loadSchedules(schedules.nextCursor!))}
              >
                Thêm lịch
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await loadSchedules();
                  if (selected) await loadJobs();
                })
              }
            >
              Tải lại lịch
            </Button>
          </div>
          {!schedules.items.length && (
            <p className="text-sm text-muted-foreground">Chưa có lịch trong phạm vi của bạn.</p>
          )}
          {schedule && (
            <>
              <div className="flex flex-wrap gap-3 text-sm">
                <Badge variant="outline">
                  {schedule.enabled
                    ? schedule.next_run_at
                      ? 'Đang chạy'
                      : 'Đã hết lịch'
                    : 'Đã tắt'}
                </Badge>
                <span>
                  {schedule.workflow_name} · v{schedule.version}
                </span>
                <span>
                  {schedule.cadence === 'once'
                    ? frequencies.once
                    : 'Mỗi ' + schedule.every + ' ' + intervalUnits[schedule.cadence]}{' '}
                  · {schedule.local_time}
                </span>
                <span>
                  Từ {schedule.start_date.split('-').reverse().join('/')}
                  {schedule.end_date && ' đến ' + schedule.end_date.split('-').reverse().join('/')}
                </span>
                {schedule.next_run_at && <span>Kỳ tới {timestamp(schedule.next_run_at)}</span>}
                {jobs.recipientName && <span>Người nhận {jobs.recipientName}</span>}
              </div>
              {schedule.enabled && (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-0 grow space-y-2">
                    <Label htmlFor="schedule-operation-reason">Lý do tắt hoặc thử lại</Label>
                    <Input
                      id="schedule-operation-reason"
                      value={operationReason}
                      maxLength={240}
                      onChange={(e) => setOperationReason(e.target.value)}
                    />
                  </div>
                  <Button
                    variant="outline"
                    disabled={busy || operationReason.trim().length < 5}
                    onClick={() =>
                      void perform(async () => {
                        await write(
                          '/draft-schedules/' + selected + '/disable',
                          { expectedRevision: schedule.revision },
                          operationReason,
                        );
                        await loadSchedules();
                        await loadJobs();
                        setNotice('Đã tắt lịch tạo nháp.');
                      })
                    }
                  >
                    Tắt lịch
                  </Button>
                </div>
              )}
              <h3 className="font-medium">Lịch sử chạy</h3>
              {!jobs.items.length && (
                <p className="text-sm text-muted-foreground">Chưa có kỳ chạy.</p>
              )}
              <ul className="divide-y">
                {jobs.items.map((job) => (
                  <li key={job.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span>{timestamp(job.scheduled_for)}</span>
                      <Badge variant="outline">{states[job.status]}</Badge>
                      <span className="text-sm text-muted-foreground">
                        {job.attempts} lần xử lý
                      </span>
                      {job.status === 'blocked' && schedule.enabled && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || operationReason.trim().length < 5}
                          onClick={() =>
                            void perform(async () => {
                              await write(
                                '/draft-schedule-jobs/' + job.id + '/retry',
                                { expectedRevision: job.attempts },
                                operationReason,
                              );
                              await loadJobs();
                              setNotice('Đã đưa kỳ chạy vào hàng chờ.');
                            })
                          }
                        >
                          Thử lại
                        </Button>
                      )}
                    </div>
                    {job.error_code && (
                      <p className="text-sm">{errorMessage(new ApiError(409, job.error_code))}</p>
                    )}
                    {!!job.history.length && (
                      <details className="text-sm">
                        <summary className="cursor-pointer">Các lần xử lý gần đây</summary>
                        <ul className="space-y-1 pl-4">
                          {job.history.map((attempt) => (
                            <li key={attempt.attempt}>
                              {timestamp(attempt.recorded_at)} · {states[attempt.status]}
                              {attempt.error_code &&
                                ' · ' + errorMessage(new ApiError(409, attempt.error_code))}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
              {jobs.nextCursor && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void perform(() => loadJobs(jobs.nextCursor!))}
                >
                  Xem kỳ cũ hơn
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
