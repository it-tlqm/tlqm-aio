import { CoursePolicyEditor } from './course-policy-editor';
import { ConfigurationTransferControls } from '@/components/configuration-transfer';
import { UnitPicker } from '@/components/unit-picker';
import { learningPolicy } from '../../../src/lms/learning-policy';
import { useEffect, useState } from 'react';
import { Plus, ArrowLeft, Save, Send, FileText, Trash2, Video, Pause } from 'lucide-react';
import { api, apiCollection, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { MediaUpload } from './media-upload';
import { QuestionImport, QuestionExport, BankPicker } from './question-tools';
import { sourceFromInput, videoEmbedUrl } from '../../../src/lms/video-sources';
import type { VideoSource } from '../../../src/lms/video-sources';
import { LearningVideo } from './video-player';
import { useCourseCommands } from './course-api';
import type { ManagedCourse, UploadedMedia } from './course-api';
import type {
  CourseSpec,
  Question,
  Checkpoint,
  AnswerKey,
} from '../../../src/lms/course-contracts';
import { Empty, normalized } from './common';

const blank = (): CourseSpec => ({
  schemaVersion: 1,
  title: '',
  subtitle: '',
  series: 'Đào tạo nội bộ',
  duration: 0,
  video: null,
  deadline: '',
  isMandatory: true,
  audienceUnits: [],
  checkpoints: [],
  questions: [],
  answerKey: {},
  attachments: [],
});
export function QuestionEditor({
  question,
  answer,
  checkpoint,
  onChange,
  onDelete,
}: {
  question: Question | Checkpoint;
  answer: AnswerKey;
  checkpoint: boolean;
  onChange: (question: Question | Checkpoint, answer: AnswerKey) => void;
  onDelete?: () => void;
}) {
  const options = question.options;
  const prefix = question.id;
  return (
    <Card size="sm" className="shadow-none">
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="w-full space-y-2">
            <Label htmlFor={prefix + '-question'}>
              {checkpoint ? 'Câu hỏi tại điểm dừng' : 'Câu hỏi bài kiểm tra'}
            </Label>
            <Textarea
              id={prefix + '-question'}
              value={question.question}
              onChange={(event) => onChange({ ...question, question: event.target.value }, answer)}
            />
          </div>
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={'Xóa câu hỏi ' + question.question}
              onClick={onDelete}
            >
              <Trash2 className="text-destructive" />
            </Button>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={prefix + '-type'}>Loại câu hỏi</Label>
            <Select
              value={question.type}
              onValueChange={(type) =>
                onChange(
                  {
                    ...question,
                    type: type as Question['type'],
                    options: type === 'text' ? [] : ['Lựa chọn 1', 'Lựa chọn 2'],
                  },
                  {
                    answer: type === 'text' ? '' : type === 'multiple' ? [0] : 0,
                    explanation: answer.explanation,
                  },
                )
              }
            >
              <SelectTrigger id={prefix + '-type'} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">Chọn một</SelectItem>
                <SelectItem value="multiple">Chọn nhiều</SelectItem>
                <SelectItem value="text">Nhập đáp án</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {checkpoint && (
            <div className="space-y-2">
              <Label htmlFor={prefix + '-time'}>Điểm dừng (giây)</Label>
              <Input
                id={prefix + '-time'}
                type="number"
                min={0}
                value={(question as Checkpoint).time}
                onChange={(event) =>
                  onChange({ ...question, time: Number(event.target.value) } as Checkpoint, answer)
                }
              />
            </div>
          )}
        </div>
        {checkpoint && (
          <div className="space-y-2">
            <Label htmlFor={prefix + '-title'}>Tên điểm dừng</Label>
            <Input
              id={prefix + '-title'}
              value={(question as Checkpoint).title}
              onChange={(event) =>
                onChange({ ...question, title: event.target.value } as Checkpoint, answer)
              }
            />
          </div>
        )}
        {question.type === 'text' ? (
          <div className="space-y-2">
            <Label htmlFor={prefix + '-answer'}>Đáp án chuẩn</Label>
            <Input
              id={prefix + '-answer'}
              value={String(answer.answer)}
              onChange={(event) => onChange(question, { ...answer, answer: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Không phân biệt hoa thường; chuẩn hóa khoảng trắng. Nội dung phải khớp đáp án.
            </p>
          </div>
        ) : (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Lựa chọn và đáp án đúng</legend>
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <Checkbox
                  aria-label={'Đáp án đúng ' + (index + 1) + ' — ' + question.question}
                  checked={
                    question.type === 'multiple'
                      ? (answer.answer as number[]).includes(index)
                      : answer.answer === index
                  }
                  onCheckedChange={(checked) =>
                    onChange(question, {
                      ...answer,
                      answer:
                        question.type === 'multiple'
                          ? checked
                            ? [...(answer.answer as number[]), index]
                            : (answer.answer as number[]).filter((value) => value !== index)
                          : index,
                    })
                  }
                />
                <Input
                  aria-label={'Lựa chọn ' + (index + 1) + ' — ' + question.question}
                  value={option}
                  onChange={(event) =>
                    onChange(
                      {
                        ...question,
                        options: options.map((value, i) =>
                          i === index ? event.target.value : value,
                        ),
                      },
                      answer,
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={'Xóa lựa chọn ' + (index + 1)}
                  disabled={options.length <= 2}
                  onClick={() =>
                    onChange(
                      { ...question, options: options.filter((_, i) => i !== index) },
                      { ...answer, answer: question.type === 'multiple' ? [0] : 0 },
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              disabled={options.length >= 12}
              onClick={() =>
                onChange(
                  { ...question, options: [...options, 'Lựa chọn ' + (options.length + 1)] },
                  answer,
                )
              }
            >
              <Plus />
              Thêm lựa chọn
            </Button>
          </fieldset>
        )}
        <div className="space-y-2">
          <Label htmlFor={prefix + '-explanation'}>Giải thích đáp án</Label>
          <Textarea
            id={prefix + '-explanation'}
            value={answer.explanation}
            onChange={(event) => onChange(question, { ...answer, explanation: event.target.value })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
export function CourseManager({
  csrfToken,
  onAccessError,
  onDirtyChange,
}: {
  csrfToken: string;
  onAccessError: (error: unknown) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [items, setItems] = useState<ManagedCourse[]>([]),
    [refs, setRefs] = useState<{ ownUnitId: string; units: { id: string; name: string }[] }>({
      ownUnitId: '',
      units: [],
    }),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState(''),
    [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ManagedCourse | null>(null),
    [spec, setSpec] = useState<CourseSpec | null>(null),
    [code, setCode] = useState(''),
    [owner, setOwner] = useState(''),
    [dirty, setDirty] = useState(false),
    [tab, setTab] = useState('info'),
    [archive, setArchive] = useState<ManagedCourse | null>(null),
    [discard, setDiscard] = useState(false),
    [provider, setProvider] = useState<VideoSource['kind']>('file'),
    [sourceInput, setSourceInput] = useState(''),
    [mediaItems, setMediaItems] = useState<UploadedMedia[]>([]),
    [previewSource, setPreviewSource] = useState<VideoSource | null>(null),
    [previewError, setPreviewError] = useState('');
  useEffect(() => {
    onDirtyChange(Boolean(spec && dirty));
  }, [spec, dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!spec || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [spec, dirty]);
  const command = useCourseCommands(csrfToken);
  const fail = (error: unknown) => {
    setError(error);
    if (error instanceof ApiError && [401, 403].includes(error.status)) onAccessError(error);
  };
  async function load() {
    setLoading(true);
    setError(null);
    setItems([]);
    try {
      const [list, lookup, media] = await Promise.all([
        apiCollection<ManagedCourse>('/api/lms/manage/courses'),
        api<typeof refs>('/api/lms/lookups'),
        apiCollection<UploadedMedia>('/api/lms/media'),
      ]);
      setItems(list.items);
      setRefs(lookup);
      setMediaItems(media.items);
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function reloadQuestionDraft() {
    if (!editing) return;
    const result = await apiCollection<ManagedCourse>('/api/lms/manage/courses'),
      current = result.items.find((item) => item.id === editing.id);
    if (!current) throw new ApiError(404, 'LMS_COURSE_NOT_FOUND');
    setItems(result.items);
    setEditing(current);
    setSpec(structuredClone(current.spec));
    setDirty(false);
    setNotice('Đã cập nhật câu hỏi trong bản nháp. Bản phát hành giữ nguyên.');
  }
  function edit(item: ManagedCourse | null) {
    const video = item?.spec.video;
    setProvider(video?.kind ?? 'file');
    setSourceInput(
      video?.kind === 'direct'
        ? video.url
        : video && video.kind !== 'file'
          ? video.kind === 'vimeo' && video.hash
            ? videoEmbedUrl(video)!
            : video.id
          : '',
    );
    setPreviewSource(null);
    setPreviewError('');
    setEditing(item);
    setSpec(item ? structuredClone(item.spec) : blank());
    setCode(item?.code ?? 'khoa-hoc-' + crypto.randomUUID().slice(0, 8));
    setOwner(item?.ownerUnitId ?? refs.ownUnitId);
    setDirty(!item);
    setTab('info');
    setError(null);
    setNotice('');
  }
  function update(next: CourseSpec) {
    setSpec(next);
    setDirty(true);
    setNotice('');
  }
  async function save() {
    if (!spec) return;
    setBusy(true);
    setError(null);
    try {
      let draft = spec;
      if (provider !== 'file') {
        try {
          draft = {
            ...spec,
            schemaVersion: spec.schemaVersion === 3 ? 3 : 2,
            video: sourceFromInput(provider, sourceInput),
          };
        } catch {
          throw new ApiError(400, 'LMS_VIDEO_SOURCE_INVALID');
        }
      }
      const result = await command<{ id: string; revision: number }>('save-course', {
        ...(editing ? { courseId: editing.id } : {}),
        code,
        ownerUnitId: owner,
        expectedRevision: editing?.revision ?? 0,
        spec: draft,
      });
      setSpec(draft);
      setEditing({
        id: result.id,
        revision: result.revision,
        code,
        ownerUnitId: owner,
        spec: draft,
        versionId: editing?.versionId ?? null,
        version: editing?.version ?? null,
        status: editing?.status ?? 'active',
        updatedAt: Date.now(),
      });
      setDirty(false);
      setNotice('Đã lưu bản nháp khóa học.');
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const result = await command<{ revision: number; versionId: string; version: number }>(
        'publish-course',
        { courseId: editing.id, expectedRevision: editing.revision },
      );
      setEditing({ ...editing, ...result, status: 'active' });
      setNotice(
        'Đã phát hành phiên bản ' + result.version + '. Học viên được cấp có thể bắt đầu học.',
      );
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  function question(type: 'checkpoint' | 'quiz') {
    if (!spec) return;
    const id = crypto.randomUUID(),
      base: Question = {
        id,
        type: 'single',
        question: 'Câu hỏi mới',
        options: ['Lựa chọn 1', 'Lựa chọn 2'],
      };
    update({
      ...spec,
      checkpoints:
        type === 'checkpoint'
          ? [
              ...spec.checkpoints,
              {
                ...base,
                title: 'Điểm dừng mới',
                time: Math.min(spec.duration, (spec.checkpoints.at(-1)?.time ?? 0) + 5),
              },
            ]
          : spec.checkpoints,
      questions: type === 'quiz' ? [...spec.questions, base] : spec.questions,
      answerKey: { ...spec.answerKey, [id]: { answer: 0, explanation: '' } },
    });
  }
  function uploaded(media: UploadedMedia) {
    if (!spec) return;
    setMediaItems((items) => [media, ...items.filter((item) => item.id !== media.id)]);
    if (media.kind === 'video') {
      setProvider('file');
      setSourceInput('');
      setPreviewSource(null);
      update({ ...spec, video: { kind: 'file', id: media.id } });
    } else
      update({
        ...spec,
        attachments: [
          ...spec.attachments,
          { id: crypto.randomUUID(), title: media.name, mediaId: media.id },
        ],
      });
  }
  const errors = Boolean(error) && (
    <Alert variant="destructive">
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  );
  if (spec)
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={() => {
              if (dirty) {
                setDiscard(true);
                return;
              }
              setDirty(false);
              setSpec(null);
              void load();
            }}
          >
            <ArrowLeft />
            Danh sách khóa học
          </Button>
          <div className="flex flex-wrap gap-2">
            {dirty && <Badge variant="outline">Chưa lưu thay đổi</Badge>}
            {editing && (
              <ConfigurationTransferControls
                kind="lms-course"
                target={editing.id}
                csrfToken={csrfToken}
                disabled={busy || dirty}
                onImported={async () => {
                  const data = await apiCollection<ManagedCourse>('/api/lms/manage/courses'),
                    current = data.items.find((c) => c.id === editing.id);
                  if (!current) throw new ApiError(404, 'LMS_COURSE_NOT_FOUND');
                  setItems(data.items);
                  edit(current);
                  setNotice('Đã nhập cấu hình khóa học vào bản nháp. Bản phát hành giữ nguyên.');
                }}
              />
            )}
            <Button variant="outline" disabled={busy} onClick={() => void save()}>
              <Save />
              Lưu bản nháp
            </Button>
            <Button disabled={!editing || dirty || busy} onClick={() => void publish()}>
              <Send />
              Phát hành
            </Button>
          </div>
        </div>
        {errors}
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        <Dialog open={discard} onOpenChange={setDiscard}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Bỏ thay đổi chưa lưu?</DialogTitle>
              <DialogDescription>
                Nội dung vừa chỉnh sửa chưa được lưu vào bản nháp.
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
                  setDirty(false);
                  setSpec(null);
                  void load();
                }}
              >
                Bỏ thay đổi
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="info">Thông tin</TabsTrigger>
            <TabsTrigger value="policy">Chính sách học & thi</TabsTrigger>
            <TabsTrigger value="media">Video & tài liệu</TabsTrigger>
            <TabsTrigger value="checkpoints">Điểm dừng ({spec.checkpoints.length})</TabsTrigger>
            <TabsTrigger value="quiz">Bài kiểm tra ({spec.questions.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="policy">
            <CoursePolicyEditor
              spec={spec}
              onChange={update}
              courses={items}
              courseId={editing?.id}
            />
          </TabsContent>
          <TabsContent value="info">
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  {editing ? 'Thiết kế khóa học' : 'Tạo khóa học'}
                </CardTitle>
                <CardDescription>
                  Lưu bản nháp trước khi phát hành. Mỗi phiên bản giữ nguyên kết quả học đã ghi
                  nhận.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="course-title">Tên khóa học</Label>
                  <Input
                    id="course-title"
                    value={spec.title}
                    onChange={(event) => update({ ...spec, title: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="course-code">Mã khóa học</Label>
                  <Input
                    id="course-code"
                    disabled={!!editing}
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value);
                      setDirty(true);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="course-series">Chương trình / chuyên đề</Label>
                  <Input
                    id="course-series"
                    value={spec.series}
                    onChange={(event) => update({ ...spec, series: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="course-deadline">Hạn học</Label>
                  <Input
                    id="course-deadline"
                    type="date"
                    value={spec.deadline}
                    onChange={(event) => update({ ...spec, deadline: event.target.value })}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="course-description">Mô tả ngắn</Label>
                  <Textarea
                    id="course-description"
                    value={spec.subtitle}
                    onChange={(event) => update({ ...spec, subtitle: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="course-owner">Đơn vị quản lý</Label>
                  <Select
                    value={owner}
                    onValueChange={(value) => {
                      setOwner(value);
                      setDirty(true);
                    }}
                    disabled={!!editing}
                  >
                    <SelectTrigger id="course-owner" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {refs.units.map((unit) => (
                        <SelectItem key={unit.id} value={unit.id}>
                          {unit.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={spec.isMandatory}
                    onCheckedChange={(value) => update({ ...spec, isMandatory: value === true })}
                  />
                  Khóa học bắt buộc
                </label>
                <fieldset className="space-y-2 md:col-span-2">
                  <legend className="mb-2 font-medium">Đơn vị được học</legend>
                  <UnitPicker
                    options={refs.units}
                    value={spec.audienceUnits}
                    onChange={(audienceUnits) => update({ ...spec, audienceUnits })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Tên đơn vị tham chiếu hồ sơ LMS. Phạm vi truy cập được kiểm tra bằng định danh
                    đơn vị AIO.
                  </p>
                </fieldset>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="media" className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  Video bài học
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <MediaUpload
                  ownerUnitId={owner}
                  csrfToken={csrfToken}
                  onUploaded={uploaded}
                  onAccessError={onAccessError}
                />
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="course-provider">Nguồn video</Label>
                    <Select
                      value={provider}
                      onValueChange={(value) => {
                        setProvider(value as VideoSource['kind']);
                        setSourceInput('');
                        setPreviewSource(null);
                        setPreviewError('');
                        setDirty(true);
                      }}
                    >
                      <SelectTrigger id="course-provider" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="file">File trong LMS</SelectItem>
                        <SelectItem value="youtube">YouTube</SelectItem>
                        <SelectItem value="vimeo">Vimeo</SelectItem>
                        <SelectItem value="gdrive">Google Drive</SelectItem>
                        <SelectItem value="direct">Liên kết video HTTPS</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="course-duration">Thời lượng (giây)</Label>
                    <Input
                      id="course-duration"
                      type="number"
                      min={0}
                      value={spec.duration}
                      onChange={(event) =>
                        update({ ...spec, duration: Number(event.target.value) })
                      }
                    />
                  </div>
                </div>
                {provider === 'file' ? (
                  <div className="space-y-2">
                    <Label htmlFor="course-stored-video">Video đã tải</Label>
                    <Select
                      value={spec.video?.kind === 'file' ? spec.video.id : '_none'}
                      onValueChange={(id) =>
                        update({ ...spec, video: id === '_none' ? null : { kind: 'file', id } })
                      }
                    >
                      <SelectTrigger id="course-stored-video" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">Chọn video trong thư viện</SelectItem>
                        {mediaItems
                          .filter((item) => item.kind === 'video')
                          .map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Label htmlFor="course-source">Liên kết hoặc ID video</Label>
                    <Input
                      id="course-source"
                      value={sourceInput}
                      onChange={(event) => {
                        setSourceInput(event.target.value);
                        setPreviewSource(null);
                        setDirty(true);
                      }}
                    />
                    <Button
                      variant="outline"
                      onClick={() => {
                        try {
                          const source = sourceFromInput(provider, sourceInput);
                          setPreviewSource(source);
                          setPreviewError('');
                          update({
                            ...spec,
                            schemaVersion: spec.schemaVersion === 3 ? 3 : 2,
                            video: source,
                          });
                        } catch {
                          setPreviewError('Liên kết hoặc ID video chưa hợp lệ.');
                        }
                      }}
                    >
                      Xem trước liên kết
                    </Button>
                    {provider === 'gdrive' && (
                      <p className="text-sm text-muted-foreground">
                        Google Drive dùng xác nhận mốc học của học viên; không báo thời gian phát tự
                        động cho LMS.
                      </p>
                    )}
                  </div>
                )}
                {previewError && (
                  <Alert variant="destructive">
                    <AlertDescription>{previewError}</AlertDescription>
                  </Alert>
                )}
                {previewSource && provider !== 'file' && (
                  <LearningVideo
                    source={previewSource}
                    versionId=""
                    title="Xem trước video nhúng"
                    start={0}
                    maximum={86400}
                    paused={false}
                    onTime={() => {}}
                    onEnded={() => {}}
                    onError={setPreviewError}
                  />
                )}
                {provider === 'file' && spec.video?.kind === 'file' && (
                  <video
                    aria-label="Xem trước video khóa học"
                    controls
                    preload="metadata"
                    className="max-h-96 w-full rounded-lg bg-black"
                    src={'/api/lms/media/' + spec.video.id}
                    onLoadedMetadata={(event) => {
                      const duration = event.currentTarget.duration;
                      if (
                        Number.isFinite(duration) &&
                        duration > 0 &&
                        Math.abs(duration - spec.duration) > 0.5
                      )
                        update({ ...spec, duration: Math.round(duration * 10) / 10 });
                    }}
                  />
                )}
                {spec.video && (
                  <p className="text-sm text-muted-foreground">
                    {spec.video.kind === 'file'
                      ? 'Video đã lưu trong LMS.'
                      : 'Sử dụng nguồn video đã cấu hình.'}
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  Tài liệu đính kèm
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <MediaUpload
                  ownerUnitId={owner}
                  csrfToken={csrfToken}
                  onUploaded={uploaded}
                  onAccessError={onAccessError}
                  kind="document"
                />
                {spec.attachments.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <a
                      href={'/api/lms/media/' + item.mediaId}
                      className="flex min-h-11 items-center gap-2 text-primary underline underline-offset-4"
                    >
                      <FileText className="size-4" />
                      {item.title}
                    </a>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={'Bỏ tài liệu ' + item.title}
                      onClick={() =>
                        update({
                          ...spec,
                          attachments: spec.attachments.filter((a) => a.id !== item.id),
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
          {(['checkpoints', 'quiz'] as const).map((kind) => (
            <TabsContent key={kind} value={kind} className="space-y-4">
              <div className="space-y-3 rounded-lg border bg-card p-4">
                <div className="flex flex-wrap gap-3">
                  <QuestionImport
                    kind={kind === 'checkpoints' ? 'checkpoint' : 'quiz'}
                    target={{
                      destination: 'course',
                      courseId: editing?.id ?? '',
                      expectedRevision: editing?.revision ?? 0,
                    }}
                    csrfToken={csrfToken}
                    disabled={busy || dirty || !editing}
                    onApplied={reloadQuestionDraft}
                    onAccessError={onAccessError}
                  />
                  <BankPicker
                    kind={kind === 'checkpoints' ? 'checkpoint' : 'quiz'}
                    courseId={editing?.id ?? ''}
                    expectedRevision={editing?.revision ?? 0}
                    csrfToken={csrfToken}
                    disabled={busy || dirty || !editing}
                    onApplied={reloadQuestionDraft}
                    onAccessError={onAccessError}
                  />
                  <QuestionExport
                    kind={kind === 'checkpoints' ? 'checkpoint' : 'quiz'}
                    csrfToken={csrfToken}
                    onAccessError={onAccessError}
                  />
                  <QuestionExport
                    kind={kind === 'checkpoints' ? 'checkpoint' : 'quiz'}
                    source={{ source: 'course', courseId: editing?.id ?? '' }}
                    csrfToken={csrfToken}
                    disabled={busy || dirty || !editing}
                    onAccessError={onAccessError}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Lưu bản nháp trước khi nhập, lấy từ ngân hàng hoặc xuất câu hỏi. Thao tác áp dụng
                  vào bản nháp đã lưu.
                </p>
              </div>
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    {kind === 'checkpoints' ? 'Câu hỏi trong video' : 'Câu hỏi kiểm tra cuối bài'}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {kind === 'checkpoints'
                      ? 'Xếp điểm dừng theo thời gian tăng dần.'
                      : `Học viên đạt từ ${learningPolicy(spec).passScore} điểm. Đáp án chỉ được dùng tại máy chủ khi chấm.`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => question(kind === 'checkpoints' ? 'checkpoint' : 'quiz')}
                >
                  <Plus />
                  {kind === 'checkpoints' ? 'Thêm điểm dừng' : 'Thêm câu hỏi'}
                </Button>
              </div>
              {(kind === 'checkpoints' ? spec.checkpoints : spec.questions).map((q) => (
                <QuestionEditor
                  key={q.id}
                  question={q}
                  answer={spec.answerKey[q.id]!}
                  checkpoint={kind === 'checkpoints'}
                  onChange={(next, key) =>
                    update({
                      ...spec,
                      [kind === 'checkpoints' ? 'checkpoints' : 'questions']: (kind ===
                      'checkpoints'
                        ? spec.checkpoints
                        : spec.questions
                      ).map((item) => (item.id === q.id ? next : item)),
                      answerKey: { ...spec.answerKey, [q.id]: key },
                    })
                  }
                  onDelete={() => {
                    const keys = { ...spec.answerKey };
                    delete keys[q.id];
                    update({
                      ...spec,
                      [kind === 'checkpoints' ? 'checkpoints' : 'questions']: (kind ===
                      'checkpoints'
                        ? spec.checkpoints
                        : spec.questions
                      ).filter((item) => item.id !== q.id),
                      answerKey: keys,
                    });
                  }}
                />
              ))}
              {!(kind === 'checkpoints' ? spec.checkpoints : spec.questions).length && (
                <Empty
                  title={kind === 'checkpoints' ? 'Chưa có điểm dừng' : 'Chưa có câu hỏi kiểm tra'}
                  detail="Thêm câu hỏi và đáp án để hoàn thiện nội dung khóa học."
                />
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    );
  const filtered = items.filter((item) =>
    normalized(item.spec.title + ' ' + item.code).includes(normalized(search)),
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Quản lý khóa học</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Thiết kế nội dung, video và bài kiểm tra; phát hành theo đơn vị.
          </p>
        </div>
        <Button disabled={loading} onClick={() => edit(null)}>
          <Plus />
          Tạo khóa học
        </Button>
      </div>
      {errors}
      <Input
        aria-label="Tìm khóa học quản lý"
        placeholder="Tìm tên hoặc mã khóa học…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {loading ? (
        <p role="status">Đang tải khóa học…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((item) => (
            <Card key={item.id} className="shadow-none">
              <CardHeader>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">
                    {item.version ? 'Phiên bản ' + item.version : 'Bản nháp'}
                  </Badge>
                  {item.status === 'archived' && <Badge variant="outline">Đã ngừng</Badge>}
                </div>
                <CardTitle role="heading" aria-level={3}>
                  {item.spec.title}
                </CardTitle>
                <CardDescription>
                  {item.spec.series} · {item.code}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => edit(item)}>
                  <Video />
                  Thiết kế
                </Button>
                {item.versionId && item.status === 'active' && (
                  <Button variant="ghost" onClick={() => setArchive(item)}>
                    <Pause />
                    Ngừng phát hành
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
          {!filtered.length && (
            <Empty
              title="Chưa có khóa học phù hợp"
              detail="Tạo khóa học mới hoặc đổi từ khóa tìm kiếm."
            />
          )}
        </div>
      )}
      <Dialog
        open={!!archive}
        onOpenChange={(open) => {
          if (!open) setArchive(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ngừng phát hành khóa học?</DialogTitle>
            <DialogDescription>
              Học viên sẽ không tiếp tục truy cập nội dung. Kết quả đã nộp được giữ nguyên.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setArchive(null)}>
              Hủy
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (!archive) return;
                setBusy(true);
                void command('course-status', {
                  courseId: archive.id,
                  expectedRevision: archive.revision,
                  status: 'archived',
                })
                  .then(() => {
                    setArchive(null);
                    return load();
                  })
                  .catch(fail)
                  .finally(() => setBusy(false));
              }}
            >
              Ngừng phát hành
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
