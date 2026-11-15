import { useState } from 'react';
import { Plus, Users, RefreshCw } from 'lucide-react';
import type { Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { can, Choice, formError } from '../forms/common';
import type { WorkflowGroup, WorkflowLookup, workflowWrite } from './common';
export function WorkflowGroups({
  groups,
  lookup,
  me,
  tenantId,
  write,
  onChanged,
}: {
  groups: WorkflowGroup[];
  lookup: WorkflowLookup;
  me: Me;
  tenantId: string;
  write: ReturnType<typeof workflowWrite>;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<WorkflowGroup | null>(null),
    [name, setName] = useState(''),
    [unit, setUnit] = useState('_all'),
    [active, setActive] = useState(true),
    [members, setMembers] = useState<string[]>([]),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const unitOptions = [
    ...(can(me, tenantId, 'workflows:manage', null)
      ? [{ id: '_all', name: 'Toàn không gian' }]
      : []),
    ...lookup.units.filter((unit) => can(me, tenantId, 'workflows:manage', unit.id)),
  ];
  const candidates = lookup.accounts.filter(
    (account) => unit === '_all' || account.unitIds.includes(unit),
  );
  const missing = members.filter((id) => !candidates.some((candidate) => candidate.id === id));
  function edit(group: WorkflowGroup | null) {
    setEditing(group);
    setName(group?.name ?? '');
    setUnit(group ? (group.org_unit_id ?? '_all') : (unitOptions[0]?.id ?? ''));
    setActive(group?.active ?? true);
    setMembers(group?.account_ids ?? []);
    setReason('');
    setError(null);
    setOpen(true);
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Nhóm giới hạn người có thể nhận nhiệm vụ. Thành viên vẫn cần quyền xử lý trong ứng dụng và
          đơn vị tương ứng.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void onChanged().catch(setError)}>
            <RefreshCw />
            Tải lại nhóm
          </Button>
          <Button onClick={() => edit(null)}>
            <Plus />
            Tạo nhóm xử lý
          </Button>
        </div>
      </div>
      {error && !open ? (
        <Alert variant="destructive">
          <AlertDescription>{formError(error)}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <Card key={group.id}>
            <CardHeader>
              <div className="mb-2 flex items-center justify-between">
                <Users className="size-5 text-primary" />
                <Badge variant="outline">{group.active ? 'Đang sử dụng' : 'Đã ngừng'}</Badge>
              </div>
              <CardTitle>{group.name}</CardTitle>
              <CardDescription>
                {lookup.units.find((unit) => unit.id === group.org_unit_id)?.name ??
                  'Toàn không gian'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {group.account_ids
                  ? group.account_ids.length + ' thành viên'
                  : 'Nhóm tham chiếu trong phạm vi'}
              </p>
              {group.canManage && (
                <Button variant="outline" onClick={() => edit(group)}>
                  Sửa nhóm
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {!groups.length && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Chưa có nhóm xử lý. Tạo nhóm để người gửi chọn người nhận đúng phạm vi.
          </CardContent>
        </Card>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Sửa nhóm xử lý' : 'Tạo nhóm xử lý'}</DialogTitle>
            <DialogDescription>
              Việc bỏ thành viên hoặc ngừng nhóm có hiệu lực với các nhiệm vụ đang mở. Lịch sử vẫn
              được giữ.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="workflow-group-name">Tên nhóm</Label>
            <Input
              id="workflow-group-name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Choice
            label="Phạm vi nhóm"
            value={unit}
            disabled={!!editing}
            options={unitOptions}
            onChange={(value) => {
              setUnit(value);
              setMembers([]);
            }}
          />
          <label className="flex min-h-11 items-center gap-3">
            <Checkbox checked={active} onCheckedChange={(value) => setActive(value === true)} />
            Đang sử dụng nhóm
          </label>
          <fieldset className="space-y-2">
            <legend className="mb-2 font-medium">Thành viên được chọn</legend>
            {candidates.map((account) => (
              <label key={account.id} className="flex min-h-11 items-center gap-3">
                <Checkbox
                  checked={members.includes(account.id)}
                  onCheckedChange={(value) =>
                    setMembers((old) =>
                      value ? [...old, account.id] : old.filter((id) => id !== account.id),
                    )
                  }
                />
                {account.name}
              </label>
            ))}
            {missing.map((id) => (
              <label
                key={id}
                className="flex min-h-11 items-center gap-3 text-sm text-muted-foreground"
              >
                <Checkbox
                  checked
                  onCheckedChange={() => setMembers((old) => old.filter((value) => value !== id))}
                />
                Tài khoản {id.slice(0, 8)} · không còn sẵn sàng
              </label>
            ))}
            {!candidates.length && (
              <p className="text-sm text-muted-foreground">
                Chưa có người đủ quyền xử lý trong phạm vi này.
              </p>
            )}
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="workflow-group-reason">Lý do thay đổi nhóm</Label>
            <Textarea
              id="workflow-group-reason"
              maxLength={240}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {Boolean(error) && (
            <Alert variant="destructive">
              <AlertDescription>{formError(error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Quay lại
            </Button>
            <Button
              disabled={busy || !name.trim() || reason.trim().length < 5 || !unit}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await write(
                    '/groups' + (editing ? '/' + editing.id : ''),
                    {
                      name,
                      orgUnitId: unit === '_all' ? null : unit,
                      active,
                      accountIds: members,
                      ...(editing ? { expectedRevision: editing.revision } : {}),
                    },
                    reason,
                  );
                  await onChanged();
                  setOpen(false);
                } catch (error) {
                  setError(error);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Lưu nhóm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
