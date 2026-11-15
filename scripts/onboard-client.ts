import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import pg from 'pg';
import { chromium } from '@playwright/test';
import * as oidc from 'openid-client';
import { loadLocalConfig, applicationDatabaseUrl, assertLocalClients } from '../src/config.js';
import type { ClientConfig } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import type { MutationContext } from '../src/management/mutations.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { OidcClient } from '../src/oidc.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import {
  parseClientManifest,
  manifestClient,
  clientRepresentation,
  verifyClientRegistration,
} from './client-contract.js';
import {
  recordClientProvisioning,
  expireClientSessions,
  claimLocalFormsReservation,
} from './client-registry.js';

let stage = 'manifest';
const pools: pg.Pool[] = [];
try {
  const mode = process.argv[3] ?? 'provision';
  if (!['provision', 'verify', 'disable', 'activate'].includes(mode))
    throw new Error('Invalid client operation.');
  const path = resolve(process.argv[2] ?? 'infrastructure/local/clients/aio-onboarding.json');
  const within = relative(resolve('infrastructure/local/clients'), path);
  if (within.startsWith('..') || isAbsolute(within) || !within.endsWith('.json'))
    throw new Error('Manifest must be in infrastructure/local/clients.');
  const manifest = parseClientManifest(JSON.parse(await readFile(path, 'utf8')));
  const runtime = await loadLocalConfig();
  const originalRuntime = await readFile('.local/runtime.json', 'utf8');
  const runtimeClient = runtime.clients.find((client) => client.code === manifest.code);
  if (mode === 'verify' && !runtimeClient)
    throw new Error('Verification requires an already registered runtime client.');
  if (
    runtime.clients.some((client) => client.port === manifest.port && client.code !== manifest.code)
  )
    throw new Error('Client port already belongs to another manifest.');
  if (
    runtimeClient &&
    (runtimeClient.baseUrl !== 'http://127.0.0.1:' + manifest.port ||
      runtimeClient.kind !== (manifest.version === 1 ? 'integration-probe' : manifest.kind))
  )
    throw new Error('Cannot replace an existing client contract.');
  for (const test of [false, true]) {
    const pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, test), max: 2 });
    pools.push(pool);
    const marker = (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose;
    if (marker !== (test ? 'tlqm-aio-test' : 'tlqm-aio-local'))
      throw new Error('Unexpected local database marker.');
  }
  stage = 'MFA actor verification';
  const browser = await chromium.launch({ headless: true });
  let proof;
  try {
    proof = await authenticateMfaFixture(browser, runtime, ids.admin);
  } finally {
    await browser.close();
  }
  const identity = {
    issuer: runtime.issuer,
    subject: proof.subject,
    authenticatedAt: proof.authTime,
    authenticationMethods: proof.authenticationMethods ?? [],
  };
  const context = (operation: string): MutationContext => ({
    identity,
    appCode: 'aio-foundation',
    tenantId: ids.tenantA,
    requestId: 'client-onboard-' + randomUUID(),
    idempotencyKey: randomUUID(),
    reason: 'Local integration client ' + mode + ': ' + operation,
  });
  const stores = pools.map((pool) => new Store(pool));
  const governance = stores.map((store) => new GovernanceService(store));
  stage = 'registry preflight';
  for (const [index, store] of stores.entries()) {
    const actor = await store.principal(identity, 'aio-foundation');
    if (actor.accountId !== ids.admin) throw new Error('Unexpected operator account mapping.');
    store.require(actor, 'applications:create', ids.tenantA);
    let row = (await store.pool.query('SELECT * FROM applications WHERE code=$1', [manifest.code]))
      .rows[0];
    if (
      mode === 'provision' &&
      manifest.version === 2 &&
      manifest.code === 'aio-forms' &&
      row?.protected &&
      row?.status === 'planned'
    )
      row = await claimLocalFormsReservation(store, context('claim reserved Forms application'), {
        code: manifest.code,
        name: manifest.name,
        baseUrl: 'http://127.0.0.1:' + manifest.port,
      });
    if (!row && mode !== 'provision') throw new Error('Register the client before this operation.');
    if (row) {
      await governance[index]!.assertApp(
        store.pool,
        actor,
        ids.tenantA,
        manifest.code,
        'applications:manage',
      );
      if (
        row.owner_tenant_id !== ids.tenantA ||
        row.launch_url !== 'http://127.0.0.1:' + manifest.port
      )
        throw new Error('Registry owner or launch URL differs from manifest.');
      if (row.status === 'disabled' && mode === 'provision')
        throw new Error('Provisioning never reactivates a disabled application.');
    }
  }
  for (const [index, store] of stores.entries()) {
    if (
      !(await store.pool.query('SELECT 1 FROM applications WHERE code=$1', [manifest.code]))
        .rowCount
    )
      await governance[index]!.saveApplication(context('register planned app'), {
        code: manifest.code,
        name: manifest.name,
        launchUrl: 'http://127.0.0.1:' + manifest.port,
        status: 'planned',
      });
  }
  stage = 'local client receipt';
  if (mode !== 'verify') await mkdir('.local/clients', { recursive: true });
  const receiptPath = '.local/clients/' + manifest.code + '.json';
  let receipt: { instanceId: string; client: ClientConfig; keycloakId?: string } | undefined;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!receipt) {
    if (runtimeClient || mode !== 'provision')
      throw new Error('Missing provisioning receipt; do not regenerate credentials.');
    receipt = {
      instanceId: runtime.instanceId,
      client: manifestClient(manifest, randomBytes(32).toString('hex')),
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const client = receipt.client;
  const expected = manifestClient(manifest, client.clientSecret);
  if (
    receipt.instanceId !== runtime.instanceId ||
    JSON.stringify(expected) !== JSON.stringify(client) ||
    (runtimeClient && runtimeClient.clientSecret !== client.clientSecret)
  )
    throw new Error('Provisioning receipt does not match this instance and manifest.');
  assertLocalClients([...runtime.clients.filter((value) => value.code !== client.code), client]);
  const admin = await localKeycloakAdmin(runtime);
  let records = (await (
    await admin('/clients?clientId=' + encodeURIComponent(client.clientId))
  ).json()) as { id: string; clientId: string }[];
  if (records.length > 1) throw new Error('Ambiguous IdP client.');
  if (!records.length) {
    if (receipt.keycloakId || mode !== 'provision')
      throw new Error('A previously provisioned IdP client is missing; operator review required.');
    stage = 'create local confidential client';
    await admin('/clients', 'POST', clientRepresentation(client, runtime.instanceId));
    records = (await (
      await admin('/clients?clientId=' + encodeURIComponent(client.clientId))
    ).json()) as { id: string; clientId: string }[];
  }
  const record = records[0];
  if (
    !record ||
    record.clientId !== client.clientId ||
    (receipt.keycloakId && receipt.keycloakId !== record.id)
  )
    throw new Error('IdP client ownership mismatch.');
  stage = 'verify live OIDC contract';
  const representation = (await (await admin('/clients/' + record.id)).json()) as Record<
    string,
    unknown
  >;
  verifyClientRegistration(
    client,
    runtime.instanceId,
    representation,
    ['disable', 'activate'].includes(mode),
  );
  receipt.keycloakId = record.id;
  if (mode !== 'verify') {
    await writeFile(receiptPath + '.next', JSON.stringify(receipt, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename(receiptPath + '.next', receiptPath);
  }
  if (mode === 'disable') {
    // Remove app access before disabling IdP login. Reruns preserve the disabled state and credentials.
    for (const [index, store] of stores.entries()) {
      const row = (
        await store.pool.query('SELECT revision,status FROM applications WHERE code=$1', [
          client.code,
        ])
      ).rows[0];
      if (row.status !== 'disabled')
        await governance[index]!.saveApplication(
          context('disable registry'),
          { status: 'disabled' },
          client.code,
          row.revision,
        );
      await expireClientSessions(store, context('revoke BFF sessions'), client.code);
    }
    // Omitting webOrigins on update makes Keycloak derive new CORS origins from redirectUris.
    await admin('/clients/' + record.id, 'PUT', { enabled: false, webOrigins: [] });
    verifyClientRegistration(
      client,
      runtime.instanceId,
      await (await admin('/clients/' + record.id)).json(),
      true,
    );
  } else {
    if (mode === 'activate' && representation.enabled === false)
      await admin('/clients/' + record.id, 'PUT', { enabled: true, webOrigins: [] });
    const connection = await OidcClient.create(runtime, client);
    // A syntactically invalid probe returns inactive only after successful confidential-client authentication.
    const probe = await oidc.tokenIntrospection(connection.config, 'local-onboarding-probe');
    if (probe.active) throw new Error('Unexpected introspection probe response.');
    if (!runtimeClient) {
      if ((await readFile('.local/runtime.json', 'utf8')) !== originalRuntime)
        throw new Error('Runtime changed concurrently; retry without overwriting it.');
      runtime.clients.push(client);
      await writeFile(
        '.local/runtime.onboarding.next.json',
        JSON.stringify(runtime, null, 2) + '\n',
        { mode: 0o600 },
      );
      await rename('.local/runtime.onboarding.next.json', '.local/runtime.json');
    }
    if (mode !== 'verify') {
      for (const [index, store] of stores.entries()) {
        stage = 'record provisioning and activation';
        const row = await recordClientProvisioning(store, context('verify provisioning'), client);
        if (row.status !== 'active')
          await governance[index]!.saveApplication(
            context('activate verified client'),
            { status: 'active' },
            client.code,
            row.revision,
          );
        // Create only missing fixtures. Existing disabled roles/bindings or revoked grants remain unchanged.
        // Application manifests never inherit the probe's demonstration user or role.
        if (client.kind !== 'integration-probe') continue;
        if (
          !(
            await store.pool.query(
              "SELECT 1 FROM permission_catalog WHERE app_code=$1 AND code='integration:read'",
              [client.code],
            )
          ).rowCount
        )
          await governance[index]!.savePermission(context('permission catalog'), {
            appCode: client.code,
            code: 'integration:read',
            name: 'Đọc thông tin client tích hợp',
          });
        if (
          !(
            await store.pool.query(
              "SELECT 1 FROM app_roles WHERE tenant_id=$1 AND app_code=$2 AND code='integration-reader'",
              [ids.tenantA, client.code],
            )
          ).rowCount
        )
          await governance[index]!.saveRole(context('fixture role'), {
            appCode: client.code,
            code: 'integration-reader',
            name: 'Người dùng thử tích hợp',
            permissions: ['integration:read'],
          });
        if (
          !(
            await store.pool.query(
              'SELECT 1 FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
              [ids.learner, ids.tenantA, client.code],
            )
          ).rowCount
        )
          await governance[index]!.saveGrant(context('fixture grant'), {
            appCode: client.code,
            accountId: ids.learner,
            active: true,
          });
        if (
          !(
            await store.pool.query(
              "SELECT 1 FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 AND role_code='integration-reader'",
              [ids.learner, ids.tenantA, client.code],
            )
          ).rowCount
        )
          await governance[index]!.saveBinding(context('fixture binding'), {
            appCode: client.code,
            accountId: ids.learner,
            roleCode: 'integration-reader',
          });
      }
    }
  }
  const status = [];
  for (const [index, store] of stores.entries()) {
    const row = (
      await store.pool.query(
        'SELECT status,oidc_client_id,oidc_audience,provisioned_at FROM applications WHERE code=$1',
        [client.code],
      )
    ).rows[0];
    if (
      mode !== 'disable' &&
      (!row.provisioned_at ||
        row.oidc_client_id !== client.clientId ||
        row.oidc_audience !== client.audience ||
        row.status !== 'active')
    )
      throw new Error('Registry is not active with verified provisioning metadata.');
    status.push({
      database: index === 0 ? 'aio_foundation' : 'aio_foundation_test',
      status: row.status,
    });
  }
  await mkdir('.local/evidence', { recursive: true });
  await writeFile(
    client.code === 'aio-onboarding'
      ? '.local/evidence/client-onboarding.json'
      : '.local/evidence/client-onboarding-' + client.code + '.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        code: client.code,
        issuer: runtime.issuer,
        clientId: client.clientId,
        audience: client.audience,
        baseUrl: client.baseUrl,
        mode,
        contractVersion: manifest.version,
        registry: status,
        fingerprint: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Local client ' +
      client.code +
      ': ' +
      mode +
      ' verified; credentials preserved in ignored local storage.',
  );
} catch (error) {
  console.error(
    'Client onboarding failed at: ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). No credentials, tokens or IdP payloads logged.',
  );
  process.exitCode = 1;
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
}
