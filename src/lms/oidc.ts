import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { LmsError, validateLmsConfig } from './security.js';
import type { LmsConfig } from './security.js';

export type LmsTransaction = { state: string; nonce: string; verifier: string };
export type LmsTokens = {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  subject: string;
  sid: string;
  authTime: number;
  expiresAt: number;
  nonce: string;
};
export class LmsOidc {
  private constructor(
    readonly local: LmsConfig,
    readonly config: oidc.Configuration,
    private readonly keys: ReturnType<typeof createRemoteJWKSet>,
  ) {}
  private availableKeys: JWTVerifyGetKey = async (header, token) => {
    try {
      return await this.keys(header, token);
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
      throw new LmsError(503, 'IDENTITY_UNAVAILABLE');
    }
  };
  private async reloadKeys() {
    try {
      await this.keys.reload();
    } catch {
      throw new LmsError(503, 'IDENTITY_UNAVAILABLE');
    }
  }
  static async create(local: LmsConfig) {
    validateLmsConfig(local);
    let config;
    try {
      config = await oidc.discovery(
        new URL(local.issuer),
        local.clientId,
        local.clientSecret,
        undefined,
        { timeout: 5, ...(local.mode === 'local' && { execute: [oidc.allowInsecureRequests] }) },
      );
    } catch {
      throw new LmsError(503, 'IDENTITY_UNAVAILABLE');
    }
    const metadata = config.serverMetadata();
    const issuer = new URL(local.issuer);
    for (const field of [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'introspection_endpoint',
      'end_session_endpoint',
    ] as const) {
      const endpoint = metadata[field];
      if (
        typeof endpoint !== 'string' ||
        new URL(endpoint).origin !== issuer.origin ||
        !new URL(endpoint).pathname.startsWith(issuer.pathname + '/')
      )
        throw new LmsError(503, 'IDENTITY_CONFIGURATION_INVALID');
    }
    return new LmsOidc(
      local,
      config,
      createRemoteJWKSet(new URL(metadata.jwks_uri!), {
        timeoutDuration: 5000,
        cooldownDuration: 1000,
      }),
    );
  }
  private grantConfig() {
    const config = new oidc.Configuration(this.config.serverMetadata(), this.local.clientId, {
      client_secret: this.local.clientSecret,
      id_token_signed_response_alg: 'RS256',
    });
    if (this.local.mode === 'local') oidc.allowInsecureRequests(config);
    oidc.enableNonRepudiationChecks(config);
    config.timeout = 5;
    return config;
  }
  async begin(reauthenticate = false) {
    const transaction: LmsTransaction = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
    };
    const url = oidc.buildAuthorizationUrl(this.config, {
      response_type: 'code',
      scope: 'openid profile',
      redirect_uri: this.local.baseUrl + '/auth/callback',
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier),
      code_challenge_method: 'S256',
      ...(reauthenticate ? { prompt: 'login', max_age: '0' } : {}),
    });
    return { transaction, url: url.href };
  }
  async access(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.availableKeys, {
        issuer: this.local.issuer,
        audience: this.local.audience,
        algorithms: ['RS256'],
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'sid', 'auth_time'],
      });
      if (
        payload.typ !== 'Bearer' ||
        payload.azp !== this.local.clientId ||
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.auth_time !== 'number' ||
        !Number.isInteger(payload.auth_time)
      )
        throw new LmsError(401, 'INVALID_ACCESS_TOKEN');
      return payload;
    } catch (error) {
      if (error instanceof LmsError) throw error;
      const code = (error as { code?: string }).code;
      if (code === 'ERR_JWKS_TIMEOUT' || (error instanceof TypeError && !code))
        throw new LmsError(503, 'IDENTITY_UNAVAILABLE');
      throw new LmsError(401, 'INVALID_ACCESS_TOKEN');
    }
  }
  async complete(url: URL, transaction: LmsTransaction): Promise<LmsTokens> {
    try {
      const tokens = await oidc.authorizationCodeGrant(this.grantConfig(), url, {
        pkceCodeVerifier: transaction.verifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
      await this.reloadKeys();
      const access = await this.access(tokens.access_token),
        claims = tokens.claims();
      if (
        !claims ||
        claims.typ !== 'ID' ||
        !tokens.id_token ||
        !tokens.refresh_token ||
        claims.sub !== access.sub ||
        claims.sid !== access.sid ||
        claims.auth_time !== access.auth_time
      )
        throw new LmsError(401, 'OIDC_CALLBACK_REJECTED');
      return {
        accessToken: tokens.access_token,
        idToken: tokens.id_token,
        refreshToken: tokens.refresh_token,
        subject: access.sub!,
        sid: access.sid as string,
        authTime: access.auth_time as number,
        expiresAt: access.exp! * 1000,
        nonce: transaction.nonce,
      };
    } catch (error) {
      if (error instanceof LmsError && error.status === 503) throw error;
      throw new LmsError(401, 'OIDC_CALLBACK_REJECTED');
    }
  }
  async refresh(previous: LmsTokens): Promise<LmsTokens> {
    let tokens;
    try {
      tokens = await oidc.refreshTokenGrant(this.grantConfig(), previous.refreshToken);
    } catch (error) {
      if (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant')
        throw new LmsError(401, 'SESSION_REVOKED');
      throw new LmsError(503, 'IDENTITY_UNAVAILABLE');
    }
    await this.reloadKeys();
    const access = await this.access(tokens.access_token),
      claims = tokens.claims();
    if (
      access.sub !== previous.subject ||
      access.sid !== previous.sid ||
      access.auth_time !== previous.authTime ||
      (claims &&
        (claims.typ !== 'ID' ||
          claims.sub !== previous.subject ||
          (claims.sid !== undefined && claims.sid !== previous.sid) ||
          (claims.auth_time !== undefined && claims.auth_time !== previous.authTime) ||
          (claims.nonce !== undefined && claims.nonce !== previous.nonce)))
    )
      throw new LmsError(401, 'SESSION_IDENTITY_CHANGED');
    return {
      ...previous,
      accessToken: tokens.access_token,
      idToken: tokens.id_token ?? previous.idToken,
      refreshToken: tokens.refresh_token ?? previous.refreshToken,
      expiresAt: access.exp! * 1000,
    };
  }
  endSession() {
    return oidc.buildEndSessionUrl(this.config, {
      client_id: this.local.clientId,
      post_logout_redirect_uri: this.local.baseUrl + '/',
    }).href;
  }
  async logoutToken(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.availableKeys, {
        issuer: this.local.issuer,
        audience: this.local.clientId,
        algorithms: ['RS256'],
        typ: 'logout+jwt',
        maxTokenAge: 120,
        requiredClaims: ['iat', 'jti', 'events'],
      });
      const events = payload.events as Record<string, unknown> | undefined;
      if (
        payload.typ !== 'Logout' ||
        payload.nonce !== undefined ||
        typeof payload.jti !== 'string' ||
        !events ||
        !Object.hasOwn(events, 'http://schemas.openid.net/event/backchannel-logout') ||
        (typeof payload.sid !== 'string' && typeof payload.sub !== 'string')
      )
        throw new Error('Invalid logout');
      return {
        jti: payload.jti,
        sid: typeof payload.sid === 'string' ? payload.sid : null,
        subject: typeof payload.sub === 'string' ? payload.sub : null,
      };
    } catch (error) {
      if (error instanceof LmsError && error.status === 503) throw error;
      throw new LmsError(401, 'LOGOUT_TOKEN_REJECTED');
    }
  }
}
