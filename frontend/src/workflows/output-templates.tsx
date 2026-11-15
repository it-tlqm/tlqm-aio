import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { can, Choice } from '../forms/common';
import {
  outputEvents,
  outputFields,
  stepOutputEvents,
} from '../../../src/workflows/output-templates';
import type { OutputEvent, OutputTemplate } from '../../../src/workflows/output-templates';
import type { DefinitionItem, WorkflowLookup, workflowWrite } from './common';

const endpoint = (tenantId: string, path: string, params: Record<string, string> = {}) =>
  '/api/v1/workflows' + path + '?' + new URLSearchParams({ tenantId, ...params });
type Template = OutputTemplate & { workflow_name: string; workflow_version: number };
type Job = {
  id: string;
  status: string;
  attempts: number;
  error_code?: string;
  history: { attempt: number; status: string; recorded_at: string }[];
};
const statusLabels: Record<string, string> = {
  queued: 'Đang chờ',
  retry: 'Chờ thử lại',
  done: 'Đã ghi vào hộp thư',
  blocked: 'Đã dừng',
  skipped: 'Bỏ qua',
};
const time = (value: string) =>
  new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));
const label = (kind: Template['kind']) => (kind === 'print' ? 'Mẫu in' : 'Mẫu email');

export function WorkflowOutputs({
  tenantId,
  me,
  definitions,
  lookup,
  write,
}: {
  tenantId: string;
  me: Me;
  definitions: DefinitionItem[];
  lookup: WorkflowLookup;
  write: ReturnType<typeof workflowWrite>;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [definitionId, setDefinition] = useState('');
  const [unitId, setUnit] = useState('');
  const [kind, setKind] = useState<Template['kind']>('print');
  const [name, setName] = useState('');
  const [heading, setHeading] = useState('');
  const [body, setBody] = useState('');
  const [fields, setFields] = useState<string[]>([]);
  const [event, setEvent] = useState<OutputEvent>('completed');
  const [stepId, setStep] = useState('');
  const [token, setToken] = useState('run.title');
  const [reason, setReason] = useState('');
  const [operationReason, setOperationReason] = useState('');
  const [busy, setBusy] = useState(false);
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
  const catalog = version ? outputFields(version.spec) : [];
  const current = templates.find((item) => item.id === selected);
  const valid = Boolean(
    version &&
    units.some(({ id }) => id === unitId) &&
    name.trim() &&
    heading.trim() &&
    reason.trim().length >= 5,
  );
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: Template[] }>(endpoint(tenantId, '/output-templates'), {
      signal: controller.signal,
    })
      .then(({ items }) => {
        if (!controller.signal.aborted) setTemplates(items);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure);
      });
    return () => controller.abort();
  }, [tenantId]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void api<{ items: Job[] }>(endpoint(tenantId, '/output-templates/' + selected + '/jobs'), {
      signal: controller.signal,
    })
      .then(({ items }) => {
        if (!controller.signal.aborted) setJobs(items);
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
  async function reload() {
    setTemplates((await api<{ items: Template[] }>(endpoint(tenantId, '/output-templates'))).items);
    if (selected)
      setJobs(
        (await api<{ items: Job[] }>(endpoint(tenantId, '/output-templates/' + selected + '/jobs')))
          .items,
      );
  }
  function resetSelection(id: string) {
    setDefinition(id);
    setUnit('');
    setFields([]);
    setStep('');
    setToken('run.title');
  }
  async function create() {
    if (!version || !valid) return;
    const result = await write<Template>(
      '/output-templates',
      {
        definitionId,
        versionId: version.id,
        unitId,
        kind,
        name,
        heading,
        body,
        fields: kind === 'print' ? fields : [],
        ...(kind === 'email' && { event, ...(stepId && { stepId }) }),
      },
      reason,
    );
    await reload();
    setSelected(result.id);
    setJobs([]);
    setName('');
    setReason('');
    setNotice('Đã lưu mẫu.');
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
            <h2>Tạo mẫu</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Choice
              label="Loại mẫu"
              value={kind}
              options={[
                { id: 'print', name: 'Mẫu in' },
                { id: 'email', name: 'Mẫu email' },
              ]}
              onChange={(value) => {
                setKind(value as Template['kind']);
                setStep('');
                setToken('run.title');
                setHeading('');
                setBody('');
              }}
            />
            <Choice
              label="Quy trình dùng mẫu"
              value={definitionId}
              onChange={resetSelection}
              options={published.map((item) => ({
                id: item.id,
                name: item.version!.spec.name + ' · v' + item.version!.version,
              }))}
            />
            <Choice
              label="Đơn vị dùng mẫu"
              value={unitId}
              onChange={setUnit}
              options={units}
              disabled={!version}
            />
            <div className="space-y-2">
              <Label htmlFor="output-name">Tên mẫu</Label>
              <Input
                id="output-name"
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>
          {kind === 'email' && (
            <div className="grid gap-4 md:grid-cols-2">
              <Choice
                label="Sự kiện gửi email"
                value={event}
                options={Object.entries(outputEvents).map(([id, name]) => ({ id, name }))}
                onChange={(value) => {
                  setEvent(value as OutputEvent);
                  setStep('');
                }}
              />
              {stepOutputEvents.some((value) => value === event) && (
                <Choice
                  label="Bước áp dụng email"
                  value={stepId || 'all'}
                  options={[
                    { id: 'all', name: 'Tất cả bước' },
                    ...(version?.spec.nodes
                      .filter((node) => node.kind === 'task' || node.kind === 'approval')
                      .map(({ id, label }) => ({ id, name: label })) ?? []),
                  ]}
                  onChange={(value) => setStep(value === 'all' ? '' : value)}
                />
              )}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="output-heading">
              {kind === 'email' ? 'Tiêu đề email' : 'Tiêu đề bản in'}
            </Label>
            <Input
              id="output-heading"
              maxLength={240}
              value={heading}
              onChange={(e) => setHeading(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="output-body">Nội dung mẫu</Label>
            <Textarea
              id="output-body"
              maxLength={6000}
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
            <Choice
              label="Trường chèn vào nội dung"
              value={token}
              onChange={setToken}
              options={[
                { id: 'run.title', name: 'Tên hồ sơ' },
                { id: 'run.version', name: 'Phiên bản' },
                { id: 'run.round', name: 'Lần gửi' },
                ...(kind === 'email' ? [{ id: 'event.kind', name: 'Tên sự kiện' }] : []),
                ...catalog
                  .filter(({ field }) => field.type !== 'table')
                  .map(({ key, label }) => ({ id: key, name: label })),
              ]}
            />
            <Button
              variant="outline"
              onClick={() => setHeading((value) => (value + ' {{' + token + '}}').trim())}
            >
              Chèn vào tiêu đề
            </Button>
            <Button
              variant="outline"
              onClick={() => setBody((value) => (value + ' {{' + token + '}}').trim())}
            >
              Chèn vào nội dung
            </Button>
          </div>
          {kind === 'print' && catalog.length > 0 && (
            <fieldset className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              <legend className="px-1 font-medium">Trường và bảng hiển thị</legend>
              {catalog.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    checked={fields.includes(key)}
                    onChange={(e) =>
                      setFields((values) =>
                        e.target.checked ? [...values, key] : values.filter((item) => item !== key),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          )}
          <div className="space-y-2">
            <Label htmlFor="output-reason">Lý do áp dụng mẫu</Label>
            <Input
              id="output-reason"
              maxLength={240}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button disabled={busy || !valid} onClick={() => void perform(create)}>
            Lưu mẫu
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Mẫu đã lưu và lịch sử gửi</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Choice
            label="Mẫu đang xem"
            value={selected}
            disabled={busy}
            options={templates.map((item) => ({
              id: item.id,
              name: item.name + ' · ' + label(item.kind),
            }))}
            onChange={(value) => {
              setSelected(value);
              setJobs([]);
            }}
          />
          <Button variant="outline" disabled={busy} onClick={() => void perform(reload)}>
            Tải lại mẫu
          </Button>
          {current && (
            <>
              <p className="text-sm">
                {current.workflow_name} · v{current.workflow_version} ·{' '}
                {current.enabled ? 'Đang áp dụng' : 'Đã tắt'}
              </p>
              <div className="space-y-2">
                <Label htmlFor="output-operation">Lý do tắt hoặc thử lại</Label>
                <Input
                  id="output-operation"
                  value={operationReason}
                  maxLength={240}
                  onChange={(e) => setOperationReason(e.target.value)}
                />
              </div>
              <Button
                variant="outline"
                disabled={busy || !current.enabled || operationReason.trim().length < 5}
                onClick={() =>
                  void perform(async () => {
                    await write(
                      '/output-templates/' + current.id + '/disable',
                      { expectedRevision: current.revision },
                      operationReason,
                    );
                    await reload();
                    setNotice('Đã tắt mẫu.');
                  })
                }
              >
                Tắt mẫu
              </Button>
              {current.kind === 'email' && (
                <ul className="divide-y">
                  {jobs.map((job) => (
                    <li key={job.id} className="space-y-2 py-3">
                      <p>
                        {statusLabels[job.status]} · {job.attempts} lần xử lý
                      </p>
                      {job.error_code && (
                        <p className="text-sm">{errorMessage(new ApiError(409, job.error_code))}</p>
                      )}
                      {job.history.length > 0 && (
                        <details className="text-sm">
                          <summary>Lịch sử xử lý</summary>
                          {job.history.map((attempt) => (
                            <p key={attempt.attempt}>
                              {time(attempt.recorded_at)} · {statusLabels[attempt.status]}
                            </p>
                          ))}
                        </details>
                      )}
                      {job.status === 'blocked' && current.enabled && (
                        <Button
                          variant="outline"
                          disabled={busy || operationReason.trim().length < 5}
                          onClick={() =>
                            void perform(async () => {
                              await write(
                                '/output-jobs/' + job.id + '/retry',
                                { expectedRevision: job.attempts },
                                operationReason,
                              );
                              await reload();
                              setNotice('Đã đưa email vào hàng chờ.');
                            })
                          }
                        >
                          Thử lại
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function RunPrintTemplates({ tenantId, runId }: { tenantId: string; runId: string }) {
  const [items, setItems] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function load() {
    try {
      const result = await api<{ items: { id: string; name: string }[] }>(
        endpoint(tenantId, '/runs/' + runId + '/print-templates'),
      );
      setItems(result.items);
      setSelected(result.items[0]?.id ?? '');
      setLoaded(true);
      setError(null);
    } catch (failure) {
      setError(failure);
    }
  }
  const path = '/runs/' + runId + '/print';
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Mẫu in hồ sơ</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        )}
        {!loaded && (
          <Button variant="outline" onClick={() => void load()}>
            Tải mẫu in
          </Button>
        )}
        {loaded && !items.length && (
          <p className="text-sm text-muted-foreground">Phiên bản này chưa có mẫu in.</p>
        )}
        {items.length > 0 && (
          <>
            <Choice label="Chọn mẫu in" value={selected} onChange={setSelected} options={items} />
            <div className="flex flex-wrap gap-4">
              <a
                className="text-primary underline"
                target="_blank"
                rel="noopener"
                href={endpoint(tenantId, path, { templateId: selected })}
              >
                Xem bản in
              </a>
              <a
                className="text-primary underline"
                href={endpoint(tenantId, path, { templateId: selected, download: 'true' })}
              >
                Tải bản in HTML
              </a>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type Mail = {
  id: string;
  subject: string;
  body: string;
  runId: string;
  taskId: string | null;
  createdAt: string;
};
export function WorkflowMailbox({
  tenantId,
  openRun,
}: {
  tenantId: string;
  openRun: (id: string, taskId?: string) => Promise<void>;
}) {
  const [items, setItems] = useState<Mail[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function load() {
    try {
      setItems((await api<{ items: Mail[] }>(endpoint(tenantId, '/output-mailbox'))).items);
      setLoaded(true);
      setError(null);
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Email giả lập</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button variant="outline" onClick={() => void load()}>
          Tải hộp thư
        </Button>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        )}
        {loaded && !items.length && (
          <p className="text-sm text-muted-foreground">Chưa có thư trong phạm vi của bạn.</p>
        )}
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.id} className="space-y-2 py-4">
              <h3 className="font-semibold break-words">{item.subject}</h3>
              <p className="text-sm text-muted-foreground">{time(item.createdAt)}</p>
              <p className="whitespace-pre-wrap break-words">{item.body}</p>
              <Button
                variant="outline"
                onClick={() => void openRun(item.runId, item.taskId ?? undefined)}
              >
                Mở hồ sơ
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
