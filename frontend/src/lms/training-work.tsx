import { useEffect, useState, useId } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCourseCommands } from './course-api';
import { normalized } from './common';
import { parseWorkCenterRoute, updateWorkCenterRoute } from '@/lib/work-center-route';
type Feed = {
  items: {
    id: string;
    title: string;
    pathTitle: string;
    startsAt: number;
    dueAt: number;
    progress: number;
    remainingCourses: number;
    overdue: boolean;
    needsReview: boolean;
  }[];
  notices: {
    id: string;
    batchId: string;
    title: string;
    kind: string;
    createdAt: number;
    readAt: number | null;
    revision: number;
  }[];
  source?: { baseUrl: string };
};
const date = (n: number) => new Date(n).toLocaleString('vi-VN'),
  names: Record<string, string> = {
    assigned: 'Đợt đào tạo mới',
    rescheduled: 'Lịch đào tạo cập nhật',
    due_soon: 'Sắp đến hạn học',
    overdue: 'Đã quá hạn học',
  };
export function TrainingWorkPanel({
  endpoint = '/api/lms/training-work',
  csrfToken = '',
  portal = false,
  onAccessError,
}: {
  endpoint?: string;
  csrfToken?: string;
  portal?: boolean;
  onAccessError?: (e: unknown) => void;
}) {
  const initialRoute = parseWorkCenterRoute(location.hash);
  const [data, setData] = useState<Feed | null>(null),
    [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0),
    [view, setView] = useState<'work' | 'notices'>(initialRoute.trainingView),
    [search, setSearch] = useState(initialRoute.trainingSearch),
    [page, setPage] = useState(initialRoute.trainingPage);
  const command = useCourseCommands(csrfToken, '/api/lms/training-commands');
  const searchId = useId();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError(null);
    void api<Feed>(endpoint, { signal: controller.signal })
      .then((r) => {
        if (!controller.signal.aborted) setData(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e);
          if (e instanceof ApiError && [401, 403].includes(e.status)) onAccessError?.(e);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, version]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) setVersion((v) => v + 1);
    }, 60000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const update = () => {
      const route = parseWorkCenterRoute(location.hash);
      setView(route.trainingView);
      setSearch(route.trainingSearch);
      setPage(route.trainingPage);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const next = updateWorkCenterRoute(location.hash, {
      trainingView: view,
      trainingSearch: search,
      trainingPage: page,
    });
    if (next !== location.hash) window.history.replaceState(null, '', next);
  }, [view, search, page]);
  const work = (data?.items ?? []).filter((i) =>
      normalized(i.title + ' ' + i.pathTitle).includes(normalized(search)),
    ),
    notices = (data?.notices ?? []).filter((n) => normalized(n.title).includes(normalized(search))),
    total = view === 'work' ? work.length : notices.length,
    currentPage = Math.min(page, Math.max(0, Math.ceil(total / 10) - 1)),
    href = (id: string) => (data?.source?.baseUrl ?? '') + '/#training-batch/' + id;
  async function mark(n: Feed['notices'][number]) {
    setBusy(true);
    setError(null);
    try {
      await command('mark-notice', {
        id: n.id,
        read: n.readAt === null,
        expectedRevision: n.revision,
      });
      setVersion((v) => v + 1);
    } catch (e) {
      setData(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-5" aria-label="Công việc đào tạo">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-secondary-foreground">Việc học & nhắc hạn</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Các đợt chưa hoàn thành và thông báo trong phạm vi của bạn.
          </p>
        </div>
        <Button variant="outline" disabled={busy} onClick={() => setVersion((v) => v + 1)}>
          Tải lại việc học
        </Button>
      </div>
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <div role="status" aria-label="Đang tải việc học">
          <Skeleton className="h-64" />
        </div>
      ) : (
        data && (
          <>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {[
                ['Đợt cần học', data.items.length],
                ['Quá hạn', data.items.filter((i) => i.overdue).length],
                ['Chưa bắt đầu', data.items.filter((i) => i.startsAt > Date.now()).length],
                ['Thông báo chưa đọc', data.notices.filter((n) => n.readAt === null).length],
              ].map(([name, n]) => (
                <Card key={name}>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">{name}</p>
                    <p className="mt-2 text-2xl font-semibold text-secondary-foreground">{n}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <Tabs
              value={view}
              onValueChange={(v) => {
                setView(v as 'work' | 'notices');
                setPage(0);
              }}
            >
              <TabsList className="w-fit max-w-full">
                <TabsTrigger value="work">Đợt cần học</TabsTrigger>
                <TabsTrigger value="notices">Thông báo đào tạo</TabsTrigger>
              </TabsList>
              <TabsContent value={view} className="space-y-4 pt-3">
                <div className="space-y-2 sm:max-w-md">
                  <Label htmlFor={searchId}>Tìm việc học</Label>
                  <Input
                    id={searchId}
                    aria-label="Tìm việc học"
                    placeholder="Tên đợt hoặc lộ trình…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(0);
                    }}
                    className="w-full"
                  />
                </div>
                {view === 'work'
                  ? work.slice(currentPage * 10, currentPage * 10 + 10).map((i) => (
                      <Card key={i.id}>
                        <CardHeader>
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <CardTitle>{i.title}</CardTitle>
                            <Badge
                              variant="outline"
                              className={
                                i.overdue ? 'status-danger' : i.needsReview ? 'status-warning' : ''
                              }
                            >
                              {i.overdue
                                ? 'Quá hạn'
                                : i.needsReview
                                  ? 'Cần đối soát'
                                  : i.startsAt > Date.now()
                                    ? 'Chưa bắt đầu'
                                    : i.progress + '% hoàn thành'}
                            </Badge>
                          </div>
                          <CardDescription>{i.pathTitle}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <p className="text-sm">
                            Còn {i.remainingCourses} khóa cần đạt · Hạn {date(i.dueAt)}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Bắt đầu {date(i.startsAt)}
                          </p>
                          <Button asChild variant="outline">
                            <a href={href(i.id)}>Mở đợt đào tạo</a>
                          </Button>
                        </CardContent>
                      </Card>
                    ))
                  : notices.slice(currentPage * 10, currentPage * 10 + 10).map((n) => (
                      <Card key={n.id}>
                        <CardHeader>
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <CardTitle>{names[n.kind] ?? n.kind}</CardTitle>
                            <Badge variant="secondary">{n.readAt ? 'Đã đọc' : 'Chưa đọc'}</Badge>
                          </div>
                          <CardDescription>{date(n.createdAt)}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <p className="font-medium">{n.title}</p>
                          <div className="flex flex-wrap gap-2">
                            <Button asChild variant="outline">
                              <a href={href(n.batchId)}>Mở đợt đào tạo</a>
                            </Button>
                            {!portal && (
                              <Button variant="ghost" disabled={busy} onClick={() => void mark(n)}>
                                {n.readAt ? 'Đánh dấu chưa đọc' : 'Đánh dấu đã đọc'}
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                {!total && (
                  <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
                    {search
                      ? 'Không có kết quả phù hợp.'
                      : view === 'work'
                        ? 'Bạn không có đợt đào tạo cần hoàn thành.'
                        : 'Chưa có thông báo đào tạo đang hiệu lực.'}
                  </p>
                )}
                {total > 10 && (
                  <nav
                    aria-label="Phân trang việc học"
                    className="flex flex-wrap items-center gap-3"
                  >
                    <Button
                      variant="outline"
                      disabled={!currentPage}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      Trang trước
                    </Button>
                    <span className="text-sm">
                      {total} kết quả · Trang {currentPage + 1}/{Math.ceil(total / 10)}
                    </span>
                    <Button
                      variant="outline"
                      disabled={(currentPage + 1) * 10 >= total}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      Trang sau
                    </Button>
                  </nav>
                )}
                {portal && view === 'notices' && (
                  <p className="text-sm text-muted-foreground">
                    Mở Đào tạo để xử lý thông báo và cập nhật trạng thái đã đọc.
                  </p>
                )}
              </TabsContent>
            </Tabs>
          </>
        )
      )}
    </section>
  );
}
