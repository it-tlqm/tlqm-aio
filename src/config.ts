import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type ClientConfig = {
  code: string;
  name: string;
  port: number;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  audience: string;
};
export type LocalConfig = {
  mode: 'local';
  instanceId: string;
  issuer: string;
  databaseUrl: string;
  encryptionKey: string;
  clients: ClientConfig[];
  users: { id: string; username: string; name: string; tenantId: string; password: string }[];
  keycloakAdmin: { username: string; password: string };
};
export function assertLocalDatabase(url: string, test = false): void {
  const value = new URL(url);
  if (
    value.protocol !== 'postgresql:' ||
    value.hostname !== '127.0.0.1' ||
    value.port !== '5438' ||
    value.username !== 'aio_foundation' ||
    value.pathname !== (test ? '/aio_foundation_test' : '/aio_foundation') ||
    value.search !== ''
  )
    throw new Error('Only the isolated AIO local database is allowed.');
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
  for (const client of value.clients) {
    if (
      !['aio-foundation', 'aio-probe'].includes(client.code) ||
      client.baseUrl !== 'http://127.0.0.1:' + client.port ||
      ![4100, 4101].includes(client.port)
    )
      throw new Error('Invalid local client.');
  }
  return value;
}
export function testDatabaseUrl(config: LocalConfig): string {
  const url = new URL(config.databaseUrl);
  url.pathname = '/aio_foundation_test';
  return url.href;
}
