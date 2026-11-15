import { useState } from 'react';
import type { Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Choice, useFormsWrite } from './common';
import type { FormDetail, Lookup, Group, Audience } from './common';
import type { ConfirmRequest } from './respond';

export function AudiencePanel({
  detail,
  lookup,
  groups,
  me,
  tenantId,
  confirm,
  onChanged,
}: {
  detail: FormDetail;
  lookup: Lookup;
  groups: Group[];
  me: Me;
  tenantId: string;
  confirm: (request: ConfirmRequest) => void;
  onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(
    detail.audiences.map((audience) => audience.kind + ':' + audience.target_id),
  );
  const [opensAt, setOpensAt] = useState(
    detail.audiences[0]?.opens_at?.slice(0, 16) ?? new Date().toISOString().slice(0, 16),
  );
  const [closesAt, setClosesAt] = useState(detail.audiences[0]?.closes_at?.slice(0, 16) ?? '');
  const write = useFormsWrite(me, tenantId);
  const toggle = (key: string, checked: boolean) =>
    setSelected((old) => (checked ? [...old, key] : old.filter((value) => value !== key)));
  return (
    <div className="space-y-5">
      <Alert>
        <AlertDescription>
          Người nhận vẫn cần quyền vào ứng dụng và quyền trả lời. Việc giao biểu mẫu không cấp thêm
          quyền nền tảng.
        </AlertDescription>
      </Alert>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="audience-open">Mở nhận phiếu (UTC)</Label>
          <Input
            id="audience-open"
            type="datetime-local"
            value={opensAt}
            onChange={(event) => setOpensAt(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audience-close">Đóng nhận phiếu (UTC, không bắt buộc)</Label>
          <Input
            id="audience-close"
            type="datetime-local"
            value={closesAt}
            onChange={(event) => setClosesAt(event.target.value)}
          />
        </div>
      </div>
      {(
        [
          { kind: 'unit', name: 'Đơn vị', rows: lookup.units },
          { kind: 'account', name: 'Người nhận cụ thể', rows: lookup.accounts },
          {
            kind: 'group',
            name: 'Nhóm nhận biểu mẫu',
            rows: groups.filter((group) => group.active),
          },
        ] as const
      ).map((group) => (
        <Card key={group.kind}>
          <CardHeader>
            <CardTitle>{group.name}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {!group.rows.length && (
              <p className="text-sm text-muted-foreground">Chưa có lựa chọn trong phạm vi.</p>
            )}
            {group.rows.map((row) => (
              <Label
                className="flex min-h-11 items-center gap-4 rounded-md border p-3"
                key={row.id}
                htmlFor={group.kind + row.id}
              >
                <Checkbox
                  id={group.kind + row.id}
                  checked={selected.includes(group.kind + ':' + row.id)}
                  onCheckedChange={(checked) => toggle(group.kind + ':' + row.id, checked === true)}
                />
                {row.name}
              </Label>
            ))}
          </CardContent>
        </Card>
      ))}
      <Button
        disabled={!opensAt}
        onClick={() =>
          confirm({
            title: 'Cập nhật người nhận biểu mẫu?',
            description: `Danh sách sẽ được thay bằng ${selected.length} lựa chọn hiện tại. Người bị bỏ khỏi danh sách không thể gửi phiếu mới.`,
            action: async (reason) => {
              const audiences: Audience[] = selected.map((value) => ({
                kind: value.split(':')[0] as Audience['kind'],
                targetId: value.split(':')[1]!,
                opensAt: new Date(opensAt + ':00Z').toISOString(),
                closesAt: closesAt ? new Date(closesAt + ':00Z').toISOString() : null,
              }));
              await write(
                '/' + detail.form.id + '/audience',
                { expectedRevision: detail.form.revision, audiences },
                reason,
              );
              await onChanged();
            },
          })
        }
      >
        Lưu người nhận
      </Button>
    </div>
  );
}
export function GroupsPanel({
  groups,
  lookup,
  me,
  tenantId,
  confirm,
  onChanged,
}: {
  groups: Group[];
  lookup: Lookup;
  me: Me;
  tenantId: string;
  confirm: (request: ConfirmRequest) => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Group | null>(null),
    [name, setName] = useState(''),
    [unit, setUnit] = useState('_all'),
    [members, setMembers] = useState<string[]>([]),
    [active, setActive] = useState(true),
    [creating, setCreating] = useState(false);
  const write = useFormsWrite(me, tenantId);
  const start = (group: Group | null) => {
    setEditing(group);
    setName(group?.name ?? '');
    setUnit(group?.org_unit_id ?? '_all');
    setMembers(group?.account_ids ?? []);
    setActive(group?.active ?? true);
    setCreating(true);
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-[var(--brand-navy)]">Nhóm nhận biểu mẫu</h2>
        <Button onClick={() => start(null)}>Tạo nhóm nhận</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Nhóm dùng để giao biểu mẫu, không thay đổi cơ cấu tổ chức hoặc vai trò ứng dụng.
      </p>
      {creating && (
        <Card>
          <CardHeader>
            <CardTitle>{editing ? 'Chỉnh sửa nhóm' : 'Nhóm mới'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="group-name">Tên nhóm</Label>
              <Input
                id="group-name"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Choice
              label="Phạm vi nhóm"
              name="group-unit"
              value={unit}
              disabled={!!editing}
              onChange={setUnit}
              options={[{ id: '_all', name: 'Toàn không gian được quản lý' }, ...lookup.units]}
            />
            <Label className="flex min-h-11 items-center gap-4" htmlFor="group-active">
              <Checkbox
                id="group-active"
                checked={active}
                onCheckedChange={(checked) => setActive(checked === true)}
              />
              Đang hoạt động
            </Label>
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="mb-3 font-medium">Thành viên</legend>
              {lookup.accounts.map((account) => (
                <Label
                  className="flex min-h-11 items-center gap-4 rounded border p-3"
                  key={account.id}
                  htmlFor={'member-' + account.id}
                >
                  <Checkbox
                    id={'member-' + account.id}
                    checked={members.includes(account.id)}
                    onCheckedChange={(checked) =>
                      setMembers((old) =>
                        checked ? [...old, account.id] : old.filter((id) => id !== account.id),
                      )
                    }
                  />
                  {account.name}
                </Label>
              ))}
            </fieldset>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setCreating(false)}>
                Hủy chỉnh sửa
              </Button>
              <Button
                disabled={!name.trim()}
                onClick={() =>
                  confirm({
                    title: 'Lưu nhóm nhận biểu mẫu?',
                    description:
                      'Thay đổi thành viên có hiệu lực với các biểu mẫu đang giao cho nhóm này.',
                    action: async (reason) => {
                      await write(
                        '/groups' + (editing ? '/' + editing.id : ''),
                        {
                          name,
                          orgUnitId: unit === '_all' ? null : unit,
                          accountIds: members,
                          active,
                          ...(editing ? { expectedRevision: editing.revision } : {}),
                        },
                        reason,
                        editing ? 'PATCH' : 'POST',
                      );
                      setCreating(false);
                      await onChanged();
                    },
                  })
                }
              >
                Lưu nhóm nhận
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map((group) => (
          <Card key={group.id}>
            <CardHeader>
              <CardTitle>{group.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
                {group.active ? 'Đang hoạt động' : 'Đã dừng'} · {group.account_ids.length} thành
                viên
              </p>
              <Button variant="outline" onClick={() => start(group)}>
                Chỉnh sửa nhóm
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      {!groups.length && !creating && (
        <p className="rounded-lg border bg-card p-6 text-muted-foreground">
          Chưa có nhóm nhận biểu mẫu.
        </p>
      )}
    </div>
  );
}
