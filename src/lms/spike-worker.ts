import * as oidc from 'openid-client';
import { importJWK, jwtVerify, SignJWT, exportJWK } from 'jose';
import type { D1Database } from './types.js';

type Env = { LMS_DB: D1Database; ISSUER: string; CLIENT_ID: string; INSTANCE_ID: string };
export default {
  async fetch(_request: Request, env: Env) {
    try {
      if (env.ISSUER !== 'http://127.0.0.1:8180/realms/aio-local')
        return Response.json({ error: 'WRONG_LOCAL_ISSUER' }, { status: 503 });
      const config = await oidc.discovery(
        new URL(env.ISSUER),
        env.CLIENT_ID,
        undefined,
        undefined,
        { execute: [oidc.allowInsecureRequests], timeout: 5 },
      );
      oidc.enableNonRepudiationChecks(config);
      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const keys = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      );
      const publicKey = await importJWK(await exportJWK(keys.publicKey), 'RS256');
      const jwt = await new SignJWT({ aud: 'local-spike', iss: env.ISSUER })
        .setProtectedHeader({ alg: 'RS256' })
        .setExpirationTime('30s')
        .sign(keys.privateKey);
      const verified = await jwtVerify(jwt, publicKey, {
        issuer: env.ISSUER,
        audience: 'local-spike',
        algorithms: ['RS256'],
      });
      const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aes,
        new TextEncoder().encode('local-spike'),
      );
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, ciphertext);
      await env.LMS_DB.prepare(
        'CREATE TABLE IF NOT EXISTS spike_marker(instance_id TEXT PRIMARY KEY,purpose TEXT NOT NULL)',
      ).run();
      await env.LMS_DB.prepare(
        'INSERT INTO spike_marker VALUES (?,?) ON CONFLICT(instance_id) DO NOTHING',
      )
        .bind(env.INSTANCE_ID, 'tlqm-aio-lms-spike')
        .run();
      const marker = await env.LMS_DB.prepare(
        'SELECT instance_id,purpose FROM spike_marker',
      ).first<{ instance_id: string; purpose: string }>();
      return Response.json({
        worker: true,
        webCrypto: new TextDecoder().decode(plaintext) === 'local-spike',
        joseSignature: verified.payload.aud === 'local-spike',
        oidcDiscovery: config.serverMetadata().issuer === env.ISSUER,
        pkce: challenge.length === 43,
        d1: marker?.instance_id === env.INSTANCE_ID && marker.purpose === 'tlqm-aio-lms-spike',
      });
    } catch (error) {
      return Response.json(
        { error: 'LMS_SPIKE_FAILED', type: error instanceof Error ? error.name : 'unknown' },
        { status: 500 },
      );
    }
  },
};
