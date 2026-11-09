import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { ClientConfig, LocalConfig } from './config.js';
import { HttpError } from './security.js';

export type LoginTransaction = { state: string; nonce: string; verifier: string };
export type LoginTokens = {
  accessToken: string;
  idToken: string;
  subject: string;
  sid: string | null;
  expiresAt: number;
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
    if (typeof payload.sub !== 'string' || payload.azp !== clientId)
      throw new Error('Invalid authorized party.');
    return { issuer, subject: payload.sub };
  } catch {
    throw new HttpError(401, 'INVALID_ACCESS_TOKEN');
  }
}
export class OidcClient {
  private constructor(
    public config: oidc.Configuration,
    public runtime: LocalConfig,
    public app: ClientConfig,
    private keys: JWTVerifyGetKey,
  ) {}
  static async create(runtime: LocalConfig, app: ClientConfig) {
    // HTTP is allowed solely for the fixed loopback local issuer, never from a request parameter.
    if (runtime.mode !== 'local' || runtime.issuer !== 'http://127.0.0.1:8180/realms/aio-local')
      throw new Error('Local issuer required.');
    const config = await oidc.discovery(
      new URL(runtime.issuer),
      app.clientId,
      app.clientSecret,
      undefined,
      { execute: [oidc.allowInsecureRequests], timeout: 5 },
    );
    oidc.enableNonRepudiationChecks(config);
    const jwks = config.serverMetadata().jwks_uri;
    if (!jwks || new URL(jwks).origin !== new URL(runtime.issuer).origin)
      throw new Error('Unexpected JWKS origin.');
    return new OidcClient(
      config,
      runtime,
      app,
      createRemoteJWKSet(new URL(jwks), { timeoutDuration: 5000, cooldownDuration: 1000 }),
    );
  }
  async begin() {
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
    });
    return { transaction, url: url.href };
  }
  async complete(url: URL, transaction: LoginTransaction): Promise<LoginTokens> {
    try {
      const tokens = await oidc.authorizationCodeGrant(this.config, url, {
        pkceCodeVerifier: transaction.verifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || !tokens.id_token || typeof claims.sub !== 'string')
        throw new Error('Missing identity.');
      const identity = await this.access(tokens.access_token);
      if (identity.subject !== claims.sub) throw new Error('Token subject mismatch.');
      return {
        accessToken: tokens.access_token,
        idToken: tokens.id_token,
        subject: claims.sub,
        sid: typeof claims.sid === 'string' ? claims.sid : null,
        expiresAt: Math.min(Date.now() + 300_000, Date.now() + (tokens.expires_in ?? 300) * 1000),
      };
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 503) throw error;
      throw new HttpError(401, 'OIDC_CALLBACK_REJECTED');
    }
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
        maxTokenAge: 120,
        requiredClaims: ['iat', 'jti', 'events'],
      });
      const events = payload.events as Record<string, unknown> | undefined;
      if (
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
    } catch {
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
