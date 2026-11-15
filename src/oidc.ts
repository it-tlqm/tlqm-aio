import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { ClientConfig, AppRuntime } from './config.js';
import { assertStagingConfig } from './staging-config.js';
import { HttpError } from './security.js';

export type LoginTransaction = {
  state: string;
  nonce: string;
  verifier: string;
  purpose?: 'identity-proof';
};
export type LoginTokens = {
  accessToken: string;
  idToken: string;
  subject: string;
  sid: string | null;
  expiresAt: number;
  refreshToken?: string;
  nonce?: string;
  authTime?: number;
  authenticationMethods?: string[];
};
export async function verifyAccessToken(
  token: string,
  key: JWTVerifyGetKey,
  issuer: string,
  audience: string,
  clientId: string,
) {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat'],
    });
    if (payload.typ !== 'Bearer' || typeof payload.sub !== 'string' || payload.azp !== clientId)
      throw new Error('Invalid access token type, subject or authorized party.');
    const methods =
      Array.isArray(payload.amr) && payload.amr.every((value) => typeof value === 'string')
        ? (payload.amr as string[])
        : undefined;
    const authTime =
      typeof payload.auth_time === 'number' &&
      Number.isInteger(payload.auth_time) &&
      payload.auth_time >= 0
        ? payload.auth_time
        : undefined;
    return {
      issuer,
      subject: payload.sub,
      ...(methods ? { authenticationMethods: methods } : {}),
      ...(authTime === undefined ? {} : { authenticatedAt: authTime }),
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 503) throw error;
    throw new HttpError(401, 'INVALID_ACCESS_TOKEN');
  }
}
export class OidcClient {
  private constructor(
    public config: oidc.Configuration,
    public runtime: AppRuntime,
    public app: ClientConfig,
    private keys: JWTVerifyGetKey,
    private reloadKeys: () => Promise<void>,
  ) {}
  static async create(runtime: AppRuntime, app: ClientConfig) {
    // HTTP is allowed solely for the fixed loopback local issuer, never from a request parameter.
    if (runtime.mode === 'staging') assertStagingConfig(runtime);
    else if (
      runtime.mode !== 'local' ||
      runtime.issuer !== 'http://127.0.0.1:8180/realms/aio-local'
    )
      throw new Error('Local issuer required.');
    const config = await oidc.discovery(
      new URL(runtime.issuer),
      app.clientId,
      app.clientSecret,
      undefined,
      { timeout: 5, ...(runtime.mode === 'local' && { execute: [oidc.allowInsecureRequests] }) },
    );
    oidc.enableNonRepudiationChecks(config);
    const metadata = config.serverMetadata();
    if (runtime.mode === 'staging') {
      const origin = new URL(runtime.issuer).origin;
      for (const endpoint of [
        metadata.authorization_endpoint,
        metadata.token_endpoint,
        metadata.introspection_endpoint,
        metadata.end_session_endpoint,
      ])
        if (!endpoint || new URL(endpoint).origin !== origin)
          throw new Error('Unexpected staging identity endpoint.');
    }
    const jwks = metadata.jwks_uri;
    if (!jwks || new URL(jwks).origin !== new URL(runtime.issuer).origin)
      throw new Error('Unexpected JWKS origin.');
    const remoteKeys = createRemoteJWKSet(new URL(jwks), {
      timeoutDuration: 5000,
      cooldownDuration: 1000,
    });
    const availableKeys: JWTVerifyGetKey = async (header, token) => {
      try {
        return await remoteKeys(header, token);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          code &&
          [
            'ERR_JWKS_NO_MATCHING_KEY',
            'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
            'ERR_JOSE_ALG_NOT_ALLOWED',
            'ERR_JWS_INVALID',
            'ERR_JWT_INVALID',
          ].includes(code)
        )
          throw error;
        throw new HttpError(503, 'IDENTITY_UNAVAILABLE');
      }
    };
    return new OidcClient(config, runtime, app, availableKeys, async () => {
      try {
        await remoteKeys.reload();
      } catch {
        throw new HttpError(503, 'IDENTITY_UNAVAILABLE');
      }
    });
  }
  private grantConfiguration() {
    // Fresh signature-verification context: do not inherit a stale ID-token JWKS cache across key rollover.
    // Pinned discovery metadata, PKCE/state/nonce and non-repudiation checks remain unchanged.
    const configuration = new oidc.Configuration(this.config.serverMetadata(), this.app.clientId, {
      client_secret: this.app.clientSecret,
      id_token_signed_response_alg: 'RS256',
    });
    if (this.runtime.mode === 'local') oidc.allowInsecureRequests(configuration);
    oidc.enableNonRepudiationChecks(configuration);
    configuration.timeout = 5;
    return configuration;
  }
  async begin(reauthenticate = false) {
    const transaction: LoginTransaction = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
    };
    const url = oidc.buildAuthorizationUrl(this.config, {
      response_type: 'code',
      scope: 'openid profile',
      redirect_uri: this.app.baseUrl + '/auth/callback',
      code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier),
      code_challenge_method: 'S256',
      state: transaction.state,
      nonce: transaction.nonce,
      ...(reauthenticate ? { prompt: 'login' } : {}),
    });
    return { transaction, url: url.href };
  }
  async complete(url: URL, transaction: LoginTransaction): Promise<LoginTokens> {
    try {
      const tokens = await oidc.authorizationCodeGrant(this.grantConfiguration(), url, {
        pkceCodeVerifier: transaction.verifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || !tokens.id_token || claims.typ !== 'ID' || typeof claims.sub !== 'string')
        throw new Error('Missing identity.');
      await this.reloadKeys();
      const identity = await this.access(tokens.access_token);
      if (identity.subject !== claims.sub) throw new Error('Token subject mismatch.');
      return {
        accessToken: tokens.access_token,
        idToken: tokens.id_token,
        subject: claims.sub,
        sid: typeof claims.sid === 'string' ? claims.sid : null,
        expiresAt: this.tokenExpiry(tokens.access_token, tokens.expires_in),
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        nonce: transaction.nonce,
        ...(typeof claims.auth_time === 'number' ? { authTime: claims.auth_time } : {}),
        ...(identity.authenticationMethods
          ? { authenticationMethods: identity.authenticationMethods }
          : {}),
      };
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 503) throw error;
      throw new HttpError(401, 'OIDC_CALLBACK_REJECTED');
    }
  }
  private tokenExpiry(token: string, expiresIn?: number): number {
    // Only called after signature, issuer, audience and introspection checks have passed.
    const exp = decodeJwt(token).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp))
      throw new HttpError(401, 'INVALID_ACCESS_TOKEN');
    return Math.min(exp * 1000, Date.now() + (expiresIn ?? 300) * 1000);
  }
  async refresh(previous: LoginTokens): Promise<LoginTokens> {
    if (!previous.refreshToken) throw new HttpError(401, 'SESSION_EXPIRED');
    let tokens;
    try {
      tokens = await oidc.refreshTokenGrant(this.grantConfiguration(), previous.refreshToken);
    } catch (error) {
      if (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant')
        throw new HttpError(401, 'SESSION_REVOKED');
      // A failed dependency must never extend the session or authorize from stale claims.
      throw new HttpError(503, 'IDENTITY_UNAVAILABLE');
    }
    await this.reloadKeys();
    const identity = await this.access(tokens.access_token);
    const claims = tokens.claims();
    const accessClaims = decodeJwt(tokens.access_token);
    if (
      identity.subject !== previous.subject ||
      accessClaims.sid !== previous.sid ||
      (claims &&
        (claims.typ !== 'ID' ||
          claims.sub !== previous.subject ||
          (claims.sid !== undefined && claims.sid !== previous.sid) ||
          (claims.nonce !== undefined && claims.nonce !== previous.nonce) ||
          (previous.authTime !== undefined && claims.auth_time !== previous.authTime)))
    )
      throw new HttpError(401, 'SESSION_IDENTITY_CHANGED');
    return {
      ...previous,
      accessToken: tokens.access_token,
      idToken: tokens.id_token ?? previous.idToken,
      refreshToken: tokens.refresh_token ?? previous.refreshToken,
      expiresAt: this.tokenExpiry(tokens.access_token, tokens.expires_in),
      authenticationMethods: identity.authenticationMethods ?? [],
    };
  }
  async access(token: string) {
    const identity = await verifyAccessToken(
      token,
      this.keys,
      this.runtime.issuer,
      this.app.audience,
      this.app.clientId,
    );
    let result;
    try {
      result = await oidc.tokenIntrospection(this.config, token);
    } catch {
      throw new HttpError(503, 'IDENTITY_UNAVAILABLE');
    }
    if (!result.active || result.sub !== identity.subject) {
      throw new HttpError(401, 'SESSION_REVOKED');
    }
    return identity;
  }
  async logoutToken(token: string): Promise<{ jti: string; sid?: string; subject?: string }> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.runtime.issuer,
        audience: this.app.clientId,
        algorithms: ['RS256'],
        typ: 'logout+jwt',
        maxTokenAge: 120,
        requiredClaims: ['iat', 'jti', 'events'],
      });
      const events = payload.events as Record<string, unknown> | undefined;
      if (
        payload.typ !== 'Logout' ||
        payload.nonce !== undefined ||
        !events ||
        !Object.hasOwn(events, 'http://schemas.openid.net/event/backchannel-logout') ||
        typeof payload.jti !== 'string' ||
        (typeof payload.sid !== 'string' && typeof payload.sub !== 'string')
      )
        throw new Error('Invalid logout event.');
      return {
        jti: payload.jti,
        ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}),
        ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}),
      };
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 503) throw error;
      throw new HttpError(401, 'INVALID_LOGOUT_TOKEN');
    }
  }
  endSession() {
    return oidc.buildEndSessionUrl(this.config, {
      post_logout_redirect_uri: this.app.baseUrl + '/',
      client_id: this.app.clientId,
    }).href;
  }
}
