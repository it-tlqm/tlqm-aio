import { ChevronLeft, ChevronRight, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { allowed } from '@/lib/api';
import type { Me, Row } from '@/lib/api';
import { resourceByKey } from '@/lib/resources';
import { lifecycle } from './model';
export type Edit = (resource: string, row?: Row, defaults?: Row) => void;
export type ViewProps = { me: Me; tenantId: string; edit: Edit };
export function StateBadge({ row }: { row: Row }) {
  const state = lifecycle(row);
  return (
    <Badge
      className={
        state === 'current'
          ? 'status-success'
          : state === 'future'
            ? 'status-info'
            : 'status-warning'
      }
    >
      {state === 'current' ? 'Đang hiệu lực' : state === 'future' ? 'Sắp hiệu lực' : 'Đã ngừng'}
    </Badge>
  );
}
export function Stats({
  items,
}: {
  items: { label: string; value: number | string; hint?: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label} className="gap-0 py-0">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{item.label}</p>
            <p className="mt-2 text-2xl font-semibold text-secondary-foreground">{item.value}</p>
            {item.hint && <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
export function EditButton({
  resource,
  row,
  me,
  tenantId,
  edit,
}: ViewProps & { resource: string; row: Row }) {
  const forbidden =
    !allowed(me, tenantId, resourceByKey[resource]!.write) ||
    row.protected ||
    row.isProtected ||
    (resource === 'accounts' && row.id === me.accountId) ||
    (['bindings', 'grants'].includes(resource) && row.accountId === me.accountId);
  return (
    <Button
      variant="outline"
      size="icon"
      disabled={!!forbidden}
      aria-label={'Sửa ' + String(row.name ?? row.displayName ?? row.employeeCode ?? 'bản ghi')}
      onClick={() => edit(resource, row)}
    >
      <Pencil className="size-4" />
    </Button>
  );
}
export function Paging({
  page,
  total,
  size = 12,
  onPage,
}: {
  page: number;
  total: number;
  size?: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size)),
    current = Math.min(page, pages - 1);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      <span>
        {total} kết quả · Trang {current + 1}/{pages}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Trang trước"
          disabled={current === 0}
          onClick={() => onPage(current - 1)}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Trang sau"
          disabled={current === pages - 1}
          onClick={() => onPage(current + 1)}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
export function Period({ row }: { row: Row }) {
  const date = (value: unknown) => new Date(String(value)).toLocaleDateString('vi-VN');
  return (
    <span className="text-xs text-muted-foreground">
      {row.validFrom ? date(row.validFrom) : 'Không giới hạn'} →{' '}
      {row.validUntil ? date(row.validUntil) : 'Không thời hạn'}
    </span>
  );
}
