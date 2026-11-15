import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Log, LogLevel, Miniflare, Response } from 'miniflare';
import type { Request } from 'miniflare';
import { ids } from '../src/fixtures.js';
import { signTrainingIntake } from '../src/lms-intake-proof.js';
import type { TrainingIntakeEnvelope, TrainingIntakeReference } from '../src/lms-intake-proof.js';
import { validateLmsConfig } from '../src/lms/security.js';
import type { LmsConfig } from '../src/lms/security.js';
import type { D1Database, MediaBucket } from '../src/lms/types.js';
import { stagingTarget } from '../src/staging-endpoints.js';
import {
  copyLmsStorage,
  quarantineLmsRestore,
  snapshotLmsStorage,
  verifyStoredMedia,
} from './lms-backup-storage.js';

const tenant = ids.tenantA;
const unit = ids.unitA;
type FixtureBucket = MediaBucket & {
  put(
    key: string,
    value: Uint8Array,
    options: { httpMetadata: { contentType: string }; sha256: string },
  ): Promise<unknown>;
};

async function openWorker(artifact: string, directory: string, config: LmsConfig) {
  const issuer = config.issuer;
  const worker = new Miniflare({
    modules: true,
    scriptPath: join(artifact, 'dist/lms/worker.mjs'),
    compatibilityDate: '2026-07-30',
    host: '127.0.0.1',
    port: 0,
    cf: false,
    log: new Log(LogLevel.NONE),
    d1Databases: { LMS_DB: config.instanceId },
    d1Persist: join(directory, 'd1'),
    r2Buckets: { LMS_MEDIA: config.instanceId + '-media' },
    r2Persist: join(directory, 'r2'),
    bindings: { LMS_CONFIG: JSON.stringify(config) },
    // The service endpoint initializes OIDC discovery, but the rehearsal never obtains a user token.
    outboundService(request: Request) {
      if (request.method !== 'GET' || request.url !== issuer + '/.well-known/openid-configuration')
        return new Response(null, { status: 403 });
      return Response.json({
        issuer,
        authorization_endpoint: issuer + '/protocol/openid-connect/auth',
        token_endpoint: issuer + '/protocol/openid-connect/token',
        jwks_uri: issuer + '/protocol/openid-connect/certs',
        introspection_endpoint: issuer + '/protocol/openid-connect/token/introspect',
        end_session_endpoint: issuer + '/protocol/openid-connect/logout',
      });
    },
  });
  try {
    await worker.ready;
    const db = (await worker.getD1Database('LMS_DB')) as unknown as D1Database;
    const bucket = (await worker.getR2Bucket('LMS_MEDIA')) as unknown as FixtureBucket;
    return { worker, db, bucket, config };
  } catch (error) {
    await worker.dispose();
    throw error;
  }
}

type Runtime = Awaited<ReturnType<typeof openWorker>>;

async function receive(runtime: Runtime, reference: TrainingIntakeReference) {
  const { config, worker } = runtime;
  const envelope: TrainingIntakeEnvelope = {
    instanceId: config.instanceId,
    environment: 'staging',
    reference,
  };
  const proof = await signTrainingIntake(config.clientSecret, config.clientId, 'receive', envelope);
  const response = await worker.dispatchFetch(
    config.baseUrl + '/api/integrations/workflow-intake',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aio-service-proof': proof },
      body: JSON.stringify(envelope),
    },
  );
  const body = (await response.json()) as { id?: string; error?: string };
  assert.equal(
    response.status,
    200,
    /^[A-Z0-9_]+$/.test(body.error ?? '') ? body.error : 'LMS intake failed',
  );
  assert.deepEqual(body, { id: reference.id });
  return reference.id;
}

async function intakeState(db: D1Database, ref: TrainingIntakeReference) {
  const rows = (
    await db
      .prepare(
        `SELECT i.id,i.source_version_id,i.source_round,i.recipient_account_id,
    i.recipient_person_id,i.org_unit_id,i.batch_id,a.id AS audit_id
    FROM lms_training_intakes i JOIN aio_audit a ON a.request_id=i.id
    AND a.tenant_id=i.tenant_id AND a.action='training.workflow_intake_received'
    WHERE i.tenant_id=? AND i.source_run_id=?`,
      )
      .bind(ref.tenantId, ref.runId)
      .all()
  ).results;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: ref.id,
    source_version_id: ref.versionId,
    source_round: ref.round,
    recipient_account_id: ref.accountId,
    recipient_person_id: ref.personId,
    org_unit_id: ref.unitId,
    batch_id: null,
    audit_id: rows[0]!.audit_id,
  });
  return rows[0];
}

export async function prepareLmsRecovery(
  artifact: string,
  directory: string,
  instance: string,
  ref: TrainingIntakeReference,
) {
  assert.equal(ref.tenantId, tenant);
  assert.equal(ref.unitId, unit);
  const slot = 'a';
  const target = stagingTarget(slot);
  const config = validateLmsConfig({
    mode: 'staging',
    purpose: 'tlqm-aio-lms-staging',
    slot,
    instanceId: instance,
    issuer: target.issuer,
    clientId: 'aio-lms-sandbox',
    audience: 'aio-lms-sandbox-api',
    baseUrl: 'https://127.0.0.1:' + target.lms,
    foundationUrl:
      'https://127.0.0.1:' + target.foundation + '/api/v1/integrations/aio-lms-sandbox/authorize',
    clientSecret: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('hex'),
  });
  await mkdir(directory, { mode: 0o700 });
  const sourcePath = join(directory, 'source');
  await mkdir(sourcePath, { mode: 0o700 });
  const runtime = await openWorker(artifact, sourcePath, config);
  const { db } = runtime;
  const employee = randomUUID(),
    course = randomUUID(),
    v1 = randomUUID(),
    v2 = randomUUID();
  const attempt = randomUUID(),
    mediaId = randomUUID();
  const objectKey = tenant + '/' + mediaId + '/' + randomUUID();
  const bytes = Buffer.from('TLQM AIO synthetic LMS recovery object\n');
  const mediaSha = createHash('sha256').update(bytes).digest('hex');
  const spec = JSON.stringify({
    schemaVersion: 1,
    title: 'Synthetic recovery course',
    subtitle: '',
    series: 'AIO',
    duration: 30,
    video: { kind: 'youtube', id: 'abcdefghijk' },
    deadline: '',
    isMandatory: true,
    audienceUnits: [unit],
    checkpoints: [],
    questions: [{ id: 'q1', type: 'single', question: 'Synthetic question', options: ['A', 'B'] }],
    answerKey: { q1: { answer: 0, explanation: '' } },
    attachments: [{ id: 'media', title: 'Reference', mediaId }],
  });
  const courseSha = createHash('sha256').update(spec).digest('base64url');
  const assessment = JSON.stringify({
    schemaVersion: 1,
    lessonTitle: 'Synthetic recovery course',
    series: 'AIO',
    version: 1,
    checksum: courseSha,
    score: 100,
    passed: true,
    review: [],
    tabSwitchCount: 0,
  });
  try {
    const migration = (await import(
      pathToFileURL(join(artifact, 'dist/src/lms/database.js')).href
    )) as typeof import('../src/lms/database.js');
    await migration.migrateLms(db, config);
    const now = Date.now(),
      stamp = new Date(now).toISOString();
    assert.ok(
      await runtime.bucket.put(objectKey, bytes, {
        httpMetadata: { contentType: 'text/plain' },
        sha256: mediaSha,
      }),
    );
    await db.batch([
      db
        .prepare(
          `INSERT INTO employees(id,code,name,department,role,password_hash,credential_kind,created_at,updated_at)
        VALUES (?,'NV-RECOVERY','Synthetic learner','AIO','learner',NULL,'sso-only',?,?)`,
        )
        .bind(employee, stamp, stamp),
      db
        .prepare(
          `INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by)
        VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(ref.accountId, ref.personId, employee, tenant, unit, now, ref.accountId),
      db
        .prepare(
          `INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES (?,?,?,?,?)`,
        )
        .bind(config.issuer, ref.accountId, ref.accountId, now, ref.accountId),
      db
        .prepare(
          `INSERT INTO lms_media(id,tenant_id,owner_unit_id,kind,object_key,name,mime_type,size,sha256,created_by,created_at)
        VALUES (?,?,?,'document',?,'recovery.txt','text/plain',?,?,?,?)`,
        )
        .bind(mediaId, tenant, unit, objectKey, bytes.length, mediaSha, ref.accountId, now),
      db
        .prepare(
          `INSERT INTO lms_courses(id,tenant_id,owner_unit_id,code,draft_json,published_version_id,created_by,created_at,updated_at)
        VALUES (?,?,?,'recovery-course',?,?,?,?,?)`,
        )
        .bind(course, tenant, unit, spec, v2, ref.accountId, now, now),
      db
        .prepare(
          `INSERT INTO lms_course_versions(id,course_id,version,spec_json,checksum,published_by,published_at)
        VALUES (?,?,1,?,?,?,?),(?,?,2,?,?,?,?)`,
        )
        .bind(
          v1,
          course,
          spec,
          courseSha,
          ref.accountId,
          now,
          v2,
          course,
          spec,
          courseSha,
          ref.accountId,
          now,
        ),
      db
        .prepare(
          `INSERT INTO lms_progress(id,employee_id,version_id,position,watched,finished,updated_at)
        VALUES (?,?,?,30,30,1,?)`,
        )
        .bind(randomUUID(), employee, v1, now),
      db
        .prepare(
          `INSERT INTO lms_attempts(id,employee_id,version_id,score,answers_json,snapshot_json,created_at)
        VALUES (?,?,?,100,'{"q1":0}',?,?)`,
        )
        .bind(attempt, employee, v1, assessment, now),
      db
        .prepare(
          `INSERT INTO lms_certificates(id,employee_id,tenant_id,code,snapshot_json,issued_at)
        VALUES (?,?,?,'RECOVERY-CERT',?,?)`,
        )
        .bind(attempt, employee, tenant, assessment, now),
      db
        .prepare('INSERT INTO aio_login_transactions VALUES (?,?,?)')
        .bind('synthetic-transaction-marker', 'fixture-only', now + 60_000),
    ]);
    await receive(runtime, ref);
    await intakeState(db, ref);
    const snapshot = await snapshotLmsStorage(db, config, tenant);
    const media = await verifyStoredMedia(db, runtime.bucket);
    assert.deepEqual(media, { objects: 1, bytes: bytes.length });
    return {
      config,
      sourcePath,
      snapshot,
      media,
      ref,
      employee,
      course,
      v1,
      v2,
      attempt,
      courseSha,
    };
  } finally {
    await runtime.worker.dispose();
  }
}

type Prepared = Awaited<ReturnType<typeof prepareLmsRecovery>>;
type Files = Awaited<ReturnType<typeof copyLmsStorage>>;

export async function verifyLmsRollback(
  artifacts: string[],
  root: string,
  backup: string,
  files: Files,
  seed: Prepared,
) {
  const target = join(root, 'rollback');
  await mkdir(target, { mode: 0o700 });
  await copyLmsStorage(backup, target, files);
  for (const artifact of artifacts) {
    const runtime = await openWorker(artifact, target, seed.config);
    try {
      const ready = await runtime.worker.dispatchFetch(seed.config.baseUrl + '/health/ready');
      assert.equal(ready.status, 200);
      assert.equal(
        ((await ready.json()) as { instanceId: string }).instanceId,
        seed.config.instanceId,
      );
      assert.deepEqual(await snapshotLmsStorage(runtime.db, runtime.config, tenant), seed.snapshot);
      assert.deepEqual(await verifyStoredMedia(runtime.db, runtime.bucket), seed.media);
      const prior = await intakeState(runtime.db, seed.ref);
      assert.equal(await receive(runtime, seed.ref), seed.ref.id);
      assert.deepEqual(await intakeState(runtime.db, seed.ref), prior);
      assert.deepEqual(await snapshotLmsStorage(runtime.db, runtime.config, tenant), seed.snapshot);
    } finally {
      await runtime.worker.dispose();
    }
  }
  return {
    workerStarts: artifacts.length,
    journalAndDataRetained: true,
    mediaVerified: seed.media.objects,
    intakeReplayPreserved: true,
  };
}

export async function restoreLmsRecovery(
  artifact: string,
  root: string,
  backup: string,
  files: Files,
  seed: Prepared,
  replayOutbox: (deliver: () => Promise<string>) => Promise<void>,
) {
  const destination = join(root, 'target');
  await mkdir(destination, { mode: 0o700 });
  await copyLmsStorage(backup, destination, files);
  const runtime = await openWorker(artifact, destination, seed.config);
  const { db, config, worker } = runtime;
  try {
    const health = await worker.dispatchFetch(config.baseUrl + '/health/ready');
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { instanceId: string }).instanceId, config.instanceId);
    assert.deepEqual(await snapshotLmsStorage(db, config, tenant), seed.snapshot);
    assert.deepEqual(await verifyStoredMedia(db, runtime.bucket), seed.media);
    const learning = await db
      .prepare(
        `SELECT p.version_id,p.position,p.watched,p.finished,
      a.score,c.published_version_id,v.checksum,json_extract(a.snapshot_json,'$.version') AS assessed,
      json_extract(cert.snapshot_json,'$.checksum') AS certificate_checksum
      FROM lms_progress p JOIN lms_attempts a ON (a.employee_id,a.version_id)=(p.employee_id,p.version_id)
      JOIN lms_course_versions v ON v.id=p.version_id JOIN lms_courses c ON c.id=v.course_id
      JOIN lms_certificates cert ON cert.id=a.id
      WHERE p.employee_id=? AND c.id=? AND a.id=?`,
      )
      .bind(seed.employee, seed.course, seed.attempt)
      .first();
    assert.deepEqual(learning, {
      version_id: seed.v1,
      position: 30,
      watched: 30,
      finished: 1,
      score: 100,
      published_version_id: seed.v2,
      checksum: seed.courseSha,
      assessed: 1,
      certificate_checksum: seed.courseSha,
    });
    const intake = await intakeState(db, seed.ref);
    await replayOutbox(() => receive(runtime, seed.ref));
    assert.deepEqual(await intakeState(db, seed.ref), intake);
    assert.deepEqual(await snapshotLmsStorage(db, config, tenant), seed.snapshot);

    const restoreId = randomUUID();
    await quarantineLmsRestore(
      db,
      seed.ref.accountId,
      tenant,
      restoreId,
      config.instanceId,
      'staging',
      seed.media.objects,
    );
    const after = await snapshotLmsStorage(db, config, tenant);
    assert.deepEqual(after.business, seed.snapshot.business);
    assert.equal(after.ownershipHash, seed.snapshot.ownershipHash);
    assert.equal(after.audit.count, seed.snapshot.audit.count + 1);
    assert.deepEqual(await intakeState(db, seed.ref), intake);
    for (const table of ['aio_sessions', 'aio_login_transactions', 'sessions']) {
      assert.equal(await db.prepare('SELECT count(*) AS n FROM ' + table).first('n'), 0);
    }
    assert.equal(
      await db.prepare('SELECT count(*) AS n FROM aio_account_links WHERE active<>0').first('n'),
      0,
    );
    const denied = await worker.dispatchFetch(config.baseUrl + '/api/v1/me');
    assert.equal(denied.status, 503);
    assert.equal(((await denied.json()) as { error: string }).error, 'LMS_ADAPTER_DISABLED');
    return {
      ready: true,
      learningVersionPinned: true,
      attemptAndCertificateRetained: true,
      media: seed.media,
      schema: seed.snapshot.schema.map(({ version }) => version),
      businessTables: seed.snapshot.business.length,
      duplicateIntakes: 0,
      duplicateIntakeAuditEvents: 0,
      sessionsAndLoginTransactionsCleared: true,
      adapterDisabled: true,
      activeMappings: 0,
    };
  } finally {
    await worker.dispose();
  }
}
