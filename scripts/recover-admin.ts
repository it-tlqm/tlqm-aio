import { chromium } from '@playwright/test';
import { loadLocalConfig } from '../src/config.js';
import { recoverLocalAdministrator } from './recovery.js';

const browser = await chromium.launch({ headless: true });
try {
  await recoverLocalAdministrator(await loadLocalConfig(), browser);
  console.log(
    'Synthetic primary administrator recovered with separate MFA proof; prior sessions revoked and both local databases audited.',
  );
} catch {
  console.error(
    'Local recovery did not complete. Keep MFA enforcement enabled; inspect the recovery audit and rerun after restoring dependencies. No secrets logged.',
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
