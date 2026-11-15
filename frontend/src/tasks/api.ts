import { api } from '@/lib/api';
import type { TaskStatus } from '../../../src/tasks/options';

export const tasksBase = '/api/v1/tasks';
export const statusLabel: Record<TaskStatus, string> = {
  todo: 'Cần thực hiện',
  doing: 'Đang thực hiện',
  done: 'Hoàn thành',
};
export const roleLabel = {
  manager: 'Quản trị dự án',
  member: 'Thành viên',
  viewer: 'Người xem',
} as const;
export const vietnamTime = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});
export const dayLabel = (value: string | null) =>
  value ? value.split('-').reverse().join('/') : 'Chưa đặt hạn';
export type TaskWriter = <T>(
  path: string,
  data: Record<string, unknown>,
  reason: string,
) => Promise<T>;
export function taskWriter(tenantId: string, csrfToken: string): TaskWriter {
  const keys = new Map<string, string>();
  return async <T>(path: string, data: Record<string, unknown>, reason: string) => {
    const body = JSON.stringify({ ...data, tenantId, reason });
    const signature = path + '\n' + body;
    const key = keys.get(signature) ?? crypto.randomUUID();
    keys.set(signature, key);
    const result = await api<T>(tasksBase + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        'idempotency-key': key,
      },
      body,
    });
    keys.delete(signature);
    return result;
  };
}
export function getTaskApi<T>(
  tenantId: string,
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return api<T>(
    tasksBase + path + '?' + new URLSearchParams({ tenantId, ...params }),
    signal ? { signal } : {},
  );
}
