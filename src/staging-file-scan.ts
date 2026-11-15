import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:tls';
import type { StagingSlot } from './staging-endpoints.js';

type ScanStream = Pick<ReadableStream<Uint8Array>, 'getReader'>;
type ScanInput = Uint8Array | ScanStream;

export type StagingScannerTls = { ca: Buffer; cert: Buffer; key: Buffer };

export async function loadStagingScannerTls(directory: string | undefined) {
  if (!directory) throw new Error('Missing staging scanner TLS credentials.');
  const [ca, cert, key] = await Promise.all(
    ['server.pem', 'client.pem', 'client-key.pem'].map((file) => readFile(join(directory, file))),
  );
  return { ca: ca!, cert: cert!, key: key! };
}

export const stagingScannerPort = (slot: StagingSlot) => (slot === 'a' ? 4530 : 4540);
const chunkBytes = 64 * 1024;
const maxBytes = 100 * 1024 * 1024;
const timeoutMs = 15000;

async function* chunks(content: ScanInput) {
  if (content instanceof Uint8Array) {
    yield content;
    return;
  }
  const reader = content.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function stagingFileScanner(slot: StagingSlot, tls: StagingScannerTls | undefined) {
  if (!tls) throw new Error('Missing staging scanner TLS credentials.');
  return async (content: ScanInput) => {
    const socket = connect({
      ...tls,
      host: '127.0.0.1',
      port: stagingScannerPort(slot),
      minVersion: 'TLSv1.3',
      rejectUnauthorized: true,
    });
    const timeout = setTimeout(
      () => socket.destroy(new Error('File scanner timed out.')),
      timeoutMs,
    );
    let reply = '';
    let complete = false;
    const result = new Promise<'clean' | 'infected'>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('close', () => reject(new Error('Incomplete file scanner response.')));
      socket.setEncoding('ascii');
      socket.on('data', (part: string) => {
        reply += part;
        if (reply.length > 512) socket.destroy(new Error('Invalid file scanner response.'));
        else if (reply.endsWith('\0')) {
          if (reply === 'stream: OK\0' && complete) resolve('clean');
          else if (/^stream: [A-Za-z0-9_.-]+ FOUND\0$/.test(reply)) resolve('infected');
          else reject(new Error('Invalid file scanner response.'));
        }
      });
    });
    const write = async (value: Uint8Array) => {
      if (socket.destroyed) throw new Error('File scanner disconnected.');
      if (!socket.write(value)) {
        const controller = new AbortController();
        const disconnected = () => controller.abort();
        socket.once('close', disconnected);
        try {
          await once(socket, 'drain', { signal: controller.signal });
        } finally {
          socket.off('close', disconnected);
        }
      }
    };
    const transfer = async () => {
      await once(socket, 'secureConnect');
      await write(Buffer.from('zINSTREAM\0'));
      let total = 0;
      for await (const part of chunks(content)) {
        total += part.byteLength;
        if (total > maxBytes) throw new Error('Scanner input limit exceeded.');
        for (let offset = 0; offset < part.byteLength; offset += chunkBytes) {
          const data = part.subarray(offset, offset + chunkBytes);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(data.byteLength);
          await write(header);
          await write(data);
        }
      }
      if (!total) throw new Error('Empty scanner input.');
      complete = true;
      await write(Buffer.alloc(4));
    };
    try {
      const [, verdict] = await Promise.all([transfer(), result]);
      return verdict;
    } finally {
      clearTimeout(timeout);
      socket.destroy();
    }
  };
}
