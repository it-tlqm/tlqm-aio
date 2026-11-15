import type { Browser } from '@playwright/test';
import type { LocalConfig, ClientConfig } from '../src/config.js';
import { OidcClient } from '../src/oidc.js';
import { nextFixtureOtp } from './local-totp.js';

/** Test/provisioning helper for owned local fixtures; callback tokens stay in memory. */
export async function clientLoginProof(
  browser: Browser,
  runtime: LocalConfig,
  client: ClientConfig,
  user: { id: string; subject?: string; username: string; password: string },
  mfa = false,
) {
  const oidc = await OidcClient.create(runtime, client),
    context = await browser.newContext();
  let step = 'login';
  try {
    await context.route(
      (url) => url.origin === client.baseUrl && url.pathname === '/auth/callback',
      (route) => route.fulfill({ contentType: 'text/html', body: '<p>Local verification</p>' }),
    );
    const page = await context.newPage(),
      { url, transaction } = await oidc.begin(true);
    const callback = page.waitForRequest(
      (request) => {
        const u = new URL(request.url());
        return u.origin === client.baseUrl && u.pathname === '/auth/callback';
      },
      { timeout: 60000 },
    );
    void callback.catch(() => {});
    await page.goto(url);
    await page.locator('#username').fill(user.username);
    await page.locator('#password').fill(user.password);
    await page.locator('#kc-login').click();
    if (mfa) {
      await page.locator('#otp').fill(await nextFixtureOtp(user.id));
      await page.locator('#kc-login').click();
    }
    const callbackUrl = new URL((await callback).url());
    step = 'verify callback';
    const tokens = await oidc.complete(callbackUrl, transaction);
    step = 'validate identity';
    if (
      tokens.subject !== (user.subject ?? user.id) ||
      !tokens.authenticationMethods?.includes('pwd') ||
      (mfa && !tokens.authenticationMethods.includes('otp')) ||
      typeof tokens.authTime !== 'number' ||
      Date.now() / 1000 - tokens.authTime > 90
    )
      throw new Error('Local identity proof mismatch.');
    return tokens;
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new Error(
      'Local identity proof failed at ' +
        step +
        (code && /^[A-Z0-9_]{1,60}$/.test(code) ? ' (' + code + ')' : '') +
        '; credentials and callback details omitted.',
    );
  } finally {
    await context.close();
  }
}
