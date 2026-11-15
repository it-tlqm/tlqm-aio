import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { errorMessage } from '@/lib/messages';
import { Choice } from '../forms/common';
import { defaultTaskStages } from '../../../src/tasks/options';
import type { ProjectMember, TaskDetail, TaskStage } from '../../../src/tasks/options';
import { dayLabel, statusLabel, vietnamTime } from './api';

const historyLabels: Record<string, string> = {
  'task.created': 'Tạo công việc',
  'task.updated': 'Chỉnh sửa',
  'task.progress': 'Cập nhật tiến độ',
  'task.handoff': 'Bàn giao',
  'task.comment': 'Thêm trao đổi',
};
type Change = (path: string, data: Record<string, unknown>, reason: string) => Promise<void>;

function TaskActions({
  detail,
  members,
  mode,
  write,
  close,
  stages,
}: {
  detail: TaskDetail;
  members: ProjectMember[];
  mode: 'progress' | 'handoff';
  write: Change;
  close: () => void;
  stages: readonly TaskStage[];
}) {
  const { item } = detail;
  const [stageCode, setStageCode] = useState(item.stageCode ?? item.status);
  const stage = stages.find(({ code }) => code === stageCode);
  const status = stage?.phase ?? item.status;
  const [progress, setProgress] = useState(item.progress);
  const [assignee, setAssignee] = useState(item.assignee?.accountId ?? 'none');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write(
        '/items/' + item.id + '/' + mode,
        mode === 'progress'
          ? {
              status,
              ...(item.stageCode && { stageCode }),
              progress: status === 'done' ? 100 : status === 'todo' ? 0 : progress,
              expectedRevision: item.revision,
            }
          : { assigneeId: assignee === 'none' ? null : assignee, expectedRevision: item.revision },
        reason,
      );
      close();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4 rounded-md border p-3">
      <h3 className="font-semibold">
        {mode === 'progress' ? 'Cập nhật tiến độ' : 'Bàn giao công việc'}
      </h3>
      {mode === 'progress' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Choice
            label="Trạng thái mới"
            value={stageCode}
            options={stages
              .filter(
                ({ code }) =>
                  code === (item.stageCode ?? item.status) ||
                  (item.allowedStages?.includes(code) ?? true),
              )
              .map(({ code, name }) => ({ id: code, name }))}
            onChange={(value) => {
              setStageCode(value);
              if (stages.find(({ code }) => code === value)?.phase === 'doing' && progress >= 100)
                setProgress(0);
            }}
          />
          {status === 'doing' && (
            <div className="space-y-2">
              <Label htmlFor="tasks-progress">Tiến độ (%)</Label>
              <Input
                id="tasks-progress"
                type="number"
                min={0}
                max={99}
                value={progress}
                onChange={(event) => setProgress(Number(event.target.value))}
              />
            </div>
          )}
        </div>
      ) : (
        <Choice
          label="Người nhận bàn giao"
          value={assignee}
          options={[
            { id: 'none', name: 'Bỏ phân công' },
            ...members
              .filter(({ role }) => role !== 'viewer')
              .map(({ accountId, name }) => ({ id: accountId, name })),
          ]}
          onChange={setAssignee}
        />
      )}
      <div className="space-y-2">
        <Label htmlFor="tasks-change-reason">Lý do</Label>
        <Textarea
          id="tasks-change-reason"
          rows={2}
          maxLength={240}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={close} disabled={busy}>
          Quay lại
        </Button>
        <Button
          type="submit"
          disabled={
            busy ||
            reason.trim().length < 5 ||
            (mode === 'handoff' && assignee === (item.assignee?.accountId ?? 'none'))
          }
        >
          {mode === 'progress' ? 'Lưu tiến độ' : 'Xác nhận bàn giao'}
        </Button>
      </div>
    </form>
  );
}

export function TaskDetailsDialog({
  detail,
  error,
  members,
  onClose,
  onRestoreFocus,
  onEdit,
  onChild,
  onOpen,
  write,
  stages = defaultTaskStages,
}: {
  detail: TaskDetail | null;
  error: unknown;
  members: ProjectMember[];
  onClose: () => void;
  onRestoreFocus: () => void;
  onEdit: (value: TaskDetail) => void;
  onChild: (id: string) => void;
  onOpen: (id: string) => void;
  write: Change;
  stages?: readonly TaskStage[];
}) {
  const [mode, setMode] = useState<'progress' | 'handoff' | null>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [commentError, setCommentError] = useState<unknown>(null);
  const item = detail?.item;
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!item || !comment.trim() || sending) return;
    setSending(true);
    setCommentError(null);
    try {
      await write('/items/' + item.id + '/comment', { body: comment }, 'Trao đổi trong công việc');
      setComment('');
    } catch (failure) {
      setCommentError(failure);
    } finally {
      setSending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !sending) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
        className="max-h-[90dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="break-words">{item?.title ?? 'Chi tiết công việc'}</DialogTitle>
          <DialogDescription>
            {item?.parentId ? 'Việc con' : 'Theo dõi thực hiện và trao đổi'}
          </DialogDescription>
        </DialogHeader>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        )}
        {!detail && error === null && (
          <p role="status" className="text-muted-foreground">
            Đang tải công việc…
          </p>
        )}
        {item && detail && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={item.status === 'done' ? 'secondary' : 'outline'}>
                {item.stageName ?? statusLabel[item.status]}
              </Badge>
              <span className="text-sm font-medium">{item.progress}%</span>
              {item.overdue && <Badge variant="destructive">Quá hạn</Badge>}
            </div>
            <dl className="grid grid-cols-1 gap-3 rounded-md border p-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Người thực hiện</dt>
                <dd>{item.assignee?.name ?? 'Chưa giao'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Hạn hoàn thành</dt>
                <dd>{dayLabel(item.dueOn)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Người giao việc</dt>
                <dd>{item.creator.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Người liên quan</dt>
                <dd className="break-words">
                  {detail.participants.map(({ name }) => name).join(', ') || 'Chưa có'}
                </dd>
              </div>
            </dl>
            {item.description && (
              <p className="break-words whitespace-pre-wrap">{item.description}</p>
            )}
            {mode ? (
              <TaskActions
                key={item.id + ':' + item.revision + ':' + mode}
                detail={detail}
                members={members}
                mode={mode}
                write={write}
                close={() => setMode(null)}
                stages={stages}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {item.canProgress && (
                  <Button onClick={() => setMode('progress')}>Cập nhật tiến độ</Button>
                )}
                {item.canHandoff && (
                  <Button variant="outline" onClick={() => setMode('handoff')}>
                    Bàn giao
                  </Button>
                )}
                {item.canEdit && (
                  <Button variant="outline" onClick={() => onEdit(detail)}>
                    Chỉnh sửa
                  </Button>
                )}
                {item.canProgress && !item.parentId && (
                  <Button variant="outline" onClick={() => onChild(item.id)}>
                    Thêm việc con
                  </Button>
                )}
              </div>
            )}
            {!!detail.children.length && (
              <section className="space-y-2" aria-label="Việc con">
                <h3 className="font-semibold">Việc con</h3>
                <ul className="divide-y rounded-md border">
                  {detail.children.map((child) => (
                    <li
                      key={child.id}
                      className="flex flex-wrap items-center justify-between gap-2 p-2.5"
                    >
                      <Button
                        variant="link"
                        className="max-w-full whitespace-normal break-words"
                        onClick={() => onOpen(child.id)}
                      >
                        {child.title}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {child.stageName ?? statusLabel[child.status]} · {child.progress}%
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="space-y-3" aria-label="Trao đổi">
              <h3 className="font-semibold">Trao đổi</h3>
              {detail.comments.length > 0 && (
                <ul className="divide-y rounded-md border">
                  {detail.comments.map((entry) => (
                    <li key={entry.id} className="space-y-1 p-3">
                      <p className="text-xs text-muted-foreground">
                        {entry.author} · {vietnamTime.format(new Date(entry.createdAt))}
                      </p>
                      <p className="break-words whitespace-pre-wrap">{entry.body}</p>
                    </li>
                  ))}
                </ul>
              )}
              {item.canComment && (
                <form onSubmit={(event) => void send(event)} className="space-y-2">
                  <Label htmlFor="tasks-comment">Nội dung trao đổi</Label>
                  <Textarea
                    id="tasks-comment"
                    value={comment}
                    maxLength={3000}
                    onChange={(event) => setComment(event.target.value)}
                  />
                  {commentError !== null && (
                    <Alert variant="destructive">
                      <AlertDescription>{errorMessage(commentError)}</AlertDescription>
                    </Alert>
                  )}
                  <Button type="submit" variant="outline" disabled={sending || !comment.trim()}>
                    Gửi trao đổi
                  </Button>
                </form>
              )}
            </section>
            {detail.history.length > 0 && (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer font-medium">Lịch sử công việc</summary>
                <ol className="mt-2 divide-y text-sm">
                  {detail.history.map((entry) => (
                    <li key={entry.id} className="space-y-1 py-2">
                      <p className="font-medium">{historyLabels[entry.action] ?? entry.action}</p>
                      {entry.action === 'task.handoff' && (
                        <p>
                          {String(entry.details.from ?? 'Chưa giao')} →{' '}
                          {String(entry.details.to ?? 'Chưa giao')}
                        </p>
                      )}
                      <p className="break-words text-muted-foreground">
                        {entry.actor} · {vietnamTime.format(new Date(entry.occurredAt))} ·{' '}
                        {entry.reason}
                      </p>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={sending} onClick={onClose}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
