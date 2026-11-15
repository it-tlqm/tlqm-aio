import { useEffect, useId, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { taskTarget } from '@/lib/task-target';
import { parseWorkCenterRoute, updateWorkCenterRoute } from '@/lib/work-center-route';
import { dayLabel, statusLabel } from '../tasks/api';
import type { TaskWorkPage, TaskWorkReminder } from '../../../src/tasks/options';

type Source = { baseUrl: string };
type Feed = (TaskWorkPage & { source: Source }) | { items: TaskWorkReminder[]; source: Source };
const reminderLabel = { due: 'Sắp đến hạn', overdue: 'Quá hạn' } as const;

export function TaskWorkPanel({ tenantId }: { tenantId: string }) {
  const searchId = useId();
  const initialRoute = parseWorkCenterRoute(location.hash);
  const [tab, setTab] = useState<'assigned' | 'reminders'>(initialRoute.taskTab);
  const [input, setInput] = useState(initialRoute.taskSearch);
  const [search, setSearch] = useState(initialRoute.taskSearch);
  const [cursors, setCursors] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const after = cursors.at(-1);
  const query = new URLSearchParams({ tenantId });
  if (tab === 'assigned' && search) query.set('search', search);
  if (tab === 'assigned' && after) query.set('after', after);
  const endpoint = '/api/v1/work-center/tasks/' + tab + '?' + query;
  const [state, setState] = useState<{
    endpoint: string;
    refresh: number;
    data?: Feed;
    error?: unknown;
  }>();
  const current = state?.endpoint === endpoint && state.refresh === refresh ? state : undefined;
  const reload = () => {
    setCursors([]);
    setRefresh((value) => value + 1);
  };
  useEffect(() => {
    const controller = new AbortController();
    void api<Feed>(endpoint, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ endpoint, refresh, data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ endpoint, refresh, error });
      });
    return () => controller.abort();
  }, [endpoint, refresh]);
  useEffect(() => {
    const update = () => {
      const route = parseWorkCenterRoute(location.hash);
      setTab(route.taskTab);
      setInput(route.taskSearch);
      setSearch(route.taskSearch);
      setCursors([]);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const next = updateWorkCenterRoute(location.hash, { taskTab: tab, taskSearch: search });
    if (next !== location.hash) window.history.replaceState(null, '', next);
  }, [tab, search]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRefresh((value) => value + 1);
    }, 60000);
    return () => window.clearInterval(timer);
  }, []);

  const next = current?.data && 'nextAfter' in current.data ? current.data.nextAfter : null;
  return (
    <section className="min-w-0 space-y-4" aria-label="Công việc được giao">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold text-[var(--brand-navy)]">Công việc</h2>
        <Button variant="outline" onClick={reload}>
          <RefreshCw aria-hidden="true" /> Tải lại công việc
        </Button>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as 'assigned' | 'reminders');
          setCursors([]);
        }}
      >
        <TabsList aria-label="Nhóm công việc">
          <TabsTrigger value="assigned">Việc được giao</TabsTrigger>
          <TabsTrigger value="reminders">Nhắc hạn</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="mt-4 space-y-4">
          {tab === 'assigned' && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setSearch(input.trim());
                reload();
              }}
            >
              <div className="min-w-0 grow sm:max-w-md">
                <Label htmlFor={searchId}>Tìm công việc hoặc dự án</Label>
                <Input
                  id={searchId}
                  value={input}
                  maxLength={120}
                  className="mt-1"
                  onChange={(event) => setInput(event.target.value)}
                />
              </div>
              <Button type="submit">Tìm kiếm</Button>
            </form>
          )}
          {!current && <p role="status">Đang tải công việc…</p>}
          {current?.error != null && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(current.error)}</AlertDescription>
            </Alert>
          )}
          {current?.data && (
            <>
              {current.data.items.length === 0 ? (
                <p role="status" className="text-muted-foreground">
                  {tab === 'assigned'
                    ? 'Không có công việc được giao trong danh sách này.'
                    : 'Chưa có nhắc hạn công việc.'}
                </p>
              ) : (
                <ul className="divide-y rounded-md border bg-card">
                  {current.data.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-3 p-4"
                    >
                      <div className="min-w-0 space-y-1">
                        <h3 className="break-words font-medium">{item.title}</h3>
                        {'projectName' in item && (
                          <p className="break-words text-sm text-muted-foreground">
                            {item.projectName}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                          <Badge variant="outline">
                            {'kind' in item
                              ? reminderLabel[item.kind]
                              : (item.stageName ?? statusLabel[item.status])}
                          </Badge>
                          {'overdue' in item && item.overdue && (
                            <Badge variant="destructive">Quá hạn</Badge>
                          )}
                          <span>{dayLabel(item.dueOn)}</span>
                        </div>
                      </div>
                      <Button variant="outline" asChild>
                        <a
                          aria-label={'Mở công việc ' + item.title}
                          href={
                            current.data!.source.baseUrl +
                            '/' +
                            taskTarget(
                              tenantId,
                              item.projectId,
                              'taskId' in item ? item.taskId : item.id,
                            )
                          }
                        >
                          Mở công việc <ArrowUpRight aria-hidden="true" />
                        </a>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {(after || next) && (
                <nav aria-label="Phân trang công việc" className="flex flex-wrap gap-2">
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
            </>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
