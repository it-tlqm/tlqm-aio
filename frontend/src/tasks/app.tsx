import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  BriefcaseBusiness,
  LogOut,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { Brand } from '@/components/brand';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/messages';
import type { Me } from '@/lib/api';
import { parseTaskTarget, taskTarget } from '@/lib/task-target';
import { defaultTaskStages } from '../../../src/tasks/options';
import { Choice } from '../forms/common';
import type {
  ProjectItem,
  ProjectMember,
  TaskDetail,
  TaskItem,
  TaskReport,
  TaskStage,
} from '../../../src/tasks/options';
import { dayLabel, getTaskApi, roleLabel, taskWriter, vietnamTime } from './api';
import { WorkflowEditor } from './workflow-editor';
import { loadTaskView, saveTaskView } from './saved-view';
import { MemberEditor, ProjectEditor, TaskEditor } from './editors';
import { TaskDetailsDialog } from './detail';
import { ProjectReport, TaskBoard, TaskList } from './views';

type Unit = { id: string; name: string; canCreate: boolean };
type ProjectData = { project: ProjectItem; members: ProjectMember[] };
type Items = { items: TaskItem[]; nextAfter: string | null };
type Reminder = {
  id: string;
  projectId: string;
  taskId: string;
  title: string;
  dueOn: string;
  kind: 'due' | 'overdue';
  createdAt: string;
};
type Tab = 'list' | 'board' | 'members' | 'report';
const navHash = () => parseTaskTarget(location.hash);
const tabNames: Record<Tab, string> = {
  list: 'Danh sách',
  board: 'Bảng Kanban',
  members: 'Thành viên',
  report: 'Báo cáo',
};
function ErrorNotice({ error }: { error: unknown }) {
  return error !== null ? (
    <Alert variant="destructive">
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  ) : null;
}

export function TasksApp({
  me,
  logout,
  portalUrl,
}: {
  me: Me;
  logout: () => void | Promise<void>;
  portalUrl: string | undefined;
}) {
  const [tenantId, setTenant] = useState(() => {
    const requested = navHash()?.tenant;
    return me.memberships.find(({ id }) => id === requested)?.id ?? me.memberships[0]?.id ?? '';
  });
  const [section, setSection] = useState<'projects' | 'reminders'>('projects');
  const [projectId, setProjectId] = useState<string | null>(() => navHash()?.project ?? null);
  const [taskId, setTaskId] = useState<string | null>(() => navHash()?.task ?? null);
  const [tab, setTab] = useState<Tab>('list');
  const [units, setUnits] = useState<Unit[]>([]);
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [items, setItems] = useState<Items | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [report, setReport] = useState<TaskReport | null>(null);
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [mine, setMine] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [projectEditor, setProjectEditor] = useState<'new' | ProjectItem | null>(null);
  const [workflowEditor, setWorkflowEditor] = useState<ProjectItem | null>(null);
  const viewScope = useRef('');
  const [memberEditor, setMemberEditor] = useState<'new' | ProjectMember | null>(null);
  const [taskEditor, setTaskEditor] = useState<{ detail?: TaskDetail; parent?: string } | null>(
    null,
  );
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const taskTrigger = useRef<HTMLElement | null>(null);
  const closingTask = useRef(false);
  const write = useMemo(() => taskWriter(tenantId, me.csrfToken), [tenantId, me.csrfToken]);
  const project = projectData?.project;
  const stages = project?.workflow?.stages ?? defaultTaskStages;
  const members = projectData?.members ?? [];
  const filter = JSON.stringify({ search, status, assignee, mine, overdue });
  useEffect(() => {
    const scope = projectId ? tenantId + ':' + projectId : '';
    if (!scope) {
      viewScope.current = '';
      return;
    }
    if (projectData?.project.id !== projectId || viewScope.current === scope) return;
    viewScope.current = scope;
    const view = loadTaskView(me.accountId, tenantId, projectId);
    if (!view) return;
    setTab(view.tab);
    setQuery(view.search);
    setSearch(view.search);
    setStatus(
      (projectData.project.workflow?.stages ?? defaultTaskStages).some(
        ({ code }) => code === view.status,
      )
        ? view.status
        : 'all',
    );
    setAssignee(
      projectData.members.some(({ accountId }) => accountId === view.assignee)
        ? view.assignee
        : 'all',
    );
    setMine(view.mine);
    setOverdue(view.overdue);
    setAfter(null);
  }, [tenantId, projectId, projectData, me.accountId]);
  const update = () => {
    setAfter(null);
    setRefresh((value) => value + 1);
  };
  function showProject(id: string | null, task: string | null = null) {
    viewScope.current = '';
    if (task) taskTrigger.current = null;
    setSection('projects');
    setProjectId(id);
    setProjectData(null);
    setTaskId(task);
    setDetail(null);
    setTab('list');
    setAfter(null);
    setQuery('');
    setSearch('');
    setStatus('all');
    setAssignee('all');
    setMine(false);
    setOverdue(false);
    setError(null);
    setNotice('');
    history.replaceState(null, '', id ? taskTarget(tenantId, id, task) : '#tasks');
  }
  function openTask(id: string | null) {
    closingTask.current = id === null;
    if (id && !taskId)
      taskTrigger.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetail(null);
    setDetailError(null);
    setTaskId(id);
    if (projectId) history.replaceState(null, '', taskTarget(tenantId, projectId, id));
  }
  useEffect(() => {
    const changed = () => {
      const current = navHash();
      if (current?.tenant && me.memberships.some(({ id }) => id === current.tenant))
        setTenant(current.tenant);
      setSection('projects');
      setProjectId(current?.project ?? null);
      setTaskId(current?.task ?? null);
      setTab('list');
      setAfter(null);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [me.memberships]);
  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    void Promise.all([
      getTaskApi<{ units: Unit[] }>(tenantId, '/lookups', {}, abort.signal),
      getTaskApi<{ items: ProjectItem[] }>(tenantId, '/projects', {}, abort.signal),
    ])
      .then(([catalog, result]) => {
        if (!abort.signal.aborted) {
          setUnits(catalog.units);
          setProjects(result.items);
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setProjects([]);
          setUnits([]);
          setError(failure);
        }
      });
    return () => abort.abort();
  }, [tenantId, refresh]);
  useEffect(() => {
    if (!projectId || section !== 'projects') return;
    const abort = new AbortController();
    void getTaskApi<ProjectData>(tenantId, '/projects/' + projectId, {}, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setProjectData(value);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setProjectData(null);
          setError(failure);
        }
      });
    return () => abort.abort();
  }, [tenantId, projectId, section, refresh]);
  useEffect(() => {
    if (!projectId || section !== 'projects' || (tab !== 'list' && tab !== 'board')) return;
    const abort = new AbortController();
    if (!after) setItems(null);
    const active = JSON.parse(filter) as {
      search: string;
      status: string;
      assignee: string;
      overdue: boolean;
      mine: boolean;
    };
    const params = {
      ...(active.search && { search: active.search }),
      ...(active.status !== 'all' && { stageCode: active.status }),
      ...(active.assignee !== 'all' && { assigneeId: active.assignee }),
      ...(active.overdue && { overdue: 'true' }),
      ...(active.mine && { mine: 'true' }),
      ...(after && { after }),
    };
    void getTaskApi<Items>(tenantId, '/projects/' + projectId + '/items', params, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted)
          setItems((previous) =>
            after && previous ? { ...data, items: [...previous.items, ...data.items] } : data,
          );
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setItems(null);
          setError(failure);
        }
      });
    return () => abort.abort();
  }, [tenantId, projectId, section, tab, filter, after, refresh]);
  useEffect(() => {
    if (!taskId || section !== 'projects') return;
    const abort = new AbortController();
    setDetailError(null);
    void getTaskApi<TaskDetail>(tenantId, '/items/' + taskId, {}, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setDetail(data);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setDetail(null);
          setDetailError(failure);
        }
      });
    return () => abort.abort();
  }, [tenantId, taskId, section, refresh]);
  useEffect(() => {
    if (!projectId || tab !== 'report' || section !== 'projects') return;
    const abort = new AbortController();
    setReport(null);
    void getTaskApi<TaskReport>(tenantId, '/projects/' + projectId + '/report', {}, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setReport(data);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure);
      });
    return () => abort.abort();
  }, [tenantId, projectId, tab, section, refresh]);
  useEffect(() => {
    if (section !== 'reminders') return;
    const abort = new AbortController();
    setReminders(null);
    void getTaskApi<{ items: Reminder[] }>(tenantId, '/reminders', {}, abort.signal)
      .then(({ items }) => {
        if (!abort.signal.aborted) setReminders(items);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure);
      });
    return () => abort.abort();
  }, [tenantId, section, refresh]);

  async function archive() {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    try {
      await write(
        '/projects/' + project.id,
        {
          unitId: project.unitId,
          name: project.name,
          description: project.description,
          archived: !project.archived,
          expectedRevision: project.revision,
        },
        project.archived ? 'Mở lại dự án' : 'Lưu trữ dự án',
      );
      update();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function move(item: TaskItem, next: TaskStage) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write(
        '/items/' + item.id + '/progress',
        {
          status: next.phase,
          ...(item.stageCode && { stageCode: next.code }),
          progress:
            next.phase === 'done' ? 100 : next.phase === 'todo' ? 0 : Math.min(item.progress, 99),
          expectedRevision: item.revision,
        },
        'Chuyển trạng thái trên bảng',
      );
      setNotice('Đã cập nhật trạng thái.');
      update();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4 border-b bg-sidebar p-4 lg:min-h-screen lg:border-r lg:border-b-0">
        <Brand module="Công việc" />
        <nav className="flex flex-wrap gap-2 lg:flex-col" aria-label="Điều hướng Công việc">
          <Button
            variant={section === 'projects' ? 'secondary' : 'ghost'}
            className="justify-start"
            onClick={() => showProject(null)}
          >
            <BriefcaseBusiness /> Dự án
          </Button>
          <Button
            variant={section === 'reminders' ? 'secondary' : 'ghost'}
            className="justify-start"
            onClick={() => {
              setSection('reminders');
              setTaskId(null);
              setDetail(null);
              setError(null);
              setNotice('');
              history.replaceState(null, '', '#tasks');
            }}
          >
            <Bell /> Nhắc hạn
          </Button>
        </nav>
        <div className="flex flex-wrap gap-2 lg:mt-auto lg:flex-col">
          <p className="text-sm font-medium">{me.displayName}</p>
          <Button variant="outline" asChild>
            <a href={portalUrl ?? 'http://127.0.0.1:4100/'}>
              Mở Portal <ArrowUpRight />
            </a>
          </Button>
          <Button variant="ghost" onClick={() => void logout()}>
            <LogOut /> Đăng xuất SSO
          </Button>
        </div>
      </aside>
      <main className="min-w-0 space-y-5 p-4 sm:p-7">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">AIO Công việc</p>
            <h1
              ref={pageHeading}
              tabIndex={-1}
              className="break-words text-2xl font-semibold text-[var(--brand-navy)]"
            >
              {section === 'reminders' ? 'Nhắc hạn công việc' : (project?.name ?? 'Dự án')}
            </h1>
          </div>
          {me.memberships.length > 1 && (
            <Choice
              label="Không gian làm việc"
              value={tenantId}
              options={me.memberships.map(({ id, name }) => ({ id, name }))}
              onChange={(id) => {
                setTenant(id);
                setProjects(null);
                setUnits([]);
                showProject(null);
              }}
            />
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              update();
            }}
          >
            <RefreshCw /> Tải lại
          </Button>
        </header>
        <ErrorNotice error={error} />
        {notice && (
          <p role="status" className="text-sm text-[var(--success)]">
            {notice}
          </p>
        )}
        {section === 'reminders' && (
          <Card>
            <CardContent>
              {!reminders && error === null && <p role="status">Đang tải nhắc hạn…</p>}
              {reminders?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Chưa có nhắc hạn trong phạm vi của bạn.
                </p>
              )}
              <ul className="divide-y">
                {reminders?.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="break-words font-medium">{row.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {row.kind === 'overdue' ? 'Quá hạn' : 'Sắp đến hạn'} · {dayLabel(row.dueOn)}
                        {' · '}
                        {vietnamTime.format(new Date(row.createdAt))}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      aria-label={'Mở ' + row.title}
                      onClick={() => showProject(row.projectId, row.taskId)}
                    >
                      Mở công việc
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
        {section === 'projects' && !projectId && (
          <>
            {units.some(({ canCreate }) => canCreate) && (
              <Button onClick={() => setProjectEditor('new')}>
                <Plus /> Tạo dự án
              </Button>
            )}
            {!projects && error === null && <p role="status">Đang tải dự án…</p>}
            {projects?.length === 0 && (
              <p className="text-sm text-muted-foreground">Chưa có dự án trong phạm vi của bạn.</p>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {projects?.map((item) => (
                <Card key={item.id} className="min-w-0 border-t-4 border-t-primary">
                  <CardHeader>
                    <CardTitle className="break-words">{item.name}</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {units.find(({ id }) => id === item.unitId)?.name ?? 'Đơn vị quản lý'}
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {item.description && (
                      <p className="line-clamp-3 break-words text-sm">{item.description}</p>
                    )}
                    {item.archived && <Badge variant="outline">Đã lưu trữ</Badge>}
                    <div>
                      <Button
                        variant="outline"
                        aria-label={'Mở dự án ' + item.name}
                        onClick={() => showProject(item.id)}
                      >
                        Mở dự án
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
        {section === 'projects' && projectId && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => showProject(null)}>
                <ArrowLeft /> Về dự án
              </Button>
              {project?.canManage && (
                <Button variant="outline" onClick={() => setProjectEditor(project)}>
                  Chỉnh sửa dự án
                </Button>
              )}
              {project?.canManage && (
                <Button variant="outline" disabled={busy} onClick={() => void archive()}>
                  {project.archived ? 'Mở lại dự án' : 'Lưu trữ dự án'}
                </Button>
              )}
              {project?.archived && <Badge variant="outline">Đã lưu trữ</Badge>}
              {project?.canManage && !project.archived && (
                <Button variant="outline" onClick={() => setWorkflowEditor(project)}>
                  Trạng thái dự án
                </Button>
              )}
            </div>
            {!project && error === null && <p role="status">Đang tải dự án…</p>}
            {project && (
              <>
                {project.description && (
                  <p className="max-w-3xl break-words whitespace-pre-wrap text-sm text-muted-foreground">
                    {project.description}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <nav className="flex flex-wrap gap-2" aria-label="Chế độ xem dự án">
                    {(Object.keys(tabNames) as Tab[])
                      .filter((key) => key !== 'report' || project.canReport)
                      .map((key) => (
                        <Button
                          key={key}
                          variant={tab === key ? 'secondary' : 'outline'}
                          aria-pressed={tab === key}
                          onClick={() => {
                            setTab(key);
                            setAfter(null);
                            setError(null);
                          }}
                        >
                          {tabNames[key]}
                        </Button>
                      ))}
                  </nav>
                  {project.canCreateTask && (
                    <Button onClick={() => setTaskEditor({})}>
                      <Plus /> Tạo công việc
                    </Button>
                  )}
                </div>
                {(tab === 'list' || tab === 'board') && (
                  <>
                    <Card>
                      <CardContent className="space-y-3">
                        <form
                          className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)]"
                          onSubmit={(event) => {
                            event.preventDefault();
                            setAfter(null);
                            setSearch(query.trim());
                          }}
                        >
                          <div className="space-y-2">
                            <Label htmlFor="tasks-search">Tìm công việc</Label>
                            <Input
                              id="tasks-search"
                              maxLength={120}
                              value={query}
                              onChange={(event) => setQuery(event.target.value)}
                            />
                          </div>
                          <Button type="submit" variant="outline">
                            Tìm
                          </Button>
                          <Choice
                            label="Lọc trạng thái"
                            value={status}
                            options={[
                              { id: 'all', name: 'Tất cả trạng thái' },
                              ...stages.map(({ code, name }) => ({ id: code, name })),
                            ]}
                            onChange={(value) => {
                              setAfter(null);
                              setStatus(value);
                            }}
                          />
                          <Choice
                            label="Lọc người thực hiện"
                            value={assignee}
                            options={[
                              { id: 'all', name: 'Tất cả người thực hiện' },
                              ...members.map(({ accountId, name }) => ({ id: accountId, name })),
                            ]}
                            onChange={(value) => {
                              setAfter(null);
                              setAssignee(value);
                            }}
                          />
                        </form>
                        <div className="flex flex-wrap gap-x-5">
                          <label className="flex min-h-11 items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={mine}
                              className="size-4 accent-primary"
                              onChange={(event) => {
                                setAfter(null);
                                setMine(event.target.checked);
                              }}
                            />{' '}
                            Việc giao cho tôi
                          </label>
                          <Button
                            variant="outline"
                            type="button"
                            onClick={() => {
                              const saved = saveTaskView(me.accountId, tenantId, project.id, {
                                tab,
                                search,
                                status,
                                assignee,
                                mine,
                                overdue,
                              });
                              setNotice(
                                saved
                                  ? 'Đã lưu góc nhìn trên trình duyệt này.'
                                  : 'Không lưu được góc nhìn trên trình duyệt này.',
                              );
                            }}
                          >
                            Lưu góc nhìn
                          </Button>
                          <label className="flex min-h-11 items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={overdue}
                              className="size-4 accent-primary"
                              onChange={(event) => {
                                setAfter(null);
                                setOverdue(event.target.checked);
                              }}
                            />{' '}
                            Chỉ việc quá hạn
                          </label>
                        </div>
                      </CardContent>
                    </Card>
                    {!items && error === null && <p role="status">Đang tải công việc…</p>}
                    {items &&
                      (tab === 'board' ? (
                        <TaskBoard
                          items={items.items}
                          open={openTask}
                          move={(item, next) => void move(item, next)}
                          busy={busy}
                          stages={stages}
                        />
                      ) : items.items.length ? (
                        <TaskList items={items.items} open={openTask} />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Chưa có công việc trong phạm vi này.
                        </p>
                      ))}
                    {items?.nextAfter && (
                      <Button variant="outline" onClick={() => setAfter(items.nextAfter)}>
                        Xem thêm công việc
                      </Button>
                    )}
                  </>
                )}
                {tab === 'members' && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Thành viên dự án</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {project.canManage && !project.archived && (
                        <Button onClick={() => setMemberEditor('new')}>
                          <Plus /> Thêm thành viên
                        </Button>
                      )}
                      <ul className="divide-y">
                        {members.map((member) => (
                          <li
                            key={member.accountId}
                            className="flex flex-wrap items-center justify-between gap-2 py-3"
                          >
                            <div>
                              <p className="font-medium">{member.name}</p>
                              <p className="text-sm text-muted-foreground">
                                {roleLabel[member.role]}
                              </p>
                            </div>
                            {project.canManage &&
                              !project.archived &&
                              member.accountId !== project.ownerAccountId && (
                                <Button
                                  variant="outline"
                                  aria-label={'Quyền của ' + member.name}
                                  onClick={() => setMemberEditor(member)}
                                >
                                  Chỉnh quyền
                                </Button>
                              )}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}
                {tab === 'report' &&
                  project.canReport &&
                  (report ? (
                    <ProjectReport report={report} />
                  ) : (
                    error === null && <p role="status">Đang tải báo cáo…</p>
                  ))}
              </>
            )}
          </>
        )}
      </main>
      {workflowEditor && (
        <WorkflowEditor
          key={workflowEditor.id}
          project={workflowEditor}
          close={() => setWorkflowEditor(null)}
          save={async (workflow, reason) => {
            await write(
              '/projects/' + workflowEditor.id + '/workflow',
              { workflow, expectedRevision: workflowEditor.revision },
              reason,
            );
            setWorkflowEditor(null);
            setStatus('all');
            setNotice('Đã lưu trạng thái dự án.');
            update();
          }}
        />
      )}
      {projectEditor && (
        <ProjectEditor
          units={units}
          project={projectEditor === 'new' ? undefined : projectEditor}
          close={() => setProjectEditor(null)}
          save={async (input) => {
            const old = projectEditor === 'new' ? null : projectEditor;
            const result = await write<{ id: string }>(
              '/projects' + (old ? '/' + old.id : ''),
              { ...input, ...(old && { expectedRevision: old.revision }) },
              old ? 'Cập nhật dự án' : 'Tạo dự án mới',
            );
            setProjectEditor(null);
            showProject(result.id);
            update();
          }}
        />
      )}
      {memberEditor && project && (
        <MemberEditor
          tenantId={tenantId}
          projectId={project.id}
          member={memberEditor === 'new' ? undefined : memberEditor}
          close={() => setMemberEditor(null)}
          save={async (input) => {
            await write(
              '/projects/' + project.id + '/member',
              { ...input, expectedRevision: project.revision },
              input.active ? 'Lưu quyền thành viên' : 'Thu hồi quyền thành viên',
            );
            setMemberEditor(null);
            setNotice('Đã lưu quyền thành viên.');
            update();
          }}
        />
      )}
      {taskEditor && project && (
        <TaskEditor
          detail={taskEditor.detail}
          parent={taskEditor.parent}
          members={members}
          close={() => setTaskEditor(null)}
          save={async (input) => {
            const old = taskEditor.detail?.item;
            const endpoint = old
              ? '/items/' + old.id + '/edit'
              : '/projects/' + project.id + '/items';
            await write(
              endpoint,
              {
                ...input,
                ...(old && { projectId: project.id, expectedRevision: old.revision }),
                ...(taskEditor.parent && { parentId: taskEditor.parent }),
              },
              old ? 'Chỉnh sửa công việc' : 'Giao công việc mới',
            );
            setTaskEditor(null);
            setNotice('Đã lưu công việc.');
            update();
          }}
        />
      )}
      {taskId && !taskEditor && (
        <TaskDetailsDialog
          key={taskId}
          stages={stages}
          detail={detail}
          error={detailError}
          members={members}
          onClose={() => openTask(null)}
          onRestoreFocus={() => {
            if (!closingTask.current) return;
            closingTask.current = false;
            const trigger = taskTrigger.current;
            if (trigger?.isConnected) trigger.focus();
            else pageHeading.current?.focus();
          }}
          onEdit={(value) => setTaskEditor({ detail: value })}
          onChild={(id) => setTaskEditor({ parent: id })}
          onOpen={openTask}
          write={async (path, data, reason) => {
            await write(path, data, reason);
            update();
          }}
        />
      )}
    </div>
  );
}
