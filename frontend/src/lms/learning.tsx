import { useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Clock3,
  ArrowRight,
  CalendarDays,
  NotebookPen,
  Award,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  dateLabel,
  minutes,
  normalized,
  progressStatus,
  Metric,
  ProgressMeter,
  StatusBadge,
  Filters,
  Empty,
} from './common';
import type { LearningStatus } from './common';
import type { Learning, LessonProgress, Attempt, Note } from './types';

function Results({ attempts }: { attempts: Attempt[] }) {
  return attempts.length ? (
    <div className="divide-y">
      {attempts.map((row) => (
        <div
          key={row.id}
          className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">{row.title || 'Bài học đã lưu'}</p>
            <p className="mt-1 text-xs text-muted-foreground">{dateLabel(row.created_at)}</p>
          </div>
          <p className="shrink-0 text-xl font-semibold text-[var(--brand-navy)]">
            {row.score}
            <span className="ml-1 text-xs font-normal text-muted-foreground">/100</span>
          </p>
        </div>
      ))}
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">Chưa có kết quả kiểm tra.</p>
  );
}
function Notes({ notes }: { notes: Note[] }) {
  return notes.length ? (
    <div className="space-y-3">
      {notes.map((row) => (
        <div key={row.id} className="rounded-lg border-l-2 border-l-primary bg-secondary p-4">
          <p className="text-xs font-medium text-[var(--brand-navy)]">
            {row.title || 'Bài học đã lưu'} · {minutes(row.time)}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{row.content}</p>
        </div>
      ))}
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">Chưa có ghi chú học tập.</p>
  );
}
function LessonCard({ lesson, learning }: { lesson: LessonProgress; learning: Learning }) {
  const attempts = learning.attempts.filter((row) => row.lesson_id === lesson.lesson_id);
  const notes = learning.notes.filter((row) => row.lesson_id === lesson.lesson_id);
  return (
    <Dialog>
      <Card className="gap-5 overflow-hidden shadow-none transition-shadow hover:shadow-md">
        <CardHeader className="grid-cols-[auto_minmax(0,1fr)] gap-4">
          <div className="grid size-14 place-items-center rounded-lg bg-secondary text-primary">
            <BookOpen className="size-7" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap gap-2">
              <Badge variant="secondary">{lesson.series || 'Đào tạo nội bộ'}</Badge>
              {Boolean(lesson.is_mandatory) && <Badge variant="outline">Bắt buộc</Badge>}
            </div>
            <CardTitle role="heading" aria-level={3} className="text-lg leading-7">
              {lesson.title}
            </CardTitle>
            {lesson.subtitle && (
              <CardDescription className="mt-1">{lesson.subtitle}</CardDescription>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-4" aria-hidden="true" />
              {minutes(lesson.duration)}
            </span>
            {lesson.deadline && (
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="size-4" aria-hidden="true" />
                Hạn học: {lesson.deadline}
              </span>
            )}
          </div>
          <ProgressMeter
            watched={lesson.watched}
            duration={lesson.duration}
            label={'Thời lượng đã xem — ' + lesson.title}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <StatusBadge watched={lesson.watched} finished={lesson.finished} />
            <DialogTrigger asChild>
              <Button variant="outline" aria-label={'Xem chi tiết ' + lesson.title}>
                Xem chi tiết
                <ArrowRight aria-hidden="true" />
              </Button>
            </DialogTrigger>
          </div>
        </CardContent>
      </Card>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{lesson.title}</DialogTitle>
          <DialogDescription>
            Tiến độ, kết quả và ghi chú đã lưu của riêng bài học này.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <div className="rounded-lg border bg-secondary/40 p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <StatusBadge watched={lesson.watched} finished={lesson.finished} />
              <span className="text-sm text-muted-foreground">{minutes(lesson.duration)}</span>
            </div>
            <ProgressMeter
              watched={lesson.watched}
              duration={lesson.duration}
              label="Thời lượng đã xem của bài học"
            />
            <p className="mt-3 text-sm text-muted-foreground">
              Đã xem {minutes(lesson.watched)} · Mốc xem đã lưu: {minutes(lesson.position)}
            </p>
          </div>
          <section className="space-y-4">
            <h3 className="flex items-center gap-2 font-semibold">
              <Award className="size-4" aria-hidden="true" />
              Kết quả kiểm tra
            </h3>
            <Results attempts={attempts} />
          </section>
          <section className="space-y-4">
            <h3 className="flex items-center gap-2 font-semibold">
              <NotebookPen className="size-4" aria-hidden="true" />
              Ghi chú của bài học
            </h3>
            <Notes notes={notes} />
          </section>
          <p className="rounded-lg border bg-muted p-3 text-xs leading-5 text-muted-foreground">
            Bản dùng thử hiển thị lịch sử giả lập. Trình phát bài học và làm bài kiểm tra chưa được
            kết nối tại đây.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function LearningDashboard({ learning }: { learning: Learning }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<LearningStatus>('all');
  const rows = learning.progress.filter(
    (row) =>
      (status === 'all' || progressStatus(row.watched, row.finished) === status) &&
      normalized(row.title + ' ' + row.series).includes(normalized(search.trim())),
  );
  const completed = learning.progress.filter((row) => row.finished).length;
  const active = learning.progress.filter(
    (row) => progressStatus(row.watched, row.finished) === 'active',
  ).length;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Bài đã tham gia" value={learning.progress.length} icon={BookOpen} />
        <Metric label="Đang học" value={active} icon={Clock3} />
        <Metric label="Đã hoàn thành" value={completed} icon={CheckCircle2} />
        <Metric label="Lượt kiểm tra đã lưu" value={learning.attempts.length} icon={Award} />
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0 space-y-5" aria-labelledby="lms-lessons-title">
          <div>
            <h2 id="lms-lessons-title" className="text-lg font-semibold">
              Bài học đã tham gia
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Theo dõi việc học và xem lại kết quả của bạn.
            </p>
          </div>
          <Filters
            search={search}
            onSearch={setSearch}
            status={status}
            onStatus={setStatus}
            label="Tìm bài học"
            placeholder="Tên bài học hoặc chương trình…"
          />
          <p role="status" className="text-xs text-muted-foreground">
            Hiển thị {rows.length} / {learning.progress.length} bài học
          </p>
          <div className="space-y-4">
            {rows.map((row) => (
              <LessonCard key={row.id} lesson={row} learning={learning} />
            ))}
            {!rows.length && (
              <Empty
                title={
                  learning.progress.length
                    ? 'Không có bài học phù hợp'
                    : 'Chưa có bài học đã tham gia'
                }
                detail={
                  learning.progress.length
                    ? 'Thử đổi từ khóa hoặc trạng thái để xem các bài học khác.'
                    : 'Lịch sử sẽ xuất hiện tại đây khi có dữ liệu học tập.'
                }
                {...(learning.progress.length
                  ? {
                      reset: () => {
                        setSearch('');
                        setStatus('all');
                      },
                    }
                  : {})}
              />
            )}
          </div>
        </section>
        <aside className="min-w-0 space-y-5" aria-label="Kết quả và ghi chú">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
                <Award className="size-5 text-primary" aria-hidden="true" />
                Kết quả gần đây
              </CardTitle>
              <CardDescription>3 lượt kiểm tra mới nhất</CardDescription>
            </CardHeader>
            <CardContent>
              <Results attempts={learning.attempts.slice(0, 3)} />
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
                <NotebookPen className="size-5 text-primary" aria-hidden="true" />
                Ghi chú gần đây
              </CardTitle>
              <CardDescription>Chọn bài học để xem toàn bộ ghi chú.</CardDescription>
            </CardHeader>
            <CardContent>
              <Notes notes={learning.notes.slice(0, 3)} />
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
