import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { OrganizationImport } from '../src/management/organization-import.js';
import {
  organizationHeaders,
  parseOrganizationWorkbook,
  organizationTemplate,
} from '../src/management/organization-workbook.js';
import type { ImportSheet } from '../src/management/organization-workbook.js';
import type { MutationContext } from '../src/management/mutations.js';
import { ids } from '../src/fixtures.js';
const runtime = await loadLocalConfig(),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 2 }),
  service = new OrganizationImport(new Store(pool));
const ctx = (): MutationContext => ({
  identity: {
    issuer: runtime.issuer,
    subject: ids.admin,
    authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ['pwd', 'otp'],
  },
  tenantId: ids.tenantA,
  appCode: 'aio-foundation',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
  reason: 'Kiểm thử nhập tổ chức giả lập',
});
function workbook(data: Partial<Record<ImportSheet, string[][]>>, formula = false) {
  const b = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(data)) {
    const s = XLSX.utils.aoa_to_sheet([[...organizationHeaders[name as ImportSheet]], ...rows]);
    if (formula) s.A2 = { t: 'n', v: 1, f: '1+1' };
    XLSX.utils.book_append_sheet(b, s, name);
  }
  return new Uint8Array(XLSX.write(b, { type: 'buffer', bookType: 'xlsx', compression: true }));
}
before(async () =>
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  ),
);
after(() => pool.end());
test('workbook parser refuses formula/malformed archives and reports empty templates', async () => {
  assert.ok((await parseOrganizationWorkbook(organizationTemplate())).errors.length);
  assert.ok(
    (
      await parseOrganizationWorkbook(workbook({ ChucDanh: [['AA', 'Chức danh']] }, true))
    ).errors.some((e) => e.row === 2 && e.column === 'Ma'),
  );
  await assert.rejects(() => parseOrganizationWorkbook(new Uint8Array([1, 2, 3])), {
    code: 'ORGANIZATION_WORKBOOK_INVALID',
  });
});
test('four-sheet import resolves out-of-order parents, rolls preview back and commits exactly once', async () => {
  const code = 'I' + randomUUID().slice(0, 7),
    entity = (await pool.query('SELECT code FROM legal_entities WHERE id=$1', [ids.legalA])).rows[0]
      .code;
  const file = workbook({
    DonVi: [
      [code + 'child', 'Đơn vị con', entity, code],
      [code, 'Đơn vị cha', entity, ''],
    ],
    ChucDanh: [[code, 'Chuyên viên nhập']],
    ViTri: [[code, 'Vị trí nhập', entity, code + 'child', code]],
    NhanSu: [[code, 'Nhân sự Excel', entity, code, '2026-01-01', '']],
  });
  const preview = await service.preview(ctx(), file);
  assert.equal(preview.canCommit, true);
  assert.equal(preview.items.length, 5);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM org_units WHERE tenant_id=$1 AND code=$2', [
        ids.tenantA,
        code,
      ])
    ).rowCount,
    0,
  );
  const context = ctx(),
    result = await service.commit(context, file, preview.snapshot);
  assert.equal(result.items.length, 5);
  assert.deepEqual(await service.commit(context, file, preview.snapshot), result);
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM accounts a JOIN persons p ON p.id=a.person_id WHERE p.display_name=$1',
        ['Nhân sự Excel'],
      )
    ).rowCount,
    0,
  );
  const duplicate = await service.preview(ctx(), file);
  assert.equal(duplicate.canCommit, false);
  assert.ok(duplicate.errors.some((e) => e.sheet === 'DonVi' && e.row === 2));
  const audit = (
    await pool.query(
      "SELECT 1 FROM audit_events WHERE request_id=$1 AND action='organization.imported'",
      [context.requestId],
    )
  ).rowCount;
  assert.equal(audit, 1);
});
test('invalid row is reported without committing valid neighbours; stale snapshot and denied actor cannot import', async () => {
  const code = 'I' + randomUUID().slice(0, 7),
    bad = workbook({
      ChucDanh: [
        [code, 'Dòng hợp lệ'],
        ['!bad', 'Sai mã'],
      ],
    }),
    preview = await service.preview(ctx(), bad);
  assert.equal(preview.canCommit, false);
  assert.equal(preview.errors[0]?.row, 3);
  assert.equal((await pool.query('SELECT 1 FROM job_titles WHERE code=$1', [code])).rowCount, 0);
  await assert.rejects(() => service.commit(ctx(), bad, preview.snapshot), {
    code: 'IMPORT_REQUIRED',
  });
  assert.equal((await pool.query('SELECT 1 FROM job_titles WHERE code=$1', [code])).rowCount, 0);
  const good = workbook({ ChucDanh: [[code, 'Dòng hợp lệ']] });
  await assert.rejects(() => service.commit(ctx(), good, preview.snapshot), {
    code: 'PERSONNEL_PREVIEW_STALE',
  });
  const denied = ctx();
  denied.identity.subject = ids.learner;
  await assert.rejects(() => service.preview(denied, good), { code: 'PERMISSION_DENIED' });
});
