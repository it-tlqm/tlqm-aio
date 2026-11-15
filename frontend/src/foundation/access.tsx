import { useState } from 'react';
import { Check, Minus, Plus, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { allowed } from '@/lib/api';
import { canRead } from './data';
import { byName, effective, label, normalize } from './model';
import type { DirectoryData } from './model';
import { EditButton, Paging, Period, StateBadge, Stats } from './common';
import type { ViewProps } from './common';

export function AccessView({ data, me, tenantId, edit }: ViewProps & { data: DirectoryData }) {
  const [query, setQuery] = useState(''),
    [assignmentQuery, setAssignmentQuery] = useState(''),
    [page, setPage] = useState(0),
    [includeInactive, setIncludeInactive] = useState(false);
  const allRoles = [...(data.roles ?? [])].sort(byName),
    roles = allRoles.filter((row) => includeInactive || row.active !== false),
    permissions = (data.permissions ?? []).filter((row) =>
      normalize(row.name + ' ' + row.code).includes(normalize(query)),
    );
  const bindings = (data.bindings ?? []).filter((row) =>
    normalize(
      [
        row.displayName,
        allRoles.find((role) => role.code === row.roleCode)?.name,
        row.roleCode,
        row.orgUnitId ? label(data, 'org-units', row.orgUnitId) : 'Toàn không gian',
      ].join(' '),
    ).includes(normalize(assignmentQuery)),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(bindings.length / 12) - 1));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <ShieldCheck className="size-5" />
            Vai trò và phạm vi truy cập
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Chức danh mô tả công việc. Vai trò quyết định thao tác được phép trong ứng dụng.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {allowed(me, tenantId, 'roles:manage') && (
            <>
              <Button variant="outline" onClick={() => edit('bindings')}>
                <UserPlus className="size-4" />
                Gán vai trò
              </Button>
              <Button onClick={() => edit('roles')}>
                <Plus className="size-4" />
                Thêm vai trò
              </Button>
            </>
          )}
          {allowed(me, tenantId, 'access:manage') && (
            <Button variant="outline" onClick={() => edit('grants')}>
              <Plus className="size-4" />
              Cấp truy cập ứng dụng
            </Button>
          )}
        </div>
      </div>
      <Stats
        items={[
          { label: 'Vai trò hoạt động', value: roles.filter((row) => row.active !== false).length },
          {
            label: 'Quyền trong danh mục',
            value: (data.permissions ?? []).filter((row) => row.active !== false).length,
          },
          {
            label: 'Phân công còn hiệu lực',
            value: (data.bindings ?? []).filter(
              (row) =>
                effective(row) &&
                roles.some((role) => role.code === row.roleCode && role.active !== false),
            ).length,
            hint: 'Tách riêng trạng thái cấp truy cập',
          },
          {
            label: 'Đã cấp truy cập',
            value: canRead(me, tenantId, 'grants')
              ? (data.grants ?? []).filter((row) => effective(row) && row.accountActive !== false)
                  .length
              : '—',
            hint: 'Theo tài khoản trong ứng dụng',
          },
        ]}
      />
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Ma trận vai trò – quyền</CardTitle>
          <CardDescription>
            So sánh cấu hình từng vai trò. Vai trò hoặc quyền đã ngừng không được áp dụng.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-3.5 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              aria-label="Tìm quyền trong ma trận"
              placeholder="Tên hoặc mã quyền…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <Checkbox
              checked={includeInactive}
              onCheckedChange={(value) => setIncludeInactive(value === true)}
            />
            Hiện vai trò đã ngừng
          </label>
          <Table
            containerProps={{
              tabIndex: 0,
              role: 'region',
              'aria-label': 'Ma trận vai trò và quyền',
            }}
          >
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-52">Quyền thao tác</TableHead>
                {roles.map((role) => (
                  <TableHead key={String(role.code)} className="min-w-44">
                    <div className="flex items-start justify-between gap-2 py-2">
                      <div>
                        <p className="font-semibold text-secondary-foreground">
                          {String(role.name)}
                        </p>
                        <p className="mt-1 text-xs">{String(role.code)}</p>
                        <div className="mt-2">
                          <StateBadge row={role} />
                        </div>
                      </div>
                      <EditButton
                        resource="roles"
                        row={role}
                        me={me}
                        tenantId={tenantId}
                        edit={edit}
                      />
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {permissions.map((permission) => (
                <TableRow key={String(permission.code)}>
                  <TableCell>
                    <p className="font-medium">{String(permission.name)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{String(permission.code)}</p>
                    {permission.active === false && (
                      <Badge className="status-warning">Đã ngừng</Badge>
                    )}
                  </TableCell>
                  {roles.map((role) => {
                    const configured =
                        Array.isArray(role.permissions) &&
                        role.permissions.includes(permission.code),
                      active = configured && role.active !== false && permission.active !== false;
                    return (
                      <TableCell key={String(role.code)}>
                        <span
                          className={
                            'inline-flex min-h-11 items-center gap-2 text-sm ' +
                            (active ? 'text-[var(--success)]' : 'text-muted-foreground')
                          }
                        >
                          {active ? <Check className="size-4" /> : <Minus className="size-4" />}
                          {active ? 'Được cấp' : configured ? 'Tạm ngừng' : 'Không cấp'}
                        </span>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {!permissions.length && (
                <TableRow>
                  <TableCell
                    colSpan={roles.length + 1}
                    className="h-28 text-center text-muted-foreground"
                  >
                    Không có quyền phù hợp.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {!roles.length && (
            <p className="text-sm text-muted-foreground">
              Ứng dụng chưa có vai trò. Tạo vai trò từ danh mục quyền rồi phân công cho tài khoản.
            </p>
          )}
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Phân công vai trò</CardTitle>
          <CardDescription>
            Kiểm tra tài khoản, phạm vi đơn vị và thời hạn của từng phân công.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            aria-label="Tìm phân công vai trò"
            className="max-w-md"
            placeholder="Tìm người, vai trò hoặc đơn vị…"
            value={assignmentQuery}
            onChange={(event) => {
              setAssignmentQuery(event.target.value);
              setPage(0);
            }}
          />
          <Table
            containerProps={{
              tabIndex: 0,
              role: 'region',
              'aria-label': 'Phân công vai trò trong ứng dụng',
            }}
          >
            <TableHeader>
              <TableRow>
                <TableHead>Tài khoản</TableHead>
                <TableHead>Vai trò</TableHead>
                <TableHead>Phạm vi</TableHead>
                <TableHead>Hiệu lực</TableHead>
                <TableHead>
                  <span className="sr-only">Thao tác</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.slice(currentPage * 12, (currentPage + 1) * 12).map((binding) => (
                <TableRow key={String(binding.id)}>
                  <TableCell className="min-w-40 font-medium">
                    {String(binding.displayName)}
                  </TableCell>
                  <TableCell className="min-w-32">
                    {String(
                      allRoles.find((row) => row.code === binding.roleCode)?.name ??
                        binding.roleCode,
                    )}
                  </TableCell>
                  <TableCell className="min-w-32">
                    {binding.orgUnitId
                      ? label(data, 'org-units', binding.orgUnitId)
                      : 'Toàn không gian'}
                    {Boolean(binding.managedAppCode) && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Ủy quyền: {String(binding.managedAppCode)}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="min-w-44">
                    <StateBadge row={binding} />
                    <div className="mt-2">
                      <Period row={binding} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <EditButton
                      resource="bindings"
                      row={binding}
                      me={me}
                      tenantId={tenantId}
                      edit={edit}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {!bindings.length && (
                <TableRow>
                  <TableCell colSpan={5} className="h-28 text-center text-muted-foreground">
                    Chưa có phân công phù hợp.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Paging page={currentPage} total={bindings.length} onPage={setPage} />
        </CardContent>
      </Card>
    </div>
  );
}
