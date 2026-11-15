import { Courses } from './courses.js';
import type { CourseActor, CourseCommand } from './courses.js';
import { parseCourse } from './course-contracts.js';
import { LmsError } from './security.js';
import { mergeQuestions, parseQuestionEntry } from './question-contracts.js';
import type {
  QuestionEntry,
  QuestionKind,
  QuestionPreview,
  BankItem,
} from './question-contracts.js';
import { parseQuestionWorkbook, spreadsheetMaxBytes } from './question-spreadsheet.js';
import { scanLmsUpload } from './media.js';
import type { UploadScan } from '../upload-scan.js';
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function requireInput(value: unknown, code = 'INVALID_REQUEST'): asserts value {
  if (!value) throw new LmsError(400, code);
}
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
type BankRow = {
  id: string;
  category: string;
  entry_json: string;
  kind: QuestionKind;
  status: 'active' | 'archived';
  revision: number;
  updated_at: number;
};
const map = (row: BankRow): BankItem => ({
  id: row.id,
  category: row.category,
  entry: parseQuestionEntry(JSON.parse(row.entry_json)),
  status: row.status,
  revision: row.revision,
  updatedAt: row.updated_at,
});
export class QuestionBank extends Courses {
  async listBank(
    options: {
      search?: string | undefined;
      kind?: string | undefined;
      status?: string | undefined;
      cursor?: string | undefined;
    } = {},
  ) {
    const actor = await this.actor('lms:admin'),
      search = options.search ?? '',
      kind = options.kind ?? 'all',
      status = options.status ?? 'active';
    requireInput(
      search.length <= 200 &&
        ['all', 'quiz', 'checkpoint'].includes(kind) &&
        ['all', 'active', 'archived'].includes(status),
    );
    let after: [number, string] | null = null;
    if (options.cursor) {
      const parts = options.cursor.split(':');
      requireInput(parts.length === 2 && /^\d{13}$/.test(parts[0]!) && uuid(parts[1]));
      after = [Number(parts[0]), parts[1]];
    }
    const result = await this.db
      .prepare(
        "SELECT id,category,entry_json,kind,status,revision,updated_at FROM lms_question_bank WHERE tenant_id=? AND (?='all' OR kind=?) AND (?='all' OR status=?) AND instr(search_text,?)>0" +
          (after ? ' AND (updated_at<? OR (updated_at=? AND id<?))' : '') +
          ' ORDER BY updated_at DESC,id DESC LIMIT 51',
      )
      .bind(
        actor.link.tenant_id,
        kind,
        kind,
        status,
        status,
        normalize(search.trim()),
        ...(after ? [after[0], after[0], after[1]] : []),
      )
      .all<BankRow>();
    return {
      items: result.results.slice(0, 50).map(map),
      nextCursor:
        result.results.length > 50
          ? result.results[49]!.updated_at + ':' + result.results[49]!.id
          : null,
    };
  }
  private async bankRow(actor: CourseActor, id: string) {
    requireInput(uuid(id));
    const row = await this.db
      .prepare('SELECT * FROM lms_question_bank WHERE id=? AND tenant_id=?')
      .bind(id, actor.link.tenant_id)
      .first<BankRow>();
    if (!row) throw new LmsError(404, 'LMS_QUESTION_NOT_FOUND');
    return row;
  }
  async saveQuestion(
    input: {
      id?: string;
      expectedRevision: number;
      category: string;
      entry: unknown;
      status: 'active' | 'archived';
    },
    command: CourseCommand,
  ) {
    const actor = await this.actor('lms:admin');
    const replay = await this.replayCommand<{ id: string; revision: number }>(
      actor,
      command,
      'questions.saved',
      input,
    );
    if (replay) return replay;
    requireInput(
      Number.isInteger(input.expectedRevision) &&
        input.expectedRevision >= 0 &&
        typeof input.category === 'string' &&
        input.category.trim().length > 0 &&
        input.category.length <= 100 &&
        ['active', 'archived'].includes(input.status),
    );
    if (input.id) await this.bankRow(actor, input.id);
    else requireInput(input.expectedRevision === 0 && input.status === 'active');
    const id = input.id ?? crypto.randomUUID(),
      entry = parseQuestionEntry(input.entry),
      category = input.category.trim(),
      now = Date.now();
    entry.question.id = id;
    const json = JSON.stringify(entry);
    return this.commit(actor, 'lms:admin', command, 'questions.saved', input, (operation) => ({
      statements: [
        input.id
          ? this.db
              .prepare(
                'UPDATE lms_question_bank SET category=?,kind=?,entry_json=?,search_text=?,status=?,revision=revision+1,updated_at=?,last_operation_id=? WHERE id=? AND tenant_id=? AND revision=?',
              )
              .bind(
                category,
                entry.kind,
                json,
                normalize(category + ' ' + entry.question.question),
                input.status,
                now,
                operation,
                id,
                actor.link.tenant_id,
                input.expectedRevision,
              )
          : this.db
              .prepare(
                'INSERT INTO lms_question_bank(id,tenant_id,category,kind,entry_json,search_text,status,last_operation_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
              )
              .bind(
                id,
                actor.link.tenant_id,
                category,
                entry.kind,
                json,
                normalize(category + ' ' + entry.question.question),
                input.status,
                operation,
                actor.principal.accountId,
                now,
                now,
              ),
        this.db
          .prepare(
            'INSERT INTO lms_question_versions(question_id,revision,category,entry_json,status,created_at) SELECT id,revision,category,entry_json,status,? FROM lms_question_bank WHERE id=? AND last_operation_id=?',
          )
          .bind(now, id, operation),
      ],
      condition: 'EXISTS(SELECT 1 FROM lms_question_bank WHERE id=? AND last_operation_id=?)',
      values: [id, operation],
      result: { id, revision: input.expectedRevision + 1 },
      details: {
        questionId: id,
        revision: input.expectedRevision + 1,
        kind: entry.kind,
        status: input.status,
      },
    }));
  }
  async preview(
    request: Request,
    kind: QuestionKind,
    command: CourseCommand,
    scan?: UploadScan,
  ): Promise<QuestionPreview> {
    const actor = await this.actor('lms:admin');
    let name: string;
    try {
      name = decodeURIComponent(request.headers.get('x-file-name') ?? '');
    } catch {
      throw new LmsError(400, 'INVALID_REQUEST');
    }
    const reader = request.body?.getReader();
    requireInput(reader);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.length;
        if (size > spreadsheetMaxBytes) throw new LmsError(413, 'LMS_WORKBOOK_TOO_LARGE');
        chunks.push(value.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (scan) await scanLmsUpload(scan, bytes);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const parsed = await parseQuestionWorkbook(bytes, name, kind),
      now = Date.now(),
      id = crypto.randomUUID(),
      expiresAt = now + 30 * 60 * 1000;
    requireInput(JSON.stringify(parsed).length <= 1024 * 1024, 'LMS_WORKBOOK_LIMIT');
    return this.commit(
      actor,
      'lms:admin',
      command,
      'questions.import_previewed',
      { digest, kind, name },
      () => ({
        statements: [
          this.db
            .prepare(
              'INSERT INTO lms_question_imports(id,tenant_id,actor_account_id,kind,source_name,digest,snapshot_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
            )
            .bind(
              id,
              actor.link.tenant_id,
              actor.principal.accountId,
              kind,
              name,
              digest,
              JSON.stringify(parsed),
              now,
              expiresAt,
            ),
        ],
        condition: 'EXISTS(SELECT 1 FROM lms_question_imports WHERE id=?)',
        values: [id],
        result: { id, kind, sourceName: name, digest, expiresAt, ...parsed },
        details: {
          previewId: id,
          digest,
          kind,
          rows: parsed.items.length,
          errors: parsed.errors.length,
        },
      }),
    );
  }
  private async previewData(actor: CourseActor, id: string) {
    requireInput(uuid(id));
    const row = await this.db
      .prepare(
        'SELECT kind,snapshot_json,expires_at FROM lms_question_imports WHERE id=? AND tenant_id=? AND actor_account_id=?',
      )
      .bind(id, actor.link.tenant_id, actor.principal.accountId)
      .first<{ kind: QuestionKind; snapshot_json: string; expires_at: number }>();
    if (!row || row.expires_at <= Date.now()) throw new LmsError(409, 'LMS_IMPORT_EXPIRED');
    const parsed = JSON.parse(row.snapshot_json) as Pick<QuestionPreview, 'items' | 'errors'>;
    if (parsed.errors.length || !parsed.items.length)
      throw new LmsError(409, 'LMS_IMPORT_HAS_ERRORS');
    return { kind: row.kind, entries: parsed.items.map((item) => parseQuestionEntry(item.entry)) };
  }
  async applyImport(
    input: {
      previewId: string;
      destination: 'bank' | 'course';
      category?: string;
      courseId?: string;
      expectedRevision?: number;
      mode: 'append' | 'replace';
    },
    command: CourseCommand,
  ) {
    const actor = await this.actor('lms:admin');
    requireInput(
      ['bank', 'course'].includes(input.destination) && ['append', 'replace'].includes(input.mode),
    );
    const replay = await this.replayCommand<{
      id?: string;
      revision?: number;
      ids?: string[];
      count: number;
    }>(
      actor,
      command,
      input.destination === 'bank' ? 'questions.imported_to_bank' : 'questions.applied_to_draft',
      input,
    );
    if (replay) return replay;
    const preview = await this.previewData(actor, input.previewId);
    if (input.destination === 'course')
      return this.writeCourseQuestions(
        actor,
        {
          courseId: input.courseId!,
          expectedRevision: input.expectedRevision!,
          kind: preview.kind,
          mode: input.mode,
        },
        preview.entries,
        input,
        command,
        [],
      );
    requireInput(
      input.mode === 'append' &&
        typeof input.category === 'string' &&
        input.category.trim().length > 0 &&
        input.category.length <= 100,
    );
    const category = input.category.trim(),
      now = Date.now(),
      entries = preview.entries.map((entry) => ({
        ...entry,
        question: { ...entry.question, id: crypto.randomUUID() },
      }));
    return this.commit(
      actor,
      'lms:admin',
      command,
      'questions.imported_to_bank',
      input,
      (operation) => ({
        statements: entries.flatMap((entry) => {
          const id = entry.question.id,
            json = JSON.stringify(entry);
          return [
            this.db
              .prepare(
                'INSERT INTO lms_question_bank(id,tenant_id,category,kind,entry_json,search_text,last_operation_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
              )
              .bind(
                id,
                actor.link.tenant_id,
                category,
                entry.kind,
                json,
                normalize(category + ' ' + entry.question.question),
                operation,
                actor.principal.accountId,
                now,
                now,
              ),
            this.db
              .prepare(
                "INSERT INTO lms_question_versions(question_id,revision,category,entry_json,status,created_at) VALUES (?,1,?,?,'active',?)",
              )
              .bind(id, category, json, now),
          ];
        }),
        condition:
          '(SELECT COUNT(*) FROM lms_question_bank WHERE tenant_id=? AND last_operation_id=?)=? AND EXISTS(SELECT 1 FROM lms_question_imports WHERE id=? AND actor_account_id=? AND tenant_id=? AND expires_at>?)',
        values: [
          actor.link.tenant_id,
          operation,
          entries.length,
          input.previewId,
          actor.principal.accountId,
          actor.link.tenant_id,
          Date.now(),
        ],
        result: { ids: entries.map((entry) => entry.question.id), count: entries.length },
        details: { previewId: input.previewId, count: entries.length, kind: preview.kind },
      }),
    );
  }
  async attach(
    input: {
      courseId: string;
      expectedRevision: number;
      kind: QuestionKind;
      mode: 'append' | 'replace';
      items: { id: string; revision: number }[];
    },
    command: CourseCommand,
  ) {
    const actor = await this.actor('lms:admin');
    const replay = await this.replayCommand<{ id: string; revision: number; count: number }>(
      actor,
      command,
      'questions.applied_to_draft',
      input,
    );
    if (replay) return replay;
    requireInput(
      Array.isArray(input.items) &&
        input.items.length > 0 &&
        input.items.length <= 100 &&
        input.items.every(
          (item) =>
            item && typeof item === 'object' && uuid(item.id) && Number.isInteger(item.revision),
        ) &&
        new Set(input.items.map((item) => item.id)).size === input.items.length,
    );
    const rows = [];
    for (const item of input.items) {
      requireInput(item && uuid(item.id) && Number.isInteger(item.revision));
      const row = await this.bankRow(actor, item.id);
      if (row.status !== 'active' || row.revision !== item.revision)
        throw new LmsError(409, 'REVISION_CONFLICT');
      rows.push(row);
    }
    return this.writeCourseQuestions(
      actor,
      input,
      rows.map((row) => parseQuestionEntry(JSON.parse(row.entry_json))),
      input,
      command,
      rows,
    );
  }
  private async writeCourseQuestions(
    actor: CourseActor,
    input: {
      courseId: string;
      expectedRevision: number;
      kind: QuestionKind;
      mode: 'append' | 'replace';
    },
    entries: QuestionEntry[],
    payload: unknown,
    command: CourseCommand,
    bankRows: BankRow[],
  ) {
    requireInput(
      uuid(input.courseId) &&
        Number.isInteger(input.expectedRevision) &&
        input.expectedRevision > 0,
    );
    const course = await this.course(actor, input.courseId),
      spec = mergeQuestions(
        parseCourse(JSON.parse(course.draft_json)),
        entries,
        input.kind,
        input.mode,
      ),
      json = JSON.stringify(spec);
    requireInput(new TextEncoder().encode(json).byteLength <= 240000, 'LMS_WORKBOOK_LIMIT');
    const previewId =
      payload && typeof payload === 'object' && 'previewId' in payload
        ? (payload as { previewId: string }).previewId
        : null;
    return this.commit(
      actor,
      'lms:admin',
      command,
      'questions.applied_to_draft',
      payload,
      (operation) => ({
        statements: [
          ...bankRows.map((row, index) =>
            this.db
              .prepare(
                'INSERT INTO lms_write_guards(operation_id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM lms_question_bank WHERE id=? AND tenant_id=? AND revision=? AND status=?) THEN 1 ELSE 0 END)',
              )
              .bind(
                operation + ':bank:' + index,
                row.id,
                actor.link.tenant_id,
                row.revision,
                'active',
              ),
          ),
          this.db
            .prepare(
              'UPDATE lms_courses SET draft_json=?,revision=revision+1,updated_at=?,last_operation_id=? WHERE id=? AND tenant_id=? AND revision=?',
            )
            .bind(
              json,
              Date.now(),
              operation,
              input.courseId,
              actor.link.tenant_id,
              input.expectedRevision,
            ),
          ...bankRows.map((_, index) =>
            this.db
              .prepare('DELETE FROM lms_write_guards WHERE operation_id=?')
              .bind(operation + ':bank:' + index),
          ),
        ],
        condition:
          'EXISTS(SELECT 1 FROM lms_courses WHERE id=? AND tenant_id=? AND last_operation_id=?)' +
          (previewId
            ? ' AND EXISTS(SELECT 1 FROM lms_question_imports WHERE id=? AND actor_account_id=? AND tenant_id=? AND expires_at>?)'
            : ''),
        values: [
          input.courseId,
          actor.link.tenant_id,
          operation,
          ...(previewId
            ? [previewId, actor.principal.accountId, actor.link.tenant_id, Date.now()]
            : []),
        ],
        result: { id: input.courseId, revision: input.expectedRevision + 1, count: entries.length },
        details: {
          courseId: input.courseId,
          revision: input.expectedRevision + 1,
          count: entries.length,
          kind: input.kind,
          mode: input.mode,
        },
      }),
    );
  }
  async exportQuestions(
    input: {
      source: 'bank' | 'course';
      kind: QuestionKind;
      courseId?: string;
      items?: { id: string; revision: number }[];
    },
    command: CourseCommand,
  ) {
    const actor = await this.actor('lms:admin');
    const replay = await this.replayCommand<{ entries: QuestionEntry[]; kind: QuestionKind }>(
      actor,
      command,
      'questions.exported',
      input,
    );
    if (replay) return replay;
    requireInput(
      ['bank', 'course'].includes(input.source) && ['quiz', 'checkpoint'].includes(input.kind),
    );
    let entries: QuestionEntry[];
    if (input.source === 'course') {
      requireInput(uuid(input.courseId));
      const course = await this.course(actor, input.courseId),
        spec = parseCourse(JSON.parse(course.draft_json));
      entries = (input.kind === 'quiz' ? spec.questions : spec.checkpoints).map((question) => ({
        kind: input.kind,
        question,
        key: spec.answerKey[question.id]!,
      }));
    } else {
      requireInput(
        Array.isArray(input.items) &&
          input.items.length > 0 &&
          input.items.length <= 100 &&
          input.items.every(
            (item) =>
              item && typeof item === 'object' && uuid(item.id) && Number.isInteger(item.revision),
          ) &&
          new Set(input.items.map((item) => item.id)).size === input.items.length,
      );
      entries = [];
      for (const item of input.items) {
        const row = await this.bankRow(actor, item.id);
        if (row.revision !== item.revision) throw new LmsError(409, 'REVISION_CONFLICT');
        entries.push(parseQuestionEntry(JSON.parse(row.entry_json)));
      }
    }
    requireInput(entries.every((entry) => entry.kind === input.kind));
    return this.commit(actor, 'lms:admin', command, 'questions.exported', input, () => ({
      statements: [],
      condition: '1=1',
      values: [],
      result: { entries, kind: input.kind },
      details: {
        source: input.source,
        courseId: input.courseId ?? null,
        kind: input.kind,
        count: entries.length,
      },
    }));
  }
}
