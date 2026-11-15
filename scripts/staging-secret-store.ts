import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { StagingSlot } from '../src/staging-endpoints.js';
import { openBaoApi, readStagingSecret, stagingSecretPorts } from '../src/staging-secret-client.js';
import type { StagingSecretGrant } from '../src/staging-secret-client.js';
import { stagingSecretSnapshot } from './staging-secret-snapshot.js';

type Workload = StagingSecretGrant['workload'];

export async function startStagingSecretStore(input: {
  slot: StagingSlot;
  instanceId: string;
  directory: string;
  certFile: string;
  keyFile: string;
  ca: string;
  binarySha256: string;
  values: Partial<Record<Workload, object>>;
}) {
  const { binarySha256 } = input;
  const binary = resolve(process.env.AIO_STAGING_OPENBAO_EXE ?? '');
  if (
    !/^[a-f0-9]{64}$/.test(binarySha256) ||
    basename(binary) !== 'bao.exe' ||
    (await realpath(binary)) !== binary ||
    createHash('sha256')
      .update(await readFile(binary))
      .digest('hex') !== binarySha256
  )
    throw new Error('Set AIO_STAGING_OPENBAO_EXE to the pinned OpenBao AIO binary.');
  const { directory, instanceId, slot } = input;
  const port = stagingSecretPorts[slot];
  const audit = join(directory, 'openbao-audit.ndjson');
  const file = (path: string) => JSON.stringify(path.replaceAll('\\', '/'));
  let child: ReturnType<typeof spawn> | undefined;
  let activeConfig: string | undefined;
  const start = async (suffix: '' | '-restored') => {
    const config = join(directory, 'openbao' + suffix + '.hcl');
    const storage = join(directory, 'openbao-storage' + suffix);
    await mkdir(storage, { mode: 0o700 });
    await writeFile(
      config,
      `ui = false
api_addr = "https://127.0.0.1:${port}"
cluster_addr = "https://127.0.0.1:${port + 1}"
storage "raft" {
  path = ${file(storage)}
  node_id = "aio-staging-${slot}"
}
listener "tcp" {
  address = "127.0.0.1:${port}"
  cluster_address = "127.0.0.1:${port + 1}"
  tls_cert_file = ${file(input.certFile)}
  tls_key_file = ${file(input.keyFile)}
  tls_min_version = "tls13"
}
audit "file" "aio-staging" {
  options {
    file_path = ${file(audit)}
    log_raw = "false"
  }
}
`,
      { flag: 'wx', mode: 0o600 },
    );
    activeConfig = config;
    await launch(config);
  };
  const launch = async (config: string) => {
    child = spawn(binary, ['server', '-config=' + config], {
      cwd: directory,
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !/^(BAO|VAULT)_/i.test(name)),
      ),
      stdio: 'ignore',
    });
    await once(child, 'spawn');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  };
  const call = openBaoApi(port, input.ca);
  const ready = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        return (await call<{ initialized: boolean }>('sys/init', 'GET', 200)).initialized;
      } catch (error) {
        if (child?.exitCode !== null || i === 39) throw error;
        await delay(250);
      }
    }
    throw new Error('Staging vault readiness was not observed.');
  };
  const initialize = async () => {
    assert.equal(await ready(), false, 'Staging vault must be a fresh isolated instance.');
    const init = await call<{ root_token: string; keys_base64: string[] }>('sys/init', 'PUT', 200, {
      body: { secret_shares: 3, secret_threshold: 2 },
    });
    assert.ok(init.root_token && init.keys_base64.length === 3);
    await unseal(init.keys_base64);
    return init;
  };
  const waitForSeal = async (sealed: boolean) => {
    for (let i = 0; i < 80; i++) {
      if (sealed) {
        const state = await call<{ sealed: boolean }>('sys/seal-status', 'GET', 200);
        if (state.sealed) return;
      } else {
        const health = await call<{ standby: boolean; sealed: boolean }>(
          'sys/health',
          'GET',
          [200, 429, 500, 503],
        );
        if (health.sealed === false && health.standby === false) return;
      }
      await delay(250);
    }
    throw new Error('Staging vault did not reach the expected seal state.');
  };
  const unseal = async (shares: string[]) => {
    for (const [index, key] of shares.slice(0, 2).entries()) {
      const seal = await call<{ sealed: boolean }>('sys/unseal', 'PUT', 200, { body: { key } });
      assert.equal(seal.sealed, index === 0);
    }
    await waitForSeal(false);
  };
  try {
    await start('');
    const init = await initialize();
    const token = init.root_token;
    let restartedReads = 0;
    await call('sys/mounts/aio-kv', 'POST', 204, {
      token,
      body: { type: 'kv', options: { version: '2' } },
    });
    await call('sys/auth/approle', 'POST', 204, { token, body: { type: 'approle' } });
    const roleIds = new Map<Workload, string>();
    const versions = new Map<Workload, number>();
    for (const [name, value] of Object.entries(input.values) as [Workload, object][]) {
      const path = 'aio-kv/data/' + name;
      const role = 'aio-' + name;
      await call('sys/policies/acl/' + role, 'PUT', 204, {
        token,
        body: {
          policy: `path "${path}" { capabilities = ["read"] }\npath "auth/token/revoke-self" { capabilities = ["update"] }`,
        },
      });
      await call('auth/approle/role/' + role, 'POST', 204, {
        token,
        body: {
          token_policies: [role],
          token_no_default_policy: true,
          token_ttl: '1m',
          token_explicit_max_ttl: '2m',
          secret_id_num_uses: 1,
          secret_id_ttl: '1m',
        },
      });
      await call(path, 'POST', 200, {
        token,
        body: { options: { cas: 0 }, data: { instanceId, value } },
      });
      const reply = await call<{ data: { role_id: string } }>(
        'auth/approle/role/' + role + '/role-id',
        'GET',
        200,
        { token },
      );
      roleIds.set(name, reply.data.role_id);
      versions.set(name, 1);
    }
    const store = {
      port,
      async rotate(workload: Workload, value: object) {
        const previous = versions.get(workload);
        if (!previous) throw new Error('Unknown isolated workload secret role.');
        const { data } = await call<{ data: { version: number } }>(
          'aio-kv/data/' + workload,
          'POST',
          200,
          {
            token,
            body: { options: { cas: previous }, data: { instanceId, value } },
          },
        );
        assert.equal(data.version, previous + 1);
        versions.set(workload, data.version);
        return { previous, current: data.version };
      },
      async destroyRetired(workload: Workload, retired: number) {
        const current = versions.get(workload);
        if (!current || !Number.isInteger(retired) || retired < 1 || retired >= current)
          throw new Error('Expected a retired isolated secret version.');
        await call('aio-kv/destroy/' + workload, 'PUT', 204, {
          token,
          body: { versions: [retired] },
        });
        const { data } = await call<{ data: { versions: Record<string, { destroyed: boolean }> } }>(
          'aio-kv/metadata/' + workload,
          'GET',
          200,
          { token },
        );
        assert.equal(data.versions[String(retired)]?.destroyed, true);
      },
      async grant(workload: Workload): Promise<StagingSecretGrant> {
        const roleId = roleIds.get(workload);
        if (!roleId) throw new Error('Unknown isolated workload secret role.');
        const { wrap_info } = await call<{ wrap_info: { token: string } }>(
          'auth/approle/role/aio-' + workload + '/secret-id',
          'POST',
          200,
          { token, wrap: '1m', body: {} },
        );
        return {
          kind: 'openbao-staging',
          slot,
          instanceId,
          workload,
          roleId,
          wrappedSecret: wrap_info.token,
        };
      },
      async checkpoint() {
        return stagingSecretSnapshot(slot, input.ca, token);
      },
      async read<T>(workload: Workload): Promise<T> {
        const read = async () => readStagingSecret<T>(await store.grant(workload), input.ca);
        try {
          return await read();
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'AbortError' || !activeConfig)
            throw error;
          // A timed-out AppRole operation may already have consumed its one-use grant.
          // Restart this runner-owned process and issue a new grant for the read.
          await stop();
          await launch(activeConfig);
          assert.equal(await ready(), true, 'Staging Raft data was not retained across restart.');
          await unseal(init.keys_base64);
          restartedReads++;
          return read();
        }
      },
      async restore(archive: Buffer) {
        const markerPath = 'aio-kv/data/recovery-marker';
        await call(markerPath, 'POST', 200, {
          token,
          body: { options: { cas: 0 }, data: { instanceId } },
        });
        await stop();
        try {
          await start('-restored');
          const target = await initialize();
          await stagingSecretSnapshot(slot, input.ca, target.root_token, archive);
          await waitForSeal(true);
          await unseal(init.keys_base64);
          await call(markerPath, 'GET', 404, { token });
          await call('auth/token/lookup-self', 'GET', 403, { token: target.root_token });
          const restoredWorkloads = [];
          for (const [workload, value] of Object.entries(input.values) as [Workload, object][]) {
            const recovered = await store.read<object>(workload);
            if (!isDeepStrictEqual(recovered, JSON.parse(JSON.stringify(value))))
              throw new Error('Restored workload secret differs from the checkpoint.');
            restoredWorkloads.push(workload);
          }
          return {
            snapshotSha256: createHash('sha256').update(archive).digest('hex'),
            snapshotBytes: archive.length,
            restoredWorkloads,
            newStorage: true,
            postCheckpointMarkerAbsent: true,
            bootstrapTokenDenied: true,
          } as const;
        } catch (error) {
          await stop();
          throw error;
        }
      },
      async evidence() {
        const bytes = await readFile(audit, 'utf8');
        const events = bytes
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        const reads = [...roleIds.keys()].map((workload) => ({
          workload,
          reads: events.filter(
            (event) =>
              event.type === 'response' &&
              event.request?.path === 'aio-kv/data/' + workload &&
              event.request?.operation === 'read' &&
              !event.error,
          ).length,
        }));
        assert.ok(reads.every((entry) => entry.reads > 0));
        return {
          engine: 'OpenBao 2.7.2 source with AIO build profile',
          binarySha256,
          transport: 'TLSv1.3',
          workloadSecretReads: reads,
          restartedReads,
          auditSha256: createHash('sha256').update(bytes).digest('hex'),
        };
      },
      async close() {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        try {
          for (const [name, current] of versions)
            await call('aio-kv/destroy/' + name, 'PUT', 204, {
              token,
              body: { versions: Array.from({ length: current }, (_, index) => index + 1) },
            });
          await call('auth/token/revoke-self', 'POST', 204, { token, body: {} });
        } finally {
          await stop();
        }
      },
    };
    return store;
  } catch (error) {
    await stop();
    throw error;
  }
}
