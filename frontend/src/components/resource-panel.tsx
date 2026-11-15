import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { api, apiCollection, allowed } from '@/lib/api';
import type { Me, Row } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { labels } from '@/lib/resources';
import type { Field, Resource } from '@/lib/resources';

type Props = {
  resource: Resource;
  me: Me;
  tenantId: string;
  appCode: string;
  options: Record<string, Row[]>;
  onChanged: () => void;
  editorOnly?: boolean;
  refreshVersion?: number;
  request?: { key: string; row?: Row; defaults?: Row };
};
function localDate(value: unknown) {
  if (!value) return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function rowLabel(row: Row, options: Record<string, Row[]> = {}): string {
  const person = options.people?.find((item) => item.id === row.personId);
  return String(
    row.displayName ??
      row.name ??
      person?.displayName ??
      row.employeeCode ??
      row.code ??
      row.id ??
      row.accountId ??
      '',
  );
}
function status(row: Row) {
  if (
    row.status === 'planned' ||
    (row.validFrom && new Date(String(row.validFrom)).getTime() > Date.now())
  )
    return <Badge className="status-info">Chờ hiệu lực</Badge>;
  if (
    row.active === false ||
    row.status === 'disabled' ||
    (row.validUntil && new Date(String(row.validUntil)).getTime() <= Date.now())
  )
    return <Badge className="status-warning">Đã ngừng</Badge>;
  return <Badge className="status-success">Hoạt động</Badge>;
}
export function ResourcePanel({
  resource,
  me,
  tenantId,
  appCode,
  options,
  onChanged,
  editorOnly = false,
  refreshVersion = 0,
  request,
}: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<Record<string, unknown> | null>(null);
  const confirmTrigger = useRef<HTMLElement | null>(null);
  const mutationKey = useRef(crypto.randomUUID());
  const triggerRef = useRef<HTMLElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const canWrite = allowed(me, tenantId, resource.write);
  const canCreate = allowed(me, tenantId, resource.create ?? resource.write);
  const openedRequest = useRef('');
  useEffect(() => {
    if (!request || openedRequest.current === request.key) return;
    openedRequest.current = request.key;
    if (request.row ? !canWrite || request.row.protected || request.row.isProtected : !canCreate)
      return;
    start(request.row ?? null, request.defaults);
  });
  useEffect(() => {
    if (editorOnly) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setPage(0);
    const params = new URLSearchParams({ tenantId, ...(resource.appScoped ? { appCode } : {}) });
    setRows([]);
    apiCollection<Row>('/api/v1/manage/' + resource.key + '?' + params, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setRows(result.items);
        setLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(error);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [resource.key, tenantId, appCode, reload, editorOnly, refreshVersion]);
  function start(row: Row | null, defaults: Row = {}) {
    triggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMessage('');
    setEditing(row);
    setReason('');
    setErrors({});
    setSaveError(null);
    mutationKey.current = crypto.randomUUID();
    setDraft({
      ...Object.fromEntries(
        resource.fields.map((field) => [
          field.key,
          row
            ? (row[field.key] ?? (field.kind === 'boolean' ? false : ''))
            : field.kind === 'boolean'
              ? field.key === 'active'
              : field.kind === 'permissions'
                ? []
                : field.kind === 'date' && !field.optional
                  ? new Date().toISOString()
                  : field.key === 'status'
                    ? 'planned'
                    : '',
        ]),
      ),
      ...(!row ? defaults : {}),
    });
    setOpen(true);
  }
  function change(key: string, value: unknown) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: '' }));
    setSaveError(null);
    mutationKey.current = crypto.randomUUID();
  }
  function choices(field: Field) {
    if (field.options) return field.options;
    return (options[field.source ?? ''] ?? [])
      .filter((row) => {
        if (editing && row.id === draft[field.key]) return true;
        if (row.active === false) return false;
        if (field.key === 'parentId' && editing?.id === row.id) return false;
        if (
          (field.key === 'parentId' ||
            field.key === 'orgUnitId' ||
            field.key === 'positionId' ||
            field.source === 'employments') &&
          draft.legalEntityId &&
          row.legalEntityId !== draft.legalEntityId
        )
          return false;
        if (field.source === 'accounts' && (row.isProtected || row.id === me.accountId))
          return false;
        return true;
      })
      .map((row) => ({
        value: String(
          field.source === 'roles' ||
            field.source === 'applications' ||
            field.source === 'permissions'
            ? row.code
            : row.id,
        ),
        label:
          field.source === 'positions'
            ? rowLabel(row, options) +
              ' · ' +
              String(
                options['org-units']?.find((unit) => unit.id === row.orgUnitId)?.name ??
                  row.orgUnitId,
              )
            : field.source === 'employments'
              ? rowLabel(row, options) +
                ' · ' +
                String(row.employeeCode) +
                ' · ' +
                String(
                  options['legal-entities']?.find((entity) => entity.id === row.legalEntityId)
                    ?.name ?? row.legalEntityId,
                )
              : rowLabel(row, options),
      }));
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const invalid: Record<string, string> = {};
    const data: Record<string, unknown> = {};
    for (const field of resource.fields) {
      let value = draft[field.key];
      if (field.kind === 'boolean') value = Boolean(value);
      else if (field.kind === 'permissions') value = Array.isArray(value) ? value : [];
      else if (field.kind === 'date') value = value ? new Date(String(value)).toISOString() : null;
      else if (field.kind === 'select') value = value === '' || value === undefined ? null : value;
      else value = String(value ?? '').trim();
      if (field.key === 'launchUrl' && value === '') value = null;
      if (
        !field.optional &&
        field.kind !== 'boolean' &&
        field.kind !== 'permissions' &&
        (value === null || value === '')
      )
        invalid[field.key] = 'Vui lòng nhập ' + field.label.toLowerCase() + '.';
      data[field.key] = value;
    }
    if (reason.trim().length < 5) invalid.reason = 'Nhập lý do thay đổi, tối thiểu 5 ký tự.';
    if (
      data.validFrom &&
      data.validUntil &&
      new Date(String(data.validUntil)) <= new Date(String(data.validFrom))
    )
      invalid.validUntil = 'Thời điểm kết thúc phải sau thời điểm bắt đầu.';
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    if (resource.appScoped) data.appCode = appCode;
    const sensitive =
      ['roles', 'permissions', 'bindings', 'grants'].includes(resource.key) ||
      Boolean(
        editing && ['accounts', 'people'].includes(resource.key) && data.active !== editing.active,
      ) ||
      Boolean(
        editing &&
        resource.key === 'applications' &&
        (data.status !== editing.status || data.launchUrl !== editing.launchUrl),
      );
    if (sensitive) {
      confirmTrigger.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSaveError(null);
      setConfirmation(data);
      return;
    }
    await persist(data);
  }
  async function persist(data: Record<string, unknown>) {
    setSaving(true);
    setSaveError(null);
    const id = editing?.[resource.idKey ?? 'id'];
    try {
      await api(
        '/api/v1/manage/' + resource.key + (editing ? '/' + encodeURIComponent(String(id)) : ''),
        {
          method: editing ? 'PATCH' : 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': me.csrfToken,
            'idempotency-key': mutationKey.current,
          },
          body: JSON.stringify({
            tenantId,
            reason: reason.trim(),
            data,
            ...(editing ? { expectedRevision: editing.revision } : {}),
          }),
        },
      );
      setConfirmation(null);
      setOpen(false);
      setReload((value) => value + 1);
      setMessage('Đã lưu thay đổi và ghi nhận lịch sử.');
      onChanged();
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  }
  function confirmationValue(field: Field) {
    const value = confirmation?.[field.key];
    if (field.kind === 'boolean') return value ? 'Hoạt động' : 'Ngừng hoạt động';
    if (field.kind === 'date')
      return value ? new Date(String(value)).toLocaleString('vi') : 'Không giới hạn';
    if (field.kind === 'permissions')
      return Array.isArray(value)
        ? value
            .map((code) =>
              String(options.permissions?.find((item) => item.code === code)?.name ?? code),
            )
            .join(', ') || 'Không có quyền thao tác'
        : 'Không có quyền thao tác';
    if (field.kind === 'select')
      return (
        choices(field).find((choice) => choice.value === String(value))?.label ??
        (field.key === 'orgUnitId' ? 'Toàn không gian' : 'Không chọn')
      );
    return String(value ?? '');
  }
  function renderCell(row: Row, key: string) {
    if (key === 'active' || key === 'status') return status(row);
    if (key === 'protected' || key === 'isProtected')
      return row[key] ? <Badge variant="secondary">Hệ thống</Badge> : '—';
    if (key === 'mfaRequired') return row[key] ? 'Bắt buộc' : 'Chưa yêu cầu';
    if (key === 'accountActive') return row[key] ? 'Hoạt động' : 'Đã khóa';
    if (key === 'permissions')
      return Array.isArray(row[key]) ? String((row[key] as unknown[]).length) + ' quyền' : '—';
    if (key.toLowerCase().includes('valid') || key === 'provisionedAt')
      return row[key]
        ? new Date(String(row[key])).toLocaleString('vi-VN', {
            dateStyle: 'short',
            timeStyle: 'short',
          })
        : '—';
    const field = resource.fields.find((field) => field.key === key);
    if (field?.source) {
      const match = (options[field.source] ?? []).find(
        (item) =>
          String(item.id ?? item.code) === String(row[key]) ||
          String(item.code) === String(row[key]),
      );
      if (match) return rowLabel(match, options);
    }
    if (row[key] === null || row[key] === undefined || row[key] === '') return '—';
    return String(row[key]);
  }
  const visible = rows.filter(
    (row) =>
      (archived ||
        !(
          row.active === false ||
          row.status === 'disabled' ||
          (row.validUntil && new Date(String(row.validUntil)).getTime() < Date.now())
        )) &&
      JSON.stringify(row).toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')),
  );
  const pages = Math.max(1, Math.ceil(visible.length / 15));
  const currentPage = Math.min(page, pages - 1);
  const slice = visible.slice(currentPage * 15, (currentPage + 1) * 15);
  return (
    <section ref={sectionRef} tabIndex={-1} aria-label={resource.title} className="space-y-4">
      {!editorOnly && (
        <>
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-xl font-semibold">{resource.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Quản lý trong phạm vi đơn vị được cấp.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setReload((value) => value + 1)}
                aria-label="Tải lại danh sách"
              >
                <RefreshCw className="size-4" />
              </Button>
              {canCreate && !loadError && (
                <Button onClick={() => start(null)}>
                  <Plus className="size-4" />
                  Thêm {resource.singular}
                </Button>
              )}
            </div>
          </div>
          {message && (
            <Alert className="status-success" role="status">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
          {loadError ? (
            <Alert variant="destructive">
              <ShieldAlert className="size-4" />
              <AlertDescription>{errorMessage(loadError)}</AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative w-full max-w-md">
                  <Search className="absolute left-3 top-3.5 size-4 text-muted-foreground" />
                  <Input
                    className="pl-10"
                    aria-label="Tìm kiếm trong danh sách"
                    placeholder="Tìm theo tên, mã hoặc nội dung…"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(0);
                    }}
                  />
                </div>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <Checkbox
                    checked={archived}
                    onCheckedChange={(value) => setArchived(value === true)}
                  />
                  Hiện mục đã ngừng
                </label>
              </div>
              <div className="overflow-hidden rounded-lg border bg-card">
                {loading ? (
                  <div className="space-y-4 p-5" role="status">
                    <span className="sr-only">Đang tải dữ liệu</span>
                    {[0, 1, 2, 3].map((item) => (
                      <Skeleton key={item} className="h-10 w-full" />
                    ))}
                  </div>
                ) : (
                  <Table
                    className={
                      ['reporting-lines', 'unit-leaders', 'approval-substitutions'].includes(
                        resource.key,
                      )
                        ? 'min-w-[900px]'
                        : undefined
                    }
                    containerProps={
                      ['reporting-lines', 'unit-leaders', 'approval-substitutions'].includes(
                        resource.key,
                      )
                        ? { tabIndex: 0, role: 'region', 'aria-label': 'Bảng ' + resource.title }
                        : undefined
                    }
                  >
                    <TableHeader>
                      <TableRow>
                        {resource.columns.map((key) => (
                          <TableHead key={key}>{labels[key] ?? key}</TableHead>
                        ))}
                        <TableHead className="w-20 text-right">Thao tác</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {slice.length ? (
                        slice.map((row, index) => (
                          <TableRow key={String(row[resource.idKey ?? 'id'] ?? index)}>
                            {resource.columns.map((key) => (
                              <TableCell className="table-cell-wrap" key={key}>
                                {renderCell(row, key)}
                              </TableCell>
                            ))}
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={'Sửa ' + rowLabel(row, options)}
                                disabled={
                                  !canWrite ||
                                  Boolean(row.protected) ||
                                  Boolean(row.isProtected) ||
                                  ((resource.key === 'bindings' || resource.key === 'grants') &&
                                    row.accountId === me.accountId)
                                }
                                onClick={() => start(row)}
                              >
                                <Pencil className="size-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell
                            colSpan={resource.columns.length + 1}
                            className="h-36 text-center text-muted-foreground"
                          >
                            {query
                              ? 'Không có kết quả phù hợp.'
                              : 'Chưa có dữ liệu trong danh sách này.'}
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                )}
              </div>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  {visible.length} bản ghi · Trang {currentPage + 1}/{pages}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Trang trước"
                    disabled={currentPage === 0}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Trang sau"
                    disabled={currentPage === pages - 1}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!saving && !confirmation) setOpen(value);
        }}
      >
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (triggerRef.current?.isConnected) triggerRef.current.focus();
            else sectionRef.current?.focus();
          }}
        >
          <DialogHeader className="pr-12">
            <DialogTitle>
              {editing ? 'Cập nhật ' : 'Thêm '}
              {resource.singular}
            </DialogTitle>
            <DialogDescription>
              Thay đổi được kiểm tra quyền và lưu vào lịch sử quản trị.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-5" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              {resource.fields.map((field) => {
                const id = 'field-' + field.key;
                const disabled =
                  saving ||
                  Boolean(editing && field.immutable) ||
                  (resource.key === 'people' &&
                    editing?.id === me.personId &&
                    field.key === 'active');
                return (
                  <div
                    key={field.key}
                    className={
                      field.kind === 'permissions' || field.kind === 'textarea'
                        ? 'space-y-2 sm:col-span-2'
                        : 'space-y-2'
                    }
                  >
                    {field.kind === 'boolean' ? (
                      <label htmlFor={id} className="flex min-h-11 items-center gap-3">
                        <Checkbox
                          id={id}
                          disabled={disabled}
                          checked={Boolean(draft[field.key])}
                          onCheckedChange={(value) => change(field.key, value === true)}
                        />
                        <span className="text-sm font-medium">{field.label}</span>
                      </label>
                    ) : (
                      <>
                        <Label htmlFor={id}>
                          {field.label}
                          {!field.optional && (
                            <span className="text-destructive" aria-hidden="true">
                              {' '}
                              *
                            </span>
                          )}
                        </Label>
                        {field.kind === 'select' ? (
                          <Select
                            disabled={disabled}
                            value={String(draft[field.key] ?? '') || '__none__'}
                            onValueChange={(value) =>
                              change(field.key, value === '__none__' ? null : value)
                            }
                          >
                            <SelectTrigger
                              id={id}
                              className="w-full"
                              aria-invalid={Boolean(errors[field.key])}
                            >
                              <SelectValue placeholder="Chọn giá trị" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">
                                {field.optional ? 'Không chọn' : 'Chọn giá trị'}
                              </SelectItem>
                              {choices(field).map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : field.kind === 'permissions' ? (
                          <div
                            id={id}
                            className="grid max-h-64 gap-2 overflow-y-auto rounded-md border p-3 sm:grid-cols-2"
                            role="group"
                            aria-label={field.label}
                          >
                            {(options.permissions ?? [])
                              .filter((item) => item.active !== false)
                              .map((permission) => (
                                <label
                                  key={String(permission.code)}
                                  className="flex min-h-11 items-center gap-2 text-sm"
                                >
                                  <Checkbox
                                    disabled={disabled}
                                    checked={
                                      Array.isArray(draft.permissions) &&
                                      draft.permissions.includes(permission.code)
                                    }
                                    onCheckedChange={(value) => {
                                      const selected = Array.isArray(draft.permissions)
                                        ? draft.permissions
                                        : [];
                                      change(
                                        'permissions',
                                        value === true
                                          ? [...selected, permission.code]
                                          : selected.filter((code) => code !== permission.code),
                                      );
                                    }}
                                  />
                                  <span>{String(permission.name)}</span>
                                </label>
                              ))}
                            {!options.permissions?.length && (
                              <p className="text-sm text-muted-foreground">
                                Chưa có quyền trong danh mục ứng dụng.
                              </p>
                            )}
                          </div>
                        ) : field.kind === 'textarea' ? (
                          <Textarea
                            id={id}
                            disabled={disabled}
                            value={String(draft[field.key] ?? '')}
                            onChange={(event) => change(field.key, event.target.value)}
                          />
                        ) : (
                          <Input
                            id={id}
                            disabled={disabled}
                            type={field.kind === 'date' ? 'datetime-local' : 'text'}
                            aria-invalid={Boolean(errors[field.key])}
                            aria-describedby={errors[field.key] ? id + '-error' : undefined}
                            value={
                              field.kind === 'date'
                                ? localDate(draft[field.key])
                                : String(draft[field.key] ?? '')
                            }
                            onChange={(event) =>
                              change(
                                field.key,
                                field.kind === 'date' && event.target.value
                                  ? new Date(event.target.value).toISOString()
                                  : event.target.value,
                              )
                            }
                          />
                        )}
                      </>
                    )}
                    {errors[field.key] && (
                      <p id={id + '-error'} className="text-sm text-destructive">
                        {errors[field.key]}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="space-y-2">
              <Label htmlFor="change-reason">
                Lý do thay đổi <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="change-reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  mutationKey.current = crypto.randomUUID();
                  setErrors((value) => ({ ...value, reason: '' }));
                }}
                placeholder="Nêu ngắn gọn lý do tạo hoặc cập nhật…"
                aria-invalid={Boolean(errors.reason)}
              />
              {errors.reason && <p className="text-sm text-destructive">{errors.reason}</p>}
            </div>
            {Boolean(saveError) && (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage(saveError)}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setOpen(false)}
              >
                Hủy
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Đang lưu…' : 'Lưu thay đổi'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(value) => {
          if (!value && !saving) setConfirmation(null);
        }}
      >
        <AlertDialogContent
          className="max-h-[85vh] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (confirmTrigger.current?.isConnected) confirmTrigger.current.focus();
            else triggerRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận thay đổi quyền truy cập</AlertDialogTitle>
            <AlertDialogDescription>
              Thay đổi {resource.singular} sẽ được áp dụng theo phạm vi hiện tại và lưu lịch sử. Hãy
              kiểm tra đối tượng, quyền và thời hạn trước khi lưu.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-words font-medium">
            {editing
              ? rowLabel(editing, options)
              : String(
                  confirmation?.name ??
                    confirmation?.code ??
                    options.accounts?.find((item) => item.id === confirmation?.accountId)
                      ?.displayName ??
                    'Bản ghi mới',
                )}
          </p>
          <dl className="space-y-2 text-sm">
            {resource.fields
              .filter((field) =>
                [
                  'accountId',
                  'roleCode',
                  'permissions',
                  'orgUnitId',
                  'managedAppCode',
                  'active',
                  'status',
                  'validUntil',
                  'launchUrl',
                ].includes(field.key),
              )
              .map((field) => (
                <div key={field.key}>
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="break-words font-medium">{confirmationValue(field)}</dd>
                </div>
              ))}
          </dl>
          <p className="break-words text-sm text-muted-foreground">Lý do: {reason}</p>
          {Boolean(saveError) && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(saveError)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Quay lại biểu mẫu</AlertDialogCancel>
            <Button
              disabled={saving}
              onClick={() => {
                if (confirmation) void persist(confirmation);
              }}
            >
              {saving ? 'Đang lưu…' : 'Xác nhận lưu'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
