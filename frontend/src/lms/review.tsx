import { useState } from 'react';
import { Users, BookOpen, CheckCircle2, Clock3, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  Filters,
  Metric,
  Empty,
  ProgressMeter,
  StatusBadge,
  minutes,
  normalized,
  progressStatus,
} from './common';
import type { LearningStatus } from './common';
import type { Review } from './types';

export function ReviewDashboard({ review, admin }: { review: Review; admin: boolean }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<LearningStatus>('all');
  const [department, setDepartment] = useState('all');
  const [page, setPage] = useState(0);
  const departments = [...new Set(review.items.map((row) => row.department))]
    .filter(Boolean)
    .sort();
  const filtered = review.items.filter(
    (row) =>
      (status === 'all' || progressStatus(row.watched, row.finished) === status) &&
      (department === 'all' || row.department === department) &&
      normalized([row.name, row.code, row.title].join(' ')).includes(normalized(search.trim())),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pages - 1);
  const learners = new Set(filtered.map((row) => row.id)).size;
  const records = filtered.filter((row) => row.lesson_id);
  const rows = filtered.slice(currentPage * 10, currentPage * 10 + 10);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Học viên" value={learners} icon={Users} />
        <Metric label="Lượt học đã ghi nhận" value={records.length} icon={BookOpen} />
        <Metric
          label="Lượt đang học"
          value={
            records.filter((row) => progressStatus(row.watched, row.finished) === 'active').length
          }
          icon={Clock3}
        />
        <Metric
          label="Lượt hoàn thành"
          value={records.filter((row) => row.finished).length}
          icon={CheckCircle2}
        />
      </div>
      <Card className="gap-5 shadow-none">
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            {admin ? 'Danh sách quản trị sandbox' : 'Tiến độ trong phạm vi được cấp'}
          </CardTitle>
          <CardDescription>
            Mỗi dòng là một học viên và bài học. Số liệu theo bộ lọc trên toàn bộ các trang đã tải
            từ phạm vi bạn được phép xem.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Filters
            search={search}
            onSearch={(value) => {
              setSearch(value);
              setPage(0);
            }}
            status={status}
            onStatus={(value) => {
              setStatus(value);
              setPage(0);
            }}
            label="Tìm học viên hoặc bài học"
            placeholder="Tên, mã học viên, tên bài học…"
          >
            <div className="w-full space-y-2 sm:w-56">
              <Label htmlFor="lms-department">Phòng ban trong hồ sơ LMS</Label>
              <Select
                value={department}
                onValueChange={(value) => {
                  setDepartment(value);
                  setPage(0);
                }}
              >
                <SelectTrigger id="lms-department" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả phòng ban</SelectItem>
                  {departments.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Filters>
          {rows.length ? (
            <div className="overflow-hidden rounded-lg border">
              <Table
                containerProps={{
                  tabIndex: 0,
                  role: 'region',
                  'aria-label': 'Bảng tiến độ học viên, cuộn ngang để xem thêm cột',
                }}
              >
                <TableHeader>
                  <TableRow>
                    <TableHead>Học viên</TableHead>
                    <TableHead>Bài học</TableHead>
                    <TableHead>Tiến độ xem</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>ID lịch sử</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.progress_id ?? row.id + ':unstarted'}>
                      <TableCell className="min-w-44">
                        <p className="font-medium">{row.name}</p>
                        <p className="text-xs text-muted-foreground">{row.code}</p>
                        <p className="text-xs text-muted-foreground">{row.department}</p>
                      </TableCell>
                      <TableCell className="min-w-44 max-w-64 whitespace-normal">
                        {row.title || 'Chưa có bài học đã ghi nhận'}
                      </TableCell>
                      <TableCell className="min-w-48">
                        {row.lesson_id ? (
                          <>
                            <ProgressMeter
                              watched={row.watched}
                              duration={row.duration}
                              label={'Thời lượng đã xem của ' + row.name + ' — ' + row.title}
                            />
                            <p className="mt-2 text-xs text-muted-foreground">
                              {minutes(row.watched)} / {minutes(row.duration)}
                            </p>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Chưa có tiến độ</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge watched={row.watched} finished={row.finished} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.id}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <Empty
              title="Không có học viên phù hợp"
              detail="Danh sách chỉ hiển thị học viên trong phạm vi được cấp. Bạn có thể thay đổi hoặc xóa bộ lọc."
              reset={() => {
                setSearch('');
                setStatus('all');
                setDepartment('all');
                setPage(0);
              }}
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-xs text-muted-foreground">
              {filtered.length ? currentPage * 10 + 1 : 0}–
              {Math.min((currentPage + 1) * 10, filtered.length)} / {filtered.length} dòng ·{' '}
              {learners} học viên
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label="Trang học viên trước"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft />
              </Button>
              <span className="text-xs text-muted-foreground">
                Trang {currentPage + 1}/{pages}
              </span>
              <Button
                variant="outline"
                size="icon"
                aria-label="Trang học viên sau"
                disabled={currentPage >= pages - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
