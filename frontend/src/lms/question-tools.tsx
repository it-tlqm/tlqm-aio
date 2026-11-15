import { useEffect, useId, useRef, useState } from 'react';
import { Download, Upload, Library } from 'lucide-react';
import { api, apiCollection, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import { useCourseCommands } from './course-api';
import { answerText } from './answer-fields';
import type { QuestionKind, QuestionPreview, BankItem } from '../../../src/lms/question-contracts';
export type { QuestionKind, QuestionPreview, BankItem } from '../../../src/lms/question-contracts';
type AccessError = (error: unknown) => void;
const failAccess = (error: unknown, onAccessError: AccessError) => {
  if (error instanceof ApiError && [401, 403].includes(error.status)) onAccessError(error);
};
async function download(path: string, filename: string, options: RequestInit = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(response.status, error.error ?? 'REQUEST_FAILED');
  }
  const blob = await response.blob(),
    url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function QuestionExport({
  kind,
  source,
  csrfToken,
  disabled = false,
  onAccessError,
}: {
  kind: QuestionKind;
  source?:
    | { source: 'course'; courseId: string }
    | { source: 'bank'; items: { id: string; revision: number }[] };
  csrfToken: string;
  disabled?: boolean;
  onAccessError: AccessError;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    retry = useRef<{ body: string; key: string } | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (!source)
        await download('/api/lms/question-template?kind=' + kind, 'TLQM-mau-' + kind + '.xlsx');
      else {
        const body = JSON.stringify({
          action: 'export-questions',
          data: { ...source, kind },
          reason: 'Xuất câu hỏi đào tạo ra Excel',
        });
        if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
        await download('/api/lms/question-export', 'TLQM-' + kind + '.xlsx', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
            'idempotency-key': retry.current.key,
          },
          body,
        });
        retry.current = null;
      }
    } catch (error) {
      setError(error);
      failAccess(error, onAccessError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <Button variant="outline" disabled={disabled || busy} onClick={() => void run()}>
        <Download aria-hidden="true" />
        {source ? 'Xuất Excel' : 'Tải mẫu Excel'}
      </Button>
      {Boolean(error) && (
        <p role="alert" className="mt-2 max-w-sm text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}
    </div>
  );
}
type Destination =
  | { destination: 'bank'; category: string }
  | { destination: 'course'; courseId: string; expectedRevision: number };
export function QuestionImport({
  kind,
  target,
  csrfToken,
  disabled = false,
  onApplied,
  onAccessError,
}: {
  kind: QuestionKind;
  target: Destination;
  csrfToken: string;
  disabled?: boolean;
  onApplied: () => Promise<void>;
  onAccessError: AccessError;
}) {
  const id = useId(),
    [open, setOpen] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<QuestionPreview | null>(null),
    [mode, setMode] = useState<'append' | 'replace'>('append'),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    key = useRef(crypto.randomUUID());
  const command = useCourseCommands(csrfToken, '/api/lms/question-commands');
  async function inspect() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      if (file.size > 2 * 1024 * 1024) throw new ApiError(413, 'LMS_WORKBOOK_TOO_LARGE');
      setPreview(
        await api<QuestionPreview>('/api/lms/question-imports/preview?kind=' + kind, {
          method: 'POST',
          headers: {
            'content-type': file.type || 'application/octet-stream',
            'x-file-name': encodeURIComponent(file.name),
            'x-csrf-token': csrfToken,
            'idempotency-key': key.current,
          },
          body: file,
        }),
      );
    } catch (error) {
      setError(error);
      failAccess(error, onAccessError);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await command('apply-import', { ...target, previewId: preview.id, mode });
      setOpen(false);
      await onApplied();
    } catch (error) {
      setError(error);
      failAccess(error, onAccessError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) {
          setFile(null);
          setPreview(null);
          setMode('append');
          setConfirmed(false);
          setError(null);
          key.current = crypto.randomUUID();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" disabled={disabled}>
          <Upload aria-hidden="true" />
          Nhập Excel
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Nhập câu hỏi từ Excel</DialogTitle>
          <DialogDescription>
            Đọc XLSX, XLS hoặc CSV UTF-8. Tối đa 100 câu hỏi và 2 MiB mỗi tệp. Chỉ nhập khi tất cả
            các dòng hợp lệ.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label htmlFor={id}>Tệp câu hỏi</Label>
          <Input
            id={id}
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setError(null);
              key.current = crypto.randomUUID();
            }}
          />
          <Button variant="outline" disabled={!file || busy} onClick={() => void inspect()}>
            Kiểm tra tệp
          </Button>
        </div>
        {busy && <p role="status">Đang xử lý câu hỏi…</p>}
        {Boolean(error) && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        )}
        {preview && (
          <div className="space-y-4">
            <p className="text-sm font-medium">
              {preview.items.length} câu hỏi hợp lệ · {preview.errors.length} lỗi
            </p>
            {preview.errors.length > 0 && (
              <Alert variant="destructive">
                <AlertDescription>
                  <p>Hãy sửa tệp và kiểm tra lại trước khi nhập.</p>
                  <ul className="max-h-52 list-disc space-y-1 overflow-auto pl-5">
                    {preview.errors.map((error, index) => (
                      <li key={index}>
                        Dòng {error.row} · {error.column}: {error.message}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            {preview.items.length > 0 && (
              <div className="max-h-72 overflow-y-auto rounded-lg border">
                <Table
                  containerProps={{
                    tabIndex: 0,
                    role: 'region',
                    'aria-label': 'Xem trước câu hỏi nhập',
                  }}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dòng</TableHead>
                      <TableHead>Loại</TableHead>
                      <TableHead>Câu hỏi</TableHead>
                      <TableHead>Đáp án</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.items.map((item) => (
                      <TableRow key={item.row}>
                        <TableCell>{item.row}</TableCell>
                        <TableCell>{item.entry.question.type}</TableCell>
                        <TableCell className="min-w-48 whitespace-normal">
                          {item.entry.question.question}
                        </TableCell>
                        <TableCell className="min-w-36 whitespace-normal">
                          {answerText(item.entry.question, item.entry.key.answer)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Bản xem trước có hiệu lực 30 phút. Đáp án chỉ dành cho người biên soạn.
            </p>
          </div>
        )}
        {target.destination === 'course' && (
          <div className="space-y-3">
            <Label htmlFor={id + '-mode'}>Cách nhập vào bản nháp</Label>
            <Select
              value={mode}
              onValueChange={(value) => {
                setMode(value as typeof mode);
                setConfirmed(false);
              }}
            >
              <SelectTrigger id={id + '-mode'}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="append">Thêm vào câu hỏi hiện có</SelectItem>
                <SelectItem value="replace">Thay thế phần câu hỏi này</SelectItem>
              </SelectContent>
            </Select>
            {mode === 'replace' && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(value) => setConfirmed(value === true)}
                  aria-label="Đồng ý thay thế câu hỏi trong bản nháp"
                />
                <span className="pt-3">
                  Tôi đồng ý thay thế phần {kind === 'quiz' ? 'bài kiểm tra' : 'điểm dừng'} trong
                  bản nháp. Bản đã phát hành giữ nguyên.
                </span>
              </label>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Hủy
          </Button>
          <Button
            disabled={
              busy ||
              !preview ||
              !!preview.errors.length ||
              !preview.items.length ||
              (mode === 'replace' && !confirmed)
            }
            onClick={() => void apply()}
          >
            Nhập câu hỏi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function BankPicker({
  kind,
  courseId,
  expectedRevision,
  csrfToken,
  disabled,
  onApplied,
  onAccessError,
}: {
  kind: QuestionKind;
  courseId: string;
  expectedRevision: number;
  csrfToken: string;
  disabled: boolean;
  onApplied: () => Promise<void>;
  onAccessError: AccessError;
}) {
  const [open, setOpen] = useState(false),
    [items, setItems] = useState<BankItem[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const command = useCourseCommands(csrfToken, '/api/lms/question-commands'),
    id = useId();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    setItems([]);
    setSelected([]);
    void apiCollection<BankItem>(
      '/api/lms/question-bank?kind=' + kind + '&search=' + encodeURIComponent(query),
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setItems(result.items);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error);
          failAccess(error, onAccessError);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, query, kind]);
  async function attach() {
    setBusy(true);
    setError(null);
    try {
      await command('attach-questions', {
        courseId,
        expectedRevision,
        kind,
        mode: 'append',
        items: items
          .filter((item) => selected.includes(item.id))
          .map((item) => ({ id: item.id, revision: item.revision })),
      });
      setOpen(false);
      await onApplied();
    } catch (error) {
      setError(error);
      failAccess(error, onAccessError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" disabled={disabled}>
          <Library aria-hidden="true" />
          Chọn từ ngân hàng
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Chọn câu hỏi dùng lại</DialogTitle>
          <DialogDescription>
            Chỉ sao chép vào bản nháp. Sửa câu hỏi trong ngân hàng sau này không thay nội dung đã
            sao chép hoặc phát hành.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search);
          }}
        >
          <div className="flex-1 space-y-2">
            <Label htmlFor={id}>Tìm trong ngân hàng</Label>
            <Input
              id={id}
              maxLength={200}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Button variant="outline" disabled={busy}>
            Tìm kiếm
          </Button>
        </form>
        {Boolean(error) && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        )}
        {busy && <p role="status">Đang tải câu hỏi…</p>}
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {items.map((item) => (
            <label key={item.id} className="flex items-start gap-2 rounded-lg border p-3">
              <Checkbox
                checked={selected.includes(item.id)}
                disabled={!selected.includes(item.id) && selected.length >= 100}
                onCheckedChange={(checked) =>
                  setSelected((value) =>
                    checked === true ? [...value, item.id] : value.filter((id) => id !== item.id),
                  )
                }
                aria-label={'Chọn câu hỏi ' + item.entry.question.question}
              />
              <span className="min-w-0 pt-2">
                <span className="block break-words text-sm font-medium">
                  {item.entry.question.question}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {item.category} · {item.entry.question.type}
                </span>
              </span>
            </label>
          ))}
          {!busy && !items.length && (
            <p className="p-4 text-sm text-muted-foreground">
              Chưa có câu hỏi phù hợp. Thêm câu hỏi tại tab Ngân hàng câu hỏi.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Hủy
          </Button>
          <Button disabled={busy || !selected.length} onClick={() => void attach()}>
            Thêm {selected.length} câu vào bản nháp
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
