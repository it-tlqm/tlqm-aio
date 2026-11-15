import { hash, LmsError } from './security.js';
import type { D1Database } from './types.js';

export type LmsControlCommand = {
  target: 'adapter' | 'mapping';
  accountId?: string;
  orgUnitId?: string;
  enabled: boolean;
  expectedRevision: number;
  reason: string;
  commandKey: string;
};
/** Trusted local operator boundary. Caller must verify fresh MFA + Foundation delegation first.
 * Not exposed as a Worker route; disabled adapters remain manageable by the guarded CLI.
 */
export async function controlLms(
  db: D1Database,
  actor: { accountId: string; tenantId: string },
  command: LmsControlCommand,
) {
  if (
    !Number.isInteger(command.expectedRevision) ||
    command.expectedRevision < 1 ||
    typeof command.enabled !== 'boolean' ||
    !['adapter', 'mapping'].includes(command.target) ||
    command.reason.trim().length < 5 ||
    command.reason.length > 200 ||
    !/^[A-Za-z0-9-]{16,80}$/.test(command.commandKey) ||
    (command.target === 'mapping' && !/^[0-9a-f-]{36}$/.test(command.accountId ?? '')) ||
    (command.orgUnitId !== undefined &&
      (command.target !== 'mapping' || !/^[0-9a-f-]{36}$/.test(command.orgUnitId)))
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  const requestHash = await hash(
    JSON.stringify({
      target: command.target,
      accountId: command.accountId ?? null,
      orgUnitId: command.orgUnitId ?? null,
      enabled: command.enabled,
      expectedRevision: command.expectedRevision,
      reason: command.reason,
      tenantId: actor.tenantId,
    }),
  );
  const receipt = await db
    .prepare(
      'SELECT request_hash,response FROM aio_receipts WHERE actor_account_id=? AND command_key=?',
    )
    .bind(actor.accountId, command.commandKey)
    .first<{ request_hash: string; response: string }>();
  if (receipt) {
    if (receipt.request_hash !== requestHash) throw new LmsError(409, 'IDEMPOTENCY_KEY_REUSED');
    return JSON.parse(receipt.response) as { revision: number; enabled: boolean };
  }
  const table = command.target === 'adapter' ? 'aio_adapter_control' : 'aio_account_links';
  // The sandbox control is global and must never be used for a second tenant implicitly.
  if (
    command.target === 'adapter' &&
    (await db
      .prepare('SELECT 1 FROM aio_account_links WHERE tenant_id<>? LIMIT 1')
      .bind(actor.tenantId)
      .first())
  )
    throw new LmsError(403, 'LMS_PERMISSION_DENIED');
  const where = command.target === 'adapter' ? 'id=1' : 'account_id=? AND tenant_id=?';
  const values = command.target === 'adapter' ? [] : [command.accountId!, actor.tenantId];
  const prior = await db
    .prepare(
      'SELECT revision,' +
        (command.target === 'adapter' ? 'enabled' : 'active AS enabled,org_unit_id AS orgUnitId') +
        ' FROM ' +
        table +
        ' WHERE ' +
        where,
    )
    .bind(...values)
    .first<{ revision: number; enabled: number; orgUnitId?: string }>();
  if (!prior) throw new LmsError(404, 'LMS_MAPPING_NOT_FOUND');
  const operation = crypto.randomUUID();
  const result = {
    revision: command.expectedRevision + 1,
    enabled: command.enabled,
    ...(command.orgUnitId ? { orgUnitId: command.orgUnitId } : {}),
  };
  const body = JSON.stringify(result);
  const selector = ' FROM ' + table + ' WHERE ' + where + ' AND last_operation_id=? AND revision=?';
  const selected = [...values, operation, result.revision];
  try {
    const results = await db.batch([
      db
        .prepare(
          'UPDATE ' +
            table +
            ' SET ' +
            (command.target === 'adapter' ? 'enabled' : 'active') +
            '=?,' +
            (command.orgUnitId ? 'org_unit_id=?,' : '') +
            'revision=revision+1,last_operation_id=? WHERE ' +
            where +
            ' AND revision=? RETURNING revision',
        )
        .bind(
          Number(command.enabled),
          ...(command.orgUnitId ? [command.orgUnitId] : []),
          operation,
          ...values,
          command.expectedRevision,
        ),
      db
        .prepare(
          'INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,subject_account_id,employee_id,tenant_id,action,reason,request_id,details) SELECT ?,?,?,?,' +
            (command.target === 'adapter' ? 'NULL' : 'employee_id') +
            ',?,?,?,?,?' +
            selector,
        )
        .bind(
          operation,
          Date.now(),
          actor.accountId,
          command.accountId ?? null,
          actor.tenantId,
          command.target + '.' + (command.enabled ? 'enabled' : 'disabled'),
          command.reason,
          command.commandKey,
          JSON.stringify({ before: prior, after: result }),
          ...selected,
        ),
      db
        .prepare(
          'INSERT INTO aio_receipts(actor_account_id,command_key,request_hash,response) SELECT ?,?,?,?' +
            selector,
        )
        .bind(actor.accountId, command.commandKey, requestHash, body, ...selected),
    ]);
    // D1 changes includes rows written by revocation triggers; RETURNING identifies the CAS row.
    if (results[0]!.results.length !== 1) throw new LmsError(409, 'REVISION_CONFLICT');
    return result;
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE constraint failed: aio_receipts'))
      return controlLms(db, actor, command);
    throw error;
  }
}
