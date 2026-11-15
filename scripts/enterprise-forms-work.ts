import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { ids } from '../src/fixtures.js';
import type { FormWorkPage } from '../src/forms/work-center.js';
import type { SubmissionRow } from '../src/forms/service.js';

export async function verifyFormsWork(
  artifact: string,
  foundation: Pool,
  owner: Pool,
  forms: Pool,
) {
  const load = (file: string) => pathToFileURL(join(artifact, 'dist/src', file)).href;
  const { Store } = (await import(load('store.js'))) as typeof import('../src/store.js');
  const { FormsService, formHash } = (await import(
    load('forms/service.js')
  )) as typeof import('../src/forms/service.js');
  const { formWorkActor, registerFormsWorkRoute } = (await import(
    load('forms-boundary.js')
  )) as typeof import('../src/forms-boundary.js');
  const { registerFormsRoutes } = (await import(
    load('forms/routes.js')
  )) as typeof import('../src/forms/routes.js');
  const store = new Store(foundation);
  const service = new FormsService(forms, { validateTargets: async () => {} });
  const tenant = ids.tenantA,
    unit = ids.unitA,
    account = ids.learner;
  const identity = { issuer: 'https://127.0.0.1:4518/realms/aio-staging-a', subject: account };
  const actor = async (space: string) =>
    formWorkActor(
      store,
      {
        identity,
        principal: await store.principal(identity, 'aio-foundation'),
        sessionHash: undefined,
      },
      space,
    );
  await owner.query("UPDATE applications SET status='active' WHERE code='aio-forms'");
  await owner.query(
    "INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,'aio-forms')",
    [account, tenant],
  );
  await owner.query(
    "INSERT INTO permission_catalog(app_code,code,name) VALUES ('aio-forms','forms:respond','Trả lời')",
  );
  await owner.query(
    "INSERT INTO app_roles(tenant_id,app_code,code,name) VALUES ($1,'aio-forms','e4-respond','Trả lời')",
    [tenant],
  );
  await owner.query(
    "INSERT INTO role_permissions(tenant_id,app_code,role_code,permission) VALUES ($1,'aio-forms','e4-respond','forms:respond')",
    [tenant],
  );
  const binding = randomUUID();
  await owner.query(
    "INSERT INTO role_bindings(id,account_id,tenant_id,app_code,role_code,org_unit_id) VALUES ($1,$2,$3,'aio-forms','e4-respond',$4)",
    [binding, account, tenant, unit],
  );

  const schema = (title: string) => ({
    schemaVersion: 1,
    title,
    sections: [
      {
        id: 'main',
        title: 'Thông tin',
        fields: [{ id: 'feedback', type: 'shortText', label: 'Phản hồi', required: true }],
      },
    ],
  });
  const fixture = async (
    title: string,
    kind: 'unit' | 'account' | 'group',
    target: string,
    future = false,
  ) => {
    const id = randomUUID(),
      version = randomUUID(),
      body = schema(title);
    await forms.query(
      `INSERT INTO forms(id,tenant_id,code,title,owner_account_id,latest_version,max_submissions)
      VALUES ($1,$2,$3,'Tên nháp riêng',$4,1,1)`,
      [id, tenant, 'e4-' + id.slice(0, 8), ids.admin],
    );
    await forms.query(
      'INSERT INTO form_versions(id,tenant_id,form_id,version,schema,checksum,published_by) VALUES ($1,$2,$3,1,$4,$5,$6)',
      [version, tenant, id, JSON.stringify(body), formHash(body), ids.admin],
    );
    const audience = randomUUID();
    await forms.query(
      `INSERT INTO form_audiences(id,tenant_id,form_id,kind,target_id,opens_at)
      VALUES ($1,$2,$3,$4,$5,now()+CASE WHEN $6 THEN interval '1 day' ELSE interval '-1 day' END)`,
      [audience, tenant, id, kind, target, future],
    );
    return { id, version, audience };
  };
  const group = randomUUID();
  await forms.query("INSERT INTO form_groups(id,tenant_id,name) VALUES ($1,$2,'Nhóm E4')", [
    group,
    tenant,
  ]);
  await forms.query(
    'INSERT INTO form_group_members(tenant_id,group_id,account_id) VALUES ($1,$2,$3)',
    [tenant, group, account],
  );
  const assigned = await fixture('Phiếu E4 chính thức', 'unit', unit);
  const grouped = await fixture('Phiếu E4 theo nhóm', 'group', group);
  const outside = await fixture('Phiếu đơn vị ngoài', 'unit', ids.unitC);
  await fixture('Phiếu chưa đến hạn', 'account', account, true);
  for (let i = 0; i < 26; i++) await fixture('Phiếu E4 trang ' + i, 'account', account);

  const server = Fastify({
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  server.setErrorHandler((error: { statusCode?: number; code?: string }, _req, reply) =>
    reply.code(error.statusCode ?? 500).send({ error: error.code }),
  );
  registerFormsWorkRoute(server, service, (_req, space) => actor(space), 'https://127.0.0.1:4513');
  registerFormsRoutes(server, { service, actor: () => actor(tenant), lookups: async () => ({}) });
  const read = async (query: Record<string, string> = {}, expected = 200) => {
    const result = await server.inject({
      method: 'GET',
      url: '/api/v1/work-center/forms?' + new URLSearchParams({ tenantId: tenant, ...query }),
    });
    assert.equal(result.statusCode, expected);
    if (expected === 200) assert.equal(result.headers['cache-control'], 'private, no-store');
    return result.json<FormWorkPage>();
  };
  const write = async (
    versionId: string,
    submit: boolean,
    row?: SubmissionRow,
    key = randomUUID(),
    expected = 200,
  ) => {
    const response = await server.inject({
      method: row ? 'PATCH' : 'POST',
      url: '/api/v1/forms/' + assigned.id + '/submissions' + (row ? '/' + row.id : ''),
      headers: { 'idempotency-key': key },
      payload: {
        tenantId: tenant,
        versionId,
        orgUnitId: unit,
        submit,
        answers: { feedback: 'Đáp án không xuất hiện trong Portal' },
        reason: 'Diễn tập phiếu giả lập',
        ...(row && { expectedRevision: row.revision }),
      },
    });
    assert.equal(response.statusCode, expected, response.body.slice(0, 140));
    return response.json<SubmissionRow>();
  };
  try {
    const page = await read();
    assert.equal(page.items.length, 25);
    assert.ok(page.nextCursor);
    const next = await read({ after: page.nextCursor });
    assert.equal(next.items.length, 3);
    const visible = [...page.items, ...next.items];
    assert.equal(new Set(visible.map(({ id }) => id)).size, 28);
    assert.ok(!visible.some(({ id }) => id === outside.id));
    assert.deepEqual((await read({ after: outside.id })).items, []);
    assert.deepEqual((await read({ search: 'Phiếu E4 chính thức' })).items, [
      { id: assigned.id, title: 'Phiếu E4 chính thức', version: 1, action: 'start' },
    ]);
    const draft = await write(assigned.version, false);
    const body = schema('Phiếu E4 bản mới');
    await forms.query(
      'INSERT INTO form_versions(id,tenant_id,form_id,version,schema,checksum,published_by) VALUES ($1,$2,$3,2,$4,$5,$6)',
      [randomUUID(), tenant, assigned.id, JSON.stringify(body), formHash(body), ids.admin],
    );
    await forms.query('UPDATE forms SET latest_version=2,revision=revision+1 WHERE id=$1', [
      assigned.id,
    ]);
    assert.deepEqual((await read({ search: 'Phiếu E4 chính thức' })).items, [
      { id: assigned.id, title: 'Phiếu E4 chính thức', version: 1, action: 'resume' },
    ]);
    const key = randomUUID();
    const submitted = await write(assigned.version, true, draft, key);
    assert.equal(submitted.version_id, assigned.version);
    assert.equal(submitted.status, 'submitted');
    assert.deepEqual(await write(assigned.version, true, draft, key), submitted);
    assert.deepEqual(
      (await read({ search: 'Phiếu E4' })).items.filter(({ id }) => id === assigned.id),
      [],
    );
    await forms.query(
      'UPDATE form_group_members SET active=false WHERE group_id=$1 AND account_id=$2',
      [group, account],
    );
    assert.deepEqual((await read({ search: 'Phiếu E4 theo nhóm' })).items, []);
    assert.ok(grouped.id);
    await read({ tenantId: ids.tenantB }, 403);
    await owner.query('UPDATE role_bindings SET active=false,revision=revision+1 WHERE id=$1', [
      binding,
    ]);
    await read({}, 403);
    await owner.query(
      "UPDATE application_grants SET active=false,revision=revision+1 WHERE (tenant_id,account_id,app_code)=($1,$2,'aio-forms')",
      [tenant, account],
    );
    await read({}, 403);
    assert.equal(
      (
        await forms.query(
          "SELECT count(*)::int AS n FROM form_audit WHERE target_id=$1 AND action='form.submission.sent'",
          [submitted.id],
        )
      ).rows[0]?.n,
      1,
    );
    return {
      firstPage: 25,
      secondPage: 3,
      scopedCursor: true,
      audienceChecked: true,
      draftPinnedAcrossPublish: true,
      submittedAndReplayed: true,
      hiddenAfterSubmissionLimit: true,
      groupAndGrantRevocation: true,
      crossTenantDenied: true,
      submitAuditEvents: 1,
      identitySimulated: true,
    };
  } finally {
    await server.close();
  }
}
