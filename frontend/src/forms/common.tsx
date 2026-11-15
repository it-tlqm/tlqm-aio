import { useRef } from 'react';
import type { FormSchema, FormField, FormIssue } from '../../../src/forms/contracts';
import { FormValidationError } from '../../../src/forms/contracts';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';

export type FormListItem = {
  id: string;
  code: string;
  title: string;
  org_unit_id: string | null;
  revision: number;
  latest_version: number;
  status: string;
  hasDraft: boolean;
  max_submissions: number;
  draft_schema?: FormSchema | null;
};
export type Version = { id: string; version: number; schema: FormSchema; closed_at: string | null };
export type Audience = {
  kind: 'account' | 'unit' | 'group';
  targetId: string;
  opensAt: string;
  closesAt: string | null;
};
export type FormDetail = {
  form: FormListItem;
  versions: Version[];
  responseUnits: string[];
  audiences: {
    kind: Audience['kind'];
    target_id: string;
    opens_at: string;
    closes_at: string | null;
  }[];
};
export type PageResult<T> = { items: T[]; nextCursor: string | null; submittedCount?: number };
export type Submission = {
  id: string;
  version_id: string;
  org_unit_id: string;
  account_id: string;
  status: string;
  revision: number;
  answers: Record<string, string | number | boolean | string[]>;
  version_schema: FormSchema;
  version: number;
  submitted_at: string | null;
};
export type Lookup = {
  units: { id: string; name: string }[];
  ownUnits: string[];
  accounts: { id: string; name: string }[];
};
export type Group = {
  id: string;
  name: string;
  org_unit_id: string | null;
  account_ids: string[];
  active: boolean;
  revision: number;
};
export const typeLabels: Record<FormField['type'], string> = {
  shortText: 'Văn bản ngắn',
  longText: 'Văn bản dài',
  number: 'Số',
  integer: 'Số nguyên',
  percentage: 'Phần trăm',
  date: 'Ngày',
  month: 'Tháng / năm',
  time: 'Giờ / phút',
  dateTime: 'Ngày và giờ',
  singleChoice: 'Chọn một',
  multipleChoice: 'Chọn nhiều',
  boolean: 'Có / Không',
  money: 'Số tiền',
  table: 'Bảng chi tiết',
  person: 'Nhân sự AIO',
  orgUnit: 'Đơn vị AIO',
  attachment: 'Tệp đính kèm',
};
export const id = (prefix: string) =>
  prefix + '_' + crypto.randomUUID().replaceAll('-', '').slice(0, 10);
export function emptySchema(title = 'Biểu mẫu mới'): FormSchema {
  return {
    schemaVersion: 1,
    title,
    description: '',
    sections: [
      {
        id: id('section'),
        title: 'Nội dung',
        fields: [
          { id: id('field'), label: 'Câu hỏi đầu tiên', type: 'shortText', required: false },
        ],
      },
    ],
  };
}
export function can(me: Me, tenantId: string, permission: string, unit?: string | null) {
  return me.permissions.some(
    (entry) =>
      entry.tenantId === tenantId &&
      entry.permission === permission &&
      (unit === undefined || entry.orgUnitId === null || entry.orgUnitId === unit),
  );
}
const issueMessages: Record<string, string> = {
  INVALID_REFERENCE: 'Chọn nhân sự hoặc đơn vị từ danh sách.',
  REFERENCE_UNAVAILABLE: 'Lựa chọn không còn trong phạm vi hiện tại. Hãy tìm và chọn lại.',
  ATTACHMENT_REFERENCE_INVALID: 'Tệp không hợp lệ hoặc nằm ngoài phạm vi của trường.',
  ATTACHMENT_FORMAT_INVALID: 'Chọn ít nhất một định dạng tệp hợp lệ.',
  ATTACHMENT_LIMIT: 'Kiểm tra giới hạn số tệp và dung lượng từng tệp.',
  BUSINESS_VALUE_INVALID: 'Kiểm tra ô dữ liệu trong bảng; dùng dấu chấm cho phần thập phân.',
  DECIMAL_PRECISION: 'Số tiền tối đa 2 chữ số thập phân, số lượng tối đa 3 chữ số.',
  TABLE_ROW_LIMIT: 'Số dòng vượt giới hạn của bảng.',
  BUSINESS_TOTAL_OVERFLOW: 'Số tiền hoặc tổng vượt giới hạn cho phép.',
  INVALID_FORMULA_REFERENCE: 'Công thức cần hai cột số lượng hoặc số tiền còn tồn tại.',
  DUPLICATE_ROW: 'Các dòng không được trùng mã.',
  DUPLICATE_COLUMN: 'Các cột không được trùng mã.',
  REQUIRED_ANSWER: 'Vui lòng trả lời câu hỏi này.',
  INVALID_ANSWER: 'Giá trị không đúng kiểu hoặc nằm ngoài giới hạn.',
  HIDDEN_FIELD_ANSWER: 'Câu hỏi đang ẩn không nhận dữ liệu.',
  OPTION_NOT_AVAILABLE: 'Lựa chọn không phù hợp với điều kiện hiện tại. Hãy chọn lại.',
  INVALID_OPTION_RULE: 'Mỗi quy tắc phải chọn ít nhất một giá trị còn trong danh sách.',
  CONDITION_LIMIT: 'Điều kiện vượt giới hạn số dòng hoặc số cấp nhóm.',
  INVALID_TEXT: 'Vui lòng nhập nội dung trong giới hạn.',
  INVALID_TEXT_BOUNDS: 'Giới hạn độ dài chưa hợp lệ.',
  INVALID_NUMBER_BOUNDS: 'Giá trị tối thiểu phải nhỏ hơn hoặc bằng tối đa.',
  INVALID_DATE_BOUNDS: 'Khoảng ngày chưa hợp lệ.',
  INVALID_DATE: 'Ngày không hợp lệ.',
  CONDITION_CYCLE: 'Điều kiện đang tham chiếu vòng lặp.',
  CONDITION_TYPE_MISMATCH: 'Giá trị điều kiện không khớp loại câu hỏi nguồn.',
  UNKNOWN_CONDITION_FIELD: 'Điều kiện tham chiếu câu hỏi đã bị xóa.',
  DUPLICATE_OPTION_ID: 'Lựa chọn bị trùng mã.',
  INVALID_LIST_SIZE: 'Cần có câu hỏi hoặc lựa chọn hợp lệ.',
  INVALID_NUMBER: 'Vui lòng nhập số hợp lệ.',
};
export function formIssues(error: unknown): FormIssue[] {
  return error instanceof FormValidationError
    ? error.issues
    : error instanceof ApiError
      ? (error.issues ?? [])
      : [];
}
export function formError(error: unknown) {
  const issues = formIssues(error);
  return issues.length
    ? [
        ...new Set(
          issues.map((issue) => issueMessages[issue.code] ?? 'Nội dung biểu mẫu chưa hợp lệ.'),
        ),
      ].join(' ')
    : errorMessage(error);
}
export function issueText(code: string) {
  return issueMessages[code] ?? 'Vui lòng kiểm tra câu trả lời.';
}
export function Choice({
  label,
  value,
  onChange,
  options,
  disabled = false,
  name,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { id: string; name: string }[];
  disabled?: boolean;
  name?: string;
}) {
  const controlId = name ?? label.replaceAll(' ', '-');
  return (
    <div className="space-y-2">
      <Label htmlFor={controlId}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={controlId} className="w-full">
          <SelectValue placeholder="Chọn…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function useFormsWrite(me: Me, tenantId: string) {
  const pending = useRef<{ signature: string; key: string } | null>(null);
  return async function write<T>(
    path: string,
    data: Record<string, unknown>,
    reason: string,
    method = 'POST',
  ): Promise<T> {
    const body = JSON.stringify({ ...data, tenantId, reason });
    const signature = method + path + body;
    if (pending.current?.signature !== signature)
      pending.current = { signature, key: crypto.randomUUID() };
    const response = await api<T>('/api/v1/forms' + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': me.csrfToken,
        'idempotency-key': pending.current.key,
      },
      body,
    });
    pending.current = null;
    return response;
  };
}
