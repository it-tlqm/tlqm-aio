import { useEffect, useState } from 'react';
import { apiCollection } from '@/lib/api';
import type { Me, Row } from '@/lib/api';
import { resourceByKey } from '@/lib/resources';
import type { DirectoryData } from './model';
export function canRead(me: Me, tenantId: string, key: string) {
  return me.permissions.some(
    (p) => p.tenantId === tenantId && p.permission === resourceByKey[key]?.read,
  );
}
export function useDirectoryData(
  keys: string[],
  me: Me,
  tenantId: string,
  appCode: string,
  version: number,
): { data: DirectoryData; loading: boolean; error: unknown } {
  const [state, setState] = useState<{
    requestKey: string;
    data: DirectoryData;
    loading: boolean;
    error: unknown;
  }>({
    requestKey: '',
    data: {},
    loading: true,
    error: null,
  });
  const key = keys.join(',');
  const requestKey = JSON.stringify([
    key,
    tenantId,
    appCode,
    version,
    me.accountId,
    me.permissions,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    setState({ requestKey, data: {}, loading: true, error: null });
    void Promise.all(
      key
        .split(',')
        .filter(Boolean)
        .map(async (name) => {
          if (!canRead(me, tenantId, name)) return [name, []] as const;
          const params = new URLSearchParams({
            tenantId,
            ...(resourceByKey[name]?.appScoped ? { appCode } : {}),
          });
          const result = await apiCollection<Row>('/api/v1/manage/' + name + '?' + params, {
            signal: controller.signal,
          });
          return [name, result.items] as const;
        }),
    )
      .then((entries) => {
        if (!controller.signal.aborted)
          setState({ requestKey, data: Object.fromEntries(entries), loading: false, error: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ requestKey, data: {}, loading: false, error });
      });
    return () => controller.abort();
  }, [key, me, tenantId, appCode, version, requestKey]);
  return state.requestKey === requestKey ? state : { data: {}, loading: true, error: null };
}
