import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadLocalConfig } from '../src/config.js';
import { OidcClient } from '../src/oidc.js';
import { nextFixtureOtp } from './local-totp.js';

const runtime = await loadLocalConfig();
const workflow = runtime.clients.find((client) => client.code === 'aio-workflows')!;
const foundation = runtime.clients.find((client) => client.code === 'aio-foundation')!;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'vi-VN',
  colorScheme: 'dark',
});
const page = await context.newPage();
let stage = 'open login';
const scans: { screen: string; violations: string[]; incompleteRules: string[] }[] = [];
const cspViolations: string[] = [];
const externalOrigins = new Set<string>();
const allowedOrigins = new Set([
  new URL(runtime.issuer).origin,
  ...runtime.clients.map((client) => client.baseUrl),
]);
context.on('request', (request) => {
  const origin = new URL(request.url()).origin;
  if (!allowedOrigins.has(origin)) externalOrigins.add(origin);
});
await context.addInitScript(() => {
  (window as Window & { qaCsp?: string[] }).qaCsp = [];
  document.addEventListener('securitypolicyviolation', (event) =>
    (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.effectiveDirective),
  );
});
await context.route(
  (url) => allowedOrigins.has(url.origin) && url.pathname === '/auth/callback',
  (route) => route.fulfill({ contentType: 'text/html', body: '<p>Local identity check</p>' }),
);

async function scan(screen: string) {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page
      .locator('input[type="password"], #otp, #totp, #totpSecret')
      .evaluateAll((inputs) => inputs.some((input) => (input as HTMLInputElement).value !== '')),
    false,
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const safe = {
    screen,
    violations: result.violations.map((item) => item.id),
    incompleteRules: result.incomplete.map((item) => item.id),
  };
  scans.push(safe);
  if (safe.violations.length) console.log(JSON.stringify(safe));
  assert.equal(safe.violations.length, 0);
  cspViolations.push(
    ...(await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp ?? [])),
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}

async function designTokens() {
  await page.evaluate(() => document.fonts.ready);
  const actual = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('#kc-login')!;
    return {
      canvas: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.body).fontFamily.includes('Be Vietnam Pro'),
      fontLoaded: [...document.fonts].some(
        (font) => font.family.includes('Be Vietnam Pro') && font.status === 'loaded',
      ),
      button: getComputedStyle(button).backgroundColor,
      radius: getComputedStyle(document.querySelector('main')!).borderRadius,
      heading: getComputedStyle(document.querySelector('h1')!).color,
      light: !document.documentElement.classList.contains('pf-v5-theme-dark'),
      controls: [
        ...document.querySelectorAll<HTMLElement>('input:not([type=hidden]),button,select'),
      ]
        .filter((element) => element.getBoundingClientRect().width > 0)
        .every((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width >= 44 && rect.height >= 44;
        }),
    };
  });
  const expected = {
    canvas: 'rgb(245, 248, 250)',
    font: true,
    fontLoaded: true,
    button: 'rgb(8, 124, 60)',
    radius: '14px',
    heading: 'rgb(34, 56, 115)',
    light: true,
    controls: true,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    console.log(JSON.stringify({ computedStyles: actual }));
  assert.deepEqual(actual, expected);
}

async function layoutGeometry() {
  const actual = await page.evaluate(() => {
    const main = document.querySelector('main')!.getBoundingClientRect();
    const title = document.querySelector('h1')!;
    const form = document.querySelector('#username')!.getBoundingClientRect();
    const language = document.querySelector('#login-select-toggle')!.getBoundingClientRect();
    const story = document.querySelector('.tlqm-story')!.getBoundingClientRect();
    return {
      viewport: innerWidth,
      cardWidth: main.width,
      fieldWidth: form.width,
      languageWidth: language.width,
      titleLines:
        title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight),
      separated: story.width === 0 || story.right < main.left,
    };
  });
  assert.ok(actual.languageWidth >= 120, 'The language name must remain readable.');
  assert.ok(actual.titleLines < 1.1, 'Login heading should not wrap.');
  assert.ok(actual.separated, 'Branding and form must not overlap.');
  if (actual.viewport >= 1100) {
    assert.ok(
      actual.cardWidth >= 440 && actual.fieldWidth >= 360,
      'Desktop form must not collapse into a mobile-width card.',
    );
  } else if (actual.viewport >= 900) {
    assert.ok(actual.cardWidth >= 400 && actual.fieldWidth >= 320);
  } else {
    assert.ok(actual.cardWidth >= Math.min(actual.viewport - 32, 440));
  }
}

try {
  assert.ok(workflow && foundation);
  const oidc = await OidcClient.create(runtime, workflow);
  const initial = await oidc.begin(true);
  await page.goto(initial.url);
  assert.equal(await page.locator('html').getAttribute('lang'), 'vi');
  assert.equal(
    (await page.locator('#kc-header-wrapper').innerText()).replace(/\s+/g, ' ').trim(),
    'TLQM AIO',
  );
  await designTokens();
  await layoutGeometry();
  await scan('login-desktop');
  for (const width of [1904, 1024, 900, 899, 768]) {
    await page.setViewportSize({ width, height: 1030 });
    await layoutGeometry();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'keyboard and button states';
  await page.locator('#username').focus();
  assert.equal(
    await page
      .locator('#username')
      .evaluate((input) => getComputedStyle(input.parentElement!).outlineColor),
    'rgb(10, 148, 68)',
  );
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'password');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#password').getAttribute('type'), 'text');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#password').getAttribute('type'), 'password');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'kc-login');
  await page.locator('#kc-login').hover();
  assert.equal(
    await page.locator('#kc-login').evaluate((button) => getComputedStyle(button).backgroundColor),
    'rgb(7, 105, 52)',
  );
  await page.mouse.move(0, 0);
  stage = 'mobile and language';
  await page.setViewportSize({ width: 390, height: 844 });
  await designTokens();
  await layoutGeometry();
  await scan('login-mobile');
  await page.setViewportSize({ width: 320, height: 740 });
  await layoutGeometry();
  await scan('login-small-mobile');
  const english = await page
    .locator('#login-select-toggle option')
    .evaluateAll((options) =>
      options
        .find(
          (option) =>
            new URL((option as HTMLOptionElement).value, document.baseURI).searchParams.get(
              'kc_locale',
            ) === 'en',
        )
        ?.getAttribute('value'),
    );
  assert.ok(english);
  await page.locator('#login-select-toggle').selectOption(english);
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal((await page.locator('h1').innerText()).trim(), 'Sign in');
  await scan('login-english');
  stage = 'invalid password';
  await page.goto((await oidc.begin(true)).url);
  await page.locator('#username').fill('theme.invalid.local');
  await page.locator('#password').fill('invalid-local-test-password');
  await page.locator('#kc-login').click();
  await page.locator('[aria-invalid="true"]').first().waitFor();
  await page.locator('#password').fill('');
  await scan('login-error');
  stage = 'MFA challenge';
  const administrator = runtime.users.find((user) => user.username === 'demo.admin')!;
  const foundationOidc = await OidcClient.create(runtime, foundation);
  const challenge = await foundationOidc.begin(true);
  await page.goto(challenge.url);
  await page.locator('#username').fill(administrator.username);
  await page.locator('#password').fill(administrator.password);
  await page.locator('#kc-login').click();
  await page.locator('#otp').waitFor();
  stage = 'OTP design tokens';
  await designTokens();
  stage = 'OTP accessibility';
  await scan('otp-mobile');
  stage = 'OTP invalid input';
  await page.locator('#otp').fill('invalid-otp');
  await page.locator('#kc-login').click();
  await page.locator('[aria-invalid="true"]').first().waitFor();
  await page.locator('#otp').fill('');
  stage = 'OTP error accessibility';
  await scan('otp-error');
  const callback = page.waitForRequest(
    (request) => {
      const url = new URL(request.url());
      return url.origin === foundation.baseUrl && url.pathname === '/auth/callback';
    },
    { timeout: 60000 },
  );
  void callback.catch(() => {});
  await page.locator('#otp').fill(await nextFixtureOtp(administrator.id));
  await page.locator('#kc-login').click();
  stage = 'MFA identity proof';
  const tokens = await foundationOidc.complete(
    new URL((await callback).url()),
    challenge.transaction,
  );
  assert.equal(tokens.subject, administrator.subject ?? administrator.id);
  assert.ok(tokens.authenticationMethods?.includes('pwd'));
  assert.ok(tokens.authenticationMethods?.includes('otp'));
  stage = 'theme policy';
  assert.equal(cspViolations.length, 0);
  assert.equal(externalOrigins.size, 0);
  await mkdir('.local/evidence', { recursive: true });
  await writeFile(
    '.local/evidence/sso-theme-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        theme: 'tlqm',
        scans,
        tokensAndGeometry: true,
        keyboard: true,
        lightMode: true,
        localFonts: true,
        mfaVerified: true,
        externalRequests: 0,
        cspViolations: 0,
        privacy:
          'No screenshots, DOM, credentials, OTP, callback URLs, tokens or cookies retained.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: TLQM SSO tokens/font, keyboard, 1440/390/320 layouts, vi/en, invalid login and real MFA; 7 axe scans.',
  );
} catch (error) {
  console.error(
    'SSO theme E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
