import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Choice, can } from '../forms/common';
import {
  fieldAggregates,
  reportOptions,
  reportStateLabels,
} from '../../../src/workflows/report-options';
import type {
  FieldAggregate,
  PerformanceReportQuery,
  ReportBucket,
  ReportFieldChoice,
  ReportFieldValue,
  ReportDataset,
  ReportGroup,
  ReportHistory,
  ReportMeasure,
  ReportMetrics,
  ReportObservation,
} from '../../../src/workflows/report-options';

type Version = { id: string; name: string; version: number };
type Summary = {
  observedAt: string;
  groupCount: number;
  page: number;
  pageSize: number;
  totals: ReportMetrics;
  groups: ReportBucket[];
  fieldMetric?: ReportFieldChoice;
};
type Detail = { total: number; items: ReportObservation[]; columns?: ReportFieldChoice[] };
type ReportFields = { fields: ReportFieldChoice[]; values: ReportFieldValue[]; more: boolean };
const aggregateLabels: Record<FieldAggregate, string> = {
  sum: 'Tổng',
  average: 'Trung bình',
  min: 'Nhỏ nhất',
  max: 'Lớn nhất',
};
const datasetLabels: Record<ReportDataset, string> = {
  runs: 'Hồ sơ',
  attempts: 'Lần xử lý',
  decisions: 'Quyết định và phiếu',
};
const groupLabels: Record<ReportGroup, string> = {
  version: 'Quy trình và phiên bản',
  unit: 'Đơn vị',
  step: 'Bước theo phiên bản',
  status: 'Trạng thái / hành động',
  person: 'Người ra quyết định',
  field: 'Trường nghiệp vụ',
};
const measureLabels: Record<ReportMeasure, string> = {
  rows: 'Số dòng',
  runs: 'Số hồ sơ',
  attempts: 'Số lần xử lý',
  people: 'Số người',
  averageSeconds: 'Thời gian trung bình',
  late: 'Số trễ hạn',
  lateRate: 'Tỷ lệ trễ',
  openOverdue: 'Đang quá hạn',
  fieldValue: 'Giá trị tổng hợp theo trường',
};
const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});
const date = (offset: number) =>
  new Date(Date.now() + 7 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
const defaults = (): PerformanceReportQuery => ({
  dataset: 'attempts',
  groupBy: 'step',
  measure: 'rows',
  history: 'effective',
  from: date(-29),
  to: date(0),
});
const options = (ids: readonly string[], labels: Record<string, string>) =>
  ids.map((id) => ({ id, name: labels[id] ?? id }));
const metric = (
  value: string | number | null | undefined,
  measure: ReportMeasure,
  currency?: ReportFieldChoice['currency'],
) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value + (currency ? ' ' + currency : '');
  if (measure === 'averageSeconds')
    return value >= 3600
      ? number.format(value / 3600) + ' giờ'
      : value >= 60
        ? number.format(value / 60) + ' phút'
        : number.format(value) + ' giây';
  return number.format(value) + (measure === 'lateRate' ? '%' : '');
};
const urlParams = (tenantId: string, query: PerformanceReportQuery) =>
  new URLSearchParams({
    tenantId,
    dataset: query.dataset,
    groupBy: query.groupBy,
    measure: query.measure,
    from: query.from,
    to: query.to,
    ...(query.dataset !== 'runs' && query.history ? { history: query.history } : {}),
    ...(query.unitId ? { unitId: query.unitId } : {}),
    ...(query.versionId ? { versionId: query.versionId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.columns ? { columns: query.columns } : {}),
    ...(query.groupField ? { groupField: query.groupField } : {}),
    ...(query.filterField ? { filterField: query.filterField } : {}),
    ...(query.match ? { match: query.match } : {}),
    ...(query.metricField ? { metricField: query.metricField } : {}),
    ...(query.aggregate ? { aggregate: query.aggregate } : {}),
  });
const base = '/api/v1/workflows/performance-report';
export function reportHashTenant() {
  return location.hash.startsWith('#workflows/report?')
    ? new URLSearchParams(location.hash.split('?')[1]).get('tenantId')
    : null;
}
function initialFilters(tenantId: string): PerformanceReportQuery {
  const source =
    location.hash.startsWith('#workflows/report?') && reportHashTenant() === tenantId
      ? new URLSearchParams(location.hash.split('?')[1])
      : new URLSearchParams();
  const fallback = defaults();
  const dataset = source.get('dataset') as ReportDataset | null;
  if (!dataset || !Object.hasOwn(reportOptions, dataset)) return fallback;
  const config = reportOptions[dataset];
  const group = source.get('groupBy') as ReportGroup | null;
  const measure = source.get('measure') as ReportMeasure | null;
  const status = source.get('status');
  const history = source.get('history');
  return {
    dataset,
    groupBy:
      group && (config.groups as readonly ReportGroup[]).includes(group) ? group : config.groups[0],
    measure:
      measure &&
      (measure === 'fieldValue' || (config.measures as readonly ReportMeasure[]).includes(measure))
        ? measure
        : config.measures[0],
    from: source.get('from') ?? fallback.from,
    to: source.get('to') ?? fallback.to,
    history: history === 'all' || history === 'superseded' ? history : 'effective',
    unitId: source.get('unitId') ?? undefined,
    versionId: source.get('versionId') ?? undefined,
    status: status && (config.states as readonly string[]).includes(status) ? status : undefined,
    columns: source.get('columns') ?? undefined,
    groupField: source.get('groupField') ?? undefined,
    filterField: source.get('filterField') ?? undefined,
    match: source.get('match') ?? undefined,
    metricField: source.get('metricField') ?? undefined,
    aggregate: (source.get('aggregate') ?? undefined) as FieldAggregate | undefined,
  };
}

function BusinessFields({
  tenantId,
  draft,
  setDraft,
}: {
  tenantId: string;
  draft: PerformanceReportQuery;
  setDraft: (query: PerformanceReportQuery) => void;
}) {
  const [result, setResult] = useState<ReportFields | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const request = urlParams(tenantId, {
    ...draft,
    groupBy: reportOptions[draft.dataset].groups[0],
    measure: 'rows',
    columns: undefined,
    groupField: undefined,
    metricField: undefined,
    aggregate: undefined,
  });
  if (draft.filterField && search) request.set('search', search);
  const params = request.toString();
  useEffect(() => {
    const abort = new AbortController();
    setResult(null);
    setFailure(null);
    const delay = window.setTimeout(() => {
      void api<ReportFields>(base + '/fields?' + params, { signal: abort.signal })
        .then((data) => {
          if (!abort.signal.aborted) setResult(data);
        })
        .catch((error) => {
          if (!abort.signal.aborted) setFailure(error);
        });
    }, 180);
    return () => {
      window.clearTimeout(delay);
      abort.abort();
    };
  }, [params]);
  const columns = draft.columns?.split(',') ?? [];
  const available = result?.fields.map(({ id, label }) => ({ id, name: label })) ?? [];
  const numeric =
    result?.fields.filter(({ numeric }) => numeric).map(({ id, label }) => ({ id, name: label })) ??
    [];
  return (
    <fieldset className="min-w-0 space-y-3 rounded-md border p-3 sm:p-4">
      <legend className="px-1 text-sm font-semibold">Trường nghiệp vụ</legend>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {draft.groupBy === 'field' && (
          <Choice
            label="Trường để nhóm"
            value={draft.groupField ?? ''}
            options={available}
            disabled={!result}
            onChange={(groupField) => setDraft({ ...draft, groupField })}
          />
        )}
        <Choice
          label="Lọc theo trường"
          value={draft.filterField ?? 'none'}
          options={[{ id: 'none', name: 'Không lọc theo trường' }, ...available]}
          onChange={(value) => {
            setSearch('');
            setDraft({
              ...draft,
              filterField: value === 'none' ? undefined : value,
              match: undefined,
            });
          }}
        />
        {draft.filterField && (
          <>
            <Choice
              label="Giá trị lọc"
              value={draft.match ?? 'all'}
              options={[
                { id: 'all', name: 'Mọi giá trị được xem' },
                ...(result?.values.map(({ id, label }) => ({ id, name: label })) ?? []),
              ]}
              onChange={(value) =>
                setDraft({ ...draft, match: value === 'all' ? undefined : value })
              }
            />
            {(result?.more || search) && (
              <div className="space-y-2">
                <Label htmlFor="report-value-search">Tìm giá trị lọc</Label>
                <Input
                  id="report-value-search"
                  value={search}
                  maxLength={120}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            )}
          </>
        )}
        <Choice
          label="Trường để tính"
          value={draft.metricField ?? 'none'}
          options={[{ id: 'none', name: 'Không tính theo trường' }, ...numeric]}
          onChange={(value) =>
            setDraft({
              ...draft,
              metricField: value === 'none' ? undefined : value,
              aggregate: value === 'none' ? undefined : (draft.aggregate ?? 'sum'),
              measure:
                value === 'none'
                  ? draft.measure === 'fieldValue'
                    ? 'rows'
                    : draft.measure
                  : 'fieldValue',
            })
          }
        />
        {draft.metricField && (
          <Choice
            label="Phép tính"
            value={draft.aggregate ?? 'sum'}
            options={options(fieldAggregates, aggregateLabels)}
            onChange={(value) => setDraft({ ...draft, aggregate: value as FieldAggregate })}
          />
        )}
      </div>
      <details>
        <summary className="cursor-pointer py-2 text-sm font-medium">
          Cột chi tiết ({columns.length}/6)
        </summary>
        <div className="grid gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
          {available.map(({ id, name }) => (
            <label key={id} className="flex min-h-11 min-w-0 items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={columns.includes(id)}
                disabled={!columns.includes(id) && columns.length >= 6}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...columns, id]
                    : columns.filter((column) => column !== id);
                  setDraft({ ...draft, columns: next.length ? next.join(',') : undefined });
                }}
              />
              <span className="break-words">{name}</span>
            </label>
          ))}
        </div>
        {columns.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDraft({ ...draft, columns: undefined })}
          >
            Bỏ chọn cột
          </Button>
        )}
      </details>
      {result && !result.fields.length && (
        <p className="text-sm text-muted-foreground">Không có trường trong phạm vi đã chọn.</p>
      )}
      {!result && failure === null && (
        <p role="status" className="text-sm text-muted-foreground">
          Đang tải trường…
        </p>
      )}
      {failure !== null && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(failure)}</AlertDescription>
        </Alert>
      )}
    </fieldset>
  );
}

function Pagination({
  page,
  pages,
  busy,
  onPage,
}: {
  page: number;
  pages: number;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  if (pages < 2 && page === 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={busy || page === 1} onClick={() => onPage(page - 1)}>
        Trang trước
      </Button>
      <span className="text-sm text-muted-foreground">
        Trang {page} / {Math.max(1, pages)}
      </span>
      <Button variant="outline" disabled={busy || page >= pages} onClick={() => onPage(page + 1)}>
        Trang sau
      </Button>
    </div>
  );
}

export function WorkflowPerformanceReport({
  tenantId,
  me,
  units,
  onOpen,
}: {
  tenantId: string;
  me: Me;
  units: { id: string; name: string }[];
  onOpen: (runId: string, taskId?: string, history?: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => initialFilters(tenantId));
  const [filters, setFilters] = useState(draft);
  const [sharedTenant, setSharedTenant] = useState(reportHashTenant);
  const [versions, setVersions] = useState<Version[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [chart, setChart] = useState(false);
  const [selected, setSelected] = useState<ReportBucket | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [sharing, setSharing] = useState(false);
  const [exporting, setExporting] = useState<'summary' | 'detail' | null>(null);
  const [reason, setReason] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const exportKey = useRef<{ signature: string; id: string } | null>(null);
  const matchTenant = !sharedTenant || sharedTenant === tenantId;
  const labels = new Map(units.map((unit) => [unit.id, unit.name]));
  const allowedUnits = units.filter(
    ({ id }) =>
      can(me, tenantId, 'workflows:report', id) || can(me, tenantId, 'workflows:manage', id),
  );
  const bucketLabel = (bucket: ReportBucket) =>
    filters.groupBy === 'unit'
      ? (labels.get(bucket.key) ?? bucket.label)
      : filters.groupBy === 'status'
        ? (reportStateLabels[bucket.label] ?? bucket.label)
        : bucket.label;
  const measures: ReportMeasure[] = [...reportOptions[filters.dataset].measures];
  if (summary?.fieldMetric) measures.push('fieldValue');
  const measureLabel = (measure: ReportMeasure) =>
    measure === 'fieldValue' && summary?.fieldMetric && filters.aggregate
      ? aggregateLabels[filters.aggregate] + ' · ' + summary.fieldMetric.label
      : measureLabels[measure];
  const format = (value: ReportMetrics, measure: ReportMeasure) =>
    metric(value[measure], measure, summary?.fieldMetric?.currency);
  const shareUrl =
    location.origin + location.pathname + '#workflows/report?' + urlParams(tenantId, filters);

  useEffect(() => {
    const update = () => {
      if (!location.hash.startsWith('#workflows/report')) return;
      const query = initialFilters(tenantId);
      setSharedTenant(reportHashTenant());
      setDraft(query);
      setFilters(query);
      setSelected(null);
      setPage(1);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [tenantId]);
  useEffect(() => {
    const abort = new AbortController();
    void api<{ items: Version[] }>(base + '/versions?' + new URLSearchParams({ tenantId }), {
      signal: abort.signal,
    })
      .then(({ items }) => {
        if (!abort.signal.aborted) setVersions(items);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure);
      });
    return () => abort.abort();
  }, [tenantId]);
  useEffect(() => {
    const abort = new AbortController();
    if (!matchTenant) return;
    setBusy(true);
    setError(null);
    setSummary(null);
    const query = urlParams(tenantId, filters);
    query.set('page', String(page));
    void api<Summary>(base + '?' + query, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setSummary(result);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [tenantId, filters, page, refresh, matchTenant]);
  useEffect(() => {
    if (!selected || !summary || !matchTenant) return;
    const abort = new AbortController();
    setDetail(null);
    setDetailError(null);
    const query = urlParams(tenantId, filters);
    query.set('group', selected.key);
    query.set('page', String(detailPage));
    query.set('observedAt', summary.observedAt);
    void api<Detail>(base + '/details?' + query, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setDetail(result);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setDetailError(failure);
      });
    return () => abort.abort();
  }, [tenantId, filters, selected, summary, detailPage, matchTenant]);

  function apply() {
    setSelected(null);
    setSharedTenant(tenantId);
    setPage(1);
    setFilters({ ...draft });
    setNotice('');
    window.history.replaceState(null, '', '#workflows/report?' + urlParams(tenantId, draft));
  }
  function openBucket(bucket: ReportBucket) {
    setDetail(null);
    setDetailPage(1);
    setSelected(bucket);
  }
  function openExport(mode: 'summary' | 'detail') {
    setExporting(mode);
    setReason('');
    setExportError(null);
    exportKey.current = null;
  }
  async function download() {
    setExportBusy(true);
    setExportError(null);
    try {
      const body = JSON.stringify({
        tenantId,
        report: filters,
        reason,
        ...(exporting === 'detail' && { group: selected?.key }),
      });
      if (exportKey.current?.signature !== body)
        exportKey.current = { signature: body, id: crypto.randomUUID() };
      const response = await fetch(base + '/export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': me.csrfToken,
          'idempotency-key': exportKey.current.id,
        },
        body,
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new ApiError(response.status, failure.error ?? 'REQUEST_FAILED');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bao-cao-quy-trinh.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Đã tải báo cáo CSV.');
      setExporting(null);
    } catch (failure) {
      setExportError(failure);
    } finally {
      setExportBusy(false);
    }
  }
  const chartValues =
    summary?.groups.map((bucket) => Number(bucket.metrics[filters.measure] ?? 0)) ?? [];
  const min = Math.min(0, ...chartValues);
  const max = filters.measure === 'lateRate' ? 100 : Math.max(1, ...chartValues);

  return (
    <div className="min-w-0 space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Hiệu quả xử lý</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              apply();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Choice
                label="Nguồn dữ liệu"
                value={draft.dataset}
                options={options(Object.keys(datasetLabels), datasetLabels)}
                onChange={(value) => {
                  const dataset = value as ReportDataset;
                  const config = reportOptions[dataset];
                  setDraft({
                    ...draft,
                    dataset,
                    groupBy: config.groups[0],
                    measure: config.measures[0],
                    status: undefined,
                    groupField: undefined,
                    columns: undefined,
                    filterField: undefined,
                    match: undefined,
                    metricField: undefined,
                    aggregate: undefined,
                  });
                }}
              />
              <Choice
                label="Nhóm theo"
                value={draft.groupBy}
                options={options(
                  reportOptions[draft.dataset].groups.filter(
                    (id) => id !== 'field' || draft.versionId,
                  ),
                  groupLabels,
                )}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    groupBy: value as ReportGroup,
                    groupField: value === 'field' ? draft.groupField : undefined,
                  })
                }
              />
              <Choice
                label="Chỉ số chính"
                value={draft.measure}
                options={options(
                  [
                    ...reportOptions[draft.dataset].measures,
                    ...(draft.metricField ? ['fieldValue'] : []),
                  ],
                  measureLabels,
                )}
                onChange={(value) => setDraft({ ...draft, measure: value as ReportMeasure })}
              />
              {draft.dataset !== 'runs' && (
                <Choice
                  label="Lịch sử xử lý"
                  value={draft.history ?? 'effective'}
                  options={options(['effective', 'all', 'superseded'], {
                    effective: 'Đường xử lý còn hiệu lực',
                    all: 'Tất cả lần xử lý',
                    superseded: 'Lần đã thay thế',
                  })}
                  onChange={(value) => setDraft({ ...draft, history: value as ReportHistory })}
                />
              )}
              <div className="space-y-2">
                <Label htmlFor="report-from">Từ ngày</Label>
                <Input
                  id="report-from"
                  type="date"
                  required
                  value={draft.from}
                  onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="report-to">Đến ngày</Label>
                <Input
                  id="report-to"
                  type="date"
                  required
                  value={draft.to}
                  onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                />
              </div>
              <Choice
                label="Đơn vị báo cáo"
                value={draft.unitId ?? 'all'}
                options={[{ id: 'all', name: 'Tất cả đơn vị trong phạm vi' }, ...allowedUnits]}
                onChange={(value) =>
                  setDraft({ ...draft, unitId: value === 'all' ? undefined : value })
                }
              />
              <Choice
                label="Phiên bản quy trình"
                value={draft.versionId ?? 'all'}
                options={[
                  { id: 'all', name: 'Tất cả phiên bản trong phạm vi' },
                  ...versions.map((item) => ({
                    id: item.id,
                    name: item.name + ' · v' + item.version,
                  })),
                ]}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    versionId: value === 'all' ? undefined : value,
                    groupBy:
                      draft.groupBy === 'field'
                        ? reportOptions[draft.dataset].groups[0]
                        : draft.groupBy,
                    measure: draft.measure === 'fieldValue' ? 'rows' : draft.measure,
                    columns: undefined,
                    groupField: undefined,
                    filterField: undefined,
                    match: undefined,
                    metricField: undefined,
                    aggregate: undefined,
                  })
                }
              />
              <Choice
                label="Trạng thái báo cáo"
                value={draft.status ?? 'all'}
                options={[
                  { id: 'all', name: 'Tất cả trạng thái' },
                  ...options(reportOptions[draft.dataset].states, reportStateLabels),
                ]}
                onChange={(value) =>
                  setDraft({ ...draft, status: value === 'all' ? undefined : value })
                }
              />
            </div>
            {draft.versionId && (
              <BusinessFields
                key={draft.versionId}
                tenantId={tenantId}
                draft={draft}
                setDraft={setDraft}
              />
            )}
            <Button
              type="submit"
              disabled={(matchTenant && busy) || (draft.groupBy === 'field' && !draft.groupField)}
            >
              Áp dụng bộ lọc
            </Button>
          </form>
        </CardContent>
      </Card>
      {!matchTenant && (
        <Alert>
          <AlertDescription>
            Liên kết dành cho không gian khác. Chọn không gian có quyền hoặc áp dụng bộ lọc cho
            không gian đang mở.
          </AlertDescription>
        </Alert>
      )}
      {matchTenant && busy && (
        <p role="status" className="text-sm text-muted-foreground">
          Đang tính báo cáo…
        </p>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm text-[var(--success)]">
          {notice}
        </p>
      )}
      {matchTenant && summary && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>
                {datasetLabels[filters.dataset]} theo{' '}
                {groupLabels[filters.groupBy].toLocaleLowerCase('vi-VN')}
              </h3>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                variant={chart ? 'outline' : 'secondary'}
                aria-pressed={!chart}
                onClick={() => setChart(false)}
              >
                Bảng
              </Button>
              <Button
                variant={chart ? 'secondary' : 'outline'}
                aria-pressed={chart}
                onClick={() => setChart(true)}
              >
                Biểu đồ
              </Button>
              <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
                Tải lại số liệu
              </Button>
              <Button variant="outline" onClick={() => setSharing(true)}>
                Chia sẻ bộ lọc
              </Button>
              <Button
                variant="outline"
                disabled={!summary.groupCount}
                onClick={() => openExport('summary')}
              >
                Tải CSV tổng hợp
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {time.format(new Date(summary.observedAt))} · {number.format(summary.groupCount)} nhóm
              · {number.format(summary.totals.rows ?? 0)} dòng
              {chart &&
                filters.measure !== 'rows' &&
                ' · ' +
                  measureLabel(filters.measure) +
                  ' trong phạm vi ' +
                  format(summary.totals, filters.measure)}
            </p>
            {summary.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">Không có dữ liệu cho bộ lọc này.</p>
            ) : chart ? (
              <ul className="space-y-3" aria-label={'Biểu đồ ' + measureLabel(filters.measure)}>
                {summary.groups.map((bucket) => (
                  <li
                    key={bucket.key}
                    className="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="break-words text-sm font-medium">
                          {bucketLabel(bucket)}
                        </span>
                        <span className="text-sm">{format(bucket.metrics, filters.measure)}</span>
                      </div>
                      <meter
                        className="h-3 w-full accent-primary"
                        min={min}
                        max={max}
                        value={Number(bucket.metrics[filters.measure] ?? 0)}
                        aria-label={bucketLabel(bucket) + ' · ' + measureLabel(filters.measure)}
                      />
                    </div>
                    <Button
                      variant="outline"
                      aria-label={'Chi tiết nhóm ' + bucketLabel(bucket)}
                      onClick={() => openBucket(bucket)}
                    >
                      Chi tiết
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <Table
                containerProps={{
                  tabIndex: 0,
                  role: 'region',
                  'aria-label': 'Bảng tổng hợp báo cáo',
                }}
                className="min-w-max"
              >
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Nhóm</TableHead>
                    {measures.map((item) => (
                      <TableHead scope="col" key={item} className="text-right">
                        {item === 'rows' ? datasetLabels[filters.dataset] : measureLabel(item)}
                      </TableHead>
                    ))}
                    <TableHead scope="col">Chi tiết</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.groups.map((bucket) => (
                    <TableRow key={bucket.key}>
                      <TableCell className="max-w-72 whitespace-normal break-words">
                        {bucketLabel(bucket)}
                      </TableCell>
                      {measures.map((item) => (
                        <TableCell key={item} className="text-right tabular-nums">
                          {format(bucket.metrics, item)}
                        </TableCell>
                      ))}
                      <TableCell>
                        <Button
                          variant="outline"
                          aria-label={'Chi tiết nhóm ' + bucketLabel(bucket)}
                          onClick={() => openBucket(bucket)}
                        >
                          Chi tiết
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableHead scope="row">Tổng trong phạm vi</TableHead>
                    {measures.map((item) => (
                      <TableCell key={item} className="text-right tabular-nums">
                        {format(summary.totals, item)}
                      </TableCell>
                    ))}
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            )}
            <Pagination
              page={page}
              pages={Math.ceil(summary.groupCount / summary.pageSize)}
              busy={busy}
              onPage={setPage}
            />
          </CardContent>
        </Card>
      )}
      {matchTenant && summary && selected && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>Chi tiết nhóm {bucketLabel(selected)}</h3>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {detailError !== null && (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage(detailError)}</AlertDescription>
              </Alert>
            )}
            {!detail && detailError === null && <p role="status">Đang tải chi tiết…</p>}
            {detail && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-muted-foreground">
                    {number.format(detail.total)} dòng
                  </p>
                  <Button
                    variant="outline"
                    disabled={!detail.total}
                    onClick={() => openExport('detail')}
                  >
                    Tải CSV chi tiết
                  </Button>
                  <Button variant="outline" onClick={() => setSelected(null)}>
                    Đóng chi tiết
                  </Button>
                </div>
                {detail.total !== selected.metrics.rows && (
                  <p className="text-sm text-muted-foreground">
                    Số dòng đã thay đổi khi tải chi tiết. Tải lại số liệu để cập nhật bảng tổng hợp.
                  </p>
                )}
                <ul className="divide-y rounded-md border">
                  {detail.items.map((row, index) => (
                    <li
                      key={[row.runId, row.taskId, row.finishedAt, index].join('/')}
                      className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div className="min-w-0 space-y-1 text-sm">
                        <p className="break-words font-medium">{row.title}</p>
                        <p className="break-words text-muted-foreground">
                          {row.workflow} · v{row.version} · {labels.get(row.unitId) ?? row.unitId}
                        </p>
                        {row.step && (
                          <p className="break-words">
                            {row.step} · vòng {row.round} · lần xử lý {row.attempt}
                            {row.person && ' · ' + row.person}
                          </p>
                        )}
                        <p>
                          {reportStateLabels[row.status] ?? row.status}
                          {row.superseded && ' · Đã thay thế'}
                          {row.late && ' · Trễ hạn'}
                          {row.overdue && ' · Đang quá hạn'}
                        </p>
                        <p className="text-muted-foreground">
                          Bắt đầu {time.format(new Date(row.startedAt))}
                          {row.dueAt && ' · Hạn ' + time.format(new Date(row.dueAt))}
                          {row.finishedAt && ' · Kết thúc ' + time.format(new Date(row.finishedAt))}
                        </p>
                        {detail.columns?.some(
                          ({ id }) => row.fields && Object.hasOwn(row.fields, id),
                        ) && (
                          <dl className="grid gap-2 pt-1 sm:grid-cols-2">
                            {detail.columns
                              .filter(({ id }) => row.fields && Object.hasOwn(row.fields, id))
                              .map(({ id, label, currency }) => (
                                <div key={id} className="min-w-0 break-words">
                                  <dt className="text-muted-foreground">{label}</dt>
                                  <dd>{metric(row.fields?.[id], 'fieldValue', currency)}</dd>
                                </div>
                              ))}
                          </dl>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        aria-label={
                          'Mở hồ sơ ' +
                          row.title +
                          (row.attempt ? ' · lần xử lý ' + row.attempt : '')
                        }
                        onClick={() => onOpen(row.runId, row.taskId ?? undefined, !!row.finishedAt)}
                      >
                        Mở hồ sơ
                      </Button>
                    </li>
                  ))}
                </ul>
                <Pagination
                  page={detailPage}
                  pages={Math.ceil(detail.total / 30)}
                  busy={!detail}
                  onPage={setDetailPage}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}
      <Dialog open={sharing} onOpenChange={setSharing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Chia sẻ bộ lọc báo cáo</DialogTitle>
            <DialogDescription>
              Người mở liên kết xem kết quả theo quyền của tài khoản đang đăng nhập.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="report-link">Liên kết báo cáo</Label>
            <Input
              id="report-link"
              readOnly
              value={shareUrl}
              onFocus={(event) => event.target.select()}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(shareUrl)
                  .then(() => {
                    setNotice('Đã sao chép liên kết báo cáo.');
                    setSharing(false);
                  })
                  .catch(() => document.getElementById('report-link')?.focus())
              }
            >
              Sao chép liên kết
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!exporting}
        onOpenChange={(open) => {
          if (!open && !exportBusy) setExporting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {exporting === 'detail' ? 'Xuất chi tiết báo cáo' : 'Xuất bảng tổng hợp'}
            </DialogTitle>
            <DialogDescription>Nhập lý do để ghi nhật ký xuất dữ liệu.</DialogDescription>
          </DialogHeader>
          {exportError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(exportError)}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="report-export-reason">Lý do xuất</Label>
            <Input
              id="report-export-reason"
              value={reason}
              maxLength={240}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={exportBusy || reason.trim().length < 5}
              onClick={() => void download()}
            >
              Tải CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
