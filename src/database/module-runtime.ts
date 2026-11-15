import type { Pool } from 'pg';
import type { AppRuntime } from '../config.js';
import { HttpError } from '../security.js';
import type { StagingModule } from '../staging-config.js';
import { stagingDatabaseTls, stagingModuleDatabase } from '../staging-config.js';
import { formsDatabaseUrl, loadFormsConfig } from '../forms/database.js';
import { tasksDatabaseUrl, loadTasksConfig } from '../tasks/database.js';
import { workflowsDatabaseUrl, loadWorkflowsConfig } from '../workflows/database.js';

export async function moduleDatabaseUrl(runtime: AppRuntime, module: StagingModule, test: boolean) {
  if (runtime.mode === 'staging') {
    const url = runtime.moduleDatabases?.[module];
    if (!url) throw new Error('Missing staging module database.');
    return url;
  }
  switch (module) {
    case 'forms':
      return formsDatabaseUrl(await loadFormsConfig(runtime.instanceId), test);
    case 'tasks':
      return tasksDatabaseUrl(await loadTasksConfig(runtime.instanceId), test);
    case 'workflows':
      return workflowsDatabaseUrl(await loadWorkflowsConfig(runtime.instanceId), test);
  }
}

export async function moduleDatabaseConnection(
  runtime: AppRuntime,
  module: StagingModule,
  test: boolean,
) {
  return {
    connectionString: await moduleDatabaseUrl(runtime, module, test),
    ...(runtime.mode === 'staging' && { ssl: stagingDatabaseTls(runtime.databaseCa) }),
  };
}

export async function assertModuleReady(
  pool: Pool,
  runtime: AppRuntime,
  module: StagingModule,
  test: boolean,
  code: string,
) {
  const { rows } = await pool.query(
    'SELECT instance_id,purpose,current_database() AS database,current_user AS role FROM environment_marker',
  );
  const [marker] = rows;
  const staging = runtime.mode === 'staging' ? stagingModuleDatabase(runtime.slot, module) : null;
  if (
    rows.length !== 1 ||
    marker.instance_id !== runtime.instanceId ||
    marker.purpose !== (staging?.purpose ?? 'tlqm-aio-' + module + (test ? '-test' : '-local')) ||
    (staging && (marker.database !== staging.name || marker.role !== staging.role))
  )
    throw new HttpError(503, code);
}
