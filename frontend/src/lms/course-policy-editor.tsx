import { useState } from 'react';
import type { CourseSpec } from '../../../src/lms/course-contracts';
import { learningPolicy } from '../../../src/lms/learning-policy';
import type { LearningPolicy } from '../../../src/lms/learning-policy';
import type { ManagedCourse } from './course-api';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Choice } from '../forms/common';
import { normalized } from './common';

export function CoursePolicyEditor({
  spec,
  onChange,
  courses,
  courseId,
}: {
  spec: CourseSpec;
  onChange: (spec: CourseSpec) => void;
  courses: ManagedCourse[];
  courseId?: string;
}) {
  const policy = learningPolicy(spec),
    [search, setSearch] = useState('');
  const set = (patch: Partial<LearningPolicy>) =>
    onChange({ ...spec, schemaVersion: 3, policy: { ...policy, ...patch } });
  const available = courses.filter(
    (c) => c.id !== courseId && c.status === 'active' && c.versionId,
  );
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Chính sách học và kiểm tra</CardTitle>
          <CardDescription>
            Áp dụng cho phiên bản được phát hành tiếp theo. Kết quả và chứng nhận cũ giữ nguyên
            chính sách lúc nộp bài.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 md:grid-cols-3">
            {(
              [
                ['passScore', 'Điểm đạt (1–100)', 1, 100],
                ['maxAttempts', 'Số lần nộp tối đa', 0, 100],
                ['cooldownMinutes', 'Chờ giữa hai lần nộp (phút)', 0, 10080],
              ] as const
            ).map(([key, label, min, max]) => (
              <div className="space-y-2" key={key}>
                <Label htmlFor={`policy-${key}`}>{label}</Label>
                <Input
                  id={`policy-${key}`}
                  type="number"
                  min={min}
                  max={max}
                  value={policy[key]}
                  onChange={(e) => set({ [key]: Number(e.target.value) })}
                />
              </div>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Số lần bằng 0 nghĩa là không giới hạn; thời gian chờ bằng 0 cho phép nộp tiếp ngay. Giới
            hạn tính riêng cho mỗi học viên và phiên bản khóa học.
          </p>
          <label className="flex items-center gap-3">
            <Checkbox
              checked={policy.requireVideoCompletion}
              onCheckedChange={(v) => set({ requireVideoCompletion: !!v })}
            />
            Hoàn thành video trước khi thi
          </label>
          <Choice
            label="Yêu cầu tại điểm dừng"
            value={policy.checkpointPolicy}
            onChange={(v) => set({ checkpointPolicy: v as LearningPolicy['checkpointPolicy'] })}
            options={[
              { id: 'answered', name: 'Đã trả lời tất cả điểm dừng' },
              { id: 'correct', name: 'Trả lời đúng tất cả điểm dừng' },
              { id: 'none', name: 'Không bắt buộc điểm dừng' },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Khóa học tiên quyết</CardTitle>
          <CardDescription>
            Học viên phải đạt các phiên bản được chọn trước khi mở nội dung khóa này. Chọn tối đa 20
            khóa có cùng đối tượng học phù hợp.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="prerequisite-search">Tìm khóa học tiên quyết</Label>
          <Input
            id="prerequisite-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nhập tên khóa học…"
          />
          <p className="text-sm text-muted-foreground">
            Đã chọn {policy.prerequisiteVersionIds.length} phiên bản
          </p>
          <div
            role="region"
            aria-label="Khóa học có thể chọn"
            tabIndex={0}
            className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {available
              .filter((c) =>
                normalized(c.publishedTitle ?? c.spec.title).includes(normalized(search)),
              )
              .map((c) => (
                <label key={c.id} className="flex items-center gap-3">
                  <Checkbox
                    checked={policy.prerequisiteVersionIds.includes(c.versionId!)}
                    onCheckedChange={(v) =>
                      set({
                        prerequisiteVersionIds: v
                          ? [...policy.prerequisiteVersionIds, c.versionId!]
                          : policy.prerequisiteVersionIds.filter((id) => id !== c.versionId),
                      })
                    }
                  />
                  <span className="text-sm">
                    {c.publishedTitle ?? c.spec.title} · phiên bản {c.version}
                  </span>
                </label>
              ))}
            {!available.length && (
              <p className="text-sm text-muted-foreground">Chưa có khóa khác đang phát hành.</p>
            )}
          </div>
          {policy.prerequisiteVersionIds
            .filter((id) => !available.some((c) => c.versionId === id))
            .map((id, index) => (
              <div
                key={id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <p className="text-sm">
                  Khóa đã chọn {index + 1} không còn phát hành phiên bản này. Chọn bản hiện hành
                  trước khi phát hành lại.
                </p>
                <Button
                  variant="outline"
                  onClick={() =>
                    set({
                      prerequisiteVersionIds: policy.prerequisiteVersionIds.filter((v) => v !== id),
                    })
                  }
                >
                  Bỏ lựa chọn cũ
                </Button>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
