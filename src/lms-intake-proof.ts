import type { IntakeReference } from './workflows/intakes.js';

export type TrainingIntakeReference = IntakeReference & { kind: 'lms-training' };
export type TrainingIntakeEnvelope = {
  instanceId: string;
  environment: 'local' | 'test' | 'staging';
  reference: TrainingIntakeReference;
};
export type TrainingIntakeOperation = 'receive' | 'status' | 'source';
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const referenceKeys = [
  'id',
  'kind',
  'tenantId',
  'unitId',
  'runId',
  'versionId',
  'round',
  'accountId',
  'personId',
];
export function trainingIntakeEnvelope(value: unknown): value is TrainingIntakeEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as TrainingIntakeEnvelope;
  const ref = envelope.reference;
  return (
    Object.keys(envelope).length === 3 &&
    uuid.test(envelope.instanceId) &&
    ['local', 'test', 'staging'].includes(envelope.environment) &&
    !!ref &&
    typeof ref === 'object' &&
    Object.keys(ref).length === referenceKeys.length &&
    referenceKeys.every((key) => Object.hasOwn(ref, key)) &&
    ref.kind === 'lms-training' &&
    Number.isSafeInteger(ref.round) &&
    ref.round > 0 &&
    [ref.id, ref.tenantId, ref.unitId, ref.runId, ref.versionId, ref.accountId, ref.personId].every(
      (id) => typeof id === 'string' && uuid.test(id),
    )
  );
}

export function trainingIntakeReferenceKey(ref: TrainingIntakeReference) {
  return [
    ref.id,
    ref.kind,
    ref.tenantId,
    ref.unitId,
    ref.runId,
    ref.versionId,
    ref.round,
    ref.accountId,
    ref.personId,
  ];
}

async function key(secret: string, appCode: string) {
  const raw = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(appCode),
      info: encoder.encode('aio-training-intake-v1'),
    },
    raw,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

async function message(
  appCode: string,
  operation: TrainingIntakeOperation,
  envelope: TrainingIntakeEnvelope,
  token: string,
  time: number,
) {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))),
  );
  return encoder.encode(
    JSON.stringify([
      'POST',
      'aio-training-intake-v1',
      appCode,
      operation,
      time,
      digest,
      envelope.instanceId,
      envelope.environment,
      ...trainingIntakeReferenceKey(envelope.reference),
    ]),
  );
}

export async function signTrainingIntake(
  secret: string,
  appCode: string,
  operation: TrainingIntakeOperation,
  envelope: TrainingIntakeEnvelope,
  token = '',
  time = Math.floor(Date.now() / 1000),
) {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await key(secret, appCode),
      await message(appCode, operation, envelope, token, time),
    ),
  );
  return time + '.' + Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyTrainingIntake(
  secret: string,
  appCode: string,
  operation: TrainingIntakeOperation,
  envelope: TrainingIntakeEnvelope,
  proof: string,
  token = '',
) {
  const match = /^(\d{10})\.([0-9a-f]{64})$/.exec(proof);
  if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 30) return false;
  return crypto.subtle.verify(
    'HMAC',
    await key(secret, appCode),
    Uint8Array.from(match[2]!.match(/../g)!, (byte) => parseInt(byte, 16)),
    await message(appCode, operation, envelope, token, Number(match[1])),
  );
}
