import { Checkbox } from '@/components/ui/checkbox';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { Node, NodeProps, Connection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  GitBranch,
  CheckCheck,
  ClipboardCheck,
  Play,
  Flag,
  Plus,
  Trash2,
  LayoutGrid,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Choice, emptySchema } from '../forms/common';
import { getAutoLayoutedElements } from './bos-layout';
import { WorkflowConditionEditor } from './condition-editor';
import type { WorkflowSpec, WorkflowNode, HumanStep } from '../../../src/workflows/contracts';
import {
  nextSteps,
  previousAssigneeSteps,
  workflowConditionFields,
  workflowBranchFields,
} from '../../../src/workflows/contracts';
import { schemaFields } from '../../../src/forms/contracts';
import type { WorkflowLookup } from './common';
type VisualNode = Node<{
  label: string;
  kind: WorkflowNode['kind'];
  assignee: string;
  active: boolean;
  branches: number;
}>;
const addableSteps = {
  approval: 'Phê duyệt',
  task: 'Thực hiện',
  condition: 'Điều kiện',
  parallel: 'Song song',
} as const;
type AddableStep = keyof typeof addableSteps;
const icons = {
  start: Play,
  approval: CheckCheck,
  task: ClipboardCheck,
  condition: GitBranch,
  parallel: GitBranch,
  join: CheckCheck,
  end: Flag,
};
function StepNode({ data, selected }: NodeProps<VisualNode>) {
  const Icon = icons[data.kind];
  return (
    <div
      className={
        'workflow-node rounded-xl border-2 bg-card p-4 shadow-sm ' +
        (data.active ? 'border-primary' : selected ? 'border-[var(--brand-navy)]' : 'border-border')
      }
    >
      <Handle type="target" position={Position.Top} isConnectable={data.kind !== 'start'} />
      <div className="flex items-start gap-3">
        <span className="rounded-md bg-secondary p-2">
          <Icon className="size-5 text-[var(--brand-navy)]" />
        </span>
        <div>
          <p className="font-semibold text-foreground">{data.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {data.assignee ||
              (
                {
                  start: 'Biểu mẫu khởi tạo',
                  end: 'Kết thúc lượt chạy',
                  condition: 'Điều kiện từ dữ liệu',
                  parallel: 'Mở ' + data.branches + ' nhánh',
                  join: 'Chờ đủ nhánh',
                  approval: 'Chọn người phê duyệt',
                  task: 'Chọn người thực hiện',
                } as Record<string, string>
              )[data.kind]}
          </p>
        </div>
      </div>
      {data.kind === 'condition' ? (
        <>
          <Handle id="yes" type="source" position={Position.Bottom} className="left-[30%]!" />
          <Handle id="no" type="source" position={Position.Bottom} className="left-[70%]!" />
          <p className="mt-3 flex justify-around text-xs text-muted-foreground">
            <span>Đúng</span>
            <span>Sai</span>
          </p>
        </>
      ) : data.kind === 'parallel' ? (
        Array.from({ length: data.branches }, (_, index) => (
          <Handle
            key={index}
            id={'branch-' + index}
            type="source"
            position={Position.Bottom}
            style={{ left: ((index + 1) / (data.branches + 1)) * 100 + '%' }}
          />
        ))
      ) : data.kind !== 'end' ? (
        <Handle id="next" type="source" position={Position.Bottom} />
      ) : null}
    </div>
  );
}
const nodeTypes = { step: StepNode };
function Canvas({
  spec,
  onChange,
  lookup,
  readOnly = false,
  activeStep,
  onEditForm,
}: {
  spec: WorkflowSpec;
  onChange: (spec: WorkflowSpec) => void;
  lookup: WorkflowLookup;
  readOnly?: boolean;
  activeStep?: string | null;
  onEditForm?: (id: string) => void;
}) {
  const [selected, setSelected] = useState(spec.nodes[0]?.id ?? '');
  const [nodes, setNodes, onNodesChange] = useNodesState<VisualNode>([]);
  const flow = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = '';
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      const size = `${Math.round(entry.contentRect.width)}:${Math.round(entry.contentRect.height)}`;
      if (size === previous) return;
      previous = size;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void flow.fitView({ padding: 0.2, duration: 0 });
      }, 120);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [flow]);
  const edges = useMemo(
    () =>
      spec.nodes.flatMap((node) =>
        nextSteps(node)
          .map((target, index) => ({
            id: node.id + '-' + index,
            source: node.id,
            target,
            sourceHandle:
              node.kind === 'condition'
                ? index === 0
                  ? 'yes'
                  : 'no'
                : node.kind === 'parallel'
                  ? 'branch-' + index
                  : 'next',
            label:
              node.kind === 'condition'
                ? index === 0
                  ? 'Đúng'
                  : 'Sai'
                : node.kind === 'parallel'
                  ? 'Nhánh ' + (index + 1)
                  : node.kind === 'approval' && node.rejectNext
                    ? index === 0
                      ? 'Phê duyệt'
                      : 'Từ chối'
                    : undefined,
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: '#223873', strokeWidth: 2 },
          }))
          .filter((edge) => spec.nodes.some((item) => item.id === edge.target)),
      ),
    [spec],
  );
  useEffect(() => {
    const prepared: VisualNode[] = spec.nodes.map((node, index) => ({
      id: node.id,
      type: 'step',
      position: spec.positions[node.id] ?? { x: 0, y: index * 200 },
      selected: node.id === selected,
      data: {
        label: node.label,
        kind: node.kind,
        active: node.id === activeStep,
        branches: node.kind === 'parallel' ? node.branches.length : 0,
        assignee:
          'assignee' in node
            ? node.assigneeRule?.kind === 'pool'
              ? 'Nhóm phê duyệt · ' +
                { all: 'tất cả', any: 'một người', quorum: 'đủ số người' }[node.assigneeRule.mode]
              : node.assigneeRule?.kind === 'group'
                ? 'Chọn trong nhóm ' +
                  (lookup.groups?.find(
                    (group) =>
                      node.assigneeRule?.kind === 'group' && group.id === node.assigneeRule.groupId,
                  )?.name ?? 'đã cấu hình')
                : node.assigneeRule?.kind === 'previous'
                  ? 'Theo bước ' +
                    (spec.nodes.find(
                      (step) =>
                        node.assigneeRule?.kind === 'previous' &&
                        step.id === node.assigneeRule.stepId,
                    )?.label ?? 'trước')
                  : node.assigneeRule?.kind === 'organization'
                    ? node.assigneeRule.relation === 'manager'
                      ? 'Quản lý trực tiếp'
                      : 'Trưởng đơn vị'
                    : (lookup.accounts.find((account) => account.id === node.assignee)?.name ?? '')
            : '',
      },
    }));
    setNodes(
      Object.keys(spec.positions).length
        ? prepared
        : (getAutoLayoutedElements(prepared, edges).nodes as VisualNode[]),
    );
  }, [spec, selected, activeStep, lookup, edges, setNodes]);
  const update = (id: string, patch: Partial<WorkflowNode>) =>
    onChange({
      ...spec,
      schemaVersion:
        'reassignRoles' in patch ||
        'rejectNext' in patch ||
        ('returnMode' in patch && patch.returnMode !== undefined) ||
        ('rejectReturnMode' in patch && patch.rejectReturnMode !== undefined) ||
        ('assigneeRule' in patch &&
          patch.assigneeRule?.kind === 'group' &&
          patch.assigneeRule.selectionTiming)
          ? 5
          : spec.schemaVersion < 4 &&
              ['deadlineMinutes', 'deadlineMode', 'allowReturn'].some((key) => key in patch)
            ? 4
            : spec.schemaVersion,
      nodes: spec.nodes.map((node) => {
        if (node.id !== id) return node;
        const next = { ...node, ...patch } as WorkflowNode;
        if ('form' in next && next.assigneeRule?.kind !== 'group') delete next.reassignRoles;
        return next;
      }),
    });
  const connect = (connection: Connection) => {
    if (readOnly || !connection.source || !connection.target) return;
    const node = spec.nodes.find((node) => node.id === connection.source);
    if (node?.kind === 'condition')
      update(node.id, { [connection.sourceHandle === 'no' ? 'no' : 'yes']: connection.target });
    else if (node?.kind === 'parallel') {
      const index = Number(connection.sourceHandle?.replace(/^branch-/, ''));
      if (Number.isInteger(index) && index >= 0 && index < node.branches.length)
        update(node.id, {
          branches: node.branches.map((target, lane) =>
            lane === index ? connection.target! : target,
          ),
        });
    } else if (node && 'next' in node) update(node.id, { next: connection.target });
  };
  const add = useCallback(
    (kind: AddableStep, position?: { x: number; y: number }) => {
      const id = 'step_' + crypto.randomUUID().slice(0, 8),
        first = workflowConditionFields(spec.input)[0]!;
      const node: WorkflowNode =
        kind === 'parallel'
          ? { id, kind, label: 'Xử lý song song', branches: ['', ''], join: id + '_join' }
          : kind === 'condition'
            ? {
                id,
                kind,
                label: 'Điều kiện mới',
                condition: {
                  schemaVersion: 1,
                  logicalOperator: 'AND',
                  rules: [{ fieldCode: first.id, operator: 'IS_NOT_EMPTY' }],
                },
                yes: '',
                no: '',
              }
            : {
                id,
                kind,
                label: kind === 'approval' ? 'Phê duyệt mới' : 'Thực hiện mới',
                assignee: '',
                dueHours: 24,
                next: '',
                form: null,
              };
      const at = position ?? { x: 400, y: spec.nodes.length * 100 };
      const join: WorkflowNode | null =
        node.kind === 'parallel'
          ? { id: node.join, kind: 'join', label: 'Hợp các nhánh', next: '' }
          : null;
      onChange({
        ...spec,
        schemaVersion: join ? 5 : spec.schemaVersion,
        nodes: join ? [...spec.nodes, node, join] : [...spec.nodes, node],
        positions: {
          ...Object.fromEntries(nodes.map((node) => [node.id, node.position])),
          [id]: at,
          ...(join && { [join.id]: { x: at.x, y: at.y + 360 } }),
        },
      });
      setSelected(id);
    },
    [spec, onChange, nodes],
  );
  const node = spec.nodes.find((node) => node.id === selected),
    targets = spec.nodes
      .filter((item) => item.id !== node?.id && item.kind !== 'start')
      .map((item) => ({ id: item.id, name: item.label }));
  const branch = node?.kind === 'condition' ? node : null;
  return (
    <div className={'grid gap-5 ' + (!readOnly ? 'xl:grid-cols-[minmax(0,1fr)_300px]' : '')}>
      <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
          <div className="flex flex-wrap gap-2">
            {!readOnly &&
              (Object.keys(addableSteps) as AddableStep[]).map((kind) => (
                <Button
                  key={kind}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('application/aio-step', kind)}
                  variant="outline"
                  onClick={() => add(kind)}
                >
                  <Plus className="size-4" />
                  {addableSteps[kind]}
                </Button>
              ))}
          </div>
          <Button
            variant="ghost"
            aria-label="Tự sắp xếp sơ đồ"
            onClick={() => {
              const laid = getAutoLayoutedElements(nodes, edges);
              if (readOnly) setNodes(laid.nodes as VisualNode[]);
              else
                onChange({
                  ...spec,
                  positions: Object.fromEntries(laid.nodes.map((node) => [node.id, node.position])),
                });
              void flow.fitView({ duration: 250 });
            }}
          >
            <LayoutGrid />
            Sắp xếp
          </Button>
        </div>
        <div
          ref={canvas}
          className="h-[560px] lg:h-[700px]"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(event) => {
            event.preventDefault();
            const kind = event.dataTransfer.getData('application/aio-step');
            if (!readOnly && Object.hasOwn(addableSteps, kind))
              add(
                kind as AddableStep,
                flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              );
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={connect}
            onNodeClick={(_, node) => setSelected(node.id)}
            onNodeDragStop={(_, node) => {
              if (!readOnly)
                onChange({
                  ...spec,
                  positions: Object.fromEntries(
                    nodes.map((item) => [
                      item.id,
                      item.id === node.id ? node.position : item.position,
                    ]),
                  ),
                });
            }}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            deleteKeyCode={null}
            fitView
            minZoom={0.3}
            maxZoom={1.5}
            aria-label="Sơ đồ quy trình"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} color="#E3E8EF" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
      {!readOnly && node && (
        <Card className="max-h-[850px] overflow-y-auto" data-workflow-properties>
          <CardHeader>
            <CardTitle>Cấu hình bước</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Choice
              label="Bước đang cấu hình"
              value={selected}
              onChange={(id) => {
                setSelected(id);
                void flow.fitView({ nodes: [{ id }], minZoom: 0.9, maxZoom: 1, duration: 200 });
              }}
              options={spec.nodes.map((node) => ({ id: node.id, name: node.label }))}
            />
            <div className="space-y-2">
              <Label htmlFor="step-label">Tên bước</Label>
              <Input
                id="step-label"
                value={node.label}
                onChange={(event) => update(node.id, { label: event.target.value })}
              />
            </div>
            {(node.kind === 'approval' || node.kind === 'task') && (
              <>
                <Choice
                  label="Cách giao nhiệm vụ"
                  value={node.assigneeRule?.kind ?? 'account'}
                  onChange={(kind) => {
                    const next = { ...node, assignee: '', assigneeRule: undefined } as typeof node;
                    if (kind !== 'group') delete next.reassignRoles;
                    if (kind === 'pool')
                      next.assigneeRule = { kind: 'pool', groupId: '', mode: 'all' };
                    if (kind === 'group') next.assigneeRule = { kind: 'group', groupId: '' };
                    if (kind === 'previous') next.assigneeRule = { kind: 'previous', stepId: '' };
                    if (kind === 'organization')
                      next.assigneeRule = { kind: 'organization', relation: 'manager' };
                    onChange({
                      ...spec,
                      schemaVersion:
                        spec.schemaVersion === 5
                          ? 5
                          : kind === 'pool' || spec.schemaVersion === 4
                            ? 4
                            : kind === 'organization' || spec.schemaVersion === 3
                              ? 3
                              : 2,
                      nodes: spec.nodes.map((item) => (item.id === node.id ? next : item)),
                    });
                  }}
                  options={[
                    { id: 'account', name: 'Người cố định' },
                    ...(node.kind === 'approval'
                      ? [{ id: 'pool', name: 'Nhiều người cùng phê duyệt' }]
                      : []),
                    { id: 'group', name: 'Chọn người trong nhóm' },
                    { id: 'previous', name: 'Người đã xử lý bước trước' },
                    { id: 'organization', name: 'Theo cơ cấu tổ chức' },
                  ]}
                />
                {!node.assigneeRule && (
                  <Choice
                    label="Người xử lý"
                    value={node.assignee || '_none'}
                    onChange={(value) =>
                      update(node.id, { assignee: value === '_none' ? '' : value })
                    }
                    options={[{ id: '_none', name: 'Chọn người xử lý' }, ...lookup.accounts]}
                  />
                )}
                {node.assigneeRule?.kind === 'organization' && (
                  <>
                    <Choice
                      label="Người phụ trách"
                      value={node.assigneeRule.relation}
                      onChange={(value) =>
                        update(node.id, {
                          assigneeRule: {
                            kind: 'organization',
                            relation: value as 'manager' | 'unit-head',
                          },
                        })
                      }
                      options={[
                        { id: 'manager', name: 'Quản lý trực tiếp của người gửi' },
                        { id: 'unit-head', name: 'Trưởng đơn vị của người gửi' },
                      ]}
                    />
                    <p className="text-xs text-muted-foreground">
                      Xác định khi đến bước, theo đơn vị lượt chạy. Ưu tiên người thay thế còn hiệu
                      lực; người nhận phải có quyền xử lý. Không tự duyệt hoặc tự cấp quyền.
                    </p>
                  </>
                )}
                {node.assigneeRule?.kind === 'group' && (
                  <>
                    <Choice
                      label="Nhóm xử lý"
                      value={node.assigneeRule.groupId || '_none'}
                      onChange={(value) =>
                        update(node.id, {
                          assigneeRule: {
                            kind: 'group',
                            selectionTiming:
                              node.assigneeRule?.kind === 'group'
                                ? node.assigneeRule.selectionTiming
                                : undefined,
                            groupId: value === '_none' ? '' : value,
                          },
                        })
                      }
                      options={[
                        { id: '_none', name: 'Chọn nhóm' },
                        ...(lookup.groups ?? []).map((group) => ({
                          id: group.id,
                          name: group.name + (group.active ? '' : ' · Đã ngừng'),
                        })),
                      ]}
                    />
                    <Choice
                      label="Thời điểm chọn người"
                      value={node.assigneeRule.selectionTiming ?? 'start'}
                      onChange={(value) =>
                        update(node.id, {
                          assigneeRule: {
                            kind: 'group',
                            groupId:
                              node.assigneeRule?.kind === 'group' ? node.assigneeRule.groupId : '',
                            selectionTiming: value === 'handoff' ? 'handoff' : undefined,
                          },
                        })
                      }
                      options={[
                        { id: 'start', name: 'Khi gửi đề nghị' },
                        { id: 'handoff', name: 'Khi bàn giao đến bước' },
                      ]}
                    />
                    <p className="text-xs text-muted-foreground">
                      {node.assigneeRule.selectionTiming === 'handoff'
                        ? 'Người chuyển đến bước chọn một thành viên đủ quyền.'
                        : 'Người khởi tạo chọn một thành viên đủ quyền cho từng lần gửi.'}
                    </p>
                  </>
                )}
                {node.assigneeRule?.kind === 'pool' && (
                  <>
                    <Choice
                      label="Nhóm phê duyệt"
                      value={node.assigneeRule.groupId || '_none'}
                      onChange={(value) =>
                        update(node.id, {
                          assigneeRule: {
                            ...(node.assigneeRule as Extract<
                              NonNullable<typeof node.assigneeRule>,
                              { kind: 'pool' }
                            >),
                            groupId: value === '_none' ? '' : value,
                          },
                        })
                      }
                      options={[
                        { id: '_none', name: 'Chọn nhóm' },
                        ...(lookup.groups ?? []).map((g) => ({
                          id: g.id,
                          name: g.name + (g.active ? '' : ' · Đã ngừng'),
                        })),
                      ]}
                    />
                    <Choice
                      label="Điều kiện hoàn tất"
                      value={node.assigneeRule.mode}
                      onChange={(mode) =>
                        update(node.id, {
                          assigneeRule: {
                            kind: 'pool',
                            groupId:
                              node.assigneeRule!.kind === 'pool' ? node.assigneeRule!.groupId : '',
                            mode: mode as 'all' | 'any' | 'quorum',
                            ...(mode === 'quorum' ? { quorum: 2 } : {}),
                          },
                        })
                      }
                      options={[
                        { id: 'all', name: 'Tất cả thành viên đồng ý' },
                        { id: 'any', name: 'Một người đồng ý' },
                        { id: 'quorum', name: 'Đủ số người đồng ý' },
                      ]}
                    />
                    {node.assigneeRule.mode === 'quorum' && (
                      <div className="space-y-2">
                        <Label htmlFor="pool-quorum">Số người tối thiểu</Label>
                        <Input
                          id="pool-quorum"
                          type="number"
                          min={1}
                          max={50}
                          value={node.assigneeRule.quorum}
                          onChange={(e) =>
                            update(node.id, {
                              assigneeRule: {
                                ...(node.assigneeRule as Extract<
                                  NonNullable<typeof node.assigneeRule>,
                                  { kind: 'pool' }
                                >),
                                quorum: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Chốt thành viên đủ quyền khi đến bước, loại người gửi. Một người chỉ có một
                      phiếu; từ chối hoặc trả về kết thúc bước.
                    </p>
                  </>
                )}
                {node.assigneeRule?.kind === 'previous' && (
                  <>
                    <Choice
                      label="Lấy người từ bước"
                      value={node.assigneeRule.stepId || '_none'}
                      onChange={(value) =>
                        update(node.id, {
                          assigneeRule: {
                            kind: 'previous',
                            stepId: value === '_none' ? '' : value,
                          },
                        })
                      }
                      options={[
                        { id: '_none', name: 'Chọn bước trước' },
                        ...previousAssigneeSteps(spec.nodes, node.id).map((step) => ({
                          id: step.id,
                          name: step.label,
                        })),
                      ]}
                    />
                    <p className="text-xs text-muted-foreground">
                      Lấy người thực sự hoàn thành bước này trong cùng lần gửi. Chỉ chọn bước chắc
                      chắn đi qua ở mọi nhánh.
                    </p>
                  </>
                )}
                <Choice
                  label="Đơn vị thời hạn"
                  value={node.deadlineMinutes === undefined ? 'hours' : 'minutes'}
                  onChange={(v) =>
                    update(node.id, {
                      deadlineMinutes: v === 'minutes' ? node.dueHours * 60 : undefined,
                    })
                  }
                  options={[
                    { id: 'hours', name: 'Giờ' },
                    { id: 'minutes', name: 'Phút' },
                  ]}
                />
                <div className="space-y-2">
                  <Label htmlFor="step-due">
                    {node.deadlineMinutes === undefined ? 'Hạn xử lý (giờ)' : 'Hạn xử lý (phút)'}
                  </Label>
                  <Input
                    id="step-due"
                    type="number"
                    min={1}
                    max={node.deadlineMinutes === undefined ? 8760 : 525600}
                    value={node.deadlineMinutes ?? node.dueHours}
                    onChange={(e) =>
                      update(
                        node.id,
                        node.deadlineMinutes === undefined
                          ? { dueHours: Number(e.target.value) }
                          : { deadlineMinutes: Number(e.target.value) },
                      )
                    }
                  />
                </div>
                <Choice
                  label="Cách tính thời hạn"
                  value={node.deadlineMode ?? 'elapsed'}
                  onChange={(v) => update(node.id, { deadlineMode: v as 'elapsed' | 'business' })}
                  options={[
                    { id: 'elapsed', name: 'Thời gian liên tục' },
                    { id: 'business', name: 'Theo lịch làm việc' },
                  ]}
                />
                {node.deadlineMode === 'business' && !spec.calendar && (
                  <p role="alert" className="text-sm text-destructive">
                    Cần bật lịch làm việc tại Thông tin & đối tượng trước khi lưu.
                  </p>
                )}
                <label className="flex items-center gap-3">
                  <Checkbox
                    checked={node.allowReturn !== false}
                    onCheckedChange={(v) =>
                      update(node.id, { allowReturn: !!v, ...(v ? {} : { returnMode: undefined }) })
                    }
                  />
                  Cho phép trả về
                </label>
                {node.allowReturn !== false && (
                  <Choice
                    label="Khi trả về"
                    value={node.returnMode ?? '_initiator'}
                    onChange={(value) =>
                      update(node.id, {
                        returnMode:
                          value === '_initiator' ? undefined : (value as HumanStep['returnMode']),
                      })
                    }
                    options={[
                      { id: '_initiator', name: 'Về người khởi tạo' },
                      { id: 'previous', name: 'Về bước liền trước' },
                      { id: 'choose', name: 'Người xử lý chọn bước' },
                      { id: 'end', name: 'Kết thúc lượt chạy' },
                    ]}
                  />
                )}
                {node.assigneeRule?.kind === 'group' && (
                  <fieldset className="space-y-2 rounded-md border p-3">
                    <legend className="px-1 text-sm font-medium">Ai được phân công lại?</legend>
                    <p className="text-xs text-muted-foreground">
                      Điều phối viên có quyền. Có thể cấp thêm quyền đổi người trong nhóm cho:
                    </p>
                    {(
                      [
                        ['assignee', 'Người đang được giao bước'],
                        ['sender', 'Người đã chuyển hồ sơ đến bước'],
                      ] as const
                    ).map(([role, label]) => (
                      <label key={role} className="flex min-h-11 items-center gap-3">
                        <Checkbox
                          checked={node.reassignRoles?.includes(role) ?? false}
                          onCheckedChange={(checked) => {
                            const roles = node.reassignRoles ?? [];
                            const next =
                              checked === true
                                ? [...roles, role]
                                : roles.filter((value) => value !== role);
                            update(node.id, { reassignRoles: next.length ? next : undefined });
                          }}
                        />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                )}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    if (!node.form)
                      update(node.id, { form: emptySchema('Thông tin tại ' + node.label) });
                    onEditForm?.(node.id);
                  }}
                >
                  Biểu mẫu tại bước
                </Button>
                {node.form && (
                  <Button variant="ghost" onClick={() => update(node.id, { form: null })}>
                    Bỏ biểu mẫu tại bước
                  </Button>
                )}
              </>
            )}
            {'next' in node && (
              <Choice
                label="Chuyển đến"
                value={node.next || '_none'}
                onChange={(value) => update(node.id, { next: value === '_none' ? '' : value })}
                options={[{ id: '_none', name: 'Chọn bước tiếp theo' }, ...targets]}
              />
            )}
            {node.kind === 'parallel' && (
              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">Nhánh song song</legend>
                <Choice
                  label="Hợp tại"
                  value={node.join || '_none'}
                  onChange={(value) => update(node.id, { join: value === '_none' ? '' : value })}
                  options={[
                    { id: '_none', name: 'Chọn điểm hợp' },
                    ...targets.filter((target) =>
                      spec.nodes.some((item) => item.id === target.id && item.kind === 'join'),
                    ),
                  ]}
                />
                {node.branches.map((target, index) => (
                  <div className="space-y-2" key={index}>
                    <Choice
                      label={'Bước đầu nhánh ' + (index + 1)}
                      value={target || '_none'}
                      onChange={(value) =>
                        update(node.id, {
                          branches: node.branches.map((start, lane) =>
                            lane === index ? (value === '_none' ? '' : value) : start,
                          ),
                        })
                      }
                      options={[
                        { id: '_none', name: 'Chọn bước đầu' },
                        ...targets.filter(
                          (item) =>
                            item.id !== node.join &&
                            (item.id === target || !node.branches.includes(item.id)),
                        ),
                      ]}
                    />
                    {node.branches.length > 2 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          update(node.id, {
                            branches: node.branches.filter((_, lane) => lane !== index),
                          })
                        }
                      >
                        Bỏ nhánh {index + 1}
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={node.branches.length >= 28}
                  onClick={() => update(node.id, { branches: [...node.branches, ''] })}
                >
                  <Plus /> Thêm nhánh
                </Button>
              </fieldset>
            )}
            {node.kind === 'approval' && (
              <Choice
                label="Khi từ chối"
                value={
                  node.rejectReturnMode ? '_' + node.rejectReturnMode : (node.rejectNext ?? '_none')
                }
                onChange={(value) => {
                  const returnMode =
                    value === '_previous' ? 'previous' : value === '_choose' ? 'choose' : undefined;
                  update(node.id, {
                    rejectNext: value === '_none' || returnMode ? undefined : value,
                    rejectReturnMode: returnMode,
                  });
                }}
                options={[
                  { id: '_none', name: 'Kết thúc với trạng thái từ chối' },
                  { id: '_previous', name: 'Về bước liền trước' },
                  { id: '_choose', name: 'Người xử lý chọn bước' },
                  ...targets,
                ]}
              />
            )}
            {branch && (
              <>
                <p className="text-sm text-muted-foreground">
                  Chọn dữ liệu khởi tạo hoặc kết quả của bước luôn hoàn tất trước nhánh này.
                </p>
                <WorkflowConditionEditor
                  value={branch.condition}
                  fields={workflowBranchFields(
                    spec.input,
                    spec.nodes,
                    branch.id,
                    spec.fieldReaders,
                  )}
                  onChange={(condition) => update(branch.id, { condition })}
                />
                <Choice
                  label="Nếu đúng"
                  value={branch.yes || '_none'}
                  onChange={(value) => update(node.id, { yes: value === '_none' ? '' : value })}
                  options={[{ id: '_none', name: 'Chọn bước' }, ...targets]}
                />
                <Choice
                  label="Nếu sai"
                  value={branch.no || '_none'}
                  onChange={(value) => update(node.id, { no: value === '_none' ? '' : value })}
                  options={[{ id: '_none', name: 'Chọn bước' }, ...targets]}
                />
              </>
            )}
            {node.kind === 'start' && (
              <Button variant="outline" className="w-full" onClick={() => onEditForm?.('input')}>
                Biểu mẫu khởi tạo
              </Button>
            )}
            {!['start', 'end'].includes(node.kind) && (
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() => {
                  onChange({ ...spec, nodes: spec.nodes.filter((item) => item.id !== node.id) });
                  setSelected(spec.nodes[0]!.id);
                }}
              >
                <Trash2 />
                Xóa bước
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Người xử lý cần quyền ứng dụng trong đơn vị của lượt chạy. Quyền được kiểm lại khi
              thao tác.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
export function WorkflowCanvas(props: Parameters<typeof Canvas>[0]) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
