import { useId } from 'react';
import { Plus, Copy, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Choice, id } from './common';
import type { FormField } from '../../../src/forms/contracts';
import { isTableAnswer, parseTableAnswer } from '../../../src/forms/business';
import type { BusinessColumn, TableAnswer } from '../../../src/forms/business';
const formatted = (value: string | undefined) =>
  value === undefined
    ? '—'
    : new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(
        Number(value),
      );

export function BusinessTable({
  field,
  value,
  onChange,
  disabled = false,
}: {
  field: FormField;
  value: unknown;
  onChange?: (value: TableAnswer) => void;
  disabled?: boolean;
}) {
  const raw = isTableAnswer(value) ? value : { rows: [], totals: {} };
  let computed: TableAnswer | undefined;
  try {
    computed = parseTableAnswer(field.columns!, field.maxRows!, raw, 'draft');
  } catch {
    /* Keep incomplete input editable. */
  }
  const rows = raw.rows;
  const change = (next: TableAnswer['rows']) => onChange?.({ rows: next, totals: {} });
  const columns = field.columns ?? [];
  return (
    <div className="min-w-0 space-y-3" role="group" aria-label={field.label}>
      <div
        className="overflow-x-auto rounded-lg border"
        tabIndex={0}
        role="region"
        aria-label={'Bảng ' + field.label}
      >
        <table className="w-full text-sm">
          <caption className="sr-only">
            {field.label} · {field.currency}
          </caption>
          <thead className="bg-secondary text-left text-[var(--brand-navy)]">
            <tr>
              <th className="p-3" scope="col">
                STT
              </th>
              {columns.map((c) => (
                <th className="min-w-36 p-3" scope="col" key={c.id}>
                  {c.label}
                  {c.required ? ' *' : ''}
                </th>
              ))}
              {onChange && (
                <th className="p-3" scope="col">
                  Thao tác
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr className="border-t align-top" key={row.id}>
                <td className="p-3">{index + 1}</td>
                {columns.map((c) => (
                  <td className="min-w-36 p-2" key={c.id}>
                    {!onChange || c.type === 'calculated' ? (
                      <span className="block min-h-11 py-3 tabular-nums">
                        {c.type === 'text'
                          ? row.cells[c.id] || '—'
                          : formatted(
                              c.type === 'calculated'
                                ? computed?.rows[index]?.cells[c.id]
                                : row.cells[c.id],
                            )}
                      </span>
                    ) : (
                      <Input
                        aria-label={`${field.label} · ${c.label} · Dòng ${index + 1}`}
                        inputMode={c.type === 'text' ? 'text' : 'decimal'}
                        maxLength={c.type === 'text' ? 500 : 20}
                        disabled={disabled}
                        value={row.cells[c.id] ?? ''}
                        onChange={(e) =>
                          change(
                            rows.map((r, i) =>
                              i === index
                                ? { ...r, cells: { ...r.cells, [c.id]: e.target.value } }
                                : r,
                            ),
                          )
                        }
                      />
                    )}
                  </td>
                ))}
                {onChange && (
                  <td className="p-2">
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={disabled || rows.length >= field.maxRows!}
                        aria-label={'Nhân bản dòng ' + (index + 1)}
                        onClick={() =>
                          change([
                            ...rows.slice(0, index + 1),
                            { ...structuredClone(row), id: id('row') },
                            ...rows.slice(index + 1),
                          ])
                        }
                      >
                        <Copy />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={disabled}
                        aria-label={'Xóa dòng ' + (index + 1)}
                        onClick={() => change(rows.filter((_, i) => i !== index))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {computed && columns.some((c) => c.summarize) && (
            <tfoot className="border-t bg-secondary font-semibold">
              <tr>
                <th className="p-3" scope="row">
                  Tổng
                </th>
                {columns.map((c) => (
                  <td className="p-3 tabular-nums" key={c.id}>
                    {c.summarize
                      ? formatted(computed.totals[c.id] ?? '0.00') + ' ' + field.currency
                      : ''}
                  </td>
                ))}
                {onChange && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {!rows.length && <p className="text-sm text-muted-foreground">Chưa có dòng chi tiết.</p>}
      {!computed && (
        <p role="status" className="text-sm text-destructive">
          Kiểm tra số tiền và số lượng; chưa thể tính tổng cho bảng này.
        </p>
      )}
      {onChange && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={disabled || rows.length >= field.maxRows!}
            onClick={() => change([...rows, { id: id('row'), cells: {} }])}
          >
            <Plus />
            Thêm dòng
          </Button>
          <p className="text-xs text-muted-foreground">
            {rows.length}/{field.maxRows} dòng · Số lượng tối đa 3 chữ số thập phân; tiền 2 chữ số.
          </p>
        </div>
      )}
    </div>
  );
}

export function BusinessFieldSettings({
  field,
  onChange,
}: {
  field: FormField;
  onChange: (patch: Partial<FormField>) => void;
}) {
  const prefix = useId();
  const columns = field.columns ?? [];
  const patch = (index: number, value: BusinessColumn) =>
    onChange({ columns: columns.map((c, i) => (i === index ? value : c)) });
  return (
    <fieldset className="space-y-4 rounded-lg border p-4">
      <legend className="px-1 font-medium">Thiết lập nghiệp vụ</legend>
      <Choice
        label="Đơn vị tiền tệ"
        value={field.currency ?? 'VND'}
        options={[
          { id: 'VND', name: 'VND — Việt Nam đồng' },
          { id: 'USD', name: 'USD — Đô la Mỹ' },
        ]}
        onChange={(currency) => onChange({ currency: currency as 'VND' | 'USD' })}
      />
      {field.type === 'table' && (
        <>
          <div className="space-y-2">
            <Label htmlFor={prefix + 'rows'}>Số dòng tối đa (1–100)</Label>
            <Input
              id={prefix + 'rows'}
              type="number"
              min={1}
              max={100}
              value={field.maxRows ?? 50}
              onChange={(e) => onChange({ maxRows: Number(e.target.value) })}
            />
          </div>
          {columns.map((c, index) => (
            <fieldset className="space-y-3 rounded-lg bg-secondary/50 p-3" key={c.id}>
              <legend className="px-1 text-sm font-medium">Cột {index + 1}</legend>
              <div className="space-y-2">
                <Label htmlFor={prefix + c.id}>Tên cột {index + 1}</Label>
                <Input
                  id={prefix + c.id}
                  value={c.label}
                  maxLength={120}
                  onChange={(e) => patch(index, { ...c, label: e.target.value })}
                />
              </div>
              <Choice
                label={'Kiểu cột ' + (index + 1)}
                value={c.type}
                options={[
                  { id: 'text', name: 'Văn bản' },
                  { id: 'quantity', name: 'Số lượng' },
                  { id: 'money', name: 'Số tiền' },
                  { id: 'calculated', name: 'Tính tích hai cột' },
                ]}
                onChange={(type) => {
                  const numeric = columns.filter(
                    (x) => ['money', 'quantity'].includes(x.type) && x.id !== c.id,
                  );
                  patch(index, {
                    id: c.id,
                    label: c.label,
                    type: type as BusinessColumn['type'],
                    required: c.required,
                    ...(type === 'calculated'
                      ? {
                          factors: [
                            numeric[0]?.id ?? '',
                            numeric[1]?.id ?? numeric[0]?.id ?? '',
                          ] as [string, string],
                          summarize: true,
                        }
                      : {}),
                  });
                }}
              />
              {c.type === 'calculated' &&
                [0, 1].map((factor) => (
                  <Choice
                    key={factor}
                    label={`Cột ${index + 1} — Thừa số ${factor + 1}`}
                    value={c.factors?.[factor] ?? ''}
                    options={columns
                      .filter((x) => ['money', 'quantity'].includes(x.type) && x.id !== c.id)
                      .map((x) => ({ id: x.id, name: x.label }))}
                    onChange={(v) =>
                      patch(index, {
                        ...c,
                        factors:
                          factor === 0 ? [v, c.factors?.[1] ?? ''] : [c.factors?.[0] ?? '', v],
                      })
                    }
                  />
                ))}
              <Label
                className="flex min-h-11 items-center gap-3"
                htmlFor={prefix + c.id + 'required'}
              >
                <Checkbox
                  id={prefix + c.id + 'required'}
                  checked={c.required}
                  onCheckedChange={(checked) => patch(index, { ...c, required: checked === true })}
                />
                Bắt buộc tại cột {index + 1}
              </Label>
              {['money', 'calculated'].includes(c.type) && (
                <Label className="flex min-h-11 items-center gap-3" htmlFor={prefix + c.id + 'sum'}>
                  <Checkbox
                    id={prefix + c.id + 'sum'}
                    checked={c.summarize ?? false}
                    onCheckedChange={(checked) =>
                      patch(index, { ...c, summarize: checked === true })
                    }
                  />
                  Cộng tổng cột {index + 1}
                </Label>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={columns.length === 1}
                onClick={() => onChange({ columns: columns.filter((_, i) => i !== index) })}
              >
                <Trash2 />
                Xóa cột {index + 1}
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={columns.length >= 12}
            onClick={() =>
              onChange({
                columns: [
                  ...columns,
                  { id: id('col'), label: 'Cột mới', type: 'text', required: false },
                ],
              })
            }
          >
            <Plus />
            Thêm cột
          </Button>
          <p className="text-xs text-muted-foreground">
            Thành tiền làm tròn từng dòng đến 2 chữ số. Máy chủ tính lại khi lưu/gửi.
          </p>
        </>
      )}
    </fieldset>
  );
}
