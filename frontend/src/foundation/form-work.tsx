import { useEffect, useId, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { api } from '@/lib/api';
import { formTarget } from '@/lib/form-target';
import { errorMessage } from '@/lib/messages';
import { parseWorkCenterRoute, updateWorkCenterRoute } from '@/lib/work-center-route';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FormWorkPage } from '../../../src/forms/work-center';

type Feed = FormWorkPage & { source: { baseUrl: string } };
export function FormWorkPanel({ tenantId }: { tenantId: string }) {
  const id = useId();
  const initialRoute = parseWorkCenterRoute(location.hash);
  const [input, setInput] = useState(initialRoute.formSearch);
  const [search, setSearch] = useState(initialRoute.formSearch);
  const [cursors, setCursors] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const after = cursors.at(-1);
  const endpoint =
    '/api/v1/work-center/forms?' +
    new URLSearchParams({ tenantId, ...(after && { after }), ...(search && { search }) });
  const key = endpoint + '#' + refresh;
  const [state, setState] = useState<{ key: string; data?: Feed; error?: unknown }>();
  const current = state?.key === key ? state : undefined;
  const reload = () => {
    setCursors([]);
    setRefresh((value) => value + 1);
  };
  useEffect(() => {
    const request = new AbortController();
    void api<Feed>(endpoint, { signal: request.signal })
      .then((data) => {
        if (!request.signal.aborted) setState({ key, data });
      })
      .catch((error: unknown) => {
        if (!request.signal.aborted) setState({ key, error });
      });
    return () => request.abort();
  }, [endpoint, key]);
  useEffect(() => {
    const update = () => {
      const route = parseWorkCenterRoute(location.hash);
      setInput(route.formSearch);
      setSearch(route.formSearch);
      setCursors([]);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const next = updateWorkCenterRoute(location.hash, { formSearch: search });
    if (next !== location.hash) window.history.replaceState(null, '', next);
  }, [search]);
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') setRefresh((value) => value + 1);
    };
    const timer = window.setInterval(refreshVisible, 60000);
    window.addEventListener('pageshow', refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pageshow', refreshVisible);
    };
  }, []);
  const next = current?.data?.nextCursor;
  return (
    <section aria-label="Biểu mẫu cần trả lời" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold text-[var(--brand-navy)]">Biểu mẫu</h2>
        <Button variant="outline" onClick={reload}>
          Tải lại biểu mẫu
        </Button>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(input.trim());
          reload();
        }}
      >
        <div className="min-w-0 grow sm:max-w-md">
          <Label htmlFor={id}>Tìm biểu mẫu</Label>
          <Input
            id={id}
            className="mt-1"
            maxLength={120}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </div>
        <Button type="submit">Tìm kiếm</Button>
      </form>
      {!current && <p role="status">Đang tải biểu mẫu…</p>}
      {current?.error != null && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(current.error)}</AlertDescription>
        </Alert>
      )}
      {current?.data &&
        (current.data.items.length ? (
          <ul className="divide-y rounded-md border bg-card">
            {current.data.items.map((item) => {
              const action = item.action === 'resume' ? 'Tiếp tục bản nháp' : 'Điền biểu mẫu';
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0 space-y-1">
                    <h3 className="break-words font-medium">{item.title}</h3>
                    <Badge variant="outline">Phiên bản {item.version}</Badge>
                  </div>
                  <Button variant="outline" asChild>
                    <a
                      aria-label={action + ' ' + item.title}
                      href={current.data!.source.baseUrl + '/' + formTarget(tenantId, item.id)}
                    >
                      {action} <ArrowUpRight aria-hidden="true" />
                    </a>
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p role="status" className="text-muted-foreground">
            Không có biểu mẫu cần trả lời.
          </p>
        ))}
      {(after || next) && (
        <nav aria-label="Phân trang biểu mẫu" className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!after}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            Trang trước
          </Button>
          <Button
            variant="outline"
            disabled={!next}
            onClick={() => {
              if (next) setCursors([...cursors, next]);
            }}
          >
            Trang sau
          </Button>
        </nav>
      )}
    </section>
  );
}
