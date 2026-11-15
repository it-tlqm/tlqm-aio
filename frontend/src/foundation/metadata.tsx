import { useEffect, useState } from 'react';
import { ConfigurationTransferControls } from '@/components/configuration-transfer';
import type { ConfigurationKind } from '../../../src/configuration-package';
import { api, apiCollection, allowed, ApiError } from '@/lib/api';
import type { Me, Row } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Paging } from './common';
import { FormDesigner } from '@/forms/designer';
import { FormRenderer, AnswerReadback } from '@/forms/renderer';
import { schemaFields } from '../../../src/forms/contracts';
import type { FormSchema, Answers } from '../../../src/forms/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
type Configuration = { schema: FormSchema; selfView: string[]; selfEdit: string[] };
type ConfigResponse = {
  configuration: { draft: Configuration; revision: number; currentVersion: number } | null;
  versions: { version: number; publishedAt: string }[];
};
type RecordData = {
  schema: FormSchema;
  answers: Answers;
  revision: number;
  schemaVersion: number;
  storedVersion: number;
  selfEdit: string[];
};
const resources = [
  { id: 'people', name: 'Hồ sơ nhân sự' },
  { id: 'org-units', name: 'Đơn vị / phòng ban' },
  { id: 'job-titles', name: 'Chức danh' },
  { id: 'positions', name: 'Vị trí công tác' },
];
const initial = (): Configuration => ({
  schema: {
    schemaVersion: 1,
    title: 'Thông tin mở rộng',
    sections: [
      {
        id: 'general',
        title: 'Thông tin bổ sung',
        fields: [
          { id: 'note', label: 'Ghi chú', type: 'longText', required: false, maxLength: 2000 },
        ],
      },
    ],
  },
  selfView: [],
  selfEdit: [],
});
async function write<T>(
  me: Me,
  path: string,
  tenantId: string,
  reason: string,
  data: object,
  key: string,
) {
  return api<T>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': me.csrfToken,
      'idempotency-key': key,
    },
    body: JSON.stringify({ tenantId, reason, ...data }),
  });
}
function Choice({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  items: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value || '_none'} onValueChange={(v) => onChange(v === '_none' ? '' : v)}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_none">Chọn…</SelectItem>
          {items.map((i) => (
            <SelectItem key={i.id} value={i.id}>
              {i.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function MetadataRecord({
  me,
  tenantId,
  resource,
  id,
  self = false,
}: {
  me: Me;
  tenantId: string;
  resource: string;
  id: string;
  self?: boolean;
}) {
  const [record, setRecord] = useState<RecordData | null>(null),
    [answers, setAnswers] = useState<Answers>({}),
    [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [reason, setReason] = useState(''),
    [version, setVersion] = useState(0),
    [message, setMessage] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [history, setHistory] = useState<Row[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setRecord(null);
    setError(null);
    setHistory(null);
    void api<RecordData>(
      (self ? '/api/v1/profile/me' : '/api/v1/directory-metadata/' + resource + '/' + id) +
        '?tenantId=' +
        tenantId,
      { signal: controller.signal },
    )
      .then((r) => {
        if (!controller.signal.aborted) {
          setRecord(r);
          setAnswers(r.answers);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, resource, id, self, version]);
  const editable = self
    ? !!record?.selfEdit.length
    : allowed(me, tenantId, resource === 'people' ? 'people:manage' : 'directory:manage');
  async function save() {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      if (self) {
        const patch = Object.fromEntries(
          record.selfEdit
            .filter((id) => JSON.stringify(answers[id]) !== JSON.stringify(record.answers[id]))
            .map((id) => [id, answers[id] ?? null]),
        );
        await write(
          me,
          '/api/v1/profile/proposals',
          tenantId,
          reason,
          { patch, expectedRevision: record.revision, schemaVersion: record.schemaVersion },
          key,
        );
        setMessage('Đã gửi đề xuất. Hồ sơ chỉ thay đổi sau khi HR duyệt.');
      } else {
        await write(
          me,
          '/api/v1/directory-metadata/' + resource + '/' + id,
          tenantId,
          reason,
          { answers, expectedRevision: record.revision, schemaVersion: record.schemaVersion },
          key,
        );
        setMessage('Đã lưu hồ sơ và lịch sử phiên bản.');
      }
      setVersion((v) => v + 1);
      setReason('');
      setKey(crypto.randomUUID());
    } catch (e) {
      if (e instanceof ApiError && [403, 404].includes(e.status)) setRecord(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Skeleton className="h-44" />;
  if (error instanceof ApiError && error.code === 'PROFILE_CONFIGURATION_UNPUBLISHED')
    return (
      <Alert>
        <AlertDescription>Chưa có cấu hình thông tin mở rộng được phát hành.</AlertDescription>
      </Alert>
    );
  return (
    <div className="space-y-4">
      {message && (
        <Alert role="status" className="status-success">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {record && (
        <>
          <div className="flex flex-wrap justify-between gap-3">
            <Badge variant="secondary">
              Cấu hình v{record.schemaVersion} · Hồ sơ r{record.revision}
            </Badge>
            {!self && (
              <Button
                variant="outline"
                onClick={() =>
                  void apiCollection<Row>(
                    '/api/v1/directory-metadata/' +
                      resource +
                      '/' +
                      id +
                      '/history?tenantId=' +
                      tenantId,
                  )
                    .then((r) => setHistory(r.items))
                    .catch(setError)
                }
              >
                Xem lịch sử
              </Button>
            )}
          </div>
          {record.storedVersion && record.storedVersion !== record.schemaVersion ? (
            <Alert>
              <AlertDescription>
                Cấu hình đã có phiên bản mới. Các trường cũ vẫn được giữ trong lịch sử; hãy rà soát
                trước khi lưu.
              </AlertDescription>
            </Alert>
          ) : null}
          {record.schema.sections.length ? (
            <FormRenderer
              schema={record.schema}
              issues={error instanceof ApiError ? error.issues : []}
              answers={answers}
              disabled={busy || !editable}
              readOnlyFields={
                self
                  ? schemaFields(record.schema)
                      .filter((f) => !record.selfEdit.includes(f.id))
                      .map((f) => f.id)
                  : []
              }
              onChange={(values) => {
                setAnswers(values);
                setKey(crypto.randomUUID());
                setMessage('');
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Chưa có trường được phép xem.</p>
          )}
          {editable && (
            <div className="space-y-3">
              <Label htmlFor={'metadata-reason-' + id}>
                {self ? 'Lý do đề xuất cập nhật' : 'Lý do cập nhật thông tin'}
              </Label>
              <Input
                id={'metadata-reason-' + id}
                disabled={busy}
                value={reason}
                maxLength={240}
                onChange={(e) => {
                  setReason(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              />
              <Button disabled={busy || reason.trim().length < 5} onClick={() => void save()}>
                {self ? 'Gửi HR duyệt' : 'Lưu thông tin mở rộng'}
              </Button>
            </div>
          )}
        </>
      )}
      <Dialog
        open={history !== null}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Lịch sử thông tin mở rộng</DialogTitle>
            <DialogDescription>
              Thông tin và nhãn trường tại từng phiên bản đã lưu.
            </DialogDescription>
          </DialogHeader>
          {history?.length ? (
            history.map((h) => (
              <Card key={String(h.id)}>
                <CardHeader>
                  <CardTitle>
                    Hồ sơ r{String(h.revision)} · Cấu hình v{String(h.schemaVersion)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <AnswerReadback
                    schema={(h.configuration as Configuration).schema}
                    answers={h.answers as Answers}
                  />
                </CardContent>
              </Card>
            ))
          ) : (
            <p>Chưa có lịch sử.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function ProposalQueue({
  me,
  tenantId,
  self = false,
}: {
  me: Me;
  tenantId: string;
  self?: boolean;
}) {
  const [items, setItems] = useState<Row[]>([]),
    [page, setPage] = useState(0),
    [error, setError] = useState<unknown>(null),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [target, setTarget] = useState<Row | null>(null),
    [reason, setReason] = useState(''),
    [decision, setDecision] = useState<'approved' | 'rejected' | 'withdrawn'>('approved'),
    [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setError(null);
    void apiCollection<Row>(
      (self ? '/api/v1/profile/proposals' : '/api/v1/manage/profile-proposals') +
        '?tenantId=' +
        tenantId,
      { signal: controller.signal },
    )
      .then((r) => {
        if (!controller.signal.aborted) setItems(r.items);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      });
    return () => controller.abort();
  }, [tenantId, self, version]);
  async function review() {
    if (!target) return;
    setBusy(true);
    try {
      await write(
        me,
        '/api/v1/profile/proposals/' + target.id + '/review',
        tenantId,
        reason,
        { decision, expectedRevision: target.revision },
        key,
      );
      setTarget(null);
      setVersion((v) => v + 1);
    } catch (e) {
      if (e instanceof ApiError && [403, 404].includes(e.status)) {
        setItems([]);
        setTarget(null);
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-secondary-foreground">
          {self ? 'Đề xuất cập nhật của tôi' : 'Đề xuất hồ sơ chờ HR xử lý'}
        </h3>
        <Button variant="outline" onClick={() => setVersion((v) => v + 1)}>
          Tải lại đề xuất
        </Button>
      </div>
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {items.length ? (
        items
          .slice(
            Math.min(page, Math.max(0, Math.ceil(items.length / 6) - 1)) * 6,
            Math.min(page, Math.max(0, Math.ceil(items.length / 6) - 1)) * 6 + 6,
          )
          .map((row) => (
            <Card key={String(row.id)}>
              <CardContent className="space-y-3">
                <p className="font-medium">{String(row.displayName)}</p>
                <Badge variant="secondary">
                  {
                    (
                      {
                        pending: 'Chờ duyệt',
                        approved: 'Đã duyệt',
                        rejected: 'Từ chối',
                        withdrawn: 'Đã rút',
                      } as Record<string, string>
                    )[String(row.status)]
                  }
                </Badge>
                <p className="text-sm">{String(row.reason)}</p>
                <dl className="space-y-2 text-sm">
                  {(row.changes as { id: string; label: string; value: string }[]).map((change) => (
                    <div key={change.id}>
                      <dt className="text-muted-foreground">{change.label}</dt>
                      <dd>{change.value}</dd>
                    </div>
                  ))}
                </dl>
                {Boolean(row.reviewReason) && (
                  <p className="text-sm">Phản hồi: {String(row.reviewReason)}</p>
                )}
                {row.status === 'pending' && (
                  <div className="flex flex-wrap gap-2">
                    {!self && (
                      <ProfileWorkflow
                        me={me}
                        tenantId={tenantId}
                        id={String(row.id)}
                        name={String(row.displayName)}
                        revision={Number(row.revision)}
                        onDone={() => setVersion((v) => v + 1)}
                      />
                    )}
                    {(self
                      ? ['withdrawn']
                      : row.workflowLinked
                        ? ['rejected']
                        : ['approved', 'rejected']
                    ).map((d) => (
                      <Button
                        key={d}
                        variant={d === 'approved' ? 'default' : 'outline'}
                        disabled={busy}
                        onClick={() => {
                          setTarget(row);
                          setDecision(d as typeof decision);
                          setReason('');
                          setKey(crypto.randomUUID());
                        }}
                      >
                        {d === 'approved'
                          ? 'Duyệt cập nhật'
                          : d === 'rejected'
                            ? 'Từ chối'
                            : 'Rút đề xuất'}
                      </Button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))
      ) : (
        <p className="text-sm text-muted-foreground">Chưa có đề xuất.</p>
      )}
      <Paging page={page} total={items.length} size={6} onPage={setPage} />
      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !busy) setTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xác nhận xử lý đề xuất</DialogTitle>
            <DialogDescription>
              {String(target?.displayName ?? '')} · Hồ sơ và cấu hình sẽ được kiểm tra lại trước khi
              ghi.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="profile-review-reason">
            {self ? 'Lý do rút đề xuất' : 'Phản hồi gửi nhân viên'}
          </Label>
          <Input
            id="profile-review-reason"
            value={reason}
            maxLength={240}
            onChange={(e) => {
              setReason(e.target.value);
              setKey(crypto.randomUUID());
            }}
          />
          <DialogFooter>
            <Button disabled={busy || reason.trim().length < 5} onClick={() => void review()}>
              Xác nhận đề xuất
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function SelfProfile({ me, tenantId }: { me: Me; tenantId: string }) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-secondary-foreground">Thông tin hồ sơ bổ sung</h2>
      <MetadataRecord
        key={tenantId + me.personId}
        me={me}
        tenantId={tenantId}
        resource="people"
        id={me.personId}
        self
      />
      <ProposalQueue me={me} tenantId={tenantId} self />
    </div>
  );
}
export function MetadataWorkspace({
  me,
  tenantId,
  people,
}: {
  me: Me;
  tenantId: string;
  people: boolean;
}) {
  const [resource, setResource] = useState(people ? 'people' : 'org-units'),
    [tab, setTab] = useState('records'),
    [config, setConfig] = useState<ConfigResponse | null>(null),
    [draft, setDraft] = useState<Configuration>(initial),
    [targets, setTargets] = useState<Row[]>([]),
    [targetId, setTargetId] = useState(''),
    [reason, setReason] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const canManage = allowed(
    me,
    tenantId,
    resource === 'people' ? 'people:manage' : 'directory:manage',
  );
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setConfig(null);
    setTargets([]);
    setTargetId('');
    setReason('');
    void apiCollection<Row>('/api/v1/manage/' + resource + '?tenantId=' + tenantId, {
      signal: controller.signal,
    })
      .then((r) => {
        if (!controller.signal.aborted) setTargets(r.items);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      });
    if (canManage)
      void api<ConfigResponse>('/api/v1/directory-config/' + resource + '?tenantId=' + tenantId, {
        signal: controller.signal,
      })
        .then((r) => {
          if (!controller.signal.aborted) {
            setConfig(r);
            setDraft(r.configuration?.draft ?? initial());
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e);
        });
    return () => controller.abort();
  }, [tenantId, resource, version, canManage]);
  function change(next: Configuration) {
    setDraft(next);
    setKey(crypto.randomUUID());
    setMessage('');
  }
  async function save(publish = false) {
    setBusy(true);
    setError(null);
    try {
      if (publish)
        await write(
          me,
          '/api/v1/directory-config/' + resource + '/publish',
          tenantId,
          reason,
          { expectedRevision: config!.configuration!.revision },
          key,
        );
      else
        await write(
          me,
          '/api/v1/directory-config/' + resource,
          tenantId,
          reason,
          { configuration: draft, expectedRevision: config?.configuration?.revision ?? 0 },
          key,
        );
      setMessage(
        publish
          ? 'Đã phát hành cấu hình mới; lịch sử cũ được giữ nguyên.'
          : 'Đã lưu bản nháp. Chưa thay đổi cấu hình đang sử dụng.',
      );
      setVersion((v) => v + 1);
      setKey(crypto.randomUUID());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <h2 className="text-xl font-semibold text-secondary-foreground">
        Thông tin & cấu hình mở rộng
      </h2>
      <Choice
        label="Loại hồ sơ cấu hình"
        value={resource}
        items={resources.filter((r) => (people ? r.id === 'people' : r.id !== 'people'))}
        onChange={(v) => {
          if (v) {
            setResource(v);
            setTab('records');
            setMessage('');
          }
        }}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="records">Thông tin hồ sơ</TabsTrigger>
          {canManage && <TabsTrigger value="configuration">Thiết kế trường & bố cục</TabsTrigger>}
          {people && canManage && (
            <TabsTrigger value="proposals">Duyệt đề xuất nhân viên</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value={tab} className="space-y-5 mt-5">
          {message && (
            <Alert role="status" className="status-success">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
          {Boolean(error) && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          {tab === 'records' && (
            <>
              <Choice
                label="Chọn hồ sơ"
                value={targetId}
                items={targets.map((r) => ({
                  id: String(r.id),
                  name: String(r.displayName ?? r.name ?? r.code),
                }))}
                onChange={setTargetId}
              />
              {targetId && (
                <MetadataRecord
                  key={resource + targetId}
                  me={me}
                  tenantId={tenantId}
                  resource={resource}
                  id={targetId}
                />
              )}
            </>
          )}
          {tab === 'configuration' && canManage && config !== null && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="secondary">
                  Đang sử dụng v{config?.configuration?.currentVersion ?? 0}
                </Badge>
                <Badge variant="outline">Bản nháp r{config?.configuration?.revision ?? 0}</Badge>
                <p className="text-sm text-muted-foreground">
                  Trường mở rộng không thay tài khoản, mã định danh hoặc quyền ứng dụng.
                </p>
              </div>
              <Label htmlFor="config-reason">Lý do thay đổi cấu hình</Label>
              <Input
                id="config-reason"
                disabled={busy}
                value={reason}
                maxLength={240}
                onChange={(e) => {
                  setReason(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              />
              <ConfigurationTransferControls
                kind={('directory-' + resource) as ConfigurationKind}
                target="current"
                tenantId={tenantId}
                csrfToken={me.csrfToken}
                disabled={
                  busy ||
                  !config.configuration ||
                  JSON.stringify(draft) !== JSON.stringify(config.configuration.draft)
                }
                onImported={async () => {
                  try {
                    const current = await api<ConfigResponse>(
                      '/api/v1/directory-config/' + resource + '?tenantId=' + tenantId,
                    );
                    setConfig(current);
                    setDraft(current.configuration!.draft);
                    setReason('');
                    setKey(crypto.randomUUID());
                    setMessage('Đã nhập cấu hình vào bản nháp. Kiểm tra trước khi phát hành.');
                  } catch (e) {
                    setConfig(null);
                    setError(e);
                    throw e;
                  }
                }}
              />
              <FormDesigner
                schema={draft.schema}
                busy={busy || reason.trim().length < 5}
                onChange={(schema) => {
                  const ids = schemaFields(schema).map((f) => f.id);
                  change({
                    ...draft,
                    schema,
                    selfView: draft.selfView.filter((id) => ids.includes(id)),
                    selfEdit: draft.selfEdit.filter((id) => ids.includes(id)),
                  });
                }}
                onSave={() => void save()}
              />
              {people && (
                <Card>
                  <CardHeader>
                    <CardTitle role="heading" aria-level={3}>
                      Nhân viên tự xem / đề xuất cập nhật
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {schemaFields(draft.schema).map((f) => (
                      <div key={f.id} className="flex flex-wrap gap-3 items-center border-b py-2">
                        <span className="min-w-48 font-medium text-sm">{f.label}</span>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={draft.selfView.includes(f.id)}
                            disabled={busy}
                            onCheckedChange={(v) =>
                              change({
                                ...draft,
                                selfView: v
                                  ? [...draft.selfView, f.id]
                                  : draft.selfView.filter((id) => id !== f.id),
                                selfEdit: v
                                  ? draft.selfEdit
                                  : draft.selfEdit.filter((id) => id !== f.id),
                              })
                            }
                          />
                          Nhân viên được xem {f.label}
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={draft.selfEdit.includes(f.id)}
                            disabled={busy || !draft.selfView.includes(f.id)}
                            onCheckedChange={(v) =>
                              change({
                                ...draft,
                                selfEdit: v
                                  ? [...draft.selfEdit, f.id]
                                  : draft.selfEdit.filter((id) => id !== f.id),
                              })
                            }
                          />
                          Được đề xuất sửa {f.label}
                        </label>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
              <Button
                disabled={
                  busy ||
                  !config?.configuration ||
                  reason.trim().length < 5 ||
                  JSON.stringify(draft) !== JSON.stringify(config.configuration.draft)
                }
                onClick={() => void save(true)}
              >
                Phát hành bản nháp đã lưu
              </Button>
              <p className="text-sm text-muted-foreground">
                Các phiên bản đã phát hành:{' '}
                {config?.versions.map((v) => 'v' + v.version).join(', ') || 'Chưa có'}. Đổi loại một
                trường cần tạo ID mới; lịch sử giữ cấu hình lúc ghi.
              </p>
            </>
          )}
          {tab === 'proposals' && people && canManage && (
            <ProposalQueue me={me} tenantId={tenantId} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
import { ProfileWorkflow } from './profile-workflow';
