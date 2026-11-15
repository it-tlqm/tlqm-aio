import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Learners, LearnerAction } from '../../../src/lms/learners';
type MappingPage = Awaited<ReturnType<Learners['mappings']>>;
type Mapping = MappingPage['items'][number];
type Candidates = Awaited<ReturnType<Learners['discover']>>;
type Candidate = Candidates['items'][number];
const labels: Record<string, string> = {
  ready: 'Sẵn sàng học',
  disabled: 'Đã khóa tại LMS',
  unavailable: 'Cần kiểm tra quyền AIO',
  'stale-unit': 'Cần đối soát đơn vị',
  'identity-disabled': 'Liên kết SSO đã khóa',
  'profile-inactive': 'Hồ sơ cũ đã ngừng',
};
const actions: Record<LearnerAction, string> = {
  provision: 'Thêm học viên',
  enable: 'Mở lại học viên',
  disable: 'Khóa học viên',
  reconcile: 'Đối soát đơn vị',
};
export function LearnersPanel({
  csrfToken,
  accountId,
  onAccessError,
}: {
  csrfToken: string;
  accountId: string;
  onAccessError: (error: unknown) => void;
}) {
  const [data, setData] = useState<MappingPage | null>(null),
    [cursors, setCursors] = useState<string[]>([]),
    [generation, setGeneration] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const [discover, setDiscover] = useState(false),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [candidateCursors, setCandidateCursors] = useState<string[]>([]),
    [candidates, setCandidates] = useState<Candidates | null>(null),
    [searchBusy, setSearchBusy] = useState(false);
  const [selection, setSelection] = useState<{ mapping?: Mapping; candidate?: Candidate } | null>(
      null,
    ),
    [action, setAction] = useState<LearnerAction>('provision'),
    [unit, setUnit] = useState(''),
    [reason, setReason] = useState(''),
    [saving, setSaving] = useState(false),
    [dialogError, setDialogError] = useState<unknown>(null);
  const addTrigger = useRef<HTMLButtonElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null),
    pending = useRef<{ body: string; key: string } | null>(null);
  const fail = (e: unknown) => {
    setError(e);
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      setData(null);
      setCandidates(null);
      setSelection(null);
      setDiscover(false);
      onAccessError(e);
    }
  };
  const cursor = cursors.at(-1),
    candidateCursor = candidateCursors.at(-1);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setData(null);
    setError(null);
    void api<MappingPage>(
      '/api/lms/learners' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) fail(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [cursor, generation]);
  useEffect(() => {
    if (!discover) return;
    const controller = new AbortController();
    setSearchBusy(true);
    setCandidates(null);
    setDialogError(null);
    const params = new URLSearchParams({
      search: query,
      ...(candidateCursor ? { cursor: candidateCursor } : {}),
    });
    void api<Candidates>('/api/lms/learner-candidates?' + params, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setCandidates(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setDialogError(e);
          if (e instanceof ApiError && [401, 403].includes(e.status)) fail(e);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearchBusy(false);
      });
    return () => controller.abort();
  }, [discover, query, candidateCursor]);
  const choose = (
    value: { mapping?: Mapping; candidate?: Candidate },
    button: HTMLButtonElement,
  ) => {
    trigger.current = button;
    setSelection(value);
    setAction(value.candidate ? 'provision' : value.mapping!.active ? 'disable' : 'enable');
    setUnit(value.candidate?.units[0]?.id ?? value.mapping!.orgUnitId);
    setReason('');
    setDialogError(null);
    pending.current = null;
    if (value.candidate) setDiscover(false);
  };
  const selected = selection?.candidate ?? selection?.mapping;
  const unitChoices = selection?.candidate?.units ?? selection?.mapping?.units ?? [];
  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setDialogError(null);
    setNotice('');
    const body = JSON.stringify({
      action,
      data: {
        accountId: selected.accountId,
        orgUnitId: unit,
        expectedRevision: selection?.mapping?.revision ?? 0,
      },
      reason: reason.trim(),
    });
    if (pending.current?.body !== body) pending.current = { body, key: crypto.randomUUID() };
    try {
      await api('/api/lms/learner-commands', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'idempotency-key': pending.current.key,
        },
        body,
      });
      setNotice(actions[action] + ' thành công.');
      setSelection(null);
      setCandidates(null);
      setCursors([]);
      setGeneration((v) => v + 1);
      pending.current = null;
    } catch (e) {
      setDialogError(e);
      if (e instanceof ApiError && [401, 403].includes(e.status)) fail(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle role="heading" aria-level={2} className="text-xl">
              Học viên & tài khoản
            </CardTitle>
            <CardDescription className="mt-2 max-w-2xl">
              Thêm nhân sự đã được cấp quyền LMS trên AIO, quản lý trạng thái và đơn vị học tập.
            </CardDescription>
          </div>
          <Button
            ref={addTrigger}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              setDiscover(true);
              setSearch('');
              setQuery('');
              setCandidateCursors([]);
            }}
          >
            <Plus aria-hidden="true" />
            Thêm từ AIO
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-lg bg-secondary p-4 text-sm">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
            <p>
              Học viên dùng tài khoản SSO của công ty. Mật khẩu và vai trò được quản lý tại AIO;
              lịch sử học được giữ khi khóa hoặc đổi đơn vị.
            </p>
          </div>
        </CardContent>
      </Card>
      {!!notice && (
        <p
          role="status"
          className="rounded-lg border bg-[var(--success-bg)] p-4 text-sm text-[var(--success)]"
        >
          {notice}
        </p>
      )}
      {!!error && (
        <Alert variant="destructive">
          <AlertDescription>
            {errorMessage(error)}
            <Button variant="outline" onClick={() => setGeneration((v) => v + 1)}>
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle role="heading" aria-level={2}>
              Danh sách học viên
            </CardTitle>
            <CardDescription className="mt-1">
              Trang {cursors.length + 1} · Tối đa 50 hồ sơ mỗi trang
            </CardDescription>
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setGeneration((v) => v + 1)}
            aria-label="Làm mới danh sách học viên"
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </CardHeader>
        <CardContent>
          {busy ? (
            <p role="status" className="py-12 text-center text-muted-foreground">
              Đang tải học viên…
            </p>
          ) : (
            data && (
              <>
                <div
                  role="region"
                  aria-label="Danh sách học viên đã liên kết"
                  tabIndex={0}
                  className="overflow-x-auto rounded-lg border"
                >
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Học viên</TableHead>
                        <TableHead>Đơn vị học tập</TableHead>
                        <TableHead>Trạng thái</TableHead>
                        <TableHead>Hồ sơ</TableHead>
                        <TableHead>
                          <span className="sr-only">Thao tác</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.items.length ? (
                        data.items.map((row) => (
                          <TableRow key={row.accountId}>
                            <TableCell>
                              <p className="font-medium">{row.name}</p>
                              <p className="mt-1 max-w-60 break-all text-xs text-muted-foreground">
                                {row.code}
                              </p>
                            </TableCell>
                            <TableCell className="min-w-36">{row.unitName}</TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={
                                  row.state === 'ready'
                                    ? 'status-success'
                                    : row.state === 'disabled'
                                      ? 'status-danger'
                                      : 'status-warning'
                                }
                              >
                                {labels[row.state]}
                              </Badge>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">
                              {row.credentialKind === 'sso-only'
                                ? 'Tài khoản SSO'
                                : 'Giữ lịch sử cũ'}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="outline"
                                disabled={row.accountId === accountId}
                                aria-label={'Cấu hình ' + row.name}
                                onClick={(event) => choose({ mapping: row }, event.currentTarget)}
                              >
                                <Settings2 aria-hidden="true" />
                                Cấu hình
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="py-12 text-center text-muted-foreground"
                          >
                            Chưa có học viên được liên kết. Thêm học viên từ danh mục AIO.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                <div className="mt-4 grid grid-cols-2 items-center gap-2 sm:flex sm:justify-between">
                  <Button
                    variant="outline"
                    disabled={!cursors.length}
                    onClick={() => setCursors((v) => v.slice(0, -1))}
                  >
                    <ChevronLeft aria-hidden="true" />
                    Trang trước
                  </Button>
                  <span className="col-span-2 row-start-1 text-center text-xs text-muted-foreground">
                    {data.items.length} hồ sơ trên trang
                  </span>
                  <Button
                    variant="outline"
                    disabled={!data.nextCursor}
                    onClick={() => setCursors((v) => [...v, data.nextCursor!])}
                  >
                    Trang sau
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </div>
              </>
            )
          )}
        </CardContent>
      </Card>
      <Dialog open={discover} onOpenChange={setDiscover}>
        <DialogContent
          className="sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            if (selection) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Thêm học viên từ AIO</DialogTitle>
            <DialogDescription>
              Chọn nhân sự đang công tác và đã được cấp quyền truy cập LMS. Nếu chưa có trong danh
              sách, hãy kiểm tra hồ sơ và quyền tại Portal.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(search.trim());
              setCandidateCursors([]);
            }}
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="learner-search">Tên nhân sự</Label>
              <Input
                id="learner-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Nhập tên để tìm"
                maxLength={160}
              />
            </div>
            <Button type="submit" disabled={searchBusy}>
              <Search aria-hidden="true" />
              Tìm kiếm
            </Button>
          </form>
          {!!dialogError && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(dialogError)}</AlertDescription>
            </Alert>
          )}
          {searchBusy ? (
            <p role="status" className="py-8 text-center">
              Đang tìm trong AIO…
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-lg border">
              {candidates?.items.length ? (
                candidates.items.map((person) => (
                  <div
                    key={person.accountId}
                    className="flex flex-wrap items-center justify-between gap-3 border-b p-4 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{person.displayName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {person.units
                          .map(
                            (u) =>
                              u.name +
                              (u.employeeCodes.length ? ' · ' + u.employeeCodes.join(', ') : ''),
                          )
                          .join(' / ')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      disabled={person.alreadyLinked || person.accountId === accountId}
                      onClick={(event) => choose({ candidate: person }, event.currentTarget)}
                      aria-label={'Chọn ' + person.displayName}
                    >
                      {person.alreadyLinked ? 'Đã liên kết' : 'Chọn học viên'}
                    </Button>
                  </div>
                ))
              ) : (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  Không có nhân sự phù hợp trong phạm vi được cấp.
                </p>
              )}
            </div>
          )}
          <DialogFooter className="sm:justify-between">
            <Button
              variant="outline"
              disabled={!candidateCursors.length || searchBusy}
              onClick={() => setCandidateCursors((v) => v.slice(0, -1))}
            >
              Kết quả trước
            </Button>
            <Button
              variant="outline"
              disabled={!candidates?.nextCursor || searchBusy}
              onClick={() => setCandidateCursors((v) => [...v, candidates!.nextCursor!])}
            >
              Kết quả sau
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selection}
        onOpenChange={(open) => {
          if (!open && !saving) setSelection(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
            else addTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {selection?.candidate ? 'Thêm học viên' : 'Cấu hình học viên'}
            </DialogTitle>
            <DialogDescription>
              {selection?.candidate?.displayName ?? selection?.mapping?.name} · Xác nhận thao tác để
              cập nhật liên kết học tập.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {selection?.mapping && (
              <div className="space-y-2">
                <Label htmlFor="learner-action">Thao tác</Label>
                <Select
                  value={action}
                  onValueChange={(v) => {
                    setAction(v as LearnerAction);
                    setUnit(selection.mapping!.orgUnitId);
                  }}
                >
                  <SelectTrigger id="learner-action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disable">Khóa học viên tại LMS</SelectItem>
                    <SelectItem value="enable">Mở lại học viên</SelectItem>
                    <SelectItem value="reconcile">Đối soát đơn vị học tập</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {action === 'provision' || action === 'reconcile' ? (
              <div className="space-y-2">
                <Label htmlFor="learner-unit">Đơn vị học tập</Label>
                <Select value={unit} onValueChange={setUnit}>
                  <SelectTrigger id="learner-unit">
                    <SelectValue placeholder="Chọn đơn vị đang công tác" />
                  </SelectTrigger>
                  <SelectContent>
                    {unitChoices.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!unitChoices.length && (
                  <p className="text-sm text-destructive">
                    Chưa có đơn vị AIO hợp lệ. Cập nhật công tác tại Portal trước khi tiếp tục.
                  </p>
                )}
              </div>
            ) : (
              <p className="rounded-lg bg-muted p-3 text-sm">{selection?.mapping?.unitName}</p>
            )}
            <p className="text-sm text-muted-foreground">
              {action === 'provision'
                ? 'Tạo hồ sơ học viên mới, dùng tài khoản SSO đã chọn.'
                : action === 'disable'
                  ? 'Phiên LMS đang mở sẽ kết thúc. Khóa học, bài làm và chứng nhận vẫn được giữ.'
                  : action === 'enable'
                    ? 'Chỉ mở khi định danh, đơn vị và quyền AIO còn hợp lệ. Học viên cần đăng nhập lại.'
                    : 'Đối soát với đơn vị công tác hiện hành trên AIO. Giữ nguyên lịch sử; học viên cần đăng nhập lại.'}
            </p>
            <div className="space-y-2">
              <Label htmlFor="learner-reason">Lý do thay đổi</Label>
              <Textarea
                id="learner-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                minLength={5}
                maxLength={300}
                required
                placeholder="Ghi rõ lý do để lưu lịch sử quản trị"
              />
            </div>
            {!!dialogError && (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage(dialogError)}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setSelection(null)}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                variant={action === 'disable' ? 'destructive' : 'default'}
                disabled={
                  saving ||
                  reason.trim().length < 5 ||
                  !unit ||
                  ((action === 'provision' || action === 'reconcile') &&
                    !unitChoices.some((u) => u.id === unit))
                }
              >
                {saving ? 'Đang lưu…' : actions[action]}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
