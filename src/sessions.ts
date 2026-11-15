import type { ClientConfig, AppRuntime } from './config.js';
import type { LoginTokens, OidcClient } from './oidc.js';
import { HttpError, seal, unseal } from './security.js';
import type { Store } from './store.js';
import { databaseUnavailable } from './dependencies.js';

export const SESSION_MAX_MS = 60 * 60_000;
export const SESSION_IDLE_MS = 15 * 60_000;
const REFRESH_BEFORE_MS = 30_000;
type SessionRow = {
  account_id: string;
  issuer: string;
  subject: string;
  encrypted_payload: string;
  expires_at: Date;
  absolute_expires_at: Date;
};

export class Sessions {
  constructor(
    private store: Store,
    private runtime: AppRuntime,
    private app: ClientConfig,
    private oidc: Pick<OidcClient, 'access' | 'refresh'>,
  ) {}

  async create(hash: string, tokens: LoginTokens, requestId: string, previousHash?: string) {
    const db = await this.store.pool.connect();
    let discard = false;
    try {
      await db.query('BEGIN');
      const principal = await this.store.principal(
        {
          issuer: this.runtime.issuer,
          subject: tokens.subject,
          authenticationMethods: tokens.authenticationMethods ?? [],
          ...(tokens.authTime === undefined ? {} : { authenticatedAt: tokens.authTime }),
        },
        this.app.code,
        db,
      );
      const now = Date.now();
      const absolute = tokens.refreshToken ? now + SESSION_MAX_MS : tokens.expiresAt;
      if (previousHash)
        await db.query('DELETE FROM sessions WHERE hash=$1 AND app_code=$2', [
          previousHash,
          this.app.code,
        ]);
      await db.query(
        'INSERT INTO sessions(hash,app_code,account_id,issuer,subject,sid,encrypted_payload,expires_at,absolute_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          hash,
          this.app.code,
          principal.accountId,
          this.runtime.issuer,
          tokens.subject,
          tokens.sid,
          seal(tokens, this.runtime.encryptionKey, 'session:' + this.app.code),
          new Date(Math.min(absolute, now + SESSION_IDLE_MS)),
          new Date(absolute),
        ],
      );
      await this.store.audit(
        principal.accountId,
        principal.accountId,
        null,
        this.app.code,
        'auth.login',
        null,
        requestId,
        db,
      );
      await db.query('COMMIT');
      return { absoluteExpiresAt: absolute };
    } catch (error) {
      discard = databaseUnavailable(error);
      if (!discard) await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release(discard);
    }
  }

  async logout(hash: string, requestId: string) {
    const db = await this.store.pool.connect();
    let discard = false;
    try {
      await db.query('BEGIN');
      const row = (
        await db.query('DELETE FROM sessions WHERE hash=$1 AND app_code=$2 RETURNING account_id', [
          hash,
          this.app.code,
        ])
      ).rows[0];
      if (row)
        await this.store.audit(
          row.account_id,
          row.account_id,
          null,
          this.app.code,
          'auth.logout',
          null,
          requestId,
          db,
        );
      await db.query('COMMIT');
    } catch (error) {
      discard = databaseUnavailable(error);
      if (!discard) await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release(discard);
    }
  }

  async authenticate(hash: string, requestId: string, delegateRead = false) {
    const db = await this.store.pool.connect();
    let row: SessionRow | undefined;
    let discard = false;
    try {
      await db.query('BEGIN');
      // A per-session lock prevents concurrent refresh-token reuse and resurrection after logout.
      row = (
        await db.query<SessionRow>(
          'SELECT account_id,issuer,subject,encrypted_payload,expires_at,absolute_expires_at FROM sessions WHERE hash=$1 AND app_code=$2 FOR UPDATE',
          [hash, this.app.code],
        )
      ).rows[0];
      if (
        !row ||
        Math.min(row.expires_at.getTime(), row.absolute_expires_at.getTime()) <= Date.now()
      )
        throw new HttpError(401, 'SESSION_EXPIRED');
      let tokens = unseal<LoginTokens>(
        row.encrypted_payload,
        this.runtime.encryptionKey,
        'session:' + this.app.code,
      );
      if (row.issuer !== this.runtime.issuer || row.subject !== tokens.subject)
        throw new HttpError(401, 'SESSION_IDENTITY_CHANGED');
      // Resolve current account/grants before attempting a refresh, then again before allowing access.
      await this.store.principal(
        {
          issuer: row.issuer,
          subject: row.subject,
          authenticationMethods: tokens.authenticationMethods ?? [],
          ...(tokens.authTime === undefined ? {} : { authenticatedAt: tokens.authTime }),
        },
        this.app.code,
        db,
      );
      const refresh = tokens.expiresAt <= Date.now() + REFRESH_BEFORE_MS;
      if (refresh) tokens = await this.oidc.refresh(tokens);
      const identity = await this.oidc.access(tokens.accessToken);
      if (identity.issuer !== row.issuer || identity.subject !== row.subject)
        throw new HttpError(401, 'SESSION_IDENTITY_CHANGED');
      const principal = await this.store.principal(identity, this.app.code, db);
      if (principal.accountId !== row.account_id)
        throw new HttpError(401, 'SESSION_IDENTITY_CHANGED');
      const now = Date.now();
      if (Math.min(row.expires_at.getTime(), row.absolute_expires_at.getTime()) <= now)
        throw new HttpError(401, 'SESSION_EXPIRED');
      const expiresAt = Math.min(row.absolute_expires_at.getTime(), now + SESSION_IDLE_MS);
      await db.query(
        'UPDATE sessions SET encrypted_payload=$3,expires_at=$4 WHERE hash=$1 AND app_code=$2',
        [
          hash,
          this.app.code,
          refresh
            ? seal(tokens, this.runtime.encryptionKey, 'session:' + this.app.code)
            : row.encrypted_payload,
          new Date(expiresAt),
        ],
      );
      if (refresh)
        await this.store.audit(
          principal.accountId,
          principal.accountId,
          null,
          this.app.code,
          'auth.session_renewed',
          'Access token renewed within the original session maximum',
          requestId,
          db,
        );
      await db.query('COMMIT');
      return {
        identity,
        principal,
        ...(delegateRead ? { delegatedAccessToken: tokens.accessToken } : {}),
        expiresAt,
        absoluteExpiresAt: row.absolute_expires_at.getTime(),
      };
    } catch (error) {
      discard = databaseUnavailable(error);
      if (discard) throw error;
      if (row && error instanceof HttpError && error.statusCode === 401) {
        await db.query('DELETE FROM sessions WHERE hash=$1 AND app_code=$2', [hash, this.app.code]);
        await this.store.audit(
          row.account_id,
          row.account_id,
          null,
          this.app.code,
          'auth.session_ended',
          error.code,
          requestId,
          db,
        );
        await db.query('COMMIT');
      } else {
        await db.query('ROLLBACK');
      }
      throw error;
    } finally {
      db.release(discard);
    }
  }
}
