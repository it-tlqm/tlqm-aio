import type { Browser } from '@playwright/test';
import type { LocalConfig } from '../src/config.js';
import { OidcClient } from '../src/oidc.js';
import { nextFixtureOtp, saveMfaFixture } from './local-totp.js';

export async function authenticateMfaFixture(
  browser: Browser,
  runtime: LocalConfig,
  id: string,
  enroll = false,
) {
  const user = runtime.users.find((value) => value.id === id);
  const client = runtime.clients.find((value) => value.code === 'aio-foundation');
  if (!user || !client) throw new Error('Unknown local MFA fixture.');
  const oidc = await OidcClient.create(runtime, client);
  // The callback is intercepted locally and verified with the same OIDC client. No running API is needed.
  const context = await browser.newContext();
  let step = 'open login';
  const page = await context.newPage();
  try {
    await context.route(
      (url) => url.origin === client.baseUrl && url.pathname === '/auth/callback',
      (route) => route.fulfill({ contentType: 'text/html', body: '<p>Local MFA check</p>' }),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const { url, transaction } = await oidc.begin(true);
      const callbackRequest = page.waitForRequest(
        (request) => {
          const target = new URL(request.url());
          return target.origin === client.baseUrl && target.pathname === '/auth/callback';
        },
        { timeout: 60000 },
      );
      void callbackRequest.catch(() => {});
      await page.goto(url);
      step = 'submit password';
      if (await page.locator('#username').isVisible())
        await page.locator('#username').fill(user.username);
      else if ((await page.locator('#kc-attempted-username').inputValue()) !== user.username)
        throw new Error('Unexpected reauthentication subject.');
      await page.locator('#password').fill(user.password);
      await page.locator('#kc-login').click();
      step = 'await OTP or enrollment';
      await page.waitForFunction(
        () =>
          document.querySelector('#otp, #totpSecret') !== null ||
          location.pathname === '/auth/callback',
        undefined,
        { timeout: 15000 },
      );
      if (await page.locator('#totpSecret').count()) {
        step = 'submit enrollment';
        if (!enroll) throw new Error('MFA fixture enrollment is required.');
        const secret = await page.locator('#totpSecret').inputValue();
        // Save before submission so a crash after successful enrollment cannot lose the local seed.
        await saveMfaFixture(id, secret);
        await page.locator('#totp').fill(await nextFixtureOtp(id));
        await page.locator('#userLabel').fill('AIO local synthetic fixture');
        await page.locator('#saveTOTPBtn').click();
      } else if (await page.locator('#otp').count()) {
        step = 'submit OTP';
        await page.locator('#otp').fill(await nextFixtureOtp(id));
        await page.locator('#kc-login').click();
      }
      const callback = await callbackRequest;
      step = 'verify tokens';
      const tokens = await oidc.complete(new URL(callback.url()), transaction);
      if (tokens.subject !== (user.subject ?? id)) throw new Error('MFA proof subject mismatch.');
      if (
        tokens.authenticationMethods?.includes('pwd') &&
        tokens.authenticationMethods.includes('otp') &&
        typeof tokens.authTime === 'number'
      )
        return { ...tokens, authTime: tokens.authTime };
      if (!enroll) throw new Error('The local session did not prove both password and OTP.');
      // First enrollment is not itself a successful OTP authentication execution; force a fresh login.
    }
    throw new Error('MFA fixture could not obtain verified authentication methods.');
  } catch (error) {
    const inputIds = await page
      .locator('input')
      .evaluateAll((inputs) => inputs.map((input) => input.id))
      .catch(() => []);
    throw Object.assign(
      new Error(
        step +
          '; error=' +
          (error instanceof Error ? error.name : 'unknown') +
          '; path=' +
          new URL(page.url()).pathname +
          '; inputs=' +
          inputIds.join(','),
      ),
      { name: 'MfaBrowserError' },
    );
  } finally {
    await context.close();
  }
}
