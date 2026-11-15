import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { validateLmsConfig } from '../src/lms/security.js';
import type { LmsConfig } from '../src/lms/security.js';
import { assertStagingConfig } from '../src/staging-config.js';
import type { StagingConfig } from '../src/staging-config.js';
import { stagingAppOrigin, stagingTarget } from '../src/staging-endpoints.js';

test('named staging origins are bound to the configured app and slot', () => {
  const slot = 'a';
  const target = stagingTarget(slot);
  const secret = () => randomBytes(32).toString('hex');
  const clients = (['foundation', 'probe'] as const).map((client) => {
    const code = 'aio-' + client;
    return {
      code,
      name: code,
      port: target[client],
      clientId: code,
      audience: code + '-api',
      clientSecret: secret(),
      baseUrl: stagingAppOrigin(slot, code, target[client], true),
    };
  });
  const config: StagingConfig = {
    mode: 'staging',
    slot,
    namedHosts: true,
    issuer: target.issuer,
    instanceId: randomUUID(),
    databaseUrl: `postgresql://aio_runtime:${secret()}@127.0.0.1:${target.dbPort}/${target.database}`,
    encryptionKey: secret(),
    ingressKey: secret(),
    clients,
  };
  const [foundation, probe] = clients;
  assert.ok(foundation && probe);
  assert.doesNotThrow(() => assertStagingConfig(config));
  for (const origin of [
    probe.baseUrl,
    stagingAppOrigin('b', foundation.code, foundation.port, true),
    `https://127.0.0.1:${foundation.port}`,
  ]) {
    assert.throws(
      () =>
        assertStagingConfig({ ...config, clients: [{ ...foundation, baseUrl: origin }, probe] }),
      /Invalid isolated staging client/,
    );
  }
  const lms: LmsConfig = {
    mode: 'staging',
    purpose: 'tlqm-aio-lms-staging',
    slot,
    namedHosts: true,
    instanceId: config.instanceId,
    issuer: config.issuer,
    clientId: 'aio-lms-sandbox',
    clientSecret: secret(),
    audience: 'aio-lms-sandbox-api',
    baseUrl: stagingAppOrigin(slot, 'aio-lms-sandbox', target.lms, true),
    foundationUrl: foundation.baseUrl + '/api/v1/integrations/aio-lms-sandbox/authorize',
    encryptionKey: secret(),
  };
  assert.equal(validateLmsConfig(lms), lms);
  assert.throws(
    () => validateLmsConfig({ ...lms, baseUrl: foundation.baseUrl }),
    /LMS_CONFIGURATION_INVALID/,
  );
  assert.throws(
    () =>
      validateLmsConfig({
        ...lms,
        foundationUrl: lms.foundationUrl.replace(foundation.baseUrl, probe.baseUrl),
      }),
    /LMS_CONFIGURATION_INVALID/,
  );
});
