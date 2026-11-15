import type { PoolClient } from 'pg';
import type { StagingModule } from '../staging-config.js';

const appendOnly = {
  forms: ['form_versions', 'form_audit', 'form_receipts', 'version_availability'],
  tasks: ['task_comments', 'task_audit', 'task_receipts', 'task_reminders'],
  workflows: [
    'workflow_versions',
    'workflow_audit',
    'workflow_receipts',
    'workflow_run_inputs',
    'workflow_task_results',
    'workflow_run_assignments',
    'workflow_approval_votes',
    'workflow_request_history',
    'workflow_task_supersessions',
    'workflow_task_dependencies',
    'workflow_recall_events',
    'workflow_attachments',
    'workflow_attachment_links',
    'workflow_run_comments',
    'workflow_comment_mentions',
    'workflow_link_attempts',
    'workflow_scheduled_draft_attempts',
    'workflow_email_deliveries',
    'workflow_email_attempts',
    'workflow_document_versions',
    'workflow_document_files',
    'workflow_document_version_files',
  ],
};

export async function grantModuleRuntime(db: PoolClient, module: StagingModule) {
  const role = 'aio_' + module + '_runtime';
  await db.query('BEGIN');
  try {
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.query('GRANT USAGE ON SCHEMA public TO ' + role);
    await db.query('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ' + role);
    await db.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ' + role);
    await db.query('REVOKE INSERT,UPDATE ON schema_migrations,environment_marker FROM ' + role);
    await db.query('REVOKE UPDATE ON ' + appendOnly[module].join(',') + ' FROM ' + role);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
