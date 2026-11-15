import { useEffect, useId, useRef, useState } from 'react';
import { Search, X, ChevronDown } from 'lucide-react';
import type { ReferenceAnswer, ReferenceKind } from '../../../src/forms/references';
import { isReferenceAnswer } from '../../../src/forms/references';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/messages';

export type ReferenceContext = { tenantId: string; unitId: string };
type ReferencePage = { items: ReferenceAnswer[]; nextCursor: string | null };
export function ReferencePicker({
  kind,
  value,
  onChange,
  context,
  disabled,
  ...aria
}: {
  kind: ReferenceKind;
  value: unknown;
  onChange: (value: ReferenceAnswer | undefined) => void;
  context?: ReferenceContext;
  disabled?: boolean;
  id: string;
  'aria-labelledby': string;
  'aria-describedby': string;
  'aria-invalid': boolean;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(''),
    [data, setData] = useState<ReferencePage>({ items: [], nextCursor: null }),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const sequence = useRef(0),
    searchId = useId(),
    trigger = useRef<HTMLButtonElement>(null);
  const selected = isReferenceAnswer(value) ? value : undefined;
  const scope = context ? context.tenantId + ':' + context.unitId : '';
  async function load(after?: string) {
    if (!context?.unitId || !open) return;
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    if (!after) setData({ items: [], nextCursor: null });
    try {
      const query = new URLSearchParams({
        tenantId: context.tenantId,
        unitId: context.unitId,
        kind,
        search,
        ...(after ? { after } : {}),
      });
      const result = await api<ReferencePage>('/api/v1/workflows/references?' + query);
      if (request !== sequence.current) return;
      setData((old) => ({
        ...result,
        items: after
          ? [
              ...old.items,
              ...result.items.filter((item) => !old.items.some((p) => p.id === item.id)),
            ]
          : result.items,
      }));
    } catch (e) {
      if (request === sequence.current) {
        setData({ items: [], nextCursor: null });
        setError(errorMessage(e));
      }
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    sequence.current++;
    setData({ items: [], nextCursor: null });
    setError('');
    const timeout = setTimeout(() => {
      void load();
    }, 200);
    return () => {
      sequence.current++;
      clearTimeout(timeout);
    };
  }, [scope, open, search, kind]);
  function choose(item?: ReferenceAnswer) {
    onChange(item);
    setOpen(false);
    if (!open) trigger.current?.focus();
  }
  return (
    <Popover open={open && !disabled && !!context?.unitId} onOpenChange={setOpen}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <PopoverTrigger asChild>
            <Button
              ref={trigger}
              type="button"
              variant="outline"
              {...aria}
              aria-labelledby={aria['aria-labelledby'] + ' ' + aria.id + '-value'}
              disabled={disabled || !context?.unitId}
              className="h-auto min-h-11 min-w-0 flex-1 justify-between text-left font-normal whitespace-normal"
            >
              <span id={aria.id + '-value'} className="min-w-0 break-words">
                {selected?.label || (kind === 'person' ? 'Chọn nhân sự' : 'Chọn đơn vị')}
              </span>
              <ChevronDown className="shrink-0" />
            </Button>
          </PopoverTrigger>
          {selected && !disabled && (
            <Button
              type="button"
              variant="ghost"
              aria-label={kind === 'person' ? 'Bỏ chọn nhân sự' : 'Bỏ chọn đơn vị'}
              onClick={() => choose()}
            >
              <X />
            </Button>
          )}
        </div>
        {open && !disabled && (
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] space-y-2"
            aria-labelledby={aria['aria-labelledby']}
          >
            <div className="relative">
              <Search
                aria-hidden
                className="absolute top-3.5 left-3 size-4 text-muted-foreground"
              />
              <Input
                id={searchId}
                autoFocus
                className="pl-9"
                aria-label={kind === 'person' ? 'Tìm nhân sự' : 'Tìm đơn vị'}
                placeholder="Tìm theo tên…"
                maxLength={100}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {kind === 'person'
                ? 'Nhân sự đang công tác tại đơn vị của hồ sơ.'
                : 'Đơn vị trong phạm vi khởi tạo hoặc xử lý của bạn.'}
            </p>
            <div className="max-h-64 space-y-1 overflow-y-auto" aria-busy={loading}>
              {data.items.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  aria-label={item.label + ' ' + item.id.slice(-8)}
                  variant={item.id === selected?.id ? 'secondary' : 'ghost'}
                  className="h-auto min-h-11 w-full justify-start whitespace-normal text-left"
                  onClick={() => choose(item)}
                >
                  <span>
                    {item.label}{' '}
                    <span className="ml-2 text-xs text-muted-foreground">{item.id.slice(-8)}</span>
                  </span>
                </Button>
              ))}
            </div>
            <p role="status" className="text-sm text-muted-foreground">
              {loading
                ? 'Đang tải danh sách…'
                : !data.items.length && !error
                  ? 'Không có kết quả trong phạm vi hiện tại.'
                  : ''}
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {error && (
              <Button type="button" variant="outline" onClick={() => void load()}>
                Thử lại
              </Button>
            )}
            {data.nextCursor && (
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={() => void load(data.nextCursor!)}
              >
                Tải thêm
              </Button>
            )}
          </PopoverContent>
        )}
        {!context && (
          <p className="text-xs text-muted-foreground">
            Danh sách được tải theo quyền khi nhập hồ sơ.
          </p>
        )}
      </div>
    </Popover>
  );
}
