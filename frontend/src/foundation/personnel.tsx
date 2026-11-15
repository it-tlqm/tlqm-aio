import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, allowed } from '@/lib/api';
import type { Me, Row } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { rowLabel } from '@/components/resource-panel';
type InputData = {
  kind: 'onboard' | 'transfer' | 'offboard';
  personId?: string;
  displayName?: string;
  employmentId?: string;
  legalEntityId?: string;
  positionId?: string;
  employeeCode?: string;
  workflowIntakeId?: string;
  effectiveAt: string;
  revokeBindingIds: string[];
};
type Preview = {
  snapshot: string;
  summary: {
    personName: string;
    positionName: string | null;
    accountsDisabled: number;
    changes: { resource: string; id: string | null; data: Row }[];
    bindings: {
      id: string;
      roleCode: string;
      appCode: string;
      orgUnitId: string | null;
      revoke: boolean;
    }[];
    grants: { appCode: string; revoke: boolean }[];
  };
};
type WorkflowDraft = {
  id: string;
  unitId: string;
  title: string;
  displayName?: string;
  employeeCode?: string;
};
const emptyOnboard: InputData = { kind: 'onboard', effectiveAt: '', revokeBindingIds: [] };
function Choice({
  label,
  value,
  onChange,
  rows,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: Row[];
  options: Record<string, Row[]>;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value || '_none'} onValueChange={(v) => onChange(v === '_none' ? '' : v)}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_none">Chọn…</SelectItem>
          {rows.map((row) => (
            <SelectItem key={String(row.id)} value={String(row.id)}>
              {rowLabel(row, options)}
              {row.employeeCode ? ' · ' + row.employeeCode : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function PersonnelPanel({
  me,
  tenantId,
  options,
  onChanged,
}: {
  me: Me;
  tenantId: string;
  options: Record<string, Row[]>;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<InputData>(emptyOnboard),
    [preview, setPreview] = useState<Preview | null>(null),
    [reason, setReason] = useState(''),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [intakes, setIntakes] = useState<WorkflowDraft[] | null>(null),
    [intakeError, setIntakeError] = useState<unknown>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (draft.workflowIntakeId) nameInput.current?.focus();
  }, [draft.workflowIntakeId]);

  function resetReview() {
    setReason('');
    setPreview(null);
    setError(null);
    setDone(false);
    setKey(crypto.randomUUID());
  }
  function change(next: Partial<InputData>) {
    setDraft((d) => ({ ...d, ...next }));
    resetReview();
  }
  async function review(revokeBindingIds = draft.revokeBindingIds) {
    setBusy(true);
    setError(null);
    const input = { ...draft, effectiveAt: new Date().toISOString(), revokeBindingIds };
    try {
      const p = await api<Preview>('/api/v1/manage/personnel/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
        body: JSON.stringify({ tenantId, input }),
      });
      setDraft(input);
      setPreview(p);
      setKey(crypto.randomUUID());
    } catch (e) {
      setPreview(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/manage/personnel/commit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': me.csrfToken,
          'idempotency-key': key,
        },
        body: JSON.stringify({ tenantId, input: draft, snapshot: preview.snapshot, reason }),
      });
      setDone(true);
      setPreview(null);
      if (draft.workflowIntakeId) {
        setIntakes((items) => items?.filter(({ id }) => id !== draft.workflowIntakeId) ?? null);
        setDraft(emptyOnboard);
      }
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function loadIntakes() {
    setBusy(true);
    setIntakeError(null);
    try {
      const { items } = await api<{ items: WorkflowDraft[] }>(
        '/api/v1/manage/personnel/workflow-drafts?' + new URLSearchParams({ tenantId }),
      );
      setIntakes(items);
      if (draft.workflowIntakeId && !items.some(({ id }) => id === draft.workflowIntakeId)) {
        setDraft(emptyOnboard);
        resetReview();
      }
    } catch (failure) {
      setIntakes(null);
      setIntakeError(failure);
    } finally {
      setBusy(false);
    }
  }
  if (!allowed(me, tenantId, 'people:manage'))
    return (
      <Alert>
        <AlertDescription>
          Bạn chưa có quyền vận hành nhân sự trong không gian này.
        </AlertDescription>
      </Alert>
    );
  const employment = options.employments?.find((e) => e.id === draft.employmentId),
    entity = draft.kind === 'transfer' ? employment?.legalEntityId : draft.legalEntityId;
  const intake = intakes?.find(({ id }) => id === draft.workflowIntakeId);
  const positions = (options.positions ?? []).filter(
    (p) => p.active && p.legalEntityId === entity && (!intake || p.orgUnitId === intake.unitId),
  );
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Đề nghị tiếp nhận từ Quy trình
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" disabled={busy} onClick={() => void loadIntakes()}>
            Tải đề nghị tiếp nhận
          </Button>
          {intakeError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(intakeError)}</AlertDescription>
            </Alert>
          )}
          {intakes?.length === 0 && (
            <p className="text-sm text-muted-foreground">Chưa có đề nghị cần xác nhận.</p>
          )}
          {Boolean(intakes?.length) && (
            <ul className="space-y-2">
              {intakes?.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                >
                  <p className="min-w-0 break-words font-medium">{item.title}</p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    aria-label={'Mở đề nghị ' + item.title}
                    onClick={() => {
                      setDraft({
                        ...emptyOnboard,
                        workflowIntakeId: item.id,
                        displayName: item.displayName,
                        employeeCode: item.employeeCode,
                      });
                      resetReview();
                    }}
                  >
                    Mở đề nghị
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Tiếp nhận · Điều chuyển · Nghỉ việc
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Thực hiện ngay sau khi xem trước và xác nhận. Giữ lịch sử; việc tiếp nhận hoặc đổi vị
            trí không tự cấp quyền ứng dụng.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {intake && (
            <p role="status" className="break-words text-sm">
              Đề nghị đang rà soát · {intake.title}
            </p>
          )}
          <fieldset disabled={busy} className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Thao tác</Label>
              <Select
                value={draft.kind}
                onValueChange={(v) => {
                  setDraft({ kind: v as InputData['kind'], effectiveAt: '', revokeBindingIds: [] });
                  resetReview();
                }}
              >
                <SelectTrigger aria-label="Thao tác nhân sự" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="onboard">Tiếp nhận nhân sự</SelectItem>
                  <SelectItem value="transfer">Điều chuyển vị trí chính</SelectItem>
                  <SelectItem value="offboard">Nghỉ việc và thu hồi truy cập</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.kind === 'onboard' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="join-name">Họ và tên nhân sự mới</Label>
                  <Input
                    id="join-name"
                    ref={nameInput}
                    value={draft.displayName ?? ''}
                    onChange={(e) => change({ displayName: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="join-code">Mã nhân sự</Label>
                  <Input
                    id="join-code"
                    value={draft.employeeCode ?? ''}
                    onChange={(e) => change({ employeeCode: e.target.value })}
                  />
                </div>
                <Choice
                  label="Pháp nhân tiếp nhận"
                  value={draft.legalEntityId ?? ''}
                  onChange={(v) => change({ legalEntityId: v, positionId: undefined })}
                  rows={options['legal-entities'] ?? []}
                  options={options}
                />
              </>
            )}
            {draft.kind === 'transfer' && (
              <Choice
                label="Quan hệ công tác cần điều chuyển"
                value={draft.employmentId ?? ''}
                onChange={(v) => change({ employmentId: v, positionId: undefined })}
                rows={options.employments ?? []}
                options={options}
              />
            )}
            {draft.kind === 'offboard' && (
              <Choice
                label="Nhân sự nghỉ việc"
                value={draft.personId ?? ''}
                onChange={(v) => change({ personId: v })}
                rows={(options.people ?? []).filter((p) => p.active && p.id !== me.personId)}
                options={options}
              />
            )}
            {draft.kind !== 'offboard' && (
              <Choice
                label="Vị trí nhận công tác"
                value={draft.positionId ?? ''}
                onChange={(v) => change({ positionId: v })}
                rows={positions}
                options={options}
              />
            )}
          </fieldset>
          <Button onClick={() => void review()} disabled={busy}>
            Xem trước thay đổi
          </Button>
        </CardContent>
      </Card>
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {done && (
        <Alert className="status-success" role="status">
          <AlertDescription>Đã hoàn tất thao tác và ghi lịch sử quản trị.</AlertDescription>
        </Alert>
      )}
      {preview && (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Xác nhận thay đổi · {preview.summary.personName}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p>
              {preview.summary.positionName
                ? 'Vị trí mới: ' + preview.summary.positionName
                : 'Kết thúc công tác và giữ lịch sử.'}
            </p>
            <p className="text-sm text-muted-foreground">
              {draft.kind === 'onboard'
                ? 'Tạo hồ sơ, quan hệ công tác và bổ nhiệm chính. Tài khoản SSO và quyền ứng dụng được cấp riêng.'
                : `${preview.summary.changes.length} bản ghi tổ chức/nhân sự thay đổi; ${preview.summary.accountsDisabled} tài khoản bị khóa.`}
            </p>
            {preview.summary.bindings.length > 0 && (
              <div className="space-y-2">
                <h3 className="font-medium">Rà soát vai trò hiện có</h3>
                {preview.summary.bindings.map((b) => (
                  <label key={b.id} className="flex items-center gap-2 rounded-md border p-2">
                    <Checkbox
                      checked={b.revoke}
                      disabled={busy || draft.kind === 'offboard'}
                      onCheckedChange={(checked) =>
                        void review(
                          checked
                            ? [...draft.revokeBindingIds, b.id]
                            : draft.revokeBindingIds.filter((id) => id !== b.id),
                        )
                      }
                    />
                    <span className="text-sm">
                      Thu hồi {b.roleCode} · {b.appCode} ·{' '}
                      {b.orgUnitId
                        ? String(
                            options['org-units']?.find((u) => u.id === b.orgUnitId)?.name ??
                              'Đơn vị',
                          )
                        : 'Toàn không gian'}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {preview.summary.grants.map((g, i) => (
              <p key={i} className="text-sm">
                {g.revoke ? 'Thu hồi' : 'Giữ'} truy cập ứng dụng: {g.appCode}
              </p>
            ))}
            <div className="space-y-2">
              <Label htmlFor="personnel-reason">Lý do thực hiện</Label>
              <Input
                id="personnel-reason"
                disabled={busy}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setKey(crypto.randomUUID());
                }}
                maxLength={240}
              />
            </div>
            <Button
              variant={draft.kind === 'offboard' ? 'destructive' : 'default'}
              disabled={busy || reason.trim().length < 5}
              onClick={() => void commit()}
            >
              Xác nhận thực hiện
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
