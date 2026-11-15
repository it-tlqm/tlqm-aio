import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { cmsDatabaseUrl, loadCmsConfig } from '../src/cms/database.js';
import { CmsPublicationWorker } from '../src/cms/publication-worker.js';
import {
  createRuntimePublicationAdapters,
  EnvironmentCmsSecretResolver,
} from '../src/cms/connectors.js';

const runtime = await loadLocalConfig();
const config = await loadCmsConfig(runtime.instanceId);
const test = process.argv.includes('--test');
const pool = new pg.Pool({ connectionString: cmsDatabaseUrl(config, test, true), max: 2 });
try {
  const adapters = process.argv.includes('--provider-runtime')
    ? createRuntimePublicationAdapters({ secretResolver: new EnvironmentCmsSecretResolver() })
    : undefined;
  const worker = new CmsPublicationWorker(pool, adapters);
  const once = process.argv.includes('--once');
  do {
    const result = await worker.runOnce();
    if (result.processed) console.log('CMS publication processed: ' + result.state);
    if (once || !result.processed) break;
  } while (true);
} finally {
  await pool.end();
}
