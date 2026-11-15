import { useEffect, useId, useState, useRef } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import {
  configurationReferences,
  parseConfigurationPackage,
  ConfigurationTransferError,
} from '../../../src/configuration-package';
import type {
  ConfigurationKind,
  ConfigurationPackage,
  ConfigurationReference,
  ReferenceOptions,
  SignedConfigurationReview,
} from '../../../src/configuration-package';
type Preview = {
  review: SignedConfigurationReview;
  changes: { path: string; before: string; after: string }[];
  backup: ConfigurationPackage;
  imported: ConfigurationPackage;
};
type Action = 'export' | 'options' | 'preview' | 'apply';
const typeNames = {
  unit: 'Đơn vị',
  account: 'Người xử lý',
  group: 'Nhóm xử lý',
  courseVersion: 'Phiên bản khóa học',
  media: 'Tệp nội dung',
};
const terms: Record<string, string> = {
  schema: 'Biểu mẫu',
  sections: 'Nhóm',
  fields: 'Trường',
  title: 'Tên',
  label: 'Nhãn',
  description: 'Hướng dẫn',
  required: 'Bắt buộc',
  selfView: 'Nhân viên được xem',
  selfEdit: 'Nhân viên được sửa',
  name: 'Tên',
  category: 'Phân loại',
  audienceUnits: 'Đơn vị',
  nodes: 'Bước',
  assignee: 'Người xử lý',
  dueHours: 'Hạn (giờ)',
  deadlineMinutes: 'Hạn (phút)',
  calendar: 'Lịch',
  questions: 'Câu hỏi',
  answerKey: 'Đáp án',
  policy: 'Chính sách học/thi',
  passScore: 'Điểm đạt',
  courseVersionIds: 'Khóa trong lộ trình',
  options: 'Lựa chọn',
  type: 'Loại',
  id: 'Mã',
  next: 'Bước tiếp',
  subtitle: 'Mô tả ngắn',
};
const fieldName = (path: string) =>
  path
    .split('.')
    .map((p) => p.replace(/^[^[]+/, (v) => terms[v] ?? v))
    .join(' › ');
function download(pack: ConfigurationPackage, target: string, before = false) {
  const pretty = JSON.stringify(pack, null, 2);
  const text =
    new TextEncoder().encode(pretty).byteLength <= 262144 ? pretty : JSON.stringify(pack);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' })),
    link = document.createElement('a');
  link.href = url;
  link.download =
    'tlqm-' + pack.kind + '-' + target.slice(0, 12) + (before ? '-truoc-khi-nhap' : '') + '.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ReferenceRow({
  reference,
  index,
  options,
  value,
  onChange,
}: {
  reference: ConfigurationReference;
  index: number;
  options: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [search, setSearch] = useState(''),
    id = useId(),
    selected = options.find((o) => o.id === value),
    matches = options.filter((o) =>
      (o.name + ' ' + o.id).toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')),
    ),
    visible = [
      ...(selected ? [selected] : []),
      ...matches.filter((o) => o.id !== value).slice(0, 100),
    ];
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">
        {typeNames[reference.type]} nguồn: {reference.label}
      </p>
      <p className="break-all text-xs text-muted-foreground">{reference.id}</p>
      {options.length > 30 && (
        <div className="space-y-1">
          <Label htmlFor={id}>Tìm đối tượng thay thế {index + 1}</Label>
          <Input id={id} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      )}
      <Choice
        label={'Đích cho ' + reference.label}
        value={value || '_none'}
        onChange={(v) => onChange(v === '_none' ? '' : v)}
        options={[{ id: '_none', name: 'Chọn đối tượng hiện hành' }, ...visible]}
      />
      {matches.length > 100 && (
        <p className="text-xs text-muted-foreground">
          Hiện 100 kết quả đầu; nhập tên để thu hẹp lựa chọn.
        </p>
      )}
    </div>
  );
}
function DifferenceValue({ value }: { value: string }) {
  return value.length < 400 ? (
    <p className="whitespace-pre-wrap break-words text-sm">{value}</p>
  ) : (
    <details className="text-sm">
      <summary className="cursor-pointer py-2">Xem giá trị đầy đủ ({value.length} ký tự)</summary>
      <pre className="whitespace-pre-wrap break-words font-sans">{value}</pre>
    </details>
  );
}
export function ConfigurationTransferControls({
  kind,
  target,
  tenantId,
  csrfToken,
  disabled = false,
  onImported,
}: {
  kind: ConfigurationKind;
  target: string;
  tenantId?: string;
  csrfToken: string;
  disabled?: boolean;
  onImported: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState(''),
    [pack, setPack] = useState<ConfigurationPackage | null>(null),
    [options, setOptions] = useState<ReferenceOptions | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [selected, setSelected] = useState<Record<string, string>>({}),
    [reason, setReason] = useState(''),
    [refPage, setRefPage] = useState(0),
    [diffPage, setDiffPage] = useState(0),
    [applyKey, setApplyKey] = useState(() => crypto.randomUUID());
  const fileId = useId(),
    reasonId = useId(),
    lms = kind.startsWith('lms-');
  const fileRead = useRef(0);
  function fail(e: unknown) {
    setError(e);
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      setOptions(null);
      setPreview(null);
    }
  }
  const refs = pack
    ? configurationReferences(kind, pack.content).map((r) => ({
        ...r,
        label:
          pack.references.find((label) => label.type === r.type && label.id === r.id)?.label ??
          r.label,
      }))
    : [];
  async function call<T>(
    action: Action,
    fields: Record<string, unknown> = {},
    key = crypto.randomUUID(),
  ): Promise<T> {
    return api<T>(
      lms
        ? '/api/lms/config-transfer'
        : '/api/v1/configuration-transfer/' + kind + '/' + target + '/' + action,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'idempotency-key': key,
        },
        body: JSON.stringify({
          ...(lms ? { action, kind, target } : { tenantId }),
          reason: action === 'apply' ? reason : 'Đối chiếu cấu hình bằng tệp JSON',
          ...fields,
        }),
      },
    );
  }
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPack(null);
    setOptions(null);
    setPreview(null);
    setError(null);
    setMessage('');
    setSelected({});
    setReason('');
    setRefPage(0);
    setDiffPage(0);
    void call<ReferenceOptions>('options')
      .then((r) => {
        if (!cancelled) setOptions(r);
      })
      .catch((e) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
      fileRead.current++;
    };
  }, [open, kind, target, tenantId]);
  async function file(file: File | undefined) {
    const generation = ++fileRead.current;
    setPreview(null);
    setPack(null);
    setError(null);
    setRefPage(0);
    setDiffPage(0);
    if (!file) return;
    try {
      if (file.size > 262144) throw new ConfigurationTransferError('CONFIGURATION_TOO_LARGE');
      const next = parseConfigurationPackage(
          JSON.parse((await file.text()).replace(/^\uFEFF/, '')),
          kind,
        ),
        references = configurationReferences(kind, next.content);
      if (generation !== fileRead.current) return;
      setSelected(
        Object.fromEntries(
          references.map((r) => [
            r.type + ':' + r.id,
            options?.[r.type].some((o) => o.id === r.id) ? r.id : '',
          ]),
        ),
      );
      setPack(next);
    } catch (e) {
      if (generation !== fileRead.current) return;
      setError(
        e instanceof ConfigurationTransferError
          ? new ApiError(e.status, e.code)
          : new ApiError(400, 'CONFIGURATION_PACKAGE_INVALID'),
      );
    }
  }
  async function exportFile() {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      download(await call<ConfigurationPackage>('export'), target);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    if (!pack) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(
        await call<Preview>('preview', {
          package: pack,
          mappings: refs.map((r) => ({
            type: r.type,
            from: r.id,
            to: selected[r.type + ':' + r.id] || r.id,
          })),
        }),
      );
      setDiffPage(0);
      setApplyKey(crypto.randomUUID());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      download(preview.backup, target, true);
      await call('apply', { review: preview.review }, applyKey);
      await onImported();
      setOpen(false);
      setMessage('Đã nhập cấu hình vào bản nháp. Kiểm tra trước khi phát hành.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={disabled || busy} onClick={() => void exportFile()}>
        Xuất cấu hình
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogTrigger asChild>
          <Button variant="outline" disabled={disabled || busy}>
            Nhập cấu hình
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Nhập cấu hình vào bản nháp</DialogTitle>
            <DialogDescription>
              Chọn tệp, đối chiếu các tham chiếu và xem thay đổi. Tệp sao lưu nháp hiện tại được gửi
              đến trình duyệt trước khi ghi.
            </DialogDescription>
          </DialogHeader>
          {Boolean(error) && (
            <Alert variant="destructive">
              <AlertDescription>
                {errorMessage(error)}
                {error instanceof ApiError && error.issues?.length ? (
                  <ul className="mt-2 list-disc pl-4">
                    {error.issues.slice(0, 8).map((i, n) => (
                      <li key={n}>
                        {i.path}: {i.code}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </AlertDescription>
            </Alert>
          )}
          {!options && !error && <p role="status">Đang kiểm tra quyền và danh mục tham chiếu…</p>}
          {options && (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor={fileId}>Tệp cấu hình JSON</Label>
                <Input
                  id={fileId}
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={(e) => void file(e.target.files?.[0])}
                />
                <p className="text-xs text-muted-foreground">
                  Định dạng TLQM AIO v1, tối đa 256 KB.
                </p>
              </div>
              {pack && (
                <>
                  <p className="text-sm">
                    Tệp: <strong>{pack.label}</strong> · Xuất{' '}
                    {new Date(pack.createdAt).toLocaleString('vi-VN')}
                  </p>
                  {refs.length > 0 && (
                    <fieldset className="space-y-3">
                      <legend className="mb-2 font-semibold">Đối chiếu đối tượng hiện hành</legend>
                      {refs.slice(refPage * 8, refPage * 8 + 8).map((r, i) => (
                        <ReferenceRow
                          key={r.type + r.id}
                          reference={r}
                          index={refPage * 8 + i}
                          options={options[r.type]}
                          value={selected[r.type + ':' + r.id] ?? ''}
                          onChange={(id) => {
                            setSelected((s) => ({ ...s, [r.type + ':' + r.id]: id }));
                            setPreview(null);
                          }}
                        />
                      ))}
                      {refs.length > 8 && (
                        <nav
                          aria-label="Phân trang tham chiếu"
                          className="flex flex-wrap items-center gap-2"
                        >
                          <Button
                            variant="outline"
                            disabled={!refPage}
                            onClick={() => setRefPage(refPage - 1)}
                          >
                            Tham chiếu trước
                          </Button>
                          <span className="text-sm">
                            Trang {refPage + 1}/{Math.ceil(refs.length / 8)}
                          </span>
                          <Button
                            variant="outline"
                            disabled={(refPage + 1) * 8 >= refs.length}
                            onClick={() => setRefPage(refPage + 1)}
                          >
                            Tham chiếu sau
                          </Button>
                        </nav>
                      )}
                    </fieldset>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy || refs.some((r) => !selected[r.type + ':' + r.id])}
                    onClick={() => void inspect()}
                  >
                    Xem trước khác biệt
                  </Button>
                </>
              )}
              {preview && (
                <section className="space-y-3" aria-label="Khác biệt cấu hình">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">Nháp r{preview.review.payload.revision}</Badge>
                    <p role="status" className="text-sm">
                      {preview.changes.length} thay đổi được đối chiếu
                    </p>
                  </div>
                  {preview.changes.slice(diffPage * 10, diffPage * 10 + 10).map((change, i) => (
                    <Card key={i}>
                      <CardHeader>
                        <CardTitle className="break-words text-sm">
                          {fieldName(change.path)}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="grid gap-3 sm:grid-cols-2">
                        <div className="min-w-0 space-y-1 rounded-lg bg-muted p-3">
                          <p className="text-xs font-medium text-muted-foreground">Hiện tại</p>
                          <DifferenceValue value={change.before} />
                        </div>
                        <div className="min-w-0 space-y-1 rounded-lg border p-3">
                          <p className="text-xs font-medium text-muted-foreground">Sau khi nhập</p>
                          <DifferenceValue value={change.after} />
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                  {preview.changes.length > 10 && (
                    <nav
                      aria-label="Phân trang khác biệt"
                      className="flex flex-wrap items-center gap-2"
                    >
                      <Button
                        variant="outline"
                        disabled={!diffPage}
                        onClick={() => setDiffPage(diffPage - 1)}
                      >
                        Khác biệt trước
                      </Button>
                      <span className="text-sm">
                        Trang {diffPage + 1}/{Math.ceil(preview.changes.length / 10)}
                      </span>
                      <Button
                        variant="outline"
                        disabled={(diffPage + 1) * 10 >= preview.changes.length}
                        onClick={() => setDiffPage(diffPage + 1)}
                      >
                        Khác biệt sau
                      </Button>
                    </nav>
                  )}
                  {!preview.changes.length && (
                    <p className="text-sm text-muted-foreground">
                      Nội dung trùng bản nháp hiện tại.
                    </p>
                  )}
                  <Button variant="outline" onClick={() => download(preview.imported, target)}>
                    Tải cấu hình đã đối chiếu
                  </Button>
                  <div className="space-y-2">
                    <Label htmlFor={reasonId}>Lý do nhập cấu hình</Label>
                    <Input
                      id={reasonId}
                      value={reason}
                      maxLength={240}
                      disabled={busy}
                      onChange={(e) => {
                        setReason(e.target.value);
                        setApplyKey(crypto.randomUUID());
                      }}
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Sau khi ghi, tiếp tục kiểm tra và phát hành theo quyền quản trị của module.
                  </p>
                </section>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Đóng
            </Button>
            <Button
              disabled={busy || !preview?.changes.length || reason.trim().length < 5}
              onClick={() => void apply()}
            >
              Ghi bản nháp đã đối chiếu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!open && Boolean(error) && (
        <p role="alert" className="w-full text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}
      {message && (
        <p role="status" className="w-full text-sm text-primary">
          {message}
        </p>
      )}
    </div>
  );
}
