import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { DirectoryMetadata, parseDirectoryConfiguration } from '../src/management/metadata.js';
import type { DirectoryConfiguration } from '../src/management/metadata.js';
import { mutate } from '../src/management/mutations.js';
import type { MutationContext } from '../src/management/mutations.js';
import { ids } from '../src/fixtures.js';
const runtime = await loadLocalConfig(),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 3 }),
  store = new Store(pool),
  service = new DirectoryMetadata(store);
const c = (subject: string = ids.admin, tenantId: string = ids.tenantA): MutationContext => ({
  identity: {
    issuer: runtime.issuer,
    subject,
    authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ['pwd', 'otp'],
  },
  appCode: 'aio-foundation',
  tenantId,
  reason: 'Kiểm thử cấu hình hồ sơ giả lập',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
});
const config = (): DirectoryConfiguration => ({
  schema: {
    schemaVersion: 1,
    title: 'Hồ sơ cấu hình',
    sections: [
      {
        id: 'general',
        title: 'Thông tin',
        fields: [
          { id: 'city', type: 'shortText', label: 'Địa phương', required: false, maxLength: 100 },
          {
            id: 'hr_note',
            type: 'shortText',
            label: 'Ghi chú nội bộ HR',
            required: false,
            maxLength: 100,
          },
          { id: 'office', type: 'shortText', label: 'Văn phòng', required: false, maxLength: 100 },
        ],
      },
    ],
  },
  selfView: ['city', 'office'],
  selfEdit: ['city'],
});
let version = 0,
  personId = '';
const actor = (subject: string = ids.admin) =>
  store.principal(c(subject).identity, 'aio-foundation');
async function publish(value: DirectoryConfiguration) {
  const old = await service.configuration(await actor(), ids.tenantA, 'people');
  const draft = await service.saveConfiguration(
    c(),
    'people',
    value,
    Number(old.configuration?.revision ?? 0),
  );
  const published = await service.publish(c(), 'people', Number(draft.revision));
  version = Number(published.currentVersion);
  return published;
}
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  personId = (await actor(ids.learner)).personId;
  await publish(config());
});
after(() => pool.end());
test('configuration validates self-service field boundaries and blocks hidden dependencies', () => {
  const value = config();
  const parsed = parseDirectoryConfiguration(value, 'people');
  assert.deepEqual(parsed.selfEdit, value.selfEdit);
  assert.equal(parsed.schema.sections[0]!.fields[0]!.minLength, 0);
  assert.equal(value.schema.sections[0]!.fields[0]!.minLength, undefined);
  assert.throws(() => parseDirectoryConfiguration({ ...value, selfEdit: ['hr_note'] }, 'people'), {
    code: 'PROFILE_CONFIGURATION_INVALID',
  });
  value.schema.sections[0]!.fields[0]!.visibleWhen = {
    mode: 'all',
    rules: [{ fieldId: 'hr_note', operator: 'answered' }],
  };
  assert.throws(() => parseDirectoryConfiguration(value, 'people'), {
    code: 'PROFILE_SELF_CONDITION_HIDDEN',
  });
  assert.throws(() => parseDirectoryConfiguration(config(), 'accounts'), {
    code: 'INVALID_REQUEST',
  });
});
test('schemas publish with CAS and immutable field types; an ordinary employee cannot configure fields', async () => {
  await assert.rejects(() => service.saveConfiguration(c(ids.learner), 'people', config(), 0), {
    code: 'PERMISSION_DENIED',
  });
  await assert.rejects(() => service.publish(c(), 'people', 999999), { code: 'REVISION_CONFLICT' });
  const value = config();
  value.schema.sections[0]!.fields[0]!.type = 'number';
  delete value.schema.sections[0]!.fields[0]!.maxLength;
  const current = await service.configuration(await actor(), ids.tenantA, 'people');
  const draft = await service.saveConfiguration(
    c(),
    'people',
    value,
    Number(current.configuration!.revision),
  );
  await assert.rejects(() => service.publish(c(), 'people', Number(draft.revision)), {
    code: 'PROFILE_FIELD_TYPE_IMMUTABLE',
  });
  await publish(config());
});
test('self projection omits hidden fields, proposals cannot change readonly fields and approval is atomic/idempotent', async () => {
  const before = await service.record(await actor(), ids.tenantA, 'people', personId);
  await service.save(
    c(),
    'people',
    personId,
    { city: 'Hà Nội', hr_note: 'Ghi chú giả lập nội bộ', office: 'AIO' },
    before.revision,
    version,
  );
  const own = await service.record(await actor(ids.learner), ids.tenantA, 'people', personId, true);
  assert.deepEqual(own.answers, { city: 'Hà Nội', office: 'AIO' });
  assert.equal(JSON.stringify(own).includes('hr_note'), false);
  await assert.rejects(
    () => service.propose(c(ids.learner), { office: 'Giả mạo' }, own.revision, version),
    { code: 'PROFILE_FIELD_DENIED' },
  );
  await assert.rejects(
    () => service.propose(c(ids.learner), { hr_note: 'Giả mạo' }, own.revision, version),
    { code: 'PROFILE_FIELD_DENIED' },
  );
  const request = c(ids.learner),
    proposal = await service.propose(request, { city: 'Cao Bằng' }, own.revision, version);
  assert.deepEqual(
    await service.propose(request, { city: 'Cao Bằng' }, own.revision, version),
    proposal,
  );
  assert.equal(
    (await service.record(await actor(), ids.tenantA, 'people', personId)).answers.city,
    'Hà Nội',
  );
  const review = c();
  const result = await service.review(review, proposal.id, 'approved', 1);
  assert.deepEqual(await service.review(review, proposal.id, 'approved', 1), result);
  const saved = await service.record(await actor(), ids.tenantA, 'people', personId);
  assert.equal(saved.answers.city, 'Cao Bằng');
  assert.equal(saved.answers.hr_note, 'Ghi chú giả lập nội bộ');
  assert.ok(
    (await service.history(await actor(), ids.tenantA, 'people', personId)).items.length >= 2,
  );
});
test('conflicting record/schema changes prevent approval; withdrawal and optional field removal preserve ownership', async () => {
  const before = await service.record(
      await actor(ids.learner),
      ids.tenantA,
      'people',
      personId,
      true,
    ),
    proposal = await service.propose(c(ids.learner), { city: 'Khác' }, before.revision, version);
  const full = await service.record(await actor(), ids.tenantA, 'people', personId);
  await service.save(
    c(),
    'people',
    personId,
    { ...full.answers, office: 'Mới' },
    full.revision,
    version,
  );
  await assert.rejects(() => service.review(c(), proposal.id, 'approved', 1), {
    code: 'REVISION_CONFLICT',
  });
  await assert.rejects(
    () => service.review(c(ids.other, ids.tenantB), proposal.id, 'withdrawn', 1),
    { code: 'RECORD_NOT_FOUND' },
  );
  await service.review(c(ids.learner), proposal.id, 'withdrawn', 1);
  const current = await service.record(
      await actor(ids.learner),
      ids.tenantA,
      'people',
      personId,
      true,
    ),
    remove = await service.propose(c(ids.learner), { city: null }, current.revision, version);
  await service.review(c(), remove.id, 'approved', 1);
  assert.equal(
    (await service.record(await actor(), ids.tenantA, 'people', personId)).answers.city,
    undefined,
  );
  const latest = await service.record(
      await actor(ids.learner),
      ids.tenantA,
      'people',
      personId,
      true,
    ),
    stale = await service.propose(c(ids.learner), { city: 'Mới' }, latest.revision, version);
  await publish(config());
  await assert.rejects(() => service.review(c(), stale.id, 'approved', 1), {
    code: 'PROFILE_SCHEMA_CHANGED',
  });
  await service.review(c(), stale.id, 'rejected', 1);
});
test('self-service never bypasses tenant/record ownership and mutation helper requires explicit authorization', async () => {
  await assert.rejects(
    async () => service.record(await actor(ids.other), ids.tenantA, 'people', personId, true),
    { code: 'PROFILE_SELF_DENIED' },
  );
  await assert.rejects(
    () => service.propose(c(ids.learner, ids.tenantB), { city: 'Khác' }, 0, version),
    { code: 'PROFILE_SELF_DENIED' },
  );
  await assert.rejects(
    () => mutate(store, c(), null, 'unprotected', {}, async () => ({})),
    /Explicit ownership authorization/,
  );
});
