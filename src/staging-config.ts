import { readFile } from 'node:fs/promises';
import type { ClientConfig } from './config.js';
import { stagingAppOrigin, stagingTarget } from './staging-endpoints.js';
import type { StagingSlot } from './staging-endpoints.js';
import { readStagingSecret } from './staging-secret-client.js';
import type { StagingSecretGrant } from './staging-secret-client.js';
import type { StagingScannerTls } from './staging-file-scan.js';

export { stagingTarget } from './staging-endpoints.js';
export type { StagingSlot } from './staging-endpoints.js';
export const stagingModules = ['forms', 'workflows', 'tasks'] as const;
export type StagingModule = (typeof stagingModules)[number];
export type StagingConfig = {
  mode: 'staging';
  slot: StagingSlot;
  namedHosts?: true;
  instanceId: string;
  issuer: string;
  databaseUrl: string;
  databaseCa?: Buffer;
  scannerTls?: StagingScannerTls;
  encryptionKey: string;
  ingressKey: string;
  clients: ClientConfig[];
  moduleDatabases?: Record<StagingModule, string>;
};

const secret = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function stagingDatabaseTls(ca: string | Buffer | undefined) {
  if (!ca?.length) throw new Error('Missing staging database trust certificate.');
  return { ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
}

export function stagingModuleDatabase(slot: StagingSlot, module: StagingModule) {
  return {
    name: 'aio_' + module + '_stage_' + slot,
    owner: 'aio_' + module + '_owner',
    role: 'aio_' + module + '_runtime',
    purpose: 'tlqm-aio-' + module + '-staging',
  };
}

export function assertStagingConfig(config: StagingConfig) {
  if (
    config.mode !== 'staging' ||
    !['a', 'b'].includes(config.slot) ||
    (config.namedHosts !== undefined && config.namedHosts !== true) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      config.instanceId,
    ) ||
    !secret(config.encryptionKey) ||
    !secret(config.ingressKey) ||
    !Array.isArray(config.clients) ||
    ![2, 5, 6].includes(config.clients.length)
  )
    throw new Error('Invalid isolated staging configuration.');
  const target = stagingTarget(config.slot);
  const database = URL.parse(config.databaseUrl);
  if (
    config.issuer !== target.issuer ||
    database?.protocol !== 'postgresql:' ||
    database.host !== '127.0.0.1:' + target.dbPort ||
    database.pathname !== '/' + target.database ||
    database.username !== 'aio_runtime' ||
    !secret(database.password) ||
    database.search ||
    database.hash
  )
    throw new Error('Invalid isolated staging issuer or runtime database.');
  const clients: Pick<ClientConfig, 'code' | 'port' | 'kind'>[] = [
    { code: 'aio-foundation', port: target.foundation },
    { code: 'aio-probe', port: target.probe },
  ];
  const secrets = [config.encryptionKey, config.ingressKey, database.password];
  if (config.clients.some((client) => client?.code === 'aio-lms-sandbox')) {
    if (!config.moduleDatabases) throw new Error('Invalid isolated staging LMS configuration.');
    clients.push({ code: 'aio-lms-sandbox', port: target.lms, kind: 'external-application' });
  }
  if (config.moduleDatabases) {
    if (Object.keys(config.moduleDatabases).length !== stagingModules.length)
      throw new Error('Invalid staging module database list.');
    for (const module of stagingModules) {
      const expected = stagingModuleDatabase(config.slot, module);
      const url = URL.parse(config.moduleDatabases[module]);
      if (
        url?.protocol !== 'postgresql:' ||
        url.host !== database.host ||
        url.pathname !== '/' + expected.name ||
        url.username !== expected.role ||
        !secret(url.password) ||
        url.search ||
        url.hash
      )
        throw new Error('Invalid isolated staging module database.');
      secrets.push(url.password);
      clients.push({ code: 'aio-' + module, port: target[module], kind: 'application' });
    }
  }
  if (config.clients.length !== clients.length)
    throw new Error('Invalid isolated staging client list.');
  for (const { code, port, kind } of clients) {
    const client = config.clients.find((entry) => entry.code === code);
    if (
      !client ||
      client.kind !== kind ||
      typeof client.name !== 'string' ||
      !client.name.trim() ||
      client.clientId !== code ||
      client.audience !== code + '-api' ||
      client.port !== port ||
      client.baseUrl !== stagingAppOrigin(config.slot, code, port, config.namedHosts) ||
      !secret(client.clientSecret)
    )
      throw new Error('Invalid isolated staging client.');
    secrets.push(client.clientSecret);
  }
  if (new Set(secrets).size !== secrets.length)
    throw new Error('Staging credentials must be distinct.');
}

export async function loadStagingConfig(
  path: string,
  slot: StagingSlot,
  ca?: Buffer,
): Promise<StagingConfig> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('Staging requires TLS peer verification.');
  const input = JSON.parse(await readFile(path, 'utf8')) as StagingConfig | StagingSecretGrant;
  if (!input || input.slot !== slot) throw new Error('Wrong staging slot.');
  let config: StagingConfig;
  if ('kind' in input) {
    if (input.workload !== 'bff' || !ca) throw new Error('Invalid BFF staging secret grant.');
    config = await readStagingSecret<StagingConfig>(input, ca);
    if (config.slot !== slot || config.instanceId !== input.instanceId)
      throw new Error('Wrong BFF staging configuration.');
  } else config = input;
  assertStagingConfig(config);
  return config;
}
