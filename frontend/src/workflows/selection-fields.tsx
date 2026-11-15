import { Choice } from '../forms/common';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { WorkflowSelection } from './common';
export function WorkflowSelectionFields({
  options,
  values,
  onChange,
  loading,
}: {
  options: WorkflowSelection[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  loading: boolean;
}) {
  if (loading)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Đang kiểm tra người xử lý phù hợp…
      </p>
    );
  if (!options.length) return null;
  return (
    <fieldset className="space-y-4 rounded-lg border p-4">
      <legend className="px-1 font-medium">Chọn người nhận nhiệm vụ</legend>
      <p className="text-sm text-muted-foreground">
        Lựa chọn được giữ theo lần gửi này; quyền và thành viên nhóm vẫn được kiểm lại khi xử lý.
      </p>
      {options.map((option) => (
        <div key={option.stepId} className="space-y-2">
          <Choice
            name={'assignment-' + option.stepId}
            label={'Người nhận — ' + option.label}
            value={values[option.stepId] || '_none'}
            onChange={(value) => {
              const next = { ...values };
              if (value === '_none') delete next[option.stepId];
              else next[option.stepId] = value;
              onChange(next);
            }}
            options={[{ id: '_none', name: 'Chọn người nhận' }, ...option.candidates]}
          />
          <p className="text-xs text-muted-foreground">Nhóm: {option.groupName}</p>
          {!option.candidates.length && (
            <Alert>
              <AlertDescription>
                Nhóm chưa có người đủ quyền cho bước này. Điều phối viên cần đối soát thành viên và
                quyền ứng dụng.
              </AlertDescription>
            </Alert>
          )}
        </div>
      ))}
    </fieldset>
  );
}
