import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ClipboardList, LogOut, Plus, RefreshCw } from 'lucide-react';
import { parseFormSchema } from '../../../src/forms/contracts';
import type { FormSchema } from '../../../src/forms/contracts';
import { api } from '@/lib/api';
import { CopyRouteButton } from '@/components/copy-route-button';
import {
  formsDetailRoute,
  formsListRoute,
  parseFormTarget,
  parseFormsDetailRoute,
  parseFormsListRoute,
} from '@/lib/form-target';
import type { Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Brand } from '@/components/brand';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Choice, can, emptySchema, useFormsWrite, formError } from './common';
import type { FormDetail, FormListItem, Lookup, Group, PageResult } from './common';
import { FormDesigner } from './designer';
import { RespondPanel } from './respond';
import type { ConfirmRequest } from './respond';
import { AudiencePanel, GroupsPanel } from './distribution';
import { ReportsPanel } from './reports';
import { FormRenderer } from './renderer';

export function FormsApp({ me, logout }: { me: Me; logout: () => Promise<void> }) {
  const [tenantId, setTenantId] = useState(
    () => parseFormTarget(location.hash)?.tenant ?? me.memberships[0]?.id ?? '',
  );
  const [forms, setForms] = useState<FormListItem[]>([]),
    [lookup, setLookup] = useState<Lookup>({ units: [], ownUnits: [], accounts: [] }),
    [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState(
      parseFormsDetailRoute(location.hash)?.form ??
        parseFormTarget(location.hash)?.form ??
        (/^#forms\/[0-9a-f-]{36}$/.test(location.hash) ? location.hash.slice(7) : ''),
    ),
    [detail, setDetail] = useState<FormDetail | null>(null),
    [screen, setScreen] = useState<'forms' | 'groups'>(
      location.hash === '#forms/groups' ? 'groups' : 'forms',
    );
  const [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [success, setSuccess] = useState(''),
    [search, setSearch] = useState(() => parseFormsListRoute(location.hash)?.search ?? '');
  const [draft, setDraft] = useState<FormSchema | null>(null),
    [dirty, setDirty] = useState(false),
    [reason, setReason] = useState('Cập nhật bản nháp biểu mẫu');
  const [tab, setTab] = useState(() => parseFormsDetailRoute(location.hash)?.tab ?? ''),
    [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [createOpen, setCreateOpen] = useState(false),
    [createName, setCreateName] = useState(''),
    [createCode, setCreateCode] = useState(''),
    [createUnit, setCreateUnit] = useState('_all'),
    [createMax, setCreateMax] = useState(1),
    [createError, setCreateError] = useState<unknown>(null);
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null),
    [confirmationReason, setConfirmationReason] = useState('Thực hiện thao tác biểu mẫu'),
    [confirmationError, setConfirmationError] = useState<unknown>(null),
    [confirmBusy, setConfirmBusy] = useState(false);
  const trigger = useRef<HTMLElement | null>(null),
    createTrigger = useRef<HTMLElement | null>(null);
  const write = useFormsWrite(me, tenantId);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => {
    const onHashChange = () => {
      const target = parseFormTarget(location.hash);
      const detailRoute = parseFormsDetailRoute(location.hash);
      const next =
        detailRoute?.form ??
        target?.form ??
        (/^#forms\/[0-9a-f-]{36}$/.test(location.hash) ? location.hash.slice(7) : '');
      const nextScreen = location.hash === '#forms/groups' ? 'groups' : 'forms';
      const listRoute = parseFormsListRoute(location.hash);
      if (
        next === selected &&
        nextScreen === screen &&
        (!target || target.tenant === tenantId) &&
        (!listRoute || listRoute.search === search)
      )
        return;
      if (dirty && !window.confirm('Bản nháp chưa lưu. Bạn muốn rời màn hình này?')) {
        window.history.replaceState(null, '', selected ? '#forms/' + selected : '#forms');
        return;
      }
      setDirty(false);
      setSelected(next);
      if (target) setTenantId(target.tenant);
      if (listRoute) setSearch(listRoute.search);
      if (detailRoute?.tab) setTab(detailRoute.tab);
      setScreen(nextScreen);
      setError(null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [selected, dirty, screen, tenantId, search]);
  useEffect(() => {
    if (selected || screen !== 'forms') return;
    const next = formsListRoute(search);
    if (location.hash !== next) window.history.replaceState(null, '', next);
  }, [selected, screen, search]);
  const design = can(me, tenantId, 'forms:design'),
    publish = can(me, tenantId, 'forms:publish');
  const notify = (message: string) => {
    setSuccess(message);
    setError(null);
  };
  const confirm = (request: ConfirmRequest) => {
    trigger.current = document.activeElement as HTMLElement;
    setConfirmationError(null);
    setConfirmationReason('Thực hiện thao tác biểu mẫu');
    setConfirmation(request);
  };
  const reloadLists = useCallback(
    async (signal?: AbortSignal) => {
      const [list, references, groupList] = await Promise.all([
        api<PageResult<FormListItem>>('/api/v1/forms/pages?tenantId=' + tenantId, { signal }),
        api<Lookup>('/api/v1/forms/lookups?tenantId=' + tenantId, { signal }),
        publish
          ? api<Group[]>('/api/v1/forms/groups?tenantId=' + tenantId, { signal })
          : Promise.resolve([]),
      ]);
      setForms(list.items);
      setNextCursor(list.nextCursor);
      setLookup(references);
      setGroups(groupList);
    },
    [tenantId, publish],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void reloadLists(controller.signal)
      .then(() => setLoading(false))
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [reloadLists]);
  const loadDetail = useCallback(
    async (formId: string, signal?: AbortSignal) => {
      const result = await api<FormDetail>('/api/v1/forms/' + formId + '?tenantId=' + tenantId, {
        signal,
      });
      if (signal?.aborted) return result;
      setDetail(result);
      setDraft(result.form.draft_schema ?? null);
      setDirty(false);
      return result;
    },
    [tenantId],
  );
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDraft(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    void loadDetail(selected, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        const requestedTab = parseFormsDetailRoute(location.hash)?.tab;
        const requestedAllowed =
          (requestedTab === 'design' &&
            can(me, tenantId, 'forms:design', detail.form.org_unit_id)) ||
          (requestedTab === 'audience' &&
            can(me, tenantId, 'forms:publish', detail.form.org_unit_id)) ||
          (requestedTab === 'versions' &&
            can(me, tenantId, 'forms:publish', detail.form.org_unit_id)) ||
          (requestedTab === 'respond' && can(me, tenantId, 'forms:respond')) ||
          (requestedTab === 'review' && can(me, tenantId, 'forms:review')) ||
          (requestedTab === 'analyze' && can(me, tenantId, 'forms:analyze')) ||
          (requestedTab === 'history' &&
            (can(me, tenantId, 'forms:design') || can(me, tenantId, 'forms:publish')));
        setTab(
          requestedAllowed && requestedTab
            ? requestedTab
            : parseFormTarget(location.hash)?.form === selected &&
                can(me, tenantId, 'forms:respond')
              ? 'respond'
              : can(me, tenantId, 'forms:design', detail.form.org_unit_id)
                ? 'design'
                : can(me, tenantId, 'forms:publish', detail.form.org_unit_id)
                  ? 'audience'
                  : can(me, tenantId, 'forms:respond')
                    ? 'respond'
                    : can(me, tenantId, 'forms:review')
                      ? 'review'
                      : 'analyze',
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error);
      });
    return () => controller.abort();
  }, [selected, tenantId, loadDetail, me]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  useEffect(() => {
    if (tab !== 'history' || !selected) return;
    const controller = new AbortController();
    void api<Record<string, unknown>[]>(
      '/api/v1/forms/' + selected + '/audit?tenantId=' + tenantId,
      { signal: controller.signal },
    )
      .then(setHistory)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error);
      });
    return () => controller.abort();
  }, [tab, selected, tenantId, detail?.form.revision]);
  async function changed() {
    if (selected) await loadDetail(selected);
    await reloadLists();
    notify('Đã cập nhật biểu mẫu.');
  }
  function navigate(formId = '', nextScreen: 'forms' | 'groups' = 'forms') {
    if (dirty && !window.confirm('Bản nháp chưa lưu. Bạn muốn rời màn hình này?')) return;
    setDirty(false);
    setSelected(formId);
    setScreen(nextScreen);
    setError(null);
    setSuccess('');
    location.hash = formId
      ? 'forms/' + formId
      : nextScreen === 'groups'
        ? 'forms/groups'
        : formsListRoute(search).slice(1);
    window.scrollTo({ top: 0 });
  }
  async function saveDraft() {
    if (!detail || !draft) return;
    setBusy(true);
    setError(null);
    try {
      await write(
        '/' + detail.form.id + '/draft',
        { expectedRevision: detail.form.revision, schema: parseFormSchema(draft) },
        reason,
      );
      await changed();
      notify('Đã lưu bản nháp. Phiên bản đã xuất bản giữ nguyên.');
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setCreateError(null);
    try {
      const row = await write<FormListItem>(
        '',
        {
          code: createCode,
          schema: emptySchema(createName),
          orgUnitId: createUnit === '_all' ? null : createUnit,
          maxSubmissions: createMax,
        },
        'Tạo biểu mẫu nội bộ',
      );
      setCreateOpen(false);
      await reloadLists();
      navigate(row.id);
    } catch (error) {
      setCreateError(error);
    } finally {
      setBusy(false);
    }
  }
  const scopedDesign = detail && can(me, tenantId, 'forms:design', detail.form.org_unit_id),
    scopedPublish = detail && can(me, tenantId, 'forms:publish', detail.form.org_unit_id);
  const tabs = detail
    ? [
        ...(scopedDesign ? [{ id: 'design', name: 'Thiết kế' }] : []),
        ...(scopedPublish
          ? [
              { id: 'audience', name: 'Phân phối' },
              { id: 'versions', name: 'Phiên bản' },
            ]
          : []),
        ...(can(me, tenantId, 'forms:respond') ? [{ id: 'respond', name: 'Trả lời' }] : []),
        ...(can(me, tenantId, 'forms:review') ? [{ id: 'review', name: 'Phiếu đã gửi' }] : []),
        ...(can(me, tenantId, 'forms:analyze') ? [{ id: 'analyze', name: 'Tổng hợp' }] : []),
        ...(scopedDesign || scopedPublish ? [{ id: 'history', name: 'Lịch sử' }] : []),
      ]
    : [];
  const filtered = forms.filter((form) =>
    (form.title + ' ' + form.code).toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')),
  );
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-8">
          <Brand module="Biểu mẫu nội bộ" />
          <div className="flex flex-wrap items-center gap-3">
            <span className="max-w-48 truncate text-sm">{me.displayName}</span>
            <Badge variant="outline">Local · Dữ liệu giả lập</Badge>
            <Button variant="ghost" onClick={() => void logout()}>
              <LogOut />
              Đăng xuất SSO
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
        <nav className="flex flex-wrap items-center gap-3" aria-label="Điều hướng Forms">
          <Button variant={screen === 'forms' ? 'secondary' : 'ghost'} onClick={() => navigate()}>
            Biểu mẫu
          </Button>
          {publish && (
            <Button
              variant={screen === 'groups' ? 'secondary' : 'ghost'}
              onClick={() => navigate('', 'groups')}
            >
              Nhóm nhận biểu mẫu
            </Button>
          )}
          {me.memberships.length > 1 && (
            <Choice
              label="Không gian"
              value={tenantId}
              onChange={(id) => {
                navigate();
                setTenantId(id);
              }}
              options={me.memberships}
            />
          )}
        </nav>
        {success && (
          <Alert role="status">
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}
        {error !== null && (
          <Alert variant="destructive" data-form-error>
            <AlertDescription>{formError(error)}</AlertDescription>
          </Alert>
        )}
        {loading && <p role="status">Đang tải biểu mẫu…</p>}
        {!loading && screen === 'groups' && (
          <GroupsPanel
            groups={groups}
            lookup={lookup}
            me={me}
            tenantId={tenantId}
            confirm={confirm}
            onChanged={async () => {
              await reloadLists();
              notify('Đã lưu nhóm nhận biểu mẫu.');
            }}
          />
        )}
        {!loading && screen === 'forms' && !selected && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1
                  id="forms-main-title"
                  tabIndex={-1}
                  className="text-2xl font-semibold text-[var(--brand-navy)]"
                >
                  Biểu mẫu nội bộ
                </h1>
                <p className="mt-2 text-muted-foreground">
                  Tạo, giao và trả lời biểu mẫu trong phạm vi được cấp.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <CopyRouteButton />
                <Button variant="outline" onClick={() => void reloadLists().catch(setError)}>
                  <RefreshCw />
                  Tải lại
                </Button>
                {design && (
                  <Button
                    onClick={() => {
                      createTrigger.current = document.activeElement as HTMLElement;
                      setCreateName('');
                      setCreateCode('');
                      setCreateUnit('_all');
                      setCreateMax(1);
                      setCreateError(null);
                      setCreateOpen(true);
                    }}
                  >
                    <Plus />
                    Tạo biểu mẫu
                  </Button>
                )}
              </div>
            </div>
            <div className="max-w-md space-y-2">
              <Label htmlFor="forms-search">Tìm trong danh sách đã tải</Label>
              <Input
                id="forms-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Tên hoặc mã biểu mẫu"
              />
              {search && (
                <Button type="button" variant="ghost" onClick={() => setSearch('')}>
                  Xóa tìm kiếm
                </Button>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((form) => (
                <Card key={form.id}>
                  <CardHeader>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <ClipboardList className="size-5 text-[var(--brand-navy)]" />
                      <Badge variant="outline">
                        {form.status === 'archived'
                          ? 'Đã lưu trữ'
                          : form.status === 'closed'
                            ? 'Đã đóng'
                            : form.latest_version
                              ? 'Đang nhận phiếu'
                              : 'Chưa xuất bản'}
                      </Badge>
                    </div>
                    <CardTitle>{form.title}</CardTitle>
                    <CardDescription>{form.code}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex gap-2">
                      <Badge variant="secondary">
                        {form.latest_version ? 'Phiên bản ' + form.latest_version : 'Bản nháp'}
                      </Badge>
                      {form.hasDraft && form.latest_version > 0 && (
                        <Badge variant="outline">Có bản nháp mới</Badge>
                      )}
                    </div>
                    <Button variant="outline" className="w-full" onClick={() => navigate(form.id)}>
                      Mở biểu mẫu
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
            {!filtered.length && (
              <div className="rounded-lg border bg-card p-8 text-center">
                <ClipboardList className="mx-auto mb-3 size-8 text-muted-foreground" />
                <p className="font-medium">Chưa có biểu mẫu phù hợp</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Biểu mẫu sẽ xuất hiện khi được giao hoặc khi bạn tạo bản nháp mới.
                </p>
              </div>
            )}
            {nextCursor && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void api<PageResult<FormListItem>>(
                    '/api/v1/forms/pages?' + new URLSearchParams({ tenantId, after: nextCursor }),
                  )
                    .then((page) => {
                      setForms((old) => [
                        ...new Map([...old, ...page.items].map((row) => [row.id, row])).values(),
                      ]);
                      setNextCursor(page.nextCursor);
                    })
                    .catch(setError)
                    .finally(() => setBusy(false));
                }}
              >
                Tải thêm biểu mẫu
              </Button>
            )}
          </>
        )}
        {screen === 'forms' && selected && !detail && !error && (
          <p role="status">Đang mở biểu mẫu…</p>
        )}
        {screen === 'forms' && selected && detail && (
          <>
            <Button variant="ghost" onClick={() => navigate()}>
              <ArrowLeft />
              Danh sách biểu mẫu
            </Button>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="mb-2 text-sm text-muted-foreground">{detail.form.code}</p>
                <h1
                  id="forms-main-title"
                  tabIndex={-1}
                  className="break-words text-2xl font-semibold text-[var(--brand-navy)]"
                >
                  {detail.form.title}
                </h1>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge variant="secondary">
                    {detail.form.latest_version
                      ? 'Phiên bản ' + detail.form.latest_version
                      : 'Chưa xuất bản'}
                  </Badge>
                  <Badge variant="outline">
                    {detail.form.status === 'open'
                      ? 'Đang mở'
                      : detail.form.status === 'closed'
                        ? 'Đã đóng'
                        : 'Đã lưu trữ'}
                  </Badge>
                  {dirty && <Badge variant="outline">Chưa lưu thay đổi</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (
                      dirty &&
                      !window.confirm(
                        'Bản nháp chưa lưu. Tải lại sẽ bỏ các thay đổi chưa lưu. Tiếp tục?',
                      )
                    )
                      return;
                    setBusy(true);
                    void changed()
                      .catch(setError)
                      .finally(() => setBusy(false));
                  }}
                >
                  <RefreshCw />
                  Tải lại biểu mẫu
                </Button>
                {scopedPublish && detail.form.draft_schema && detail.form.status === 'open' && (
                  <Button
                    onClick={() =>
                      confirm({
                        title: 'Xuất bản phiên bản mới?',
                        description:
                          'Phiên bản xuất bản không thể sửa. Các phiếu cũ tiếp tục gắn với phiên bản của chúng.',
                        action: async (reason) => {
                          await write(
                            '/' + selected + '/publish',
                            { expectedRevision: detail.form.revision },
                            reason,
                          );
                          await changed();
                        },
                      })
                    }
                  >
                    Xuất bản
                  </Button>
                )}
                {scopedPublish && detail.form.status !== 'archived' && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() =>
                        confirm({
                          title:
                            detail.form.status === 'open' ? 'Đóng biểu mẫu?' : 'Mở lại biểu mẫu?',
                          description:
                            'Đóng sẽ chặn lưu nháp và gửi phiếu mới. Lịch sử được giữ nguyên.',
                          action: async (reason) => {
                            await write(
                              '/' + selected + '/status',
                              {
                                expectedRevision: detail.form.revision,
                                status: detail.form.status === 'open' ? 'closed' : 'open',
                              },
                              reason,
                            );
                            await changed();
                          },
                        })
                      }
                    >
                      {detail.form.status === 'open' ? 'Đóng biểu mẫu' : 'Mở lại'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        confirm({
                          title: 'Lưu trữ biểu mẫu?',
                          description:
                            'Biểu mẫu lưu trữ không thể mở lại hoặc sửa. Phiếu cũ vẫn được giữ trong phạm vi được cấp.',
                          action: async (reason) => {
                            await write(
                              '/' + selected + '/status',
                              { expectedRevision: detail.form.revision, status: 'archived' },
                              reason,
                            );
                            await changed();
                          },
                        })
                      }
                    >
                      Lưu trữ
                    </Button>
                  </>
                )}
              </div>
            </div>
            <Tabs
              value={tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id}
              onValueChange={(value) => {
                setTab(value);
                if (selected)
                  window.history.replaceState(null, '', formsDetailRoute(selected, value));
              }}
            >
              <div className="overflow-x-auto">
                <TabsList className="h-auto min-h-11 justify-start gap-1">
                  {tabs.map((item) => (
                    <TabsTrigger key={item.id} value={item.id}>
                      {item.name}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              {scopedDesign && (
                <TabsContent value="design" className="mt-6 space-y-5">
                  {detail.form.status === 'archived' ? (
                    <Alert>
                      <AlertDescription>
                        Biểu mẫu đã lưu trữ, không còn chỉnh sửa bản nháp.
                      </AlertDescription>
                    </Alert>
                  ) : draft ? (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="draft-reason">Lý do chỉnh sửa</Label>
                        <Input
                          id="draft-reason"
                          value={reason}
                          minLength={5}
                          maxLength={240}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </div>
                      <FormDesigner
                        schema={draft}
                        onChange={(schema) => {
                          setDraft(schema);
                          setDirty(true);
                        }}
                        onSave={() => void saveDraft()}
                        busy={busy}
                      />
                    </>
                  ) : (
                    <Card>
                      <CardHeader>
                        <CardTitle>Phiên bản đã xuất bản được giữ nguyên</CardTitle>
                        <CardDescription>
                          Tạo một bản nháp mới để thay đổi nội dung cho lần xuất bản tiếp theo.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Button
                          onClick={() => {
                            setDraft(
                              structuredClone(
                                detail.versions[0]?.schema ?? emptySchema(detail.form.title),
                              ),
                            );
                            setDirty(true);
                          }}
                        >
                          Tạo bản nháp mới
                        </Button>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>
              )}
              {scopedPublish && (
                <TabsContent value="audience" className="mt-6">
                  <AudiencePanel
                    key={detail.form.id + ':' + detail.form.revision}
                    detail={detail}
                    lookup={lookup}
                    groups={groups}
                    me={me}
                    tenantId={tenantId}
                    confirm={confirm}
                    onChanged={changed}
                  />
                </TabsContent>
              )}
              {scopedPublish && (
                <TabsContent value="versions" className="mt-6 space-y-5">
                  {detail.form.draft_schema && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Bản nháp chờ xuất bản</CardTitle>
                        <CardDescription>Kiểm tra nội dung trước khi xuất bản.</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <FormRenderer
                          schema={detail.form.draft_schema}
                          answers={{}}
                          onChange={() => {}}
                          disabled
                        />
                      </CardContent>
                    </Card>
                  )}
                  {detail.versions.map((version) => (
                    <Card key={version.id}>
                      <CardHeader>
                        <CardTitle>
                          Phiên bản {version.version} · {version.schema.title}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="mb-3 text-sm text-muted-foreground">
                          {version.closed_at
                            ? 'Phiên bản đã đóng'
                            : 'Phiên bản đang cho phép nhận phiếu phù hợp'}
                        </p>
                        {!version.closed_at && (
                          <Button
                            variant="outline"
                            onClick={() =>
                              confirm({
                                title: 'Đóng phiên bản ' + version.version + '?',
                                description:
                                  'Các bản nháp đang gắn với phiên bản này sẽ không gửi được; người trả lời cần tạo phiếu mới.',
                                action: async (reason) => {
                                  await write(
                                    '/' + selected + '/versions/' + version.id + '/close',
                                    { expectedRevision: detail.form.revision },
                                    reason,
                                  );
                                  await changed();
                                },
                              })
                            }
                          >
                            Đóng phiên bản {version.version}
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                  {!detail.versions.length && <p>Chưa có phiên bản đã xuất bản.</p>}
                </TabsContent>
              )}
              {can(me, tenantId, 'forms:respond') && (
                <TabsContent value="respond" className="mt-6">
                  <RespondPanel
                    key={detail.form.id}
                    detail={detail}
                    lookup={lookup}
                    me={me}
                    tenantId={tenantId}
                    confirm={confirm}
                    notify={notify}
                    onDirtyChange={setDirty}
                  />
                </TabsContent>
              )}
              {can(me, tenantId, 'forms:review') && (
                <TabsContent value="review" className="mt-6">
                  <ReportsPanel
                    detail={detail}
                    lookup={lookup}
                    me={me}
                    tenantId={tenantId}
                    mode="review"
                    exportAllowed={can(me, tenantId, 'forms:export')}
                    confirm={confirm}
                  />
                </TabsContent>
              )}
              {can(me, tenantId, 'forms:analyze') && (
                <TabsContent value="analyze" className="mt-6">
                  <ReportsPanel
                    detail={detail}
                    lookup={lookup}
                    me={me}
                    tenantId={tenantId}
                    mode="analyze"
                    exportAllowed={can(me, tenantId, 'forms:export')}
                    confirm={confirm}
                  />
                </TabsContent>
              )}
              {(scopedDesign || scopedPublish) && (
                <TabsContent value="history" className="mt-6">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Thời điểm</TableHead>
                        <TableHead>Thao tác</TableHead>
                        <TableHead>Lý do</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map((row) => (
                        <TableRow key={String(row.id)}>
                          <TableCell>
                            {new Date(String(row.occurred_at)).toLocaleString('vi-VN')}
                          </TableCell>
                          <TableCell>{String(row.action)}</TableCell>
                          <TableCell>{String(row.reason)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TabsContent>
              )}
            </Tabs>
          </>
        )}
        <footer className="border-t pt-5 text-xs text-muted-foreground">
          TLQM AIO · Biểu mẫu có đăng nhập và định danh · Môi trường thử nội bộ
        </footer>
      </main>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            createTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Tạo biểu mẫu nội bộ</DialogTitle>
            <DialogDescription>
              Bắt đầu từ bản nháp, sau đó thêm câu hỏi và giao cho người nhận.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="create-name">Tên biểu mẫu</Label>
              <Input
                id="create-name"
                required
                maxLength={200}
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-code">Mã biểu mẫu</Label>
              <Input
                id="create-code"
                required
                pattern="[a-z][a-z0-9-]{2,50}"
                maxLength={51}
                value={createCode}
                onChange={(event) => setCreateCode(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                3–51 ký tự: chữ thường, số và dấu gạch nối. Ví dụ: khao-sat-so-hoa.
              </p>
            </div>
            <Choice
              label="Phạm vi quản lý"
              name="create-unit"
              value={createUnit}
              onChange={setCreateUnit}
              options={[
                ...(can(me, tenantId, 'forms:design', null)
                  ? [{ id: '_all', name: 'Toàn không gian được cấp' }]
                  : []),
                ...lookup.units.filter((unit) => can(me, tenantId, 'forms:design', unit.id)),
              ]}
            />
            <div className="space-y-2">
              <Label htmlFor="create-max">Số phiếu tối đa mỗi người</Label>
              <Input
                id="create-max"
                required
                type="number"
                min={1}
                max={100}
                value={createMax}
                onChange={(event) => setCreateMax(Number(event.target.value))}
              />
            </div>
            {createError !== null && (
              <Alert variant="destructive">
                <AlertDescription>{formError(createError)}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Hủy
              </Button>
              <Button type="submit" disabled={busy}>
                Tạo bản nháp
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !confirmBusy) setConfirmation(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
            else document.getElementById('forms-main-title')?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="forms-confirm-reason">Lý do thao tác</Label>
            <Input
              id="forms-confirm-reason"
              minLength={5}
              maxLength={240}
              value={confirmationReason}
              onChange={(event) => setConfirmationReason(event.target.value)}
            />
          </div>
          {confirmationError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{formError(confirmationError)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmBusy}>Hủy</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmBusy || confirmationReason.trim().length < 5}
              onClick={(event) => {
                event.preventDefault();
                if (!confirmation) return;
                setConfirmBusy(true);
                setConfirmationError(null);
                void confirmation
                  .action(confirmationReason)
                  .then(() => setConfirmation(null))
                  .catch(setConfirmationError)
                  .finally(() => setConfirmBusy(false));
              }}
            >
              Xác nhận
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
