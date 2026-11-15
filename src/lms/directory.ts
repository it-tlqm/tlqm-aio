import { directoryProof } from '../integration-directory-proof.js';
import type {
  DirectoryQuery,
  DirectoryPerson,
  DirectoryUnit,
} from '../integration-directory-proof.js';
import type { LmsConfig } from './security.js';
import { LmsError } from './security.js';
export type LmsDirectory = {
  units(tenantId: string): Promise<DirectoryUnit[]>;
  people(tenantId: string, accountIds: string[]): Promise<DirectoryPerson[]>;
};
export function foundationDirectory(
  config: LmsConfig,
  token: string,
  subject: string,
): LmsDirectory {
  async function request<T>(query: DirectoryQuery): Promise<T[]> {
    const items: T[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const body: DirectoryQuery = { ...query, ...(cursor ? { cursor } : {}) };
      let response: Response;
      try {
        response = await fetch(config.foundationUrl.replace(/\/authorize$/, '/directory'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + token,
            'x-aio-service-proof': await directoryProof(
              config.clientSecret,
              config.clientId,
              token,
              body,
            ),
          },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(6000),
        });
      } catch {
        throw new LmsError(503, 'FOUNDATION_UNAVAILABLE');
      }
      if (!response.ok)
        throw new LmsError(
          response.status === 401 || response.status === 403 ? response.status : 503,
          response.status === 403
            ? 'LMS_DIRECTORY_DENIED'
            : response.status === 401
              ? 'SESSION_REVOKED'
              : 'FOUNDATION_UNAVAILABLE',
        );
      const result = (await response.json()) as {
        version: number;
        appCode: string;
        subject: string;
        tenantId: string;
        kind: string;
        maxAgeSeconds: number;
        items: T[];
        nextCursor: string | null;
      };
      if (
        result.version !== 1 ||
        result.appCode !== config.clientId ||
        result.subject !== subject ||
        result.tenantId !== query.tenantId ||
        result.kind !== query.kind ||
        result.maxAgeSeconds !== 0 ||
        !Array.isArray(result.items) ||
        !(result.nextCursor === null || typeof result.nextCursor === 'string')
      )
        throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
      items.push(...result.items);
      if (result.nextCursor === null) return items;
      if (seen.has(result.nextCursor)) throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
  }
  return {
    async units(tenantId) {
      const rows = await request<DirectoryUnit>({ kind: 'units', tenantId });
      if (
        !rows.every(
          (row) =>
            row &&
            typeof row.id === 'string' &&
            typeof row.name === 'string' &&
            typeof row.code === 'string' &&
            typeof row.legalEntityId === 'string' &&
            typeof row.legalEntityName === 'string',
        )
      )
        throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
      return rows;
    },
    async people(tenantId, accountIds) {
      const unique = [...new Set(accountIds)],
        rows: DirectoryPerson[] = [];
      for (let offset = 0; offset < unique.length; offset += 100) {
        const batch = unique.slice(offset, offset + 100),
          current = await request<DirectoryPerson>({ kind: 'people', tenantId, accountIds: batch });
        if (
          !current.every(
            (row) =>
              row &&
              batch.includes(row.accountId) &&
              typeof row.personId === 'string' &&
              typeof row.displayName === 'string' &&
              Array.isArray(row.units) &&
              row.units.every(
                (unit) =>
                  unit &&
                  typeof unit.id === 'string' &&
                  typeof unit.name === 'string' &&
                  Array.isArray(unit.employeeCodes) &&
                  unit.employeeCodes.every((code) => typeof code === 'string'),
              ),
          )
        )
          throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
        rows.push(...current);
      }
      return rows;
    },
  };
}
