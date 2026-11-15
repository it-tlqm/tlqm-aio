import { useId } from 'react';
import type { HumanStep, WorkflowSpec } from '../../../src/workflows/contracts';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { StepInputEditor } from './step-input-editor';
export function FieldAccessEditor({
  spec,
  onChange,
  disabled,
}: {
  spec: WorkflowSpec;
  onChange: (spec: WorkflowSpec) => void;
  disabled: boolean;
}) {
  const prefix = useId(),
    steps = spec.nodes.filter((n): n is HumanStep => 'form' in n);
  const sources = [
    { id: 'input', name: 'Biểu mẫu khởi tạo', schema: spec.input },
    ...steps.flatMap((n) =>
      'form' in n && n.form ? [{ id: n.id, name: n.label, schema: n.form }] : [],
    ),
  ];
  const update = (address: string, readers: string[] | null) => {
    const policies = { ...spec.fieldReaders };
    if (readers === null) delete policies[address];
    else policies[address] = readers;
    onChange({ ...spec, schemaVersion: 5, fieldReaders: policies });
  };
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Quyền xem dữ liệu hồ sơ</CardTitle>
          <CardDescription>
            Người nhập hoặc người được giao bước luôn xem được dữ liệu tại bước của mình. Giới hạn
            dưới đây dành cho các đối tượng còn lại đã có quyền xem hồ sơ. Quyền thiết kế, báo cáo
            hoặc điều phối không tự mở trường bảo mật.
          </CardDescription>
        </CardHeader>
      </Card>
      <StepInputEditor spec={spec} steps={steps} disabled={disabled} onChange={onChange} />
      {sources.map((source) => (
        <Card key={source.id}>
          <CardHeader>
            <CardTitle>{source.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {source.schema.sections
              .flatMap((s) => s.fields)
              .map((field) => {
                const address = source.id + '.' + field.id,
                  readers = spec.fieldReaders?.[address];
                return (
                  <fieldset className="space-y-3 rounded-lg border p-4" key={address}>
                    <legend className="px-1 font-medium">
                      {field.label} {readers && <Badge variant="outline">Bảo mật</Badge>}
                    </legend>
                    <Label htmlFor={prefix + address} className="flex min-h-11 items-center gap-3">
                      <Checkbox
                        id={prefix + address}
                        disabled={disabled}
                        checked={readers !== undefined}
                        onCheckedChange={(checked) => update(address, checked === true ? [] : null)}
                      />
                      Giới hạn người xem
                    </Label>
                    {readers !== undefined && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {[
                          { id: 'owner', name: 'Người khởi tạo' },
                          { id: 'manager', name: 'Điều phối viên có quyền' },
                          ...steps.map((s) => ({ id: s.id, name: 'Người xử lý · ' + s.label })),
                        ]
                          .filter((r) => r.id !== (source.id === 'input' ? 'owner' : source.id))
                          .map((r) => (
                            <Label
                              key={r.id}
                              htmlFor={prefix + address + r.id}
                              className="flex min-h-11 items-center gap-3 rounded-md bg-secondary/40 p-2"
                            >
                              <Checkbox
                                id={prefix + address + r.id}
                                disabled={disabled}
                                checked={readers.includes(r.id)}
                                onCheckedChange={(checked) =>
                                  update(
                                    address,
                                    checked === true
                                      ? [...readers, r.id]
                                      : readers.filter((id) => id !== r.id),
                                  )
                                }
                              />
                              {r.name}
                            </Label>
                          ))}
                      </div>
                    )}
                    {readers !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        Áp dụng cả dữ liệu hiện tại, các lần gửi và câu trả lời trong lịch sử. Bảng
                        chi tiết được bảo vệ theo cả trường.
                      </p>
                    )}
                  </fieldset>
                );
              })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
