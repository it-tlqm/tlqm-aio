import { useEffect, useState } from 'react';
import { TrainingWorkPanel } from '../lms/training-work';
import { TaskWorkPanel } from './task-work';
import { FormWorkPanel } from './form-work';
import { Bell, BriefcaseBusiness, RefreshCw, ArrowUpRight, CheckCheck, Clock3 } from 'lucide-react';
import { api } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { CopyRouteButton } from '@/components/copy-route-button';
import {
  parseWorkCenterRoute,
  updateWorkCenterRoute,
  type WorkCenterTab,
} from '@/lib/work-center-route';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
type Item = {
  id: string;
  taskId?: string | null;
  title: string;
  workflowName: string;
  status: string;
  unitId: string;
  task: string | null;
  kind: string | null;
  assigneeName: string | null;
  dueAt: string | null;
  waitingSince: string;
  overdue: boolean;
  route: string;
};
type Group = {
  id: string;
  name: string | null;
  count: number;
  overdue: number;
  oldestWaitingAt: string;
};
type Work = {
  items: Item[];
  page: number;
  total: number;
  canManage: boolean;
  canConfigure: boolean;
  summary: { assigned: number; requested: number; returned: number; overdue: number };
  source: { baseUrl: string };
  units: { id: string; name: string }[];
  assignees: { id: string; name: string }[];
  groups: { units: Group[]; assignees: Group[] } | null;
};
type Notice = {
  id: string;
  title: string;
  kind: string;
  readAt: string | null;
  revision: number;
  createdAt: string;
  route: string;
};
type Notices = {
  items: Notice[];
  page: number;
  total: number;
  unreadCount: number;
  source: { baseUrl: string };
};
type Policy = {
  org_unit_id: string;
  enabled: boolean;
  before_minutes: number;
  overdue_minutes: number;
  revision: number;
};
type Policies = {
  items: Policy[];
  units: { id: string; name: string }[];
  worker: {
    last_completed_at: string | null;
    last_error_code: string | null;
    delivered: number;
  } | null;
};
const status: Record<string, string> = {
  running: 'Đang xử lý',
  needs_revision: 'Cần bổ sung',
  completed: 'Hoàn thành',
  rejected: 'Từ chối',
  cancelled: 'Đã hủy',
};
const noticeNames: Record<string, string> = {
  assigned: 'Bạn có nhiệm vụ mới',
  approved: 'Một bước đã được duyệt',
  returned: 'Đề nghị cần bổ sung',
  completed: 'Đề nghị đã hoàn thành',
  rejected: 'Đề nghị bị từ chối',
  cancelled: 'Đề nghị đã hủy',
  due_soon: 'Công việc sắp đến hạn',
  mentioned: 'Bạn được nhắc tên trong hồ sơ',
  overdue: 'Công việc đã quá hạn',
};
const date = (value: string | null) => (value ? new Date(value).toLocaleString('vi-VN') : '—');
const waiting = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes >= 1440
    ? Math.floor(minutes / 1440) + ' ngày'
    : minutes >= 60
      ? Math.floor(minutes / 60) + ' giờ'
      : minutes + ' phút';
};
function Choice({
  name,
  value,
  items,
  onChange,
}: {
  name: string;
  value: string;
  items: { id: string; name: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value || '_all'} onValueChange={(v) => onChange(v === '_all' ? '' : v)}>
      <SelectTrigger aria-label={name} className="w-full sm:w-64">
        <SelectValue placeholder={name} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="_all">{name}</SelectItem>
        {items.map((i) => (
          <SelectItem key={i.id} value={i.id}>
            {i.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function WorkCenter({ me, tenantId }: { me: Me; tenantId: string }) {
  const [route, setRoute] = useState(() => parseWorkCenterRoute(location.hash));
  const [sources, setSources] = useState<{ code: string; name: string }[] | null>(null),
    [source, setSource] = useState(
      () => parseWorkCenterRoute(location.hash).source || 'aio-workflows',
    ),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const update = () => setRoute(parseWorkCenterRoute(location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSources(null);
    setError(null);
    void api<{ items: { code: string; name: string }[] }>(
      '/api/v1/work-center/sources?tenantId=' + tenantId,
      { signal: controller.signal },
    )
      .then((r) => {
        if (!controller.signal.aborted) {
          setSources(r.items);
          setSource((old) => {
            const preferred = route.source || old;
            const next = r.items.some((s) => s.code === preferred)
              ? preferred
              : (r.items[0]?.code ?? '');
            if (next !== route.source) {
              window.history.replaceState(
                null,
                '',
                updateWorkCenterRoute(location.hash, { source: next }),
              );
            }
            return next;
          });
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      });
    return () => controller.abort();
  }, [tenantId, me, route.source]);
  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{errorMessage(error)}</AlertDescription>
      </Alert>
    );
  if (sources === null)
    return (
      <div role="status" aria-label="Đang tải nguồn công việc">
        <Skeleton className="h-72" />
      </div>
    );
  return (
    <div className="space-y-5">
      {sources.length > 0 ? (
        <>
          <Select
            value={source}
            onValueChange={(value) => {
              setSource(value);
              window.history.replaceState(
                null,
                '',
                updateWorkCenterRoute(location.hash, { source: value }),
              );
            }}
          >
            <SelectTrigger aria-label="Nguồn công việc" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.map((s) => (
                <SelectItem key={s.code} value={s.code}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {source === 'aio-lms-sandbox' ? (
            <TrainingWorkPanel
              key={tenantId}
              endpoint={'/api/v1/work-center/training?tenantId=' + tenantId}
              portal
            />
          ) : source === 'aio-tasks' ? (
            <TaskWorkPanel key={tenantId} tenantId={tenantId} />
          ) : source === 'aio-forms' ? (
            <FormWorkPanel key={tenantId} tenantId={tenantId} />
          ) : (
            <WorkflowWorkCenter me={me} tenantId={tenantId} />
          )}
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Công việc & thông báo</CardTitle>
          </CardHeader>
          <CardContent>Chưa có nguồn công việc được cấp trong không gian này.</CardContent>
        </Card>
      )}
    </div>
  );
}
function WorkflowWorkCenter({ me, tenantId }: { me: Me; tenantId: string }) {
  const initialRoute = parseWorkCenterRoute(location.hash);
  const [tab, setTab] = useState<WorkCenterTab>(initialRoute.tab),
    [page, setPage] = useState(initialRoute.page),
    [search, setSearch] = useState(initialRoute.search),
    [searchDraft, setSearchDraft] = useState(initialRoute.search),
    [unit, setUnit] = useState(initialRoute.unit),
    [assignee, setAssignee] = useState(initialRoute.assignee),
    [unread, setUnread] = useState(initialRoute.unread),
    [version, setVersion] = useState(0);
  const [work, setWork] = useState<Work | null>(null),
    [notices, setNotices] = useState<Notices | null>(null),
    [policies, setPolicies] = useState<Policies | null>(null),
    [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [policyUnit, setPolicyUnit] = useState(''),
    [enabled, setEnabled] = useState(false),
    [before, setBefore] = useState(60),
    [overdue, setOverdue] = useState(60),
    [reason, setReason] = useState('');
  useEffect(() => {
    const update = () => {
      const next = parseWorkCenterRoute(location.hash);
      setTab(next.tab);
      setPage(next.page);
      setSearch(next.search);
      setSearchDraft(next.search);
      setUnit(next.unit);
      setAssignee(next.assignee);
      setUnread(next.unread);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const next = updateWorkCenterRoute(location.hash, {
      tab,
      page,
      search,
      unit,
      assignee,
      unread,
    });
    if (next !== location.hash) window.history.replaceState(null, '', next);
  }, [tab, page, search, unit, assignee, unread]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !busy && tab !== 'settings')
        setVersion((v) => v + 1);
    }, 60000);
    return () => clearInterval(timer);
  }, [busy, tab]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setWork(null);
    setNotices(null);
    setPolicies(null);
    const params = new URLSearchParams({
      tenantId,
      page: String(page),
      ...(search ? { search } : {}),
      ...(unit ? { unitId: unit } : {}),
      ...(assignee ? { assigneeId: assignee } : {}),
    });
    let request: Promise<unknown>;
    if (tab === 'notifications')
      request = api<Notices>(
        '/api/v1/work-center/notifications?' +
          new URLSearchParams({ tenantId, page: String(page), unread: String(unread) }),
        { signal: controller.signal },
      ).then((r) => {
        if (!controller.signal.aborted) setNotices(r);
      });
    else if (tab === 'settings')
      request = api<Policies>('/api/v1/work-center/reminders?tenantId=' + tenantId, {
        signal: controller.signal,
      }).then((r) => {
        if (!controller.signal.aborted) {
          setPolicies(r);
          setPolicyUnit('');
          setReason('');
        }
      });
    else
      request = api<Work>('/api/v1/work-center/work?' + params + '&view=' + tab, {
        signal: controller.signal,
      }).then((r) => {
        if (!controller.signal.aborted) setWork(r);
      });
    request
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [me, tenantId, tab, page, search, unit, assignee, unread, version]);
  async function mutation(path: string, data: unknown) {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await api('/api/v1/work-center/' + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': me.csrfToken,
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ tenantId, ...(data as object) }),
      });
      setMessage('Đã lưu thay đổi.');
      setVersion((v) => v + 1);
    } catch (e) {
      setWork(null);
      setNotices(null);
      setPolicies(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function selectTab(value: string) {
    setTab(value as WorkCenterTab);
    setPage(0);
    setSearch('');
    setSearchDraft('');
    setUnit('');
    setAssignee('');
    setMessage('');
  }
  const current = work ?? notices,
    total = current?.total ?? 0,
    currentPage = current?.page ?? page;
  const source = work?.source ?? notices?.source;
  return (
    <section className="space-y-5" aria-label="Trung tâm công việc">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-secondary-foreground">
            Công việc & thông báo
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Theo dõi công việc của bạn và mở hồ sơ để xử lý. Nguồn hiện tại: Quy trình.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyRouteButton />
          <Button
            variant="outline"
            aria-label="Tải lại trung tâm công việc"
            disabled={busy}
            onClick={() => setVersion((v) => v + 1)}
          >
            <RefreshCw className="size-4" />
            Tải lại
          </Button>
        </div>
      </div>
      {work && (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {(tab === 'managed' && work.groups
            ? [
                ['Việc tồn', work.total],
                ['Quá hạn', work.groups.units.reduce((total, group) => total + group.overdue, 0)],
                ['Đơn vị', work.groups.units.length],
                ['Người xử lý', work.groups.assignees.length],
              ]
            : [
                ['Được giao', work.summary.assigned],
                ['Đã gửi', work.summary.requested],
                ['Cần bổ sung', work.summary.returned],
                ['Quá hạn', work.summary.overdue],
              ]
          ).map(([name, value]) => (
            <Card key={name}>
              <CardContent>
                <p className="text-sm text-muted-foreground">{name}</p>
                <p className="mt-2 text-2xl font-semibold text-secondary-foreground">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList className="h-auto flex-wrap w-fit max-w-full">
          <TabsTrigger value="assigned">
            <BriefcaseBusiness className="size-4" />
            Việc được giao
          </TabsTrigger>
          <TabsTrigger value="requested">Đề nghị đã gửi</TabsTrigger>
          <TabsTrigger value="returned">Cần bổ sung</TabsTrigger>
          <TabsTrigger value="overdue">Quá hạn</TabsTrigger>
          <TabsTrigger value="notifications">
            <Bell className="size-4" />
            Thông báo
          </TabsTrigger>
          <TabsTrigger value="managed">Theo dõi đơn vị</TabsTrigger>
          <TabsTrigger value="settings">Cấu hình nhắc hạn</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="mt-5 space-y-4">
          {message && (
            <Alert role="status" className="status-success">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
          {Boolean(error) && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          {loading ? (
            <div role="status" aria-label="Đang tải công việc">
              <Skeleton className="h-72" />
            </div>
          ) : (
            <>
              {work && (
                <>
                  <div className="flex flex-wrap gap-3">
                    <Input
                      aria-label="Tìm công việc"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          setSearch(searchDraft);
                          setPage(0);
                        }
                      }}
                      className="sm:max-w-sm"
                      placeholder="Tên đề nghị, quy trình hoặc nhiệm vụ…"
                      value={searchDraft}
                      onChange={(e) => {
                        setSearchDraft(e.target.value);
                        setPage(0);
                      }}
                    />
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearch(searchDraft);
                        setPage(0);
                      }}
                    >
                      Tìm kiếm
                    </Button>
                    <Choice
                      name="Tất cả đơn vị"

                      value={unit}
                      items={work.units}
                      onChange={(v) => {
                        setUnit(v);
                        setPage(0);
                      }}
                    />
                    {tab === 'managed' && (
                      <Choice
                        name="Tất cả người xử lý"
                        value={assignee}
                        items={work.assignees}
                        onChange={(v) => {
                          setAssignee(v);
                          setPage(0);
                        }}
                      />
                    )}
                    <Button
                      variant="ghost"
                      disabled={!searchDraft && !unit && !assignee && !unread}
                      onClick={() => {
                        setSearchDraft('');
                        setSearch('');
                        setUnit('');
                        setAssignee('');
                        setUnread(false);
                        setPage(0);
                      }}
                    >
                      Xóa bộ lọc
                    </Button>
                  </div>
                  {work.groups && (
                    <div className="grid gap-4 lg:grid-cols-2">
                      {[
                        ['Theo đơn vị', work.groups.units],
                        ['Theo người xử lý', work.groups.assignees],
                      ].map(([title, groups]) => (
                        <Card key={String(title)}>
                          <CardHeader>
                            <CardTitle role="heading" aria-level={3}>
                              {String(title)}
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {(groups as Group[]).length ? (
                              (groups as Group[]).map((g) => (
                                <div
                                  className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"
                                  key={g.id}
                                >
                                  <div className="text-sm">
                                    <p className="font-medium">
                                      {g.name ??
                                        work.units.find((u) => u.id === g.id)?.name ??
                                        'Đơn vị trong phạm vi'}
                                    </p>
                                    <p className="text-muted-foreground">
                                      Chờ lâu nhất: {waiting(g.oldestWaitingAt)}
                                    </p>
                                  </div>
                                  <Badge variant="secondary">
                                    {g.count} tồn · {g.overdue} quá hạn
                                  </Badge>
                                </div>
                              ))
                            ) : (
                              <p className="text-sm text-muted-foreground">
                                Không có việc tồn trong phạm vi.
                              </p>
                            )}
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                  <Card>
                    <CardContent>
                      <Table
                        containerProps={{
                          tabIndex: 0,
                          role: 'region',
                          'aria-label': 'Danh sách công việc',
                        }}
                        className="min-w-[850px]"
                      >
                        <TableHeader>
                          <TableRow>
                            <TableHead>Đề nghị / Nhiệm vụ</TableHead>
                            <TableHead>Đơn vị / Người xử lý</TableHead>
                            <TableHead>Trạng thái</TableHead>
                            <TableHead>Hạn / Thời gian chờ</TableHead>
                            <TableHead>Mở hồ sơ</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {work.items.length ? (
                            work.items.map((item) => (
                              <TableRow key={item.taskId ?? item.id}>
                                <TableCell className="max-w-xs whitespace-normal">
                                  <p className="font-medium">{item.title}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {item.workflowName}
                                    {item.task ? ' · ' + item.task : ''}
                                  </p>
                                </TableCell>
                                <TableCell>
                                  <p>
                                    {work.units.find((u) => u.id === item.unitId)?.name ??
                                      'Đơn vị trong phạm vi'}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {item.assigneeName ?? 'Chưa có nhiệm vụ đang chờ'}
                                  </p>
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    className={
                                      item.overdue
                                        ? 'status-danger'
                                        : item.status === 'needs_revision'
                                          ? 'status-warning'
                                          : 'status-info'
                                    }
                                  >
                                    {item.overdue
                                      ? 'Quá hạn'
                                      : (status[item.status] ?? item.status)}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <p className="text-sm">{date(item.dueAt)}</p>
                                  {['running', 'needs_revision'].includes(item.status) && (
                                    <p className="text-xs text-muted-foreground">
                                      Chờ {waiting(item.waitingSince)}
                                    </p>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <a
                                    className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm font-medium"
                                    href={source!.baseUrl + item.route}
                                  >
                                    Mở hồ sơ
                                    <ArrowUpRight className="size-4" />
                                  </a>
                                </TableCell>
                              </TableRow>
                            ))
                          ) : (
                            <TableRow>
                              <TableCell
                                colSpan={5}
                                className="py-10 text-center text-muted-foreground"
                              >
                                Không có công việc phù hợp.
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </>
              )}
              {notices && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={unread}
                        onCheckedChange={(v) => {
                          setUnread(v === true);
                          setPage(0);
                        }}
                      />
                      Chỉ hiện chưa đọc
                    </label>
                    <Badge variant="secondary">{notices.unreadCount} thông báo chưa đọc</Badge>
                  </div>
                  <div className="space-y-3">
                    {notices.items.length ? (
                      notices.items.map((n) => (
                        <Card key={n.id}>
                          <CardContent className="flex flex-wrap items-center justify-between gap-4">
                            <div className="min-w-0">
                              <p className="font-medium text-secondary-foreground">
                                <span>{noticeNames[n.kind] ?? n.kind}</span>
                                {!n.readAt && <Badge className="ml-2 status-info">Mới</Badge>}
                              </p>
                              <p className="mt-1 break-words text-sm">{n.title}</p>
                              <p className="mt-2 text-xs text-muted-foreground">
                                {date(n.createdAt)}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <a
                                className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
                                href={source!.baseUrl + n.route}
                              >
                                Mở hồ sơ
                              </a>
                              <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  void mutation('notifications', {
                                    id: n.id,
                                    read: !n.readAt,
                                    expectedRevision: n.revision,
                                    reason: n.readAt
                                      ? 'Đánh dấu thông báo chưa đọc'
                                      : 'Đánh dấu thông báo đã đọc',
                                  })
                                }
                              >
                                <CheckCheck className="size-4" />
                                {n.readAt ? 'Chưa đọc' : 'Đã đọc'}
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))
                    ) : (
                      <Card>
                        <CardContent className="py-8 text-center text-muted-foreground">
                          Không có thông báo phù hợp.
                        </CardContent>
                      </Card>
                    )}
                  </div>
                </>
              )}
              {policies && (
                <Card>
                  <CardHeader>
                    <CardTitle role="heading" aria-level={3}>
                      Nhắc hạn trong AIO
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                      Mỗi nhiệm vụ nhận tối đa một nhắc trước hạn và một nhắc quá hạn cho mỗi người
                      được giao. Thời lượng tính liên tục, kể cả ngày nghỉ.
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm flex items-center gap-2">
                      <Clock3 className="size-4" />
                      {policies.worker?.last_completed_at
                        ? (policies.worker.last_error_code ||
                          Date.now() - Date.parse(policies.worker.last_completed_at) > 90000
                            ? 'Cần kiểm tra tiến trình nhắc hạn · '
                            : 'Lần xử lý thành công · ') + date(policies.worker.last_completed_at)
                        : 'Chưa ghi nhận lần chạy; cần bật cấu hình và chạy tiến trình nhắc hạn.'}
                    </p>
                    <Choice
                      name="Chọn đơn vị cấu hình"
                      value={policyUnit}
                      items={policies.units}
                      onChange={(id) => {
                        setPolicyUnit(id);
                        const p = policies.items.find((p) => p.org_unit_id === id);
                        setEnabled(p?.enabled ?? false);
                        setBefore(p?.before_minutes ?? 60);
                        setOverdue(p?.overdue_minutes ?? 60);
                        setReason('');
                      }}
                    />
                    {policyUnit && (
                      <fieldset disabled={busy} className="space-y-4">
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={enabled}
                            onCheckedChange={(v) => setEnabled(v === true)}
                          />
                          Bật nhắc hạn cho đơn vị
                        </label>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="remind-before">Nhắc trước hạn (phút; 0 = tắt)</Label>
                            <Input
                              id="remind-before"
                              type="number"
                              min={0}
                              max={10080}
                              value={before}
                              onChange={(e) => setBefore(Number(e.target.value))}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="remind-after">Nhắc sau khi quá hạn (phút)</Label>
                            <Input
                              id="remind-after"
                              type="number"
                              min={1}
                              max={10080}
                              value={overdue}
                              onChange={(e) => setOverdue(Number(e.target.value))}
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="remind-reason">Lý do thay đổi</Label>
                          <Input
                            id="remind-reason"
                            value={reason}
                            maxLength={240}
                            onChange={(e) => setReason(e.target.value)}
                          />
                        </div>
                        <Button
                          disabled={busy || reason.trim().length < 5}
                          onClick={() =>
                            void mutation('reminders', {
                              unitId: policyUnit,
                              enabled,
                              beforeMinutes: before,
                              overdueMinutes: overdue,
                              expectedRevision:
                                policies.items.find((p) => p.org_unit_id === policyUnit)
                                  ?.revision ?? 0,
                              reason,
                            })
                          }
                        >
                          Lưu cấu hình nhắc hạn
                        </Button>
                      </fieldset>
                    )}
                  </CardContent>
                </Card>
              )}
              {current && (
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>
                    {total} kết quả · Trang {currentPage + 1}/{Math.max(1, Math.ceil(total / 25))}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      Trang trước
                    </Button>
                    <Button
                      variant="outline"
                      disabled={(currentPage + 1) * 25 >= total}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      Trang sau
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
