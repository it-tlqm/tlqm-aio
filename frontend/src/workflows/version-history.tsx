import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Choice } from '../forms/common';
import type { DefinitionItem } from './common';
import type {
  WorkflowVersionChange,
  WorkflowVersionItem,
} from '../../../src/workflows/version-history';

type History = {
  items: WorkflowVersionItem[];
  canPublish: boolean;
  revision: number;
  latestVersion: number;
  nextBefore: number | null;
};
type Comparison = {
  before: WorkflowVersionItem;
  after: WorkflowVersionItem;
  changes: WorkflowVersionChange[];
};
const sections: Record<WorkflowVersionChange['section'], string> = {
  definition: 'Thông tin chung',
  input: 'Biểu mẫu khởi tạo',
  steps: 'Các bước và đường đi',
  access: 'Đối tượng và quyền trường',
};
const kinds = { added: 'Thêm', removed: 'Bỏ', changed: 'Sửa' } as const;
const time = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});
const option = (version: WorkflowVersionItem) => ({
  id: version.id,
  name: 'v' + version.version + ' · ' + time.format(new Date(version.publishedAt)),
});

export function WorkflowVersionHistory({
  definition,
  tenantId,
  onClose,
  onRestore,
}: {
  definition: DefinitionItem;
  tenantId: string;
  onClose: () => void;
  onRestore: (version: WorkflowVersionItem, revision: number) => void;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [compareError, setCompareError] = useState<unknown>(null);
  const path = '/api/v1/workflows/definitions/' + definition.id + '/versions';
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setLoadError(null);
    const query = new URLSearchParams({ tenantId });
    if (cursor !== null) query.set('before', String(cursor));
    void api<History>(path + '?' + query, { signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return;
        setHistory((previous) =>
          cursor === null || !previous
            ? result
            : {
                ...result,
                items: [...previous.items, ...result.items],
              },
        );
        if (cursor === null) {
          setBefore(result.items[1]?.id ?? result.items[0]?.id ?? '');
          setAfter(result.items[0]?.id ?? '');
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) setLoadError(error);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [cursor, path, tenantId]);
  useEffect(() => {
    setComparison(null);
    setCompareError(null);
    if (!before || !after) return;
    const abort = new AbortController();
    void api<Comparison>(path + '/compare?' + new URLSearchParams({ tenantId, before, after }), {
      signal: abort.signal,
    })
      .then((result) => {
        if (!abort.signal.aborted) setComparison(result);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setCompareError(error);
      });
    return () => abort.abort();
  }, [after, before, path, tenantId]);
  const chosen = history?.items.find(({ id }) => id === before);
  const versions = history?.items.map(option) ?? [];
  const problem = loadError ?? compareError;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Lịch sử phiên bản</DialogTitle>
          <DialogDescription>{definition.name}</DialogDescription>
        </DialogHeader>
        {problem !== null && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(problem)}</AlertDescription>
          </Alert>
        )}
        {history && (
          <>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <Choice
                label="Phiên bản gốc"
                value={before}
                options={versions}
                onChange={setBefore}
              />
              <Choice
                label="Phiên bản đối chiếu"
                value={after}
                options={versions}
                onChange={setAfter}
              />
            </div>
            {history.nextBefore !== null && (
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => setCursor(history.nextBefore)}
              >
                Xem thêm phiên bản
              </Button>
            )}
            <p className="text-sm text-muted-foreground">Đang phát hành v{history.latestVersion}</p>
          </>
        )}
        {(loading || (before && after && !comparison && compareError === null)) && (
          <p role="status" className="text-sm text-muted-foreground">
            Đang tải phiên bản…
          </p>
        )}
        {comparison && (
          <div className="min-w-0 space-y-3">
            <p role="status" className="text-sm text-muted-foreground">
              {comparison.changes.length
                ? comparison.changes.length +
                  ' thay đổi giữa v' +
                  comparison.before.version +
                  ' và v' +
                  comparison.after.version
                : 'Hai phiên bản có cùng cấu hình.'}
            </p>
            {Object.entries(sections).map(([section, title]) => {
              const changes = comparison.changes.filter((change) => change.section === section);
              return (
                changes.length > 0 && (
                  <section key={section} className="space-y-2">
                    <h3 className="text-sm font-semibold">{title}</h3>
                    {changes.map((change) => (
                      <details key={change.key} className="min-w-0 rounded-md border">
                        <summary className="min-h-11 cursor-pointer break-words p-3 text-sm">
                          <Badge variant="secondary" className="mr-2">
                            {kinds[change.kind]}
                          </Badge>
                          {change.label}
                        </summary>
                        <div className="grid min-w-0 grid-cols-1 gap-3 border-t p-3 sm:grid-cols-2">
                          {(
                            [
                              ['before', comparison.before.version],
                              ['after', comparison.after.version],
                            ] as const
                          ).map(([side, version]) => (
                            <div key={side} className="min-w-0">
                              <p className="pb-1 text-xs font-semibold">v{version}</p>
                              <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">
                                {Object.hasOwn(change, side)
                                  ? JSON.stringify(change[side], null, 2)
                                  : '—'}
                              </pre>
                            </div>
                          ))}
                        </div>
                      </details>
                    ))}
                  </section>
                )
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          {history?.canPublish && chosen && chosen.version !== history.latestVersion && (
            <Button onClick={() => onRestore(chosen, history.revision)}>
              Khôi phục v{chosen.version}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
