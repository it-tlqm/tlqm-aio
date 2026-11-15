import { directoryProof } from '../integration-directory-proof.js';
import { identityProof } from '../integration-identity-proof.js';
import type { IdentityQuery, IntegrationIdentity } from '../integration-identity-proof.js';
import type { DirectoryQuery, DirectoryPerson } from '../integration-directory-proof.js';
import { foundationDirectory } from './directory.js';
import type { LmsDirectory } from './directory.js';
import { LmsError } from './security.js';
import type { LmsConfig } from './security.js';

export type LearnerDirectory = LmsDirectory & {
  discover(query: {
    tenantId: string;
    search?: string;
    orgUnitId?: string;
    cursor?: string;
  }): Promise<{ items: DirectoryPerson[]; nextCursor: string | null }>;
  identity(query: IdentityQuery): Promise<IntegrationIdentity>;
};
export function foundationLearners(
  config: LmsConfig,
  token: string,
  subject: string,
): LearnerDirectory {
  async function request(path: string, body: unknown, proof: string) {
    let response: Response;
    try {
      response = await fetch(config.foundationUrl.replace(/\/authorize$/, path), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + token,
          'x-aio-service-proof': proof,
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
        response.status === 401
          ? 401
          : response.status === 403
            ? 403
            : response.status === 404 || response.status === 409
              ? 409
              : 503,
        response.status === 401
          ? 'SESSION_REVOKED'
          : response.status === 403
            ? 'LMS_PROVISIONING_DENIED'
            : response.status === 404 || response.status === 409
              ? 'LMS_IDENTITY_TARGET_UNAVAILABLE'
              : 'FOUNDATION_UNAVAILABLE',
      );
    const result = (await response.json()) as Record<string, unknown>;
    if (
      result.version !== 1 ||
      result.appCode !== config.clientId ||
      result.subject !== subject ||
      result.maxAgeSeconds !== 0
    )
      throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
    return result;
  }
  return {
    ...foundationDirectory(config, token, subject),
    async discover(query) {
      const body: DirectoryQuery = { ...query, kind: 'people' };
      const result = await request(
        '/directory',
        body,
        await directoryProof(config.clientSecret, config.clientId, token, body),
      );
      if (
        result.tenantId !== query.tenantId ||
        result.kind !== 'people' ||
        !Array.isArray(result.items) ||
        result.items.length > 100 ||
        !(result.nextCursor === null || typeof result.nextCursor === 'string')
      )
        throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
      const items = result.items as DirectoryPerson[];
      if (
        !items.every(
          (p) =>
            p &&
            typeof p.accountId === 'string' &&
            typeof p.personId === 'string' &&
            typeof p.displayName === 'string' &&
            Array.isArray(p.units) &&
            p.units.every(
              (u) =>
                typeof u.id === 'string' &&
                typeof u.name === 'string' &&
                Array.isArray(u.employeeCodes),
            ),
        )
      )
        throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
      return { items, nextCursor: result.nextCursor as string | null };
    },
    async identity(query) {
      const result = await request(
        '/identity',
        query,
        await identityProof(config.clientSecret, config.clientId, token, query),
      );
      const target = result.target as IntegrationIdentity | undefined;
      if (
        !target ||
        target.accountId !== query.accountId ||
        target.tenantId !== query.tenantId ||
        target.orgUnitId !== query.orgUnitId ||
        target.issuer !== config.issuer ||
        !target.subject ||
        typeof target.subject !== 'string' ||
        typeof target.personId !== 'string' ||
        typeof target.displayName !== 'string' ||
        typeof target.unitName !== 'string'
      )
        throw new LmsError(503, 'FOUNDATION_CONTRACT_INVALID');
      return target;
    },
  };
}
