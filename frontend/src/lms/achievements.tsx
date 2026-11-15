import { useEffect, useState } from 'react';
import { RefreshCw, Trophy } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { CertificateButton } from './certificate';
import type { Ranking } from '../../../src/lms/achievement-contracts';

export function AchievementsPanel({ onAccessError }: { onAccessError: (error: unknown) => void }) {
  const [ranking, setRanking] = useState<Ranking | null>(null),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [code, setCode] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    setRanking(null);
    void api<Ranking>('/api/lms/ranking?page=' + page + '&search=' + encodeURIComponent(query), {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setRanking(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error);
          if (error instanceof ApiError && [401, 403].includes(error.status)) onAccessError(error);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [page, query, revision, onAccessError]);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
                <Trophy className="size-5 text-primary" />
                Xếp hạng trong đơn vị
              </CardTitle>
              <CardDescription className="mt-2">
                Tính theo số khóa đạt, sau đó là điểm trung bình cao nhất của mỗi khóa. Các lần thi
                lại và phiên bản mới của cùng khóa chỉ tính một lần.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw />
              Tải lại xếp hạng
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setQuery(search.trim());
            }}
          >
            <div className="min-w-48 flex-1 space-y-2">
              <Label htmlFor="ranking-search">Tìm tên hoặc mã học viên</Label>
              <Input
                id="ranking-search"
                maxLength={100}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Button variant="outline" type="submit" disabled={busy}>
              Tìm kiếm
            </Button>
          </form>
          {Boolean(error) && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          {busy && <p role="status">Đang đối chiếu phạm vi và tính xếp hạng…</p>}
          {ranking && (
            <>
              <div className="flex flex-wrap gap-3 text-sm">
                <Badge variant="outline">Đơn vị hiện tại</Badge>
                <span>
                  {ranking.myRank
                    ? 'Hạng của bạn: ' + ranking.myRank
                    : 'Bạn chưa có kết quả để xếp hạng.'}
                </span>
              </div>
              {ranking.items.length ? (
                <Table
                  containerProps={{
                    tabIndex: 0,
                    role: 'region',
                    'aria-label': 'Bảng xếp hạng đơn vị',
                  }}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>Hạng</TableHead>
                      <TableHead>Học viên</TableHead>
                      <TableHead>Khóa đạt</TableHead>
                      <TableHead>Khóa đã thi</TableHead>
                      <TableHead>Điểm trung bình</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ranking.items.map((row) => (
                      <TableRow key={row.code} className={row.isMe ? 'bg-secondary' : ''}>
                        <TableCell className="font-semibold text-[var(--brand-navy)]">
                          {row.rank}
                        </TableCell>
                        <TableCell className="min-w-48 whitespace-normal">
                          <p className="font-medium">
                            {row.name}
                            {row.isMe ? ' (Bạn)' : ''}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">{row.code}</p>
                        </TableCell>
                        <TableCell>{row.completed}</TableCell>
                        <TableCell>{row.attempted}</TableCell>
                        <TableCell>{row.average}/100</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="rounded-lg border p-6 text-sm text-muted-foreground">
                  Chưa có kết quả phù hợp trong phạm vi hiện tại.
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <p>
                  {ranking.total} học viên · Trang {page}/
                  {Math.max(1, Math.ceil(ranking.total / ranking.pageSize))}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={page === 1 || busy}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Trang trước
                  </Button>
                  <Button
                    variant="outline"
                    disabled={page * ranking.pageSize >= ranking.total || busy}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Trang sau
                  </Button>
                </div>
              </div>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Chỉ gồm học viên có kết quả và định danh AIO đang hoạt động trong đơn vị. Cùng số khóa
            đạt và điểm trung bình sẽ cùng hạng.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Tra cứu chứng nhận
          </CardTitle>
          <CardDescription>
            Học viên xem chứng nhận của mình; người quản lý xem trong phạm vi được cấp. Mã tra cứu
            không thay thế quyền truy cập.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1 space-y-2">
            <Label htmlFor="certificate-code">Mã chứng nhận</Label>
            <Input
              id="certificate-code"
              placeholder="TLQM-…"
              maxLength={41}
              value={code}
              onChange={(event) => setCode(event.target.value.trim().toUpperCase())}
            />
          </div>
          <CertificateButton key={code} code={code} onAccessError={onAccessError} />
        </CardContent>
      </Card>
    </div>
  );
}
