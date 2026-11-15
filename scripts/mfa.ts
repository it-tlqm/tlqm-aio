import { chromium } from '@playwright/test';
import { loadLocalConfig } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { configureLocalMfa } from './mfa-config.js';
import { authenticateMfaFixture } from './mfa-browser.js';

let stage = 'configure isolated realm';
try {
  const runtime = await configureLocalMfa(await loadLocalConfig());
  const browser = await chromium.launch({ headless: true });
  try {
    // Establish and verify the second administrator before changing the first administrator's enrollment.
    for (const id of [ids.recovery, ids.admin]) {
      stage =
        id === ids.recovery
          ? 'recovery administrator enrollment'
          : 'primary administrator enrollment';
      await authenticateMfaFixture(browser, runtime, id, true);
    }
  } finally {
    await browser.close();
  }
  console.log(
    'Local MFA verified for both synthetic administrators; OTP secrets retained only in .local/.',
  );
} catch (error) {
  if (error instanceof Error && error.name === 'MfaSetupError') console.error(error.message);
  if (error instanceof Error && error.name === 'MfaBrowserError') console.error(error.message);
  if (
    error instanceof Error &&
    /^(Synthetic MFA identity|Bootstrap administrator|Unexpected local authentication|Ambiguous local authentication|Missing created subject|Expected local client)/.test(
      error.message,
    )
  )
    console.error(error.message);
  console.error('Local MFA setup failed at: ' + stage + '. Credentials and browser URLs omitted.');
  process.exitCode = 1;
}
