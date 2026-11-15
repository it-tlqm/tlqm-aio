import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AppRuntime } from '../config.js';
import type { LoginTokens, OidcClient } from '../oidc.js';
import type { Store, Principal } from '../store.js';
import { hashToken, HttpError, randomToken, seal, unseal } from '../security.js';
import { camelRow } from './directory.js';
import { mutate, auditMutation } from './mutations.js';
import type { MutationContext } from './mutations.js';
import { GovernanceService } from './governance.js';

type Db = Pool | PoolClient;
export class IdentityService {
  constructor(
    private store: Store,
    private runtime: AppRuntime,
    private oidc: Pick<OidcClient, 'access'>,
  ) {}
  private assertFoundation(appCode: string) {
    if (appCode !== 'aio-foundation') throw new HttpError(403, 'FOUNDATION_ONLY');
  }
  async targets(actor: Principal, tenantId: string, cursor?: string) {
    if (
      !actor.permissions.some(
        (permission) =>
          permission.tenantId === tenantId &&
          permission.orgUnitId === null &&
          ['identity:link', 'accounts:manage'].includes(permission.permission),
      )
    )
      throw new HttpError(403, 'PERMISSION_DENIED');
    let after: [string, string] | undefined;
    if (cursor) {
      try {
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          cursor.length > 2048 ||
          !Array.isArray(value) ||
          value.length !== 2 ||
          typeof value[0] !== 'string' ||
          value[0].length > 200 ||
          typeof value[1] !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[1])
        )
          throw new Error('Invalid cursor');
        after = value as [string, string];
      } catch {
        throw new HttpError(400, 'INVALID_REQUEST');
      }
    }
    const rows = (
      await this.store.pool.query(
        'SELECT a.id,a.person_id AS "personId",p.display_name AS "displayName",a.active,p.active AS "personActive",a.revision,a.is_protected AS "isProtected" FROM accounts a JOIN persons p ON p.id=a.person_id JOIN tenant_memberships m ON m.account_id=a.id AND m.tenant_id=p.home_tenant_id WHERE p.home_tenant_id=$1 AND m.active' +
          (after ? ' AND (p.display_name,a.id)>($2,$3::uuid)' : '') +
          ' ORDER BY p.display_name,a.id LIMIT 501',
        [tenantId, ...(after ?? [])],
      )
    ).rows;
    return {
      items: rows.slice(0, 500),
      limit: 500,
      nextCursor:
        rows.length > 500
          ? Buffer.from(JSON.stringify([rows[499].displayName, rows[499].id])).toString('base64url')
          : null,
    };
  }
  private async target(
    db: Db,
    actor: Principal,
    tenantId: string,
    accountId: string,
    lock = false,
  ) {
    const row = (
      await db.query(
        'SELECT a.*,p.display_name,p.active AS person_active FROM accounts a JOIN persons p ON p.id=a.person_id JOIN tenant_memberships m ON m.account_id=a.id AND m.tenant_id=p.home_tenant_id WHERE a.id=$1 AND p.home_tenant_id=$2 AND m.active' +
          (lock ? ' FOR UPDATE OF a' : ''),
        [accountId, tenantId],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'TARGET_NOT_FOUND');
    if (row.account_id === actor.accountId || row.id === actor.accountId)
      throw new HttpError(403, 'SELF_MANAGEMENT_FORBIDDEN');
    if (row.is_protected) throw new HttpError(403, 'PROTECTED_ACCOUNT');
    if (!row.active || !row.person_active) throw new HttpError(403, 'ACCOUNT_UNAVAILABLE');
    return row;
  }
  async createProof(tokens: LoginTokens, requestId: string) {
    const identity = await this.oidc.access(tokens.accessToken);
    const now = Date.now();
    if (
      identity.subject !== tokens.subject ||
      !identity.authenticationMethods?.includes('pwd') ||
      !Number.isInteger(identity.authenticatedAt) ||
      identity.authenticatedAt! * 1000 < now - 120_000 ||
      identity.authenticatedAt! * 1000 > now + 60_000
    )
      throw new HttpError(401, 'FRESH_IDENTITY_PROOF_REQUIRED');
    const expiresAt = Math.min(now + 300_000, tokens.expiresAt);
    if (expiresAt <= now + 10_000) throw new HttpError(400, 'IDENTITY_PROOF_UNAVAILABLE');
    const code = randomToken();
    const id = randomUUID();
    const db = await this.store.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(
        'INSERT INTO identity_proofs(id,code_hash,app_code,issuer,subject,authenticated_at,expires_at,encrypted_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          hashToken(code),
          'aio-foundation',
          identity.issuer,
          identity.subject,
          identity.authenticatedAt,
          new Date(expiresAt),
          seal(
            { accessToken: tokens.accessToken },
            this.runtime.encryptionKey,
            'identity-proof:aio-foundation',
          ),
        ],
      );
      await db.query(
        "INSERT INTO audit_events(app_code,action,request_id,target_type,target_id,details) VALUES ('aio-foundation','identity.proof_created',$1,'identity-proof',$2,$3)",
        [
          requestId,
          id,
          JSON.stringify({
            issuer: identity.issuer,
            subject: identity.subject,
            expiresAt: new Date(expiresAt).toISOString(),
          }),
        ],
      );
      await db.query('COMMIT');
      return {
        code,
        id,
        issuer: identity.issuer,
        subject: identity.subject,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  async ownProof(code: string) {
    const row = (
      await this.store.pool.query(
        'SELECT id,issuer,subject,expires_at AS "expiresAt" FROM identity_proofs WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now()',
        [hashToken(code)],
      )
    ).rows[0];
    if (!row) throw new HttpError(400, 'IDENTITY_PROOF_UNAVAILABLE');
    return { ...row, code };
  }
  private async verifiedProof(
    db: Db,
    code: string,
    targetAccount: { id: string; auth_not_before: string | number },
    lock = false,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new HttpError(400, 'IDENTITY_PROOF_UNAVAILABLE');
    const row = (
      await db.query(
        'SELECT * FROM identity_proofs WHERE code_hash=$1 AND app_code=$2 AND consumed_at IS NULL AND expires_at>now()' +
          (lock ? ' FOR UPDATE' : ''),
        [hashToken(code), 'aio-foundation'],
      )
    ).rows[0];
    if (!row?.encrypted_payload) throw new HttpError(400, 'IDENTITY_PROOF_UNAVAILABLE');
    let identity;
    try {
      const payload = unseal<{ accessToken: string }>(
        row.encrypted_payload,
        this.runtime.encryptionKey,
        'identity-proof:aio-foundation',
      );
      identity = await this.oidc.access(payload.accessToken);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401)
        throw new HttpError(400, 'IDENTITY_PROOF_UNAVAILABLE');
      throw error;
    }
    if (
      identity.issuer !== row.issuer ||
      identity.subject !== row.subject ||
      !identity.authenticationMethods?.includes('pwd') ||
      identity.authenticatedAt !== Number(row.authenticated_at) ||
      identity.authenticatedAt <= Number(targetAccount.auth_not_before)
    )
      throw new HttpError(400, 'IDENTITY_PROOF_UNAVAILABLE');
    const existing = (
      await db.query(
        'SELECT id,account_id,active FROM external_identities WHERE issuer=$1 AND subject=$2',
        [row.issuer, row.subject],
      )
    ).rows[0];
    if (existing && existing.account_id !== targetAccount.id)
      throw new HttpError(409, 'IDENTITY_BOUND_TO_OTHER_ACCOUNT');
    if (existing?.active) throw new HttpError(409, 'IDENTITY_ALREADY_LINKED');
    return row;
  }
  async preview(actor: Principal, tenantId: string, accountId: string, code: string) {
    this.store.require(actor, 'identity:link', tenantId);
    const account = await this.target(this.store.pool, actor, tenantId, accountId);
    const proof = await this.verifiedProof(this.store.pool, code, account);
    return {
      issuer: proof.issuer,
      subject: proof.subject,
      verifiedAt: proof.verified_at,
      expiresAt: proof.expires_at,
      accountId,
      accountRevision: account.revision,
      displayName: account.display_name,
    };
  }
  async list(actor: Principal, tenantId: string, accountId: string) {
    this.store.require(actor, 'identity:link', tenantId);
    const account = (
      await this.store.pool.query(
        'SELECT a.id FROM accounts a JOIN persons p ON p.id=a.person_id WHERE a.id=$1 AND p.home_tenant_id=$2',
        [accountId, tenantId],
      )
    ).rows[0];
    if (!account) throw new HttpError(404, 'TARGET_NOT_FOUND');
    return {
      items: (
        await this.store.pool.query(
          'SELECT id,issuer,subject,account_id,active,revision,verified_at,verified_by,verification_method FROM external_identities WHERE account_id=$1 ORDER BY id',
          [accountId],
        )
      ).rows.map(camelRow),
    };
  }
  async link(
    context: MutationContext,
    input: {
      accountId: string;
      proofCode: string;
      expectedSubject: string;
      expectedAccountRevision: number;
    },
  ) {
    this.assertFoundation(context.appCode);
    const data = {
      accountId: input.accountId,
      proofHash: hashToken(input.proofCode),
      expectedSubject: input.expectedSubject,
      expectedAccountRevision: input.expectedAccountRevision,
    };
    return mutate(
      this.store,
      context,
      'identity:link',
      'identity.link',
      data,
      async (db, actor) => {
        const account = await this.target(db, actor, context.tenantId, input.accountId, true);
        if (account.revision !== input.expectedAccountRevision)
          throw new HttpError(409, 'REVISION_CONFLICT');
        const proof = await this.verifiedProof(db, input.proofCode, account, true);
        if (proof.subject !== input.expectedSubject)
          throw new HttpError(409, 'IDENTITY_SUBJECT_MISMATCH');
        const before = (
          await db.query(
            'SELECT * FROM external_identities WHERE issuer=$1 AND subject=$2 FOR UPDATE',
            [proof.issuer, proof.subject],
          )
        ).rows[0];
        if (before && before.account_id !== input.accountId)
          throw new HttpError(409, 'IDENTITY_BOUND_TO_OTHER_ACCOUNT');
        const row = (
          await db.query(
            "INSERT INTO external_identities(issuer,subject,account_id,verified_at,verified_by,verification_method) VALUES ($1,$2,$3,now(),$4,'oidc-reverification') ON CONFLICT(issuer,subject) DO UPDATE SET active=true,revision=external_identities.revision+1,verified_at=now(),verified_by=EXCLUDED.verified_by,verification_method=EXCLUDED.verification_method WHERE external_identities.account_id=EXCLUDED.account_id AND NOT external_identities.active RETURNING *",
            [proof.issuer, proof.subject, input.accountId, actor.accountId],
          )
        ).rows[0];
        if (!row) throw new HttpError(409, 'IDENTITY_ALREADY_LINKED');
        await db.query(
          'UPDATE identity_proofs SET consumed_at=now(),linked_account_id=$2,encrypted_payload=NULL WHERE id=$1',
          [proof.id, input.accountId],
        );
        await db.query('UPDATE accounts SET revision=revision+1 WHERE id=$1', [input.accountId]);
        await auditMutation(
          db,
          context,
          actor,
          'identity.linked',
          'external-identity',
          row.id,
          before ?? null,
          row,
          input.accountId,
        );
        return camelRow(row);
      },
    );
  }
  async revoke(context: MutationContext, id: string, expectedRevision: number) {
    this.assertFoundation(context.appCode);
    return mutate(
      this.store,
      context,
      'identity:link',
      'identity.revoke',
      { id, expectedRevision },
      async (db, actor) => {
        const before = (
          await db.query(
            'SELECT i.* FROM external_identities i JOIN accounts a ON a.id=i.account_id JOIN persons p ON p.id=a.person_id WHERE i.id=$1 AND p.home_tenant_id=$2 FOR UPDATE OF i',
            [id, context.tenantId],
          )
        ).rows[0];
        if (!before) throw new HttpError(404, 'RECORD_NOT_FOUND');
        await this.target(db, actor, context.tenantId, before.account_id, true);
        if (before.revision !== expectedRevision) throw new HttpError(409, 'REVISION_CONFLICT');
        const row = (
          await db.query(
            'UPDATE external_identities SET active=false,revision=revision+1 WHERE id=$1 RETURNING *',
            [id],
          )
        ).rows[0];
        await db.query(
          'UPDATE accounts SET auth_not_before=GREATEST(auth_not_before,floor(extract(epoch FROM clock_timestamp()))::bigint),revision=revision+1 WHERE id=$1',
          [before.account_id],
        );
        await db.query('DELETE FROM sessions WHERE account_id=$1', [before.account_id]);
        await auditMutation(
          db,
          context,
          actor,
          'identity.revoked',
          'external-identity',
          id,
          before,
          row,
          before.account_id,
        );
        return camelRow(row);
      },
    );
  }
  async offboard(context: MutationContext, accountId: string, expectedRevision: number) {
    this.assertFoundation(context.appCode);
    return mutate(
      this.store,
      context,
      'accounts:manage',
      'account.offboard',
      { accountId, expectedRevision },
      async (db, actor) => {
        const before = await this.target(db, actor, context.tenantId, accountId, true);
        if (before.revision !== expectedRevision) throw new HttpError(409, 'REVISION_CONFLICT');
        const governance = new GovernanceService(this.store);
        const apps = (
          await db.query(
            'SELECT app_code FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND active UNION SELECT app_code FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND active',
            [accountId, context.tenantId],
          )
        ).rows;
        for (const app of apps)
          await governance.assertApp(db, actor, context.tenantId, app.app_code, 'access:manage');
        const grantsBefore = (
          await db.query(
            'SELECT * FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND active',
            [accountId, context.tenantId],
          )
        ).rows;
        const bindingsBefore = (
          await db.query(
            'SELECT * FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND active',
            [accountId, context.tenantId],
          )
        ).rows;
        await db.query(
          'UPDATE application_grants SET active=false,revision=revision+1 WHERE account_id=$1 AND tenant_id=$2 AND active',
          [accountId, context.tenantId],
        );
        await db.query(
          'UPDATE role_bindings SET active=false,revision=revision+1 WHERE account_id=$1 AND tenant_id=$2 AND active',
          [accountId, context.tenantId],
        );
        const row = (
          await db.query(
            'UPDATE accounts SET active=false,revision=revision+1 WHERE id=$1 RETURNING *',
            [accountId],
          )
        ).rows[0];
        await auditMutation(
          db,
          context,
          actor,
          'account.offboarded',
          'account',
          accountId,
          { account: before, grants: grantsBefore, bindings: bindingsBefore },
          {
            account: row,
            grants: grantsBefore.map((g) => ({ ...g, active: false, revision: g.revision + 1 })),
            bindings: bindingsBefore.map((b) => ({
              ...b,
              active: false,
              revision: b.revision + 1,
            })),
          },
          accountId,
        );
        return {
          account: camelRow(row),
          grantsRevoked: grantsBefore.length,
          bindingsRevoked: bindingsBefore.length,
        };
      },
    );
  }
}
