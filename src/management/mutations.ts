import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Identity, Principal, Store } from '../store.js';
import { HttpError } from '../security.js';

export type MutationContext = {
  identity: Identity;
  appCode: string;
  tenantId: string;
  requestId: string;
  idempotencyKey: string;
  reason: string;
};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function databaseError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const value = error as { code?: string; constraint?: string };
  if (value.code === '23505') throw new HttpError(409, 'DUPLICATE_RECORD');
  if (value.code === '23503') throw new HttpError(400, 'INVALID_RELATION');
  if (value.code === '23514' && value.constraint === 'personnel_source_activation_blocked')
    throw new HttpError(409, 'PERSONNEL_SOURCE_ACTIVATION_BLOCKED');
  if (value.code === '23P01')
    throw new HttpError(
      409,
      value.constraint?.endsWith('_overlap') && value.constraint !== 'primary_assignment_no_overlap'
        ? 'RESPONSIBILITY_OVERLAP'
        : 'PRIMARY_ASSIGNMENT_OVERLAP',
    );
  if (value.code === '23514')
    throw new HttpError(
      400,
      value.constraint === 'organization_no_cycle'
        ? 'ORGANIZATION_CYCLE'
        : value.constraint?.includes('assignment')
          ? 'INVALID_ASSIGNMENT_PERIOD'
          : 'INVALID_DATA',
    );
  if (value.code === '23502') throw new HttpError(400, 'MISSING_REQUIRED_FIELD');
  if (value.code === '40001' || value.code === '40P01') throw new HttpError(409, 'RETRY_REQUIRED');
  throw error;
}
export async function mutate<T>(
  store: Store,
  context: MutationContext,
  permission: string | null,
  operation: string,
  input: unknown,
  action: (db: PoolClient, actor: Principal) => Promise<T>,
  authorize?: (db: PoolClient, actor: Principal) => Promise<void>,
): Promise<T> {
  if (permission === null && !authorize)
    throw new Error('Explicit ownership authorization is required for a self-service mutation.');
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(context.idempotencyKey))
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  if (context.reason.trim().length < 5 || context.reason.length > 240)
    throw new HttpError(400, 'REASON_REQUIRED');
  const requestHash = createHash('sha256')
    .update(JSON.stringify(canonical({ operation, input, reason: context.reason })))
    .digest('hex');
  const db = await store.pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(71092027)');
    const actor = await store.principal(context.identity, context.appCode, db);
    if (permission !== null) store.require(actor, permission, context.tenantId);
    if (authorize) await authorize(db, actor);
    const receipt = await db.query(
      'SELECT operation,request_hash,response FROM mutation_receipts WHERE actor_account_id=$1 AND app_code=$2 AND tenant_id=$3 AND idempotency_key=$4',
      [actor.accountId, context.appCode, context.tenantId, context.idempotencyKey],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].operation !== operation || receipt.rows[0].request_hash !== requestHash)
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
      await db.query('COMMIT');
      return receipt.rows[0].response as T;
    }
    const response = JSON.parse(JSON.stringify(await action(db, actor))) as T;
    await db.query(
      'INSERT INTO mutation_receipts(actor_account_id,app_code,tenant_id,idempotency_key,operation,request_hash,response) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        actor.accountId,
        context.appCode,
        context.tenantId,
        context.idempotencyKey,
        operation,
        requestHash,
        JSON.stringify(response),
      ],
    );
    await db.query('COMMIT');
    return response;
  } catch (error) {
    await db.query('ROLLBACK');
    return databaseError(error);
  } finally {
    db.release();
  }
}
export async function auditMutation(
  db: PoolClient,
  context: MutationContext,
  actor: Principal,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
  subjectAccountId: string | null = null,
) {
  await db.query(
    'INSERT INTO audit_events(actor_account_id,subject_account_id,tenant_id,app_code,action,reason,request_id,target_type,target_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      actor.accountId,
      subjectAccountId,
      context.tenantId,
      context.appCode,
      action,
      context.reason.trim(),
      context.requestId,
      targetType,
      targetId,
      JSON.stringify({ before, after }),
    ],
  );
}
