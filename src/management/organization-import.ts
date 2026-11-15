import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Store, Principal } from '../store.js';
import { HttpError } from '../security.js';
import { DirectoryService } from './directory.js';
import { parseOrganizationWorkbook } from './organization-workbook.js';
import type { ImportRow, ImportIssue } from './organization-workbook.js';
import { mutate, databaseError, auditMutation } from './mutations.js';
import type { MutationContext } from './mutations.js';
type RecordRow = Record<string, any>;
const code = (value: string) => /^[A-Za-z0-9_-]{2,48}$/.test(value);
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export class OrganizationImport {
  constructor(private store: Store) {}
  private authorize(actor: Principal, tenant: string) {
    for (const p of ['directory:read', 'directory:manage', 'people:read', 'people:manage'])
      this.store.require(actor, p, tenant);
  }
  private async snapshot(db: PoolClient, tenant: string, bytes: Uint8Array) {
    const state: unknown[] = [];
    for (const table of [
      'legal_entities',
      'org_units',
      'job_titles',
      'positions',
      'persons',
      'employments',
      'assignments',
    ])
      state.push(
        (
          await db.query(
            'SELECT * FROM ' +
              table +
              ' WHERE ' +
              (table === 'persons' ? 'home_tenant_id' : 'tenant_id') +
              '=$1 ORDER BY id',
            [tenant],
          )
        ).rows,
      );
    return createHash('sha256').update(bytes).update(JSON.stringify(state)).digest('hex');
  }
  private async apply(
    db: PoolClient,
    actor: Principal,
    context: MutationContext,
    rows: ImportRow[],
    preview: boolean,
  ) {
    const service = new DirectoryService(this.store),
      errors: ImportIssue[] = [],
      items: { sheet: string; row: number; id: string; name: string }[] = [];
    const read = async (table: string) =>
      (
        await db.query(
          'SELECT * FROM ' +
            table +
            ' WHERE ' +
            (table === 'persons' ? 'home_tenant_id' : 'tenant_id') +
            '=$1',
          [context.tenantId],
        )
      ).rows as RecordRow[];
    const entities = await read('legal_entities'),
      units = await read('org_units'),
      titles = await read('job_titles'),
      positions = await read('positions'),
      people = await read('persons');
    const importedPositions = new Map<string, string>(),
      importedUnits = new Set<string>(),
      importedTitles = new Set<string>(),
      importedPeople = new Set<string>();
    const entity = (name: string) => {
      const e = entities.find((e) => e.code === name && e.active);
      if (!e) throw new HttpError(400, 'IMPORT_ENTITY');
      return e;
    };
    const save = (resource: string, data: RecordRow) =>
      service.saveInTransaction(db, actor, resource, context, data);
    const processRow = async (row: ImportRow) => {
      const v = row.values;
      if (row.sheet === 'ChucDanh') {
        if (!code(v.Ma!) || !v.Ten) throw new HttpError(400, 'IMPORT_REQUIRED');
        if (titles.some((t) => t.code === v.Ma) || importedTitles.has(v.Ma!))
          throw new HttpError(409, 'DUPLICATE_RECORD');
        const result = await save('job-titles', { code: v.Ma, name: v.Ten });
        titles.push({ id: result.id, code: v.Ma, active: true });
        importedTitles.add(v.Ma!);
        return result;
      }
      const e = entity(v.MaPhapNhan!);
      if (row.sheet === 'DonVi') {
        if (!code(v.Ma!) || !v.Ten) throw new HttpError(400, 'IMPORT_REQUIRED');
        if (units.some((u) => u.code === v.Ma) || importedUnits.has(v.Ma!))
          throw new HttpError(409, 'DUPLICATE_RECORD');
        const parent = v.MaDonViCha
          ? units.find((u) => u.code === v.MaDonViCha && u.legal_entity_id === e.id && u.active)
          : null;
        if (v.MaDonViCha && !parent) throw new HttpError(400, 'IMPORT_PARENT');
        const result = await save('org-units', {
          legalEntityId: e.id,
          parentId: parent?.id ?? null,
          code: v.Ma,
          name: v.Ten,
        });
        units.push({ id: result.id, code: v.Ma, legal_entity_id: e.id, active: true });
        importedUnits.add(v.Ma!);
        return result;
      }
      if (row.sheet === 'ViTri') {
        const u = units.find((u) => u.code === v.MaDonVi && u.legal_entity_id === e.id && u.active),
          j = titles.find((j) => j.code === v.MaChucDanh && j.active);
        if (!u || !j) throw new HttpError(400, 'IMPORT_REFERENCE');
        if (!code(v.MaNhap!) || !v.Ten) throw new HttpError(400, 'IMPORT_REQUIRED');
        if (
          importedPositions.has(v.MaNhap!) ||
          positions.some(
            (p) => p.org_unit_id === u.id && p.job_title_id === j.id && p.name === v.Ten,
          )
        )
          throw new HttpError(409, 'DUPLICATE_RECORD');
        const result = await save('positions', {
          legalEntityId: e.id,
          orgUnitId: u.id,
          jobTitleId: j.id,
          name: v.Ten,
        });
        importedPositions.set(v.MaNhap!, String(result.id));
        positions.push({
          id: result.id,
          name: v.Ten,
          org_unit_id: u.id,
          job_title_id: j.id,
          legal_entity_id: e.id,
          active: true,
        });
        return result;
      }
      if (!code(v.MaNhanSu!) || !v.HoTen || !/^\d{4}-\d{2}-\d{2}$/.test(v.NgayBatDau!))
        throw new HttpError(400, 'IMPORT_REQUIRED');
      const date = new Date(v.NgayBatDau + 'T00:00:00.000Z');
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== v.NgayBatDau)
        throw new HttpError(400, 'IMPORT_DATE');
      const employeeKey = e.id + ':' + v.MaNhanSu;
      if (
        importedPeople.has(employeeKey) ||
        (
          await db.query(
            'SELECT 1 FROM employments WHERE legal_entity_id=$1 AND employee_code=$2',
            [e.id, v.MaNhanSu],
          )
        ).rowCount
      )
        throw new HttpError(409, 'DUPLICATE_RECORD');
      const positionId = importedPositions.get(v.ViTri!) ?? (uuid(v.ViTri!) ? v.ViTri : null),
        p = positions.find((p) => p.id === positionId && p.legal_entity_id === e.id && p.active);
      if (!p) throw new HttpError(400, 'IMPORT_REFERENCE');
      let person: RecordRow | undefined = v.NhanSuId
        ? people.find((p) => p.id === v.NhanSuId && p.active)
        : undefined;
      if (v.NhanSuId && !person) throw new HttpError(400, 'IMPORT_PERSON');
      if (person && person.display_name !== v.HoTen) throw new HttpError(400, 'IMPORT_PERSON_NAME');
      person ??= await save('people', { displayName: v.HoTen });
      const employment = await save('employments', {
        personId: person.id,
        legalEntityId: e.id,
        employeeCode: v.MaNhanSu,
        validFrom: date.toISOString(),
      });
      await save('assignments', {
        legalEntityId: e.id,
        employmentId: employment.id,
        positionId: p.id,
        isPrimary: true,
        validFrom: date.toISOString(),
      });
      importedPeople.add(employeeKey);
      return person;
    };
    // Parent rows may occur later in the file. Detect unresolved parents/cycles without guessing.
    const pending = rows.filter((r) => r.sheet === 'DonVi'),
      ordered: ImportRow[] = [];
    const seen = new Set(units.map((u) => u.code));
    while (pending.length) {
      const index = pending.findIndex((r) => !r.values.MaDonViCha || seen.has(r.values.MaDonViCha));
      if (index < 0) {
        ordered.push(...pending);
        break;
      }
      const row = pending.splice(index, 1)[0]!;
      ordered.push(row);
      seen.add(row.values.Ma!);
    }
    const sorted = [
      ...rows.filter((r) => r.sheet === 'ChucDanh'),
      ...ordered,
      ...rows.filter((r) => r.sheet === 'ViTri'),
      ...rows.filter((r) => r.sheet === 'NhanSu'),
    ];
    for (const row of sorted) {
      await db.query('SAVEPOINT import_row');
      try {
        const result = await processRow(row);
        items.push({
          sheet: row.sheet,
          row: row.row,
          id: String(result.id),
          name: row.values.Ten ?? row.values.HoTen ?? '',
        });
        await db.query('RELEASE SAVEPOINT import_row');
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT import_row');
        await db.query('RELEASE SAVEPOINT import_row');
        if (!preview) return databaseError(error);
        const messages: Record<string, string> = {
          IMPORT_ENTITY: 'Mã pháp nhân không có hoặc đã ngừng.',
          IMPORT_PARENT: 'Không tìm thấy đơn vị cha hợp lệ; kiểm tra mã hoặc vòng lặp.',
          IMPORT_REFERENCE: 'Đơn vị/chức danh/vị trí không hợp lệ hoặc dòng tham chiếu có lỗi.',
          IMPORT_REQUIRED: 'Thiếu trường bắt buộc hoặc mã sai định dạng.',
          IMPORT_DATE: 'Ngày bắt đầu không hợp lệ, dùng YYYY-MM-DD.',
          IMPORT_PERSON: 'NhanSuId phải là ID hồ sơ hiện có trong không gian này.',
          IMPORT_PERSON_NAME: 'Họ tên không khớp hồ sơ được chọn bằng ID.',
          DUPLICATE_RECORD: 'Mã hoặc bản ghi đã tồn tại. Tệp này chỉ tạo mới.',
        };
        try {
          databaseError(error);
        } catch (mapped) {
          if (!(mapped instanceof HttpError)) throw mapped;
          errors.push({
            sheet: row.sheet,
            row: row.row,
            column: '',
            message: messages[mapped.code] ?? 'Quan hệ hoặc dữ liệu không hợp lệ.',
          });
        }
      }
    }
    return { items, errors };
  }
  async preview(context: MutationContext, bytes: Uint8Array) {
    const parsed = await parseOrganizationWorkbook(bytes),
      db = await this.store.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(71092027)');
      const actor = await this.store.principal(context.identity, context.appCode, db);
      this.authorize(actor, context.tenantId);
      const snapshot = await this.snapshot(db, context.tenantId, bytes);
      const result = parsed.errors.length
        ? { items: [], errors: parsed.errors }
        : await this.apply(db, actor, context, parsed.rows, true);
      await db.query('ROLLBACK');
      return {
        snapshot,
        ...result,
        canCommit: result.errors.length === 0 && result.items.length > 0,
      };
    } catch (error) {
      await db.query('ROLLBACK');
      return databaseError(error);
    } finally {
      db.release();
    }
  }
  async commit(context: MutationContext, bytes: Uint8Array, snapshot: string) {
    const parsed = await parseOrganizationWorkbook(bytes);
    if (parsed.errors.length || !parsed.rows.length)
      throw new HttpError(400, 'ORGANIZATION_WORKBOOK_ERRORS');
    return mutate(
      this.store,
      context,
      'people:manage',
      'organization.import',
      { hash: createHash('sha256').update(bytes).digest('hex'), snapshot },
      async (db, actor) => {
        this.authorize(actor, context.tenantId);
        if ((await this.snapshot(db, context.tenantId, bytes)) !== snapshot)
          throw new HttpError(409, 'PERSONNEL_PREVIEW_STALE');
        const result = await this.apply(db, actor, context, parsed.rows, false);
        await auditMutation(
          db,
          context,
          actor,
          'organization.imported',
          'batch',
          context.idempotencyKey,
          null,
          { rows: result.items },
        );
        return result;
      },
      async (_db, actor) => this.authorize(actor, context.tenantId),
    );
  }
}
