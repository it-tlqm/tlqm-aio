import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { UnitPicker } from '@/components/unit-picker';
import { Button } from '@/components/ui/button';
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
import { Choice } from '../forms/common';
import { maxAttachmentBytes } from '../../../src/forms/attachment-fields';
import type {
  DocumentContent,
  DocumentDraftInput,
  DocumentFile,
  DocumentFolder,
} from '../../../src/workflows/document-library-options';
import type { DefinitionItem } from './common';
import type { WorkflowVersionItem } from '../../../src/workflows/version-history';

type Unit = { id: string; name: string };
const none = 'none';
const fileData = (file: File) =>
  new Promise<{ fileName: string; content: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () =>
      resolve({ fileName: file.name, content: String(reader.result).split(',')[1]! });
    reader.readAsDataURL(file);
  });
export function documentFolderPath(folders: DocumentFolder[], id: string) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path = [];
  for (
    let folder = byId.get(id);
    folder && path.length < 8;
    folder = folder.parent_id ? byId.get(folder.parent_id) : undefined
  )
    path.unshift(folder.name);
  return path.join(' / ');
}

export function DocumentEditor({
  tenantId,
  draft,
  units,
  authorUnits,
  folders,
  definitions,
  folderId,
  close,
  save,
}: {
  tenantId: string;
  draft?: DocumentContent | undefined;
  units: Unit[];
  authorUnits: Unit[];
  folders: DocumentFolder[];
  definitions: DefinitionItem[];
  folderId: string | null;
  close: () => void;
  save: (input: DocumentDraftInput) => Promise<void>;
}) {
  const folder = folders.find((item) => item.id === folderId);
  const [unitId, setUnit] = useState(
    draft?.unitId ??
      (folder && authorUnits.some(({ id }) => id === folder.org_unit_id)
        ? folder.org_unit_id
        : (authorUnits[0]?.id ?? '')),
  );
  const [parent, setParent] = useState(
    draft ? draft.folderId : folder?.org_unit_id === unitId ? folderId : null,
  );
  const [title, setTitle] = useState(draft?.title ?? '');
  const [content, setContent] = useState(draft?.content ?? '');
  const [viewerUnits, setViewers] = useState(draft?.viewerUnits ?? (unitId ? [unitId] : []));
  const [workflow, setWorkflow] = useState(draft?.workflow?.definitionId ?? none);
  const [version, setVersion] = useState(draft?.workflow?.versionId ?? '');
  const [choices, setChoices] = useState<WorkflowVersionItem[]>([]);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [retained, setRetained] = useState<DocumentFile[]>(draft?.files ?? []);
  const [uploads, setUploads] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const selected = definitions.find((item) => item.id === workflow);
  const bytes =
    retained.reduce((total, file) => total + file.byte_count, 0) +
    uploads.reduce((total, file) => total + file.size, 0);
  const filesFit = bytes <= maxAttachmentBytes && retained.length + uploads.length <= 4;
  useEffect(() => {
    setChoices([]);
    setHistoryError(null);
    if (workflow === none) return;
    const abort = new AbortController();
    void api<{ items: WorkflowVersionItem[] }>(
      '/api/v1/workflows/definitions/' +
        workflow +
        '/versions?' +
        new URLSearchParams({ tenantId }),
      { signal: abort.signal },
    )
      .then(({ items }) => {
        if (!abort.signal.aborted) setChoices(items);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setHistoryError(failure);
      });
    return () => abort.abort();
  }, [tenantId, workflow]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !filesFit) return;
    setBusy(true);
    setError(null);
    try {
      const encoded = await Promise.all(uploads.map(fileData));
      await save({
        unitId,
        folderId: parent,
        title,
        content,
        viewerUnits,
        files: [...retained.map(({ id }) => ({ reuseId: id })), ...encoded],
        ...(workflow !== none && { workflow: { definitionId: workflow, versionId: version } }),
      });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft ? 'Soạn lại tài liệu' : 'Tạo tài liệu'}</DialogTitle>
          <DialogDescription>Lưu nội dung và tệp vào một phiên bản dự thảo.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="min-w-0 space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Choice
              label="Đơn vị quản lý tài liệu"
              value={unitId}
              disabled={!!draft || busy}
              options={authorUnits}
              onChange={(id) => {
                setUnit(id);
                setParent(null);
                setViewers([id]);
                setWorkflow(none);
                setVersion('');
              }}
            />
            <Choice
              label="Thư mục chứa tài liệu"
              value={parent ?? none}
              disabled={!!draft || busy}
              options={[
                { id: none, name: 'Thư mục gốc' },
                ...folders
                  .filter((item) => item.org_unit_id === unitId)
                  .map(({ id }) => ({ id, name: documentFolderPath(folders, id) })),
              ]}
              onChange={(id) => setParent(id === none ? null : id)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="document-title">Tên tài liệu</Label>
            <Input
              id="document-title"
              value={title}
              required
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="document-content">Nội dung tài liệu</Label>
            <Textarea
              id="document-content"
              value={content}
              rows={6}
              maxLength={20000}
              onChange={(event) => setContent(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Choice
              label="Quy trình liên kết"
              value={workflow}
              options={[
                { id: none, name: 'Không liên kết' },
                ...definitions
                  .filter((item) => item.org_unit_id === unitId && item.version)
                  .map(({ id, name }) => ({ id, name })),
              ]}
              onChange={(id) => {
                setWorkflow(id);
                setVersion(definitions.find((item) => item.id === id)?.version?.id ?? '');
              }}
            />
            {workflow !== none && (
              <Choice
                label="Phiên bản quy trình liên kết"
                value={version}
                options={choices.map((item) => ({
                  id: item.id,
                  name: 'v' + item.version + ' · ' + item.name,
                }))}
                onChange={setVersion}
              />
            )}
          </div>
          {selected?.version?.id === version && selected?.version?.spec.description && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setContent(selected.version!.spec.description)}
            >
              Dùng mô tả quy trình
            </Button>
          )}
          {historyError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(historyError)}</AlertDescription>
            </Alert>
          )}
          <fieldset className="space-y-1 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Đơn vị được xem khi ban hành</legend>
            <UnitPicker options={units} value={viewerUnits} onChange={setViewers} disabled={busy} />
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="document-files">Tệp đính kèm</Label>
            <Input
              id="document-files"
              type="file"
              multiple
              accept=".pdf,.docx,.xlsx,.txt,.png,.jpeg,.jpg"
              onChange={(event) => setUploads(Array.from(event.target.files ?? []))}
            />
            <p className="text-xs text-muted-foreground">Tối đa 4 tệp, tổng dung lượng 10 MB.</p>
            {retained.map((file) => (
              <div key={file.id} className="flex flex-wrap items-center gap-2">
                <span className="break-all text-sm">
                  {file.file_name}
                  {file.scan_status === 'quarantined' ? ' · Cách ly' : ''}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={'Bỏ tệp ' + file.file_name}
                  onClick={() => setRetained(retained.filter(({ id }) => id !== file.id))}
                >
                  Bỏ tệp
                </Button>
              </div>
            ))}
            {!filesFit && (
              <p role="alert" className="text-sm text-destructive">
                Giảm số lượng hoặc dung lượng tệp đính kèm.
              </p>
            )}
          </div>
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Hủy
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                !filesFit ||
                !title.trim() ||
                !viewerUnits.length ||
                (!content.trim() && !uploads.length && !retained.length) ||
                (workflow !== none && !version)
              }
            >
              {busy ? 'Đang lưu…' : 'Lưu dự thảo'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DocumentFolderEditor({
  folders,
  folder,
  selected,
  units,
  close,
  save,
}: {
  folders: DocumentFolder[];
  folder?: DocumentFolder | undefined;
  selected: string | null;
  units: Unit[];
  close: () => void;
  save: (input: { unitId: string; parentId: string | null; name: string }) => Promise<void>;
}) {
  const current = folders.find(({ id }) => id === selected);
  const [unitId, setUnit] = useState(
    folder?.org_unit_id ??
      (current && units.some(({ id }) => id === current.org_unit_id)
        ? current.org_unit_id
        : (units[0]?.id ?? '')),
  );
  const [parent, setParent] = useState(
    folder ? folder.parent_id : current?.org_unit_id === unitId ? selected : null,
  );
  const [name, setName] = useState(folder?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{folder ? 'Đổi tên thư mục' : 'Tạo thư mục'}</DialogTitle>
          <DialogDescription>Thư mục lưu tài liệu của đơn vị quản lý.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await save({ unitId, parentId: parent, name });
            } catch (failure) {
              setError(failure);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Choice
            label="Đơn vị quản lý thư mục"
            value={unitId}
            disabled={!!folder || busy}
            options={units}
            onChange={(id) => {
              setUnit(id);
              setParent(null);
            }}
          />
          <Choice
            label="Thư mục cha"
            value={parent ?? none}
            disabled={!!folder || busy}
            options={[
              { id: none, name: 'Thư mục gốc' },
              ...folders
                .filter((item) => item.org_unit_id === unitId && item.id !== folder?.id)
                .map(({ id }) => ({ id, name: documentFolderPath(folders, id) })),
            ]}
            onChange={(id) => setParent(id === none ? null : id)}
          />
          <div className="space-y-2">
            <Label htmlFor="document-folder-name">Tên thư mục</Label>
            <Input
              id="document-folder-name"
              value={name}
              required
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Hủy
            </Button>
            <Button type="submit" disabled={busy || !unitId || !name.trim()}>
              Lưu thư mục
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
