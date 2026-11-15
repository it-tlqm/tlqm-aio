import { useEffect, useState } from 'react';
import { Plus, ArrowLeft, Save, RefreshCw, Pencil, Archive } from 'lucide-react';
import { apiCollection, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { QuestionEditor } from './course-manager';
import { QuestionImport, QuestionExport } from './question-tools';
import { useCourseCommands } from './course-api';
import type { BankItem, QuestionEntry, QuestionKind } from '../../../src/lms/question-contracts';
export function QuestionBankPanel({
  csrfToken,
  onAccessError,
  onDirtyChange,
}: {
  csrfToken: string;
  onAccessError: (error: unknown) => void;
  onDirtyChange: (value: boolean) => void;
}) {
  const [items, setItems] = useState<BankItem[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [kind, setKind] = useState<QuestionKind>('quiz'),
    [status, setStatus] = useState('active'),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(0),
    [generation, setGeneration] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<BankItem | null>(null),
    [draft, setDraft] = useState<QuestionEntry | null>(null),
    [category, setCategory] = useState('Tổng hợp'),
    [importCategory, setImportCategory] = useState('Tổng hợp'),
    [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false),
    [archive, setArchive] = useState<BankItem | null>(null);
  const command = useCourseCommands(csrfToken, '/api/lms/question-commands');
  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'LMS_INVALID_COURSE')
      error = new ApiError(error.status, 'LMS_INVALID_QUESTION', error.issues);
    setError(error);
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      setItems([]);
      setDraft(null);
      onAccessError(error);
    }
  };
  useEffect(() => {
    onDirtyChange(Boolean(draft && dirty));
    return () => onDirtyChange(false);
  }, [draft, dirty, onDirtyChange]);
  useEffect(() => {
    if (!draft || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, dirty]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    setItems([]);
    setSelected([]);
    setPage(0);
    void apiCollection<BankItem>(
      '/api/lms/question-bank?kind=' +
        kind +
        '&status=' +
        status +
        '&search=' +
        encodeURIComponent(query),
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setItems(result.items);
      })
      .catch((error) => {
        if (!controller.signal.aborted) fail(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [kind, status, query, generation]);
  const refresh = async () => {
    setGeneration((value) => value + 1);
    setNotice('Đã cập nhật ngân hàng câu hỏi.');
  };
  function edit(item: BankItem | null) {
    setEditing(item);
    setCategory(item?.category ?? importCategory);
    setDraft(
      item
        ? structuredClone(item.entry)
        : {
            kind,
            question: {
              id: 'q-' + crypto.randomUUID(),
              type: 'single',
              question: '',
              options: ['Lựa chọn 1', 'Lựa chọn 2'],
              ...(kind === 'checkpoint' ? { time: 0, title: '' } : {}),
            },
            key: { answer: 0, explanation: '' },
          },
    );
    setDirty(!item);
    setError(null);
    setNotice('');
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await command('save-question', {
        ...(editing ? { id: editing.id } : {}),
        expectedRevision: editing?.revision ?? 0,
        category,
        entry: draft,
        status: editing?.status ?? 'active',
      });
      setDraft(null);
      setDirty(false);
      await refresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function changeStatus() {
    if (!archive) return;
    setBusy(true);
    setError(null);
    try {
      await command('save-question', {
        id: archive.id,
        expectedRevision: archive.revision,
        category: archive.category,
        entry: archive.entry,
        status: archive.status === 'active' ? 'archived' : 'active',
      });
      setArchive(null);
      await refresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="rounded-lg bg-secondary p-3 text-sm text-primary">
          {notice}
        </p>
      )}
      {draft ? (
        <>
          <div className="flex flex-wrap justify-between gap-3">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => (dirty ? setDiscard(true) : setDraft(null))}
            >
              <ArrowLeft />
              Về ngân hàng câu hỏi
            </Button>
            <Button disabled={busy || !dirty} onClick={() => void save()}>
              <Save />
              Lưu câu hỏi
            </Button>
          </div>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                {editing ? 'Chỉnh sửa câu hỏi' : 'Tạo câu hỏi dùng lại'}
              </CardTitle>
              <CardDescription>
                Thay đổi tạo phiên bản ngân hàng mới. Khóa học đã sao chép câu hỏi giữ nguyên nội
                dung của mình.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Label htmlFor="bank-category">Nhóm câu hỏi</Label>
              <Input
                id="bank-category"
                maxLength={100}
                className="mt-2"
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value);
                  setDirty(true);
                }}
              />
            </CardContent>
          </Card>
          <QuestionEditor
            question={draft.question}
            answer={draft.key}
            checkpoint={draft.kind === 'checkpoint'}
            onChange={(question, key) => {
              setDraft({ ...draft, question, key });
              setDirty(true);
            }}
          />
        </>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <CardTitle role="heading" aria-level={2}>
                    Ngân hàng câu hỏi
                  </CardTitle>
                  <CardDescription className="mt-2">
                    Soạn, phân nhóm và tái sử dụng câu hỏi. Đáp án chỉ hiển thị cho người có quyền
                    biên soạn.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
                    <RefreshCw />
                    Tải lại ngân hàng
                  </Button>
                  <Button disabled={busy} onClick={() => edit(null)}>
                    <Plus />
                    Tạo câu hỏi
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <form
                className="grid gap-4 sm:grid-cols-[1fr_180px_180px_auto]"
                onSubmit={(event) => {
                  event.preventDefault();
                  setQuery(search.trim());
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="bank-search">Tìm câu hỏi hoặc nhóm</Label>
                  <Input
                    id="bank-search"
                    maxLength={200}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bank-kind">Phần học tập</Label>
                  <Select value={kind} onValueChange={(value) => setKind(value as QuestionKind)}>
                    <SelectTrigger id="bank-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quiz">Bài kiểm tra</SelectItem>
                      <SelectItem value="checkpoint">Điểm dừng video</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bank-status">Trạng thái câu hỏi</Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger id="bank-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Đang sử dụng</SelectItem>
                      <SelectItem value="archived">Ngừng sử dụng</SelectItem>
                      <SelectItem value="all">Tất cả</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button variant="outline" type="submit" className="self-end" disabled={busy}>
                  Tìm kiếm
                </Button>
              </form>
              <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-secondary/40 p-4">
                <div className="min-w-40 flex-1 space-y-2">
                  <Label htmlFor="bank-import-category">Nhóm cho câu hỏi nhập</Label>
                  <Input
                    id="bank-import-category"
                    maxLength={100}
                    value={importCategory}
                    onChange={(event) => setImportCategory(event.target.value)}
                  />
                </div>
                <QuestionImport
                  key={kind}
                  kind={kind}
                  csrfToken={csrfToken}
                  target={{ destination: 'bank', category: importCategory }}
                  disabled={busy || !importCategory.trim()}
                  onApplied={refresh}
                  onAccessError={onAccessError}
                />
                <QuestionExport kind={kind} csrfToken={csrfToken} onAccessError={onAccessError} />
                <QuestionExport
                  kind={kind}
                  source={{
                    source: 'bank',
                    items: items
                      .filter((item) => selected.includes(item.id))
                      .map((item) => ({ id: item.id, revision: item.revision })),
                  }}
                  csrfToken={csrfToken}
                  disabled={busy || !selected.length}
                  onAccessError={onAccessError}
                />
              </div>
              {busy && <p role="status">Đang tải ngân hàng…</p>}
              {!busy && !items.length ? (
                <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  Chưa có câu hỏi phù hợp. Tạo mới hoặc tải mẫu để nhập từ Excel.
                </p>
              ) : (
                <Table
                  containerProps={{
                    tabIndex: 0,
                    role: 'region',
                    'aria-label': 'Danh sách ngân hàng câu hỏi',
                  }}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>Chọn</TableHead>
                      <TableHead>Câu hỏi</TableHead>
                      <TableHead>Nhóm</TableHead>
                      <TableHead>Loại</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead>Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.slice(page * 20, page * 20 + 20).map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <Checkbox
                            checked={selected.includes(item.id)}
                            disabled={!selected.includes(item.id) && selected.length >= 100}
                            aria-label={'Chọn câu hỏi ' + item.entry.question.question}
                            onCheckedChange={(checked) =>
                              setSelected((value) =>
                                checked === true
                                  ? [...value, item.id]
                                  : value.filter((id) => id !== item.id),
                              )
                            }
                          />
                        </TableCell>
                        <TableCell className="max-w-md min-w-52 whitespace-normal">
                          <p className="font-medium">{item.entry.question.question}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Phiên bản {item.revision}
                          </p>
                        </TableCell>
                        <TableCell className="max-w-40 whitespace-normal">
                          {item.category}
                        </TableCell>
                        <TableCell>{item.entry.question.type}</TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={
                              item.status === 'active' ? 'status-success' : 'status-warning'
                            }
                          >
                            {item.status === 'active' ? 'Đang dùng' : 'Đã ngừng'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button variant="outline" disabled={busy} onClick={() => edit(item)}>
                              <Pencil />
                              Sửa câu hỏi
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setArchive(item)}
                            >
                              <Archive />
                              {item.status === 'active' ? 'Ngừng dùng' : 'Khôi phục'}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <p>
                  {items.length} câu hỏi · Đã chọn {selected.length}/100
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    disabled={page === 0 || busy}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Trang trước
                  </Button>
                  <span>
                    {page + 1}/{Math.max(1, Math.ceil(items.length / 20))}
                  </span>
                  <Button
                    variant="outline"
                    disabled={(page + 1) * 20 >= items.length || busy}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Trang sau
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bỏ câu hỏi chưa lưu?</DialogTitle>
            <DialogDescription>
              Nội dung đang chỉnh sửa chưa được lưu vào ngân hàng.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscard(false)}>
              Tiếp tục chỉnh sửa
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDiscard(false);
                setDraft(null);
                setDirty(false);
              }}
            >
              Bỏ thay đổi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!archive}
        onOpenChange={(open) => {
          if (!open && !busy) setArchive(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {archive?.status === 'active' ? 'Ngừng sử dụng câu hỏi?' : 'Khôi phục câu hỏi?'}
            </DialogTitle>
            <DialogDescription>
              Câu hỏi trong các khóa đã sao chép và phiên bản đã phát hành vẫn được giữ nguyên.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setArchive(null)}>
              Hủy
            </Button>
            <Button disabled={busy} onClick={() => void changeStatus()}>
              Xác nhận trạng thái
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
