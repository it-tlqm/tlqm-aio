import { authorize, requireLink } from './access.js';
import type { LmsPrincipal, LmsLink } from './access.js';
import { LmsOidc } from './oidc.js';
import type { LmsTokens } from './oidc.js';
import { LmsError, seal, unseal, hash, opaque } from './security.js';
import type { LmsConfig } from './security.js';
import type { D1Database, D1Statement } from './types.js';

export type LmsSession = {
  hash: string;
  account_id: string;
  employee_id: string;
  issuer: string;
  subject: string;
  sid: string;
  authenticated_at: number;
  encrypted_payload: string;
  created_at: number;
  idle_expires_at: number;
  absolute_expires_at: number;
  revision: number;
  refresh_lock: string | null;
  lock_until: number | null;
};
export type LmsAuthentication = {
  principal: LmsPrincipal;
  link: LmsLink;
  tokens: LmsTokens;
  sessionHash: string;
};
export function audit(
  db: D1Database,
  action: string,
  reason: string,
  requestId: string,
  principal?: LmsPrincipal,
  link?: LmsLink,
  details: unknown = {},
): D1Statement {
  return db
    .prepare(
      'INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,subject_account_id,employee_id,tenant_id,action,reason,request_id,details) VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      principal?.accountId ?? null,
      principal?.accountId ?? null,
      link?.employee_id ?? null,
      link?.tenant_id ?? null,
      action,
      reason,
      requestId,
      JSON.stringify(details),
    );
}
export class LmsSessions {
  constructor(
    readonly db: D1Database,
    readonly config: LmsConfig,
    readonly oidc: LmsOidc,
  ) {}
  async verify(tokens: LmsTokens) {
    const access = await this.oidc.access(tokens.accessToken);
    if (
      access.sub !== tokens.subject ||
      access.sid !== tokens.sid ||
      access.auth_time !== tokens.authTime
    )
      throw new LmsError(401, 'SESSION_IDENTITY_CHANGED');
    const principal = await authorize(this.config, tokens.accessToken, tokens.subject);
    if (principal.authenticatedAt !== tokens.authTime)
      throw new LmsError(401, 'SESSION_IDENTITY_CHANGED');
    const link = await requireLink(this.db, this.config, principal);
    return { principal, link };
  }
  async create(tokens: LmsTokens, requestId: string, previousHash?: string) {
    const { principal, link } = await this.verify(tokens);
    const raw = opaque(),
      sessionHash = await hash(raw),
      now = Date.now();
    const statements: D1Statement[] = [];
    if (previousHash)
      statements.push(...this.revokeStatements(previousHash, 'login replacement', requestId));
    statements.push(
      this.db
        .prepare(
          'INSERT INTO aio_sessions(hash,account_id,employee_id,issuer,subject,sid,authenticated_at,encrypted_payload,created_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          sessionHash,
          principal.accountId,
          link.employee_id,
          this.config.issuer,
          tokens.subject,
          tokens.sid,
          tokens.authTime,
          await seal(this.config, tokens, 'session:' + sessionHash),
          now,
          now + 900000,
          now + 3600000,
        ),
      audit(this.db, 'session.created', 'OIDC login', requestId, principal, link),
    );
    await this.db.batch(statements);
    return { raw, principal, link };
  }
  private revokeStatements(
    sessionHash: string,
    reason: string,
    requestId: string,
    revision?: number,
    lease?: string,
  ): D1Statement[] {
    const where =
      'hash=?' +
      (revision === undefined ? '' : ' AND revision=?') +
      (lease === undefined ? '' : ' AND refresh_lock=?');
    const values: (string | number)[] = [
      sessionHash,
      ...(revision === undefined ? [] : [revision]),
      ...(lease === undefined ? [] : [lease]),
    ];
    const selectWhere = where.replace(/\b(hash|revision|refresh_lock)\b/g, 's.$1');
    return [
      this.db
        .prepare(
          "INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,subject_account_id,employee_id,tenant_id,action,reason,request_id,details) SELECT ?,?,s.account_id,s.account_id,s.employee_id,a.tenant_id,'session.revoked',?,?,'{}' FROM aio_sessions s JOIN aio_account_links a ON a.account_id=s.account_id WHERE " +
            selectWhere,
        )
        .bind(crypto.randomUUID(), Date.now(), reason, requestId, ...values),
      this.db.prepare('DELETE FROM aio_sessions WHERE ' + where).bind(...values),
    ];
  }
  async revoke(
    sessionHash: string,
    reason: string,
    requestId: string,
    revision?: number,
    lease?: string,
  ) {
    return this.db.batch(this.revokeStatements(sessionHash, reason, requestId, revision, lease));
  }
  async authenticate(sessionHash: string, requestId: string): Promise<LmsAuthentication> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await this.db
        .prepare('SELECT * FROM aio_sessions WHERE hash=?')
        .bind(sessionHash)
        .first<LmsSession>();
      if (!row) throw new LmsError(401, 'SESSION_EXPIRED');
      const now = Date.now();
      if (row.absolute_expires_at <= now || row.idle_expires_at <= now) {
        await this.revoke(sessionHash, 'session deadline', requestId, row.revision);
        throw new LmsError(401, 'SESSION_EXPIRED');
      }
      if (row.refresh_lock && row.lock_until! > now) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      let lease: string | undefined;
      try {
        let tokens = await unseal<LmsTokens>(
          this.config,
          row.encrypted_payload,
          'session:' + sessionHash,
        );
        if (
          tokens.subject !== row.subject ||
          tokens.sid !== row.sid ||
          tokens.authTime !== row.authenticated_at
        )
          throw new LmsError(401, 'SESSION_IDENTITY_CHANGED');
        if (tokens.expiresAt <= now + 30000) {
          lease = crypto.randomUUID();
          const locked = await this.db
            .prepare(
              'UPDATE aio_sessions SET refresh_lock=?,lock_until=? WHERE hash=? AND revision=? AND (refresh_lock IS NULL OR lock_until<?) RETURNING hash',
            )
            .bind(lease, now + 30000, sessionHash, row.revision, now)
            .first();
          if (!locked) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            continue;
          }
          tokens = await this.oidc.refresh(tokens);
          // Preserve the new rotating credential under the same lease before
          // the live Foundation check, which can fail independently of the IdP.
          const persisted = await this.db
            .prepare(
              'UPDATE aio_sessions SET encrypted_payload=? WHERE hash=? AND revision=? AND refresh_lock=? AND absolute_expires_at>? AND idle_expires_at>?',
            )
            .bind(
              await seal(this.config, tokens, 'session:' + sessionHash),
              sessionHash,
              row.revision,
              lease,
              Date.now(),
              Date.now(),
            )
            .run();
          if (persisted.meta.changes !== 1) throw new LmsError(401, 'SESSION_REVOKED');
          const verified = await this.verify(tokens);
          if (
            verified.principal.accountId !== row.account_id ||
            verified.link.employee_id !== row.employee_id
          )
            throw new LmsError(401, 'SESSION_IDENTITY_CHANGED');
          const completed = Date.now(),
            operation = crypto.randomUUID();
          const result = await this.db.batch([
            this.db
              .prepare(
                'UPDATE aio_sessions SET idle_expires_at=min(absolute_expires_at,?),revision=revision+1,refresh_lock=NULL,lock_until=NULL,last_operation_id=? WHERE hash=? AND revision=? AND refresh_lock=? AND absolute_expires_at>? AND idle_expires_at>?',
              )
              .bind(
                completed + 900000,
                operation,
                sessionHash,
                row.revision,
                lease,
                completed,
                completed,
              ),
            this.db
              .prepare(
                "INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,subject_account_id,employee_id,tenant_id,action,reason,request_id,details) SELECT ?,?,s.account_id,s.account_id,s.employee_id,a.tenant_id,'session.renewed','token rotation',?,'{}' FROM aio_sessions s JOIN aio_account_links a ON a.account_id=s.account_id WHERE s.hash=? AND s.last_operation_id=? AND s.revision=?",
              )
              .bind(operation, completed, requestId, sessionHash, operation, row.revision + 1),
          ]);
          if (result[0]!.meta.changes !== 1) throw new LmsError(401, 'SESSION_REVOKED');
          return { ...verified, tokens, sessionHash };
        }
        const verified = await this.verify(tokens);
        if (
          verified.principal.accountId !== row.account_id ||
          verified.link.employee_id !== row.employee_id
        )
          throw new LmsError(401, 'SESSION_IDENTITY_CHANGED');
        const changed = await this.db
          .prepare(
            'UPDATE aio_sessions SET idle_expires_at=min(absolute_expires_at,?) WHERE hash=? AND revision=? AND refresh_lock IS NULL AND absolute_expires_at>? AND idle_expires_at>?',
          )
          .bind(Date.now() + 900000, sessionHash, row.revision, Date.now(), Date.now())
          .run();
        if (changed.meta.changes !== 1) continue;
        return { ...verified, tokens, sessionHash };
      } catch (error) {
        if (error instanceof LmsError && (error.status === 401 || error.status === 403))
          await this.revoke(sessionHash, error.code, requestId, row.revision, lease);
        if (lease)
          await this.db
            .prepare(
              'UPDATE aio_sessions SET refresh_lock=NULL,lock_until=NULL,revision=revision+1 WHERE hash=? AND revision=? AND refresh_lock=?',
            )
            .bind(sessionHash, row.revision, lease)
            .run();
        throw error;
      }
    }
    throw new LmsError(503, 'SESSION_RENEWAL_IN_PROGRESS');
  }
  async backchannel(token: string, requestId: string) {
    const logout = await this.oidc.logoutToken(token),
      operation = crypto.randomUUID();
    // Receipt insertion is the first statement; a duplicate aborts every following change.
    try {
      await this.db.batch([
        this.db
          .prepare('INSERT INTO aio_logout_receipts(jti,expires_at) VALUES (?,?)')
          .bind(logout.jti, Date.now() + 300000),
        this.db
          .prepare(
            "INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,subject_account_id,employee_id,tenant_id,action,reason,request_id,details) VALUES (?,?,NULL,NULL,NULL,NULL,'session.backchannel_logout','signed IdP logout',?,'{}')",
          )
          .bind(operation, Date.now(), requestId),
        this.db
          .prepare(
            'DELETE FROM aio_sessions WHERE issuer=? AND ((? IS NOT NULL AND sid=?) OR (? IS NULL AND subject=?))',
          )
          .bind(this.config.issuer, logout.sid, logout.sid, logout.sid, logout.subject),
      ]);
    } catch (error) {
      if (
        String((error as Error).message).includes(
          'UNIQUE constraint failed: aio_logout_receipts.jti',
        )
      )
        return;
      throw error;
    }
  }
}
