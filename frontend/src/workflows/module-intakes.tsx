import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { can, Choice } from '../forms/common';
import type { DefinitionItem, WorkflowLookup, workflowWrite } from './common';
import type { IntakeKind, IntakeRule } from '../../../src/workflows/intakes';

type Rule = IntakeRule & { workflow_name: string; workflow_version: number };
type ChoiceItem = { id: string; name: string };
type Job = {
  id: string;
  status: string;
  attempts: number;
  error_code: string | null;
  history: { attempt: number; status: string; recorded_at: string; error_code: string | null }[];
};
const states: Record<string, string> = {
  queued: 'Đang chờ',
  retry: 'Chờ thử lại',
  done: 'Đã tạo đề nghị tại module đích',
  blocked: 'Đã dừng',
  skipped: 'Bỏ qua',
};
const date = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});
const endpoint = (tenantId: string, suffix: string, query: Record<string, string> = {}) =>
  '/api/v1/workflows' + suffix + '?' + new URLSearchParams({ tenantId, ...query });
const destinations = {
  'hr-onboarding': {
    name: 'Nhân sự',
    fields: [
      ['displayName', 'Ghép họ tên'],
      ['employeeCode', 'Ghép mã nhân sự'],
    ],
  },
  'lms-training': {
    name: 'Đào tạo LMS',
    fields: [
      ['title', 'Ghép tên đợt đào tạo'],
      ['summary', 'Ghép nội dung đề nghị'],
    ],
  },
};

export function WorkflowModuleIntakes({
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
  const [definitionId, setDefinition] = useState('');
  const [kind, setKind] = useState<IntakeKind>('hr-onboarding');
  const [unitId, setUnit] = useState('');
  const [account, setAccount] = useState('');
  const [search, setSearch] = useState('');
  const [recipients, setRecipients] = useState<ChoiceItem[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [operationReason, setOperationReason] = useState('');
  const [rules, setRules] = useState<Rule[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const published = definitions.filter(
    ({ canPublish, status, version }) => canPublish && status === 'published' && version,
  );
  const version = published.find(({ id }) => id === definitionId)?.version;
  const units = lookup.units.filter(
    ({ id }) =>
      version?.spec.audienceUnits.includes(id) && can(me, tenantId, 'workflows:publish', id),
  );
  const fields = version?.spec.input.sections.flatMap(({ fields }) => fields) ?? [];
  const destination = destinations[kind];
  const current = rules.find(({ id }) => id === selected);

  useEffect(() => {
    const abort = new AbortController();
    void api<{ items: Rule[] }>(endpoint(tenantId, '/intake-rules'), { signal: abort.signal })
      .then(({ items }) => {
        if (!abort.signal.aborted) setRules(items);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure);
      });
    return () => abort.abort();
  }, [tenantId]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    void api<{ items: Job[] }>(endpoint(tenantId, '/intake-rules/' + selected + '/jobs'), {
      signal: abort.signal,
    })
      .then(({ items }) => {
        if (!abort.signal.aborted) setJobs(items);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure);
      });
    return () => abort.abort();
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
  async function reload(id = selected) {
    setRules((await api<{ items: Rule[] }>(endpoint(tenantId, '/intake-rules'))).items);
    if (id)
      setJobs(
        (await api<{ items: Job[] }>(endpoint(tenantId, '/intake-rules/' + id + '/jobs'))).items,
      );
  }
  function changeUnit(id: string) {
    setUnit(id);
    setAccount('');
    setSearch('');
    setRecipients([]);
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
            <h2>Chuyển đề nghị sau khi hoàn tất</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset disabled={busy} className="grid gap-4 md:grid-cols-2">
            <Choice
              label="Module đích"
              value={kind}
              options={Object.entries(destinations).map(([id, item]) => ({ id, name: item.name }))}
              onChange={(value) => {
                setKind(value as IntakeKind);
                changeUnit(unitId);
                setMapping({});
              }}
            />
            <Choice
              label="Quy trình nguồn"
              value={definitionId}
              options={published.map((item) => ({
                id: item.id,
                name: item.version!.spec.name + ' · v' + item.version!.version,
              }))}
              onChange={(id) => {
                setDefinition(id);
                changeUnit('');
                setMapping({});
              }}
            />
            <Choice
              label="Đơn vị tiếp nhận"
              value={unitId}
              options={units}
              onChange={changeUnit}
              disabled={!version}
            />
            <div className="space-y-2">
              <Label htmlFor="intake-search">Tìm người tiếp nhận</Label>
              <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                <Input
                  id="intake-search"
                  value={search}
                  maxLength={100}
                  onChange={(event) => setSearch(event.target.value)}
                  disabled={!unitId}
                />
                <Button
                  variant="outline"
                  disabled={!unitId}
                  onClick={() =>
                    void perform(async () => {
                      const result = await api<{ items: ChoiceItem[] }>(
                        endpoint(tenantId, '/intake-recipients', {
                          definitionId,
                          unitId,
                          search,
                          intakeKind: kind,
                        }),
                      );
                      setRecipients(result.items);
                      setAccount('');
                      if (!result.items.length)
                        setNotice('Không tìm thấy người tiếp nhận đủ quyền.');
                    })
                  }
                >
                  Tìm người
                </Button>
              </div>
            </div>
            <Choice
              label="Người tiếp nhận"
              value={account}
              options={recipients}
              onChange={setAccount}
              disabled={!recipients.length}
            />
            {destination.fields.map(([key, label]) => (
              <Choice
                key={key}
                label={label}
                value={mapping[key] ?? 'unmapped'}
                onChange={(value) => setMapping((old) => ({ ...old, [key]: value }))}
                options={[
                  { id: 'unmapped', name: 'Bổ sung tại ' + destination.name },
                  ...fields
                    .filter(
                      ({ type }) =>
                        type === 'shortText' || (key === 'summary' && type === 'longText'),
                    )
                    .map(({ id, label }) => ({ id, name: label })),
                ]}
                disabled={!version}
              />
            ))}
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="intake-reason">Lý do áp dụng</Label>
              <Input
                id="intake-reason"
                maxLength={240}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </fieldset>
          <Button
            disabled={
              busy ||
              !version ||
              !account ||
              !units.some(({ id }) => id === unitId) ||
              reason.trim().length < 5
            }
            onClick={() =>
              void perform(async () => {
                if (!version) return;
                const rule = await write<Rule>(
                  '/intake-rules',
                  {
                    kind,
                    definitionId,
                    versionId: version.id,
                    unitId,
                    recipientAccountId: account,
                    mapping: Object.fromEntries(
                      Object.entries(mapping).filter(([, value]) => value !== 'unmapped'),
                    ),
                  },
                  reason,
                );
                await reload(rule.id);
                setSelected(rule.id);
                setReason('');
                setNotice('Đã áp dụng quy tắc chuyển đề nghị.');
              })
            }
          >
            Áp dụng quy tắc
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Quy tắc và lịch sử chuyển đề nghị</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Choice
            label="Quy tắc đang xem"
            value={selected}
            options={rules.map((rule) => ({
              id: rule.id,
              name:
                rule.workflow_name +
                ' · v' +
                rule.workflow_version +
                ' · ' +
                destinations[rule.kind].name +
                (rule.enabled ? '' : ' · Đã tắt'),
            }))}
            onChange={(id) => {
              setSelected(id);
              setJobs([]);
              setOperationReason('');
            }}
            disabled={busy}
          />
          {current && (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void perform(() => reload())}
              >
                Tải lại lịch sử
              </Button>
              <div className="space-y-2">
                <Label htmlFor="intake-operation">Lý do tắt hoặc thử lại</Label>
                <Input
                  id="intake-operation"
                  maxLength={240}
                  value={operationReason}
                  onChange={(event) => setOperationReason(event.target.value)}
                />
              </div>
              <Button
                variant="outline"
                disabled={busy || !current.enabled || operationReason.trim().length < 5}
                onClick={() =>
                  void perform(async () => {
                    await write(
                      '/intake-rules/' + selected + '/disable',
                      { expectedRevision: current.revision },
                      operationReason,
                    );
                    await reload();
                    setNotice('Đã tắt quy tắc chuyển đề nghị.');
                  })
                }
              >
                Tắt quy tắc
              </Button>
              <ul className="divide-y">
                {jobs.map((job) => (
                  <li key={job.id} className="space-y-2 py-3">
                    <p>
                      {states[job.status]} · {job.attempts} lần xử lý
                    </p>
                    {job.error_code && (
                      <p className="text-sm">{errorMessage(new ApiError(409, job.error_code))}</p>
                    )}
                    {job.history.length > 0 && (
                      <details className="text-sm">
                        <summary>Lịch sử xử lý</summary>
                        {job.history.map((entry) => (
                          <p key={entry.attempt}>
                            {date.format(new Date(entry.recorded_at))} · {states[entry.status]}
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
                              '/intake-jobs/' + job.id + '/retry',
                              { expectedRevision: job.attempts },
                              operationReason,
                            );
                            await reload();
                            setNotice('Đã đưa đề nghị vào hàng chờ.');
                          })
                        }
                      >
                        Thử lại
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const trainingStates: Record<string, string> = {
  queued: 'Đang chờ chuyển sang LMS',
  retry: 'Chờ thử lại',
  blocked: 'Chuyển đề nghị đã dừng',
  skipped: 'Đã bỏ qua',
  draft: 'Đang chờ quản trị LMS xác nhận',
  active: 'Đã giao đợt đào tạo',
  cancelled: 'Đợt đào tạo đã hủy',
  unavailable: 'Tạm thời chưa lấy được trạng thái LMS',
};
export function WorkflowTrainingIntake({ tenantId, runId }: { tenantId: string; runId: string }) {
  const [state, setState] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    void api<{ state: string | null }>(endpoint(tenantId, '/runs/' + runId + '/training-intake'), {
      signal: abort.signal,
    })
      .then(({ state }) => {
        if (!abort.signal.aborted) setState(state);
      })
      .catch(() => {
        if (!abort.signal.aborted) setState(null);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [tenantId, runId, refresh]);
  if (!state) return null;
  return (
    <section
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
      aria-label="Đề nghị đào tạo"
    >
      <p role="status" className="text-sm">
        Đào tạo LMS · {trainingStates[state]}
      </p>
      <Button variant="outline" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
        Tải trạng thái LMS
      </Button>
    </section>
  );
}
