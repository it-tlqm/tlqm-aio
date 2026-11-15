import { TrainingPanel } from './training';
import { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  ArrowUpRight,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Users,
  LayoutDashboard,
  ClipboardCheck,
  Trophy,
} from 'lucide-react';
import { api, apiCollection, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Brand } from '@/components/brand';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { LearningDashboard } from './learning';
import { ReviewDashboard } from './review';
import { CourseManager } from './course-manager';
import { CourseCatalog, CourseHistory } from './course-catalog';
import { AchievementsPanel } from './achievements';
import { QuestionBankPanel } from './question-bank';
import { ReportsPanel } from './reports';
import { LearnersPanel } from './learners';
import { isLmsReportRoute } from '@/lib/lms-report-route';
import type { Learning, Review, ReviewRow, LmsMe } from './types';
const trainingTarget = () =>
  /^#training-batch\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
    location.hash,
  )?.[1] ?? null;
const reportTarget = () => isLmsReportRoute(location.hash);

export function LmsApp({
  me: initial,
  logout,
  portalUrl,
}: {
  me: Me;
  logout: () => Promise<void>;
  portalUrl: string | undefined;
}) {
  const [me, setMe] = useState(initial as LmsMe);
  const [view, setView] = useState(
    reportTarget() ? 'reports' : trainingTarget() ? 'training' : 'courses',
  );
  const [trainingBatch, setTrainingBatch] = useState<string | null>(trainingTarget);
  const [selectedTrainingCourse, setSelectedTrainingCourse] = useState<string | null>(null);
  const [courseDirty, setCourseDirty] = useState(false),
    [pendingNavigation, setPendingNavigation] = useState<{ view?: string; refresh?: true } | null>(
      null,
    );
  const [learning, setLearning] = useState<Learning | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);
  const load = useCallback(
    async (signal: AbortSignal) => {
      setBusy(true);
      setError(null);
      setLearning(null);
      setReview(null);
      try {
        const current = await api<LmsMe>('/api/v1/me', { signal });
        if (signal.aborted) return;
        setMe(current);
        if (view === 'learn') {
          const result = await api<Learning>('/api/learning', { signal });
          if (!signal.aborted) setLearning(result);
        } else if (view === 'review' || view === 'admin') {
          const result = await apiCollection<ReviewRow>(
            view === 'admin' ? '/api/admin' : '/api/review',
            {
              signal,
            },
          );
          if (!signal.aborted) setReview(result);
        }
      } catch (e) {
        if (!signal.aborted) setError(e);
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    },
    [view],
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, revision]);
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const title =
    view === 'training' || view === 'training-manage'
      ? 'Lộ trình và đợt đào tạo'
      : view === 'learners'
        ? 'Quản trị học viên'
        : view === 'achievements'
          ? 'Thành tích học tập'
          : view === 'courses'
            ? 'Khóa học của tôi'
            : view === 'reports'
              ? 'Theo dõi đào tạo'
              : view === 'bank'
                ? 'Ngân hàng câu hỏi'
                : view === 'results'
                  ? 'Kết quả học tập'
                  : view === 'manage'
                    ? 'Quản lý khóa học'
                    : view === 'review'
                      ? 'Lịch sử đơn vị'
                      : view === 'admin'
                        ? 'Theo dõi đào tạo'
                        : 'Học tập của tôi';
  const changeView = (value: string) => {
    if (value === view) return;
    if (courseDirty) {
      setPendingNavigation({ view: value });
      return;
    }
    if (value !== 'training' && trainingTarget()) {
      history.replaceState(null, '', location.pathname + location.search);
      setTrainingBatch(null);
    }
    if (value !== 'reports' && reportTarget())
      history.replaceState(null, '', location.pathname + location.search);
    setLearning(null);
    setReview(null);
    setBusy(true);
    setView(value);
  };
  useEffect(() => {
    const navigate = () => {
      const id = trainingTarget();
      if (id) {
        setTrainingBatch(id);
        changeView('training');
      } else if (reportTarget()) {
        changeView('reports');
      }
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, [view, courseDirty]);
  const refresh = () => {
    if (courseDirty) {
      setPendingNavigation({ refresh: true });
      return;
    }
    setLearning(null);
    setReview(null);
    setBusy(true);
    setRevision((value) => value + 1);
  };
  return (
    <div className="min-h-screen bg-background">
      <a
        href="#lms-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-card focus:p-3"
      >
        Đến nội dung chính
      </a>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-7">
          <Brand module="Đào tạo" />
          <nav aria-label="Tài khoản và ứng dụng" className="flex flex-wrap items-center gap-2">
            <span className="mr-2 hidden text-sm font-medium lg:inline">{me.displayName}</span>
            <Button variant="outline" asChild>
              <a href={portalUrl ?? 'http://127.0.0.1:4100/'}>
                Mở Portal
                <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
            <Button variant="ghost" onClick={() => void logout().catch(setLogoutError)}>
              <LogOut aria-hidden="true" />
              Đăng xuất SSO
            </Button>
          </nav>
        </div>
      </header>
      <main
        id="lms-main"
        tabIndex={-1}
        className="mx-auto max-w-[1440px] space-y-6 px-4 py-7 sm:px-7"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Không gian đào tạo · TLQM AIO
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {view === 'learn'
                ? 'Bài học, tiến độ và kết quả học tập của bạn.'
                : 'Nắm tiến độ học tập trong phạm vi được giao.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline" className="bg-card">
              Sandbox · Dữ liệu giả lập
            </Badge>
            <Button variant="outline" disabled={busy} onClick={refresh}>
              <RefreshCw aria-hidden="true" className={busy ? 'animate-spin' : ''} />
              Tải lại dữ liệu
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary font-semibold text-primary"
              aria-hidden="true"
            >
              {me.displayName.trim().slice(0, 1)}
            </span>
            <div className="min-w-0">
              <p className="font-medium">{me.displayName}</p>
              <p className="text-xs text-muted-foreground">
                {me.legacy.code} · {me.unit?.name || 'Chưa xác định đơn vị AIO'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-[var(--success)]">
              <ShieldCheck aria-hidden="true" className="size-4" />
              Đăng nhập qua AIO
            </span>
            <span className="text-muted-foreground">
              Hồ sơ: <span data-testid="legacy-id">{me.legacy.id}</span>
            </span>
          </div>
        </div>
        {Boolean(error || logoutError) && (
          <Alert variant="destructive">
            <AlertDescription>
              {errorMessage(error || logoutError)}
              {error instanceof ApiError && error.status === 401 && (
                <Button asChild variant="outline">
                  <a href="/auth/login">Đăng nhập lại</a>
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        <Tabs value={view} onValueChange={changeView}>
          <TabsList className="w-fit">
            <TabsTrigger value="courses">
              <BookOpen aria-hidden="true" />
              Khóa học
            </TabsTrigger>
            <TabsTrigger value="training">Đợt đào tạo của tôi</TabsTrigger>
            {(me.capabilities['lms:review'] || me.capabilities['lms:admin']) && (
              <TabsTrigger value="training-manage">Quản lý đào tạo</TabsTrigger>
            )}
            <TabsTrigger value="results">
              <ClipboardCheck aria-hidden="true" />
              Kết quả học tập
            </TabsTrigger>
            <TabsTrigger value="achievements">
              <Trophy aria-hidden="true" />
              Thành tích
            </TabsTrigger>
            <TabsTrigger value="learn">
              <BookOpen aria-hidden="true" />
              Lịch sử của tôi
            </TabsTrigger>
            {me.capabilities['lms:admin'] && (
              <TabsTrigger value="manage">
                <BookOpen aria-hidden="true" />
                Khóa học & nội dung
              </TabsTrigger>
            )}
            {me.capabilities['lms:admin'] && (
              <TabsTrigger value="bank">
                <BookOpen aria-hidden="true" />
                Ngân hàng câu hỏi
              </TabsTrigger>
            )}
            {(me.capabilities['lms:review'] || me.capabilities['lms:admin']) && (
              <TabsTrigger value="reports">
                <LayoutDashboard aria-hidden="true" />
                Bảng điểm & báo cáo
              </TabsTrigger>
            )}
            {me.capabilities['lms:admin'] &&
              me.permissions.some(
                (p) =>
                  p.permission === 'identity:provision' &&
                  p.orgUnitId === null &&
                  p.tenantId === me.unit?.tenantId,
              ) && (
                <TabsTrigger value="learners">
                  <Users aria-hidden="true" />
                  Học viên & tài khoản
                </TabsTrigger>
              )}
            {me.capabilities['lms:review'] && (
              <TabsTrigger value="review">
                <Users aria-hidden="true" />
                Lịch sử đơn vị
              </TabsTrigger>
            )}
            {me.capabilities['lms:admin'] && (
              <TabsTrigger value="admin">
                <LayoutDashboard aria-hidden="true" />
                Lịch sử quản trị
              </TabsTrigger>
            )}
          </TabsList>
          {busy && (
            <div role="status" aria-label="Đang tải dữ liệu học tập" className="space-y-5">
              <span className="sr-only">Đang kiểm tra quyền và tải dữ liệu học tập…</span>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-28 border" />
                ))}
              </div>
              <Skeleton className="h-72 border" />
            </div>
          )}
          <TabsContent value="learn">
            {!busy && learning && <LearningDashboard learning={learning} />}
          </TabsContent>
          <TabsContent value="courses">
            {!busy && !error && (
              <CourseCatalog
                key={revision}
                csrfToken={me.csrfToken}
                onAccessError={setError}
                onDirtyChange={setCourseDirty}
                initialVersionId={selectedTrainingCourse}
                onCourseClosed={() => setSelectedTrainingCourse(null)}
              />
            )}
          </TabsContent>
          {(['training', 'training-manage'] as const).map((tab) => (
            <TabsContent key={tab} value={tab}>
              {!busy &&
                !error &&
                (tab === 'training' ||
                  me.capabilities['lms:review'] ||
                  me.capabilities['lms:admin']) && (
                  <TrainingPanel
                    key={revision + ':' + (tab === 'training' ? (trainingBatch ?? '') : 'manage')}
                    csrfToken={me.csrfToken}
                    manage={tab === 'training-manage'}
                    canAdmin={!!me.capabilities['lms:admin']}
                    onAccessError={setError}
                    onDirtyChange={setCourseDirty}
                    initialBatchId={tab === 'training' ? trainingBatch : null}
                    onCloseBatch={() => {
                      setTrainingBatch(null);
                      if (trainingTarget())
                        history.replaceState(null, '', location.pathname + location.search);
                    }}
                    onOpenCourse={(id) => {
                      setSelectedTrainingCourse(id);
                      changeView('courses');
                    }}
                  />
                )}
            </TabsContent>
          ))}
          <TabsContent value="results">
            {!busy && !error && (
              <CourseHistory key={revision} csrfToken={me.csrfToken} onAccessError={setError} />
            )}
          </TabsContent>
          <TabsContent value="achievements">
            {!busy && !error && <AchievementsPanel key={revision} onAccessError={setError} />}
          </TabsContent>
          <TabsContent value="manage">
            {!busy && !error && me.capabilities['lms:admin'] && (
              <CourseManager
                key={revision}
                csrfToken={me.csrfToken}
                onAccessError={setError}
                onDirtyChange={setCourseDirty}
              />
            )}
          </TabsContent>
          <TabsContent value="bank">
            {!busy && !error && me.capabilities['lms:admin'] && (
              <QuestionBankPanel
                key={revision}
                csrfToken={me.csrfToken}
                onAccessError={setError}
                onDirtyChange={setCourseDirty}
              />
            )}
          </TabsContent>
          <TabsContent value="reports">
            {!busy && !error && (me.capabilities['lms:review'] || me.capabilities['lms:admin']) && (
              <ReportsPanel key={revision} csrfToken={me.csrfToken} onAccessError={setError} />
            )}
          </TabsContent>
          <TabsContent value="learners">
            {!busy && !error && me.capabilities['lms:admin'] && (
              <LearnersPanel
                key={revision}
                csrfToken={me.csrfToken}
                accountId={me.accountId}
                onAccessError={setError}
              />
            )}
          </TabsContent>
          {['review', 'admin'].map((tab) => (
            <TabsContent key={tab} value={tab}>
              {!busy && review && (
                <ReviewDashboard key={tab} review={review} admin={tab === 'admin'} />
              )}
            </TabsContent>
          ))}
        </Tabs>
        <footer className="flex flex-wrap justify-between gap-2 border-t pt-5 text-xs text-muted-foreground">
          <span>Công ty Cổ phần Tà Lùng Quang Minh</span>
          <span>Bản dùng thử · Lịch sử giả lập · Chưa kết nối LMS hiện hữu</span>
        </footer>
      </main>
      <Dialog
        open={!!pendingNavigation}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bỏ thay đổi chưa lưu?</DialogTitle>
            <DialogDescription>
              Nội dung đang nhập chưa được lưu hoặc nộp. Bạn có thể quay lại để hoàn tất.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingNavigation(null)}>
              Tiếp tục chỉnh sửa
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const next = pendingNavigation;
                setPendingNavigation(null);
                setCourseDirty(false);
                setLearning(null);
                setReview(null);
                setBusy(true);
                if (next?.view) setView(next.view);
                if (next?.refresh) setRevision((value) => value + 1);
              }}
            >
              Bỏ thay đổi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
