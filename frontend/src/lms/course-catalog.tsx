import { useEffect, useState } from 'react';
import { BookOpen, Play, Clock3, CheckCircle2, Award, RefreshCw } from 'lucide-react';
import { api, apiCollection, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CoursePlayer } from './course-player';
import { AttemptReadback } from './attempt-result';
import { CertificateButton } from './certificate';
import { Empty, Metric, ProgressMeter, minutes, normalized } from './common';
import type { CourseItem, AttemptResult } from './course-api';
export function CourseCatalog({
  csrfToken,
  onAccessError,
  onDirtyChange,
  initialVersionId,
  onCourseClosed,
}: {
  csrfToken: string;
  onAccessError: (error: unknown) => void;
  onDirtyChange: (dirty: boolean) => void;
  initialVersionId?: string | null;
  onCourseClosed?: () => void;
}) {
  const [items, setItems] = useState<CourseItem[]>([]),
    [search, setSearch] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null),
    [selected, setSelected] = useState<string | null>(initialVersionId ?? null);
  useEffect(() => {
    if (initialVersionId) setSelected(initialVersionId);
  }, [initialVersionId]);
  async function load() {
    setLoading(true);
    setError(null);
    setItems([]);
    try {
      const value = await apiCollection<CourseItem>('/api/lms/courses');
      setItems(value.items);
    } catch (error) {
      setError(error);
      if (error instanceof ApiError && [401, 403].includes(error.status)) onAccessError(error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  if (selected)
    return (
      <CoursePlayer
        key={selected}
        versionId={selected}
        csrfToken={csrfToken}
        onAccessError={onAccessError}
        onDirtyChange={onDirtyChange}
        onBack={() => {
          setSelected(null);
          onCourseClosed?.();
          void load();
        }}
      />
    );
  const rows = items.filter((row) =>
    normalized(row.spec.title + ' ' + row.spec.series).includes(normalized(search.trim())),
  );
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Khóa học được giao" value={items.length} icon={BookOpen} />
        <Metric
          label="Đang học"
          value={
            items.filter((row) => (row.progress?.watched ?? 0) > 0 && !row.progress?.passed).length
          }
          icon={Play}
        />
        <Metric
          label="Đã đạt bài kiểm tra"
          value={items.filter((row) => row.progress?.passed).length}
          icon={Award}
        />
        <Metric
          label="Khóa bắt buộc"
          value={items.filter((row) => row.spec.isMandatory).length}
          icon={CheckCircle2}
        />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="text-lg font-semibold">Khóa học dành cho bạn</h2>
          <Label htmlFor="catalog-search">Tìm khóa học</Label>
          <Input
            id="catalog-search"
            value={search}
            placeholder="Tên khóa học hoặc chuyên đề…"
            onChange={(event) => setSearch(event.target.value)}
            className="max-w-xl"
          />
        </div>
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw />
          Tải lại khóa học
        </Button>
      </div>
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <p role="status">Đang tải khóa học được giao…</p>
      ) : (
        <>
          <p role="status" className="text-xs text-muted-foreground">
            Hiển thị {rows.length}/{items.length} khóa học
          </p>
          <div className="grid gap-5 lg:grid-cols-2">
            {rows.map((row) => (
              <Card key={row.id} className="shadow-none">
                <CardHeader>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{row.spec.series}</Badge>
                    {row.spec.isMandatory && <Badge variant="outline">Bắt buộc</Badge>}
                    <Badge variant="outline">Phiên bản {row.version}</Badge>
                  </div>
                  <CardTitle role="heading" aria-level={3} className="text-lg">
                    {row.spec.title}
                  </CardTitle>
                  <CardDescription>{row.spec.subtitle}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Clock3 className="size-4" aria-hidden="true" />
                      {minutes(row.spec.duration)}
                    </span>
                    {row.spec.deadline && <span>Hạn học: {row.spec.deadline}</span>}
                    <span>{row.spec.questions.length} câu kiểm tra</span>
                  </div>
                  <ProgressMeter
                    watched={row.progress?.watched ?? 0}
                    duration={row.spec.duration}
                    label={'Tiến độ ' + row.spec.title}
                    caption={
                      row.spec.video?.kind === 'gdrive'
                        ? 'Mốc học viên tự xác nhận'
                        : 'Tiến độ bài học'
                    }
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                    <Badge
                      variant="outline"
                      className={
                        row.progress?.passed
                          ? 'status-success'
                          : row.progress?.watched
                            ? 'status-info'
                            : ''
                      }
                    >
                      {row.progress?.passed
                        ? 'Đã đạt yêu cầu'
                        : row.progress?.finished
                          ? 'Đã hoàn thành video'
                          : row.progress?.watched
                            ? 'Đang học'
                            : 'Chưa bắt đầu'}
                    </Badge>
                    <Button
                      disabled={!row.versionId || !!row.prerequisitesRemaining}
                      onClick={() => setSelected(row.versionId)}
                      aria-label={
                        (row.progress?.position ? 'Tiếp tục học: ' : 'Bắt đầu học: ') +
                        row.spec.title
                      }
                    >
                      <Play />
                      {row.prerequisitesRemaining
                        ? `Cần đạt ${row.prerequisitesRemaining} khóa tiên quyết`
                        : row.progress?.position
                          ? 'Tiếp tục học'
                          : 'Bắt đầu học'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {!rows.length && (
            <Empty
              title={items.length ? 'Không có khóa học phù hợp' : 'Chưa có khóa học được giao'}
              detail={
                items.length
                  ? 'Thử từ khóa khác hoặc xóa bộ lọc.'
                  : 'Các khóa đã phát hành cho đơn vị của bạn sẽ xuất hiện tại đây.'
              }
              {...(items.length ? { reset: () => setSearch('') } : {})}
            />
          )}
        </>
      )}
    </div>
  );
}
type HistoryItem = {
  id: string;
  versionId: string;
  score: number;
  passed: boolean;
  passScore: number;
  createdAt: number;
  lessonTitle: string;
  series: string;
  version: number;
};
export function CourseHistory({
  onAccessError,
  csrfToken,
}: {
  onAccessError: (error: unknown) => void;
  csrfToken: string;
}) {
  const [items, setItems] = useState<HistoryItem[]>([]),
    [result, setResult] = useState<AttemptResult | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(true);
  const fail = (error: unknown) => {
    setError(error);
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      setItems([]);
      setResult(null);
      onAccessError(error);
    }
  };
  async function load() {
    setBusy(true);
    setError(null);
    setItems([]);
    try {
      setItems((await apiCollection<HistoryItem>('/api/lms/history')).items);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  if (result)
    return (
      <AttemptReadback
        result={result}
        onBack={() => setResult(null)}
        csrfToken={csrfToken}
        onAccessError={onAccessError}
      />
    );
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle role="heading" aria-level={2}>
              Kết quả học tập của tôi
            </CardTitle>
            <CardDescription className="mt-2">
              Mỗi lần nộp giữ câu hỏi, đáp án và điểm của đúng phiên bản đã học.
            </CardDescription>
          </div>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            <RefreshCw />
            Tải lại kết quả
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {Boolean(error) && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        )}
        {busy ? (
          <p role="status">Đang tải kết quả…</p>
        ) : items.length ? (
          <Table
            containerProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Bảng kết quả học tập' }}
          >
            <TableHeader>
              <TableRow>
                <TableHead>Khóa học</TableHead>
                <TableHead>Ngày nộp</TableHead>
                <TableHead>Điểm</TableHead>
                <TableHead>Kết quả</TableHead>
                <TableHead>Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="min-w-48 whitespace-normal">
                    <p className="font-medium">{row.lessonTitle}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.series} · Phiên bản {row.version}
                    </p>
                  </TableCell>
                  <TableCell>{new Date(row.createdAt).toLocaleDateString('vi-VN')}</TableCell>
                  <TableCell className="font-semibold">{row.score}/100</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={row.passed ? 'status-success' : 'status-warning'}
                    >
                      {row.passed ? 'Đạt' : 'Chưa đạt'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        setError(null);
                        void api<AttemptResult>('/api/lms/attempt?id=' + row.id)
                          .then(setResult)
                          .catch(fail)
                          .finally(() => setBusy(false));
                      }}
                    >
                      Xem bài làm
                    </Button>
                    {row.passed && (
                      <span className="ml-2 inline-block">
                        <CertificateButton
                          attemptId={row.id}
                          csrfToken={csrfToken}
                          onAccessError={onAccessError}
                        />
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty
            title="Chưa có bài kiểm tra đã nộp"
            detail="Kết quả sẽ xuất hiện sau khi bạn hoàn thành và nộp bài kiểm tra."
          />
        )}
      </CardContent>
    </Card>
  );
}
