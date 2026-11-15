export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public issues?: { path: string; code: string }[],
  ) {
    super(code);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...options.headers },
  });
  const body = await response.json().catch(() => ({ error: 'INVALID_RESPONSE' }));
  if (!response.ok)
    throw new ApiError(response.status, body.error || 'REQUEST_FAILED', body.issues);
  return body as T;
}

/** Collect bounded cursor pages; fail as a whole if a later page loses access. */
export async function apiCollection<T>(
  path: string,
  options: RequestInit = {},
): Promise<{ items: T[] }> {
  const items: T[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const result: { items: T[]; nextCursor?: string | null } = await api<{
      items: T[];
      nextCursor?: string | null;
    }>(
      path +
        (cursor ? (path.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor) : ''),
      options,
    );
    if (!Array.isArray(result.items)) throw new ApiError(502, 'INVALID_RESPONSE');
    items.push(...result.items);
    if (result.nextCursor == null) return { items };
    if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor) || seen.size >= 10000)
      throw new ApiError(502, 'INVALID_RESPONSE');
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}

export type Row = Record<string, unknown>;
export type Permission = {
  tenantId: string;
  permission: string;
  managedAppCode: string | null;
  orgUnitId: string | null;
};
export type Me = {
  accountId: string;
  personId: string;
  displayName: string;
  appCode: string;
  csrfToken: string;
  permissions: Permission[];
  memberships: { id: string; code: string; name: string }[];
  assignments: {
    tenantId: string;
    unitName: string;
    positionName: string;
    isPrimary: boolean;
    employeeCode: string;
  }[];
};
export type Runtime = {
  authError?: string;
  portalUrl?: string;
  appCode: string;
  name: string;
  environment: string;
  loginUrl: string;
  logoutUrl: string;
  accountUrl: string;
};

export function allowed(me: Me, tenantId: string, permission: string) {
  return me.permissions.some(
    (item) =>
      item.tenantId === tenantId && item.permission === permission && item.orgUnitId === null,
  );
}
