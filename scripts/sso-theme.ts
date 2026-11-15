import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { loadLocalConfig } from '../src/config.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { localContainer } from './local-docker.js';

const execute = promisify(execFile);
const keys = ['loginTheme', 'internationalizationEnabled', 'supportedLocales', 'defaultLocale'];
const desired = {
  loginTheme: 'tlqm',
  internationalizationEnabled: true,
  supportedLocales: ['vi', 'en'],
  defaultLocale: 'vi',
};
const presentation = (realm: Record<string, unknown>) => ({
  loginTheme: realm.loginTheme ?? 'keycloak.v2',
  internationalizationEnabled: realm.internationalizationEnabled ?? false,
  supportedLocales: realm.supportedLocales ?? [],
  defaultLocale: realm.defaultLocale ?? '',
});
const protectedSettings = (realm: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(realm).filter(([key]) => !keys.includes(key)));
const receiptPath = '.local/sso-theme.json';
let stage = 'preflight';
try {
  const mode = process.argv[2] ?? 'apply';
  assert.ok(['apply', 'ensure', 'status', 'rollback'].includes(mode));
  const runtime = await loadLocalConfig();
  const container = await localContainer('keycloak');
  assert.ok(container.running);
  const request = await localKeycloakAdmin(runtime);
  const before = (await (await request('/')).json()) as Record<string, unknown>;
  if (mode === 'status') {
    console.log(JSON.stringify({ realm: 'aio-local', ...presentation(before) }));
  } else {
    let receipt:
      | { instanceId: string; original: ReturnType<typeof presentation>; createdAt: string }
      | undefined;
    try {
      receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as typeof receipt;
      assert.equal(receipt?.instanceId, runtime.instanceId);
      assert.ok(receipt?.original && typeof receipt.original === 'object');
      assert.deepEqual(Object.keys(receipt.original).sort(), keys.toSorted());
      assert.equal(typeof receipt.original.loginTheme, 'string');
      assert.equal(typeof receipt.original.internationalizationEnabled, 'boolean');
      assert.equal(typeof receipt.original.defaultLocale, 'string');
      assert.ok(
        Array.isArray(receipt.original.supportedLocales) &&
          receipt.original.supportedLocales.every((locale) => typeof locale === 'string'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (mode === 'ensure' && receipt) {
      console.log('Existing SSO theme selection retained; use local:sso-theme apply to change it.');
    } else {
      stage = 'verify owned theme';
      if (mode !== 'rollback') {
        const properties = await readFile(
          'infrastructure/keycloak/themes/tlqm/login/theme.properties',
          'utf8',
        );
        const mounted = await execute(
          'docker',
          [
            '--context',
            'desktop-linux',
            'exec',
            container.id,
            'cat',
            '/opt/keycloak/themes/tlqm/login/theme.properties',
          ],
          { windowsHide: true, timeout: 10000 },
        );
        assert.equal(mounted.stdout, properties);
      }
      if (!receipt) {
        assert.notEqual(mode, 'rollback');
        receipt = {
          instanceId: runtime.instanceId,
          original: presentation(before),
          createdAt: new Date().toISOString(),
        };
        await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
          flag: 'wx',
          mode: 0o600,
        });
      }
      const target = mode === 'rollback' ? presentation(receipt.original) : desired;
      if (mode === 'rollback') {
        const current = presentation(before);
        assert.ok(
          JSON.stringify(current) === JSON.stringify(desired) ||
            JSON.stringify(current) === JSON.stringify(receipt.original),
          'Theme selection changed independently; do not overwrite it.',
        );
      }
      stage = 'apply presentation settings';
      await request('/', 'PUT', target);
      const after = (await (await request('/')).json()) as Record<string, unknown>;
      assert.deepEqual(presentation(after), target);
      assert.deepEqual(protectedSettings(after), protectedSettings(before));
      console.log(
        'PASS: local SSO theme ' +
          (mode === 'rollback' ? 'rolled back' : 'applied') +
          '; all non-presentation realm settings preserved.',
      );
    }
  }
} catch {
  console.error('Local SSO theme failed at ' + stage + '. Sensitive details omitted.');
  process.exitCode = 1;
}
