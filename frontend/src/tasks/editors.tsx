import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from '@/lib/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import type {
  ProjectItem,
  ProjectMember,
  ProjectRole,
  TaskDetail,
  TaskInput,
  TaskPerson,
} from '../../../src/tasks/options';
import { getTaskApi, roleLabel } from './api';

const none = 'none';
type Unit = { id: string; name: string; canCreate: boolean };
function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent, action: () => Promise<void>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}
function FormError({ failure }: { failure: unknown }) {
  return failure !== null ? (
    <Alert variant="destructive">
      <AlertDescription>{errorMessage(failure)}</AlertDescription>
    </Alert>
  ) : null;
}

export function ProjectEditor({
  units,
  project,
  close,
  save,
}: {
  units: Unit[];
  project?: ProjectItem | undefined;
  close: () => void;
  save: (input: { unitId: string; name: string; description: string }) => Promise<void>;
}) {
  const [unitId, setUnit] = useState(
    project?.unitId ?? units.find(({ canCreate }) => canCreate)?.id ?? '',
  );
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const { busy, error, submit } = useSave();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[90dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{project ? 'Chỉnh sửa dự án' : 'Tạo dự án'}</DialogTitle>
          <DialogDescription>Thiết lập đơn vị quản lý và nội dung dự án.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => void submit(event, () => save({ unitId, name, description }))}
        >
          <Choice
            label="Đơn vị quản lý"
            value={unitId}
            options={units.filter(({ canCreate, id }) => canCreate || project?.unitId === id)}
            disabled={!!project || busy}
            onChange={setUnit}
          />
          <div className="space-y-2">
            <Label htmlFor="tasks-project-name">Tên dự án</Label>
            <Input
              id="tasks-project-name"
              value={name}
              required
              maxLength={160}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tasks-project-description">Mô tả dự án</Label>
            <Textarea
              id="tasks-project-description"
              value={description}
              rows={4}
              maxLength={5000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <FormError failure={error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Hủy
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !unitId}>
              Lưu dự án
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MemberEditor({
  tenantId,
  projectId,
  member,
  close,
  save,
}: {
  tenantId: string;
  projectId: string;
  member?: ProjectMember | undefined;
  close: () => void;
  save: (input: { accountId: string; role: ProjectRole; active: boolean }) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [people, setPeople] = useState<TaskPerson[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!member);
  const [accountId, setAccount] = useState(member?.accountId ?? '');
  const [role, setRole] = useState<ProjectRole>(member?.role ?? 'member');
  const [active, setActive] = useState(true);
  const { busy, error, submit } = useSave();
  useEffect(() => {
    if (member) return;
    const abort = new AbortController();
    setLoading(true);
    setLoadError(null);
    void getTaskApi<{ items: TaskPerson[] }>(
      tenantId,
      '/projects/' + projectId + '/candidates',
      { search },
      abort.signal,
    )
      .then(({ items }) => {
        if (!abort.signal.aborted) setPeople(items);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setLoadError(failure);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [tenantId, projectId, search, member]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[90dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{member ? 'Quyền thành viên' : 'Thêm thành viên'}</DialogTitle>
          <DialogDescription>
            {member?.name ?? 'Chọn tài khoản từ danh bạ đơn vị.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => void submit(event, () => save({ accountId, role, active }))}
        >
          {!member && (
            <>
              <div className="space-y-2">
                <Label htmlFor="tasks-member-search">Tìm nhân sự</Label>
                <div className="flex gap-2">
                  <Input
                    id="tasks-member-search"
                    maxLength={120}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <Button type="button" variant="outline" onClick={() => setSearch(query.trim())}>
                    Tìm
                  </Button>
                </div>
              </div>
              <Choice
                label="Nhân sự"
                value={accountId}
                options={people.map(({ accountId, name }) => ({ id: accountId, name }))}
                onChange={setAccount}
                disabled={loading}
              />
              {loading && (
                <p role="status" className="text-sm">
                  Đang tải danh bạ…
                </p>
              )}
              <FormError failure={loadError} />
            </>
          )}
          <Choice
            label="Vai trò dự án"
            value={role}
            options={Object.entries(roleLabel).map(([id, name]) => ({ id, name }))}
            onChange={(value) => setRole(value as ProjectRole)}
          />
          {member && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
                className="size-4 accent-primary"
              />{' '}
              Thành viên còn hiệu lực
            </label>
          )}
          <FormError failure={error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Hủy
            </Button>
            <Button type="submit" disabled={busy || !accountId}>
              Lưu thành viên
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TaskEditor({
  detail,
  parent,
  members,
  close,
  save,
}: {
  detail?: TaskDetail | undefined;
  parent?: string | undefined;
  members: ProjectMember[];
  close: () => void;
  save: (input: TaskInput) => Promise<void>;
}) {
  const item = detail?.item;
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [due, setDue] = useState(item?.dueOn ?? '');
  const [remind, setRemind] = useState(
    item?.remindDays === undefined || item.remindDays === null ? none : String(item.remindDays),
  );
  const [assignee, setAssignee] = useState(item?.assignee?.accountId ?? none);
  const [participants, setParticipants] = useState(
    detail?.participants.map(({ accountId }) => accountId) ?? [],
  );
  const { busy, error, submit } = useSave();
  const assignedChoices = members
    .filter((member) => member.role !== 'viewer')
    .map(({ accountId, name }) => ({ id: accountId, name }));
  if (item?.assignee && !assignedChoices.some(({ id }) => id === item.assignee?.accountId))
    assignedChoices.push({ id: item.assignee.accountId, name: item.assignee.name });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[90dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>
            {item ? 'Chỉnh sửa công việc' : parent ? 'Thêm việc con' : 'Tạo công việc'}
          </DialogTitle>
          <DialogDescription>
            Giao người thực hiện, người liên quan và hạn hoàn thành.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) =>
            void submit(event, () =>
              save({
                title,
                description,
                dueOn: due || null,
                remindDays: due && remind !== none ? Number(remind) : null,
                assigneeId: assignee === none ? null : assignee,
                participantIds: participants,
              }),
            )
          }
        >
          <div className="space-y-2">
            <Label htmlFor="tasks-item-title">Tên công việc</Label>
            <Input
              id="tasks-item-title"
              value={title}
              required
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tasks-item-description">Mô tả công việc</Label>
            <Textarea
              id="tasks-item-description"
              value={description}
              rows={4}
              maxLength={10000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tasks-item-due">Hạn hoàn thành</Label>
              <Input
                id="tasks-item-due"
                type="date"
                value={due}
                onChange={(event) => setDue(event.target.value)}
              />
            </div>
            <Choice
              label="Nhắc hạn"
              value={due ? remind : none}
              options={[
                { id: none, name: 'Tắt nhắc hạn' },
                { id: '0', name: 'Trong ngày đến hạn' },
                ...[1, 3, 7].map((n) => ({ id: String(n), name: 'Trước hạn ' + n + ' ngày' })),
              ]}
              disabled={!due}
              onChange={setRemind}
            />
          </div>
          <Choice
            label="Người thực hiện"
            value={assignee}
            options={[{ id: none, name: 'Chưa giao' }, ...assignedChoices]}
            disabled={item?.status === 'done'}
            onChange={setAssignee}
          />
          <fieldset className="rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Người liên quan</legend>
            <div className="grid max-h-52 grid-cols-1 gap-x-3 overflow-auto sm:grid-cols-2">
              {members.map(({ accountId, name }) => (
                <label key={accountId} className="flex min-h-11 min-w-0 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    checked={participants.includes(accountId)}
                    onChange={(event) =>
                      setParticipants(
                        event.target.checked
                          ? [...participants, accountId]
                          : participants.filter((id) => id !== accountId),
                      )
                    }
                  />
                  <span className="break-words">{name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <FormError failure={error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Hủy
            </Button>
            <Button type="submit" disabled={busy || !title.trim() || participants.length > 30}>
              Lưu công việc
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
