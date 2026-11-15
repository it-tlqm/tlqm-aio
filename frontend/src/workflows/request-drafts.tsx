import { useCallback, useEffect, useState, useRef } from 'react';
import { FilePenLine, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { Answers } from '../../../src/forms/contracts';
import type { WorkflowSpec } from '../../../src/workflows/contracts';
import type { AttachmentSummary } from '../../../src/workflows/attachments';
export type RequestDraft = {
  id: string;
  definition_id: string;
  version_id: string;
  org_unit_id: string;
  title: string;
  answers: Answers;
  selections: Record<string, string>;
  revision: number;
  status: string;
  run_id?: string | null;
  linkedSource?: { runId: string; title: string; taskId?: string };
  blockedReason?: string;
};
export type RequestDraftDetail = {
  request: RequestDraft;
  version: { id: string; version: number; spec: WorkflowSpec };
  canSubmit: boolean;
  attachments: AttachmentSummary[];
  linkedSource?: RequestDraft['linkedSource'];
  blockedReason?: string;
};
type DraftRow = {
  id: string;
  title: string;
  workflow_name: string;
  version: number;
  updated_at: string;
};
export function RequestDraftList({
  tenantId,
  onResume,
}: {
  tenantId: string;
  onResume: (detail: RequestDraftDetail) => void;
}) {
  const generation = useRef(0);
  const [rows, setRows] = useState<DraftRow[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const load = useCallback(
    async (after?: string) => {
      const seq = ++generation.current;
      setBusy(true);
      setError(null);
      if (!after) setRows([]);
      try {
        const result = await api<{ items: DraftRow[]; nextCursor: string | null }>(
          '/api/v1/workflows/requests?' +
            new URLSearchParams({ tenantId, ...(after ? { after } : {}) }),
        );
        if (seq !== generation.current) return;
        setRows((old) => (after ? [...old, ...result.items] : result.items));
        setCursor(result.nextCursor);
      } catch (e) {
        if (seq !== generation.current) return;
        setRows([]);
        setCursor(null);
        setError(e);
      } finally {
        if (seq === generation.current) setBusy(false);
      }
    },
    [tenantId],
  );
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return (
    <section className="space-y-4" aria-label="Nháp hồ sơ của tôi">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Hồ sơ chưa gửi chỉ hiển thị với người tạo. Mở lại để tiếp tục nhập và kiểm tra trước khi
          gửi.
        </p>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          <RefreshCw />
          Tải lại nháp
        </Button>
      </div>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {busy && <p role="status">Đang tải nháp…</p>}
      {!busy && !rows.length && error === null && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Chưa có hồ sơ nháp. Chọn một quy trình, nhập nội dung rồi bấm Lưu nháp hồ sơ.
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {rows.map((row) => (
          <Card key={row.id}>
            <CardHeader>
              <CardTitle>{row.title}</CardTitle>
              <CardDescription>
                {row.workflow_name} · Phiên bản {row.version}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                Lưu {new Date(row.updated_at).toLocaleString('vi-VN')}
              </span>
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  const seq = ++generation.current;
                  setBusy(true);
                  setError(null);
                  try {
                    const detail = await api<RequestDraftDetail>(
                      '/api/v1/workflows/requests/' + row.id + '?tenantId=' + tenantId,
                    );
                    if (seq === generation.current) onResume(detail);
                  } catch (e) {
                    if (seq === generation.current) setError(e);
                  } finally {
                    if (seq === generation.current) setBusy(false);
                  }
                }}
              >
                <FilePenLine />
                Tiếp tục nhập
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      {cursor && (
        <Button variant="outline" disabled={busy} onClick={() => void load(cursor)}>
          Xem thêm nháp
        </Button>
      )}
    </section>
  );
}
