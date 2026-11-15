import type { WorkflowTask } from './common';
import type { HumanStep } from '../../../src/workflows/contracts';
import type { FormSchema } from '../../../src/forms/contracts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AnswerReadback } from '../forms/renderer';
import type { AttachmentContext } from '../forms/attachment-field';
export function PoolProgress({
  task,
  node,
  form,
  attachmentContext,
}: {
  task: WorkflowTask;
  node?: HumanStep;
  form: FormSchema | null;
  attachmentContext?: AttachmentContext;
}) {
  if (!task.approval_policy) return null;
  const approved = task.members.filter((m) => m.action === 'approve').length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{task.label} · tiến độ duyệt</CardTitle>
        <CardDescription>
          Lần gửi {task.round} · Lần xử lý {task.attempt} ·{' '}
          {task.superseded_by_task_id && 'Đã thay thế · '}
          Đã duyệt {approved}/{task.approval_policy.required} ·{' '}
          {
            { all: 'Tất cả thành viên', any: 'Một người đồng ý', quorum: 'Đủ số người đã chọn' }[
              task.approval_policy.mode
            ]
          }
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {task.members.map((m) => (
            <li key={m.account_id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{m.name}</span>
                <Badge variant="secondary">
                  {m.action
                    ? { approve: 'Đã phê duyệt', reject: 'Đã từ chối', return: 'Đã trả về' }[
                        m.action
                      ]
                    : !m.active
                      ? 'Đã thay thế'
                      : task.status === 'pending'
                        ? 'Chờ quyết định'
                        : 'Không cần xử lý'}
                </Badge>
              </div>
              {m.reason && <p className="whitespace-pre-wrap text-sm">{m.reason}</p>}
              {m.voted_at && (
                <time className="text-xs text-muted-foreground">
                  {new Date(m.voted_at).toLocaleString('vi-VN')}
                </time>
              )}
              {form && m.answers && (
                <AnswerReadback
                  schema={form}
                  answers={m.answers}
                  attachmentContext={attachmentContext}
                />
              )}
            </li>
          ))}
        </ul>
        {task.status === 'pending' && (
          <p className="mt-4 text-sm text-muted-foreground">
            {node?.allowReturn === false
              ? 'Một quyết định từ chối sẽ kết thúc bước hiện tại.'
              : 'Một quyết định từ chối hoặc trả về sẽ kết thúc bước hiện tại.'}{' '}
            Mỗi người chỉ được gửi một quyết định.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
