import { BookOpen, CheckCircle2, Clock3, Search, SlidersHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

export type LearningStatus = 'all' | 'new' | 'active' | 'done';
export const statuses = {
  all: 'Tất cả trạng thái',
  new: 'Chưa bắt đầu',
  active: 'Đang học',
  done: 'Đã hoàn thành',
};
export function progressStatus(
  watched: number | null,
  finished: number | null,
): Exclude<LearningStatus, 'all'> {
  return finished ? 'done' : (watched ?? 0) > 0 ? 'active' : 'new';
}
export function minutes(seconds: number | null) {
  const safe = Math.max(0, Math.round(seconds ?? 0));
  return safe < 60
    ? `${safe} giây`
    : `${Math.floor(safe / 60)} phút${safe % 60 ? ` ${safe % 60} giây` : ''}`;
}
export function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Chưa ghi nhận' : date.toLocaleDateString('vi-VN');
}
export function normalized(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLocaleLowerCase('vi-VN');
}
export function StatusBadge({
  watched,
  finished,
}: {
  watched: number | null;
  finished: number | null;
}) {
  const status = progressStatus(watched, finished);
  const Icon = status === 'done' ? CheckCircle2 : status === 'active' ? Clock3 : BookOpen;
  return (
    <Badge
      variant="outline"
      className={
        status === 'done' ? 'status-success' : status === 'active' ? 'status-info' : 'bg-muted'
      }
    >
      <Icon aria-hidden="true" />
      {statuses[status]}
    </Badge>
  );
}
export function ProgressMeter({
  watched,
  duration,
  label,
  caption = 'Thời lượng đã xem',
}: {
  watched: number | null;
  duration: number | null;
  label: string;
  caption?: string;
}) {
  const value =
    duration && duration > 0
      ? Math.min(100, Math.max(0, Math.round(((watched ?? 0) / duration) * 100)))
      : 0;
  return (
    <div className="space-y-2">
      <div className="flex justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{caption}</span>
        <span className="font-medium">
          {duration && duration > 0 ? `${value}%` : 'Chưa có thời lượng'}
        </span>
      </div>
      <progress
        aria-label={label}
        value={value}
        max={100}
        className="block h-2 w-full overflow-hidden rounded-full bg-secondary [&::-webkit-progress-bar]:bg-secondary [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
      />
    </div>
  );
}
export function Metric({
  label,
  value,
  icon: Icon,
  description,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  description?: string;
}) {
  return (
    <Card size="sm" className="shadow-none">
      <CardContent className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--brand-navy)]">
            {value}
          </p>
          {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
        </div>
        <span className="rounded-md bg-secondary p-2.5 text-primary">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      </CardContent>
    </Card>
  );
}
export function Filters({
  search,
  onSearch,
  status,
  onStatus,
  label,
  placeholder,
  children,
}: {
  search: string;
  onSearch: (value: string) => void;
  status: LearningStatus;
  onStatus: (value: LearningStatus) => void;
  label: string;
  placeholder: string;
  children?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1 basis-60 space-y-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground"
          />
          <Input
            id={id}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={placeholder}
            className="pl-10"
          />
        </div>
      </div>
      <div className="w-full space-y-2 sm:w-52">
        <Label htmlFor={id + '-status'}>Trạng thái học tập</Label>
        <Select value={status} onValueChange={(value) => onStatus(value as LearningStatus)}>
          <SelectTrigger id={id + '-status'} className="w-full">
            <SlidersHorizontal aria-hidden="true" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(statuses).map(([value, name]) => (
              <SelectItem key={value} value={value}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {children}
    </div>
  );
}
export function Empty({
  title,
  detail,
  reset,
}: {
  title: string;
  detail: string;
  reset?: () => void;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed bg-card px-6 py-12 text-center">
      <span className="mb-4 rounded-full bg-secondary p-4">
        <BookOpen className="size-6 text-primary" aria-hidden="true" />
      </span>
      <p className="font-semibold text-[var(--brand-navy)]">{title}</p>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">{detail}</p>
      {reset && (
        <Button variant="outline" className="mt-5" onClick={reset}>
          Xóa bộ lọc
        </Button>
      )}
    </div>
  );
}
