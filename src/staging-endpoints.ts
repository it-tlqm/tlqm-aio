export type StagingSlot = 'a' | 'b';

export function stagingAppOrigin(
  slot: StagingSlot,
  code: string,
  port: number,
  namedHosts = false,
) {
  const host = namedHosts ? `${code}-${slot}.localhost` : '127.0.0.1';
  return `https://${host}:${port}`;
}

export function stagingTarget(slot: StagingSlot) {
  const offset = slot === 'a' ? 0 : 10;
  return {
    issuer: 'https://127.0.0.1:' + (4518 + offset) + '/realms/aio-staging-' + slot,
    foundation: 4510 + offset,
    probe: 4511 + offset,
    forms: 4513 + offset,
    lms: 4514 + offset,
    workflows: 4515 + offset,
    tasks: 4516 + offset,
    dbPort: slot === 'a' ? '55438' : '55439',
    database: 'aio_foundation_stage_' + slot,
  };
}
