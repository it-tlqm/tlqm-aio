import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { fixtureTotp } from './local-totp.js';

const corpusSha256 = 'c95989fecfae9c91aa9f5c730344d5cabd6335bb094c9c60aba16bf1742a72fe';
const contextTerms = ['tlqm', 'tlqmaio', 'aiofoundation', 'aiostaging', 'aioportal'];
const contextEntries = contextTerms.flatMap((term) =>
  ['', '123456789012345', '202620262026', 'password1234'].map((suffix) => term + suffix),
);
const minimumLength = 15;
const rankedCount = 3000;
export const passwordDenylistName = 'aio-staging-password-denylist.txt';
export const stagingPasswordPolicy =
  'length(' +
  minimumLength +
  ') and notUsername(undefined) and notEmail(undefined) and passwordBlacklist(' +
  passwordDenylistName +
  ')';

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function prepareStagingPasswordDenylist(root: string) {
  const corpus = await readFile(join(root, '.local', 'enterprise-public-password-ranking.txt'));
  assert.equal(sha256(corpus), corpusSha256, 'Unexpected staging password corpus digest.');
  const entries = new Map<string, string>();
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(corpus).split(/\r?\n/)) {
    if (line.length < minimumLength || /[\p{Cc}\p{Cf}]/u.test(line)) continue;
    const key = line.toLowerCase();
    if (!entries.has(key)) entries.set(key, line);
    if (entries.size === rankedCount) break;
  }
  assert.equal(entries.size, rankedCount, 'Insufficient length-eligible ranked entries.');
  const contextCandidate = contextEntries.find(
    (value) => value.length >= minimumLength && !entries.has(value),
  );
  assert.ok(contextCandidate);
  const rankedCandidate = entries.values().next().value!;
  const denylist = [...new Set([...entries.keys(), ...contextEntries])].join('\n') + '\n';
  return {
    denylist,
    contextCandidate,
    rankedCandidate,
    evidence: {
      corpusSha256,
      denylistSha256: sha256(denylist),
      rankedCount,
      contextEntries: contextEntries.length,
      minimumLength,
    },
  };
}

export async function verifyStagingPasswordChange(
  browser: Browser,
  foundation: string,
  fixture: { username: string; password: string; otpSecret: string },
  list: Awaited<ReturnType<typeof prepareStagingPasswordDenylist>>,
) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(foundation + '/auth/login');
    await page.locator('#username').fill(fixture.username);
    await page.locator('#password').fill(fixture.password);
    await page.locator('#kc-login').click();
    await page.locator('#otp').waitFor();
    const now = Date.now();
    const period = 30000;
    if (now % period > 26000) await delay(period - (now % period) + 250);
    await page.locator('#otp').fill(fixtureTotp(fixture.otpSecret));
    await page.locator('#kc-login').click();
    const submit = async (target: Page, value: string) => {
      await target.locator('#password-new').fill(value);
      await target.locator('#password-confirm').fill(value);
      await target.locator('#kc-passwd-update-form [name="login"]').click();
    };
    for (const candidate of [list.rankedCandidate, list.contextCandidate]) {
      await submit(page, candidate);
      const error = page.getByText('Invalid password: password is not allowed.', { exact: true });
      await expect(error).toBeVisible();
      await expect(page.locator('#kc-passwd-update-form')).toBeVisible();
    }
    const callback = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.origin === foundation &&
        url.pathname === '/auth/callback' &&
        url.searchParams.has('code')
      );
    });
    await submit(page, randomBytes(32).toString('hex'));
    await callback;
    return {
      ...list.evidence,
      rankedDenied: true,
      contextDenied: true,
      strongAccepted: true,
      userFlow: 'UPDATE_PASSWORD',
      registrationEnabled: false,
    };
  } finally {
    await context.close();
  }
}
