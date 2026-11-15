import { useEffect, useRef, useState } from 'react';
import { parseAnswers, parseFormSchema } from '../../../src/forms/contracts';
import type { Answers } from '../../../src/forms/contracts';
import type { Me } from '@/lib/api';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormRenderer, AnswerReadback } from './renderer';
import { Choice, can, useFormsWrite, formError, formIssues } from './common';
import type { FormDetail, Lookup, Submission, PageResult } from './common';

export type ConfirmRequest = {
  title: string;
  description: string;
  action: (reason: string) => Promise<void>;
};
export function RespondPanel({
  detail,
  lookup,
  me,
  tenantId,
  confirm,
  notify,
  onDirtyChange,
}: {
  detail: FormDetail;
  lookup: Lookup;
  me: Me;
  tenantId: string;
  confirm: (request: ConfirmRequest) => void;
  notify: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [rows, setRows] = useState<Submission[]>([]),
    [active, setActive] = useState<Submission | null>(null);
  const [answers, setAnswers] = useState<Answers>({}),
    [unit, setUnit] = useState(''),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Submission | null>(null),
    [loading, setLoading] = useState(true);
  const trigger = useRef<HTMLElement | null>(null);
  const write = useFormsWrite(me, tenantId);
  const [nextCursor, setNextCursor] = useState<string | null>(null),
    [submittedCount, setSubmittedCount] = useState(0);
  const availableUnits = lookup.units.filter(
    (unit) =>
      lookup.ownUnits.includes(unit.id) &&
      detail.responseUnits.includes(unit.id) &&
      can(me, tenantId, 'forms:respond', unit.id) &&
      (!detail.form.org_unit_id || detail.form.org_unit_id === unit.id),
  );
  const responseUnit = unit || availableUnits[0]?.id || '';
  const version = active
    ? detail.versions.find((version) => version.id === active.version_id)
    : detail.versions.find((version) => version.version === detail.form.latest_version);
  async function reload() {
    const result = await api<PageResult<Submission>>(
      '/api/v1/forms/' +
        detail.form.id +
        '/submissions/page?' +
        new URLSearchParams({ tenantId, own: 'true' }),
    );
    setRows(result.items);
    setNextCursor(result.nextCursor);
    setSubmittedCount(result.submittedCount ?? 0);
    return result;
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api<PageResult<Submission>>(
      '/api/v1/forms/' +
        detail.form.id +
        '/submissions/page?' +
        new URLSearchParams({ tenantId, own: 'true' }),
      { signal: controller.signal },
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        const rows = page.items;
        setRows(rows);
        setNextCursor(page.nextCursor);
        setSubmittedCount(page.submittedCount ?? 0);
        const draft = rows.find((row) => row.status === 'draft');
        setActive(draft ?? null);
        setAnswers(draft?.answers ?? {});
        setUnit(draft?.org_unit_id ?? '');
        setLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [detail.form.id, tenantId]);
  async function save(sent: boolean) {
    if (!version || !responseUnit) {
      setError(new Error('Vui lòng chọn đơn vị.'));
      return;
    }
    try {
      setError(null);
      const parsed = parseAnswers(
        parseFormSchema(version.schema),
        answers,
        sent ? 'submit' : 'draft',
      );
      const action = async (reason: string) => {
        setBusy(true);
        try {
          const row = await write<Submission>(
            '/' + detail.form.id + '/submissions' + (active ? '/' + active.id : ''),
            {
              versionId: version.id,
              orgUnitId: responseUnit,
              answers: parsed,
              submit: sent,
              ...(active ? { expectedRevision: active.revision } : {}),
            },
            reason,
            active ? 'PATCH' : 'POST',
          );
          setActive(sent ? null : row);
          setAnswers(sent ? {} : row.answers);
          onDirtyChange(false);
          setRows((old) => [
            { ...row, version_schema: version.schema, version: version.version },
            ...old.filter((item) => item.id !== row.id),
          ]);
          await reload().catch(setError);
          notify(sent ? 'Đã gửi phiếu. Nội dung đã gửi được giữ nguyên.' : 'Đã lưu bản nháp.');
        } finally {
          setBusy(false);
        }
      };
      if (sent)
        confirm({
          title: 'Gửi phiếu trả lời?',
          description:
            'Sau khi gửi, phiếu này không thể sửa. Bạn có thể đọc lại trong lịch sử bên dưới.',
          action,
        });
      else await action('Lưu bản nháp phiếu trả lời');
    } catch (error) {
      setError(error);
      const fieldId = formIssues(error)[0]?.path.replace('answers.', '');
      if (fieldId) document.getElementById('answer-' + fieldId)?.focus();
    }
  }
  const atLimit = submittedCount >= detail.form.max_submissions;
  const writable =
    detail.form.status === 'open' &&
    version &&
    !version.closed_at &&
    !atLimit &&
    (active
      ? availableUnits.some(({ id }) => id === active.org_unit_id)
      : availableUnits.length > 0);
  return (
    <div className="space-y-6">
      {loading ? (
        <p role="status">Đang tải phiếu của bạn…</p>
      ) : (
        <>
          {!writable && (
            <Alert>
              <AlertDescription>
                {atLimit
                  ? 'Bạn đã gửi đủ số phiếu được phép.'
                  : !availableUnits.length
                    ? 'Bạn không thuộc đối tượng nhận phiếu hiện tại. Lịch sử phiếu của bạn vẫn được giữ.'
                    : 'Biểu mẫu hoặc phiên bản đã đóng. Phiếu cũ vẫn được giữ để đọc lại.'}
              </AlertDescription>
            </Alert>
          )}
          {version && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-[var(--brand-navy)]">
                    {version.schema.title}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">{version.schema.description}</p>
                </div>
                <Badge variant="outline">Phiên bản {version.version}</Badge>
              </div>
              <Choice
                label="Đơn vị trả lời"
                name="response-unit"
                value={responseUnit}
                onChange={(value) => {
                  setUnit(value);
                  onDirtyChange(true);
                }}
                disabled={!!active || busy || !writable}
                options={availableUnits.map((unit) => ({ id: unit.id, name: unit.name }))}
              />
              {writable && (
                <>
                  <FormRenderer
                    schema={version.schema}
                    answers={answers}
                    onChange={(value) => {
                      setAnswers(value);
                      onDirtyChange(true);
                    }}
                    disabled={busy}
                    issues={formIssues(error)}
                  />
                  <div className="flex flex-wrap gap-3">
                    <Button
                      disabled={busy || !responseUnit}
                      variant="outline"
                      onClick={() => void save(false)}
                    >
                      Lưu nháp phiếu
                    </Button>
                    <Button disabled={busy || !responseUnit} onClick={() => void save(true)}>
                      Gửi phiếu
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          {active && (
            <Button
              variant="ghost"
              onClick={() =>
                confirm({
                  title: 'Hủy bản nháp phiếu?',
                  description:
                    'Bản nháp sẽ được lưu lại ở trạng thái đã hủy. Bạn có thể tạo phiếu mới theo phiên bản hiện hành.',
                  action: async (reason) => {
                    await write(
                      '/' + detail.form.id + '/submissions/' + active.id + '/cancel',
                      { expectedRevision: active.revision },
                      reason,
                    );
                    await reload();
                    setActive(null);
                    setAnswers({});
                    onDirtyChange(false);
                    setUnit(availableUnits[0]?.id ?? '');
                    notify('Đã hủy bản nháp phiếu.');
                  },
                })
              }
            >
              Hủy bản nháp phiếu
            </Button>
          )}
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{formError(error)}</AlertDescription>
            </Alert>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Phiếu của tôi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!rows.length && (
                <p className="text-sm text-muted-foreground">Bạn chưa lưu hoặc gửi phiếu nào.</p>
              )}
              {rows.map((row) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  key={row.id}
                >
                  <div>
                    <p className="font-medium">
                      Phiên bản {row.version} ·{' '}
                      {row.status === 'submitted'
                        ? 'Đã gửi'
                        : row.status === 'draft'
                          ? 'Bản nháp'
                          : 'Đã hủy'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {lookup.units.find((unit) => unit.id === row.org_unit_id)?.name ??
                        'Đơn vị đã lưu'}
                      {row.submitted_at &&
                        ' · ' + new Date(row.submitted_at).toLocaleString('vi-VN')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      trigger.current = document.activeElement as HTMLElement;
                      setSelected(row);
                    }}
                  >
                    Đọc lại phiếu
                  </Button>
                  {row.status === 'draft' && active?.id !== row.id && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setActive(row);
                        setAnswers(row.answers);
                        setUnit(row.org_unit_id);
                      }}
                    >
                      Tiếp tục bản nháp
                    </Button>
                  )}
                </div>
              ))}
              {nextCursor && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void api<PageResult<Submission>>(
                      '/api/v1/forms/' +
                        detail.form.id +
                        '/submissions/page?' +
                        new URLSearchParams({ tenantId, own: 'true', after: nextCursor }),
                    )
                      .then((page) => {
                        setRows((old) => [...old, ...page.items]);
                        setNextCursor(page.nextCursor);
                        setSubmittedCount(page.submittedCount ?? submittedCount);
                      })
                      .catch(setError)
                      .finally(() => setBusy(false));
                  }}
                >
                  Tải thêm phiếu của tôi
                </Button>
              )}
            </CardContent>
          </Card>
        </>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Phiếu của tôi · phiên bản {selected?.version}</DialogTitle>
            <DialogDescription>
              Nội dung theo đúng phiên bản được dùng khi tạo phiếu.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <AnswerReadback schema={selected.version_schema} answers={selected.answers} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
