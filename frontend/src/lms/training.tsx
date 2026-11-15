import { useEffect, useState } from 'react';
import { api, apiCollection, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { UnitPicker } from '@/components/unit-picker';
import { Choice } from '../forms/common';
import { useCourseCommands } from './course-api';
import type { ManagedCourse } from './course-api';
import type { Training } from '../../../src/lms/training';
import type { TrainingPathSpec } from '../../../src/lms/training-contracts';
import { normalized } from './common';
import { TrainingReminderSettings } from './training-reminder-settings';
import { TrainingWorkPanel } from './training-work';
import { ConfigurationTransferControls } from '@/components/configuration-transfer';
type Path = Awaited<ReturnType<Training['paths']>>['items'][number];
type Batch = Awaited<ReturnType<Training['batch']>>;
type Person = Awaited<ReturnType<Training['candidates']>>['items'][number];
type Intake = Awaited<ReturnType<Training['intakeDrafts']>>['items'][number];
const date = (n: number) => new Date(n + 420 * 60000).toISOString().slice(0, 10);
const fromDate = (s: string, end = false) =>
  Date.parse(s + (end ? 'T23:59:59.999+07:00' : 'T00:00:00+07:00'));
const pathOptionLimit = 30;
const pathLabel = (path: Path) => (path.published?.title ?? path.title) + ' · v' + path.version;
const blank = (): TrainingPathSpec => ({
  schemaVersion: 1,
  title: '',
  description: '',
  courseVersionIds: [],
  audienceUnits: [],
});
export function TrainingPanel({
  csrfToken,
  manage,
  canAdmin,
  onAccessError,
  onOpenCourse,
  onDirtyChange,
  initialBatchId,
  onCloseBatch,
}: {
  csrfToken: string;
  manage: boolean;
  canAdmin: boolean;
  onAccessError: (e: unknown) => void;
  onOpenCourse: (id: string) => void;
  onDirtyChange: (v: boolean) => void;
  initialBatchId?: string | null;
  onCloseBatch?: () => void;
}) {
  const [batches, setBatches] = useState<Batch[]>([]),
    [paths, setPaths] = useState<Path[]>([]),
    [courses, setCourses] = useState<ManagedCourse[]>([]),
    [people, setPeople] = useState<Person[]>([]),
    [refs, setRefs] = useState<{ ownUnitId: string; units: { id: string; name: string }[] }>({
      ownUnitId: '',
      units: [],
    });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState(''),
    [search, setSearch] = useState(''),
    [mode, setMode] = useState<'batches' | 'paths' | 'work'>('batches'),
    [detail, setDetail] = useState<Batch | null>(null);
  const [editing, setEditing] = useState<Path | null>(null),
    [spec, setSpec] = useState<TrainingPathSpec | null>(null),
    [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false);
  const [creating, setCreating] = useState(false),
    [pathVersion, setPathVersion] = useState(''),
    [pathSearch, setPathSearch] = useState(''),
    [title, setTitle] = useState(''),
    [owner, setOwner] = useState(''),
    [start, setStart] = useState(date(Date.now())),
    [due, setDue] = useState(date(Date.now() + 30 * 86400000)),
    [selected, setSelected] = useState<string[]>([]),
    [personSearch, setPersonSearch] = useState('');
  const [intakes, setIntakes] = useState<Intake[] | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [changing, setChanging] = useState<Batch | null>(null),
    [cancelling, setCancelling] = useState<Batch | null>(null);
  const [memberSearch, setMemberSearch] = useState(''),
    [memberPage, setMemberPage] = useState(1);
  useEffect(() => {
    setMemberSearch('');
    setMemberPage(1);
  }, [detail?.id]);
  const command = useCourseCommands(csrfToken, '/api/lms/training-commands');
  const [reminderDirty, setReminderDirty] = useState(false);
  useEffect(() => {
    onDirtyChange(dirty || creating || !!changing || reminderDirty);
    return () => onDirtyChange(false);
  }, [dirty, creating, changing, reminderDirty, onDirtyChange]);
  const fail = (e: unknown) => {
    setError(e);
    if (e instanceof ApiError && e.code === 'LMS_TRAINING_INTAKE_SOURCE_DENIED') {
      setIntake(null);
      setCreating(false);
      setIntakes(null);
    }
    if (
      e instanceof ApiError &&
      [401, 403].includes(e.status) &&
      e.code !== 'LMS_TRAINING_INTAKE_SOURCE_DENIED'
    ) {
      setBatches([]);
      setPaths([]);
      setPeople([]);
      setDetail(null);
      setIntakes(null);
      setIntake(null);
      onAccessError(e);
    }
  };
  async function load() {
    setBusy(true);
    setError(null);
    setBatches([]);
    try {
      const data = await apiCollection<Batch>('/api/lms/training-batches?manage=' + String(manage));
      setBatches(data.items);
      const selectedBatch = (!manage && initialBatchId) || detail?.id;
      if (selectedBatch)
        setDetail(
          await api<Batch>(
            '/api/lms/training-batch?id=' + selectedBatch + '&manage=' + String(manage),
          ),
        );
      if (manage && canAdmin) {
        const [p, c, m, u] = await Promise.all([
          apiCollection<Path>('/api/lms/training-paths'),
          apiCollection<ManagedCourse>('/api/lms/manage/courses'),
          api<{ items: Person[] }>('/api/lms/training-candidates'),
          api<typeof refs>('/api/lms/lookups'),
        ]);
        setPaths(p.items);
        setCourses(c.items);
        setPeople(m.items);
        setRefs(u);
        setOwner(u.ownUnitId);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [manage, canAdmin]);
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function openCreate(source: Intake | null) {
    setIntake(source);
    setCreating(true);
    setSelected([]);
    setTitle(source?.title ?? '');
    setOwner(source?.unitId ?? refs.ownUnitId);
    setStart(date(Date.now()));
    setDue(date(Date.now() + 30 * 86400000));
    setPersonSearch('');
    setPathSearch('');
    setError(null);
    setPathVersion(paths.find((p) => p.versionId)?.versionId ?? '');
  }
  const patch = (value: TrainingPathSpec) => {
    setSpec(value);
    setDirty(true);
  };
  const choiceTitle = (id: string) => {
    const c = courses.find((c) => c.versionId === id);
    return c
      ? `${c.publishedTitle ?? c.spec.title} · phiên bản ${c.version}`
      : 'Khóa đã chọn (phiên bản cũ)';
  };
  const chosenPath = paths.find((p) => p.versionId === pathVersion),
    participants = people.filter((p) => chosenPath?.published?.audienceUnits.includes(p.unitId));
  const pathQuery = normalized(pathSearch.trim());
  const matchingPaths = paths.filter(
    (path) => path.versionId && normalized(pathLabel(path)).includes(pathQuery),
  );
  const visiblePaths = matchingPaths.slice(0, pathOptionLimit);
  if (chosenPath && !visiblePaths.some((path) => path.versionId === chosenPath.versionId))
    visiblePaths.unshift(chosenPath);
  const filteredMembers = (detail?.members ?? []).filter((member) =>
      normalized(member.name + ' ' + member.unitName).includes(normalized(memberSearch)),
    ),
    memberPages = Math.max(1, Math.ceil(filteredMembers.length / 10)),
    currentMemberPage = Math.min(memberPage, memberPages),
    visibleMembers = filteredMembers.slice((currentMemberPage - 1) * 10, currentMemberPage * 10);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-[var(--brand-navy)]">
            {manage ? 'Lộ trình và đợt đào tạo' : 'Đợt đào tạo của tôi'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Theo dõi các khóa đã giao, phiên bản học và hạn hoàn thành của từng đợt.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {manage && canAdmin && (
            <TrainingReminderSettings csrfToken={csrfToken} onDirtyChange={setReminderDirty} />
          )}
          {!manage && !detail && (
            <Button variant="outline" onClick={() => setMode(mode === 'work' ? 'batches' : 'work')}>
              {mode === 'work' ? 'Danh sách đợt' : 'Việc học & nhắc hạn'}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy || dirty || creating || !!changing}
            onClick={() => void load()}
          >
            Tải lại đợt đào tạo
          </Button>
          {manage && canAdmin && !spec && !detail && (
            <>
              <Button
                variant="outline"
                onClick={() => setMode(mode === 'paths' ? 'batches' : 'paths')}
              >
                {mode === 'paths' ? 'Danh sách đợt' : 'Quản lý lộ trình'}
              </Button>
              <Button onClick={() => openCreate(null)}>Tạo đợt đào tạo</Button>
            </>
          )}
        </div>
      </div>
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="rounded-lg bg-secondary p-3 text-sm">
          {notice}
        </p>
      )}
      {busy && <p role="status">Đang tải dữ liệu đào tạo…</p>}
      {manage && canAdmin && mode === 'batches' && !detail && !spec && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>Đề nghị đào tạo từ Quy trình</h3>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  setIntakes((await api<{ items: Intake[] }>('/api/lms/training-intakes')).items);
                })
              }
            >
              Tải đề nghị đào tạo
            </Button>
            {intakes?.length === 0 && (
              <p className="text-sm text-muted-foreground">Chưa có đề nghị cần xác nhận.</p>
            )}
            {Boolean(intakes?.length) && (
              <ul className="space-y-2">
                {intakes?.map((item) => (
                  <li
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                    key={item.id}
                  >
                    <p className="min-w-0 break-words font-medium">{item.title}</p>
                    <Button
                      variant="outline"
                      disabled={busy}
                      aria-label={'Mở đề nghị ' + item.title}
                      onClick={() => openCreate(item)}
                    >
                      Mở đề nghị
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
      {spec ? (
        <>
          <div className="flex flex-wrap justify-between gap-3">
            <Button variant="ghost" onClick={() => (dirty ? setDiscard(true) : setSpec(null))}>
              Về danh sách lộ trình
            </Button>
            <div className="flex flex-wrap gap-2">
              {editing && (
                <ConfigurationTransferControls
                  kind="lms-path"
                  target={editing.id}
                  csrfToken={csrfToken}
                  disabled={busy || dirty}
                  onImported={async () => {
                    const data = await apiCollection<Path>('/api/lms/training-paths'),
                      current = data.items.find((p) => p.id === editing.id);
                    if (!current) throw new ApiError(404, 'LMS_TRAINING_NOT_FOUND');
                    setPaths(data.items);
                    setEditing(current);
                    setSpec(structuredClone(current.spec));
                    setDirty(false);
                    setNotice('Đã nhập cấu hình lộ trình vào bản nháp.');
                  }}
                />
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const result = await command<{ id: string; revision: number }>('save-path', {
                      ...(editing ? { id: editing.id } : {}),
                      expectedRevision: editing?.revision ?? 0,
                      spec,
                    });
                    setEditing({
                      ...editing!,
                      ...result,
                      title: spec.title,
                      spec,
                      version: editing?.version ?? 0,
                      versionId: editing?.versionId ?? null,
                      published: editing?.published ?? null,
                    });
                    setDirty(false);
                    setNotice('Đã lưu bản nháp lộ trình.');
                  })
                }
              >
                Lưu lộ trình
              </Button>
              <Button
                disabled={busy || dirty || !editing}
                onClick={() =>
                  void perform(async () => {
                    const r = await command<{
                      id: string;
                      revision: number;
                      versionId: string;
                      version: number;
                    }>('publish-path', { id: editing!.id, expectedRevision: editing!.revision });
                    setEditing({ ...editing!, ...r, published: spec });
                    setNotice('Đã phát hành lộ trình phiên bản ' + r.version + '.');
                    await load();
                  })
                }
              >
                Phát hành lộ trình
              </Button>
            </div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Thiết kế lộ trình đào tạo</CardTitle>
              <CardDescription>
                Mỗi đợt giữ phiên bản lộ trình và khóa học đã giao. Thứ tự bên dưới hướng dẫn học;
                điều kiện tiên quyết được thiết lập riêng trong từng khóa.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="path-title">Tên lộ trình</Label>
                <Input
                  id="path-title"
                  value={spec.title}
                  onChange={(e) => patch({ ...spec, title: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="path-description">Hướng dẫn lộ trình</Label>
                <Textarea
                  id="path-description"
                  value={spec.description}
                  onChange={(e) => patch({ ...spec, description: e.target.value })}
                />
              </div>
              <fieldset className="space-y-2">
                <legend className="mb-2 font-medium">Đối tượng đơn vị</legend>
                <UnitPicker
                  options={refs.units}
                  value={spec.audienceUnits}
                  onChange={(audienceUnits) => patch({ ...spec, audienceUnits })}
                />
              </fieldset>
              <Choice
                label="Thêm khóa vào lộ trình"
                value="_none"
                onChange={(id) =>
                  id !== '_none' &&
                  patch({ ...spec, courseVersionIds: [...spec.courseVersionIds, id] })
                }
                options={[
                  { id: '_none', name: 'Chọn khóa đang phát hành' },
                  ...courses
                    .filter(
                      (c) =>
                        c.status === 'active' &&
                        c.versionId &&
                        !spec.courseVersionIds.includes(c.versionId),
                    )
                    .map((c) => ({ id: c.versionId!, name: choiceTitle(c.versionId!) })),
                ]}
              />
              <ol className="space-y-3">
                {spec.courseVersionIds.map((id, index) => (
                  <li
                    key={id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <span className="min-w-0 break-words text-sm">
                      {index + 1}. {choiceTitle(id)}
                    </span>
                    <div className="flex gap-1">
                      {([-1, 1] as const).map((delta) => (
                        <Button
                          key={delta}
                          variant="outline"
                          size="icon"
                          aria-label={`${delta < 0 ? 'Đưa lên' : 'Đưa xuống'} khóa ${index + 1}`}
                          disabled={
                            index + delta < 0 || index + delta >= spec.courseVersionIds.length
                          }
                          onClick={() => {
                            const next = [...spec.courseVersionIds];
                            [next[index], next[index + delta]] = [
                              next[index + delta]!,
                              next[index]!,
                            ];
                            patch({ ...spec, courseVersionIds: next });
                          }}
                        >
                          {delta < 0 ? '↑' : '↓'}
                        </Button>
                      ))}
                      <Button
                        variant="outline"
                        aria-label={`Bỏ khóa ${index + 1}`}
                        onClick={() =>
                          patch({
                            ...spec,
                            courseVersionIds: spec.courseVersionIds.filter((v) => v !== id),
                          })
                        }
                      >
                        Bỏ
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
              {!spec.courseVersionIds.length && (
                <p className="text-sm text-muted-foreground">Thêm khóa học để xây dựng lộ trình.</p>
              )}
            </CardContent>
          </Card>
        </>
      ) : detail ? (
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setDetail(null);
              onCloseBatch?.();
            }}
          >
            Về danh sách đợt
          </Button>
          <Card>
            <CardHeader>
              <CardTitle>{detail.title}</CardTitle>
              <CardDescription>
                {detail.pathTitle} · phiên bản {detail.pathVersion} · {date(detail.startsAt)} đến{' '}
                {date(detail.dueAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p>
                {detail.summary.completed}/{detail.summary.participants} người đã hoàn thành ·{' '}
                {detail.summary.overdue} người quá hạn trong phạm vi được xem.
              </p>
              {manage && detail.members.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="batch-member-search">Tìm học viên trong đợt</Label>
                  <Input
                    id="batch-member-search"
                    value={memberSearch}
                    onChange={(e) => {
                      setMemberSearch(e.target.value);
                      setMemberPage(1);
                    }}
                  />
                  <p className="text-sm text-muted-foreground" role="status">
                    {filteredMembers.length} học viên phù hợp · Tổng quan phía trên tính toàn bộ
                    phạm vi được xem.
                  </p>
                </div>
              )}
              {visibleMembers.map((member) => (
                <section key={member.accountId} className="space-y-3 rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-medium">{member.name}</h3>
                      <p className="text-sm text-muted-foreground">{member.unitName}</p>
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        member.completed ? 'status-success' : member.overdue ? 'status-danger' : ''
                      }
                    >
                      {member.completed
                        ? 'Hoàn thành'
                        : member.overdue
                          ? 'Quá hạn'
                          : `${member.progress}% hoàn thành`}
                    </Badge>
                  </div>
                  <ol className="space-y-2">
                    {member.courses.map((course, i) => (
                      <li
                        key={course.versionId}
                        className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
                      >
                        <span className="text-sm">
                          {i + 1}. {course.title} · v{course.version}
                        </span>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">
                            {course.passed
                              ? 'Đã đạt'
                              : course.available
                                ? 'Chưa đạt'
                                : 'Cần đối soát nội dung'}
                          </Badge>
                          {!manage && (
                            <Button
                              variant="outline"
                              disabled={!course.available || detail.startsAt > Date.now()}
                              onClick={() => onOpenCourse(course.versionId)}
                            >
                              Mở khóa học
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {!manage && detail.startsAt > Date.now() && (
                    <p className="text-sm text-muted-foreground">
                      Đợt bắt đầu từ {date(detail.startsAt)}.
                    </p>
                  )}
                </section>
              ))}
              {!detail.members.length && (
                <p className="text-sm text-muted-foreground">
                  Không còn học viên đang đủ điều kiện trong phạm vi hiện tại.
                </p>
              )}
              {detail.members.length > 0 && !filteredMembers.length && (
                <p className="text-sm text-muted-foreground">Không tìm thấy học viên phù hợp.</p>
              )}
              {memberPages > 1 && (
                <nav
                  aria-label="Phân trang học viên trong đợt"
                  className="flex flex-wrap items-center gap-3"
                >
                  <Button
                    variant="outline"
                    disabled={currentMemberPage === 1}
                    onClick={() => setMemberPage(currentMemberPage - 1)}
                  >
                    Trang học viên trước
                  </Button>
                  <span className="text-sm" role="status">
                    Trang {currentMemberPage}/{memberPages}
                  </span>
                  <Button
                    variant="outline"
                    disabled={currentMemberPage === memberPages}
                    onClick={() => setMemberPage(currentMemberPage + 1)}
                  >
                    Trang học viên sau
                  </Button>
                </nav>
              )}
            </CardContent>
          </Card>
        </>
      ) : mode === 'work' && !manage ? (
        <TrainingWorkPanel csrfToken={csrfToken} onAccessError={onAccessError} />
      ) : mode === 'paths' && manage && canAdmin ? (
        <>
          <Button
            onClick={() => {
              setEditing(null);
              setSpec(blank());
              setDirty(true);
            }}
          >
            Tạo lộ trình
          </Button>
          <div className="grid gap-4 lg:grid-cols-2">
            {paths.map((path) => (
              <Card key={path.id}>
                <CardHeader>
                  <CardTitle>{path.title}</CardTitle>
                  <CardDescription>
                    {path.version ? `Phiên bản ${path.version}` : 'Bản nháp'} ·{' '}
                    {path.spec.courseVersionIds.length} khóa
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditing(path);
                      setSpec(structuredClone(path.spec));
                      setDirty(false);
                    }}
                  >
                    Thiết kế lộ trình
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                      setSpec({ ...structuredClone(path.spec), title: path.title + ' — bản sao' });
                      setDirty(true);
                    }}
                  >
                    Dùng làm mẫu
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="batch-search">Tìm đợt đào tạo</Label>
            <Input
              id="batch-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tên đợt hoặc lộ trình…"
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {batches
              .filter((b) => normalized(b.title + ' ' + b.pathTitle).includes(normalized(search)))
              .map((batch) => (
                <Card key={batch.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <CardTitle>{batch.title}</CardTitle>
                      <Badge
                        variant="outline"
                        className={
                          batch.status === 'cancelled'
                            ? ''
                            : batch.summary.overdue
                              ? 'status-warning'
                              : 'status-info'
                        }
                      >
                        {batch.status === 'cancelled'
                          ? 'Đã hủy'
                          : batch.startsAt > Date.now()
                            ? 'Sắp bắt đầu'
                            : batch.summary.overdue
                              ? 'Có người quá hạn'
                              : 'Đang theo dõi'}
                      </Badge>
                    </div>
                    <CardDescription>
                      {batch.pathTitle} · phiên bản {batch.pathVersion}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm">
                      {date(batch.startsAt)} → {date(batch.dueAt)} · {batch.summary.completed}/
                      {batch.summary.participants} người hoàn thành
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() =>
                          void perform(async () =>
                            setDetail(
                              await api<Batch>(
                                '/api/lms/training-batch?id=' +
                                  batch.id +
                                  '&manage=' +
                                  String(manage),
                              ),
                            ),
                          )
                        }
                      >
                        Xem tiến độ
                      </Button>
                      {manage && canAdmin && batch.status === 'active' && (
                        <>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setChanging(batch);
                              setTitle(batch.title);
                              setStart(date(batch.startsAt));
                              setDue(date(batch.dueAt));
                            }}
                          >
                            Đổi lịch
                          </Button>
                          <Button variant="ghost" onClick={() => setCancelling(batch)}>
                            Hủy đợt
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
          </div>
          {!busy && !batches.length && (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                Chưa có đợt đào tạo trong phạm vi của bạn.
              </CardContent>
            </Card>
          )}
        </>
      )}
      <Dialog
        open={creating || !!changing}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setCreating(false);
            setChanging(null);
            setIntake(null);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{changing ? 'Đổi lịch đợt đào tạo' : 'Tạo đợt đào tạo'}</DialogTitle>
            <DialogDescription>
              Đợt lưu phiên bản nội dung và danh sách người học đã chọn. Việc giao đợt không cấp
              thêm quyền ứng dụng. Kết quả đạt trước đây của cùng phiên bản khóa học được tính vào
              tiến độ đợt.
            </DialogDescription>
          </DialogHeader>
          {Boolean(error) && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-4">
            {creating && intake?.summary && (
              <div className="rounded-lg bg-secondary p-3 text-sm">
                <p className="font-medium">Nội dung đã duyệt</p>
                <p className="whitespace-pre-wrap break-words">{intake.summary}</p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="batch-title">Tên đợt</Label>
              <Input
                id="batch-title"
                maxLength={150}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              {title.length > 150 && (
                <p className="text-sm text-muted-foreground">
                  Rút gọn tên đợt còn tối đa 150 ký tự.
                </p>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="batch-start">Ngày bắt đầu</Label>
                <Input
                  type="date"
                  id="batch-start"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="batch-due">Hạn hoàn thành</Label>
                <Input
                  type="date"
                  id="batch-due"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Ngày theo giờ Việt Nam; hạn kết thúc vào cuối ngày. Đây là lịch giao việc của đợt;
              truy cập nội dung theo chính sách riêng của khóa học.
            </p>
            {!changing && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="batch-path-search">Tìm lộ trình phát hành</Label>
                  <Input
                    id="batch-path-search"
                    value={pathSearch}
                    onChange={(e) => setPathSearch(e.target.value)}
                  />
                  {pathQuery && !matchingPaths.length && (
                    <p role="status" className="text-sm text-muted-foreground">
                      Không tìm thấy lộ trình phát hành.
                    </p>
                  )}
                  {matchingPaths.length > pathOptionLimit && (
                    <p role="status" className="text-sm text-muted-foreground">
                      Có {matchingPaths.length} lộ trình phù hợp. Nhập thêm tên để thu hẹp kết quả.
                    </p>
                  )}
                </div>
                <Choice
                  label="Lộ trình phát hành"
                  value={pathVersion || '_none'}
                  onChange={(v) => {
                    setPathVersion(v === '_none' ? '' : v);
                    setSelected([]);
                  }}
                  options={[
                    { id: '_none', name: 'Chọn lộ trình' },
                    ...visiblePaths.map((path) => ({
                      id: path.versionId!,
                      name: pathLabel(path),
                    })),
                  ]}
                />
                <Choice
                  label="Đơn vị phụ trách đợt"
                  value={owner}
                  onChange={setOwner}
                  options={refs.units}
                  disabled={!!intake}
                />
                <div className="space-y-2">
                  <Label htmlFor="batch-person-search">Tìm người học</Label>
                  <Input
                    id="batch-person-search"
                    value={personSearch}
                    onChange={(e) => setPersonSearch(e.target.value)}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  Đã chọn {selected.length} người · {participants.length} người đủ đối tượng hiện
                  tại
                </p>
                <div
                  role="region"
                  aria-label="Chọn người học"
                  tabIndex={0}
                  className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {participants
                    .filter((p) =>
                      normalized(p.name + ' ' + p.unitName).includes(normalized(personSearch)),
                    )
                    .map((p) => (
                      <label key={p.accountId} className="flex items-center gap-3">
                        <Checkbox
                          checked={selected.includes(p.accountId)}
                          onCheckedChange={(v) =>
                            setSelected(
                              v
                                ? [...selected, p.accountId]
                                : selected.filter((id) => id !== p.accountId),
                            )
                          }
                        />
                        <span className="text-sm">
                          {p.name} · {p.unitName}
                        </span>
                      </label>
                    ))}
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setCreating(false);
                setChanging(null);
                setIntake(null);
              }}
            >
              Đóng
            </Button>
            <Button
              disabled={
                busy ||
                !title.trim() ||
                title.length > 150 ||
                !start ||
                !due ||
                fromDate(due, true) <= fromDate(start) ||
                (!changing && (!pathVersion || !selected.length))
              }
              onClick={() =>
                void perform(async () => {
                  if (changing)
                    await command('update-batch', {
                      id: changing.id,
                      expectedRevision: changing.revision,
                      title,
                      startsAt: fromDate(start),
                      dueAt: fromDate(due, true),
                      status: 'active',
                    });
                  else
                    await command('create-batch', {
                      pathVersionId: pathVersion,
                      ownerUnitId: owner,
                      title,
                      startsAt: fromDate(start),
                      dueAt: fromDate(due, true),
                      accountIds: selected,
                      ...(intake && { workflowIntakeId: intake.id }),
                    });
                  if (intake)
                    setIntakes((items) => items?.filter(({ id }) => id !== intake.id) ?? null);
                  setIntake(null);
                  setCreating(false);
                  setChanging(null);
                  await load();
                  setNotice('Đã lưu đợt đào tạo.');
                })
              }
            >
              {changing ? 'Lưu lịch' : 'Giao đợt đào tạo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!cancelling} onOpenChange={(open) => !open && setCancelling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hủy đợt đào tạo?</DialogTitle>
            <DialogDescription>
              {cancelling?.title}. Kết quả học đã ghi nhận được giữ trong lịch sử; đợt không thể
              kích hoạt lại.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelling(null)}>
              Quay lại
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const b = cancelling!;
                  await command('update-batch', {
                    id: b.id,
                    expectedRevision: b.revision,
                    title: b.title,
                    startsAt: b.startsAt,
                    dueAt: b.dueAt,
                    status: 'cancelled',
                  });
                  setCancelling(null);
                  await load();
                })
              }
            >
              Xác nhận hủy đợt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bỏ thay đổi lộ trình?</DialogTitle>
            <DialogDescription>Bản nháp chưa lưu sẽ bị bỏ.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscard(false)}>
              Tiếp tục chỉnh sửa
            </Button>
            <Button
              onClick={() => {
                setDiscard(false);
                setSpec(null);
                setDirty(false);
              }}
            >
              Bỏ thay đổi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
