import { useId, useState } from 'react';
import type { HumanStep, WorkflowSpec } from '../../../src/workflows/contracts';
import { stepInputCandidates } from '../../../src/workflows/step-input';
import type { StepInputMode } from '../../../src/workflows/step-input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function StepInputEditor({
  spec,
  steps,
  disabled,
  onChange,
}: {
  spec: WorkflowSpec;
  steps: HumanStep[];
  disabled: boolean;
  onChange: (spec: WorkflowSpec) => void;
}) {
  const prefix = useId();
  const [stepId, setStepId] = useState('');
  const step = steps.find((item) => item.id === stepId) ?? steps[0];
  const fields = stepInputCandidates(spec.input);
  if (!step || !fields.length) return null;

  function change(fieldId: string, mode: 'none' | StepInputMode) {
    if (!step) return;
    const inputFields = { ...step.inputFields };
    if (mode === 'none') delete inputFields[fieldId];
    else inputFields[fieldId] = mode;
    onChange({
      ...spec,
      schemaVersion: 5,
      nodes: spec.nodes.map((node) =>
        node === step
          ? { ...step, inputFields: Object.keys(inputFields).length ? inputFields : undefined }
          : node,
      ),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dữ liệu khởi tạo tại từng bước</CardTitle>
        <CardDescription>
          Chọn cách dùng từng trường trong phần xử lý. Giá trị chỉnh sửa được lưu cùng kết quả bước.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-lg space-y-2">
          <Label htmlFor={prefix + 'step'}>Bước sử dụng dữ liệu</Label>
          <Select value={step.id} onValueChange={setStepId}>
            <SelectTrigger id={prefix + 'step'} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {steps.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="divide-y rounded-lg border px-3 sm:px-4">
          {fields.map((field) => {
            const readers = spec.fieldReaders?.['input.' + field.id];
            const denied = readers !== undefined && !readers.includes(step.id);
            const mode = step.inputFields?.[field.id] ?? 'none';
            const control = prefix + field.id;
            return (
              <div
                key={field.id}
                className="grid items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_12rem]"
              >
                <div className="min-w-0">
                  <Label htmlFor={control} className="break-words">
                    {field.label} tại bước
                  </Label>
                  {denied && (
                    <p id={control + '-hint'} className="mt-1 text-sm text-muted-foreground">
                      Cấp quyền xem cho bước này trong phần bên dưới.
                    </p>
                  )}
                </div>
                <Select
                  value={mode}
                  disabled={disabled || (denied && mode === 'none')}
                  onValueChange={(value) => change(field.id, value as 'none' | StepInputMode)}
                >
                  <SelectTrigger
                    id={control}
                    aria-describedby={denied ? control + '-hint' : undefined}
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Chỉ ở hồ sơ gốc</SelectItem>
                    <SelectItem value="read" disabled={denied}>
                      Chỉ xem
                    </SelectItem>
                    <SelectItem value="edit" disabled={denied}>
                      Cho sửa
                    </SelectItem>
                    <SelectItem value="required" disabled={denied}>
                      Bắt buộc điền
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
