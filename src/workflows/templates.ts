import type { WorkflowSpec } from './contracts.js';
import { purchaseColumns } from '../forms/business.js';
export function businessPurchaseTemplate(): WorkflowSpec {
  const spec = workflowTemplate('purchase');
  spec.schemaVersion = 5;
  spec.name = 'Mua sắm — Bảng chi tiết';
  spec.input.schemaVersion = 2;
  spec.input.title = spec.name;
  spec.input.sections[0]!.fields = spec.input.sections[0]!.fields.filter((f) => f.id !== 'amount');
  spec.input.sections[0]!.fields.push(
    { id: 'recipient', type: 'person', label: 'Người nhận vật tư', required: false },
    { id: 'receiving_unit', type: 'orgUnit', label: 'Đơn vị sử dụng', required: false },
  );
  spec.input.sections[0]!.fields.push({
    id: 'items',
    type: 'table',
    label: 'Chi tiết mua sắm',
    required: true,
    currency: 'VND',
    maxRows: 50,
    columns: purchaseColumns(),
  });
  const branch = spec.nodes.find((n) => n.kind === 'condition')!;
  branch.condition.rules = [
    { fieldCode: 'items__total_amount', operator: 'GREATER_THAN_OR_EQUAL', value: 10000000 },
  ];
  return spec;
}
export function workflowTemplate(kind: 'purchase' | 'leave' | 'blank' = 'purchase'): WorkflowSpec {
  const name =
    kind === 'purchase'
      ? 'Đề nghị mua sắm'
      : kind === 'leave'
        ? 'Đề nghị nghỉ phép'
        : 'Quy trình mới';
  return {
    schemaVersion: 1,
    name,
    description:
      kind === 'purchase'
        ? 'Tiếp nhận đề nghị, kiểm tra hạn mức và giao bộ phận thực hiện.'
        : 'Khởi tạo, phê duyệt và theo dõi kết quả xử lý.',
    category: kind === 'purchase' ? 'Mua sắm' : 'Hành chính',
    audienceUnits: [],
    positions: {},
    input: {
      schemaVersion: 1,
      title: name,
      sections: [
        {
          id: 'request',
          title: 'Thông tin đề nghị',
          fields:
            kind === 'purchase'
              ? [
                  { id: 'purpose', type: 'longText', label: 'Nội dung mua sắm', required: true },
                  {
                    id: 'amount',
                    type: 'number',
                    label: 'Giá trị dự kiến (VND)',
                    required: true,
                    min: 0,
                  },
                  { id: 'needed_on', type: 'date', label: 'Ngày cần sử dụng', required: true },
                ]
              : [
                  { id: 'purpose', type: 'longText', label: 'Nội dung đề nghị', required: true },
                  { id: 'requested_on', type: 'date', label: 'Ngày đề nghị', required: true },
                ],
        },
      ],
    },
    nodes:
      kind === 'purchase'
        ? [
            { id: 'start', label: 'Gửi đề nghị', kind: 'start', next: 'review' },
            {
              id: 'review',
              label: 'Trưởng bộ phận xem xét',
              kind: 'approval',
              assignee: '',
              dueHours: 24,
              next: 'budget',
              form: null,
            },
            {
              id: 'budget',
              label: 'Từ 10 triệu đồng?',
              kind: 'condition',
              condition: {
                schemaVersion: 1,
                logicalOperator: 'AND',
                rules: [
                  { fieldCode: 'amount', operator: 'GREATER_THAN_OR_EQUAL', value: 10000000 },
                ],
              },
              yes: 'director',
              no: 'fulfil',
            },
            {
              id: 'director',
              label: 'Duyệt hạn mức',
              kind: 'approval',
              assignee: '',
              dueHours: 24,
              next: 'fulfil',
              form: null,
            },
            {
              id: 'fulfil',
              label: 'Thực hiện mua sắm',
              kind: 'task',
              assignee: '',
              dueHours: 48,
              next: 'end',
              form: {
                schemaVersion: 1,
                title: 'Kết quả thực hiện',
                sections: [
                  {
                    id: 'result',
                    title: 'Hoàn tất',
                    fields: [
                      {
                        id: 'result_note',
                        type: 'longText',
                        label: 'Kết quả xử lý',
                        required: true,
                      },
                    ],
                  },
                ],
              },
            },
            { id: 'end', label: 'Hoàn thành', kind: 'end' },
          ]
        : [
            { id: 'start', label: 'Gửi đề nghị', kind: 'start', next: 'review' },
            {
              id: 'review',
              label: 'Xem xét đề nghị',
              kind: 'approval',
              assignee: '',
              dueHours: 24,
              next: 'end',
              form: null,
            },
            { id: 'end', label: 'Hoàn thành', kind: 'end' },
          ],
  };
}
