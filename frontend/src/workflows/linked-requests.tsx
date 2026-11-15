import { useCallback, useEffect, useState } from 'react';
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
import { schemaFields } from '../../../src/forms/contracts';
import type { Scalar } from '../../../src/forms/contracts';
import type { WorkflowLinkInput, WorkflowLinkRule } from '../../../src/workflows/linked-requests';
import type { HumanStep } from '../../../src/workflows/contracts';
import { stateLabels } from './common';
import type { DefinitionItem, WorkflowLookup, workflowWrite } from './common';

type Rule = WorkflowLinkRule & {
  source_name: string;
  source_version: number;
  target_name: string;
  target_version: number;
  source_step_label?: string | null;
};
type Attempt = { attempt: number; status: string; error_code: string | null; recorded_at: string };
type Job = {
  id: string;
  status: string;
  attempts: number;
  error_code: string | null;
  history: Attempt[];
};
const jobStatus: Record<string, string> = {
  queued: 'Đang chờ',
  retry: 'Chờ thử lại',
  done: 'Đã tạo nháp',
  blocked: 'Tạm dừng',
  skipped: 'Điều kiện không khớp',
};
const options = (fields: { id: string; label: string }[]) =>
  fields.map(({ id, label }) => ({ id, name: label }));
const endpoint = (path: string, tenantId: string) =>
  '/api/v1/workflows' + path + '?' + new URLSearchParams({ tenantId });

export function WorkflowLinks({
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
  const [rules, setRules] = useState<Rule[]>([]);
  const [selected, selectRule] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [sourceId, setSource] = useState('');
  const [targetId, setTarget] = useState('');
  const [unitId, setUnit] = useState('');
  const [sourceStepId, setSourceStepId] = useState('');
  const [recipientMode, setRecipientMode] = useState('requester');
  const [recipientAccountId, setRecipientAccountId] = useState('');
  const [recipientSearch, setRecipientSearch] = useState('');
  const [recipients, setRecipients] = useState<{ id: string; name: string }[]>([]);
  const [mappings, setMappings] = useState<{ from: string; to: string }[]>([]);
  const [predicateField, setPredicateField] = useState('');
  const [predicateValue, setPredicateValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const published = definitions.filter(
    (item) => item.canPublish && item.status === 'published' && item.version,
  );
  const from = published.find((item) => item.id === sourceId)?.version;
  const to = published.find((item) => item.id === targetId)?.version;
  const units = lookup.units.filter(
    ({ id }) =>
      from?.spec.audienceUnits.includes(id) &&
      to?.spec.audienceUnits.includes(id) &&
      can(me, tenantId, 'workflows:publish', id),
  );
  const humanSteps =
    from?.spec.nodes.filter(
      (node): node is HumanStep => node.kind === 'task' || node.kind === 'approval',
    ) ?? [];
  const sourceStep = humanSteps.find((step) => step.id === sourceStepId);
  const sourceFields = [
    ...(from
      ? schemaFields(from.spec.input).map((field) => ({
          ...field,
          id: 'input:' + field.id,
          fieldId: field.id,
          origin: 'input' as const,
        }))
      : []),
    ...(sourceStep?.form
      ? schemaFields(sourceStep.form).map((field) => ({
          ...field,
          id: 'step:' + field.id,
          fieldId: field.id,
          origin: 'step' as const,
          label: 'Bước · ' + field.label,
        }))
      : []),
  ].filter((field) => field.type !== 'attachment');
  const targetFields = to
    ? schemaFields(to.spec.input).filter((field) => field.type !== 'attachment')
    : [];
  const predicates = sourceFields.filter(
    (field) => !['table', 'multipleChoice', 'person', 'orgUnit'].includes(field.type),
  );
  const predicate = predicates.find(({ id }) => id === predicateField);
  const eligibleTargets = (fieldId: string) => {
    const field = sourceFields.find(({ id }) => id === fieldId);
    return field
      ? targetFields.filter(
          (target) => target.type === field.type && target.currency === field.currency,
        )
      : [];
  };
  const loadRules = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api<{ items: Rule[] }>(
        endpoint('/link-rules', tenantId),
        signal ? { signal } : {},
      );
      if (!signal?.aborted) setRules(result.items);
    },
    [tenantId],
  );
  const loadJobs = useCallback(
    async (ruleId: string, cursor?: string, signal?: AbortSignal) => {
      const path = endpoint('/link-rules/' + ruleId + '/jobs', tenantId);
      const result = await api<{ items: Job[]; nextCursor: string | null }>(
        path + (cursor ? '&after=' + encodeURIComponent(cursor) : ''),
        signal ? { signal } : {},
      );
      if (!signal?.aborted) {
        setJobs((rows) => (cursor ? [...rows, ...result.items] : result.items));
        setNextCursor(result.nextCursor);
      }
    },
    [tenantId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void loadRules(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e);
    });
    return () => controller.abort();
  }, [loadRules]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void loadJobs(selected, undefined, controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e);
    });
    return () => controller.abort();
  }, [loadJobs, selected]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function chooseSource(value: string) {
    setSource(value);
    if (value === targetId) setTarget('');
    changeUnit('');
    chooseStep('');
  }
  function chooseStep(value: string) {
    setSourceStepId(value);
    if (!value && recipientMode === 'actor') setRecipientMode('requester');
    setMappings([]);
    setPredicateField('');
    setPredicateValue('');
  }
  function changeUnit(value: string) {
    setUnit(value);
    setRecipientAccountId('');
    setRecipients([]);
  }
  async function findRecipients() {
    const query = new URLSearchParams({ definitionId: targetId, unitId, search: recipientSearch });
    const result = await api<{ items: { id: string; name: string }[] }>(
      endpoint('/draft-schedule-recipients', tenantId) + '&' + query,
    );
    setRecipients(result.items);
    setRecipientAccountId('');
    if (!result.items.length) setNotice('Không tìm thấy người có quyền khởi tạo trong đơn vị.');
  }
  async function applyRule() {
    if (!from || !to || !units.some((unit) => unit.id === unitId)) return;
    let equals: Scalar = predicateValue;
    if (predicate?.type === 'boolean') equals = predicateValue === 'true';
    if (predicate && ['number', 'integer', 'percentage'].includes(predicate.type))
      equals = Number(predicateValue);
    const input: WorkflowLinkInput = {
      name,
      sourceDefinitionId: sourceId,
      sourceVersionId: from.id,
      targetDefinitionId: targetId,
      targetVersionId: to.id,
      unitId,
      ...(sourceStep && { sourceStepId: sourceStep.id }),
      ...(recipientMode === 'actor' && { recipientIsStepActor: true }),
      ...(recipientMode === 'fixed' && { recipientAccountId }),
      mapping: mappings.map(({ from, to }) => {
        const field = sourceFields.find((item) => item.id === from)!;
        return {
          from: field.fieldId,
          to,
          ...(field.origin === 'step' && { origin: field.origin }),
        };
      }),
      ...(predicate && {
        predicate: {
          fieldId: predicate.fieldId,
          equals,
          ...(predicate.origin === 'step' && { origin: predicate.origin }),
        },
      }),
    };
    const rule = await write<Rule>('/link-rules', input, reason);
    await loadRules();
    setJobs([]);
    selectRule(rule.id);
    setName('');
    setReason('');
    setNotice('Đã áp dụng quy tắc liên kết.');
  }
  const valid =
    name.trim() &&
    from &&
    to &&
    units.some((unit) => unit.id === unitId) &&
    (recipientMode !== 'fixed' || !!recipientAccountId) &&
    reason.trim().length >= 5 &&
    mappings.every(({ from, to }) => eligibleTargets(from).some((field) => field.id === to)) &&
    new Set(mappings.map((pair) => pair.to)).size === mappings.length &&
    (!predicate || !!predicateValue.trim());
  const selectedRule = rules.find((rule) => rule.id === selected);
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
            <h2>Tạo quy trình liên kết</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="link-name">Tên quy tắc</Label>
              <Input
                id="link-name"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Choice
                label="Quy trình nguồn"
                value={sourceId}
                onChange={chooseSource}
                disabled={busy}
                options={published.map((item) => ({ id: item.id, name: item.version!.spec.name }))}
              />
              <Choice
                label="Quy trình đích"
                value={targetId}
                onChange={(value) => {
                  setTarget(value);
                  changeUnit('');
                  setMappings([]);
                }}
                disabled={busy}
                options={published
                  .filter((item) => item.id !== sourceId)
                  .map((item) => ({ id: item.id, name: item.version!.spec.name }))}
              />
              <Choice
                label="Đơn vị áp dụng"
                value={unitId}
                onChange={changeUnit}
                options={units}
                disabled={busy || !from || !to}
              />
              {from && to && (
                <p className="self-end text-sm text-muted-foreground">
                  Nguồn phiên bản {from.version} · Đích phiên bản {to.version}
                </p>
              )}
            </div>
            {from && to && (
              <div className="grid gap-4 md:grid-cols-2">
                <Choice
                  label="Khi nào tạo nháp"
                  value={sourceStepId || '__run__'}
                  onChange={(value) => chooseStep(value === '__run__' ? '' : value)}
                  options={[
                    { id: '__run__', name: 'Khi hoàn thành quy trình nguồn' },
                    ...humanSteps.map((node) => ({ id: node.id, name: node.label })),
                  ]}
                  disabled={busy}
                />
                <Choice
                  label="Giao nháp cho"
                  value={recipientMode}
                  onChange={setRecipientMode}
                  disabled={busy}
                  options={[
                    { id: 'requester', name: 'Người khởi tạo hồ sơ nguồn' },
                    ...(sourceStep ? [{ id: 'actor', name: 'Người hoàn tất bước nguồn' }] : []),
                    { id: 'fixed', name: 'Người được chỉ định' },
                  ]}
                />
              </div>
            )}
            {recipientMode === 'fixed' && (
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-end">
                <div className="space-y-2">
                  <Label htmlFor="link-recipient-search">Tìm người nhận liên kết</Label>
                  <Input
                    id="link-recipient-search"
                    value={recipientSearch}
                    maxLength={100}
                    onChange={(event) => setRecipientSearch(event.target.value)}
                    disabled={busy || !unitId}
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={() => void perform(findRecipients)}
                  disabled={busy || !unitId}
                >
                  Tìm người nhận
                </Button>
                <Choice
                  label="Người nhận liên kết"
                  value={recipientAccountId}
                  options={recipients}
                  onChange={setRecipientAccountId}
                  disabled={busy || !recipients.length}
                />
              </div>
            )}
            {from && to && (
              <fieldset className="space-y-3 rounded-lg border p-4">
                <legend className="px-1 font-medium">Ghép trường dữ liệu</legend>
                {mappings.map((pair, index) => (
                  <div key={index} className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
                    <Choice
                      label={'Trường nguồn ' + (index + 1)}
                      value={pair.from}
                      options={options(
                        sourceFields.filter((field) => eligibleTargets(field.id).length),
                      )}
                      onChange={(from) =>
                        setMappings((rows) =>
                          rows.map((row, i) => (i === index ? { from, to: '' } : row)),
                        )
                      }
                    />
                    <Choice
                      label={'Trường đích ' + (index + 1)}
                      value={pair.to}
                      options={options(eligibleTargets(pair.from))}
                      onChange={(to) =>
                        setMappings((rows) =>
                          rows.map((row, i) => (i === index ? { ...row, to } : row)),
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setMappings((rows) => rows.filter((_, i) => i !== index))}
                    >
                      Bỏ dòng {index + 1}
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  disabled={mappings.length >= 50}
                  onClick={() => setMappings((rows) => [...rows, { from: '', to: '' }])}
                >
                  Thêm cặp trường
                </Button>
              </fieldset>
            )}
            {from && (
              <div className="grid gap-4 md:grid-cols-2">
                <Choice
                  label="Điều kiện tạo nháp"
                  value={predicateField || '__always__'}
                  options={[
                    { id: '__always__', name: 'Mọi sự kiện đã chọn' },
                    ...options(predicates),
                  ]}
                  onChange={(value) => {
                    setPredicateField(value === '__always__' ? '' : value);
                    setPredicateValue('');
                  }}
                />
                {predicate?.type === 'boolean' ? (
                  <Choice
                    label="Giá trị bằng"
                    value={predicateValue}
                    onChange={setPredicateValue}
                    options={[
                      { id: 'true', name: 'Có' },
                      { id: 'false', name: 'Không' },
                    ]}
                  />
                ) : predicate?.type === 'singleChoice' ? (
                  <Choice
                    label="Giá trị bằng"
                    value={predicateValue}
                    onChange={setPredicateValue}
                    options={options(predicate.options ?? [])}
                  />
                ) : (
                  predicate && (
                    <div className="space-y-2">
                      <Label htmlFor="link-predicate-value">Giá trị bằng</Label>
                      <Input
                        id="link-predicate-value"
                        value={predicateValue}
                        type={
                          ['number', 'integer', 'percentage'].includes(predicate.type)
                            ? 'number'
                            : 'text'
                        }
                        onChange={(event) => setPredicateValue(event.target.value)}
                      />
                    </div>
                  )
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="link-reason">Lý do thao tác</Label>
              <Input
                id="link-reason"
                value={reason}
                maxLength={240}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <Button type="button" disabled={busy || !valid} onClick={() => void perform(applyRule)}>
              Áp dụng quy tắc
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Quy tắc và lịch sử chạy</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Choice
            label="Quy tắc liên kết"
            value={selected}
            disabled={busy}
            options={rules.map((rule) => ({ id: rule.id, name: rule.name }))}
            onChange={(id) => {
              setJobs([]);
              setNextCursor(null);
              selectRule(id);
            }}
          />
          {selectedRule && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="secondary">
                  {selectedRule.enabled ? 'Đang áp dụng' : 'Đã tắt'}
                </Badge>
                <span className="text-sm">
                  {selectedRule.source_name} v{selectedRule.source_version} →{' '}
                  {selectedRule.target_name} v{selectedRule.target_version}
                </span>
                {selectedRule.source_step_label && (
                  <span className="text-sm">Bước nguồn · {selectedRule.source_step_label}</span>
                )}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void perform(() => loadJobs(selected))}
                >
                  Tải lại lịch sử
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !selectedRule.enabled || reason.trim().length < 5}
                  onClick={() =>
                    void perform(async () => {
                      await write(
                        '/link-rules/' + selected + '/disable',
                        { expectedRevision: selectedRule.revision },
                        reason,
                      );
                      await loadRules();
                      setNotice('Đã tắt quy tắc liên kết.');
                    })
                  }
                >
                  Tắt quy tắc
                </Button>
              </div>
              {!jobs.length && <p className="text-sm text-muted-foreground">Chưa có lần chạy.</p>}
              <ul className="space-y-2">
                {jobs.map((job) => (
                  <li key={job.id} className="space-y-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge variant="secondary">{jobStatus[job.status]}</Badge>
                      <span className="text-sm">{job.attempts} lần xử lý</span>
                      {job.status === 'blocked' && selectedRule.enabled && (
                        <Button
                          variant="outline"
                          disabled={busy || reason.trim().length < 5}
                          onClick={() =>
                            void perform(async () => {
                              await write(
                                '/link-jobs/' + job.id + '/retry',
                                { expectedRevision: job.attempts },
                                reason,
                              );
                              await loadJobs(selected);
                              setNotice('Đã đưa lần chạy vào hàng chờ.');
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
                    {job.history.length > 0 && (
                      <details className="text-sm">
                        <summary className="cursor-pointer">Các lần xử lý gần đây</summary>
                        <ul className="space-y-1 pt-2">
                          {job.history.map((attempt) => (
                            <li key={attempt.attempt}>
                              {new Date(attempt.recorded_at).toLocaleString('vi-VN', {
                                timeZone: 'Asia/Ho_Chi_Minh',
                              })}
                              {' · ' + jobStatus[attempt.status]}
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
              {nextCursor && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void perform(() => loadJobs(selected, nextCursor))}
                >
                  Xem thêm
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type Related = {
  title: string;
  status: string;
  requestId?: string;
  runId?: string;
  sourceStep?: string;
  sourceAttempt?: number;
  sourceRound?: number;
};
export function RelatedWorkflowRequests({
  runId,
  tenantId,
  openDraft,
  openRun,
}: {
  runId: string;
  tenantId: string;
  openDraft: (id: string) => Promise<void>;
  openRun: (id: string) => Promise<void>;
}) {
  const [items, setItems] = useState<Related[]>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: Related[] }>(endpoint('/runs/' + runId + '/linked-requests', tenantId), {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setItems(result.items);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      });
    return () => controller.abort();
  }, [runId, tenantId]);
  if (!items.length && error === null) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Hồ sơ liên kết</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        )}
        {items.map((item) => (
          <div
            key={item.requestId ?? item.runId}
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <div>
              <p className="font-medium break-words">{item.title}</p>
              <p className="text-sm text-muted-foreground">
                {item.status === 'inactive_draft' ? 'Nháp hết hiệu lực' : stateLabels[item.status]}
              </p>
              {item.sourceStep && (
                <p className="text-sm text-muted-foreground">
                  {item.sourceStep} · Lần xử lý {item.sourceAttempt} · Vòng {item.sourceRound}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              onClick={() =>
                void (item.requestId ? openDraft(item.requestId) : openRun(item.runId!)).catch(
                  setError,
                )
              }
            >
              {item.requestId ? 'Mở nháp liên kết' : 'Mở hồ sơ liên kết'}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
