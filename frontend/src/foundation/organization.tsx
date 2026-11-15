import { useState } from 'react';
import { Building2, ChevronDown, ChevronRight, GitBranch, Plus, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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
import { canRead } from './data';
import { byName, childrenOf, currentMembers, find, label, normalize } from './model';
import type { DirectoryData } from './model';
import { EditButton, Paging, StateBadge, Stats } from './common';
import type { ViewProps } from './common';

export function OrganizationView({
  data,
  me,
  tenantId,
  edit,
  openPerson,
}: ViewProps & { data: DirectoryData; openPerson: (id: string) => void }) {
  const [entityId, setEntityId] = useState('all'),
    [query, setQuery] = useState(''),
    [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState(''),
    [closed, setClosed] = useState(new Set<string>()),
    [descendants, setDescendants] = useState(false),
    [page, setPage] = useState(0);
  const units = (data['org-units'] ?? [])
    .filter(
      (row) =>
        (entityId === 'all' || row.legalEntityId === entityId) &&
        (showInactive || row.active !== false),
    )
    .sort(byName);
  const selectedUnit = units.find((row) => row.id === selected),
    visibleIds = new Set(units.map((row) => String(row.id)));
  const unitIds = selectedUnit
    ? descendants
      ? childrenOf(units, selected)
      : new Set([selected])
    : visibleIds;
  const peopleVisible = canRead(me, tenantId, 'people');
  const members = currentMembers(data, unitIds);
  const positions = (data.positions ?? [])
    .filter((row) => unitIds.has(String(row.orgUnitId)) && (showInactive || row.active !== false))
    .sort(byName);
  const countUnits = units.filter((row) => row.active !== false).length;
  const search = normalize(query),
    matches = new Set(
      units
        .filter((row) => normalize(row.name + ' ' + row.code).includes(search))
        .map((row) => String(row.id)),
    );
  const included = new Set(matches);
  for (const id of matches) {
    const visited = new Set<string>();
    let row = units.find((item) => item.id === id);
    while (row?.parentId && !visited.has(String(row.parentId))) {
      const parentId = String(row.parentId);
      visited.add(parentId);
      included.add(parentId);
      row = units.find((item) => item.id === parentId);
    }
  }
  function choose(id: string) {
    setSelected(id);
    setPage(0);
  }
  function branch(row: Row, ancestry = new Set<string>()) {
    const id = String(row.id);
    if (ancestry.has(id) || !included.has(id)) return null;
    const next = new Set([...ancestry, id]),
      children = units.filter((unit) => unit.parentId === id && included.has(String(unit.id)));
    const expanded = !!search || !closed.has(id);
    return (
      <li key={id} className="min-w-0">
        <div className="flex min-w-0 items-center gap-1">
          {children.length ? (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label={(expanded ? 'Thu gọn ' : 'Mở rộng ') + String(row.name)}
              aria-expanded={expanded}
              onClick={() =>
                setClosed((previous) => {
                  const result = new Set(previous);
                  if (expanded) result.add(id);
                  else result.delete(id);
                  return result;
                })
              }
            >
              {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </Button>
          ) : (
            <span className="w-11 shrink-0" aria-hidden="true" />
          )}
          <Button
            variant="ghost"
            className={
              'h-auto min-h-11 min-w-0 flex-1 justify-start whitespace-normal px-2 py-2 text-left ' +
              (selected === id ? 'nav-current' : '')
            }
            aria-pressed={selected === id}
            onClick={() => choose(id)}
          >
            <Building2 className="size-4 shrink-0" />
            <span className="min-w-0 break-words">
              {String(row.name)}
              {row.active === false && (
                <span className="ml-2 text-xs text-muted-foreground">Đã ngừng</span>
              )}
            </span>
          </Button>
        </div>
        {children.length > 0 && expanded && (
          <ul className="ml-4 border-l pl-1">{children.map((child) => branch(child, next))}</ul>
        )}
      </li>
    );
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Bộ máy tổ chức</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Xem các đơn vị, vị trí và nhân sự đang công tác trong phạm vi được cấp.
          </p>
        </div>
        {allowed(me, tenantId, 'directory:manage') && (
          <Button
            onClick={() =>
              edit('org-units', undefined, entityId === 'all' ? {} : { legalEntityId: entityId })
            }
          >
            <Plus className="size-4" />
            Thêm đơn vị
          </Button>
        )}
      </div>
      <Stats
        items={[
          {
            label: 'Pháp nhân',
            value: (data['legal-entities'] ?? []).filter(
              (row) => row.active !== false && (entityId === 'all' || row.id === entityId),
            ).length,
          },
          { label: 'Đơn vị hoạt động', value: countUnits },
          {
            label: 'Vị trí hoạt động',
            value: positions.filter((row) => row.active !== false).length,
            hint: selectedUnit ? 'Trong đơn vị đang chọn' : 'Trong phạm vi đang xem',
          },
          {
            label: 'Nhân sự đang công tác',
            value: peopleVisible ? members.people.length : '—',
            hint: peopleVisible
              ? 'Không cộng lặp người kiêm nhiệm'
              : 'Chưa được cấp quyền xem nhân sự',
          },
        ]}
      />
      <div className="grid items-start gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="size-5" />
              Cây đơn vị
            </CardTitle>
            <CardDescription>Chọn một đơn vị để xem chi tiết.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 px-3 pb-4">
            <Select
              value={entityId}
              onValueChange={(value) => {
                setEntityId(value);
                choose('');
              }}
            >
              <SelectTrigger className="w-full" aria-label="Lọc pháp nhân">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả pháp nhân</SelectItem>
                {(data['legal-entities'] ?? []).sort(byName).map((row) => (
                  <SelectItem key={String(row.id)} value={String(row.id)}>
                    {String(row.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute left-3 top-3.5 size-4 text-muted-foreground" />
              <Input
                aria-label="Tìm đơn vị"
                placeholder="Tên hoặc mã đơn vị…"
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <Checkbox
                checked={showInactive}
                onCheckedChange={(value) => setShowInactive(value === true)}
              />
              Hiện đơn vị đã ngừng
            </label>
            <Button
              className={'w-full justify-start ' + (!selectedUnit ? 'nav-current' : '')}
              variant="ghost"
              aria-pressed={!selectedUnit}
              onClick={() => choose('')}
            >
              <Building2 className="size-4" />
              Toàn bộ cơ cấu
            </Button>
            <nav aria-label="Cây cơ cấu tổ chức" className="max-h-[560px] overflow-y-auto">
              <ul>
                {units
                  .filter((row) => !row.parentId || !visibleIds.has(String(row.parentId)))
                  .map((row) => branch(row))}
              </ul>
              {!matches.size && (
                <p className="px-3 py-8 text-sm text-muted-foreground">Không có đơn vị phù hợp.</p>
              )}
            </nav>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {selectedUnit ? String(selectedUnit.code) : 'Trong phạm vi được cấp'}
                </p>
                <CardTitle className="text-xl">
                  {selectedUnit ? String(selectedUnit.name) : 'Toàn bộ cơ cấu'}
                </CardTitle>
                <CardDescription className="mt-2">
                  {selectedUnit
                    ? label(data, 'legal-entities', selectedUnit.legalEntityId)
                    : 'Chọn đơn vị bên trái hoặc xem danh sách tổng hợp bên dưới.'}
                </CardDescription>
              </div>
              {selectedUnit && (
                <div className="flex items-center gap-2">
                  <StateBadge row={selectedUnit} />
                  <EditButton
                    resource="org-units"
                    row={selectedUnit}
                    me={me}
                    tenantId={tenantId}
                    edit={edit}
                  />
                </div>
              )}
            </div>
            {selectedUnit && (
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <Checkbox
                    checked={descendants}
                    onCheckedChange={(value) => {
                      setDescendants(value === true);
                      setPage(0);
                    }}
                  />
                  Gồm đơn vị trực thuộc
                </label>
                {allowed(me, tenantId, 'directory:manage') && selectedUnit.active !== false && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() =>
                        edit('org-units', undefined, {
                          legalEntityId: selectedUnit.legalEntityId,
                          parentId: selectedUnit.id,
                        })
                      }
                    >
                      <Plus className="size-4" />
                      Thêm đơn vị con
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        edit('positions', undefined, {
                          legalEntityId: selectedUnit.legalEntityId,
                          orgUnitId: selectedUnit.id,
                        })
                      }
                    >
                      <Plus className="size-4" />
                      Thêm vị trí
                    </Button>
                  </>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="positions" onValueChange={() => setPage(0)}>
              <TabsList>
                <TabsTrigger value="positions">Vị trí ({positions.length})</TabsTrigger>
                {peopleVisible && (
                  <TabsTrigger value="members">Nhân sự ({members.people.length})</TabsTrigger>
                )}
              </TabsList>
              <TabsContent value="positions" className="space-y-4 pt-3">
                <Table
                  containerProps={{
                    tabIndex: 0,
                    role: 'region',
                    'aria-label': 'Vị trí trong cơ cấu',
                  }}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>Vị trí / chức danh</TableHead>
                      <TableHead>Đơn vị</TableHead>
                      <TableHead>Nhân sự</TableHead>
                      <TableHead>
                        <span className="sr-only">Thao tác</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {positions
                      .slice(
                        Math.min(page, Math.max(0, Math.ceil(positions.length / 12) - 1)) * 12,
                        (Math.min(page, Math.max(0, Math.ceil(positions.length / 12) - 1)) + 1) *
                          12,
                      )
                      .map((position) => (
                        <TableRow key={String(position.id)}>
                          <TableCell className="min-w-40">
                            <p className="font-medium">{String(position.name)}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {label(data, 'job-titles', position.jobTitleId)}
                            </p>
                            {position.active === false && <StateBadge row={position} />}
                          </TableCell>
                          <TableCell className="min-w-32">
                            {label(data, 'org-units', position.orgUnitId)}
                          </TableCell>
                          <TableCell>
                            {peopleVisible
                              ? new Set(
                                  members.assignments
                                    .filter((a) => a.positionId === position.id)
                                    .map(
                                      (a) => find(data, 'employments', a.employmentId)?.personId,
                                    ),
                                ).size
                              : '—'}
                          </TableCell>
                          <TableCell>
                            <EditButton
                              resource="positions"
                              row={position}
                              me={me}
                              tenantId={tenantId}
                              edit={edit}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    {!positions.length && (
                      <TableRow>
                        <TableCell colSpan={4} className="h-28 text-center text-muted-foreground">
                          Chưa có vị trí trong phạm vi đang xem.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                <Paging page={page} total={positions.length} onPage={setPage} />
              </TabsContent>
              <TabsContent value="members" className="space-y-3 pt-3">
                {members.people.slice(page * 12, (page + 1) * 12).map((person) => (
                  <div
                    key={String(person.id)}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                  >
                    <div className="min-w-0">
                      <p className="break-words font-medium">{String(person.displayName)}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {members.assignments
                          .filter(
                            (a) =>
                              find(data, 'employments', a.employmentId)?.personId === person.id,
                          )
                          .map((a) => (
                            <Badge key={String(a.id)} variant="secondary">
                              {label(data, 'positions', a.positionId)} ·{' '}
                              {a.isPrimary ? 'Chính' : 'Kiêm nhiệm'}
                            </Badge>
                          ))}
                      </div>
                    </div>
                    <Button variant="outline" onClick={() => openPerson(String(person.id))}>
                      <Users className="size-4" />
                      Xem hồ sơ
                    </Button>
                  </div>
                ))}
                {!members.people.length && (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    Chưa có nhân sự đang công tác trong phạm vi đang xem.
                  </p>
                )}
                <Paging page={page} total={members.people.length} onPage={setPage} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
