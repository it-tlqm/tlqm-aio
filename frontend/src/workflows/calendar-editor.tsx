import type { WorkflowSpec } from '../../../src/workflows/contracts';
import type { BusinessCalendar } from '../../../src/workflows/calendar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Choice } from '../forms/common';

const standard: BusinessCalendar = {
  offsetMinutes: 420,
  weekdays: [1, 2, 3, 4, 5],
  shifts: [
    { start: 480, end: 720 },
    { start: 780, end: 1020 },
  ],
  holidays: [],
};
const time = (v: number) =>
  `${String(Math.floor(v / 60) % 24).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
const minutes = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
export function CalendarEditor({
  spec,
  onChange,
  disabled,
}: {
  spec: WorkflowSpec;
  onChange: (s: WorkflowSpec) => void;
  disabled: boolean;
}) {
  const calendar = spec.calendar;
  const set = (patch: Partial<BusinessCalendar>) =>
    onChange({ ...spec, schemaVersion: 4, calendar: { ...calendar!, ...patch } });
  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>Lịch làm việc</CardTitle>
        <CardDescription>
          Lịch được lưu cùng phiên bản phát hành. Mỗi bước chọn tính hạn theo thời gian liên tục
          hoặc giờ làm việc.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <label className="flex items-center gap-3">
          <Checkbox
            checked={!!calendar}
            disabled={disabled}
            onCheckedChange={(checked) => {
              if (checked)
                onChange({ ...spec, schemaVersion: 4, calendar: structuredClone(standard) });
              else {
                const next = { ...spec };
                delete next.calendar;
                onChange(next);
              }
            }}
          />
          Sử dụng lịch làm việc riêng
        </label>
        {calendar && (
          <fieldset disabled={disabled} className="space-y-5">
            <legend className="sr-only">Cấu hình lịch làm việc</legend>
            <Choice
              label="Múi giờ cố định"
              value={String(calendar.offsetMinutes)}
              disabled={disabled}
              onChange={(v) => set({ offsetMinutes: Number(v) })}
              options={Array.from({ length: 105 }, (_, i) => {
                const value = -720 + i * 15;
                return {
                  id: String(value),
                  name: `UTC${value >= 0 ? '+' : '−'}${Math.floor(Math.abs(value) / 60)}:${String(Math.abs(value) % 60).padStart(2, '0')}`,
                };
              })}
            />
            <p className="text-sm text-muted-foreground">
              Việt Nam dùng UTC+7:00. Lịch này không tự đổi theo giờ mùa hè.
            </p>
            <fieldset>
              <legend className="mb-2 font-medium">Ngày làm việc trong tuần</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                  <label className="flex items-center gap-2" key={day}>
                    <Checkbox
                      disabled={disabled}
                      checked={calendar.weekdays.includes(day)}
                      onCheckedChange={(checked) =>
                        set({
                          weekdays: checked
                            ? [...calendar.weekdays, day]
                            : calendar.weekdays.filter((d) => d !== day),
                        })
                      }
                    />
                    {day === 0 ? 'Chủ nhật' : `Thứ ${day + 1}`}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-3">
              <legend className="mb-2 font-medium">Ca làm việc</legend>
              {calendar.shifts.map((shift, index) => (
                <div
                  key={index}
                  className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
                >
                  {(['start', 'end'] as const).map((key) => (
                    <div className="space-y-2" key={key}>
                      <Label htmlFor={`shift-${index}-${key}`}>
                        {key === 'start' ? 'Bắt đầu' : 'Kết thúc'} ca {index + 1}
                      </Label>
                      <Input
                        id={`shift-${index}-${key}`}
                        type="time"
                        value={time(shift[key])}
                        onChange={(e) =>
                          set({
                            shifts: calendar.shifts.map((s, i) =>
                              i === index
                                ? {
                                    ...s,
                                    [key]:
                                      key === 'end' && e.target.value === '00:00'
                                        ? 1440
                                        : minutes(e.target.value),
                                  }
                                : s,
                            ),
                          })
                        }
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || calendar.shifts.length <= 1}
                    aria-label={`Xóa ca ${index + 1}`}
                    onClick={() => set({ shifts: calendar.shifts.filter((_, i) => i !== index) })}
                  >
                    Xóa ca
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={disabled || calendar.shifts.length >= 4}
                onClick={() => set({ shifts: [...calendar.shifts, { start: 1080, end: 1200 }] })}
              >
                Thêm ca làm việc
              </Button>
              <p className="text-sm text-muted-foreground">
                Tối đa 4 ca, không chồng giờ. Kết thúc 00:00 là cuối ngày. Thời gian nghỉ giữa ca
                không tính vào hạn.
              </p>
            </fieldset>
            <fieldset className="space-y-3">
              <legend className="mb-2 font-medium">Ngày nghỉ / ngày lễ</legend>
              {calendar.holidays.map((day, index) => (
                <div key={index} className="flex items-end gap-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Label htmlFor={`holiday-${index}`}>Ngày nghỉ {index + 1}</Label>
                    <Input
                      type="date"
                      id={`holiday-${index}`}
                      value={day}
                      onChange={(e) =>
                        set({
                          holidays: calendar.holidays.map((d, i) =>
                            i === index ? e.target.value : d,
                          ),
                        })
                      }
                    />
                  </div>
                  <Button
                    variant="outline"
                    aria-label={`Xóa ngày nghỉ ${index + 1}`}
                    onClick={() =>
                      set({ holidays: calendar.holidays.filter((_, i) => i !== index) })
                    }
                  >
                    Xóa
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                disabled={disabled || calendar.holidays.length >= 366}
                onClick={() => set({ holidays: [...calendar.holidays, ''] })}
              >
                Thêm ngày nghỉ
              </Button>
            </fieldset>
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}
