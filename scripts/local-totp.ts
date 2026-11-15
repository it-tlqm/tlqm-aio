import { createHmac } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

// Test-fixture helper only. The application never handles or verifies OTP secrets.
export function fixtureTotp(secret: string, now = Date.now(), digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
type Secrets = Record<string, { secret: string; lastUsedStep?: number }>;
export async function readMfaFixtures(): Promise<Secrets> {
  try {
    return JSON.parse(await readFile('.local/mfa.json', 'utf8')) as Secrets;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
export async function saveMfaFixture(id: string, secret: string) {
  const entries = await readMfaFixtures();
  entries[id] = { secret };
  await writeFile('.local/mfa.next.json', JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
  await rename('.local/mfa.next.json', '.local/mfa.json');
}
export async function nextFixtureOtp(id: string): Promise<string> {
  const entries = await readMfaFixtures();
  const entry = entries[id];
  if (!entry) throw new Error('Run local:mfa to enroll the synthetic administrator.');
  const step = Math.floor(Date.now() / 30_000);
  if (entry.lastUsedStep !== undefined && entry.lastUsedStep >= step)
    await new Promise((resolve) => setTimeout(resolve, (step + 1) * 30_000 - Date.now() + 250));
  entry.lastUsedStep = Math.floor(Date.now() / 30_000);
  await writeFile('.local/mfa.next.json', JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
  await rename('.local/mfa.next.json', '.local/mfa.json');
  return fixtureTotp(entry.secret);
}
