import type { Pool } from 'pg';
import type { AppRuntime } from '../config.js';
import { HttpError } from '../security.js';
import { stagingTarget } from '../staging-config.js';

export async function assertFoundationReady(pool: Pool, runtime: AppRuntime, test: boolean) {
  if (runtime.mode === 'staging') {
    const result = await pool.query(
      'SELECT current_database() AS db, current_user AS role, EXISTS(SELECT 1 FROM bootstrap_receipts WHERE name=$1) AS instance',
      ['enterprise-staging:' + runtime.instanceId],
    );
    const state = result.rows[0];
    if (
      state?.db !== stagingTarget(runtime.slot).database ||
      state?.role !== 'aio_runtime' ||
      !state.instance
    )
      throw new HttpError(503, 'DATABASE_NOT_READY');
  }
  const marker = (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose;
  if (marker !== (test || runtime.mode === 'staging' ? 'tlqm-aio-test' : 'tlqm-aio-local'))
    throw new HttpError(503, 'DATABASE_NOT_READY');
}
