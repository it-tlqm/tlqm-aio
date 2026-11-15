import { useEffect, useState } from 'react';
import { BookOpen, FileText, FolderPlus, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { Textarea } from '@/components/ui/textarea';
import { can, Choice } from '../forms/common';
import type { DefinitionItem, WorkflowRun, workflowWrite } from './common';
import { DocumentEditor, DocumentFolderEditor, documentFolderPath } from './document-editor';
import type {
  DocumentAction,
  DocumentContent,
  DocumentFolder,
  DocumentItem,
} from '../../../src/workflows/document-library-options';

const base = '/api/v1/workflows/documents';
const libraryHash = () =>
  location.hash.startsWith('#workflows/documents?')
    ? new URLSearchParams(location.hash.slice(location.hash.indexOf('?') + 1))
    : new URLSearchParams();
export const documentHashTenant = () => libraryHash().get('tenantId');
const docLink = (tenantId: string, doc: string, version: number) =>
  '#workflows/documents?' +
  new URLSearchParams({ tenantId, doc, issued: 'true', version: String(version) });
const documentVersion = (query: URLSearchParams) => {
  const requested = query.get('version');
  return requested === null ? undefined : Number(requested);
};
const date = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});
const states = {
  draft: 'Dự thảo',
  pending: 'Chờ duyệt',
  approved: 'Đã duyệt',
  rejected: 'Cần chỉnh sửa',
} as const;
const labels: Record<DocumentAction | 'restore', string> = {
  submit: 'Gửi duyệt',
  reopen: 'Rút yêu cầu duyệt',
  approve: 'Phê duyệt',
  reject: 'Từ chối',
  issue: 'Ban hành',
  withdraw: 'Ngừng ban hành',
  restore: 'Khôi phục thành dự thảo',
};
const events: Record<string, string> = {
  'document.saved': 'Lưu dự thảo',
  'document.submit': 'Gửi duyệt',
  'document.reopen': 'Rút yêu cầu duyệt',
  'document.approve': 'Phê duyệt',
  'document.reject': 'Từ chối',
  'document.issue': 'Ban hành',
  'document.withdraw': 'Ngừng ban hành',
  'document.restore': 'Khôi phục dự thảo',
};
type Library = { items: DocumentItem[]; folders: DocumentFolder[]; nextAfter: string | null };
type Unit = { id: string; name: string };

function PublishedState({ doc }: { doc: DocumentItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {doc.published && (
        <Badge variant="secondary">Đang ban hành v{doc.issuedVersion ?? doc.version}</Badge>
      )}
      {!doc.published && doc.issuedVersion && <Badge variant="outline">Ngừng ban hành</Badge>}
      {doc.reviewState && (!doc.published || doc.version !== doc.issuedVersion) && (
        <Badge variant="outline">
          {states[doc.reviewState]} · v{doc.version}
        </Badge>
      )}
    </div>
  );
}

export function LinkedWorkflowDocuments({
  tenantId,
  versionId,
  refreshOn,
}: {
  tenantId: string;
  versionId: string;
  refreshOn?: WorkflowRun;
}) {
  const [items, setItems] = useState<DocumentItem[]>([]);
  useEffect(() => {
    setItems([]);
    const abort = new AbortController();
    void api<Library>(base + '?' + new URLSearchParams({ tenantId, versionId }), {
      signal: abort.signal,
    })
      .then((result) => {
        if (!abort.signal.aborted) setItems(result.items);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [tenantId, versionId, refreshOn]);
  if (!items.length) return null;
  return (
    <section aria-label="Tài liệu áp dụng" className="min-w-0 rounded-md border bg-card p-3">
      <h3 className="text-sm font-semibold">Tài liệu áp dụng</h3>
      <ul className="mt-2 flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.id} className="min-w-0">
            <Button asChild variant="outline">
              <a
                href={docLink(tenantId, item.id, item.version)}
                target="_blank"
                rel="noopener noreferrer"
                className="max-w-full whitespace-normal break-words"
              >
                <BookOpen /> {item.title}
              </a>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WorkflowDocuments({
  tenantId,
  me,
  units,
  definitions,
  write,
  start,
}: {
  tenantId: string;
  me: Me;
  units: Unit[];
  definitions: DefinitionItem[];
  write: ReturnType<typeof workflowWrite>;
  start: (definition: DefinitionItem) => void;
}) {
  const [scope, setScope] = useState(documentHashTenant);
  const [list, setList] = useState<Library | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [id, setId] = useState(() => libraryHash().get('doc'));
  const [issued, setIssued] = useState(() => libraryHash().get('issued') === 'true');
  const [selectedVersion, setSelectedVersion] = useState(() => documentVersion(libraryHash()));
  const [detail, setDetail] = useState<DocumentContent | null>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [folderEditor, setFolderEditor] = useState<'create' | DocumentFolder | null>(null);
  const [editor, setEditor] = useState<'create' | DocumentContent | null>(null);
  const [action, setAction] = useState<DocumentAction | 'restore' | null>(null);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const validScope = !scope || scope === tenantId;
  const authorUnits = units.filter(({ id: unit }) => can(me, tenantId, 'workflows:design', unit));
  const selectedFolder = list?.folders.find(({ id }) => id === folder);
  useEffect(() => {
    const update = () => {
      const query = libraryHash();
      setScope(query.get('tenantId'));
      setIssued(query.get('issued') === 'true');
      setId(query.get('doc'));
      setSelectedVersion(documentVersion(query));
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (!validScope) return;
    const abort = new AbortController();
    setError(null);
    if (!after) setList(null);
    const query = new URLSearchParams({ tenantId });
    if (folder) query.set('folderId', folder);
    if (submitted) query.set('search', submitted);
    if (after) query.set('after', after);
    void api<Library>(base + '?' + query, { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted)
          setList((previous) =>
            after && previous ? { ...data, items: [...previous.items, ...data.items] } : data,
          );
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure);
      });
    return () => abort.abort();
  }, [tenantId, validScope, folder, submitted, after, refresh]);
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (!id || !validScope) return;
    const abort = new AbortController();
    const query = new URLSearchParams({ tenantId });
    if (issued) query.set('issued', 'true');
    if (selectedVersion !== undefined) query.set('version', String(selectedVersion));
    void api<DocumentContent>(base + '/' + id + '?' + query, { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted) setDetail(data);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setDetailError(failure);
      });
    return () => abort.abort();
  }, [tenantId, validScope, id, issued, selectedVersion, refresh]);

  const current = detail && detail.version === detail.versions[0]?.version;
  const actions: (DocumentAction | 'restore')[] = [];
  if (detail && current) {
    if (detail.canDraft && detail.reviewState === 'draft') actions.push('submit');
    if (detail.canDraft && detail.reviewState === 'pending') actions.push('reopen');
    if (detail.canPublish && detail.reviewState === 'pending') actions.push('approve', 'reject');
    if (
      detail.canPublish &&
      detail.reviewState === 'approved' &&
      (!detail.published || detail.issuedVersion !== detail.version)
    )
      actions.push('issue');
    if (detail.canPublish && detail.published) actions.push('withdraw');
  }
  if (detail?.canDraft && !current && detail.reviewState !== 'pending') actions.push('restore');
  const workflow = detail?.workflow;
  const linked =
    workflow &&
    definitions.find(
      (item) =>
        item.id === workflow.definitionId &&
        item.version?.id === workflow.versionId &&
        item.startUnits.length,
    );
  function dismiss() {
    setAction(null);
    setActionError(null);
    setId(null);
    setSelectedVersion(undefined);
    if (libraryHash().has('doc')) window.history.replaceState(null, '', '#workflows/documents');
  }
  function updated() {
    setAfter(null);
    setRefresh((value) => value + 1);
  }
  async function transition(event: React.FormEvent) {
    event.preventDefault();
    if (!detail || !action || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await write(
        '/documents/' + detail.id + (action === 'restore' ? '/restore' : '/transition'),
        {
          expectedRevision: detail.revision,
          ...(action === 'restore' ? { sourceVersion: detail.version } : { action }),
        },
        reason,
      );
      setAction(null);
      setSelectedVersion(undefined);
      setNotice('Đã cập nhật tài liệu.');
      updated();
    } catch (failure) {
      setActionError(failure);
    } finally {
      setBusy(false);
    }
  }
  if (!validScope)
    return (
      <Alert>
        <AlertDescription>Liên kết thuộc không gian làm việc khác.</AlertDescription>
      </Alert>
    );
  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
            onSubmit={(event) => {
              event.preventDefault();
              setAfter(null);
              setSubmitted(search.trim());
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="workflow-document-search">Tìm tài liệu</Label>
              <Input
                id="workflow-document-search"
                value={search}
                maxLength={120}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Button type="submit" variant="outline">
              Tìm
            </Button>
            <Choice
              label="Thư mục tài liệu"
              value={folder ?? 'all'}
              options={[
                { id: 'all', name: 'Tất cả thư mục' },
                ...(list?.folders ?? []).map(({ id }) => ({
                  id,
                  name: documentFolderPath(list!.folders, id),
                })),
              ]}
              onChange={(value) => {
                setAfter(null);
                setFolder(value === 'all' ? null : value);
              }}
            />
          </form>
          {authorUnits.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setEditor('create')}>
                <Plus /> Tạo tài liệu
              </Button>
              <Button variant="outline" onClick={() => setFolderEditor('create')}>
                <FolderPlus /> Tạo thư mục
              </Button>
              {selectedFolder &&
                authorUnits.some(({ id }) => id === selectedFolder.org_unit_id) && (
                  <Button variant="ghost" onClick={() => setFolderEditor(selectedFolder)}>
                    Đổi tên thư mục
                  </Button>
                )}
            </div>
          )}
        </CardContent>
      </Card>
      {notice && (
        <p role="status" className="text-sm text-[var(--success)]">
          {notice}
        </p>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {!list && error === null && (
        <p role="status" className="text-sm text-muted-foreground">
          Đang tải tài liệu…
        </p>
      )}
      {list && !list.items.length && (
        <p className="text-sm text-muted-foreground">Không có tài liệu trong phạm vi này.</p>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {list?.items.map((item) => (
          <Card key={item.id}>
            <CardHeader>
              <FileText className="size-5 text-primary" />
              <CardTitle className="break-words">{item.title}</CardTitle>
              <PublishedState doc={item} />
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="break-words text-sm text-muted-foreground">
                {units.find(({ id }) => id === item.unitId)?.name ?? 'Đơn vị quản lý'}
                {item.folderId && ' · ' + documentFolderPath(list?.folders ?? [], item.folderId)}
                {' · ' + date.format(new Date(item.updatedAt))}
              </p>
              <Button
                variant="outline"
                aria-label={'Mở tài liệu ' + item.title}
                onClick={() => {
                  setIssued(false);
                  setSelectedVersion(undefined);
                  setId(item.id);
                }}
              >
                Mở tài liệu
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      {list?.nextAfter && (
        <Button variant="outline" onClick={() => setAfter(list.nextAfter)}>
          Xem thêm tài liệu
        </Button>
      )}

      {id && !editor && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) dismiss();
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="max-h-[90dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-3xl"
          >
            <DialogHeader>
              <DialogTitle className="break-words">
                {detail?.title ?? 'Tài liệu quy trình'}
              </DialogTitle>
              <DialogDescription>
                {detail ? 'Phiên bản v' + detail.version : 'Tra cứu nội dung và tệp đính kèm.'}
              </DialogDescription>
            </DialogHeader>
            {detailError !== null && (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage(detailError)}</AlertDescription>
              </Alert>
            )}
            {!detail && detailError === null && <p role="status">Đang tải tài liệu…</p>}
            {detail && (
              <>
                <PublishedState doc={detail} />
                {detail.versions.length > 1 && (
                  <Choice
                    label="Phiên bản tài liệu"
                    value={String(detail.version)}
                    options={detail.versions.map(({ version, createdAt }) => ({
                      id: String(version),
                      name: 'v' + version + ' · ' + date.format(new Date(createdAt)),
                    }))}
                    onChange={(value) => {
                      setAction(null);
                      setSelectedVersion(Number(value));
                    }}
                  />
                )}
                {detail.content && (
                  <p className="break-words whitespace-pre-wrap">{detail.content}</p>
                )}
                {!!detail.files.length && (
                  <ul aria-label="Tệp đính kèm tài liệu" className="space-y-2">
                    {detail.files.map((file) => (
                      <li key={file.id} className="flex min-w-0 flex-wrap items-center gap-2">
                        {file.scan_status === 'ready' ? (
                          <Button asChild variant="outline">
                            <a
                              className="max-w-full whitespace-normal break-words"
                              href={
                                base +
                                '/' +
                                detail.id +
                                '/files/' +
                                file.id +
                                '?' +
                                new URLSearchParams({
                                  tenantId,
                                  version: String(detail.version),
                                  ...(issued && { issued: 'true' }),
                                })
                              }
                            >
                              Tải {file.file_name}
                            </a>
                          </Button>
                        ) : (
                          <Badge variant="outline">{file.file_name} · Cách ly</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {linked && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      dismiss();
                      start(linked);
                    }}
                  >
                    Khởi chạy quy trình liên kết
                  </Button>
                )}
                {(detail.canDraft || detail.canPublish) && detail.history.length > 0 && (
                  <details className="rounded-md border p-3">
                    <summary className="cursor-pointer font-medium">Lịch sử tài liệu</summary>
                    <ol className="mt-2 space-y-2 text-sm">
                      {detail.history.map((row) => (
                        <li key={row.id} className="border-t pt-2">
                          <p className="font-medium">
                            {events[row.action] ?? row.action}
                            {row.details.version && ' · v' + row.details.version}
                          </p>
                          <p className="break-words text-muted-foreground">
                            {row.details.actorName ?? row.actor_account_id} ·{' '}
                            {date.format(new Date(row.occurred_at))} · {row.reason}
                          </p>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {action ? (
                  <form
                    onSubmit={(event) => void transition(event)}
                    className="space-y-3 rounded-md border p-3"
                  >
                    <h3 className="font-semibold">{labels[action]}</h3>
                    <Label htmlFor="workflow-document-reason">Lý do</Label>
                    <Textarea
                      id="workflow-document-reason"
                      value={reason}
                      maxLength={240}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    {actionError !== null && (
                      <Alert variant="destructive">
                        <AlertDescription>{errorMessage(actionError)}</AlertDescription>
                      </Alert>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setAction(null)}
                      >
                        Quay lại
                      </Button>
                      <Button type="submit" disabled={busy || reason.trim().length < 5}>
                        Xác nhận
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {current && detail.canDraft && detail.reviewState !== 'pending' && (
                      <Button variant="outline" onClick={() => setEditor(detail)}>
                        Soạn lại
                      </Button>
                    )}
                    {actions.map((command) => (
                      <Button
                        key={command}
                        variant={
                          command === 'issue' || command === 'submit' ? 'default' : 'outline'
                        }
                        onClick={() => {
                          setReason('');
                          setActionError(null);
                          setAction(command);
                        }}
                      >
                        {labels[command]}
                      </Button>
                    ))}
                  </div>
                )}
              </>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={dismiss}>
                Đóng
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {folderEditor && (
        <DocumentFolderEditor
          folders={list?.folders ?? []}
          folder={folderEditor === 'create' ? undefined : folderEditor}
          selected={folder}
          units={authorUnits}
          close={() => setFolderEditor(null)}
          save={async (input) => {
            const existing = folderEditor === 'create' ? null : folderEditor;
            const result = await write<DocumentFolder>(
              '/document-folders' + (existing ? '/' + existing.id : ''),
              {
                ...input,
                ...(existing && { expectedRevision: existing.revision }),
              },
              existing ? 'Đổi tên thư mục tài liệu' : 'Tạo thư mục tài liệu',
            );
            setFolderEditor(null);
            setFolder(result.id);
            setNotice('Đã lưu thư mục.');
            updated();
          }}
        />
      )}
      {editor && (
        <DocumentEditor
          tenantId={tenantId}
          draft={editor === 'create' ? undefined : editor}
          folderId={folder}
          folders={list?.folders ?? []}
          units={units}
          authorUnits={authorUnits}
          definitions={definitions}
          close={() => setEditor(null)}
          save={async (input) => {
            const existing = editor === 'create' ? null : editor;
            const result = await write<{ id: string }>(
              '/documents' + (existing ? '/' + existing.id : ''),
              {
                ...input,
                ...(existing && { expectedRevision: existing.revision }),
              },
              'Lưu dự thảo tài liệu quy trình',
            );
            setEditor(null);
            setIssued(false);
            setId(result.id);
            setSelectedVersion(undefined);
            setNotice('Đã lưu dự thảo tài liệu.');
            updated();
          }}
        />
      )}
    </div>
  );
}
