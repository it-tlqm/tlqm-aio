import { request } from 'node:https';
import { stagingSecretPorts } from '../src/staging-secret-client.js';
import type { StagingSlot } from '../src/staging-endpoints.js';

// The archive contains encrypted Raft state. Keep it in memory for this synthetic rehearsal.
const maxSnapshotBytes = 8 * 1024 * 1024;

export function stagingSecretSnapshot(
  slot: StagingSlot,
  ca: string,
  token: string,
  archive?: Buffer,
): Promise<Buffer> {
  const origin = 'https://127.0.0.1:' + stagingSecretPorts[slot];
  const path = '/v1/sys/storage/raft/snapshot' + (archive ? '-force' : '');
  const status = archive ? 204 : 200;
  return new Promise((resolve, reject) => {
    const req = request(
      origin + path,
      {
        method: archive ? 'POST' : 'GET',
        ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
        signal: AbortSignal.timeout(20000),
        headers: {
          'x-vault-token': token,
          ...(archive && {
            'content-type': 'application/octet-stream',
            'content-length': archive.length,
          }),
        },
      },
      (response) => {
        if (response.statusCode !== status) {
          response.resume();
          reject(new Error('Staging Raft snapshot returned HTTP ' + response.statusCode));
          return;
        }
        let length = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > maxSnapshotBytes) {
            response.destroy(new Error('Staging Raft snapshot exceeded its size limit.'));
          } else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (!archive && !length) reject(new Error('Empty staging Raft snapshot.'));
          else resolve(Buffer.concat(chunks));
        });
      },
    );
    req.on('error', reject);
    req.end(archive);
  });
}
