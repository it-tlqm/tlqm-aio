import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Save, Search } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Choice } from '../forms/common';
import { actionLabels, stateLabels } from './common';
import type { RunListItem, workflowWrite } from './common';
import {
  defaultWorkspaceColumns,
  workflowRunStatuses,
  workflowDueFilters,
  workspaceColumns,
  workspaceColumnPattern,
} from '../../../src/workflows/workspace-options';
import type {
  WorkflowRunView,
  WorkspacePreset,
  WorkspaceSettings,
} from '../../../src/workflows/workspace-options';

type Option = { id: string; name: string };
type Page = {
  items: RunListItem[];
  fields: (Option & { label: string })[];
  nextCursor: string | null;
};
const dueLabels = { overdue: 'Quá hạn', today: 'Đến hạn hôm nay', upcoming: 'Chưa đến hạn' };
const columnNames = {
  step: 'Bước xử lý',
  assignee: 'Người được giao',
  status: 'Trạng thái',
  due: 'Hạn xử lý',
  unit: 'Đơn vị',
  created: 'Ngày gửi',
  handled: 'Đã xử lý lúc',
};
const dates = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});
const formatTime = (value?: string | null) => (value ? dates.format(new Date(value)) : '—');
const empty = (view: WorkflowRunView): WorkspaceSettings => ({
  columns: [...defaultWorkspaceColumns, ...(view === 'done' ? ['handled'] : [])],
});
function fromLocation(view: WorkflowRunView): WorkspaceSettings {
  const parameters = new URLSearchParams(location.hash.split('?')[1]);
  const status = workflowRunStatuses.find((v) => v === parameters.get('status'));
  const due = workflowDueFilters.find((v) => v === parameters.get('due'));
  const search = parameters.get('search')?.slice(0, 120);
  const unit = parameters.get('unitId') ?? '';
  const unitId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(unit)
    ? unit
    : undefined;
  const columns = parameters.has('columns')
    ? [
        ...new Set(
          (parameters.get('columns') ?? '')
            .split(',')
            .filter((id) => new RegExp(workspaceColumnPattern).test(id)),
        ),
      ].slice(0, 12)
    : empty(view).columns;
  return {
    columns,
    ...(status && { status }),
    ...(due && { due }),
    ...(search && { search }),
    ...(unitId && { unitId }),
  };
}
function queryFor(settings: WorkspaceSettings) {
  return new URLSearchParams({
    ...(settings.search && { search: settings.search }),
    ...(settings.unitId && { unitId: settings.unitId }),
    ...(settings.status && { status: settings.status }),
    ...(settings.due && { due: settings.due }),
    columns: settings.columns.join(','),
  });
}
export function WorkflowWorkspace({
  tenantId,
  view,
  units,
  write,
  onOpen,
}: {
  tenantId: string;
  view: WorkflowRunView;
  units: Option[];
  write: ReturnType<typeof workflowWrite>;
  onOpen: (id: string, taskId?: string) => Promise<void>;
}) {
  const [settings, setSettings] = useState(() => fromLocation(view));
  const [draft, setDraft] = useState(settings);
  const [page, setPage] = useState<Page>({ items: [], fields: [], nextCursor: null });
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [presets, setPresets] = useState<WorkspacePreset[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const previousFilter = useRef('');
  const selected = presets.find((preset) => preset.id === selectedId);
  const base = new URLSearchParams({ tenantId, view }).toString();
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: WorkspacePreset[] }>('/api/v1/workflows/workspace-views?' + base, {
      signal: controller.signal,
    })
      .then((result) => setPresets(result.items))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err);
      });
    return () => controller.abort();
  }, [base]);
  async function load(after?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    const filterKey = queryFor({ ...settings, columns: [] }).toString();
    if (!after) {
      const sameFilter = previousFilter.current === filterKey;
      previousFilter.current = filterKey;
      setPage((old) => ({ items: [], fields: sameFilter ? old.fields : [], nextCursor: null }));
    }
    const query = queryFor(settings);
    query.set('fields', 'true');
    if (after) query.set('after', after);
    try {
      const result = await api<Page>('/api/v1/workflows/runs?' + base + '&' + query, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted)
        setPage((old) => ({
          ...result,
          items: after ? [...old.items, ...result.items] : result.items,
          fields: after
            ? [
                ...new Map(
                  [...old.fields, ...result.fields].map((field) => [field.id, field]),
                ).values(),
              ]
            : result.fields,
        }));
    } catch (err) {
      if (!controller.signal.aborted) {
        if (err instanceof ApiError && [401, 403].includes(err.status))
          setPage({ items: [], fields: [], nextCursor: null });
        setError(err);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [base, settings, reload]);
  function apply(next: WorkspaceSettings) {
    setError(null);
    setSettings(next);
    setDraft(next);
    window.history.replaceState(null, '', '#workflows/' + view + '?' + queryFor(next));
  }
  async function save(update: boolean) {
    setBusy(true);
    setError(null);
    try {
      const saved = await write<WorkspacePreset>(
        '/workspace-views' + (update && selected ? '/' + selected.id : ''),
        {
          view,
          name,
          settings: draft,
          ...(update && selected && { expectedRevision: selected.revision }),
        },
        'Lưu bộ lọc bàn làm việc',
      );
      setPresets((old) =>
        [...old.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name, 'vi'),
        ),
      );
      setSelectedId(saved.id);
      apply(saved.settings);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await write(
        '/workspace-views/' + selected.id + '/archive',
        { view, expectedRevision: selected.revision },
        'Bỏ bộ lọc đã lưu',
      );
      setPresets((old) => old.filter((item) => item.id !== selected.id));
      setSelectedId('');
      setName('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const options = [
    ...workspaceColumns
      .filter((id) => id !== 'handled' || view === 'done')
      .map((id) => ({ id, name: columnNames[id] })),
    ...page.fields,
  ];
  const labels = new Map(options.map((option) => [option.id, option.name]));
  const columns = settings.columns.filter((id) => labels.has(id));
  const unitNames = new Map(units.map((unit) => [unit.id, unit.name]));
  function renderCell(id: string, row: RunListItem) {
    switch (id) {
      case 'step':
        return row.task_label ?? '—';
      case 'assignee':
        return row.assignee_name ?? '—';
      case 'status':
        return <Badge variant="outline">{stateLabels[row.status]}</Badge>;
      case 'due':
        return (
          <span className={row.overdue ? 'text-destructive' : undefined}>
            {row.overdue && 'Quá hạn · '}
            {formatTime(row.due_at)}
          </span>
        );
      case 'unit':
        return unitNames.get(row.org_unit_id) ?? '—';
      case 'created':
        return formatTime(row.created_at);
      case 'handled':
        return (
          <span>
            {formatTime(row.handled_at)}
            {row.handled_action && (
              <span className="mt-1 block text-xs text-muted-foreground">
                {actionLabels['task.' + row.handled_action] ?? row.handled_action}
              </span>
            )}
          </span>
        );
      default:
        return row.cells?.[id] ?? '—';
    }
  }
  return (
    <div className="min-w-0 space-y-4">
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent className="space-y-4">
          <form
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              apply(draft);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="workspace-search">Tìm hồ sơ</Label>
              <Input
                id="workspace-search"
                value={draft.search ?? ''}
                maxLength={120}
                placeholder="Tiêu đề, quy trình hoặc mã"
                onChange={(event) => setDraft({ ...draft, search: event.target.value })}
              />
            </div>
            <Choice
              label="Trạng thái hồ sơ"
              value={draft.status ?? 'any'}
              options={[
                { id: 'any', name: 'Tất cả trạng thái' },
                ...workflowRunStatuses.map((id) => ({ id, name: stateLabels[id]! })),
              ]}
              onChange={(value) =>
                setDraft({ ...draft, status: workflowRunStatuses.find((id) => id === value) })
              }
            />
            <Choice
              label="Đơn vị của hồ sơ"
              value={draft.unitId ?? 'any'}
              options={[{ id: 'any', name: 'Tất cả đơn vị' }, ...units]}
              onChange={(value) =>
                setDraft({ ...draft, unitId: value === 'any' ? undefined : value })
              }
            />
            {view !== 'done' && (
              <Choice
                label="Lọc theo hạn"
                value={draft.due ?? 'any'}
                options={[
                  { id: 'any', name: 'Tất cả hạn' },
                  ...workflowDueFilters.map((id) => ({ id, name: dueLabels[id] })),
                ]}
                onChange={(value) =>
                  setDraft({ ...draft, due: workflowDueFilters.find((id) => id === value) })
                }
              />
            )}
            <div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-4">
              <Button type="submit">
                <Search aria-hidden /> Áp dụng bộ lọc
              </Button>
              <Button type="button" variant="ghost" onClick={() => apply(empty(view))}>
                Đặt lại
              </Button>
              <Button type="button" variant="outline" onClick={() => setReload((old) => old + 1)}>
                <RefreshCw aria-hidden /> Tải lại danh sách
              </Button>
            </div>
          </form>
          <details className="rounded-md border p-3">
            <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
              Bộ lọc đã lưu và cột hiển thị
            </summary>
            <div className="space-y-4 pt-2">
              <fieldset className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
                <legend className="mb-2 text-sm font-medium">Cột hiển thị</legend>
                {options.map((column) => (
                  <label
                    key={column.id}
                    className="flex min-h-11 min-w-0 items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={settings.columns.includes(column.id)}
                      disabled={
                        settings.columns.length >= 12 && !settings.columns.includes(column.id)
                      }
                      onCheckedChange={(checked) =>
                        apply({
                          ...settings,
                          columns: checked
                            ? [...settings.columns, column.id]
                            : settings.columns.filter((id) => id !== column.id),
                        })
                      }
                    />
                    <span className="min-w-0 break-words">{column.name}</span>
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <Choice
                  label="Chọn bộ lọc đã lưu"
                  value={selectedId || 'new'}
                  options={[{ id: 'new', name: 'Bộ lọc mới' }, ...presets]}
                  onChange={(id) => {
                    const preset = presets.find((item) => item.id === id);
                    setSelectedId(preset?.id ?? '');
                    setName(preset?.name ?? '');
                    if (preset) apply(preset.settings);
                  }}
                />
                <div className="space-y-2">
                  <Label htmlFor="workspace-name">Tên bộ lọc</Label>
                  <Input
                    id="workspace-name"
                    maxLength={80}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!name.trim() || busy}
                  onClick={() => void save(false)}
                >
                  <Save aria-hidden /> Lưu bộ lọc mới
                </Button>
                {selected && (
                  <>
                    <Button
                      variant="outline"
                      disabled={!name.trim() || busy}
                      onClick={() => void save(true)}
                    >
                      Cập nhật bộ lọc
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => void archive()}>
                      Bỏ bộ lọc đã lưu
                    </Button>
                  </>
                )}
              </div>
            </div>
          </details>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <Table containerProps={{ role: 'region', 'aria-label': 'Bảng hồ sơ', tabIndex: 0 }}>
            <TableHeader>
              <TableRow>
                <TableHead>Lượt chạy</TableHead>
                {columns.map((id) => (
                  <TableHead key={id} title={labels.get(id)} className="min-w-28 whitespace-normal">
                    {page.fields.find((field) => field.id === id)?.label ?? labels.get(id)}
                  </TableHead>
                ))}
                <TableHead>Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((row) => (
                <TableRow key={view === 'inbox' ? (row.task_id ?? row.id) : row.id}>
                  <TableCell className="min-w-44 whitespace-normal">
                    <p className="font-medium">{row.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{row.workflow_name}</p>
                  </TableCell>
                  {columns.map((id) => (
                    <TableCell key={id} className="max-w-64 whitespace-normal break-words">
                      {renderCell(id, row)}
                    </TableCell>
                  ))}
                  <TableCell>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void onOpen(
                          row.id,
                          row.related_task_id ??
                            (view === 'inbox' ? (row.task_id ?? undefined) : undefined),
                        )
                      }
                    >
                      Mở lượt chạy
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!page.items.length && (
                <TableRow>
                  <TableCell
                    colSpan={columns.length + 2}
                    className="py-8 text-center whitespace-normal text-muted-foreground"
                  >
                    {loading ? (
                      <span role="status">Đang tải hồ sơ…</span>
                    ) : (
                      'Không có hồ sơ phù hợp.'
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {page.nextCursor && (
        <Button variant="outline" disabled={loading} onClick={() => void load(page.nextCursor!)}>
          Tải thêm lượt chạy
        </Button>
      )}
    </div>
  );
}
