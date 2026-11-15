import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errorMessage } from '@/lib/messages';
import { defaultTaskStages, taskStagePattern, taskStatuses } from '../../../src/tasks/options';
import type {
  TaskStatus,
  TaskWorkflow,
  ProjectItem,
  TaskTransition,
} from '../../../src/tasks/options';
import { statusLabel } from './api';

const roles = ['manager', 'member'] as const;
const codePattern = new RegExp(taskStagePattern);
const roleName = { manager: 'Quản trị dự án', member: 'Thành viên' };
const defaults = (): TaskWorkflow => ({
  stages: defaultTaskStages.map((stage) => ({ ...stage })),
  transitions: defaultTaskStages.flatMap(({ code: from }) =>
    defaultTaskStages
      .filter(({ code }) => code !== from)
      .map(({ code: to }) => ({ from, to, roles: [...roles] })),
  ),
});

export function WorkflowEditor({
  project,
  close,
  save,
}: {
  project: ProjectItem;
  close: () => void;
  save: (workflow: TaskWorkflow, reason: string) => Promise<void>;
}) {
  const [workflow, setWorkflow] = useState(() => project.workflow ?? defaults());
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<TaskStatus>('doing');
  const [from, setFrom] = useState('todo');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canAdd =
    code !== 'all' &&
    codePattern.test(code) &&
    !workflow.stages.some((stage) => stage.code === code) &&
    workflow.stages.length < 8;
  const add = () => {
    if (!canAdd) return;
    setWorkflow({ ...workflow, stages: [...workflow.stages, { code, name: '', phase }] });
    setCode('');
  };
  function toggle(to: string, role: TaskTransition['roles'][number]) {
    const current = workflow.transitions.find((edge) => edge.from === from && edge.to === to);
    const selected = current?.roles ?? [];
    const next = selected.includes(role)
      ? selected.filter((value) => value !== role)
      : [...selected, role];
    setWorkflow({
      ...workflow,
      transitions: [
        ...workflow.transitions.filter((edge) => edge !== current),
        ...(next.length ? [{ from, to, roles: next }] : []),
      ],
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Trạng thái dự án</DialogTitle>
          <DialogDescription>
            Đặt tên, thứ tự và quyền chuyển giữa các trạng thái.
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError(null);
            void save(workflow, reason)
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          {error != null && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          <fieldset disabled={busy} className="space-y-3">
            <legend className="mb-2 font-medium">Cột trên bảng</legend>
            {workflow.stages.map((stage, index) => (
              <div key={stage.code} className="rounded border p-2">
                <Label htmlFor={'stage-' + stage.code}>
                  {stage.code} · {statusLabel[stage.phase]}
                </Label>
                <Input
                  id={'stage-' + stage.code}
                  maxLength={60}
                  required
                  value={stage.name}
                  onChange={(event) =>
                    setWorkflow({
                      ...workflow,
                      stages: workflow.stages.map((row) =>
                        row === stage ? { ...row, name: event.target.value } : row,
                      ),
                    })
                  }
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {[-1, 1].map((step) => (
                    <Button
                      key={step}
                      type="button"
                      variant="outline"
                      disabled={index + step < 0 || index + step >= workflow.stages.length}
                      aria-label={(step < 0 ? 'Đưa lên ' : 'Đưa xuống ') + stage.code}
                      onClick={() => {
                        const stages = [...workflow.stages];
                        [stages[index], stages[index + step]] = [
                          stages[index + step]!,
                          stages[index]!,
                        ];
                        setWorkflow({ ...workflow, stages });
                      }}
                    >
                      {step < 0 ? 'Lên' : 'Xuống'}
                    </Button>
                  ))}
                  {!(taskStatuses as readonly string[]).includes(stage.code) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        if (from === stage.code) setFrom('todo');
                        setWorkflow({
                          stages: workflow.stages.filter((row) => row !== stage),
                          transitions: workflow.transitions.filter(
                            (edge) => edge.from !== stage.code && edge.to !== stage.code,
                          ),
                        });
                      }}
                    >
                      Xóa {stage.code}
                    </Button>
                  )}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor="stage-code">Mã cột mới</Label>
                <Input
                  id="stage-code"
                  maxLength={32}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <label className="grid gap-1 text-sm">
                Nhóm trạng thái
                <select
                  className="min-h-10 rounded border px-2"
                  value={phase}
                  onChange={(event) => setPhase(event.target.value as TaskStatus)}
                >
                  {taskStatuses.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel[status]}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="button" variant="outline" disabled={!canAdd} onClick={add}>
                Thêm cột
              </Button>
            </div>
            <label className="grid gap-1 text-sm">
              Chuyển từ
              <select
                className="min-h-10 rounded border px-2"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              >
                {workflow.stages.map((row) => (
                  <option key={row.code} value={row.code}>
                    {row.name || row.code}
                  </option>
                ))}
              </select>
            </label>
            {workflow.stages
              .filter((row) => row.code !== from)
              .map((row) => (
                <fieldset key={row.code} className="rounded border px-2">
                  <legend className="px-1 text-sm">Đến {row.name || row.code}</legend>
                  {roles.map((role) => (
                    <label
                      key={role}
                      className="mr-4 inline-flex min-h-11 items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={workflow.transitions.some(
                          (edge) =>
                            edge.from === from && edge.to === row.code && edge.roles.includes(role),
                        )}
                        onChange={() => toggle(row.code, role)}
                      />
                      {roleName[role]}
                    </label>
                  ))}
                </fieldset>
              ))}
            <Label htmlFor="workflow-reason">Lý do thay đổi</Label>
            <Input
              id="workflow-reason"
              minLength={5}
              maxLength={240}
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </fieldset>
          <Button disabled={busy} type="submit">
            Lưu trạng thái dự án
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
