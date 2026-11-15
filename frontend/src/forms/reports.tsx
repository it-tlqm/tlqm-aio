import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Choice, formError } from './common';
import type { FormDetail, Lookup, Submission, PageResult } from './common';
import type { ConfirmRequest } from './respond';
import { AnswerReadback } from './renderer';
type Report = {
  total: number;
  byUnit: { orgUnitId: string; count: number }[];
  versions: {
    version: number;
    versionId: string;
    total: number;
    fields: {
      id: string;
      label: string;
      type: string;
      answered: number;
      counts?: { id: string; label: string; count: number }[];
      numeric?: { min: number; max: number; mean: number };
      dates?: { earliest: string; latest: string };
    }[];
  }[];
};
export function ReportsPanel({
  detail,
  lookup,
  me,
  tenantId,
  mode,
  exportAllowed,
  confirm,
}: {
  detail: FormDetail;
  lookup: Lookup;
  me: Me;
  tenantId: string;
  mode: 'review' | 'analyze';
  exportAllowed: boolean;
  confirm: (request: ConfirmRequest) => void;
}) {
  const [rows, setRows] = useState<Submission[]>([]),
    [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Submission | null>(null),
    [version, setVersion] = useState(detail.versions[0]?.id ?? '');
  const trigger = useRef<HTMLElement | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null),
    [moreBusy, setMoreBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api<PageResult<Submission> | Report>(
      '/api/v1/forms/' +
        detail.form.id +
        (mode === 'review' ? '/submissions/page' : '/report') +
        '?tenantId=' +
        tenantId,
      { signal: controller.signal },
    )
      .then((result) => {
        if (mode === 'review') {
          const page = result as PageResult<Submission>;
          setRows(page.items);
          setNextCursor(page.nextCursor);
        } else setReport(result as Report);
        setLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [detail.form.id, tenantId, mode]);
  async function download(reason: string) {
    const response = await fetch(
      '/api/v1/forms/' + detail.form.id + '/versions/' + version + '/export',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
        body: JSON.stringify({ tenantId, reason }),
      },
    );
    if (!response.ok)
      throw new ApiError(response.status, (await response.json()).error ?? 'REQUEST_FAILED');
    const blob = await response.blob(),
      url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download =
      detail.form.code +
      '-v' +
      (detail.versions.find((item) => item.id === version)?.version ?? '') +
      '.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="space-y-5">
      <Alert>
        <AlertDescription>
          Chỉ hiển thị phiếu đã gửi trong đơn vị và phạm vi bạn được cấp.
        </AlertDescription>
      </Alert>
      {loading && <p role="status">Đang tải kết quả…</p>}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{formError(error)}</AlertDescription>
        </Alert>
      )}
      {mode === 'review' && !loading && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Đơn vị</TableHead>
              <TableHead>Phiên bản</TableHead>
              <TableHead>Thời điểm gửi</TableHead>
              <TableHead>Chi tiết</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  {lookup.units.find((unit) => unit.id === row.org_unit_id)?.name ??
                    'Đơn vị được cấp'}
                </TableCell>
                <TableCell>v{row.version}</TableCell>
                <TableCell>
                  {row.submitted_at && new Date(row.submitted_at).toLocaleString('vi-VN')}
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    onClick={() => {
                      trigger.current = document.activeElement as HTMLElement;
                      setSelected(row);
                    }}
                  >
                    Xem phiếu
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={4}>Chưa có phiếu đã gửi trong phạm vi này.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
      {mode === 'review' && nextCursor && (
        <Button
          variant="outline"
          disabled={moreBusy}
          onClick={() => {
            setMoreBusy(true);
            void api<PageResult<Submission>>(
              '/api/v1/forms/' +
                detail.form.id +
                '/submissions/page?' +
                new URLSearchParams({ tenantId, after: nextCursor }),
            )
              .then((page) => {
                setRows((old) => [...old, ...page.items]);
                setNextCursor(page.nextCursor);
              })
              .catch(setError)
              .finally(() => setMoreBusy(false));
          }}
        >
          Tải thêm phiếu
        </Button>
      )}
      {report && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{report.total} phiếu đã gửi trong phạm vi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {report.byUnit.map((row) => (
                <p key={row.orgUnitId}>
                  {lookup.units.find((unit) => unit.id === row.orgUnitId)?.name ??
                    'Đơn vị được cấp'}
                  : <strong>{row.count}</strong>
                </p>
              ))}
            </CardContent>
          </Card>
          {report.versions.map((version) => (
            <section key={version.versionId} className="space-y-4">
              <h3 className="text-lg font-semibold text-[var(--brand-navy)]">
                Phiên bản {version.version} · {version.total} phiếu
              </h3>
              <div className="grid gap-4 md:grid-cols-2">
                {version.fields.map((field) => (
                  <Card key={field.id}>
                    <CardHeader>
                      <CardTitle>{field.label}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <p className="text-sm text-muted-foreground">{field.answered} câu trả lời</p>
                      {field.counts?.map((count) => (
                        <div key={count.id} className="flex justify-between gap-3">
                          <span>{count.label}</span>
                          <strong>{count.count}</strong>
                        </div>
                      ))}
                      {field.numeric && (
                        <p>
                          Thấp nhất: {field.numeric.min} · Cao nhất: {field.numeric.max} · Trung
                          bình: {field.numeric.mean.toLocaleString('vi-VN')}
                        </p>
                      )}
                      {field.dates && (
                        <p>
                          Từ {field.dates.earliest} đến {field.dates.latest}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
      {exportAllowed && detail.versions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Xuất CSV theo phiên bản</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Choice
              label="Phiên bản cần xuất"
              name="export-version"
              value={version}
              onChange={setVersion}
              options={detail.versions.map((version) => ({
                id: version.id,
                name: 'Phiên bản ' + version.version,
              }))}
            />
            <p className="text-sm text-muted-foreground">
              Chuỗi giống công thức được thêm tiền tố “text: ” trong CSV. Câu trả lời gốc giữ
              nguyên.
            </p>
            <Button
              variant="outline"
              onClick={() =>
                confirm({
                  title: 'Xuất dữ liệu CSV?',
                  description:
                    'Tệp chứa câu trả lời trong phạm vi hiện tại. Mỗi lần tải được ghi vào lịch sử.',
                  action: download,
                })
              }
            >
              Tải CSV
            </Button>
          </CardContent>
        </Card>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Phiếu đã gửi · v{selected?.version}</DialogTitle>
            <DialogDescription>Nội dung gắn với phiên bản đã xuất bản.</DialogDescription>
          </DialogHeader>
          {selected && (
            <AnswerReadback schema={selected.version_schema} answers={selected.answers} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
