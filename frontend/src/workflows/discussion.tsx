import { useEffect, useState } from 'react';
import { MessageSquarePlus, Search, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Choice } from '../forms/common';
import type { workflowWrite } from './common';

type Discussion = {
  followers: { id: string; name: string; revision: number; canMention: boolean }[];
  comments: {
    id: string;
    authorName: string;
    body: string;
    createdAt: string;
    mentions: string[];
  }[];
  nextCursor: string | null;
  canManage: boolean;
  canInvite: boolean;
  canComment: boolean;
};
type Candidate = { accountId: string; name: string };
const displayTime = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});

export function DiscussionPanel({
  tenantId,
  runId,
  taskId,
  write,
}: {
  tenantId: string;
  runId: string;
  taskId?: string;
  write: ReturnType<typeof workflowWrite>;
}) {
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const prefix = '/runs/' + runId;
  const scope: Record<string, string> = taskId ? { taskId } : {};
  const query = new URLSearchParams({ tenantId, ...scope }).toString();
  useEffect(() => {
    const controller = new AbortController();
    void api<Discussion>('/api/v1/workflows' + prefix + '/discussion?' + query, {
      signal: controller.signal,
    })
      .then(setDiscussion)
      .catch((err) => {
        if (!controller.signal.aborted) setError(err);
      });
    return () => controller.abort();
  }, [prefix, query]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) setDiscussion(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function load(after?: string) {
    const page = await api<Discussion>(
      '/api/v1/workflows' +
        prefix +
        '/discussion?' +
        new URLSearchParams({ tenantId, ...scope, ...(after && { after }) }),
    );
    setDiscussion((old) => ({
      ...page,
      comments: after && old ? [...old.comments, ...page.comments] : page.comments,
    }));
  }

  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      {Boolean(error) && (
        <Alert variant="destructive" className="xl:col-span-2">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {!discussion && !error && <p role="status">Đang tải trao đổi…</p>}
      {discussion && (
        <>
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Bình luận</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {discussion.canComment && (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(async () => {
                      await write(
                        prefix + '/discussion',
                        { text: body, mentionIds: mentions, ...scope },
                        'Gửi bình luận hồ sơ',
                      );
                      setBody('');
                      setMentions([]);
                      await load();
                    });
                  }}
                >
                  <Label htmlFor="workflow-comment">Nội dung bình luận</Label>
                  <Textarea
                    id="workflow-comment"
                    value={body}
                    maxLength={4000}
                    disabled={busy}
                    onChange={(event) => setBody(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {taskId
                      ? 'Nội dung hiển thị với người có quyền trao đổi tại lần xử lý này.'
                      : 'Người có quyền đọc hồ sơ có thể xem nội dung trao đổi.'}
                  </p>
                  {discussion.followers.some((item) => item.canMention) && (
                    <fieldset className="space-y-1">
                      <legend className="text-sm font-medium">Nhắc tên người theo dõi</legend>
                      {discussion.followers
                        .filter((item) => item.canMention)
                        .map((item) => (
                          <label key={item.id} className="flex min-h-11 min-w-0 items-center gap-2">
                            <Checkbox
                              checked={mentions.includes(item.id)}
                              disabled={
                                busy || (mentions.length >= 10 && !mentions.includes(item.id))
                              }
                              onCheckedChange={(checked) =>
                                setMentions((old) =>
                                  checked ? [...old, item.id] : old.filter((id) => id !== item.id),
                                )
                              }
                            />
                            <span className="min-w-0 break-words">{item.name}</span>
                          </label>
                        ))}
                    </fieldset>
                  )}
                  <Button type="submit" disabled={!body.trim() || busy}>
                    <MessageSquarePlus aria-hidden /> Gửi bình luận
                  </Button>
                </form>
              )}
              {discussion.comments.length ? (
                <ol className="divide-y" aria-label="Danh sách bình luận">
                  {discussion.comments.map((item) => (
                    <li key={item.id} className="space-y-2 py-4 break-words">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <p className="font-semibold">{item.authorName}</p>
                        <time className="text-xs text-muted-foreground" dateTime={item.createdAt}>
                          {displayTime.format(new Date(item.createdAt))}
                        </time>
                      </div>
                      <p className="whitespace-pre-wrap">{item.body}</p>
                      {item.mentions.length > 0 && (
                        <p className="text-sm text-primary">
                          {item.mentions.map((name) => '@' + name).join(', ')}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-muted-foreground">Chưa có bình luận.</p>
              )}
              {discussion.nextCursor && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void perform(() => load(discussion.nextCursor!))}
                >
                  Xem bình luận trước
                </Button>
              )}
            </CardContent>
          </Card>
          <Card className="min-w-0 self-start">
            <CardHeader>
              <CardTitle>Người theo dõi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {discussion.canInvite && (
                <div className="space-y-3">
                  <form
                    className="space-y-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void perform(async () => {
                        setCandidateId('');
                        setCandidates(
                          (
                            await api<{ items: Candidate[] }>(
                              '/api/v1/workflows' +
                                prefix +
                                '/follower-candidates?' +
                                new URLSearchParams({ tenantId, search, ...scope }),
                            )
                          ).items,
                        );
                      });
                    }}
                  >
                    <Label htmlFor="follower-search">Tìm người theo dõi</Label>
                    <div className="flex gap-2">
                      <Input
                        id="follower-search"
                        value={search}
                        maxLength={100}
                        disabled={busy}
                        onChange={(event) => {
                          setSearch(event.target.value);
                          setCandidates(null);
                          setCandidateId('');
                        }}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        type="submit"
                        aria-label="Tìm người"
                        disabled={busy}
                      >
                        <Search aria-hidden />
                      </Button>
                    </div>
                  </form>
                  {candidates?.length ? (
                    <>
                      <Choice
                        label="Người đủ quyền theo dõi"
                        value={candidateId}
                        options={candidates.map((item) => ({
                          id: item.accountId,
                          name: item.name,
                        }))}
                        disabled={busy}
                        onChange={setCandidateId}
                      />
                      <Button
                        variant="outline"
                        disabled={busy || !candidateId}
                        onClick={() =>
                          void perform(async () => {
                            await write(
                              prefix + '/followers',
                              { accountId: candidateId, ...scope },
                              'Thêm người theo dõi hồ sơ',
                            );
                            setCandidateId('');
                            setCandidates(null);
                            await load();
                          })
                        }
                      >
                        <UserPlus aria-hidden /> Thêm người theo dõi
                      </Button>
                    </>
                  ) : (
                    candidates && (
                      <p className="text-muted-foreground">Không tìm thấy người đủ quyền.</p>
                    )
                  )}
                </div>
              )}
              {discussion.followers.length ? (
                <ul className="divide-y" aria-label="Người đang theo dõi">
                  {discussion.followers.map((item) => (
                    <li
                      key={item.id}
                      className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="min-w-0 break-words">{item.name}</span>
                      {discussion.canManage && (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          aria-label={'Bỏ theo dõi cho ' + item.name}
                          onClick={() =>
                            void perform(async () => {
                              await write(
                                prefix + '/followers/remove',
                                { followerId: item.id, expectedRevision: item.revision, ...scope },
                                'Bỏ người theo dõi hồ sơ',
                              );
                              setMentions((old) => old.filter((id) => id !== item.id));
                              await load();
                            })
                          }
                        >
                          Bỏ theo dõi
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">Chưa có người theo dõi.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
