import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { StagingConfig } from './staging-config.js';

export type ClientConfig = {
  kind?: 'integration-probe' | 'application' | 'external-application';
  code: string;
  name: string;
  port: number;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  audience: string;
};
export function assertLocalClient(client: ClientConfig): void {
  const corePort =
    client.code === 'aio-foundation' ? 4100 : client.code === 'aio-probe' ? 4101 : undefined;
  if (
    !/^aio-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(client.code) ||
    client.code.length > 51 ||
    typeof client.name !== 'string' ||
    !client.name.trim() ||
    client.name.length > 120 ||
    !Number.isInteger(client.port) ||
    (corePort !== undefined
      ? client.port !== corePort || client.kind !== undefined
      : !['integration-probe', 'application', 'external-application'].includes(client.kind ?? '') ||
        client.port < 4102 ||
        client.port > 4199) ||
    client.baseUrl !== 'http://127.0.0.1:' + client.port ||
    client.clientId !== client.code ||
    client.audience !== client.code + '-api' ||
    !/^[0-9a-f]{64}$/.test(client.clientSecret)
  )
    throw new Error('Invalid isolated local client contract.');
}
export function assertLocalClients(clients: ClientConfig[]): void {
  if (
    !Array.isArray(clients) ||
    !['aio-foundation', 'aio-probe'].every((code) => clients.some((client) => client.code === code))
  )
    throw new Error('Missing local core clients.');
  for (const client of clients) assertLocalClient(client);
  for (const key of ['code', 'port', 'clientId', 'audience'] as const)
    if (new Set(clients.map((client) => client[key])).size !== clients.length)
      throw new Error('Local client identifiers and ports must be unique.');
}
export type LocalConfig = {
  mode: 'local';
  instanceId: string;
  issuer: string;
  databaseUrl: string;
  databaseRuntime?: { username: 'aio_runtime'; password: string };
  encryptionKey: string;
  clients: ClientConfig[];
  users: {
    id: string;
    subject?: string;
    username: string;
    name: string;
    tenantId: string;
    password: string;
  }[];
  keycloakAdmin: { username: string; password: string };
};
export type AppRuntime = LocalConfig | StagingConfig;
export function assertLocalDatabase(url: string, test = false): void {
  const value = new URL(url);
  if (
    value.protocol !== 'postgresql:' ||
    value.hostname !== '127.0.0.1' ||
    value.port !== '5438' ||
    !['aio_foundation', 'aio_runtime'].includes(value.username) ||
    value.pathname !== (test ? '/aio_foundation_test' : '/aio_foundation') ||
    value.search !== ''
  )
    throw new Error('Only the isolated AIO local database is allowed.');
}
export function bffClients(config: Pick<LocalConfig, 'clients'>) {
  return config.clients.filter((client) => client.kind !== 'external-application');
}
export async function loadLocalConfig(): Promise<LocalConfig> {
  const value = JSON.parse(await readFile(resolve('.local/runtime.json'), 'utf8')) as LocalConfig;
  if (
    value.mode !== 'local' ||
    value.issuer !== 'http://127.0.0.1:8180/realms/aio-local' ||
    !/^[0-9a-f]{64}$/.test(value.encryptionKey)
  )
    throw new Error('Invalid local configuration.');
  assertLocalDatabase(value.databaseUrl);
  assertLocalClients(value.clients);
  return value;
}
export function testDatabaseUrl(config: LocalConfig): string {
  return applicationDatabaseUrl(config, true);
}

export function applicationDatabaseUrl(config: LocalConfig, test = false): string {
  const url = new URL(config.databaseUrl);
  assertLocalDatabase(url.href, url.pathname === '/aio_foundation_test');
  if (
    config.databaseRuntime?.username !== 'aio_runtime' ||
    !/^[0-9a-f]{64}$/.test(config.databaseRuntime.password)
  )
    throw new Error('Run db:setup to provision the local runtime role.');
  url.username = config.databaseRuntime.username;
  url.password = config.databaseRuntime.password;
  url.pathname = test ? '/aio_foundation_test' : '/aio_foundation';
  assertLocalDatabase(url.href, test);
  return url.href;
}
