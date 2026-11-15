import { useId, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
export function UnitPicker({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(''),
    id = useId();
  const normalize = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase();
  const filtered = options.filter((o) => normalize(o.name).includes(normalize(query)));
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={id}>Tìm đơn vị</Label>
        <Input
          id={id}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Nhập tên đơn vị…"
        />
      </div>
      <p className="text-sm text-muted-foreground" role="status">
        Đã chọn {value.length} đơn vị · {filtered.length} kết quả
      </p>
      <div
        role="region"
        aria-label="Danh sách đơn vị"
        tabIndex={0}
        className="grid max-h-64 gap-x-5 overflow-y-auto rounded-md border border-border p-3 focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-2"
      >
        {filtered.map((o) => (
          <label key={o.id} className="flex min-h-11 items-center gap-3">
            <Checkbox
              disabled={disabled}
              checked={value.includes(o.id)}
              onCheckedChange={(checked) =>
                onChange(checked ? [...value, o.id] : value.filter((id) => id !== o.id))
              }
            />
            <span className="min-w-0 break-words text-sm">{o.name}</span>
          </label>
        ))}
        {!filtered.length && (
          <p className="py-3 text-sm text-muted-foreground">Không tìm thấy đơn vị.</p>
        )}
      </div>
    </div>
  );
}
