import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  AppWindow,
  ArrowUpRight,
  Building2,
  ClipboardList,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  ShieldCheck,
  UserRound,
  Users,
  RefreshCw,
  LockKeyhole,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ResourcePanel } from '@/components/resource-panel';
import { Brand } from '@/components/brand';
import { LoginRecovery } from '@/components/login-recovery';
import { IdentityPanel, IdentityProofScreen } from '@/components/identity-panel';
import { api, apiCollection, allowed, ApiError } from '@/lib/api';
import type { Me, Row, Runtime } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { rememberLoginTarget, takeLoginTarget } from '@/lib/login-target';
import { resourceByKey } from '@/lib/resources';
import { FoundationWorkspace } from '@/foundation/workspace';
const WorkCenter = lazy(() =>
  import('./foundation/work-center').then((module) => ({ default: module.WorkCenter })),
);
import type { FoundationMode } from '@/foundation/workspace';
const SelfProfile = lazy(() =>
  import('./foundation/metadata').then((module) => ({ default: module.SelfProfile })),
);
const FormsApp = lazy(() => import('./forms/app').then((module) => ({ default: module.FormsApp })));
const LmsApp = lazy(() => import('./lms/app').then((module) => ({ default: module.LmsApp })));
const WorkflowsApp = lazy(() =>
  import('./workflows/app').then((module) => ({ default: module.WorkflowsApp })),
);
const TasksApp = lazy(() => import('./tasks/app').then((module) => ({ default: module.TasksApp })));
const CmsApp = lazy(() => import('./cms/app').then((module) => ({ default: module.CmsApp })));

const navigation = [
  { id: 'home', name: 'Ứng dụng của tôi', icon: LayoutGrid },
  { id: 'work-center', name: 'Công việc & thông báo', icon: ClipboardList },
  { id: 'profile', name: 'Hồ sơ của tôi', icon: UserRound },
  { id: 'organization', name: 'Cơ cấu tổ chức', icon: Building2 },
  { id: 'people', name: 'Nhân sự & tài khoản', icon: Users },
  { id: 'identities', name: 'Định danh & vòng đời', icon: ShieldCheck },
  { id: 'applications', name: 'Danh mục ứng dụng', icon: AppWindow },
  { id: 'access', name: 'Vai trò & truy cập', icon: KeyRound },
  { id: 'audit', name: 'Lịch sử quản trị', icon: ClipboardList },
];
const groups: Record<string, string[]> = {
  organization: ['legal-entities', 'org-units', 'job-titles', 'positions'],
  people: ['people', 'accounts', 'employments', 'assignments'],
  access: ['roles', 'permissions', 'bindings', 'grants'],
  applications: ['applications'],
};
const routeView = (hash: string) => hash.slice(1).split('?')[0] || 'home';
export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [authError, setAuthError] = useState<unknown>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState(routeView(location.hash));
  const [tenantId, setTenantId] = useState('');
  const [selectedApp, setSelectedApp] = useState('');
  const [tab, setTab] = useState('legal-entities');
  const [personTarget, setPersonTarget] = useState<string | undefined>();
  const [workspaceTab, setWorkspaceTab] = useState<string | undefined>();
  const [drawer, setDrawer] = useState(false);
  const [version, setVersion] = useState(0);
  const [myApps, setMyApps] = useState<Row[]>([]);
  const [audit, setAudit] = useState<Row[]>([]);
  const [auditError, setAuditError] = useState<unknown>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditSearch, setAuditSearch] = useState('');
  const [auditDetail, setAuditDetail] = useState<Row | null>(null);
  const auditTrigger = useRef<HTMLElement | null>(null);
  const refreshAuth = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const [identityResult, infoResult] = await Promise.allSettled([
        api<Me>('/api/v1/me'),
        api<Runtime>('/api/v1/runtime-info'),
      ]);
      if (infoResult.status === 'fulfilled') setRuntime(infoResult.value);
      if (identityResult.status === 'rejected') {
        if (
          identityResult.reason instanceof ApiError &&
          identityResult.reason.status === 401 &&
          infoResult.status === 'fulfilled' &&
          infoResult.value.authError
        )
          throw new ApiError(403, infoResult.value.authError);
        throw identityResult.reason;
      }
      const identity = identityResult.value;
      const pending = takeLoginTarget();
      if (pending && !location.hash) {
        location.hash = pending;
        setView(routeView(pending));
      }
      setMe(identity);
      setTenantId((value) =>
        identity.memberships.some((item) => item.id === value)
          ? value
          : (identity.memberships[0]?.id ?? ''),
      );
      setSelectedApp((value) => value || identity.appCode);
    } catch (error) {
      setAuthError(error);
      setMe(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);
  useEffect(() => {
    const update = () => setView(routeView(location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (!me) return;
    const controller = new AbortController();
    void api<{ items: Row[] }>('/api/v1/applications', { signal: controller.signal })
      .then((result) => setMyApps(result.items))
      .catch(() => {});
    return () => controller.abort();
  }, [me, tenantId]);
  useEffect(() => {
    if (view !== 'audit' || !me || !tenantId) return;
    const controller = new AbortController();
    setAuditLoading(true);
    setAuditError(null);
    void api<{ items: Row[] }>('/api/v1/audit?tenantId=' + tenantId, { signal: controller.signal })
      .then((result) => {
        setAudit(result.items);
        setAuditLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setAuditError(error);
          setAuditLoading(false);
        }
      });
    return () => controller.abort();
  }, [view, me, tenantId, version]);
  function go(id: string) {
    setPersonTarget(undefined);
    setWorkspaceTab(undefined);
    window.scrollTo({ top: 0, behavior: 'auto' });
    setTab(groups[id]?.[0] ?? '');
    location.hash = id;
    setView(id);
    setDrawer(false);
  }
  async function logout(global: boolean) {
    if (!me) {
      if (runtime) location.assign(runtime.logoutUrl);
      return;
    }
    try {
      const response = await api<{ redirectTo: string }>('/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
        body: JSON.stringify({ global }),
      });
      location.assign(response.redirectTo);
    } catch (error) {
      setAuthError(error);
      if (me.appCode === 'aio-lms-sandbox') throw error;
    }
  }
  const nav = (
    <>
      <div className="border-b p-6">
        <Brand />
      </div>
      <nav className="space-y-1 px-3 py-5" aria-label="Điều hướng chính">
        {navigation.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            className={
              'w-full justify-start gap-3 px-3 ' +
              (view === item.id ? 'nav-current' : 'text-muted-foreground')
            }
            onClick={() => go(item.id)}
            aria-current={view === item.id ? 'page' : undefined}
          >
            <item.icon className="size-4" />
            {item.name}
          </Button>
        ))}
      </nav>
      <div className="mt-auto space-y-3 border-t p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground">
            {me?.displayName.slice(0, 1)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{me?.displayName}</p>
            <p className="text-xs text-muted-foreground">Tài khoản nội bộ</p>
          </div>
        </div>
        <Button variant="outline" className="w-full" onClick={() => void logout(true)}>
          <LogOut className="size-4" />
          Đăng xuất SSO
        </Button>
      </div>
    </>
  );
  if (view === 'identity-proof') return <IdentityProofScreen />;
  if (view === 'login-recovery') return <LoginRecovery />;
  if (authLoading)
    return (
      <main className="mx-auto max-w-5xl space-y-5 p-8" aria-label="Đang tải phiên">
        <Skeleton className="h-12 w-48" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  if (!me)
    return (
      <main className="flex min-h-screen items-center justify-center px-5 py-12">
        <Card className="w-full max-w-md">
          <CardHeader>
            <Brand />
            <CardTitle className="mt-8 text-2xl">
              {runtime?.appCode === 'aio-lms-sandbox'
                ? 'LMS · Sandbox SSO'
                : 'Không gian làm việc TLQM'}
            </CardTitle>
            <CardDescription>
              Đăng nhập một lần để truy cập các ứng dụng và dữ liệu được cấp.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {Boolean(authError) && !(authError instanceof ApiError && authError.status === 401) && (
              <Alert
                variant="destructive"
                data-auth-error={authError instanceof ApiError ? authError.code : undefined}
              >
                <LockKeyhole className="size-4" />
                <AlertDescription>{errorMessage(authError)}</AlertDescription>
              </Alert>
            )}
            <Button asChild className="w-full">
              <a
                onClick={() => rememberLoginTarget(location.hash)}
                href={
                  location.port === '5173'
                    ? 'http://127.0.0.1:4100/auth/login'
                    : (runtime?.loginUrl ?? '/auth/login') +
                      (authError instanceof ApiError &&
                      ['MFA_REQUIRED', 'REAUTHENTICATION_REQUIRED'].includes(authError.code)
                        ? '?reauth=1'
                        : '')
                }
              >
                Đăng nhập SSO
                <ArrowUpRight className="size-4" />
              </a>
            </Button>
            {runtime?.appCode === 'aio-foundation' && (
              <Button variant="outline" className="w-full" asChild>
                <a href="/auth/identity-proof">Tạo mã xác minh SSO</a>
              </Button>
            )}
            {authError instanceof ApiError && authError.code === 'MFA_REQUIRED' && runtime && (
              <Button asChild variant="outline" className="w-full">
                <a href={runtime.accountUrl}>Cấu hình ứng dụng xác thực</a>
              </Button>
            )}
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => void refreshAuth()}>
                Thử lại
              </Button>
              {runtime && (
                <Button variant="ghost" asChild>
                  <a href={runtime.logoutUrl}>Đổi tài khoản</a>
                </Button>
              )}
            </div>
            <p className="text-center text-xs text-muted-foreground">
              Môi trường local · Chỉ dùng dữ liệu giả lập
            </p>
          </CardContent>
        </Card>
      </main>
    );
  if (me.appCode === 'aio-workflows')
    return (
      <Suspense
        fallback={
          <main className="p-8" role="status">
            Đang tải AIO Quy trình…
          </main>
        }
      >
        <WorkflowsApp me={me} portalUrl={runtime?.portalUrl} />
      </Suspense>
    );
  if (me.appCode === 'aio-tasks')
    return (
      <Suspense
        fallback={
          <main className="p-8" role="status">
            Đang tải AIO Công việc…
          </main>
        }
      >
        <TasksApp me={me} portalUrl={runtime?.portalUrl} logout={() => logout(true)} />
      </Suspense>
    );
  if (me.appCode === 'aio-forms')
    return (
      <Suspense
        fallback={
          <main className="p-8" role="status">
            Đang tải AIO Forms…
          </main>
        }
      >
        <FormsApp me={me} logout={() => logout(true)} />
      </Suspense>
    );
  if (me.appCode === 'aio-lms-sandbox')
    return (
      <Suspense
        fallback={
          <main className="p-8" role="status">
            Đang tải LMS sandbox…
          </main>
        }
      >
        <LmsApp me={me} portalUrl={runtime?.portalUrl} logout={() => logout(true)} />
      </Suspense>
    );
  if (me.appCode === 'aio-cms')
    return (
      <Suspense
        fallback={
          <main className="p-8" role="status">
            Đang tải AIO CMS…
          </main>
        }
      >
        <CmsApp me={me} logout={() => logout(true)} />
      </Suspense>
    );
  const group = groups[view];
  const resource = resourceByKey[group?.includes(tab) ? tab : (group?.[0] ?? '')];
  const appChoices = [
    ...new Map(
      [...myApps]
        .filter((item) => item.status !== 'planned' || !item.protected)
        .map((item) => [String(item.code), item]),
    ).values(),
  ];
  const allOptions = { applications: appChoices };
  const resourcePanel = resource ? (
    <ResourcePanel
      key={resource.key + tenantId + selectedApp}
      resource={resource}
      me={me}
      tenantId={tenantId}
      appCode={selectedApp}
      options={allOptions}
      onChanged={() => setVersion((value) => value + 1)}
    />
  ) : null;
  const visibleAudit = audit.filter((row) =>
    JSON.stringify(row).toLocaleLowerCase('vi').includes(auditSearch.toLocaleLowerCase('vi')),
  );
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-sidebar lg:flex">
        {nav}
      </aside>
      <div className="min-w-0 flex-1 lg:pl-64">
        <header className="sticky top-0 z-20 flex min-h-20 items-center justify-between gap-3 border-b bg-card px-4 py-3 md:px-7">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Sheet open={drawer} onOpenChange={setDrawer}>
              <SheetTrigger asChild>
                <Button variant="outline" size="icon" className="lg:hidden" aria-label="Mở menu">
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="flex w-72 flex-col gap-0 p-0">
                <SheetHeader className="sr-only">
                  <SheetTitle>Điều hướng TLQM AIO</SheetTitle>
                  <SheetDescription>Chọn chức năng quản trị hoặc ứng dụng.</SheetDescription>
                </SheetHeader>
                {nav}
              </SheetContent>
            </Sheet>
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground">
                NỀN TẢNG / {runtime?.name ?? 'TLQM AIO'}
              </p>
              <h1 className="mt-1 truncate text-lg font-semibold">
                {navigation.find((item) => item.id === view)?.name ?? 'Ứng dụng của tôi'}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="hidden sm:inline-flex">
              Local · Dữ liệu giả lập
            </Badge>
            <Select value={tenantId} onValueChange={setTenantId}>
              <SelectTrigger className="max-w-40 md:max-w-56" aria-label="Chọn không gian tổ chức">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {me.memberships.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </header>
        <main id="main-content" className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-7">
          {view === 'work-center' && (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <WorkCenter key={tenantId} me={me} tenantId={tenantId} />
            </Suspense>
          )}
          {Boolean(authError) && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(authError)}</AlertDescription>
            </Alert>
          )}
          {view === 'home' && (
            <>
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                  <p className="text-sm text-muted-foreground">KHÔNG GIAN LÀM VIỆC</p>
                  <h2 className="mt-2 text-2xl font-semibold">Chào {me.displayName}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Các ứng dụng dưới đây đã được cấp cho tài khoản của bạn.
                  </p>
                </div>
                <Badge className="status-success self-start" data-code="AUTHENTICATED">
                  <ShieldCheck className="mr-1 size-4" />
                  Phiên SSO đang hoạt động
                </Badge>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {myApps.map((item) => (
                  <Card key={String(item.code)}>
                    <CardHeader>
                      <div className="mb-3 flex size-11 items-center justify-center rounded-md bg-secondary text-primary">
                        <AppWindow className="size-5" />
                      </div>
                      <CardTitle>{String(item.name)}</CardTitle>
                      <CardDescription>{String(item.code)}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button variant="outline" asChild className="w-full justify-between">
                        <a href={String(item.launchUrl)}>
                          Mở ứng dụng
                          <ArrowUpRight className="size-4" />
                        </a>
                      </Button>
                    </CardContent>
                  </Card>
                ))}
                {!myApps.length && (
                  <Card>
                    <CardContent className="py-8 text-sm text-muted-foreground">
                      Chưa có ứng dụng được cấp trong phạm vi này.
                    </CardContent>
                  </Card>
                )}
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>Thao tác thường dùng</CardTitle>
                  <CardDescription>
                    Quản lý danh tính, tổ chức và truy cập từ một nơi.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => go('profile')}>
                    <UserRound className="size-4" />
                    Hồ sơ của tôi
                  </Button>
                  <Button variant="outline" onClick={() => go('organization')}>
                    <Building2 className="size-4" />
                    Cơ cấu tổ chức
                  </Button>
                  {allowed(me, tenantId, 'access:manage') && (
                    <Button
                      onClick={() => {
                        go('access');
                        setTab('grants');
                        setWorkspaceTab('grants');
                      }}
                    >
                      <KeyRound className="size-4" />
                      Cấp truy cập
                    </Button>
                  )}
                </CardContent>
              </Card>
            </>
          )}
          {view === 'profile' && (
            <div className="grid gap-5 xl:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{me.displayName}</CardTitle>
                  <CardDescription>Danh tính nội bộ dùng chung trong nền tảng.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <p className="text-sm text-muted-foreground">Không gian được cấp</p>
                    <p className="mt-1 font-medium">
                      {me.memberships.map((item) => item.name).join(', ')}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Ứng dụng đang sử dụng</p>
                    <p className="mt-1 font-medium">{runtime?.name}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline">
                      <a href={runtime?.accountUrl}>
                        Bảo mật tài khoản
                        <ArrowUpRight className="size-4" />
                      </a>
                    </Button>
                    <Button variant="outline" onClick={() => void logout(false)}>
                      Đăng xuất ứng dụng
                    </Button>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Quan hệ công tác</CardTitle>
                  <CardDescription>
                    Vị trí chính và các nhiệm vụ kiêm nhiệm còn hiệu lực.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {me.assignments.map((item, index) => (
                    <div key={index} className="rounded-md border p-4">
                      <div className="flex flex-wrap justify-between gap-2">
                        <p className="font-semibold">{item.unitName}</p>
                        <Badge variant="secondary">
                          {item.isPrimary ? 'Vị trí chính' : 'Kiêm nhiệm'}
                        </Badge>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {item.positionName} · {item.employeeCode}
                      </p>
                    </div>
                  ))}
                  {!me.assignments.length && (
                    <p className="text-sm text-muted-foreground">
                      Chưa có quan hệ công tác được ghi nhận.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
          {['organization', 'people', 'access'].includes(view) && (
            <FoundationWorkspace
              key={view + tenantId}
              mode={view as FoundationMode}
              me={me}
              tenantId={tenantId}
              applications={appChoices}
              initialPersonId={personTarget}
              initialTab={workspaceTab}
              onPerson={(id) => {
                go('people');
                setPersonTarget(id);
              }}
              onIdentity={() => go('identities')}
            />
          )}
          {view === 'profile' && (
            <Suspense fallback={<Skeleton className="h-48" />}>
              <SelfProfile key={tenantId} me={me} tenantId={tenantId} />
            </Suspense>
          )}
          {group &&
            !['organization', 'people', 'access'].includes(view) &&
            resource &&
            (group.length > 1 ? (
              <Tabs value={resource.key} onValueChange={setTab} className="min-w-0 gap-4">
                <TabsList className="w-fit max-w-full">
                  {group.map((key) => (
                    <TabsTrigger key={key} value={key}>
                      {resourceByKey[key]!.title}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {resource.appScoped && (
                  <div className="max-w-md space-y-2">
                    <p className="text-sm font-medium">Ứng dụng đang quản trị</p>
                    <Select value={selectedApp} onValueChange={setSelectedApp}>
                      <SelectTrigger className="w-full" aria-label="Chọn ứng dụng quản trị">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {appChoices.map((item) => (
                          <SelectItem key={String(item.code)} value={String(item.code)}>
                            {String(item.name)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {group.map((key) => (
                  <TabsContent key={key} value={key}>
                    {key === resource.key ? resourcePanel : null}
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              resourcePanel
            ))}
          {view === 'identities' && (
            <IdentityPanel
              key={tenantId}
              me={me}
              tenantId={tenantId}
              onChanged={() => setVersion((value) => value + 1)}
            />
          )}
          {view === 'audit' && (
            <section className="space-y-4">
              <div className="flex flex-col justify-between gap-3 sm:flex-row">
                <div>
                  <h2 className="text-xl font-semibold">Lịch sử quản trị</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Thao tác và lý do thay đổi trong không gian được cấp.
                  </p>
                </div>
                <Button variant="outline" onClick={() => setVersion((value) => value + 1)}>
                  <RefreshCw className="size-4" />
                  Tải lại
                </Button>
              </div>
              <Input
                className="max-w-md"
                value={auditSearch}
                onChange={(event) => setAuditSearch(event.target.value)}
                aria-label="Lọc lịch sử quản trị"
                placeholder="Lọc theo thao tác, đối tượng hoặc lý do…"
              />
              {auditError ? (
                <Alert variant="destructive">
                  <AlertDescription>{errorMessage(auditError)}</AlertDescription>
                </Alert>
              ) : auditLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <div className="overflow-hidden rounded-lg border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Thời gian</TableHead>
                        <TableHead>Thao tác</TableHead>
                        <TableHead>Đối tượng</TableHead>
                        <TableHead>Lý do</TableHead>
                        <TableHead>Chi tiết</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleAudit.map((row) => (
                        <TableRow key={String(row.id)}>
                          <TableCell className="whitespace-nowrap">
                            {new Date(String(row.occurredAt)).toLocaleString('vi-VN')}
                          </TableCell>
                          <TableCell>{String(row.action)}</TableCell>
                          <TableCell>{String(row.targetType ?? row.appCode)}</TableCell>
                          <TableCell className="table-cell-wrap">
                            {String(row.reason ?? '—')}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              onClick={(event) => {
                                auditTrigger.current = event.currentTarget;
                                setAuditDetail(row);
                              }}
                            >
                              Xem
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      {!visibleAudit.length && (
                        <TableRow>
                          <TableCell colSpan={5} className="h-28 text-center text-muted-foreground">
                            Chưa có sự kiện phù hợp.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          )}
          <footer className="border-t pt-4 text-xs text-muted-foreground">
            TLQM AIO · Một định danh, nhiều ứng dụng · Môi trường thử nghiệm nội bộ
          </footer>
        </main>
      </div>
      <Dialog
        open={Boolean(auditDetail)}
        onOpenChange={(open) => {
          if (!open) setAuditDetail(null);
        }}
      >
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            auditTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Chi tiết thay đổi</DialogTitle>
            <DialogDescription>
              {String(auditDetail?.reason ?? 'Sự kiện hệ thống')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              Thao tác: <strong>{String(auditDetail?.action ?? '')}</strong>
            </p>
            <p className="break-all">
              Người thực hiện: {String(auditDetail?.actorAccountId ?? 'Hệ thống')}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {['before', 'after'].map((key) => (
                <section key={key}>
                  <h3 className="mb-2 font-semibold">
                    {key === 'before' ? 'Trước thay đổi' : 'Sau thay đổi'}
                  </h3>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
                    {JSON.stringify(
                      (auditDetail?.details as Record<string, unknown> | undefined)?.[key] ?? null,
                      null,
                      2,
                    )}
                  </pre>
                </section>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
