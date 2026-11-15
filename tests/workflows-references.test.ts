import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { FormValidationError, parseFormSchema, parseAnswers } from '../src/forms/contracts.js';
import { workflowAnswers, referenceOptions } from '../src/workflows/references.js';
import { parseWorkflow, workflowConditionFields } from '../src/workflows/contracts.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import type { WorkflowActor, WorkflowDirectory } from '../src/workflows/access.js';
import { workflowReferences } from '../src/workflow-references-boundary.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { ids } from '../src/fixtures.js';

const schema = parseFormSchema(
  {
    schemaVersion: 2,
    title: 'Người nhận',
    sections: [
      {
        id: 'content',
        title: 'Nội dung',
        fields: [
          { id: 'recipient', type: 'person', label: 'Nhân sự', required: true },
          { id: 'department', type: 'orgUnit', label: 'Đơn vị', required: false },
        ],
      },
    ],
  },
  true,
);
function actor(): WorkflowActor {
  return {
    appCode: 'aio-workflows',
    accountId: randomUUID(),
    personId: randomUUID(),
    tenantIds: [ids.tenantA],
    units: [{ tenantId: ids.tenantA, orgUnitId: ids.unitA }],
    permissions: [{ tenantId: ids.tenantA, orgUnitId: ids.unitA, permission: 'workflows:start' }],
  };
}

test('Reference fields are workflow-v5 only; bounded objects, required state and branch contracts remain explicit', () => {
  assert.throws(() => parseFormSchema(schema), FormValidationError);
  assert.throws(() => parseFormSchema({ ...schema, schemaVersion: 1 }, true), FormValidationError);
  assert.deepEqual(parseAnswers(schema, {}, 'draft'), {});
  assert.throws(() => parseAnswers(schema, {}, 'submit'), FormValidationError);
  for (const bad of [
    'email@example.com',
    { id: randomUUID() },
    { id: randomUUID(), label: 'x', accountId: randomUUID() },
    { id: 'not-uuid', label: '' },
    { id: randomUUID(), label: 'x'.repeat(241) },
  ])
    assert.throws(() => parseAnswers(schema, { recipient: bad }, 'draft'), FormValidationError);
  const spec = workflowTemplate();
  spec.input = schema;
  assert.throws(() => parseWorkflow(spec, false), FormValidationError);
  spec.schemaVersion = 5;
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Bắt đầu', next: 'end' },
    { id: 'end', kind: 'end', label: 'Hoàn tất' },
  ];
  assert.equal(parseWorkflow(spec, false).input.sections[0]!.fields[0]!.type, 'person');
  assert.deepEqual(workflowConditionFields(schema), []);
});

test('Reference normalization replaces forged names, fails closed without directory and rechecks scope', async () => {
  const who = actor(),
    person = randomUUID();
  const directory: WorkflowDirectory = {
    validateUnit: async () => {},
    assignee: async () => ({ personId: person, name: 'X' }),
    references: async (_t, _a, query) => ({
      items: query.id === person ? [{ id: person, label: 'Tên chính thức' }] : [],
      nextCursor: null,
    }),
  };
  assert.deepEqual(
    await workflowAnswers(
      directory,
      who,
      ids.tenantA,
      ids.unitA,
      schema,
      { recipient: { id: person, label: 'Giả tên quản trị' } },
      'submit',
    ),
    { recipient: { id: person, label: 'Tên chính thức' } },
  );
  await assert.rejects(
    () =>
      workflowAnswers(
        directory,
        who,
        ids.tenantA,
        ids.unitA,
        schema,
        { recipient: { id: randomUUID(), label: 'Không có' } },
        'draft',
      ),
    FormValidationError,
  );
  const { references: _, ...unavailable } = directory;
  await assert.rejects(
    () =>
      workflowAnswers(
        unavailable,
        who,
        ids.tenantA,
        ids.unitA,
        schema,
        { recipient: { id: person, label: '' } },
        'submit',
      ),
    { code: 'WORKFLOW_DIRECTORY_UNAVAILABLE' },
  );
  await assert.rejects(
    () => referenceOptions(directory, who, ids.tenantA, { kind: 'person', unitId: ids.unitC }),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
  who.permissions = [];
  await assert.rejects(
    () => referenceOptions(directory, who, ids.tenantA, { kind: 'person', unitId: ids.unitA }),
    { code: 'WORKFLOW_PERMISSION_DENIED' },
  );
});

test('Foundation person projection includes employees without accounts, preserves pages and blocks foreign/inactive/out-of-unit references', async () => {
  const runtime = await loadLocalConfig(),
    pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime) }),
    db = await pool.connect();
  try {
    assert.equal(
      (await db.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
      'tlqm-aio-test',
    );
    await db.query('BEGIN');
    const store = new Store(db as unknown as pg.Pool),
      who = actor();
    const name = 'Reference-' + randomUUID();
    const position = (
      await db.query('SELECT id FROM positions WHERE org_unit_id=$1 AND active LIMIT 1', [
        ids.unitA,
      ])
    ).rows[0].id;
    const people: string[] = [];
    for (let i = 0; i < 55; i++) {
      const person = randomUUID(),
        employment = randomUUID();
      people.push(person);
      await db.query('INSERT INTO persons(id,home_tenant_id,display_name) VALUES($1,$2,$3)', [
        person,
        ids.tenantA,
        name,
      ]);
      await db.query(
        "INSERT INTO employments(id,tenant_id,person_id,legal_entity_id,employee_code,valid_from) VALUES($1,$2,$3,$4,$5,now()-interval '1 day')",
        [employment, ids.tenantA, person, ids.legalA, 'REF-' + person],
      );
      await db.query(
        "INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary,valid_from) VALUES($1,$2,$3,$4,$5,true,now()-interval '1 day')",
        [randomUUID(), ids.tenantA, ids.legalA, employment, position],
      );
    }
    const query = { kind: 'person' as const, unitId: ids.unitA, search: name };
    const page = await workflowReferences(store, ids.tenantA, who, query);
    assert.equal(page.items.length, 50);
    assert.ok(page.nextCursor);
    const next = await workflowReferences(store, ids.tenantA, who, {
      ...query,
      after: page.nextCursor,
    });
    assert.equal(next.items.length, 5);
    assert.equal(next.nextCursor, null);
    assert.deepEqual([...page.items, ...next.items].map((p) => p.id).sort(), people.sort());
    assert.deepEqual(Object.keys(page.items[0]!).sort(), ['id', 'label']);
    assert.equal(
      (
        await db.query('SELECT count(*)::int AS n FROM accounts WHERE person_id=ANY($1::uuid[])', [
          people,
        ])
      ).rows[0].n,
      0,
    );
    const target = people[0]!;
    await db.query('UPDATE persons SET active=false WHERE id=$1', [target]);
    assert.equal(
      (
        await workflowReferences(store, ids.tenantA, who, {
          kind: 'person',
          unitId: ids.unitA,
          id: target,
        })
      ).items.length,
      0,
    );
    assert.equal(
      (
        await workflowReferences(store, ids.tenantA, who, {
          kind: 'person',
          unitId: ids.unitA,
          id: randomUUID(),
        })
      ).items.length,
      0,
    );
    const foreign = (await db.query('SELECT person_id FROM accounts WHERE id=$1', [ids.other]))
      .rows[0].person_id;
    assert.equal(
      (
        await workflowReferences(store, ids.tenantA, who, {
          kind: 'person',
          unitId: ids.unitA,
          id: foreign,
        })
      ).items.length,
      0,
    );
    assert.deepEqual(
      (
        await workflowReferences(store, ids.tenantA, who, { kind: 'orgUnit', unitId: ids.unitA })
      ).items.map((i) => i.id),
      [ids.unitA],
    );
    assert.equal(
      (
        await workflowReferences(store, ids.tenantA, who, {
          kind: 'orgUnit',
          unitId: ids.unitA,
          id: ids.unitC,
        })
      ).items.length,
      0,
    );
    await assert.rejects(
      () => workflowReferences(store, ids.tenantB, who, { kind: 'person', unitId: ids.unitB }),
      { code: 'WORKFLOW_PERMISSION_DENIED' },
    );
    await assert.rejects(
      () => workflowReferences(store, ids.tenantA, who, { kind: 'person', unitId: ids.unitC }),
      { code: 'WORKFLOW_PERMISSION_DENIED' },
    );
    who.permissions = [];
    await assert.rejects(
      () => workflowReferences(store, ids.tenantA, who, { ...query, after: page.nextCursor! }),
      { code: 'WORKFLOW_PERMISSION_DENIED' },
    );
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
});
