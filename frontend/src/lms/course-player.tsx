import { learningPolicy } from '../../../src/lms/learning-policy';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Play,
  Save,
  FileText,
  Plus,
  Trash2,
  ClipboardCheck,
  CheckCircle2,
  NotebookPen,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardContent, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useCourseCommands } from './course-api';
import type { CourseDetail, AttemptResult } from './course-api';
import type { Answer, Checkpoint } from '../../../src/lms/course-contracts';
import { validAnswer } from '../../../src/lms/course-contracts';
import { LearningVideo } from './video-player';
import type { VideoControl } from './video-player';
import { AnswerFields } from './answer-fields';
import { AttemptReadback } from './attempt-result';
import { minutes, ProgressMeter } from './common';
type ProgressUpdate = { position: number; watched: number; finished: boolean; revision: number };
export function CoursePlayer({
  versionId,
  csrfToken,
  onBack,
  onAccessError,
  onDirtyChange,
}: {
  versionId: string;
  csrfToken: string;
  onBack: () => void;
  onAccessError: (error: unknown) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [assessmentNow, setAssessmentNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setAssessmentNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [detail, setDetail] = useState<CourseDetail | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [mediaError, setMediaError] = useState(''),
    [notice, setNotice] = useState(''),
    [mode, setMode] = useState<'video' | 'quiz' | 'result'>('video');
  const [position, setPosition] = useState(0),
    [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null),
    [answer, setAnswer] = useState<Answer | undefined>(undefined),
    [feedback, setFeedback] = useState<{ correct: boolean; explanation: string } | null>(null),
    [note, setNote] = useState(''),
    [answers, setAnswers] = useState<Record<string, Answer>>({}),
    [result, setResult] = useState<AttemptResult | null>(null),
    [confirmSubmit, setConfirmSubmit] = useState(false),
    [leave, setLeave] = useState(false);
  const [videoReady, setVideoReady] = useState(false),
    [mediaRevision, setMediaRevision] = useState(0);
  const control = useRef<VideoControl>(null),
    live = useRef<CourseDetail | null>(null),
    pending = useRef(false),
    currentTime = useRef(0),
    saved = useRef(0),
    opening = useRef(false),
    resume = useRef(false),
    alive = useRef(true),
    tabSwitches = useRef(0);
  const submitButton = useRef<HTMLButtonElement>(null);
  const submitIntent = useRef<{
    key: string;
    signature: string;
    data: { versionId: string; answers: Record<string, Answer>; tabSwitchCount: number };
  } | null>(null);
  const noteIntent = useRef<{
    key: string;
    data: { versionId: string; time: number; content: string };
  } | null>(null);
  const command = useCourseCommands(csrfToken);
  function apply(value: CourseDetail | null) {
    live.current = value;
    if (alive.current) setDetail(value);
  }
  function fail(error: unknown) {
    if (!alive.current) return;
    control.current?.pause();
    setError(error);
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      apply(null);
      onAccessError(error);
    }
  }
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const value = await api<CourseDetail>('/api/lms/course?versionId=' + versionId);
      if (!alive.current) return;
      apply(value);
      setPosition(value.progress.position);
      currentTime.current = value.progress.position;
      saved.current = value.progress.position;
    } catch (error) {
      if (alive.current) fail(error);
    } finally {
      if (alive.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      control.current?.pause();
    };
  }, [versionId]);
  const quizDirty = mode === 'quiz' && Object.keys(answers).length > 0;
  useEffect(() => {
    onDirtyChange(quizDirty);
    return () => onDirtyChange(false);
  }, [quizDirty, onDirtyChange]);
  useEffect(() => {
    if (!quizDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [quizDirty]);
  useEffect(() => {
    if (mode !== 'quiz') return;
    const changed = () => {
      if (document.visibilityState === 'hidden') tabSwitches.current++;
    };
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, [mode]);
  async function persist(seconds: number, acknowledged = false) {
    const value = live.current;
    if (!value || pending.current) return null;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const update = await command<ProgressUpdate>('progress', {
        versionId,
        expectedRevision: value.progress.revision,
        position: Math.max(0, seconds),
        ...(acknowledged ? { acknowledged: true } : {}),
      });
      apply({ ...value, progress: { ...value.progress, ...update } });
      saved.current = update.position;
      setNotice('Tiến độ đã lưu');
      return update;
    } catch (error) {
      fail(error);
      return null;
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function reach(question: Checkpoint) {
    if (opening.current || checkpoint || pending.current) return;
    opening.current = true;
    control.current?.pause();
    const update = await persist(question.time, live.current?.spec.video?.kind === 'gdrive');
    if (update && alive.current) {
      currentTime.current = question.time;
      setPosition(question.time);
      setCheckpoint(question);
      setAnswer(undefined);
      setFeedback(null);
    }
    opening.current = false;
  }
  const next = detail?.spec.checkpoints.find(
    (question) => !detail.progress.answeredCheckpoints.includes(question.id),
  );
  useEffect(() => {
    if (mode !== 'video' || busy || checkpoint || error) return;
    if (next) {
      if (position >= next.time - 0.04) void reach(next);
    } else if (
      detail?.spec.video &&
      detail.spec.video.kind !== 'gdrive' &&
      !detail.progress.finished &&
      position >= detail.spec.duration
    ) {
      // The provider may pause at the course limit while a periodic save is still pending.
      void persist(position);
    }
  }, [next?.id, position, busy, checkpoint, mode, error, detail]);
  useEffect(() => {
    if (!checkpoint && mode === 'video' && resume.current) {
      resume.current = false;
      control.current?.play();
    }
  }, [checkpoint, mode]);
  function time(seconds: number) {
    if (!Number.isFinite(seconds) || mode !== 'video') return;
    const value = live.current;
    if (!value) return;
    const point = value.spec.checkpoints.find(
      (q) => !value.progress.answeredCheckpoints.includes(q.id),
    );
    const allowed = Math.min(seconds, point?.time ?? value.spec.duration, value.spec.duration);
    currentTime.current = allowed;
    setPosition(allowed);
    if (checkpoint || pending.current || error) return;
    if (point && allowed >= point.time - 0.04) {
      void reach(point);
      return;
    }
    if (Math.abs(allowed - saved.current) >= 5) void persist(allowed);
  }
  async function answerCheckpoint() {
    if (!checkpoint || !detail || answer === undefined || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const update = await command<
        ProgressUpdate & { correct: boolean; explanation: string; completed: boolean }
      >('checkpoint', {
        versionId,
        expectedRevision: live.current!.progress.revision,
        questionId: checkpoint.id,
        answer,
      });
      const value = live.current!;
      apply({
        ...value,
        progress: {
          ...value.progress,
          ...update,
          answeredCheckpoints: update.completed
            ? [...new Set([...value.progress.answeredCheckpoints, checkpoint.id])]
            : value.progress.answeredCheckpoints.filter((id) => id !== checkpoint.id),
        },
      });
      setFeedback(update);
    } catch (error) {
      fail(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const signature = JSON.stringify(answers);
      if (!submitIntent.current || submitIntent.current.signature !== signature)
        submitIntent.current = {
          key: crypto.randomUUID(),
          signature,
          data: {
            versionId,
            answers: structuredClone(answers),
            tabSwitchCount: tabSwitches.current,
          },
        };
      const value = await command<AttemptResult>('submit', submitIntent.current.data, {
        key: submitIntent.current.key,
      });
      setResult(value);
      setMode('result');
      setConfirmSubmit(false);
      setAnswers({});
      setNotice('');
    } catch (error) {
      setConfirmSubmit(false);
      fail(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function createNote() {
    if (!note.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!noteIntent.current || noteIntent.current.data.content !== note)
        noteIntent.current = {
          key: crypto.randomUUID(),
          data: {
            versionId,
            time: Math.min(currentTime.current, detail!.spec.duration),
            content: note,
          },
        };
      const value = await command<{ id: string; time: number; content: string; createdAt: number }>(
        'create-note',
        noteIntent.current.data,
        { key: noteIntent.current.key },
      );
      apply({
        ...live.current!,
        notes: [
          ...live.current!.notes,
          { id: value.id, time: value.time, content: value.content, created_at: value.createdAt },
        ].sort((a, b) => a.time - b.time),
      });
      setNote('');
      noteIntent.current = null;
    } catch (error) {
      fail(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function removeNote(id: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await command('delete-note', { noteId: id });
      apply({ ...live.current!, notes: live.current!.notes.filter((note) => note.id !== id) });
    } catch (error) {
      fail(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function back() {
    if (quizDirty) {
      setLeave(true);
      return;
    }
    control.current?.pause();
    if (
      detail &&
      mode === 'video' &&
      detail.spec.video?.kind !== 'gdrive' &&
      Math.abs(currentTime.current - saved.current) > 0.2
    ) {
      if (!(await persist(currentTime.current))) return;
    }
    onBack();
  }
  if (loading) return <p role="status">Đang tải bài học…</p>;
  if (!detail)
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={onBack}>
          Về danh mục khóa học
        </Button>
      </div>
    );
  const manual = detail.spec.video?.kind === 'gdrive';
  const policy = learningPolicy(detail.spec),
    remaining = detail.assessment.remaining,
    waitUntil = detail.assessment.nextAllowedAt;
  const ready =
    (!policy.requireVideoCompletion || detail.progress.finished) &&
    !next &&
    remaining !== 0 &&
    (!waitUntil || waitUntil <= assessmentNow);
  const errorView = Boolean(error) && (
    <Alert variant="destructive">
      <AlertDescription>
        {errorMessage(error)}{' '}
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Tải lại bài học
        </Button>
      </AlertDescription>
    </Alert>
  );
  if (mode === 'result' && result)
    return (
      <AttemptReadback
        result={result}
        csrfToken={csrfToken}
        onAccessError={onAccessError}
        onBack={() => {
          setMode('video');
          setResult(null);
          void load();
        }}
      />
    );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" disabled={busy} onClick={() => void back()}>
          <ArrowLeft />
          Danh mục khóa học
        </Button>
        <Badge variant="outline">Phiên bản {detail.version}</Badge>
      </div>
      <div>
        <h2 className="text-2xl font-semibold">{detail.spec.title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{detail.spec.subtitle}</p>
      </div>
      {errorView}
      {mode === 'quiz' ? (
        <section className="space-y-5" aria-label="Bài kiểm tra cuối khóa">
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-semibold">Bài kiểm tra cuối khóa</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {detail.spec.questions.length} câu hỏi · Từ {policy.passScore} điểm để đạt yêu cầu
                </p>
              </div>
              <Badge variant="secondary">
                Đã trả lời{' '}
                {detail.spec.questions.filter((q) => validAnswer(q, answers[q.id])).length}/
                {detail.spec.questions.length}
              </Badge>
            </CardContent>
          </Card>
          {detail.spec.questions.map((q, index) => (
            <Card key={q.id}>
              <CardHeader>
                <CardTitle role="heading" aria-level={3}>
                  {index + 1}. {q.question}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <AnswerFields
                  question={q}
                  value={answers[q.id]}
                  onChange={(value) => setAnswers({ ...answers, [q.id]: value })}
                  disabled={busy}
                />
              </CardContent>
            </Card>
          ))}
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (quizDirty) setLeave(true);
                else setMode('video');
              }}
            >
              Quay lại bài học
            </Button>
            <Button
              ref={submitButton}
              disabled={busy || detail.spec.questions.some((q) => !validAnswer(q, answers[q.id]))}
              onClick={() => setConfirmSubmit(true)}
            >
              <ClipboardCheck />
              Nộp bài kiểm tra
            </Button>
          </div>
        </section>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-w-0 space-y-5" aria-label="Nội dung bài học">
            <Card className="overflow-hidden">
              <CardContent className="space-y-5">
                {detail.spec.video && (
                  <LearningVideo
                    key={versionId + '-' + mediaRevision}
                    ref={control}
                    source={detail.spec.video}
                    title={'Video bài học: ' + detail.spec.title}
                    versionId={versionId}
                    start={detail.progress.position}
                    maximum={next?.time ?? detail.spec.duration}
                    paused={!!checkpoint || mode !== 'video' || !!error}
                    onTime={time}
                    onEnded={() => {
                      if (currentTime.current < detail.spec.duration - 0.5) {
                        setMediaError(
                          'Video kết thúc trước thời lượng khóa học. Vui lòng báo quản trị kiểm tra nội dung.',
                        );
                        return;
                      }
                      void persist(currentTime.current);
                    }}
                    onPause={() => {
                      if (
                        !pending.current &&
                        !checkpoint &&
                        !error &&
                        Math.abs(currentTime.current - saved.current) > 0.2
                      )
                        void persist(currentTime.current);
                    }}
                    onReady={() => {
                      setVideoReady(true);
                      setMediaError('');
                    }}
                    onError={(message) => {
                      setVideoReady(false);
                      setMediaError(message);
                    }}
                  />
                )}
                {mediaError && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {mediaError}
                      <Button
                        variant="outline"
                        onClick={() => {
                          setMediaError('');
                          setVideoReady(false);
                          setMediaRevision((value) => value + 1);
                        }}
                      >
                        Thử tải video lại
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                <ProgressMeter
                  watched={detail.progress.watched}
                  duration={detail.spec.duration}
                  label="Tiến độ video bài học"
                  caption={manual ? 'Mốc học viên tự xác nhận' : 'Tiến độ bài học'}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    Mốc xem: {minutes(position)} / {minutes(detail.spec.duration)}
                  </span>
                  <Button
                    variant="outline"
                    disabled={busy || manual || !!checkpoint}
                    onClick={() => void persist(position)}
                  >
                    <Save />
                    Lưu tiến độ
                  </Button>
                  {!manual && (
                    <Button
                      variant="outline"
                      disabled={!videoReady || !!checkpoint || !!error || busy}
                      onClick={() => control.current?.play()}
                    >
                      <Play />
                      Phát video
                    </Button>
                  )}
                </div>
                {notice && (
                  <p role="status" className="text-xs text-[var(--success)]">
                    {notice}
                  </p>
                )}
                {manual && (
                  <div className="space-y-3 rounded-lg border bg-secondary p-4">
                    <p className="text-sm leading-6">
                      Google Drive không gửi tiến độ xem cho LMS. Bạn tự xác nhận mốc đã học; hệ
                      thống lưu đây là xác nhận của học viên.
                    </p>
                    <Button
                      disabled={busy || !!checkpoint || ready}
                      onClick={() => {
                        const target = next?.time ?? detail.spec.duration;
                        currentTime.current = target;
                        setPosition(target);
                        if (next) void reach(next);
                        else void persist(target, true);
                      }}
                    >
                      Tôi đã xem {next ? 'đến ' + minutes(next.time) : 'hết video'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
            {checkpoint && (
              <Card className="border-primary" role="region" aria-label="Câu hỏi tại điểm dừng">
                <CardHeader>
                  <Badge variant="secondary">Điểm dừng · {minutes(checkpoint.time)}</Badge>
                  <CardTitle role="heading" aria-level={3}>
                    {checkpoint.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="font-medium">{checkpoint.question}</p>
                  <AnswerFields
                    question={checkpoint}
                    value={answer}
                    disabled={busy || !!feedback}
                    onChange={setAnswer}
                  />
                  {feedback ? (
                    <>
                      <Alert className={feedback.correct ? 'status-success' : 'status-warning'}>
                        <AlertDescription>
                          {feedback.correct ? 'Câu trả lời đúng.' : 'Câu trả lời chưa đúng.'}{' '}
                          {feedback.explanation}
                        </AlertDescription>
                      </Alert>
                      <Button
                        onClick={() => {
                          if (policy.checkpointPolicy === 'correct' && !feedback.correct) {
                            setFeedback(null);
                            setAnswer(undefined);
                            return;
                          }
                          resume.current = !manual;
                          setCheckpoint(null);
                          setFeedback(null);
                          setAnswer(undefined);
                        }}
                      >
                        <Play />
                        {policy.checkpointPolicy === 'correct' && !feedback.correct
                          ? 'Trả lời lại'
                          : 'Tiếp tục học'}
                      </Button>
                    </>
                  ) : (
                    <Button
                      disabled={busy || !validAnswer(checkpoint, answer)}
                      onClick={() => void answerCheckpoint()}
                    >
                      Gửi câu trả lời
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold">Kiểm tra kiến thức</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {ready
                      ? `Đủ điều kiện làm bài · Cần ${policy.passScore} điểm · Đã nộp ${detail.assessment.count} lần${remaining === null ? ' · Không giới hạn' : ' · Còn ' + remaining + ' lần'}`
                      : remaining === 0
                        ? 'Bạn đã dùng hết số lần nộp của phiên bản này.'
                        : waitUntil && waitUntil > assessmentNow
                          ? 'Có thể nộp tiếp từ ' + new Date(waitUntil).toLocaleString('vi-VN')
                          : 'Hoàn thành các điều kiện học đã cấu hình để mở bài kiểm tra.'}
                  </p>
                </div>
                <Button
                  disabled={!ready || busy || !!checkpoint}
                  onClick={() => {
                    control.current?.pause();
                    setMode('quiz');
                    setAnswers({});
                    tabSwitches.current = 0;
                    submitIntent.current = null;
                    setNotice('');
                  }}
                >
                  <ClipboardCheck />
                  Làm bài kiểm tra
                </Button>
              </CardContent>
            </Card>
          </section>
          <aside className="min-w-0 space-y-5" aria-label="Tài liệu và ghi chú">
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={3}>
                  Nội dung khóa học
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="flex items-center gap-2 text-sm">
                  <Play className="size-4 text-primary" aria-hidden="true" />
                  Video · {minutes(detail.spec.duration)}
                </p>
                {detail.spec.checkpoints.map((q) => (
                  <p key={q.id} className="flex items-center gap-2 text-sm">
                    {detail.progress.answeredCheckpoints.includes(q.id) ? (
                      <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <span className="size-4 shrink-0 rounded-full border" aria-hidden="true" />
                    )}
                    <span>
                      {q.title} · {minutes(q.time)}
                    </span>
                  </p>
                ))}
              </CardContent>
            </Card>
            {detail.spec.attachments.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle role="heading" aria-level={3}>
                    Tài liệu bài học
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {detail.spec.attachments.map((file) => (
                    <a
                      key={file.id}
                      href={'/api/lms/media/' + file.mediaId + '?versionId=' + versionId}
                      className="flex min-h-11 items-center gap-2 text-sm text-primary underline underline-offset-4"
                    >
                      <FileText className="size-4 shrink-0" />
                      {file.title}
                    </a>
                  ))}
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={3} className="flex items-center gap-2">
                  <NotebookPen className="size-4" />
                  Ghi chú của tôi
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Label htmlFor="learning-note">Ghi chú tại {minutes(position)}</Label>
                <Textarea
                  id="learning-note"
                  value={note}
                  maxLength={500}
                  placeholder="Điều cần ghi nhớ…"
                  onChange={(event) => setNote(event.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={busy || !note.trim()}
                  onClick={() => void createNote()}
                >
                  <Plus />
                  Thêm ghi chú
                </Button>
                {detail.notes.map((row) => (
                  <div key={row.id} className="rounded-lg bg-secondary p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        variant="link"
                        className="px-0"
                        disabled={manual}
                        onClick={() => control.current?.seek(row.time)}
                      >
                        {minutes(row.time)}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={busy}
                        aria-label={'Xóa ghi chú ' + row.content}
                        onClick={() => void removeNote(row.id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm leading-6">
                      {row.content}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </aside>
        </div>
      )}
      <Dialog
        open={confirmSubmit}
        onOpenChange={(value) => {
          if (!busy) setConfirmSubmit(value);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            const button = submitButton.current;
            if (!button || button.disabled) return;
            event.preventDefault();
            button.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Nộp bài kiểm tra?</DialogTitle>
            <DialogDescription>
              Kết quả được chấm và lưu cùng phiên bản khóa học này. Bạn có thể xem lại từng câu sau
              khi nộp.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmSubmit(false)}>
              Kiểm tra lại
            </Button>
            <Button disabled={busy} onClick={() => void submit()}>
              Xác nhận nộp bài
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={leave} onOpenChange={setLeave}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rời bài kiểm tra chưa nộp?</DialogTitle>
            <DialogDescription>
              Câu trả lời đang nhập chưa được lưu thành kết quả.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeave(false)}>
              Tiếp tục làm bài
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setLeave(false);
                setAnswers({});
                setMode('video');
              }}
            >
              Bỏ câu trả lời
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
