import { Clock3, GripVertical, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { defaultTaskStages, taskStatuses } from '../../../src/tasks/options';
import type { TaskItem, TaskReport, TaskStage } from '../../../src/tasks/options';
import { dayLabel, statusLabel } from './api';

export function TaskStatusBadge({ item }: { item: TaskItem }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge variant={item.status === 'done' ? 'secondary' : 'outline'}>
        {item.stageName ?? statusLabel[item.status]}
      </Badge>
      {item.overdue && <Badge variant="destructive">Quá hạn</Badge>}
    </div>
  );
}

export function TaskList({ items, open }: { items: TaskItem[]; open: (id: string) => void }) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <Table
        containerProps={{ role: 'region', tabIndex: 0, 'aria-label': 'Danh sách công việc' }}
        className="min-w-[620px]"
      >
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Công việc</TableHead>
            <TableHead scope="col">Người thực hiện</TableHead>
            <TableHead scope="col">Hạn hoàn thành</TableHead>
            <TableHead scope="col">Trạng thái</TableHead>
            <TableHead scope="col" className="text-right">
              Tiến độ
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="max-w-72 whitespace-normal">
                <Button
                  variant="link"
                  className="h-auto min-h-11 max-w-full justify-start whitespace-normal break-words px-0 text-left"
                  onClick={() => open(item.id)}
                >
                  {item.title}
                </Button>
                {item.parentId && <p className="text-xs text-muted-foreground">Việc con</p>}
              </TableCell>
              <TableCell className="max-w-44 whitespace-normal">
                {item.assignee?.name ?? 'Chưa giao'}
              </TableCell>
              <TableCell>{dayLabel(item.dueOn)}</TableCell>
              <TableCell>
                <TaskStatusBadge item={item} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{item.progress}%</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export function TaskBoard({
  items,
  open,
  move,
  busy,
  stages = defaultTaskStages,
}: {
  items: TaskItem[];
  open: (id: string) => void;
  move: (item: TaskItem, stage: TaskStage) => void;
  busy: boolean;
  stages?: readonly TaskStage[];
}) {
  const targets = (item: TaskItem) =>
    stages.filter(
      ({ code }) =>
        item.canProgress &&
        code !== (item.stageCode ?? item.status) &&
        (item.allowedStages?.includes(code) ?? true),
    );
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-3"
      aria-label="Bảng công việc"
      role="region"
    >
      {stages.map((stage) => {
        const cards = items.filter((item) => (item.stageCode ?? item.status) === stage.code);
        return (
          <section
            key={stage.code}
            aria-label={stage.name}
            className="min-w-0 rounded-xl border bg-muted/50 p-3"
            onDragOver={(event) => {
              if (!busy && event.dataTransfer.types.includes('text/x-aio-task'))
                event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData('text/x-aio-task');
              const item = items.find((entry) => entry.id === id);
              if (item && targets(item).includes(stage) && !busy) move(item, stage);
            }}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-semibold text-[var(--brand-navy)]">{stage.name}</h3>
              <Badge variant="outline">{cards.length}</Badge>
            </div>
            <ul className="space-y-2">
              {cards.map((item) => (
                <li
                  key={item.id}
                  className="rounded-lg border bg-card p-3 shadow-xs"
                  draggable={targets(item).length > 0 && !busy}
                  onDragStart={(event) => {
                    if (!targets(item).length || busy) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData('text/x-aio-task', item.id);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                >
                  <div className="flex items-center gap-2">
                    {targets(item).length > 0 && (
                      <GripVertical
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                    <Button
                      variant="link"
                      className="h-auto min-h-11 min-w-0 max-w-full justify-start whitespace-normal break-words px-0 text-left"
                      onClick={() => open(item.id)}
                    >
                      {item.title}
                    </Button>
                  </div>
                  {item.parentId && <p className="mb-2 text-xs text-muted-foreground">Việc con</p>}
                  <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <div className="inline-flex items-center gap-1">
                      <dt className="sr-only">Người thực hiện</dt>
                      <UserRound className="size-3.5" aria-hidden="true" />
                      <dd>{item.assignee?.name ?? 'Chưa giao'}</dd>
                    </div>
                    <div className="inline-flex items-center gap-1">
                      <dt className="sr-only">Hạn hoàn thành</dt>
                      <Clock3 className="size-3.5" aria-hidden="true" />
                      <dd>{dayLabel(item.dueOn)}</dd>
                    </div>
                  </dl>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium">{item.progress}%</span>
                    {item.overdue && <Badge variant="destructive">Quá hạn</Badge>}
                  </div>
                </li>
              ))}
            </ul>
            {!cards.length && (
              <p className="py-3 text-sm text-muted-foreground">Chưa có công việc.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function ProjectReport({ report }: { report: TaskReport }) {
  const summaries = [
    ['Tổng công việc', report.total],
    ['Tỷ lệ hoàn thành', report.percentDone + '%'],
    ['Quá hạn', report.overdue],
    ['Hoàn thành đúng hạn', report.completedOnTime],
  ];
  return (
    <div className="space-y-4" role="region" aria-label="Báo cáo dự án">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summaries.map(([title, value]) => (
          <Card key={title}>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tabular-nums text-[var(--brand-navy)]">
                {value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Trạng thái công việc</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {taskStatuses.map((status) => (
              <li key={status} className="space-y-1">
                <div className="flex justify-between gap-2 text-sm">
                  <span>{statusLabel[status]}</span>
                  <span>{report.statuses[status]}</span>
                </div>
                <meter
                  className="h-3 w-full accent-primary"
                  min={0}
                  max={Math.max(1, report.total)}
                  value={report.statuses[status]}
                  aria-label={statusLabel[status]}
                />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Theo người thực hiện</CardTitle>
        </CardHeader>
        <CardContent>
          <Table
            containerProps={{
              role: 'region',
              tabIndex: 0,
              'aria-label': 'Báo cáo theo người thực hiện',
            }}
            className="min-w-[450px]"
          >
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Người thực hiện</TableHead>
                <TableHead scope="col">Tổng</TableHead>
                <TableHead scope="col">Hoàn thành</TableHead>
                <TableHead scope="col">Quá hạn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.people.map((row) => (
                <TableRow key={row.accountId ?? 'unassigned'}>
                  <TableCell>{row.name}</TableCell>
                  <TableCell>{row.total}</TableCell>
                  <TableCell>{row.done}</TableCell>
                  <TableCell>{row.overdue}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
