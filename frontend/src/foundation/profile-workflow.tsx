import { useEffect, useState, useRef } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Choice } from '../forms/common';
import { FormRenderer } from '../forms/renderer';
import { WorkflowSelectionFields } from '../workflows/selection-fields';
import type { DefinitionItem, WorkflowSelection } from '../workflows/common';
import type { Answers, FormIssue } from '../../../src/forms/contracts';
import { parseAnswers, FormValidationError } from '../../../src/forms/contracts';
type State = {
  link: { id: string; runId: string | null; initiatedBy: string; appliedAt: string | null } | null;
  run: { id: string; status: string; approvalCount: number } | null;
  canApply: boolean;
  baseUrl: string;
};
const names: Record<string, string> = {
  running: 'Đang duyệt',
  needs_revision: 'Cần bổ sung',
  completed: 'Quy trình hoàn thành',
  rejected: 'Quy trình từ chối',
  cancelled: 'Quy trình đã hủy',
};
export function ProfileWorkflow({
  me,
  tenantId,
  id,
  name,
  revision,
  onDone,
}: {
  me: Me;
  tenantId: string;
  id: string;
  name: string;
  revision: number;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false),
    [state, setState] = useState<State | null>(null),
    [units, setUnits] = useState<{ id: string; name: string }[]>([]),
    [choices, setChoices] = useState<DefinitionItem[]>([]),
    [choice, setChoice] = useState(''),
    [unit, setUnit] = useState(''),
    [answers, setAnswers] = useState<Answers>({}),
    [options, setOptions] = useState<WorkflowSelection[]>([]),
    [selections, setSelections] = useState<Record<string, string>>({}),
    [selectionLoading, setSelectionLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [reason, setReason] = useState(''),
    [error, setError] = useState<unknown>(null),
    [issues, setIssues] = useState<FormIssue[]>([]),
    [key, setKey] = useState(() => crypto.randomUUID());
  const selected = choices.find((c) => c.id === choice),
    spec = selected?.version?.spec;
  const trigger = useRef<HTMLButtonElement>(null);
  const base = '/api/v1/profile-workflows/';
  async function load(signal?: AbortSignal) {
    const next = await api<State>(base + id + '?tenantId=' + tenantId, { signal });
    const data = next.link
      ? { items: [], units: [] }
      : await api<{ items: DefinitionItem[]; units: { id: string; name: string }[] }>(
          base + 'choices?tenantId=' + tenantId,
          { signal },
        );
    if (!signal?.aborted) {
      setState(next);
      setChoices(data.items);
      setUnits(data.units);
    }
  }
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState(null);
    setChoices([]);
    setChoice('');
    setUnit('');
    setAnswers({});
    setReason('');
    setError(null);
    setIssues([]);
    setLoading(true);
    void load(controller.signal)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, tenantId, id]);
  useEffect(() => {
    setOptions([]);
    setSelections({});
    setIssues([]);
    setSelectionLoading(false);
    if (!open || !selected?.version || !unit) return;
    const controller = new AbortController();
    setSelectionLoading(true);
    setError(null);
    void api<{ items: WorkflowSelection[] }>(
      base +
        'selections?' +
        new URLSearchParams({
          tenantId,
          definitionId: selected.id,
          versionId: selected.version.id,
          unitId: unit,
        }),
      { signal: controller.signal },
    )
      .then((r) => {
        if (!controller.signal.aborted) setOptions(r.items);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSelectionLoading(false);
      });
    return () => controller.abort();
  }, [open, choice, unit]);
  async function command(action: 'send' | 'retry' | 'apply') {
    setError(null);
    setIssues([]);
    let data: Record<string, unknown> = {};
    if (action === 'send') {
      if (!selected?.version || !spec || !unit) return;
      try {
        parseAnswers(spec.input, answers, 'submit');
      } catch (e) {
        if (e instanceof FormValidationError) setIssues(e.issues);
        else setError(e);
        return;
      }
      data = {
        expectedRevision: revision,
        definitionId: selected.id,
        versionId: selected.version.id,
        unitId: unit,
        answers,
        selections,
      };
    } else if (action === 'apply') data = { expectedRevision: revision };
    setBusy(true);
    try {
      await api(base + id + '/' + action, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': me.csrfToken,
          'idempotency-key': key,
        },
        body: JSON.stringify({ tenantId, reason, ...data }),
      });
      setKey(crypto.randomUUID());
      if (action === 'apply') {
        setOpen(false);
        onDone();
      } else {
        await load();
      }
    } catch (e) {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        setState(null);
        setChoices([]);
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
        Quy trình phê duyệt
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) {
            setOpen(v);
            if (!v && state?.link) onDone();
          }
        }}
      >
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Phê duyệt cập nhật hồ sơ</DialogTitle>
            <DialogDescription>
              {name} · Quy trình xét duyệt đề xuất; HR xác nhận áp dụng sau khi hoàn thành.
            </DialogDescription>
          </DialogHeader>
          {loading && <p role="status">Đang kiểm tra đề xuất và quyền quy trình…</p>}
          {Boolean(error) && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          {state?.link ? (
            <div className="space-y-4">
              <Badge variant="secondary">
                {state.link.appliedAt
                  ? 'Đã áp dụng hồ sơ'
                  : state.run
                    ? (names[state.run.status] ?? state.run.status)
                    : 'Đã chuẩn bị, chờ gửi lại'}
              </Badge>
              {state.run && (
                <Button asChild variant="outline">
                  <a
                    href={state.baseUrl + '/#workflow-run/' + state.run.id}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Mở lượt phê duyệt
                  </a>
                </Button>
              )}
              <p className="text-sm text-muted-foreground">
                Nội dung đề xuất đã được chốt. Quyết định duyệt không tự cập nhật hồ sơ hoặc quyền
                ứng dụng.
              </p>
              {state.run?.status === 'needs_revision' && (
                <p className="text-sm">
                  Nếu cần sửa nội dung, rút đề xuất hiện tại rồi tạo đề xuất mới. HR có thể hủy lượt
                  cũ tại Quy trình.
                </p>
              )}
              {state.run?.status === 'completed' && !state.canApply && !state.link.appliedAt && (
                <p className="text-sm">
                  Chưa đủ bằng chứng để áp dụng. Lượt cần có ít nhất một bước phê duyệt độc lập và
                  đề xuất còn chờ xử lý.
                </p>
              )}
            </div>
          ) : (
            state && (
              <div className="space-y-5">
                <Choice
                  label="Quy trình xét duyệt hồ sơ"
                  value={choice || '_none'}
                  onChange={(v) => {
                    setChoice(v === '_none' ? '' : v);
                    setUnit('');
                    setAnswers({});
                    setKey(crypto.randomUUID());
                  }}
                  options={[
                    { id: '_none', name: 'Chọn quy trình đã phát hành' },
                    ...choices.map((c) => ({ id: c.id, name: c.name })),
                  ]}
                />
                {!choices.length && (
                  <p className="text-sm text-muted-foreground">
                    Chưa có quy trình được phép khởi tạo và có bước phê duyệt. Quản trị cấu hình
                    người xử lý tại module Quy trình.
                  </p>
                )}
                {selected && (
                  <Choice
                    label="Đơn vị gửi duyệt"
                    value={unit || '_none'}
                    onChange={(v) => {
                      setUnit(v === '_none' ? '' : v);
                      setKey(crypto.randomUUID());
                    }}
                    options={[
                      { id: '_none', name: 'Chọn đơn vị' },
                      ...selected.startUnits.map((id) => ({
                        id,
                        name: units.find((u) => u.id === id)?.name ?? id,
                      })),
                    ]}
                  />
                )}
                {spec && (
                  <FormRenderer
                    schema={spec.input}
                    answers={answers}
                    issues={issues}
                    disabled={busy}
                    onChange={(v) => {
                      setAnswers(v);
                      setIssues([]);
                      setKey(crypto.randomUUID());
                    }}
                  />
                )}
                <WorkflowSelectionFields
                  options={options}
                  values={selections}
                  loading={selectionLoading}
                  onChange={(v) => {
                    setSelections(v);
                    setKey(crypto.randomUUID());
                  }}
                />
                <p className="text-sm text-muted-foreground">
                  Các trường thay đổi trong đề xuất và giá trị trước/sau được gửi kèm. Người có hồ
                  sơ được sửa và người gửi không được tự phê duyệt.
                </p>
              </div>
            )
          )}
          {state && (
            <div className="space-y-2">
              <Label htmlFor={'workflow-reason-' + id}>Lý do xử lý đề xuất</Label>
              <Input
                id={'workflow-reason-' + id}
                value={reason}
                maxLength={240}
                disabled={busy}
                onChange={(e) => {
                  setReason(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                if (state?.link) onDone();
              }}
            >
              Đóng
            </Button>
            {state?.link && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void load()
                    .catch((e) => {
                      setState(null);
                      setError(e);
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Kiểm tra trạng thái
              </Button>
            )}
            {state && !state.link && (
              <Button
                disabled={
                  busy ||
                  loading ||
                  selectionLoading ||
                  !unit ||
                  !spec ||
                  reason.trim().length < 5 ||
                  options.some((o) => !selections[o.stepId])
                }
                onClick={() => void command('send')}
              >
                Gửi quy trình xét duyệt
              </Button>
            )}
            {state?.link && !state.link.runId && state.link.initiatedBy === me.accountId && (
              <Button
                disabled={busy || reason.trim().length < 5}
                onClick={() => void command('retry')}
              >
                Gửi lại lượt đã chuẩn bị
              </Button>
            )}
            {state?.canApply && (
              <Button
                disabled={busy || reason.trim().length < 5}
                onClick={() => void command('apply')}
              >
                Xác nhận áp dụng hồ sơ
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
