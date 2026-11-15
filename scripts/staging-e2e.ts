import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkServerIdentity } from 'node:tls';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import pg from 'pg';
import { bffClients } from '../src/config.js';
import type { ClientConfig } from '../src/config.js';
import { demoUsers, ids } from '../src/fixtures.js';
import { stagingAppOrigin } from '../src/staging-endpoints.js';
import { startStagingSecretStore } from './staging-secret-store.js';
import {
  loadStagingScannerTls,
  stagingFileScanner,
  stagingScannerPort,
} from '../src/staging-file-scan.js';
import type { StagingScannerTls } from '../src/staging-file-scan.js';
import {
  createStagingScannerCertificates,
  scannerTlsRelay,
  verifyStagingScannerTransport,
} from './staging-scanner-transport.js';
import { scannerTestSignature } from './staging-scan-fixture.js';
import {
  assertStagingConfig,
  stagingDatabaseTls,
  stagingModuleDatabase,
  stagingModules,
  stagingTarget,
} from '../src/staging-config.js';
import type { StagingConfig, StagingModule, StagingSlot } from '../src/staging-config.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { bootstrapFixtures } from '../src/database/bootstrap.js';
import { assertLocalDocker } from './local-docker.js';
import { fixtureTotp } from './local-totp.js';
import { provisionStagingModules, upgradeStagingModules } from './staging-business.js';
import { copyLmsStorage, verifyStoredMedia } from './lms-backup-storage.js';
import type { MediaBucket, MediaObject } from '../src/lms/types.js';
import { verifyStagingBusiness } from './staging-business-e2e.js';
import { startStagingLms } from './staging-lms.js';
import { verifyStagingLms } from './staging-lms-e2e.js';
import { verifyStagingAudit } from './staging-audit.js';
import type { AuditEvidence } from './staging-audit.js';
import { verifyStagingPersonnel } from './staging-personnel.js';
import { verifyStagingIam } from './staging-iam.js';
import {
  passwordDenylistName,
  prepareStagingPasswordDenylist,
  stagingPasswordPolicy,
  verifyStagingPasswordChange,
} from './staging-password-policy.js';
import { reportActors } from './staging-report-fixtures.js';
import { reserveStagingRequests } from './e2e-request-budget.js';
import {
  checkpointStagingPostgres,
  restoreStagingPostgres,
  restoreOperator,
} from './staging-recovery.js';
import { openStagingAuditWriter, stagingAuditDatabase } from '../src/staging-ingress-audit.js';
import {
  mixedLoadJobResults,
  provisionStagingLoadIdentities,
  seedMixedLoadJobs,
  stagingLoadIdentities,
  verifyStagingMixedLoad,
} from './staging-mixed-load.js';
import type { ReportActor, ReportSession } from './staging-report-fixtures.js';
import {
  prepareStagingInfrastructureAudit,
  stagingIngressProbes,
  stagingWorkerdProbe,
} from './staging-infrastructure-audit.js';
import {
  createStagingTelemetry,
  openTelemetryAlerts,
  writeTelemetryDashboard,
} from './staging-telemetry.js';

const execute = promisify(execFile);
const args = process.argv.slice(2);
const namedHosts = args[0] === '--named-hosts';
if (namedHosts) args.shift();
const faultDrill = args[0] === '--fault-drill';
if (faultDrill) args.shift();
const replicaDrill = args[0] === '--worker-replicas';
if (replicaDrill) args.shift();
const speechDrill = args[0] === '--screen-reader';
if (speechDrill) args.shift();
const mixedLoad = args.at(-1) === '--mixed-load';
if (mixedLoad) args.pop();
const coordinatedRecovery = args.at(-1) === '--recover';
if (coordinatedRecovery) args.pop();
const telemetryEnabled = args.at(-1) === '--telemetry' || mixedLoad;
if (args.at(-1) === '--telemetry') args.pop();
const fullRollback = args.at(-1) === '--full-rollback';
if (fullRollback) args.pop();
const scopedReports = args.at(-1) === '--scoped-reports';
const accessUi = scopedReports || args.at(-1) === '--access-ui';
const infraAudit = accessUi || args.at(-1) === '--infra-audit';
const iam = infraAudit || args.at(-1) === '--iam';
const personnel = iam || args.at(-1) === '--personnel';
const e2Audit = personnel || args.at(-1) === '--audit';
const suite =
  fullRollback ||
  e2Audit ||
  args.at(-1) === '--suite' ||
  (telemetryEnabled && !args.at(-1)?.startsWith('--'));
const business = suite || args.at(-1) === '--modules';
if (business && args.at(-1)?.startsWith('--')) args.pop();
const [release, expected, priorRelease, priorDigest, candidateImage, ...extra] =
  (mixedLoad || coordinatedRecovery || namedHosts) && args.length === 3
    ? [args[0], args[1], undefined, undefined, args[2]]
    : args;
const releaseName = /^[a-z0-9][a-z0-9-]{0,39}$/;
const manifestDigest = /^[0-9a-f]{64}$/;
if (
  !release ||
  !releaseName.test(release) ||
  !expected ||
  !manifestDigest.test(expected) ||
  (priorRelease !== undefined &&
    (!releaseName.test(priorRelease) ||
      !priorDigest ||
      !manifestDigest.test(priorDigest) ||
      priorRelease === release ||
      priorDigest === expected)) ||
  (candidateImage !== undefined && !/^sha256:[0-9a-f]{64}$/.test(candidateImage)) ||
  (infraAudit && !candidateImage) ||
  (telemetryEnabled && (!suite || !candidateImage)) ||
  (mixedLoad && (!scopedReports || fullRollback || priorRelease)) ||
  (coordinatedRecovery && (!infraAudit || mixedLoad || fullRollback || priorRelease)) ||
  (fullRollback && (!priorRelease || !candidateImage)) ||
  (namedHosts && (!iam || !candidateImage || priorRelease !== undefined || !suite)) ||
  (faultDrill &&
    (!namedHosts ||
      !scopedReports ||
      !telemetryEnabled ||
      mixedLoad ||
      coordinatedRecovery ||
      fullRollback)) ||
  (speechDrill && (!faultDrill || !process.env.AIO_STAGING_SPEECH_READER)) ||
  (replicaDrill && !faultDrill) ||
  extra.length
)
  throw new Error(
    'Usage: test:staging -- [--named-hosts [--fault-drill [--worker-replicas] [--screen-reader]]] <release> <manifest-sha256> [<prior-release> <prior-manifest-sha256> [<image-digest>]] [--modules|--suite|--audit|--personnel|--iam|--infra-audit|--access-ui|--scoped-reports] [--full-rollback] [--telemetry] [--mixed-load|--recover]',
  );
const root = await realpath('.');
const passwordList = await prepareStagingPasswordDenylist(root);
const artifactPath = (name: string) => join(root, '.local', 'releases', name, 'artifact');
const artifact = artifactPath(release);
const priorArtifact = priorRelease ? artifactPath(priorRelease) : undefined;
const fresh = () => randomBytes(32).toString('hex');
const instance = randomUUID().slice(0, 8);
const results = [];
type Promotion = Extract<
  NonNullable<Parameters<typeof verifyStagingBusiness>[7]>,
  { kind: 'target' }
>;
let workflowPromotionSource: Promotion['source'];
let stage = 'artifact and Docker preflight';
const postgres = 'sha256:9b500fc2ab1926d2bf5f02bdf88bdd26440f47c071ab3b1e2dceef63f6f1132f';
const keycloak = 'sha256:d69e717611eb7a18a51bb8295333698f80320518a52b02e01ee7448020591b2e';
const scannerImage =
  'docker.io/clamav/clamav@sha256:2a9be29239aea6c6fe17da9625f3c192f91974e61059d364e293f20277f931a3';
const relay = `
import { connect, createServer } from 'node:net';
for (const [host, port, destination, target] of JSON.parse(process.argv[1])) {
  createServer((client) => {
    const upstream = connect(target, destination);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  }).listen(port, host);
}`;

async function docker(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    return (
      await execute('docker', ['--context', 'desktop-linux', ...args], {
        env: { ...process.env, ...env },
        timeout: 40000,
        windowsHide: true,
      })
    ).stdout.trim();
  } catch {
    throw new Error('Docker ' + args.slice(0, 2).join(' ') + ' failed.');
  }
}
async function waitFor(run: () => Promise<unknown>, timeout: number) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(800);
    }
  }
}
function httpsJson(url: string, ca: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = get(url, { ca, rejectUnauthorized: true, timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTPS readiness returned ' + res.statusCode));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', reject);
  });
}

async function verifyStagingHsts(
  base: string,
  ca: string,
  path: string,
  status: number,
  host?: string,
) {
  const endpoint = new URL(base);
  const response = await new Promise<{ status: number; hsts: string }>((resolve, reject) => {
    get(
      base + path,
      {
        ca,
        rejectUnauthorized: true,
        checkServerIdentity: (_name, certificate) =>
          checkServerIdentity(endpoint.hostname, certificate),
        signal: AbortSignal.timeout(5000),
        ...(host && { headers: { host } }),
      },
      (response) => {
        response.resume();
        resolve({
          status: response.statusCode ?? 0,
          hsts: response.headers['strict-transport-security'] ?? '',
        });
      },
    ).on('error', reject);
  });
  assert.equal(response.status, status);
  const directives = response.hsts
    .toLowerCase()
    .split(';')
    .map((part) => part.trim());
  const maxAge = directives.find((value) => /^max-age=\d+$/.test(value));
  assert.ok(maxAge && Number(maxAge.split('=')[1]) >= 31536000);
  assert.ok(directives.includes('includesubdomains'));
}

async function rehearse(slot: StagingSlot) {
  const target = stagingTarget(slot);
  const name = 'tlqm-aio-stage-' + slot + '-' + instance;
  const directory = join(root, '.local', name);
  await mkdir(directory);
  const configFile = join(directory, 'runtime.json');
  const secretGrantFile = join(directory, 'runtime-grant.json');
  const coreConfigFile = join(directory, 'runtime-core.json');
  const wrongInstanceFile = join(directory, 'runtime-wrong-instance.json');
  const ingressAuditFile = join(directory, 'ingress-audit.json');
  const auditSpool = join(directory, 'audit-spool');
  const realmFile = join(directory, 'aio-staging-' + slot + '-realm.json');
  const passwordDenylist = join(directory, passwordDenylistName);
  const certFile = join(directory, 'cert.pem');
  const keyFile = join(directory, 'key.pem');
  const scannerFiles = ['server.pem', 'server-key.pem', 'client.pem', 'client-key.pem'];
  const scannerDirectory = join(directory, 'scanner');
  const scannerMount = (file: string) => [
    '--mount',
    'type=bind,source=' + join(scannerDirectory, file) + ',target=/stage/' + file + ',readonly',
  ];
  let pgPassword = fresh(),
    keycloakPassword = fresh();
  const idpOperator = iam ? { clientId: 'aio-stage-operator', secret: fresh() } : undefined;
  const endpoints: Pick<ClientConfig, 'code' | 'name' | 'port' | 'kind'>[] = [
    { code: 'aio-foundation', name: 'AIO Foundation staging', port: target.foundation },
    { code: 'aio-probe', name: 'AIO Probe staging', port: target.probe },
  ];
  const moduleDatabases = {} as Record<StagingModule, string>;
  if (business) {
    for (const module of stagingModules) {
      const db = stagingModuleDatabase(slot, module);
      moduleDatabases[module] =
        'postgresql://' + db.role + ':' + fresh() + '@127.0.0.1:' + target.dbPort + '/' + db.name;
      endpoints.push({
        code: 'aio-' + module,
        name: 'AIO ' + module + ' staging',
        port: target[module],
        kind: 'application',
      });
    }
  }
  if (suite)
    endpoints.push({
      code: 'aio-lms-sandbox',
      name: 'AIO LMS staging',
      port: target.lms,
      kind: 'external-application',
    });
  const runtime: StagingConfig = {
    mode: 'staging',
    slot,
    ...(namedHosts && { namedHosts: true }),
    instanceId: randomUUID(),
    issuer: target.issuer,
    databaseUrl:
      'postgresql://aio_runtime:' + fresh() + '@127.0.0.1:' + target.dbPort + '/' + target.database,
    encryptionKey: fresh(),
    ingressKey: fresh(),
    ...(business ? { moduleDatabases } : {}),
    clients: endpoints.map((client) => ({
      ...client,
      clientId: client.code,
      audience: client.code + '-api',
      baseUrl: stagingAppOrigin(slot, client.code, client.port, namedHosts),
      clientSecret: fresh(),
    })),
  };
  assertStagingConfig(runtime);
  const foundation = runtime.clients[0]!;
  const probe = runtime.clients[1]!;
  const coreClients = [foundation, probe];
  const lms = runtime.clients.find((client) => client.code === 'aio-lms-sandbox');
  const appHosts = runtime.clients.map(({ baseUrl }) => new URL(baseUrl).hostname);
  const otherSlot = slot === 'a' ? 'b' : 'a';
  assert.throws(
    () => assertStagingConfig({ ...runtime, slot: otherSlot }),
    /staging issuer or runtime database/,
  );
  if (business)
    assert.throws(
      () =>
        assertStagingConfig({
          ...runtime,
          moduleDatabases: { ...moduleDatabases, tasks: moduleDatabases.forms },
        }),
      /staging module database/,
    );
  assert.throws(
    () => assertStagingConfig({ ...runtime, issuer: 'http://127.0.0.1:8180/realms/aio-local' }),
    /staging issuer/,
  );
  const credentials = <T extends { id: string; username: string; name: string; tenantId: string }>(
    user: T,
  ) => ({
    ...user,
    subject: randomUUID(),
    password: fresh(),
    otpSecret: randomBytes(10).toString('hex'),
  });
  const loadIdentities = mixedLoad ? stagingLoadIdentities().map(credentials) : [];
  const users = [...demoUsers, ...(scopedReports ? Object.values(reportActors) : [])].map(
    credentials,
  );
  const admin = users.find((user) => user.id === ids.admin)!;
  const learner = users.find((user) => user.id === ids.learner)!;
  const recovery = users.find((user) => user.id === ids.recovery)!;
  const passwordActor =
    namedHosts && scopedReports && !mixedLoad && !coordinatedRecovery
      ? credentials({
          id: randomUUID(),
          username: 'stage.password-policy',
          name: 'Password fixture',
          tenantId: ids.tenantA,
        })
      : undefined;
  const realm = 'aio-staging-' + slot;
  const amr = (method: string) => ({
    alias: 'stage-amr-' + method,
    config: { 'default.reference.value': method, 'default.reference.maxAge': '3600' },
  });
  const config = {
    realm,
    enabled: true,
    sslRequired: 'all',
    registrationAllowed: false,
    resetPasswordAllowed: false,
    passwordPolicy: stagingPasswordPolicy,
    bruteForceProtected: true,
    permanentLockout: false,
    failureFactor: 8,
    waitIncrementSeconds: 30,
    maxFailureWaitSeconds: 120,
    maxDeltaTimeSeconds: 900,
    accessCodeLifespan: 60,
    accessTokenLifespan: 300,
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
    defaultSignatureAlgorithm: 'RS256',
    components: {
      'org.keycloak.keys.KeyProvider': [
        {
          name: 'aio-stage-rsa-signing',
          providerId: 'rsa-generated',
          config: { algorithm: ['RS256'], keyUse: ['SIG'], keySize: ['3072'], priority: ['100'] },
        },
        {
          name: 'aio-stage-rsa-encryption',
          providerId: 'rsa-enc-generated',
          config: { keyUse: ['ENC'], keySize: ['3072'], priority: ['100'] },
        },
      ],
    },
    ...(iam
      ? {
          eventsEnabled: true,
          eventsExpiration: 86400,
          enabledEventTypes: ['LOGIN', 'LOGIN_ERROR'],
          adminEventsEnabled: true,
          adminEventsDetailsEnabled: false,
        }
      : {}),
    browserFlow: 'stage-browser',
    authenticatorConfig: [amr('pwd'), amr('otp')],
    authenticationFlows: [
      {
        alias: 'stage-browser',
        providerId: 'basic-flow',
        topLevel: true,
        builtIn: false,
        authenticationExecutions: [
          {
            authenticator: 'auth-cookie',
            requirement: 'ALTERNATIVE',
            priority: 10,
            authenticatorFlow: false,
          },
          {
            flowAlias: 'stage-forms',
            requirement: 'ALTERNATIVE',
            priority: 20,
            authenticatorFlow: true,
          },
        ],
      },
      {
        alias: 'stage-forms',
        providerId: 'basic-flow',
        topLevel: false,
        builtIn: false,
        authenticationExecutions: [
          {
            authenticator: 'auth-username-password-form',
            authenticatorConfig: 'stage-amr-pwd',
            requirement: 'REQUIRED',
            priority: 10,
            authenticatorFlow: false,
          },
          {
            authenticator: 'auth-otp-form',
            authenticatorConfig: 'stage-amr-otp',
            requirement: 'REQUIRED',
            priority: 20,
            authenticatorFlow: false,
          },
        ],
      },
    ],
    clients: runtime.clients.map((client) => ({
      clientId: client.clientId,
      secret: client.clientSecret,
      protocol: 'openid-connect',
      enabled: true,
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: false,
      webOrigins: [],
      redirectUris: [client.baseUrl + '/auth/callback'],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': client.baseUrl + '/',
        'backchannel.logout.url':
          'https://host.docker.internal:' + client.port + '/auth/backchannel-logout',
        'backchannel.logout.session.required': 'true',
      },
      protocolMappers: [
        ...[
          ['api', 'included.custom.audience', client.audience],
          ['client', 'included.client.audience', client.clientId],
        ].map(([name, key, value]) => ({
          name: 'stage-audience-' + name,
          protocol: 'openid-connect',
          protocolMapper: 'oidc-audience-mapper',
          config: {
            [key!]: value,
            'access.token.claim': 'true',
            'introspection.token.claim': 'true',
            'id.token.claim': 'false',
          },
        })),
        {
          name: 'stage-amr',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-amr-mapper',
          config: { 'access.token.claim': 'true', 'id.token.claim': 'true' },
        },
      ],
    })),
    users: [...users, ...loadIdentities, ...(passwordActor ? [passwordActor] : [])].map((user) => ({
      id: user.subject,
      username: user.username,
      enabled: true,
      firstName: 'Stage',
      lastName: 'Fixture',
      email: user.username + '@example.test',
      emailVerified: true,
      requiredActions: user === passwordActor ? ['UPDATE_PASSWORD'] : [],
      credentials: [
        { type: 'password', value: user.password, temporary: false },
        {
          type: 'otp',
          userLabel: 'staging fixture',
          secretData: JSON.stringify({ value: user.otpSecret }),
          credentialData: JSON.stringify({
            subType: 'totp',
            digits: 6,
            counter: 0,
            period: 30,
            algorithm: 'HmacSHA1',
          }),
        },
      ],
    })),
  };
  const containers: string[] = [];
  let network = false;
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let stageLms: Awaited<ReturnType<typeof startStagingLms>> | undefined;
  let secretStore: Awaited<ReturnType<typeof startStagingSecretStore>> | undefined;
  let lmsSecrets: { clientSecret: string; encryptionKey: string } | undefined;
  let scannerEvidence:
    | {
        image: string;
        cleanProbe: true;
        standardSignature: true;
        transport: Awaited<ReturnType<typeof verifyStagingScannerTransport>>;
      }
    | undefined;
  let scannerTls: StagingScannerTls | undefined;
  let scannerContainer: string | undefined;
  let ingressAudit: Awaited<ReturnType<typeof prepareStagingInfrastructureAudit>> | undefined;
  let workerAudit: Awaited<ReturnType<typeof openStagingAuditWriter>> | undefined;
  let workerAuditFailures = 0;
  const lmsEncryptionKey = fresh();
  const lmsStorage =
    fullRollback || coordinatedRecovery || faultDrill
      ? { path: join(directory, 'lms-runtime'), encryptionKey: lmsEncryptionKey, reopen: false }
      : undefined;
  let telemetry: Awaited<ReturnType<typeof createStagingTelemetry>> | undefined;
  let alertLog: Awaited<ReturnType<typeof openTelemetryAlerts>> | undefined;
  let alertPath: string | undefined;
  const assertQueueAlert = async (state: 'firing' | 'resolved') => {
    assert.ok(alertLog && alertPath);
    await waitFor(async () => {
      await alertLog!.tick();
      const log = await readFile(alertPath!, 'utf8');
      assert.ok(
        log
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .some((line) => {
            const record = JSON.parse(line);
            return (
              record.name === 'queue-needs-attention' &&
              record.service === 'aio-workflows' &&
              record.queue === 'intake' &&
              record.state === state
            );
          }),
      );
    }, 45000);
  };
  let appLogs: ReturnType<typeof spawn> | undefined;
  const appContainers: string[] = [];
  let bridgeId: string | undefined;
  let workerBatch = 0;
  const runIntakeWorkers = async (count: 1 | 2) => {
    assert.ok(replicaDrill && candidateImage && secretStore && bridgeId);
    const store = secretStore;
    const image = candidateImage;
    const bridge = bridgeId;
    const batch = ++workerBatch;
    const barrier = join(directory, 'intake-' + batch);
    const startSignal = join(barrier, 'start');
    await mkdir(barrier, { mode: 0o700 });
    const workers = Array.from({ length: count }, (_, index) => {
      const workerName = name + '-intake-' + batch + '-' + index;
      return { workerName, grantPath: join(directory, 'intake-' + batch + '-' + index + '.json') };
    });
    try {
      const ids: string[] = [];
      const logs = (id: string) => docker(['logs', id]);
      // Keep OpenBao bootstrap sequential. Only processing the job is concurrent.
      for (const { workerName, grantPath } of workers) {
        stage = slot + ' staging intake worker bootstrap ' + (ids.length + 1) + '/' + count;
        await writeFile(grantPath, JSON.stringify(await store.grant('bff')), {
          flag: 'wx',
          mode: 0o600,
        });
        const id = await docker([
          'run',
          '-d',
          '--pull=never',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--label',
          'aio.staging.run=' + instance,
          '--name',
          workerName,
          '--network',
          'container:' + bridge,
          '--mount',
          'type=bind,source=' + grantPath + ',target=/stage/runtime.json,readonly',
          '--mount',
          'type=bind,source=' + certFile + ',target=/stage/cert.pem,readonly',
          '--mount',
          'type=bind,source=' + barrier + ',target=/stage/intake,readonly',
          '-e',
          'NODE_EXTRA_CA_CERTS=/stage/cert.pem',
          image,
          '--workflow-intake-once',
          slot,
          '/stage/runtime.json',
          '/stage/cert.pem',
        ]);
        ids.push(id);
        await waitFor(async () => {
          assert.ok((await logs(id)).includes('AIO_WORKFLOW_INTAKE_READY'));
        }, 15000);
      }
      assert.equal(new Set(ids).size, count);
      stage = slot + ' staging intake workers processing batch ' + batch;
      await writeFile(startSignal, '', { flag: 'wx' });
      const completed = await Promise.allSettled(
        ids.map(async (id) => {
          assert.equal(await docker(['wait', id]), '0', 'Staging intake worker failed.');
          const match = /^AIO_WORKFLOW_INTAKE_PROCESSED (\d+)$/m.exec(await logs(id));
          assert.ok(match, 'Expected one intake result from a staging worker.');
          return Number(match[1]);
        }),
      );
      return completed
        .map((worker) => {
          if (worker.status === 'rejected')
            throw new Error('Staging intake worker did not complete.');
          return worker.value;
        })
        .sort((left, right) => left - right);
    } finally {
      for (const { workerName, grantPath } of workers) {
        try {
          const owned = await docker([
            'ps',
            '-a',
            '-q',
            '--no-trunc',
            '--filter',
            'label=aio.staging.run=' + instance,
            '--filter',
            'name=^/' + workerName + '$',
          ]);
          if (owned) await docker(['rm', '-f', owned]);
        } finally {
          await unlink(grantPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      }
      await unlink(startSignal).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  };
  const stopApp = async () => {
    if ((fullRollback || coordinatedRecovery || faultDrill) && stageLms) {
      await stageLms.worker.dispose();
      stageLms = undefined;
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    child = undefined;
    while (appContainers.length) {
      const id = appContainers.pop()!;
      const running = await docker([
        'ps',
        '-q',
        '--no-trunc',
        '--filter',
        'id=' + id,
        '--filter',
        'label=aio.staging.run=' + instance,
      ]);
      if (running === id) await docker(['stop', id]);
    }
    if (appLogs && appLogs.exitCode === null && appLogs.signalCode === null) {
      const closed = once(appLogs, 'close');
      appLogs.kill();
      await closed;
    }
    appLogs = undefined;
    bridgeId = undefined;
  };
  const launchApp = (cwd: string, runtimePath: string) => {
    const processHandle = spawn(
      process.execPath,
      ['dist/scripts/staging.js', slot, runtimePath, certFile, keyFile],
      {
        cwd,
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: certFile,
          PGSSLMODE: 'verify-full',
          ...(business && { AIO_STAGING_SCANNER_TLS_DIR: scannerDirectory }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    processHandle.stdout?.resume();
    processHandle.stderr?.resume();
    child = processHandle;
    return processHandle;
  };
  const startImage = async (image: string) => {
    if (secretStore) {
      const grant = await secretStore.grant('bff');
      await writeFile(secretGrantFile, JSON.stringify(grant), { flag: 'w', mode: 0o600 });
    }
    const publicPorts = bffClients(runtime).map((client) => client.port);
    const routes = [
      ...publicPorts.map((port) => ['0.0.0.0', port + 1000, '127.0.0.1', port]),
      ['127.0.0.1', Number(target.dbPort), 'pg', 5432],
      ['127.0.0.1', Number(new URL(target.issuer).port), name + '-idp', 8443],
      ...(lms ? [['127.0.0.1', lms.port, 'host.docker.internal', lms.port]] : []),
      ...(business ? [['127.0.0.1', stagingScannerPort(slot), name + '-scanner', 3311]] : []),
      ...(secretStore
        ? [['127.0.0.1', secretStore.port, 'host.docker.internal', secretStore.port]]
        : []),
    ];
    const restrictions = [
      'run',
      '--rm',
      '-d',
      '--pull=never',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--label',
      'aio.staging.run=' + instance,
    ];
    const bridge = await docker([
      ...restrictions,
      '--name',
      name + '-bridge',
      '--network',
      name,
      ...(namedHosts ? appHosts.flatMap((host) => ['--add-host', host + ':127.0.0.1']) : []),
      ...publicPorts.flatMap((port) => ['-p', '127.0.0.1:' + port + ':' + (port + 1000)]),
      '--entrypoint=node',
      image,
      '--input-type=module',
      '-e',
      relay,
      JSON.stringify(routes),
    ]);
    appContainers.push(bridge);
    bridgeId = bridge;
    const appId = await docker([
      ...restrictions,
      '--name',
      name + '-app',
      '--network',
      'container:' + bridge,
      ...[
        [secretStore ? secretGrantFile : configFile, 'runtime.json'],
        [certFile, 'cert.pem'],
        [keyFile, 'key.pem'],
        ...(infraAudit ? [[ingressAuditFile, 'ingress-audit.json']] : []),
      ].flatMap(([file, mount]) => [
        '--mount',
        'type=bind,source=' + file + ',target=/stage/' + mount + ',readonly',
      ]),
      '-e',
      'NODE_EXTRA_CA_CERTS=/stage/cert.pem',
      ...(infraAudit
        ? [
            '--mount',
            'type=bind,source=' + auditSpool + ',target=/stage/audit-spool',
            '-e',
            'AIO_STAGING_AUDIT_SPOOL=/stage/audit-spool/ingress.sqlite',
          ]
        : []),
      ...(business
        ? [
            ...['server.pem', 'client.pem', 'client-key.pem'].flatMap(scannerMount),
            '-e',
            'AIO_STAGING_SCANNER_TLS_DIR=/stage',
          ]
        : []),
      ...(telemetry ? ['-e', 'AIO_STAGING_TELEMETRY=1'] : []),
      ...(replicaDrill ? ['-e', 'AIO_STAGING_MANUAL_WORKFLOW=1'] : []),
      image,
      slot,
      '/stage/runtime.json',
      '/stage/cert.pem',
      '/stage/key.pem',
      ...(infraAudit ? ['/stage/ingress-audit.json'] : []),
    ]);
    appContainers.push(appId);
    if (telemetry) {
      appLogs = spawn('docker', ['--context', 'desktop-linux', 'logs', '--follow', appId], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      appLogs.on('error', () => {});
      if (appLogs.stdout) telemetry.attach(appLogs.stdout);
    }
  };
  let hstsVerifiedFor: string[] | undefined;
  const startApp = async (cwd: string, ca: string) => {
    if (lms && (cwd === artifact || fullRollback) && !stageLms) {
      assert.ok(scannerTls);
      stage = slot + ' LMS Worker and isolated bindings';
      if (cwd === artifact && ingressAudit && !workerAudit)
        workerAudit = await openStagingAuditWriter(
          ingressAudit.workerd,
          runtime,
          Buffer.from(ca),
          'workerd',
          join(auditSpool, 'workerd.sqlite'),
        );
      stageLms = await startStagingLms(
        { ...runtime, scannerTls },
        cwd,
        certFile,
        keyFile,
        [...users, ...loadIdentities],
        telemetry?.observe,
        lmsStorage,
        workerAudit,
        lmsSecrets,
      );
      if (lmsStorage) lmsStorage.reopen = true;
      const ready = await httpsJson(lms.baseUrl + '/health/ready', ca);
      assert.equal(ready.environment, 'tlqm-aio-lms-staging');
      assert.equal(ready.service, lms.code);
    }
    const runImage = candidateImage && cwd === artifact;
    if (runImage) await startImage(candidateImage);
    else
      launchApp(
        cwd,
        business && !fullRollback && cwd === priorArtifact ? coreConfigFile : configFile,
      );
    for (const app of cwd === priorArtifact && !fullRollback ? coreClients : bffClients(runtime))
      await waitFor(async () => {
        if (child && child.exitCode !== null) throw new Error('Packaged application exited.');
        const ready = await httpsJson(app.baseUrl + '/health/ready', ca);
        assert.equal(ready.mode, 'staging');
        assert.equal(ready.service, app.code);
      }, 16000);
    if (cwd === artifact && !hstsVerifiedFor) {
      stage = slot + ' HSTS responses on candidate clients';
      const verified = [];
      for (const app of runtime.clients) {
        await verifyStagingHsts(app.baseUrl, ca, '/health/live', 200);
        if (app.kind === 'external-application') {
          await verifyStagingHsts(app.baseUrl, ca, '/api/lms/media', 401);
        } else {
          await verifyStagingHsts(app.baseUrl, ca, '/api/v1/me', 401);
          await verifyStagingHsts(app.baseUrl, ca, '/health/live', 400, 'fixture.invalid');
        }
        verified.push(app.code);
      }
      hstsVerifiedFor = verified;
    }
  };
  let ownerPool: pg.Pool | undefined;
  try {
    if (telemetryEnabled) {
      const evidence = resolve('.local/evidence');
      await mkdir(evidence, { recursive: true });
      assert.equal(await realpath(evidence), evidence);
      telemetry = await createStagingTelemetry(
        join(evidence, 'enterprise-e3-telemetry-' + instance + '-' + slot + '.ndjson'),
      );
      alertPath = join(evidence, 'enterprise-e3-alerts-' + instance + '-' + slot + '.ndjson');
      alertLog = await openTelemetryAlerts(alertPath, telemetry);
    }
    stage = slot + ' TLS material';
    if (!candidateImage || priorArtifact)
      await writeFile(configFile, JSON.stringify(runtime), { flag: 'wx', mode: 0o600 });
    if (business && priorArtifact) {
      const { moduleDatabases: _moduleDatabases, ...coreRuntime } = runtime;
      await writeFile(coreConfigFile, JSON.stringify({ ...coreRuntime, clients: coreClients }), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    await writeFile(realmFile, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    await writeFile(passwordDenylist, passwordList.denylist, { flag: 'wx', mode: 0o644 });
    if (business) await createStagingScannerCertificates(scannerDirectory);
    await execute(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          '$rsa = [System.Security.Cryptography.RSA]::Create(3072)',
          '$req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=127.0.0.1",$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)',
          '$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()',
          '$san.AddIpAddress([System.Net.IPAddress]::Loopback)',
          '$san.AddDnsName("pg")',
          '$san.AddDnsName("host.docker.internal")',
          ...(namedHosts ? appHosts.map((host) => `$san.AddDnsName("${host}")`) : []),
          '$req.CertificateExtensions.Add($san.Build())',
          '$cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddHours(-1),[DateTimeOffset]::UtcNow.AddDays(1))',
          '[IO.File]::WriteAllText((Join-Path $env:AIO_STAGE_CERT_DIR "cert.pem"),$cert.ExportCertificatePem())',
          '[IO.File]::WriteAllText((Join-Path $env:AIO_STAGE_CERT_DIR "key.pem"),$rsa.ExportPkcs8PrivateKeyPem())',
        ].join('; '),
      ],
      { env: { ...process.env, AIO_STAGE_CERT_DIR: directory }, windowsHide: true, timeout: 15000 },
    );
    const cert = await readFile(certFile, 'utf8');
    if (candidateImage) {
      stage = slot + ' isolated workload secret store';
      const openBao = JSON.parse(
        await readFile(join(artifact, 'infrastructure/release/openbao-aio.json'), 'utf8'),
      ) as { binarySha256: string };
      secretStore = await startStagingSecretStore({
        slot,
        instanceId: runtime.instanceId,
        directory,
        certFile,
        keyFile,
        ca: cert,
        binarySha256: openBao.binarySha256,
        values: {
          bff: runtime,
          postgres: { password: pgPassword },
          keycloak: { password: keycloakPassword, operator: idpOperator },
          ...(lms && { lms: { clientSecret: lms.clientSecret, encryptionKey: lmsEncryptionKey } }),
        },
      });
      pgPassword = (await secretStore.read<{ password: string }>('postgres')).password;
      if (lms)
        lmsSecrets = await secretStore.read<{ clientSecret: string; encryptionKey: string }>('lms');
    }
    const pin = createHash('sha256')
      .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    stage = slot + ' PostgreSQL';
    await docker(['network', 'create', '--label', 'aio.staging.run=' + instance, name]);
    network = true;
    const checkpointDirectory = join(directory, 'checkpoint');
    if (coordinatedRecovery) await mkdir(checkpointDirectory, { mode: 0o700 });
    const startPostgres = async (restoring = false) => {
      const id = await docker(
        [
          'run',
          '--rm',
          '-d',
          '--pull=never',
          '--name',
          name + (restoring ? '-restored-pg' : '-pg'),
          '--network',
          name,
          '--network-alias',
          'pg',
          '--label',
          'aio.staging.run=' + instance,
          '-p',
          '127.0.0.1:' + target.dbPort + ':5432',
          '-e',
          'POSTGRES_DB=' + (restoring ? 'postgres' : target.database),
          '-e',
          'POSTGRES_USER=' + (restoring ? restoreOperator : 'aio_stage_owner'),
          '-e',
          'POSTGRES_PASSWORD',
          ...(coordinatedRecovery
            ? [
                '--mount',
                'type=bind,source=' +
                  checkpointDirectory +
                  ',target=/checkpoint' +
                  (restoring ? ',readonly' : ''),
              ]
            : []),
          '--mount',
          'type=bind,source=' + certFile + ',target=/stage/cert.pem,readonly',
          '--mount',
          'type=bind,source=' + keyFile + ',target=/stage/key.pem,readonly',
          '--mount',
          'type=bind,source=' +
            join(artifact, 'infrastructure/audit/staging-pg-tls-only.conf') +
            ',target=/stage/pg_hba.conf,readonly',
          '--entrypoint',
          'sh',
          postgres,
          '-ec',
          'install -m 600 -o postgres -g postgres /stage/key.pem /tmp/aio-stage-pg-key.pem; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_min_protocol_version=TLSv1.2 -c ssl_cert_file=/stage/cert.pem -c ssl_key_file=/tmp/aio-stage-pg-key.pem -c hba_file=/stage/pg_hba.conf',
        ],
        { POSTGRES_PASSWORD: pgPassword },
      );
      containers.push(id);
      return id;
    };
    const pgContainer = await startPostgres();
    const url = new URL(runtime.databaseUrl);
    url.username = 'aio_stage_owner';
    url.password = pgPassword;
    const pool = new pg.Pool({
      connectionString: url.href,
      ssl: stagingDatabaseTls(cert),
      max: 1,
      connectionTimeoutMillis: 1500,
    });
    ownerPool = pool;
    const verifyDatabaseTransport = async () => {
      const probe = async (ssl: pg.ClientConfig['ssl'], code: string) => {
        stage = slot + ' PostgreSQL rejects ' + (ssl === false ? 'plaintext' : 'untrusted peer');
        const db = new pg.Client({
          connectionString: url.href,
          ssl,
          connectionTimeoutMillis: 3000,
        });
        try {
          await assert.rejects(db.connect(), { code });
        } finally {
          await db.end();
        }
      };
      await probe(false, '28000');
      await probe({ ca: [], rejectUnauthorized: true }, 'DEPTH_ZERO_SELF_SIGNED_CERT');
      stage = slot + ' PostgreSQL transport by role and store';
      for (const app of bffClients(runtime)) await httpsJson(app.baseUrl + '/health/ready', cert);
      const { rows } = await pool.query<{ role: string; database: string; version: string }>(
        `SELECT DISTINCT a.usename AS role,a.datname AS database,s.version
         FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid)
         WHERE a.backend_type='client backend' AND a.client_addr IS NOT NULL AND a.datname IS NOT NULL
         ORDER BY role,database,s.version`,
      );
      assert.ok(rows.every(({ version }) => version === 'TLSv1.2' || version === 'TLSv1.3'));
      const required = [
        ['aio_stage_owner', target.database],
        ['aio_runtime', target.database],
        ['aio_stage_keycloak', 'aio_stage_identity'],
        ...(runtime.moduleDatabases
          ? stagingModules.map((module) => {
              const database = stagingModuleDatabase(runtime.slot, module);
              return [database.role, database.name];
            })
          : []),
      ];
      for (const [role, database] of required) {
        stage = slot + ' PostgreSQL TLS active for ' + role;
        assert.ok(
          rows.some((row) => row.role === role && row.database === database),
          role,
        );
      }
      return { rows, plaintextRejected: true, untrustedCertificateRejected: true };
    };
    let databaseTransport: Awaited<ReturnType<typeof verifyDatabaseTransport>>;
    let versions: string[];
    let moduleSetup: Awaited<ReturnType<typeof provisionStagingModules>> | undefined;
    {
      const db = (await waitFor(() => pool.connect(), 25000)) as pg.PoolClient;
      try {
        assert.equal(
          (await db.query('SELECT current_database() AS name')).rows[0].name,
          target.database,
        );
        const password = new URL(runtime.databaseUrl).password;
        await db.query(
          "CREATE ROLE aio_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '" +
            password +
            "'",
        );
        await db.query(
          "CREATE ROLE aio_stage_keycloak LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '" +
            keycloakPassword +
            "'",
        );
        await db.query('CREATE DATABASE aio_stage_identity OWNER aio_stage_keycloak');
        await db.query('REVOKE ALL ON DATABASE aio_stage_identity FROM PUBLIC');
        versions = await migrateDatabase(
          db,
          'tlqm-aio-test',
          join(priorArtifact ?? artifact, 'infrastructure/database'),
        );
        await bootstrapFixtures(
          db,
          { clients: runtime.clients, issuer: runtime.issuer, users },
          new Set(runtime.clients.map((c) => c.code)),
        );
        await db.query('INSERT INTO bootstrap_receipts(name) VALUES ($1)', [
          'enterprise-staging:' + runtime.instanceId,
        ]);
        await db.query('REVOKE ALL ON DATABASE ' + target.database + ' FROM PUBLIC');
        await db.query('GRANT CONNECT ON DATABASE ' + target.database + ' TO aio_runtime');
        await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        await db.query('GRANT USAGE ON SCHEMA public TO aio_runtime');
        await db.query(
          'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO aio_runtime',
        );
        await db.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO aio_runtime');
        await db.query(
          'REVOKE INSERT,UPDATE,DELETE ON schema_migrations,environment_marker,bootstrap_receipts FROM aio_runtime',
        );
        await db.query('REVOKE UPDATE,DELETE ON audit_events,mutation_receipts FROM aio_runtime');
        const permissions = (
          await db.query(
            "SELECT has_table_privilege('aio_runtime','schema_migrations','INSERT') AS migration, has_table_privilege('aio_runtime','audit_events','DELETE') AS audit, has_database_privilege('aio_runtime','aio_stage_identity','CONNECT') AS identity",
          )
        ).rows[0];
        assert.deepEqual(permissions, { migration: false, audit: false, identity: false });
        if (business) {
          stage = slot + ' module databases, roles and registry';
          if (accessUi) {
            await db.query(
              `INSERT INTO persons(id,home_tenant_id,display_name)
               SELECT gen_random_uuid(),$1,'Nhân sự phân trang staging' FROM generate_series(1,503)`,
              [ids.tenantA],
            );
            await db.query(
              'INSERT INTO persons(id,home_tenant_id,display_name) VALUES (gen_random_uuid(),$1,$2)',
              [ids.tenantB, 'Nhân sự ngoài phạm vi staging'],
            );
          }
          const reportSubjects = scopedReports
            ? {
                reviewer: users.find(({ id }) => id === reportActors.reviewer.id)!.subject,
                analyst: users.find(({ id }) => id === reportActors.analyst.id)!.subject,
                outside: users.find(({ id }) => id === reportActors.outside.id)!.subject,
              }
            : undefined;
          moduleSetup = await provisionStagingModules(
            db,
            runtime,
            cert,
            fullRollback ? priorArtifact! : artifact,
            accessUi,
            reportSubjects,
          );
          if (mixedLoad) await provisionStagingLoadIdentities(db, runtime, loadIdentities);
        }
      } finally {
        db.release();
      }
    }

    if (infraAudit) {
      await mkdir(auditSpool, { mode: 0o700 });
      stage = slot + ' isolated audit store with TLS';
      ingressAudit = await prepareStagingInfrastructureAudit(runtime, pool, url, artifact, cert);
      await writeFile(ingressAuditFile, JSON.stringify(ingressAudit.ingress), {
        flag: 'wx',
        mode: 0o600,
      });
    }

    const startIdp = async (restoring = false) => {
      stage = slot + ' Keycloak TLS';
      const idpSecrets = secretStore
        ? await secretStore.read<{ password: string; operator?: typeof idpOperator }>('keycloak')
        : { password: keycloakPassword, operator: idpOperator };
      const id = await docker(
        [
          'run',
          '--rm',
          '-d',
          '--pull=never',
          '--name',
          name + '-idp',
          '--network',
          name,
          '--label',
          'aio.staging.run=' + instance,
          '-p',
          '127.0.0.1:' + new URL(target.issuer).port + ':8443',
          '--mount',
          'type=bind,source=' + certFile + ',target=/stage/cert.pem,readonly',
          '--mount',
          'type=bind,source=' + keyFile + ',target=/stage/key.pem,readonly',
          '--mount',
          'type=bind,source=' +
            realmFile +
            ',target=/opt/keycloak/data/import/' +
            realm +
            '-realm.json,readonly',
          '--mount',
          'type=bind,source=' +
            passwordDenylist +
            ',target=/opt/keycloak/data/password-blacklists/' +
            passwordDenylistName +
            ',readonly',
          '-e',
          'KC_DB=postgres',
          '-e',
          'KC_DB_URL=jdbc:postgresql://pg:5432/aio_stage_identity?sslmode=verify-full&sslrootcert=/stage/cert.pem',
          '-e',
          'KC_DB_USERNAME=aio_stage_keycloak',
          '-e',
          'KC_DB_PASSWORD',
          ...(idpOperator
            ? ['-e', 'KC_BOOTSTRAP_ADMIN_CLIENT_ID', '-e', 'KC_BOOTSTRAP_ADMIN_CLIENT_SECRET']
            : []),
          keycloak,
          'start',
          ...(restoring ? [] : ['--import-realm']),
          '--cache=local',
          '--hostname=' + new URL(target.issuer).origin,
          '--http-enabled=false',
          '--https-certificate-file=/stage/cert.pem',
          '--https-certificate-key-file=/stage/key.pem',
          '--truststore-paths=/stage/cert.pem',
        ],
        {
          KC_DB_PASSWORD: idpSecrets.password,
          ...(idpSecrets.operator
            ? {
                KC_BOOTSTRAP_ADMIN_CLIENT_ID: idpSecrets.operator.clientId,
                KC_BOOTSTRAP_ADMIN_CLIENT_SECRET: idpSecrets.operator.secret,
              }
            : {}),
        },
      );
      containers.push(id);
      stage = slot + ' Keycloak discovery';
      await waitFor(async () => {
        const discovery = await httpsJson(
          target.issuer + '/.well-known/openid-configuration',
          cert,
        );
        assert.equal(discovery.issuer, target.issuer);
      }, 150000);
      return id;
    };
    const idpContainer = await startIdp();
    if (business) {
      stage = slot + ' pinned ClamAV with isolated scan port';
      const scanner = await docker([
        'run',
        '--rm',
        '-d',
        '--pull=never',
        '--name',
        name + '-scanner',
        '--network',
        name,
        '--label',
        'aio.staging.run=' + instance,
        '-p',
        '127.0.0.1:' + stagingScannerPort(slot) + ':3311',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user',
        'clamav',
        '--health-cmd',
        'test "$(printf \'PING\\n\' | nc -w 2 127.0.0.1 3310)" = PONG',
        '--mount',
        'type=bind,source=' +
          join(artifact, 'infrastructure/release/clamd-staging.conf') +
          ',target=/stage/clamd.conf,readonly',
        '--entrypoint',
        '/usr/sbin/clamd',
        scannerImage,
        '-c',
        '/stage/clamd.conf',
      ]);
      containers.push(scanner);
      scannerContainer = scanner;
      const scannerProxy = await docker([
        'run',
        '--rm',
        '-d',
        '--pull=never',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--name',
        name + '-scanner-tls',
        '--network',
        'container:' + scanner,
        '--label',
        'aio.staging.run=' + instance,
        ...['server.pem', 'server-key.pem', 'client.pem'].flatMap(scannerMount),
        '--entrypoint=node',
        candidateImage ??
          'node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf',
        '--input-type=module',
        '-e',
        scannerTlsRelay,
      ]);
      containers.push(scannerProxy);
      scannerTls = await loadStagingScannerTls(scannerDirectory);
      const scan = stagingFileScanner(slot, scannerTls);
      await waitFor(
        async () =>
          assert.equal(await scan(Buffer.from('Synthetic AIO clean scan fixture.')), 'clean'),
        90000,
      );
      assert.equal(await scan(scannerTestSignature()), 'infected');
      const transport = await verifyStagingScannerTransport(stagingScannerPort(slot), scannerTls);
      const scannerIp = await docker([
        'inspect',
        '--format',
        '{{with index .NetworkSettings.Networks "' + name + '"}}{{.IPAddress}}{{end}}',
        scanner,
      ]);
      assert.match(scannerIp, /^\d+\.\d+\.\d+\.\d+$/);
      assert.equal(
        await docker([
          'exec',
          scanner,
          'sh',
          '-c',
          'if test "$(printf \'PING\\n\' | nc -w 2 "$1" 3310 2>/dev/null)" = PONG; then printf reachable; else printf refused; fi',
          'sh',
          scannerIp,
        ]),
        'refused',
      );
      scannerEvidence = {
        image: scannerImage,
        cleanProbe: true,
        standardSignature: true,
        transport,
      };
    }
    stage = slot + ' Keycloak discovery';
    await verifyStagingHsts(
      new URL(target.issuer).origin,
      cert,
      new URL(target.issuer).pathname + '/.well-known/openid-configuration',
      200,
    );

    stage = slot + ' packaged Foundation';
    await startApp(priorArtifact ?? artifact, cert);

    stage = slot + ' browser MFA and CSRF';
    browser = await chromium.launch({
      headless: !speechDrill,
      args: [
        '--ignore-certificate-errors-spki-list=' + pin,
        ...(speechDrill ? ['--force-renderer-accessibility'] : []),
      ],
    });
    const context = await browser.newContext();
    if (passwordActor) stage = slot + ' Keycloak user password change with the staging denylist';
    const passwordChange = passwordActor
      ? await verifyStagingPasswordChange(browser, foundation.baseUrl, passwordActor, passwordList)
      : undefined;
    const page = await context.newPage();
    const usedOtpSteps = new Map<string, number>();
    const enter = async (
      base: string,
      credentials: boolean,
      loginPage = page,
      account: { id: string; username: string; password: string; otpSecret: string } = admin,
    ) => {
      await loginPage.goto(base + '/auth/login');
      if (credentials) {
        await loginPage.locator('#username').fill(account.username);
        await loginPage.locator('#password').fill(account.password);
        await loginPage.locator('#kc-login').click();
        await loginPage.locator('#otp').waitFor();
        const period = 30000;
        const now = Date.now();
        const step = Math.floor(now / period);
        if (now % period > 26000 || usedOtpSteps.get(account.id) === step)
          await delay((step + 1) * period + 250 - now);
        const generatedAt = Date.now();
        usedOtpSteps.set(account.id, Math.floor(generatedAt / period));
        await loginPage.locator('#otp').fill(fixtureTotp(account.otpSecret, generatedAt));
        await loginPage.locator('#kc-login').click();
      }
      await loginPage.waitForURL(base + '/', { timeout: 18000 });
      const me = await loginPage.evaluate(async () => {
        const response = await fetch('/api/v1/me');
        const data = await response.json();
        return {
          status: response.status,
          accountId: data.accountId,
          hasCsrf: typeof data.csrfToken === 'string',
          error:
            typeof data.error === 'string' && /^[A-Z_]{2,80}$/.test(data.error)
              ? data.error
              : undefined,
        };
      });
      if (me.status !== 200)
        console.error('Staging browser session rejected: ' + (me.error ?? 'UNSPECIFIED'));
      assert.equal(me.status, 200);
      assert.equal(me.accountId, account.id);
      assert.equal(me.hasCsrf, true);
    };
    await enter(foundation.baseUrl, true);
    await enter(probe.baseUrl, false);
    let upgrade;
    let loadCheck: Awaited<ReturnType<typeof verifyStagingMixedLoad>> | undefined;
    let loadPassed: boolean | undefined;
    let runLoad: (() => Promise<void>) | undefined;
    let businessChecks: Awaited<ReturnType<typeof verifyStagingBusiness>> | undefined;
    let lmsChecks: Awaited<ReturnType<typeof verifyStagingLms>> | undefined;
    let auditChecks: Awaited<ReturnType<typeof verifyStagingAudit>> | undefined;
    let auditDeliveryRecovery;
    let recoveryChecks;
    let dependencyFaults;
    let workloadRotation;
    let personnelChecks: Awaited<ReturnType<typeof verifyStagingPersonnel>> | undefined;
    let iamChecks: Awaited<ReturnType<typeof verifyStagingIam>> | undefined;
    const runBusinessChecks = async () => {
      if (!business) return;
      const phase = (name: string) => {
        stage = slot + ' ' + name;
      };
      const audit: AuditEvidence[] | undefined = e2Audit ? [] : undefined;
      if (personnel) {
        phase('personnel lifecycle browser sessions');
        const lifecycle = await browser!.newContext();
        const operator = await context.newPage();
        try {
          await operator.goto(foundation.baseUrl + '/');
          const login = async (client: ClientConfig, first = false) => {
            const tab = await lifecycle.newPage();
            await enter(client.baseUrl, first, tab, learner);
            return tab;
          };
          const module = (name: StagingModule) =>
            runtime.clients.find(({ code }) => code === 'aio-' + name)!;
          personnelChecks = await verifyStagingPersonnel(
            runtime,
            pool,
            cert,
            {
              portal: await login(foundation, true),
              forms: await login(module('forms')),
              workflows: await login(module('workflows')),
              tasks: await login(module('tasks')),
              lms: await login(lms!),
            },
            operator,
            audit!,
            phase,
          );
        } finally {
          await lifecycle.close();
          await operator.close();
        }
      }
      const memberContext = await browser!.newContext();
      const otherContext = accessUi ? await browser!.newContext() : undefined;
      const reportContexts = new Map<ReportActor, typeof memberContext>();
      const reportSession: ReportSession | undefined = scopedReports
        ? async (app, actor) => {
            let actorContext = reportContexts.get(actor);
            const first = !actorContext;
            if (!actorContext) {
              actorContext = await browser!.newContext();
              reportContexts.set(actor, actorContext);
            }
            const page = await actorContext.newPage();
            await enter(
              runtime.clients.find(({ code }) => code === app)!.baseUrl,
              first,
              page,
              users.find(({ id }) => id === reportActors[actor].id)!,
            );
            return page;
          }
        : undefined;
      try {
        const learnerHome = await memberContext.newPage();
        stage = slot + ' module member SSO';
        await enter(foundation.baseUrl, true, learnerHome, learner);
        const session = async (base: string, actor: 'operator' | 'member' | 'other') => {
          if (actor === 'other') {
            const modulePage = await otherContext!.newPage();
            await enter(
              base,
              true,
              modulePage,
              users.find(({ id }) => id === ids.other)!,
            );
            return modulePage;
          }
          const modulePage = await (actor === 'operator' ? context : memberContext).newPage();
          await enter(base, false, modulePage, actor === 'operator' ? admin : learner);
          return modulePage;
        };
        const workflowDrills = namedHosts && scopedReports && !mixedLoad && !coordinatedRecovery;
        if (workflowDrills && slot === 'b') assert.ok(workflowPromotionSource);
        businessChecks = await verifyStagingBusiness(
          runtime,
          session,
          phase,
          audit,
          accessUi,
          reportSession,
          workflowDrills && stageLms
            ? {
                lms: stageLms.db,
                ...(faultDrill && { awaitQueueAlert: assertQueueAlert }),
                ...(replicaDrill && { runWorkers: runIntakeWorkers }),
                async setRecipientGrant(active) {
                  const result = await pool.query(
                    `UPDATE application_grants SET active=$1,revision=revision+1
                     WHERE (tenant_id,account_id,app_code)=($2,$3,'aio-lms-sandbox') AND active<>$1`,
                    [active, ids.tenantA, ids.admin],
                  );
                  assert.equal(result.rowCount, 1);
                },
              }
            : undefined,
          workflowDrills
            ? slot === 'a'
              ? {
                  kind: 'source',
                  publish(source) {
                    assert.equal(workflowPromotionSource, undefined);
                    workflowPromotionSource = source;
                  },
                }
              : { kind: 'target', source: workflowPromotionSource! }
            : undefined,
        );
        if (lms) {
          phase('Foundation request budget before LMS');
          await reserveStagingRequests(foundation.baseUrl, cert, 180);
          phase('LMS browser SSO');
          lmsChecks = await verifyStagingLms(
            await session(lms.baseUrl, 'operator'),
            await session(lms.baseUrl, 'member'),
            await session(foundation.baseUrl, 'operator'),
            learnerHome,
            slot,
            phase,
            audit,
            accessUi,
            reportSession,
            faultDrill,
          );
          if (telemetry) {
            phase('telemetry correlation across Portal, LMS and Foundation');
            await waitFor(async () => {
              const report = telemetry!.report();
              assert.ok(report.completeTraces.length);
              assert.equal(report.queues.length, 4);
            }, 12000);
          }
        }
        // Finish the short browser checks before the 30-minute load window.
        // Its 100 independent sessions must not extend the administrator session.
        if (mixedLoad)
          runLoad = async () => {
            phase('mixed load with 100 staged identities and authenticated sessions');
            assert.ok(
              businessChecks &&
                lmsChecks &&
                businessChecks.rollbackObjects.outsideProjectId &&
                telemetry,
            );
            const loadFixture = {
              ...businessChecks.rollbackObjects,
              ...lmsChecks.rollbackObjects,
              outsideProjectId: businessChecks.rollbackObjects.outsideProjectId,
            };
            const jobPool = new pg.Pool({
              connectionString: runtime.moduleDatabases!.workflows,
              ssl: stagingDatabaseTls(cert),
              max: 1,
              connectionTimeoutMillis: 3000,
            });
            const load = async () => {
              let jobs: Awaited<ReturnType<typeof seedMixedLoadJobs>> | undefined;
              const http = await verifyStagingMixedLoad(
                runtime,
                cert,
                browser!,
                async (client, actor, first, tab, index) => {
                  const account = loadIdentities.find(
                    (entry) => entry.actor === actor && entry.index === index,
                  )!;
                  await enter(
                    runtime.clients.find(({ code }) => code === 'aio-' + client)!.baseUrl,
                    first,
                    tab,
                    account,
                  );
                },
                loadFixture,
                async () => {
                  const { rows } = await pool.query(`SELECT count(*)::int AS connections,
              count(*) FILTER (WHERE state='active')::int AS active,
              count(*) FILTER (WHERE wait_event_type='Lock')::int AS waiting,
              current_setting('max_connections')::int AS capacity FROM pg_stat_activity WHERE backend_type='client backend'`);
                  const samples: Record<string, number | null> = { ...rows[0] };
                  for (const queue of telemetry!.report().queues) {
                    samples[queue.queue + 'Due'] = queue.due;
                    samples[queue.queue + 'OldestDueMs'] = queue.oldestDueMs;
                  }
                  const owned = [...appContainers, ...containers];
                  const usage = await docker([
                    'stats',
                    '--no-stream',
                    '--format',
                    '{{.CPUPerc}} {{.MemPerc}}',
                    ...owned,
                  ]);
                  const percentages = usage.split(/\r?\n/).map((line) =>
                    line
                      .trim()
                      .split(/\s+/)
                      .map((part) => Number(part.replace('%', ''))),
                  );
                  assert.equal(percentages.length, owned.length);
                  samples.containerCpuPctSum = percentages.reduce((sum, [cpu]) => sum + cpu!, 0);
                  samples.containerMemoryPctMax = Math.max(...percentages.map((row) => row[1]!));
                  return samples;
                },
                async () => {
                  jobs = await seedMixedLoadJobs(jobPool, loadFixture.definitionId);
                },
              );
              assert.ok(jobs);
              return { ...http, jobs: await mixedLoadJobResults(jobPool, jobs) };
            };
            const measured = await load().finally(() => jobPool.end());
            loadCheck = measured;
            const now = new Date();
            const report = {
              status:
                measured.meetsDuration &&
                measured.meetsThresholds &&
                measured.assessedLearners === 25 &&
                measured.jobs.status === 'pass' &&
                measured.samples.length > 0 &&
                measured.sampleFailures === 0
                  ? 'pass'
                  : 'fail',
              scope: 'staging-mixed-load-http',
              release,
              artifactDigest: expected,
              imageDigest: candidateImage,
              runnerSha256,
              infrastructureImages: { postgres, keycloak },
              slot,
              completedAtVietnam: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
              ...measured,
            };
            await writeFile(
              resolve(
                '.local/evidence',
                'enterprise-e3-mixed-load-' + instance + '-' + slot + '.json',
              ),
              JSON.stringify(report, null, 2) + '\n',
              { flag: 'wx', mode: 0o600 },
            );
            loadPassed = report.status === 'pass';
          };
        if (idpOperator) {
          iamChecks = await verifyStagingIam(
            runtime,
            cert,
            idpOperator,
            pool,
            browser!,
            context,
            { primary: admin, recoverySubject: recovery.subject },
            (base, fresh, tab, actor) =>
              enter(base, fresh, tab, actor === 'recovery' ? recovery : admin),
            audit!,
            stageLms!.db,
            phase,
          );
        }
        if (audit) {
          let infrastructure: Parameters<typeof verifyStagingAudit>[6];
          if (ingressAudit) {
            phase('ingress audit unauthorized and wrong host probes over TLS');
            assert.ok(lms && stageLms && workerAudit);
            const probes = await stagingIngressProbes(foundation.baseUrl, cert);
            phase('workerd audit captures denied and unavailable requests');
            const denied = await stagingWorkerdProbe(lms.baseUrl, cert, 401);
            const source = stageLms.db;
            const flip = async (from: string, to: string) => {
              const outcome = await source
                .prepare(
                  'UPDATE environment_marker SET purpose=? WHERE instance_id=? AND purpose=?',
                )
                .bind(to, runtime.instanceId, from)
                .run();
              assert.equal(outcome.meta.changes, 1);
            };
            const purpose = 'tlqm-aio-lms-staging';
            await flip(purpose, 'tlqm-aio-lms-staging-fault');
            try {
              const unavailable = await stagingWorkerdProbe(lms.baseUrl, cert, 503);
              infrastructure = {
                ca: cert,
                ingressUrl: ingressAudit.ingress.databaseUrl,
                probes,
                workerdUrl: ingressAudit.workerd.databaseUrl,
                workerd: { denied, unavailable },
              };
            } finally {
              await flip('tlqm-aio-lms-staging-fault', purpose);
            }
            assert.equal(workerAudit.failures(), 0);
          }
          phase('central audit projection, correlation and retention');
          auditChecks = await verifyStagingAudit(
            runtime,
            url.href,
            cert,
            artifact,
            stageLms!.db,
            audit,
            infrastructure,
          );
        }
      } finally {
        await memberContext.close();
        await otherContext?.close();
        await Promise.all([...reportContexts.values()].map((actorContext) => actorContext.close()));
      }
    };
    if (priorArtifact) {
      stage = slot + ' baseline application writes audited grant';
      const foundationPage = await context.newPage();
      await foundationPage.goto(foundation.baseUrl + '/');
      const before = await pool.query(
        'SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version',
      );
      const key = randomUUID();
      const data = {
        accountId: ids.noAccess,
        tenantId: ids.tenantA,
        appCode: probe.code,
        reason: 'Isolated release rehearsal',
        expectedRevision: 0,
      };
      const grant = async () => {
        const result = await foundationPage.evaluate(
          async ({ data, key }) => {
            const me = await fetch('/api/v1/me');
            if (!me.ok) return { status: me.status };
            const { csrfToken } = await me.json();
            const response = await fetch('/api/v1/access/grants', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-csrf-token': csrfToken,
                'idempotency-key': key,
              },
              body: JSON.stringify(data),
            });
            return { status: response.status, body: await response.json() };
          },
          { data, key },
        );
        assert.equal(result.status, 200);
        return result.body;
      };
      const grantBefore = await grant();
      const audit = async () =>
        (
          await pool.query(
            "SELECT id,request_id,details FROM audit_events WHERE subject_account_id=$1 AND tenant_id=$2 AND action='access.granted' ORDER BY id",
            [ids.noAccess, ids.tenantA],
          )
        ).rows;
      const auditBefore = await audit();
      assert.equal(auditBefore.length, 1);

      stage = slot + ' additive schema upgrade';
      await stopApp();
      const db = await pool.connect();
      try {
        versions = await migrateDatabase(
          db,
          'tlqm-aio-test',
          join(artifact, 'infrastructure/database'),
        );
      } finally {
        db.release();
      }
      const after = await pool.query(
        'SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version',
      );
      assert.ok(
        fullRollback
          ? after.rows.length >= before.rows.length
          : after.rows.length > before.rows.length,
      );
      assert.deepEqual(after.rows.slice(0, before.rows.length), before.rows);
      const upgradedModules = fullRollback
        ? await upgradeStagingModules(runtime, url, cert, artifact)
        : undefined;
      if (upgradedModules)
        assert.ok(
          after.rows.length > before.rows.length ||
            Object.values(upgradedModules).some(
              ({ before, after }) => after.length > before.length,
            ),
          'Select a rollback artifact before an additive migration.',
        );

      stage = slot + ' wrong instance fails closed';
      await writeFile(wrongInstanceFile, JSON.stringify({ ...runtime, instanceId: randomUUID() }), {
        flag: 'wx',
        mode: 0o600,
      });
      const invalid = launchApp(artifact, wrongInstanceFile);
      const exited = once(invalid, 'exit');
      const exitCode = await Promise.race([
        exited.then(([code]) => code),
        delay(15000, null, { ref: false }),
      ]);
      assert.equal(exitCode, 1);
      await stopApp();

      stage = slot + ' upgraded application uses existing session and receipt';
      await startApp(artifact, cert);
      assert.deepEqual(await grant(), grantBefore);
      assert.deepEqual(await audit(), auditBefore);
      const request = await foundationPage.evaluate(async () => {
        const response = await fetch('/api/v1/me', {
          headers: { 'x-request-id': 'client-supplied-id' },
        });
        return { status: response.status, id: response.headers.get('x-request-id') };
      });
      assert.equal(request.status, 200);
      assert.match(request.id ?? '', /^[0-9a-f-]{36}$/);

      stage = slot + ' candidate browser MFA and cross-client SSO';
      const candidateContext = await browser.newContext();
      try {
        const candidatePage = await candidateContext.newPage();
        await enter(foundation.baseUrl, true, candidatePage, recovery);
        await enter(probe.baseUrl, false, candidatePage, recovery);
        const candidateCookies = await candidateContext.cookies();
        for (const app of [foundation, probe]) {
          const cookie = candidateCookies.find(
            ({ name }) => name === '__Host-aio_' + slot + '_session_' + app.code,
          );
          assert.ok(cookie?.secure && cookie.httpOnly && cookie.path === '/');
        }
      } finally {
        await candidateContext.close();
      }

      await runBusinessChecks();
      stage = slot + ' PostgreSQL transport by role and store';
      databaseTransport = await verifyDatabaseTransport();
      const rollbackChecks = async () => {
        stage = slot + ' rollback suite verifies preserved records';
        assert.ok(businessChecks && lmsChecks && stageLms && lms);
        const { formId, runId, taskId } = businessChecks.rollbackObjects;
        const { attemptId, versionId } = lmsChecks.rollbackObjects;
        const checks = [
          ['aio-foundation', '/api/v1/me'],
          ['aio-forms', '/api/v1/forms/' + formId + '?tenantId=' + ids.tenantA],
          ['aio-workflows', '/api/v1/workflows/runs/' + runId + '?tenantId=' + ids.tenantA],
          ['aio-tasks', '/api/v1/tasks/items/' + taskId + '?tenantId=' + ids.tenantA],
          ['aio-lms-sandbox', '/api/lms/course?versionId=' + versionId],
        ] as const;
        for (const [code, path] of checks) {
          const client = runtime.clients.find((item) => item.code === code)!;
          const tab = await context.newPage();
          try {
            stage = slot + ' rollback preserved record in ' + code;
            await tab.goto(client.baseUrl + '/health/live');
            const status = await tab.evaluate(async (url) => (await fetch(url)).status, path);
            assert.equal(status, 200, 'Rollback read failed in ' + code);
          } finally {
            await tab.close();
          }
        }
        const attempt = await stageLms.db
          .prepare('SELECT id,version_id,score FROM lms_attempts WHERE id=?')
          .bind(attemptId)
          .first();
        assert.deepEqual(attempt, { id: attemptId, version_id: versionId, score: 100 });
        const bucket = (await stageLms.worker.getR2Bucket('LMS_MEDIA')) as unknown as MediaBucket;
        const media = await verifyStoredMedia(stageLms.db, bucket);
        assert.ok(media.objects > 0);
        return {
          services: checks.map(([code]) => code),
          lmsVersions: stageLms.versions,
          verifiedMediaObjects: media.objects,
        };
      };
      if (fullRollback) {
        stage = slot + ' open six application sessions after IAM rehearsal';
        for (const client of runtime.clients) {
          const tab = await context.newPage();
          try {
            await enter(client.baseUrl, false, tab);
          } finally {
            await tab.close();
          }
        }
      }
      const beforeRollback = fullRollback ? await rollbackChecks() : undefined;
      stage = slot + ' rollback application without schema downgrade';
      await stopApp();
      await startApp(priorArtifact, cert);
      if (beforeRollback) {
        assert.deepEqual(await rollbackChecks(), beforeRollback);
        await stopApp();
        await startApp(artifact, cert);
        assert.deepEqual(await rollbackChecks(), beforeRollback);
        assert.deepEqual(
          await upgradeStagingModules(runtime, url, cert),
          Object.fromEntries(
            Object.entries(upgradedModules!).map(([module, { after }]) => [
              module,
              { before: after, after },
            ]),
          ),
        );
      }
      assert.deepEqual(await grant(), grantBefore);
      assert.deepEqual(await audit(), auditBefore);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version',
          )
        ).rows,
        after.rows,
      );
      await foundationPage.close();
      upgrade = {
        applied: versions.slice(before.rows.length),
        existingJournalPreserved: true,
        wrongInstanceRejected: true,
        persistedSessionAndIdempotency: true,
        singleAuditEventPreserved: true,
        candidateMfaAndSso: true,
        rollbackOnUpgradedSchema: true,
        ...(beforeRollback && {
          fullRollback: {
            ...beforeRollback,
            modules: upgradedModules,
            candidateRolledForward: true,
          },
        }),
      };
    } else {
      await runBusinessChecks();
      stage = slot + ' PostgreSQL transport by role and store';
      databaseTransport = await verifyDatabaseTransport();
    }
    if (coordinatedRecovery) {
      assert.ok(lmsStorage && lms && stageLms && lmsChecks && businessChecks && auditChecks);
      assert.ok(secretStore);
      const { formId, runId, taskId } = businessChecks.rollbackObjects;
      const { attemptId, versionId } = lmsChecks.rollbackObjects;
      const ownedStop = async (id: string) => {
        assert.ok(containers.includes(id));
        assert.equal(
          await docker(['inspect', '--format', '{{index .Config.Labels "aio.staging.run"}}', id]),
          instance,
        );
        await docker(['stop', id]);
        containers.splice(containers.indexOf(id), 1);
      };
      stage = slot + ' coordinated recovery quiesce writers';
      const previous = await verifyStoredMedia(
        stageLms.db,
        (await stageLms.worker.getR2Bucket('LMS_MEDIA')) as unknown as MediaBucket,
      );
      await stopApp();
      if (workerAudit) {
        await workerAudit.close();
        workerAuditFailures += workerAudit.failures();
        workerAudit = undefined;
      }
      await ownedStop(idpContainer);
      const checkpointAt = new Date();
      const lmsBackup = join(checkpointDirectory, 'lms');
      const lmsFiles = await copyLmsStorage(lmsStorage.path, lmsBackup);
      const databases = [
        target.database,
        ...stagingModules.map((module) => stagingModuleDatabase(slot, module).name),
        'aio_stage_identity',
        stagingAuditDatabase(slot),
      ];
      const recoveryPools = new Map(
        databases.map((database) => {
          const connection = new URL(url);
          connection.pathname = '/' + database;
          return [
            database,
            new pg.Pool({
              connectionString: connection.href,
              ssl: stagingDatabaseTls(cert),
              max: 1,
              connectionTimeoutMillis: 3000,
            }),
          ] as const;
        }),
      );
      let restored;
      let incidentAt;
      let secretsRestored;
      try {
        stage = slot + ' coordinated PostgreSQL and LMS checkpoint';
        const checkpoint = await checkpointStagingPostgres(
          docker,
          pgContainer,
          checkpointDirectory,
          recoveryPools,
        );
        stage = slot + ' checkpoint encrypted OpenBao Raft storage';
        const secretArchive = await secretStore.checkpoint();
        try {
          await Promise.all([...recoveryPools.values()].map((active) => active.end()));
          const incidentMarker = randomUUID();
          await pool.query(
            "INSERT INTO audit_events(app_code,action,request_id) VALUES ('aio-foundation','recovery.after-checkpoint',$1)",
            [incidentMarker],
          );
          await pool.end();
          ownerPool = undefined;
          incidentAt = new Date();
          stage = slot + ' stop source database and start fresh target';
          await ownedStop(pgContainer);
          stage = slot + ' restore OpenBao to new storage and verify workload credentials';
          secretsRestored = await secretStore.restore(secretArchive);
          pgPassword = (await secretStore.read<{ password: string }>('postgres')).password;
          lmsSecrets = await secretStore.read<{ clientSecret: string; encryptionKey: string }>(
            'lms',
          );
          stage = slot + ' start fresh PostgreSQL target';
          const destination = await startPostgres(true);
          const bootstrap = new pg.Pool({
            host: '127.0.0.1',
            port: Number(target.dbPort),
            database: 'postgres',
            user: restoreOperator,
            password: pgPassword,
            ssl: stagingDatabaseTls(cert),
            connectionTimeoutMillis: 1500,
          });
          try {
            await waitFor(() => bootstrap.query('SELECT 1'), 25000);
          } finally {
            await bootstrap.end();
          }
          const targetPools = new Map(
            databases.map((database) => {
              const connection = new URL(url);
              connection.pathname = '/' + database;
              return [
                database,
                new pg.Pool({
                  connectionString: connection.href,
                  ssl: stagingDatabaseTls(cert),
                  max: 1,
                  connectionTimeoutMillis: 3000,
                }),
              ] as const;
            }),
          );
          try {
            stage = slot + ' restore and reconcile PostgreSQL including Keycloak';
            restored = await restoreStagingPostgres(
              docker,
              destination,
              checkpointDirectory,
              checkpoint,
              targetPools,
            );
            const missing = await targetPools
              .get(target.database)!
              .query('SELECT 1 FROM audit_events WHERE request_id=$1', [incidentMarker]);
            assert.equal(missing.rowCount, 0);
          } finally {
            await Promise.all([...targetPools.values()].map((active) => active.end()));
          }
        } finally {
          secretArchive.fill(0);
        }
      } finally {
        for (const active of recoveryPools.values()) if (!active.ending) await active.end();
      }
      stage = slot + ' restore D1 and R2 from verified checkpoint';
      const destinationLms = join(directory, 'lms-restored');
      await copyLmsStorage(lmsBackup, destinationLms, lmsFiles);
      lmsStorage.path = destinationLms;
      await startIdp(true);
      await startApp(artifact, cert);
      assert.ok(stageLms);
      const recovered = stageLms as NonNullable<typeof stageLms>;
      const attempt = await recovered.db
        .prepare('SELECT version_id,score FROM lms_attempts WHERE id=?')
        .bind(attemptId)
        .first();
      assert.deepEqual(attempt, { version_id: versionId, score: 100 });
      assert.deepEqual(
        await verifyStoredMedia(
          recovered.db,
          (await recovered.worker.getR2Bucket('LMS_MEDIA')) as unknown as MediaBucket,
        ),
        previous,
      );
      stage = slot + ' fresh MFA and authorized reads on restored target';
      const recoveredContext = await browser.newContext();
      const reads = [
        ['aio-foundation', '/api/v1/me'],
        ['aio-forms', '/api/v1/forms/' + formId + '?tenantId=' + ids.tenantA],
        ['aio-workflows', '/api/v1/workflows/runs/' + runId + '?tenantId=' + ids.tenantA],
        ['aio-tasks', '/api/v1/tasks/items/' + taskId + '?tenantId=' + ids.tenantA],
        ['aio-lms-sandbox', '/api/lms/course?versionId=' + versionId],
      ] as const;
      try {
        let first = true;
        for (const [code, path] of reads) {
          const client = runtime.clients.find((entry) => entry.code === code)!;
          const tab = await recoveredContext.newPage();
          await enter(client.baseUrl, first, tab, admin);
          first = false;
          assert.equal(
            await tab.evaluate(async (url) => (await fetch(url)).status, path),
            200,
            code,
          );
          await tab.close();
        }
      } finally {
        await recoveredContext.close();
      }
      const readyAt = new Date();
      recoveryChecks = {
        checkpointAt: checkpointAt.toISOString(),
        incidentAt: incidentAt!.toISOString(),
        readyAt: readyAt.toISOString(),
        readyAtVietnam: readyAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
        rpoMs: incidentAt!.getTime() - checkpointAt.getTime(),
        rtoMs: readyAt.getTime() - incidentAt!.getTime(),
        restored,
        secretsRestored,
        lmsFiles,
        verifiedMedia: previous,
        postCheckpointMarkerAbsent: true,
        freshMfa: true,
        authorizedApps: reads.map(([code]) => code),
      };
      assert.ok(secretsRestored?.newStorage && secretsRestored.restoredWorkloads.length === 4);
      assert.ok(recoveryChecks.rpoMs <= 15 * 60_000 && recoveryChecks.rtoMs <= 60 * 60_000);
      await writeFile(
        resolve(
          '.local/evidence',
          'enterprise-e3-staging-recovery-' + instance + '-' + slot + '.json',
        ),
        JSON.stringify(
          {
            status: 'pass',
            release,
            artifactDigest: expected,
            imageDigest: candidateImage,
            runnerSha256,
            infrastructureImages: { postgres, keycloak },
            slot,
            ...recoveryChecks,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    }
    if (faultDrill) {
      assert.ok(lms && stageLms && lmsStorage && lmsChecks && workerAudit);
      stage = slot + ' isolate audit delivery outage and verify durable replay';
      const auditUrl = new URL(url);
      auditUrl.pathname = '/' + stagingAuditDatabase(slot);
      const auditSink = new pg.Client({
        connectionString: auditUrl.href,
        ssl: stagingDatabaseTls(cert),
        connectionTimeoutMillis: 3000,
      });
      const auditRows = async (requestIds: string[]) => {
        await auditSink.query('SET ROLE aio_audit_read');
        try {
          const result = await auditSink.query(
            'SELECT source,action,http_status,request_id FROM audit_projection.infrastructure_events WHERE request_id=ANY($1) ORDER BY source,action',
            [requestIds],
          );
          return result.rows;
        } finally {
          await auditSink.query('RESET ROLE');
        }
      };
      const appId = appContainers.at(-1);
      assert.ok(appId);
      await auditSink.connect();
      try {
        let edge;
        let workerd;
        await auditSink.query('BEGIN');
        try {
          await auditSink.query(
            'LOCK TABLE audit_projection.infrastructure_events IN ACCESS EXCLUSIVE MODE',
          );
          stage = slot + ' audit outage creates ingress and workerd observations';
          edge = await stagingIngressProbes(foundation.baseUrl, cert);
          workerd = await stagingWorkerdProbe(lms.baseUrl, cert, 401);
          stage = slot + ' audit outage blocks both projection writers';
          await waitFor(async () => {
            const { rows } = await auditSink.query<{ roles: string[] }>(`
              SELECT array_agg(DISTINCT a.usename::text ORDER BY a.usename::text) AS roles
              FROM pg_locks l JOIN pg_stat_activity a USING(pid)
              WHERE l.relation='audit_projection.infrastructure_events'::regclass AND NOT l.granted
                AND a.usename IN ('aio_audit_ingress','aio_audit_workerd')
            `);
            assert.deepEqual(rows[0]?.roles, ['aio_audit_ingress', 'aio_audit_workerd']);
          }, 4500);
          stage = slot + ' audit outage signals from both projection writers';
          await waitFor(async () => {
            assert.ok(workerAudit?.blocked());
            assert.ok(
              (await docker(['logs', appId]))
                .split(/\r?\n/)
                .some((line) => line.trim() === 'AIO_AUDIT_DELIVERY ingress firing'),
            );
          }, 15000);
          stage = slot + ' audit outage stops both writers while the sink is locked';
          await stopApp();
          await workerAudit.close();
          workerAuditFailures += workerAudit.failures();
          workerAudit = undefined;
        } finally {
          await auditSink.query('ROLLBACK');
        }
        assert.ok(edge && workerd);
        stage = slot + ' audit outage verifies projection is empty before restart';
        const requestIds = [edge.denied, edge.rejected, workerd.requestId];
        assert.deepEqual(await auditRows(requestIds), []);
        await startApp(artifact, cert);
        stage = slot + ' audit outage replays all three observations to the analysis role';
        await waitFor(async () => {
          assert.deepEqual(
            (await auditRows(requestIds)).map((row) => ({ ...row })),
            [
              {
                source: 'ingress',
                action: 'edge.rejected',
                http_status: 400,
                request_id: edge.rejected,
              },
              {
                source: 'ingress',
                action: 'http.denied',
                http_status: 401,
                request_id: edge.denied,
              },
              {
                source: 'workerd',
                action: 'http.denied',
                http_status: 401,
                request_id: workerd.requestId,
              },
            ],
          );
        }, 15000);
        assert.ok(stageLms && workerAudit);
        auditDeliveryRecovery = {
          writers: ['ingress', 'workerd'],
          outageSignal: true,
          writerRestarted: true,
          replayedOnce: requestIds.length,
          analysisRole: 'aio_audit_read',
        };
      } finally {
        await auditSink.end();
      }
      const portal = await context.newPage();
      const learner = await context.newPage();
      const code = async (tab: typeof portal, path: string) =>
        tab.evaluate(async (endpoint) => {
          try {
            return (await fetch(endpoint, { signal: AbortSignal.timeout(12000) })).status;
          } catch {
            return 0;
          }
        }, path);
      const assertOwned = async (id: string) => {
        assert.ok(containers.includes(id) || appContainers.includes(id));
        assert.equal(
          await docker(['inspect', '--format', '{{index .Config.Labels "aio.staging.run"}}', id]),
          instance,
        );
      };
      const blockedDependency = async (id: string) => {
        await assertOwned(id);
        await docker(['pause', id]);
        try {
          assert.equal(await code(portal, '/api/v1/me'), 503);
        } finally {
          await docker(['unpause', id]);
        }
        await waitFor(async () => assert.equal(await code(portal, '/api/v1/me'), 200), 30000);
      };
      try {
        stage = slot + ' fault drill prepare live sessions';
        await enter(foundation.baseUrl, false, portal);
        await enter(lms.baseUrl, false, learner);
        stage = slot + ' fault drill IdP pause and resume';
        await blockedDependency(idpContainer);
        stage = slot + ' fault drill PostgreSQL pause and resume';
        await blockedDependency(pgContainer);
        stage = slot + ' fault drill R2 object missing and restored';
        const mediaId = lmsChecks.rollbackObjects.mediaId;
        const mediaPath =
          '/api/lms/media/' + mediaId + '?versionId=' + lmsChecks.rollbackObjects.versionId;
        const media = await stageLms.db
          .prepare('SELECT object_key,mime_type,sha256 FROM lms_media WHERE id=?')
          .bind(mediaId)
          .first<{ object_key: string; mime_type: string; sha256: string }>();
        assert.ok(media);
        const storage = (await stageLms.worker.getR2Bucket('LMS_MEDIA')) as unknown as Pick<
          MediaBucket,
          'delete'
        > & {
          get(key: string): Promise<(MediaObject & { arrayBuffer(): Promise<ArrayBuffer> }) | null>;
          put(
            key: string,
            value: Uint8Array,
            options: Parameters<MediaBucket['put']>[2],
          ): Promise<MediaObject | null>;
        };
        const object = await storage.get(media.object_key);
        assert.ok(object);
        const bytes = Buffer.from(await object.arrayBuffer());
        assert.equal(bytes.length, object.size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), media.sha256);
        assert.equal(await code(learner, mediaPath), 200);
        await storage.delete(media.object_key);
        try {
          assert.equal(await code(learner, mediaPath), 503);
        } finally {
          const restored = await storage.put(media.object_key, bytes, {
            httpMetadata: { contentType: media.mime_type },
            sha256: media.sha256,
          });
          assert.ok(restored);
          assert.equal(restored.size, bytes.length);
        }
        assert.equal(await code(learner, mediaPath), 200);
        stage = slot + ' fault drill stored media scan before serving';
        assert.ok(scannerContainer && scannerTls);
        await assertOwned(scannerContainer);
        const replaceMedia = async (content: Buffer) => {
          const written = await storage.put(media.object_key, content, {
            httpMetadata: { contentType: media.mime_type },
            sha256: createHash('sha256').update(content).digest('hex'),
          });
          assert.equal(written?.size, content.length);
        };
        await replaceMedia(bytes);
        await docker(['pause', scannerContainer]);
        try {
          const blocked = await learner.evaluate(async (path) => {
            const response = await fetch(path, {
              headers: { range: 'bytes=0-4' },
              signal: AbortSignal.timeout(22000),
            });
            return { status: response.status, error: (await response.json()).error };
          }, mediaPath);
          assert.deepEqual(blocked, { status: 503, error: 'LMS_UPLOAD_SCANNER_UNAVAILABLE' });
        } finally {
          await docker(['unpause', scannerContainer]);
        }
        await waitFor(async () => assert.equal(await code(learner, mediaPath), 200), 25000);
        await replaceMedia(Buffer.alloc(bytes.length, 65));
        try {
          assert.equal(await code(learner, mediaPath), 503);
        } finally {
          await replaceMedia(bytes);
        }
        assert.equal(await code(learner, mediaPath), 200);
        stage = slot + ' fault drill workerd shutdown and restart';
        await stageLms.worker.dispose();
        stageLms = undefined;
        assert.equal(await code(learner, '/api/v1/me'), 0);
        stageLms = await startStagingLms(
          { ...runtime, scannerTls },
          artifact,
          certFile,
          keyFile,
          [...users],
          telemetry?.observe,
          lmsStorage,
          workerAudit,
          lmsSecrets,
        );
        assert.equal(await code(learner, '/api/v1/me'), 200);
        assert.equal(await code(learner, mediaPath), 200);
        stage = slot + ' fault drill PostgreSQL credential rotation through OpenBao';
        assert.ok(secretStore);
        const rotated = fresh();
        const vault = await secretStore.rotate('postgres', { password: rotated });
        const retrieved = await secretStore.read<{ password: string }>('postgres');
        if (retrieved.password !== rotated)
          throw new Error('PostgreSQL received an unexpected isolated secret version.');
        const owner = url.username;
        assert.equal(owner, 'aio_stage_owner');
        const identity = await pool.query(
          'SELECT current_user AS name, current_database() AS database',
        );
        assert.deepEqual(identity.rows, [{ name: owner, database: target.database }]);
        const newUrl = new URL(url);
        newUrl.password = retrieved.password;
        await pool.query(
          'ALTER ROLE aio_stage_owner PASSWORD ' + pg.escapeLiteral(retrieved.password),
        );
        const connection = (connectionString: string) =>
          new pg.Client({
            connectionString,
            ssl: stagingDatabaseTls(cert),
            connectionTimeoutMillis: 3000,
          });
        const current = connection(newUrl.href);
        const retired = connection(url.href);
        try {
          await current.connect();
          assert.equal((await current.query('SELECT 1 AS ok')).rows[0]?.ok, 1);
          await assert.rejects(retired.connect(), { code: '28P01' });
          await secretStore.destroyRetired('postgres', vault.previous);
        } finally {
          await Promise.allSettled([current.end(), retired.end()]);
        }
        workloadRotation = {
          workload: 'postgres',
          oldCredentialDenied: true,
          newCredentialAccepted: true,
          retiredVersionDestroyed: true,
          ...vault,
        };
        dependencyFaults = {
          identityPause503: true,
          postgresPause503: true,
          missingMedia503: true,
          mediaRestoredWithOriginalDigest: true,
          scannerOutageBlockedStoredMedia: true,
          replacementWithWrongChecksumBlocked: true,
          workerdRestartPreservedSession: true,
        };
      } finally {
        await portal.close();
        await learner.close();
      }
    }
    const cookies = await context.cookies();
    for (const app of [foundation, probe]) {
      const cookie = cookies.find(
        ({ name }) => name === '__Host-aio_' + slot + '_session_' + app.code,
      );
      assert.ok(cookie?.secure && cookie.httpOnly && cookie.path === '/');
    }
    const rejected = await page.evaluate(
      async () =>
        (
          await fetch('/auth/logout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
    );
    assert.equal(rejected, 403);
    const accepted = await page.evaluate(async () => {
      const { csrfToken } = await (await fetch('/api/v1/me')).json();
      return (
        await fetch('/auth/logout', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: '{}',
        })
      ).status;
    });
    assert.equal(accepted, 200);
    await context.close();
    if (mixedLoad) {
      assert.ok(runLoad);
      await runLoad();
    }
    if (faultDrill) await alertLog?.close();
    const telemetryReport = telemetry?.report();
    if (telemetryReport) {
      assert.deepEqual(telemetryReport.log, { dropped: 0, failed: false });
      await writeTelemetryDashboard(
        resolve('.local/evidence', 'enterprise-e3-telemetry-' + instance + '-' + slot + '.html'),
        telemetryReport,
      );
    }
    assert.equal(workerAuditFailures + (workerAudit?.failures() ?? 0), 0);
    const secrets = await secretStore?.evidence();
    const faultEvidence = faultDrill
      ? {
          queueAlertFiredAndResolved: true,
          dependencyFaults,
          workloadRotation,
          alertLog: await readFile(alertPath!, 'utf8').then((value) =>
            createHash('sha256').update(value).digest('hex'),
          ),
        }
      : undefined;
    return {
      slot,
      versions,
      verifiedTls: true,
      hstsVerifiedFor,
      databaseTransport,
      verifiedMfa: true,
      crossAppSso: true,
      secureCookies: true,
      ...(scannerEvidence && { scanner: scannerEvidence }),
      ...(secrets && { secrets }),
      ...(faultEvidence && { faultEvidence }),
      passwordDenylist: passwordList.evidence,
      ...(passwordChange && { passwordChange }),
      csrfRejected: rejected,
      logout: accepted,
      isolatedRuntimeRole: true,
      ...(businessChecks ? { business: { ...moduleSetup, ...businessChecks } } : {}),
      ...(lmsChecks ? { lms: { versions: stageLms!.versions, ...lmsChecks } } : {}),
      ...(auditChecks ? { audit: auditChecks } : {}),
      ...(auditDeliveryRecovery ? { auditDeliveryRecovery } : {}),
      ...(personnelChecks ? { personnel: personnelChecks } : {}),
      ...(iamChecks ? { iam: iamChecks } : {}),
      ...(loadCheck
        ? {
            mixedLoad: {
              status: loadPassed ? 'pass' : 'fail',
              sessions: loadCheck.activeSessions,
              requests: loadCheck.requests,
              durationMs: loadCheck.durationMs,
              errorRatio: loadCheck.errorRatio,
            },
          }
        : {}),
      ...(telemetryReport ? { telemetry: telemetryReport } : {}),
      ...(upgrade ? { upgrade } : {}),
      ...(recoveryChecks ? { recovery: recoveryChecks } : {}),
    };
  } finally {
    try {
      await browser?.close();
      await stopApp();
      await stageLms?.worker.dispose();
      await workerAudit?.close();
      try {
        await alertLog?.close();
      } finally {
        await telemetry?.close();
      }
      await ownerPool?.end();
      for (const id of containers.reverse()) {
        const owned = await docker([
          'inspect',
          '--format',
          '{{index .Config.Labels "aio.staging.run"}}',
          id,
        ]);
        assert.equal(owned, instance);
        await docker(['stop', id]);
      }
      if (network) await docker(['network', 'rm', name]);
    } finally {
      try {
        await secretStore?.close();
      } finally {
        for (const file of [
          configFile,
          secretGrantFile,
          coreConfigFile,
          wrongInstanceFile,
          ingressAuditFile,
          realmFile,
          passwordDenylist,
          certFile,
          keyFile,
          ...scannerFiles.map((file) => join(scannerDirectory, file)),
        ])
          await unlink(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
      }
    }
  }
}

const runnerSha256 = createHash('sha256')
  .update(await readFile(new URL(import.meta.url)))
  .digest('hex');
try {
  await execute(process.execPath, ['scripts/release.mjs', 'verify', artifact, expected], {
    timeout: 12000,
    windowsHide: true,
  });
  if (priorArtifact)
    await execute(
      process.execPath,
      ['scripts/release.mjs', 'verify', priorArtifact, priorDigest!],
      {
        timeout: 12000,
        windowsHide: true,
      },
    );
  await assertLocalDocker();
  if (candidateImage) {
    const identity = await docker([
      'image',
      'inspect',
      '--format',
      '{{.Descriptor.Digest}} {{index .Config.Labels "io.tlqm.aio.artifact-sha256"}} {{.Config.User}}',
      candidateImage,
    ]);
    assert.equal(identity, candidateImage + ' ' + expected + ' node');
  }
  for (const slot of ['a', 'b'] as const) {
    const result = await rehearse(slot);
    results.push(result);
    console.log(
      (result.mixedLoad?.status === 'fail' ? 'FAIL' : 'PASS') +
        ' staging ' +
        slot +
        (suite
          ? ' Foundation, Forms, Workflows, Tasks and LMS.'
          : business
            ? ' Foundation, Forms, Workflows and Tasks.'
            : ' Foundation TLS, MFA, SSO and CSRF.'),
    );
  }
  const now = new Date();
  const allPassed = results.every((result) => result.mixedLoad?.status !== 'fail');
  const receipt = {
    status: allPassed ? 'pass' : 'fail',
    scope: suite
      ? 'Foundation, Forms, Workflows, Tasks and LMS staging'
      : business
        ? 'Foundation, Forms, Workflows and Tasks staging'
        : 'Foundation and probe staging',
    release,
    artifactDigest: expected,
    runnerSha256,
    ...(candidateImage ? { candidateRuntime: 'container', imageDigest: candidateImage } : {}),
    ...(priorArtifact ? { priorRelease, priorDigest } : {}),
    infrastructureImages: { postgres, keycloak, ...(business && { scanner: scannerImage }) },
    checkedAt: now.toISOString(),
    checkedAtVietnam: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    results,
  };
  await mkdir('.local/evidence', { recursive: true });
  const evidencePath = resolve(
    '.local/evidence',
    (faultDrill
      ? 'enterprise-e3-staging-faults-'
      : coordinatedRecovery
        ? 'enterprise-e3-staging-recovery-'
        : fullRollback
          ? 'enterprise-e5-staging-rollback-'
          : telemetryEnabled
            ? 'enterprise-e3-staging-telemetry-'
            : scopedReports
              ? 'enterprise-e2-staging-scoped-reports-'
              : accessUi
                ? 'enterprise-e2-staging-access-ui-'
                : infraAudit
                  ? 'enterprise-e2-staging-infra-audit-'
                  : iam
                    ? 'enterprise-e2-staging-iam-'
                    : personnel
                      ? 'enterprise-e2-staging-personnel-'
                      : e2Audit
                        ? 'enterprise-e2-staging-audit-'
                        : 'enterprise-e1-staging-' +
                          (suite ? 'suite-' : business ? 'modules-' : 'foundation-')) +
      instance +
      '.json',
  );
  await writeFile(evidencePath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log((allPassed ? 'PASS' : 'FAIL') + ' staging gate. Receipt: ' + evidencePath);
  if (!allPassed) process.exitCode = 1;
} catch (error) {
  const name = error instanceof Error ? error.name : 'unknown';
  const actual = error && typeof error === 'object' && 'actual' in error ? error.actual : null;
  const httpStatus = typeof actual === 'number' && actual >= 400 && actual <= 599 ? actual : null;
  const errorCode =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,40}$/.test(error.code)
      ? error.code
      : undefined;
  const failedAt = new Date();
  const runnerFrames =
    error instanceof Error
      ? [...(error.stack ?? '').matchAll(/(staging-[a-z-]+\.(?:ts|js):\d+:\d+)/g)]
          .map((match) => match[1])
          .slice(0, 5)
      : [];
  await mkdir(resolve('.local/evidence'), { recursive: true });
  await writeFile(
    resolve(
      '.local/evidence',
      (fullRollback ? 'enterprise-e5' : e2Audit ? 'enterprise-e2' : 'enterprise-e1') +
        '-staging-failed-' +
        instance +
        '.json',
    ),
    JSON.stringify(
      {
        status: 'fail',
        release,
        artifactDigest: expected,
        runnerSha256,
        candidateImage,
        stage,
        error: name,
        errorCode,
        httpStatus,
        runnerFrames,
        checkedAt: failedAt.toISOString(),
        checkedAtVietnam: failedAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
        completedSlots: results.map((result) => result.slot),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.error(
    'Staging rehearsal failed at ' +
      stage +
      ' (' +
      name +
      (errorCode ? ', ' + errorCode : '') +
      (httpStatus ? ', HTTP ' + httpStatus : '') +
      ').',
  );
  process.exitCode = 1;
}
