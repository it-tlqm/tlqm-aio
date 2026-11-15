import { useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, KeyRound, Plus, Search, ShieldCheck, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
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
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { allowed } from '@/lib/api';
import type { Row } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { CopyRouteButton } from '@/components/copy-route-button';
import { parsePeopleRoute, peopleRoute } from '@/lib/directory-route';
import { canRead, useDirectoryData } from './data';
import { byName, currentAssignments, effective, find, label, normalize, rowLabel } from './model';
import type { DirectoryData } from './model';
import { EditButton, Paging, Period, StateBadge, Stats } from './common';
import type { ViewProps } from './common';

function groupRows(rows: Row[], key: (row: Row) => unknown) {
  const groups = new Map<unknown, Row[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

export function PeopleView({
  data,
  me,
  tenantId,
  edit,
  initialPersonId,
  applications,
  version,
  onIdentity,
}: ViewProps & {
  data: DirectoryData;
  initialPersonId?: string;
  applications: Row[];
  version: number;
  onIdentity: () => void;
}) {
  const initialRoute = parsePeopleRoute(location.hash);
  const [query, setQuery] = useState(''),
    [unit, setUnit] = useState('all'),
    [state, setState] = useState<'active' | 'inactive' | 'all'>('active'),
    [page, setPage] = useState(0),
    [personId, setPersonId] = useState<string | null>(initialPersonId ?? null);
  useEffect(() => {
    if (!initialRoute) return;
    setQuery(initialRoute.query);
    setUnit(initialRoute.unit);
    setState(initialRoute.state);
    setPage(initialRoute.page);
  }, []);
  useEffect(() => {
    const update = () => {
      const route = parsePeopleRoute(location.hash);
      if (!route) return;
      setQuery(route.query);
      setUnit(route.unit);
      setState(route.state);
      setPage(route.page);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const profileTrigger = useRef<HTMLElement | null>(null),
    root = useRef<HTMLDivElement>(null),
    openingEditor = useRef(false);
  useEffect(() => {
    if (initialPersonId) setPersonId(initialPersonId);
  }, [initialPersonId]);
  const { people, accounts, assignments, employments, searchText, positions } = useMemo(() => {
    const people = [...(data.people ?? [])].sort(byName);
    const employmentById = new Map((data.employments ?? []).map((row) => [row.id, row]));
    const positions = new Map((data.positions ?? []).map((row) => [row.id, row]));
    const employments = groupRows(data.employments ?? [], (row) => row.personId);
    const assignments = groupRows(
      currentAssignments(data),
      (row) => employmentById.get(row.employmentId)?.personId,
    );
    const accounts = groupRows(data.accounts ?? [], (row) => row.personId);
    const searchText = new Map(
      people.map((person) => [
        person.id,
        normalize(
          [
            person.displayName,
            ...(employments.get(person.id) ?? []).map((row) => row.employeeCode),
            ...(assignments.get(person.id) ?? []).map((row) =>
              rowLabel(positions.get(row.positionId)),
            ),
          ].join(' '),
        ),
      ]),
    );
    return { people, accounts, assignments, employments, searchText, positions };
  }, [data]);
  const accountsReadable = canRead(me, tenantId, 'accounts');
  const normalizedQuery = normalize(query);
  const searched = people.filter((person) => {
    if (state !== 'all' && (person.active === false) !== (state === 'inactive')) return false;
    if (
      unit !== 'all' &&
      !assignments.get(person.id)?.some((row) => positions.get(row.positionId)?.orgUnitId === unit)
    )
      return false;
    return searchText.get(person.id)!.includes(normalizedQuery);
  });
  const currentPage = Math.min(page, Math.max(0, Math.ceil(searched.length / 12) - 1)),
    selected = people.find((row) => row.id === personId);
  useEffect(() => {
    if (!location.hash.startsWith('#people')) return;
    const next = peopleRoute({
      tab: parsePeopleRoute(location.hash)?.tab ?? 'overview',
      query,
      unit,
      state,
      page: currentPage,
    });
    if (location.hash !== next) window.history.replaceState(null, '', next);
  }, [query, unit, state, currentPage]);
  const personAccounts = selected ? (accounts.get(selected.id) ?? []) : [];
  const personEmployments = [...(selected ? (employments.get(selected.id) ?? []) : [])].sort(
    (a, b) => String(b.validFrom).localeCompare(String(a.validFrom)),
  );
  const modify = (...args: Parameters<typeof edit>) => {
    openingEditor.current = true;
    setPersonId(null);
    edit(...args);
  };
  return (
    <div ref={root} tabIndex={-1} className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Danh bạ nhân sự</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Hồ sơ, quá trình công tác và tài khoản của từng người.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyRouteButton />
          {allowed(me, tenantId, 'people:manage') && (
            <Button onClick={() => edit('people')}>
              <Plus className="size-4" />
              Thêm hồ sơ
            </Button>
          )}
        </div>
      </div>
      <Stats
        items={[
          { label: 'Hồ sơ trong phạm vi', value: people.length },
          {
            label: 'Nhân sự hoạt động',
            value: people.filter((row) => row.active !== false).length,
          },
          {
            label: 'Đang được bố trí',
            value: people.filter((row) => assignments.has(row.id)).length,
          },
          {
            label: 'Tài khoản hoạt động',
            value: accountsReadable
              ? (data.accounts ?? []).filter(
                  (row) =>
                    row.active !== false && find(data, 'people', row.personId)?.active !== false,
                ).length
              : '—',
            hint: accountsReadable
              ? 'Tài khoản được quản lý tại AIO'
              : 'Chưa được cấp quyền xem tài khoản',
          },
        ]}
      />
      <Card className="min-w-0">
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(150px,220px)_160px]">
            <div className="relative">
              <Search className="absolute left-3 top-3.5 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                aria-label="Tìm nhân sự"
                placeholder="Họ tên, mã nhân sự hoặc vị trí…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </div>
            <Select
              value={unit}
              onValueChange={(value) => {
                setUnit(value);
                setPage(0);
              }}
            >
              <SelectTrigger className="w-full" aria-label="Lọc đơn vị nhân sự">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả đơn vị</SelectItem>
                {(data['org-units'] ?? [])
                  .filter((row) => row.active !== false)
                  .sort(byName)
                  .map((row) => (
                    <SelectItem key={String(row.id)} value={String(row.id)}>
                      {String(row.name)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Select
              value={state}
              onValueChange={(value) => {
                setState(value as 'active' | 'inactive' | 'all');
                setPage(0);
              }}
            >
              <SelectTrigger className="w-full" aria-label="Lọc trạng thái nhân sự">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Đang hoạt động</SelectItem>
                <SelectItem value="inactive">Đã ngừng</SelectItem>
                <SelectItem value="all">Tất cả trạng thái</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              disabled={!query && unit === 'all' && state === 'active'}
              onClick={() => {
                setQuery('');
                setUnit('all');
                setState('active');
                setPage(0);
              }}
            >
              Xóa bộ lọc
            </Button>
          </div>
          <Table containerProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Danh bạ nhân sự' }}>
            <TableHeader>
              <TableRow>
                <TableHead>Nhân sự</TableHead>
                <TableHead>Vị trí & đơn vị hiện tại</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Tài khoản</TableHead>
                <TableHead>
                  <span className="sr-only">Hồ sơ</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {searched.slice(currentPage * 12, (currentPage + 1) * 12).map((person) => {
                const positions = assignments.get(person.id) ?? [],
                  codes = (employments.get(person.id) ?? [])
                    .filter((row) => effective(row))
                    .map((row) => row.employeeCode);
                return (
                  <TableRow key={String(person.id)}>
                    <TableCell className="min-w-44">
                      <p className="font-medium">{String(person.displayName)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {codes.length ? codes.join(' · ') : 'Chưa có mã công tác hiện hành'}
                      </p>
                    </TableCell>
                    <TableCell className="min-w-48">
                      {positions.length ? (
                        positions.map((a) => (
                          <div key={String(a.id)} className="my-1">
                            <p className="text-sm">
                              {label(data, 'positions', a.positionId)}
                              {!a.isPrimary && (
                                <Badge variant="secondary" className="ml-2">
                                  Kiêm nhiệm
                                </Badge>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {label(
                                data,
                                'org-units',
                                find(data, 'positions', a.positionId)?.orgUnitId,
                              )}
                            </p>
                          </div>
                        ))
                      ) : (
                        <span className="text-muted-foreground">Chưa có bổ nhiệm hiện hành</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StateBadge row={person} />
                    </TableCell>
                    <TableCell>
                      {accountsReadable
                        ? (accounts.get(person.id) ?? []).filter((row) => row.active !== false)
                            .length
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        aria-label={'Xem hồ sơ ' + String(person.displayName)}
                        onClick={(event) => {
                          profileTrigger.current = event.currentTarget;
                          openingEditor.current = false;
                          setPersonId(String(person.id));
                        }}
                      >
                        Xem hồ sơ
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!searched.length && (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    Không có nhân sự phù hợp.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Paging page={currentPage} total={searched.length} onPage={setPage} />
        </CardContent>
      </Card>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setPersonId(null);
        }}
      >
        <SheetContent
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (openingEditor.current) return;
            if (profileTrigger.current?.isConnected) profileTrigger.current.focus();
            else root.current?.focus();
          }}
        >
          <SheetHeader className="border-b pr-14">
            <div className="flex items-center gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                <UserRound className="size-6" />
              </div>
              <div>
                <SheetTitle className="break-words">
                  {String(selected?.displayName ?? '')}
                </SheetTitle>
                <SheetDescription>
                  Hồ sơ nhân sự và quyền truy cập được quản lý riêng.
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
          {selected && (
            <div className="space-y-6 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <StateBadge row={selected} />
                <EditButton
                  resource="people"
                  row={selected}
                  me={me}
                  tenantId={tenantId}
                  edit={modify}
                />
              </div>
              <section className="space-y-3" aria-label="Quá trình công tác">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">Quá trình công tác</h3>
                  {allowed(me, tenantId, 'people:manage') && (
                    <Button
                      variant="outline"
                      onClick={() => modify('employments', undefined, { personId: selected.id })}
                    >
                      <Plus className="size-4" />
                      Thêm quan hệ công tác
                    </Button>
                  )}
                </div>
                {personEmployments.map((employment) => (
                  <div key={String(employment.id)} className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">
                          {label(data, 'legal-entities', employment.legalEntityId)}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {String(employment.employeeCode)}
                        </p>
                        <Period row={employment} />
                      </div>
                      <EditButton
                        resource="employments"
                        row={employment}
                        me={me}
                        tenantId={tenantId}
                        edit={modify}
                      />
                    </div>
                    <StateBadge row={employment} />
                    {(data.assignments ?? [])
                      .filter((row) => row.employmentId === employment.id)
                      .sort((a, b) => String(b.validFrom).localeCompare(String(a.validFrom)))
                      .map((a) => (
                        <div
                          key={String(a.id)}
                          className="flex items-start justify-between gap-2 rounded-lg bg-muted p-3"
                        >
                          <div>
                            <p className="font-medium">{label(data, 'positions', a.positionId)}</p>
                            <p className="my-1 text-xs text-muted-foreground">
                              {label(
                                data,
                                'org-units',
                                find(data, 'positions', a.positionId)?.orgUnitId,
                              )}{' '}
                              · {a.isPrimary ? 'Vị trí chính' : 'Kiêm nhiệm'}
                            </p>
                            <Period row={a} />
                            <div className="mt-2">
                              <StateBadge row={a} />
                            </div>
                          </div>
                          <EditButton
                            resource="assignments"
                            row={a}
                            me={me}
                            tenantId={tenantId}
                            edit={modify}
                          />
                        </div>
                      ))}
                    {allowed(me, tenantId, 'people:manage') && effective(employment) && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          modify('assignments', undefined, {
                            legalEntityId: employment.legalEntityId,
                            employmentId: employment.id,
                            isPrimary: !(assignments.get(selected.id) ?? []).some(
                              (row) => row.employmentId === employment.id && row.isPrimary,
                            ),
                          })
                        }
                      >
                        <Plus className="size-4" />
                        Bổ nhiệm / kiêm nhiệm
                      </Button>
                    )}
                  </div>
                ))}
                {!personEmployments.length && (
                  <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                    Chưa có quan hệ công tác trong phạm vi xem.
                  </p>
                )}
              </section>
              {accountsReadable && (
                <section className="space-y-3" aria-label="Tài khoản của nhân sự">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-2 font-semibold">
                      <KeyRound className="size-4" />
                      Tài khoản đăng nhập
                    </h3>
                    {allowed(me, tenantId, 'accounts:manage') &&
                      selected.active !== false &&
                      !personAccounts.length && (
                        <Button
                          variant="outline"
                          onClick={() => modify('accounts', undefined, { personId: selected.id })}
                        >
                          <Plus className="size-4" />
                          Thêm tài khoản
                        </Button>
                      )}
                  </div>
                  {personAccounts.map((account) => (
                    <div key={String(account.id)} className="space-y-3 rounded-lg border p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">
                            Tài khoản AIO · {String(account.id).slice(-8)}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {account.mfaRequired
                              ? 'Bắt buộc xác thực MFA'
                              : 'MFA được kiểm theo quyền hiện hành'}
                          </p>
                        </div>
                        <EditButton
                          resource="accounts"
                          row={account}
                          me={me}
                          tenantId={tenantId}
                          edit={modify}
                        />
                      </div>
                      <StateBadge row={account} />
                      {account.isProtected === true && (
                        <Badge variant="secondary" className="ml-2">
                          Tài khoản được bảo vệ
                        </Badge>
                      )}
                    </div>
                  ))}
                  {!personAccounts.length && (
                    <p className="text-sm text-muted-foreground">
                      Chưa có tài khoản AIO. Tạo hồ sơ tài khoản rồi xác minh liên kết SSO ở mục
                      Định danh & vòng đời.
                    </p>
                  )}
                  {allowed(me, tenantId, 'identity:link') && (
                    <Button variant="outline" onClick={onIdentity}>
                      <ShieldCheck className="size-4" />
                      Quản lý định danh SSO
                    </Button>
                  )}
                </section>
              )}
              {personAccounts.length > 0 &&
                applications.length > 0 &&
                (canRead(me, tenantId, 'roles') || canRead(me, tenantId, 'grants')) && (
                  <PersonAccess
                    me={me}
                    tenantId={tenantId}
                    edit={modify}
                    data={data}
                    accounts={personAccounts}
                    applications={applications}
                    version={version}
                  />
                )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
function PersonAccess({
  me,
  tenantId,
  edit,
  data,
  accounts,
  applications,
  version,
}: ViewProps & { data: DirectoryData; accounts: Row[]; applications: Row[]; version: number }) {
  const [appCode, setAppCode] = useState(
    String(
      applications.find((row) => row.code === me.appCode)?.code ??
        applications[0]?.code ??
        me.appCode,
    ),
  );
  const access = useDirectoryData(['roles', 'bindings', 'grants'], me, tenantId, appCode, version),
    ids = new Set(accounts.map((row) => row.id));
  return (
    <section className="space-y-3" aria-label="Quyền ứng dụng của nhân sự">
      <h3 className="flex items-center gap-2 font-semibold">
        <BadgeCheck className="size-4" />
        Quyền theo ứng dụng
      </h3>
      <Select value={appCode} onValueChange={setAppCode}>
        <SelectTrigger className="w-full" aria-label="Ứng dụng trong hồ sơ">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {applications.map((row) => (
            <SelectItem key={String(row.code)} value={String(row.code)}>
              {String(row.name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {access.loading ? (
        <Skeleton className="h-24" />
      ) : access.error ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(access.error)}</AlertDescription>
        </Alert>
      ) : (
        <>
          {!canRead(me, tenantId, 'grants') ? (
            <p className="text-sm text-muted-foreground">
              Chưa được cấp quyền xem trạng thái truy cập ứng dụng.
            </p>
          ) : (
            accounts.map((account) => {
              const grant = (access.data.grants ?? []).find((row) => row.accountId === account.id);
              return (
                <div key={String(account.id)} className="rounded-lg bg-muted p-3">
                  <p className="text-sm font-medium">Tài khoản · {String(account.id).slice(-8)}</p>
                  <p className="mt-1 text-sm">
                    {grant && effective(grant) && grant.accountActive !== false
                      ? 'Đã cấp truy cập ứng dụng'
                      : 'Chưa có quyền truy cập hiện hành'}
                  </p>
                  {Boolean(grant?.validUntil) && <Period row={grant!} />}
                </div>
              );
            })
          )}
          {(access.data.bindings ?? [])
            .filter((row) => ids.has(row.accountId))
            .map((binding) => (
              <div key={String(binding.id)} className="space-y-1 rounded-lg border p-3">
                <p className="font-medium">
                  {String(
                    (access.data.roles ?? []).find((row) => row.code === binding.roleCode)?.name ??
                      binding.roleCode,
                  )}
                </p>
                <p className="text-sm text-muted-foreground">
                  {binding.orgUnitId
                    ? label(data, 'org-units', binding.orgUnitId)
                    : 'Toàn không gian'}
                  {binding.managedAppCode ? ' · Quản trị ' + String(binding.managedAppCode) : ''}
                </p>
                <Period row={binding} />
                <div className="pt-1">
                  <StateBadge row={binding} />
                </div>
              </div>
            ))}
          <p className="text-xs text-muted-foreground">
            Phân công vai trò không thay thế quyền truy cập ứng dụng. Quyền được kiểm lại khi sử
            dụng, gồm trạng thái tài khoản, thời hạn và MFA.
          </p>
        </>
      )}
    </section>
  );
}
