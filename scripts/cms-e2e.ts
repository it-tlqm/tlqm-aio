import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import { loadLocalConfig } from '../src/config.js';
import { ids } from '../src/fixtures.js';

const runtime = await loadLocalConfig();
const user = runtime.users.find((value) => value.id === ids.learner);
assert.ok(user);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4107/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === 'http://127.0.0.1:4107' && url.pathname === '/', {
    timeout: 20000,
  });
  await page.getByRole('heading', { name: 'Quản lý website và nội dung' }).waitFor();
  await page.getByText('Tà Lùng Quang Minh Logistics', { exact: true }).first().waitFor();
  await page.getByText('Collections', { exact: true }).waitFor();
  await page.getByText('Media registry', { exact: true }).waitFor();
  const publicResponse = await page.request.get(
    'http://127.0.0.1:4107/api/v1/cms/public/page?websiteCode=talung-logistics&path=%2Fabout&locale=vi',
  );
  assert.equal(publicResponse.status(), 200);
  assert.match(publicResponse.headers()['cache-control'] ?? '', /public/);
  assert.ok(publicResponse.headers().etag);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  assert.equal(axe.violations.length, 0);
  const headings = await page.locator('h1,h2,h3').allTextContents();
  await writeFile(
    '.local/evidence/cms-local-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        url: page.url(),
        headings,
        axeViolations: axe.violations.length,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS: CMS SSO UI opened and rendered website, collections and media registry.');
  await context.close();
} finally {
  await browser.close();
}
