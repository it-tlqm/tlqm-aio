import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Users, CheckCircle2, Clock3, ChartColumn, Eye } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { CopyRouteButton } from '@/components/copy-route-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type {
  GradebookPage,
  ReportFilters,
  ReportCell,
  ReportLearner,
  ReportCourse,
} from '../../../src/lms/report-contracts';
import { lmsReportHash, parseLmsReportRoute } from '@/lib/lms-report-route';
const stateLabel = {
  unassigned: 'Không phân công',
  'not-started': 'Chưa học',
  learning: 'Đang học',
  failed: 'Chưa đạt',
  passed: 'Đạt',
};
const params = (filters: ReportFilters) =>
  new URLSearchParams(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  );
function ResultBadge({ cell }: { cell: ReportCell }) {
  return cell.assigned ? (
    <Badge
      variant="outline"
      className={
        cell.state === 'passed'
          ? 'status-success'
          : cell.state === 'failed'
            ? 'status-danger'
            : 'status-warning'
      }
    >
      {cell.bestScore === null ? stateLabel[cell.state] : cell.bestScore + '/100'}
      {cell.overdue ? ' · Quá hạn' : ''}
    </Badge>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}
export function ReportsPanel({
  csrfToken,
  onAccessError,
}: {
  csrfToken: string;
  onAccessError: (error: unknown) => void;
}) {
  const initialRoute = parseLmsReportRoute(location.hash);
  const [filters, setFilters] = useState<ReportFilters>(
      initialRoute?.filters ?? { page: 1, status: 'all' },
    ),
    [search, setSearch] = useState(initialRoute?.search ?? ''),
    [data, setData] = useState<GradebookPage | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState<unknown>(null),
    [generation, setGeneration] = useState(0),
    [exporting, setExporting] = useState(false),
    [detailId, setDetailId] = useState<string | null>(null),
    [detail, setDetail] = useState<{ learner: ReportLearner; courses: ReportCourse[] } | null>(
      null,
    ),
    [detailError, setDetailError] = useState<unknown>(null);
  const exportAttempt = useRef<{ body: string; key: string } | null>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const update = () => {
      const route = parseLmsReportRoute(location.hash);
      if (!route) return;
      setFilters(route.filters);
      setSearch(route.search);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const next = lmsReportHash({ filters, search: filters.search ?? '' });
    if (location.hash !== next) window.history.replaceState(null, '', next);
  }, [filters]);
  const fail = (error: unknown) => {
    setError(error);
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      setData(null);
      setDetail(null);
      setDetailId(null);
      onAccessError(error);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setData(null);
    setError(null);
    void api<GradebookPage>('/api/lms/report?' + params(filters), { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted) fail(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [filters, generation]);
  useEffect(() => {
    if (!detailId) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    void api<{ learner: ReportLearner; courses: ReportCourse[] }>(
      '/api/lms/report-learner?' +
        params({ ...filters, page: 1 }) +
        '&employeeId=' +
        encodeURIComponent(detailId),
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setDetailError(error);
          if (error instanceof ApiError && error.status === 404) {
            setData(null);
            setGeneration((value) => value + 1);
          }
          if (error instanceof ApiError && [401, 403].includes(error.status)) fail(error);
        }
      });
    return () => controller.abort();
  }, [detailId, filters]);
  function change(key: 'orgUnitId' | 'courseId' | 'status', value: string) {
    setFilters((current) => {
      const next = { ...current, page: 1 };
      if (key === 'status') next.status = value as ReportFilters['status'];
      else if (value === '_all') delete next[key];
      else next[key] = value;
      if (key === 'orgUnitId') delete next.courseId;
      return next;
    });
  }
  async function exportFile() {
    setExporting(true);
    setError(null);
    try {
      const body = JSON.stringify({
        filters: { ...filters, page: 1 },
        reason: 'Xuất báo cáo đào tạo trong phạm vi hiện hành',
      });
      if (exportAttempt.current?.body !== body)
        exportAttempt.current = { body, key: crypto.randomUUID() };
      const response = await fetch('/api/lms/report-export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'idempotency-key': exportAttempt.current.key,
        },
        body,
      });
      if (!response.ok) {
        const problem = await response.json();
        if (problem.error === 'LMS_REPORT_CHANGED') exportAttempt.current = null;
        throw new ApiError(response.status, problem.error ?? 'REQUEST_FAILED');
      }
      const url = URL.createObjectURL(await response.blob()),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'TLQM-bao-cao-dao-tao.xlsx';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      exportAttempt.current = null;
    } catch (error) {
      fail(error);
    } finally {
      setExporting(false);
    }
  }
  const metrics = data
    ? [
        {
          label: 'Học viên trong bộ lọc',
          value: data.summary.learners,
          icon: Users,
          detail: data.summary.notRequired + ' người không có môn bắt buộc',
        },
        {
          label: 'Hoàn thành yêu cầu',
          value: data.summary.completed,
          icon: CheckCircle2,
          detail:
            data.summary.completionRate === null
              ? 'Không có môn bắt buộc trong bộ lọc'
              : data.summary.completionRate +
                '% trên ' +
                data.summary.withRequired +
                ' người có yêu cầu',
        },
        {
          label: 'Chưa hoàn thành',
          value: data.summary.pending,
          icon: Clock3,
          detail: data.summary.overdue + ' lượt học bắt buộc quá hạn',
        },
        {
          label: 'Điểm tốt nhất trung bình',
          value: data.summary.averageBestScore ?? '—',
          icon: ChartColumn,
          detail: data.summary.attempts + ' lượt thi trong phiên bản hiện hành',
        },
      ]
    : [];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Bảng điểm & báo cáo</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Theo phiên bản đang phát hành và phân công hiện hành. Điểm phiên bản cũ được giữ trong
            lịch sử; thống kê dưới đây theo bộ lọc đang chọn.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyRouteButton />
          <Button
            variant="outline"
            disabled={busy || exporting}
            onClick={() => setGeneration((value) => value + 1)}
          >
            <RefreshCw />
            Tải lại báo cáo
          </Button>
          <Button disabled={busy || exporting || !data} onClick={() => void exportFile()}>
            <Download />
            Xuất báo cáo Excel
          </Button>
        </div>
      </div>
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <form
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              setFilters((current) => ({ ...current, search: search.trim(), page: 1 }));
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="report-search">Tìm học viên hoặc mã</Label>
              <Input
                id="report-search"
                value={search}
                maxLength={160}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-unit">Đơn vị AIO</Label>
              <Select
                value={filters.orgUnitId ?? '_all'}
                onValueChange={(value) => change('orgUnitId', value)}
                disabled={busy}
              >
                <SelectTrigger id="report-unit" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all">Toàn bộ phạm vi được cấp</SelectItem>
                  {data?.units.map((unit) => (
                    <SelectItem value={unit.id} key={unit.id}>
                      {unit.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-course">Khóa học</Label>
              <Select
                value={filters.courseId ?? '_all'}
                onValueChange={(value) => change('courseId', value)}
                disabled={busy}
              >
                <SelectTrigger id="report-course" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all">Tất cả khóa được phân</SelectItem>
                  {data?.courseOptions.map((course) => (
                    <SelectItem value={course.id} key={course.id}>
                      {course.title} · v{course.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-status">Trạng thái học tập</Label>
              <Select
                value={filters.status ?? 'all'}
                onValueChange={(value) => change('status', value)}
                disabled={busy}
              >
                <SelectTrigger id="report-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả</SelectItem>
                  <SelectItem value="completed">Hoàn thành yêu cầu</SelectItem>
                  <SelectItem value="pending">Chưa hoàn thành</SelectItem>
                  <SelectItem value="not-started">Chưa bắt đầu</SelectItem>
                  <SelectItem value="not-required">Không có môn bắt buộc</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" type="submit" className="self-end" disabled={busy}>
              Tìm kiếm
            </Button>
            <Button
              variant="ghost"
              type="button"
              className="self-end"
              disabled={
                !search &&
                !filters.orgUnitId &&
                !filters.courseId &&
                !filters.mandatoryOnly &&
                (!filters.status || filters.status === 'all') &&
                (filters.page ?? 1) === 1
              }
              onClick={() => {
                setSearch('');
                setFilters({ page: 1, status: 'all' });
              }}
            >
              Xóa bộ lọc
            </Button>
          </form>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={!!filters.mandatoryOnly}
              disabled={busy}
              onCheckedChange={(value) =>
                setFilters((current) => {
                  const next = { ...current, mandatoryOnly: value === true, page: 1 };
                  delete next.courseId;
                  return next;
                })
              }
              aria-label="Chỉ môn bắt buộc"
            />
            Chỉ môn bắt buộc
          </label>
        </CardContent>
      </Card>
      {busy && <p role="status">Đang đối chiếu nhân sự và tính bảng điểm…</p>}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {metrics.map((metric) => (
              <Card key={metric.label}>
                <CardContent className="space-y-3 pt-5">
                  <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                    <span>{metric.label}</span>
                    <metric.icon className="size-5 text-primary" aria-hidden="true" />
                  </div>
                  <p className="text-3xl font-semibold text-[var(--brand-navy)]">{metric.value}</p>
                  <p className="text-xs text-muted-foreground">{metric.detail}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>
                Gradebook theo học viên
              </CardTitle>
              <CardDescription>
                Mỗi ô là điểm tốt nhất của phiên bản đang phát hành. Dấu — là khóa chưa được phân
                cho đơn vị của học viên. Không có môn bắt buộc không được tính thành hoàn thành
                100%.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {data.items.length ? (
                <Table
                  containerProps={{
                    tabIndex: 0,
                    role: 'region',
                    'aria-label': 'Bảng điểm học viên',
                  }}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>Học viên</TableHead>
                      <TableHead>Đơn vị</TableHead>
                      <TableHead>Yêu cầu</TableHead>
                      <TableHead>Chi tiết</TableHead>
                      {data.courses.map((course) => (
                        <TableHead key={course.id} className="min-w-44 max-w-56 whitespace-normal">
                          {course.title}
                          <span className="mt-1 block text-xs font-normal">
                            v{course.version} · {course.mandatory ? 'Bắt buộc' : 'Tự chọn'}
                          </span>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((row) => (
                      <TableRow key={row.employeeId}>
                        <TableCell className="min-w-44 whitespace-normal">
                          <p className="font-medium">{row.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{row.code}</p>
                        </TableCell>
                        <TableCell className="min-w-32 whitespace-normal">{row.unitName}</TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={
                              row.status === 'completed'
                                ? 'status-success'
                                : row.status === 'pending'
                                  ? 'status-warning'
                                  : 'status-info'
                            }
                          >
                            {row.required
                              ? row.passedRequired + '/' + row.required + ' môn'
                              : 'Không yêu cầu'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            onClick={(event) => {
                              trigger.current = event.currentTarget;
                              setDetailId(row.employeeId);
                            }}
                          >
                            <Eye aria-hidden="true" />
                            Chi tiết
                          </Button>
                        </TableCell>
                        {row.cells.map((cell) => (
                          <TableCell key={cell.courseId}>
                            <ResultBadge cell={cell} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  Không có học viên phù hợp trong phạm vi hiện hành.
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <p>
                  {data.total} học viên · Trang {data.page}/
                  {Math.max(1, Math.ceil(data.total / data.pageSize))}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || data.page <= 1}
                    onClick={() => setFilters((current) => ({ ...current, page: data.page - 1 }))}
                  >
                    Trang trước
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || data.page * data.pageSize >= data.total}
                    onClick={() => setFilters((current) => ({ ...current, page: data.page + 1 }))}
                  >
                    Trang sau
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>
                Tổng hợp theo đơn vị
              </CardTitle>
              <CardDescription>
                Chỉ nhân sự có mapping hợp lệ, grant và quan hệ công tác đang hoạt động.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table
                containerProps={{
                  tabIndex: 0,
                  role: 'region',
                  'aria-label': 'Tổng hợp đào tạo theo đơn vị',
                }}
              >
                <TableHeader>
                  <TableRow>
                    <TableHead>Đơn vị</TableHead>
                    <TableHead>Học viên</TableHead>
                    <TableHead>Có yêu cầu</TableHead>
                    <TableHead>Hoàn thành</TableHead>
                    <TableHead>Tỷ lệ</TableHead>
                    <TableHead>Điểm TB</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byUnit.map((unit) => (
                    <TableRow key={unit.id}>
                      <TableCell className="font-medium">{unit.name}</TableCell>
                      <TableCell>{unit.learners}</TableCell>
                      <TableCell>{unit.withRequired}</TableCell>
                      <TableCell>{unit.completed}</TableCell>
                      <TableCell>
                        {unit.completionRate === null
                          ? 'Không có yêu cầu'
                          : unit.completionRate + '%'}
                      </TableCell>
                      <TableCell>{unit.averageBestScore ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
      <Dialog
        open={!!detailId}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null);
            setDetail(null);
          }
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-5xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Chi tiết học tập</DialogTitle>
            <DialogDescription>
              {detail
                ? detail.learner.name +
                  ' · ' +
                  detail.learner.code +
                  ' · ' +
                  detail.learner.unitName
                : 'Đang kiểm tra quyền và tải dữ liệu…'}
            </DialogDescription>
          </DialogHeader>
          {Boolean(detailError) && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(detailError)}</AlertDescription>
            </Alert>
          )}
          {detail && (
            <Table
              containerProps={{
                tabIndex: 0,
                role: 'region',
                'aria-label': 'Chi tiết điểm và tiến độ',
              }}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>Khóa học</TableHead>
                  <TableHead>Kết quả</TableHead>
                  <TableHead>Đã xem</TableHead>
                  <TableHead>Lượt thi</TableHead>
                  <TableHead>Nộp gần nhất</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.learner.cells
                  .filter((cell) => cell.assigned)
                  .map((cell) => {
                    const course = detail.courses.find((course) => course.id === cell.courseId)!;
                    return (
                      <TableRow key={cell.courseId}>
                        <TableCell className="min-w-48 whitespace-normal">
                          <p className="font-medium">{course.title}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            v{course.version} · {course.mandatory ? 'Bắt buộc' : 'Tự chọn'}
                            {course.deadline ? ' · Hạn ' + course.deadline : ''}
                          </p>
                        </TableCell>
                        <TableCell>
                          <ResultBadge cell={cell} />
                        </TableCell>
                        <TableCell>
                          {cell.watchedPct}%
                          <p className="mt-1 text-xs text-muted-foreground">
                            {course.tracking === 'self-confirmed'
                              ? 'Tự xác nhận'
                              : 'Trình phát ghi nhận'}
                          </p>
                        </TableCell>
                        <TableCell>{cell.attempts}</TableCell>
                        <TableCell>
                          {cell.lastAttemptAt
                            ? new Date(cell.lastAttemptAt).toLocaleString('vi-VN')
                            : 'Chưa nộp'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
