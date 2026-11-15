import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
type Service = 'keycloak' | 'foundation-db' | 'identity-db';
type Container = {
  id: string;
  name: string;
  image: string;
  project: string;
  service: string;
  running: boolean;
  ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
};
const images = {
  keycloak: 'quay.io/keycloak/keycloak:26.8.2',
  'foundation-db': 'postgres:17.7-alpine',
  'identity-db': 'postgres:17.7-alpine',
};
async function docker(args: string[], timeout = 30_000) {
  try {
    return (
      await execute('docker', ['--context', 'desktop-linux', ...args], {
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  } catch {
    throw new Error(
      'Guarded local Docker command failed. Container environment and stderr omitted.',
    );
  }
}
export async function assertLocalDocker() {
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT)
    throw new Error('Docker overrides are not allowed.');
  const endpoint = JSON.parse(
    await docker([
      'context',
      'inspect',
      'desktop-linux',
      '--format',
      '{{json .Endpoints.docker.Host}}',
    ]),
  ) as string;
  if (!endpoint.startsWith('npipe://'))
    throw new Error('A local Windows named-pipe Docker endpoint is required.');
}
export async function localContainer(service: Service): Promise<Container> {
  await assertLocalDocker();
  const ids = (
    await docker([
      'ps',
      '-aq',
      '--filter',
      'label=com.docker.compose.project=tlqm-aio-local',
      '--filter',
      'label=com.docker.compose.service=' + service,
    ])
  )
    .split(/\r?\n/)
    .filter(Boolean);
  if (ids.length !== 1) throw new Error('Expected exactly one isolated AIO service container.');
  const format =
    '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"ports":{{json .HostConfig.PortBindings}}}';
  const result = JSON.parse(await docker(['inspect', ids[0]!, '--format', format])) as Container;
  if (
    result.name !== '/tlqm-aio-local-' + service + '-1' ||
    result.project !== 'tlqm-aio-local' ||
    result.service !== service ||
    result.image !== images[service]
  )
    throw new Error('Container identity does not match the approved local stack.');
  const expected = service === 'keycloak' ? '8180' : service === 'foundation-db' ? '5438' : null;
  for (const bindings of Object.values(result.ports ?? {}))
    for (const binding of bindings ?? [])
      if (binding.HostIp !== '127.0.0.1' || binding.HostPort !== expected)
        throw new Error('Unexpected container host binding.');
  return result;
}
export async function stopLocalService(service: Service) {
  const container = await localContainer(service);
  if (!container.running) throw new Error('Rehearsal only stops a verified running service.');
  await docker(['stop', '--time', '10', container.id]);
  if ((await localContainer(service)).running) throw new Error('Local service did not stop.');
}
export async function startLocalService(service: Service) {
  const container = await localContainer(service);
  if (!container.running) await docker(['start', container.id]);
}
export async function localStats() {
  const containers = await Promise.all(
    (['keycloak', 'foundation-db', 'identity-db'] as const).map(localContainer),
  );
  return (
    await docker(['stats', '--no-stream', '--format', '{{json .}}', ...containers.map((c) => c.id)])
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          Name: string;
          CPUPerc: string;
          MemUsage: string;
          MemPerc: string;
          PIDs: string;
        },
    );
}
