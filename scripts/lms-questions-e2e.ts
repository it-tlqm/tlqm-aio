import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import type { Page, BrowserContext, APIResponse } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import * as XLSX from 'xlsx';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp } from './local-totp.js';
import { exportQuestionWorkbook, parseQuestionWorkbook } from '../src/lms/question-spreadsheet.js';
import type { QuestionEntry, BankItem } from '../src/lms/question-contracts.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
import type { FormsFixture } from './forms-fixtures.js';
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104',
  run = randomUUID().slice(0, 8),
  category = 'G6-' + run;
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const browser = await chromium.launch({ headless: true });
let app: Awaited<ReturnType<typeof createApp>> | undefined,
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined,
  current: Page | undefined,
  stage = 'startup';
const scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
async function status(response: APIResponse, expected = 200) {
  if (response.status() !== expected) {
    const data = await response.json().catch(() => ({}));
    console.error(
      'Question API: ' +
        response.status() +
        '/' +
        expected +
        ' ' +
        (/^[A-Z0-9_]+$/.test(data.error ?? '') ? data.error : ''),
    );
  }
  assert.equal(response.status(), expected);
}
async function login(user: { id: string; username: string; password: string }, mfa = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  current = page;
  await page.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective),
    );
  });
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL(base + '/');
  await expect(
    page.getByRole('heading', { name: 'Khóa học dành cho bạn', exact: true }),
  ).toBeVisible();
  const me = await (await context.request.get(base + '/api/v1/me')).json();
  return { context, page, csrf: me.csrfToken as string };
}
async function scan(page: Page, screen: string) {
  current = page;
  assert.equal(new URL(page.url()).origin, base);
  assert.equal(await page.locator('input[type=password],#otp').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getTiming().iterations === Infinity,
      ),
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    screen,
    violations: result.violations.map((issue) => issue.id),
    incomplete: result.incomplete.map((issue) => issue.id),
  });
  if (result.violations.length)
    console.error(
      JSON.stringify({
        screen,
        issues: result.violations.map((issue) => ({
          id: issue.id,
          targets: issue.nodes.map((node) => node.target),
        })),
      }),
    );
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp), []);
}
try {
  app = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((client) => client.code === 'aio-foundation')!,
    test: true,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 4100 });
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  stage = 'admin MFA and protected endpoints';
  const publisher = fixtures.users.find((user) => user.role === 'publisher')!,
    admin = await login(publisher, true),
    page = admin.page;
  const learner = await login(runtime.users.find((user) => user.id === ids.learner)!);
  for (const route of ['/api/lms/question-bank', '/api/lms/question-template?kind=quiz'])
    await status(await learner.context.request.get(base + route), 403);
  const headers = { 'content-type': 'application/json', origin: base, 'x-csrf-token': admin.csrf };
  async function command(
    action: string,
    data: unknown,
    key = randomUUID(),
    context: BrowserContext = admin.context,
    csrf = admin.csrf,
  ) {
    return context.request.post(base + '/api/lms/question-commands', {
      headers: { ...headers, 'x-csrf-token': csrf, 'idempotency-key': key },
      data: { action, data, reason: 'Nghiệm thu ngân hàng và Excel giả lập' },
    });
  }
  const entries: QuestionEntry[] = (['single', 'multiple', 'text'] as const).map((type, index) => ({
    kind: 'quiz',
    question: {
      id: 'source-' + index,
      type,
      question: 'Bộ câu hỏi ' + run + ' ' + (index + 1),
      options: type === 'text' ? [] : ['A thực tế', 'B thực tế', 'C thực tế'],
    },
    key: {
      answer: type === 'single' ? 1 : type === 'multiple' ? [0, 2] : 'AN TOÀN',
      explanation: 'Giải thích giả lập ' + run,
    },
  }));
  const bytes = exportQuestionWorkbook(entries, 'quiz');
  const previewRequest = async (
    data: Uint8Array,
    name: string,
    context = admin.context,
    csrf = admin.csrf,
  ) =>
    context.request.post(base + '/api/lms/question-imports/preview?kind=quiz', {
      headers: {
        origin: base,
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(name),
        'x-csrf-token': csrf,
        'idempotency-key': randomUUID(),
      },
      data: Buffer.from(data),
    });
  await status(await previewRequest(bytes, 'quiz.xlsx', learner.context, learner.csrf), 403);
  await status(await previewRequest(bytes, 'quiz.xlsx', admin.context, 'bad-csrf'), 403);
  await status(
    await learner.context.request.post(base + '/api/lms/question-export', {
      headers: {
        origin: base,
        'content-type': 'application/json',
        'x-csrf-token': learner.csrf,
        'idempotency-key': randomUUID(),
      },
      data: {
        action: 'export-questions',
        data: { source: 'bank', kind: 'quiz', items: [] },
        reason: 'Không được xuất đáp án',
      },
    }),
    403,
  );
  current = page;
  stage = 'question editor, validation and keyboard';
  await page.getByRole('tab', { name: 'Ngân hàng câu hỏi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ngân hàng câu hỏi', exact: true })).toBeVisible();
  await page.getByLabel('Nhóm cho câu hỏi nhập', { exact: true }).fill(category);
  await page.getByRole('button', { name: 'Tạo câu hỏi', exact: true }).click();
  await page.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Câu hỏi bài kiểm tra', { exact: true }).fill('Câu tự soạn ' + run);
  await page.getByRole('combobox', { name: 'Loại câu hỏi', exact: true }).click();
  await page.getByRole('option', { name: 'Nhập đáp án', exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await page.getByLabel('Đáp án chuẩn', { exact: true }).fill('SSO');
  await scan(page, 'question-editor');
  await page.getByRole('button', { name: 'Về ngân hàng câu hỏi', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Bỏ câu hỏi chưa lưu?', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Đáp án chuẩn', { exact: true })).toHaveValue('SSO');
  await page.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ngân hàng câu hỏi', exact: true })).toBeVisible();
  stage = 'real workbook download and row-error preview';
  const templateDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Tải mẫu Excel', exact: true }).click();
  const template = await templateDownload;
  await template.saveAs('.local/evidence/lms-question-template.xlsx');
  assert.equal(
    (
      await parseQuestionWorkbook(
        new Uint8Array(await readFile('.local/evidence/lms-question-template.xlsx')),
        'mau.xlsx',
        'quiz',
      )
    ).items.length,
    3,
  );
  await page.getByRole('button', { name: 'Nhập Excel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Nhập câu hỏi từ Excel', exact: true });
  const bad = new TextEncoder().encode(
    'Loai_Cau_Hoi,Cau_Hoi,Phuong_An_A,Phuong_An_B,Dap_An_Dung\r\nsingle,Thiếu đáp án,A,B,\r\nmultiple,Đáp án lặp,A,B,A;A\r\n',
  );
  await dialog
    .getByLabel('Tệp câu hỏi', { exact: true })
    .setInputFiles({ name: 'loi.csv', mimeType: 'text/csv', buffer: Buffer.from(bad) });
  await dialog.getByRole('button', { name: 'Kiểm tra tệp', exact: true }).click();
  await expect(dialog.getByText(/0 câu hỏi hợp lệ · 2 lỗi/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Nhập câu hỏi', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await scan(page, 'question-import-errors-mobile');
  await page.screenshot({ path: '.local/evidence/lms-question-import-errors.png', fullPage: true });
  await dialog.getByLabel('Tệp câu hỏi', { exact: true }).setInputFiles({
    name: 'cau-hoi.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(bytes),
  });
  await dialog.getByRole('button', { name: 'Kiểm tra tệp', exact: true }).click();
  await expect(dialog.getByText('3 câu hỏi hợp lệ · 0 lỗi', { exact: true })).toBeVisible();
  await scan(page, 'question-import-valid-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await scan(page, 'question-import-preview-desktop');
  await page.screenshot({
    path: '.local/evidence/lms-question-import-preview.png',
    fullPage: true,
  });
  stage = 'lost response retry imports exactly once';
  let drop = true;
  const keys: string[] = [];
  await page.route('**/api/lms/question-commands', async (route) => {
    if (route.request().postDataJSON().action === 'apply-import') {
      keys.push(route.request().headers()['idempotency-key']!);
      if (drop) {
        drop = false;
        await status(await route.fetch());
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Nhập câu hỏi', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Nhập câu hỏi', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.unroute('**/api/lms/question-commands');
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  await page.getByLabel('Tìm câu hỏi hoặc nhóm', { exact: true }).fill('Bộ câu hỏi ' + run);
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  await expect(page.getByText('3 câu hỏi · Đã chọn 0/100', { exact: true })).toBeVisible();
  const list = (await (
    await admin.context.request.get(
      base + '/api/lms/question-bank?search=' + encodeURIComponent('Bộ câu hỏi ' + run),
    )
  ).json()) as { items: BankItem[] };
  assert.equal(list.items.length, 3);
  for (const entry of entries)
    await page
      .getByRole('checkbox', { name: 'Chọn câu hỏi ' + entry.question.question, exact: true })
      .check();
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất Excel', exact: true }).click();
  await (await exported).saveAs('.local/evidence/lms-question-bank-export.xlsx');
  const parsed = await parseQuestionWorkbook(
    new Uint8Array(await readFile('.local/evidence/lms-question-bank-export.xlsx')),
    'export.xlsx',
    'quiz',
  );
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(
    parsed.items.map((row) => JSON.stringify(row.entry.key)).sort(),
    entries.map((row) => JSON.stringify(row.key)).sort(),
  );
  await scan(page, 'question-bank-desktop');
  await page.screenshot({ path: '.local/evidence/lms-question-bank-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await scan(page, 'question-bank-mobile');
  await page.screenshot({ path: '.local/evidence/lms-question-bank-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'course reuse, version preservation and export';
  const spec: CourseSpec = {
    schemaVersion: 1,
    title: 'Khóa nhập câu hỏi ' + run,
    subtitle: 'Giả lập G6',
    series: 'Nghiệm thu Excel',
    duration: 60,
    video: { kind: 'youtube', id: 'abcdefghijk' },
    deadline: '',
    isMandatory: false,
    audienceUnits: [ids.unitA],
    checkpoints: [
      {
        id: 'cp-old',
        type: 'single',
        time: 5,
        title: 'Cũ',
        question: 'Điểm dừng cũ',
        options: ['A', 'B'],
      },
    ],
    questions: [{ id: 'q-old', type: 'single', question: 'Câu đã phát hành', options: ['A', 'B'] }],
    answerKey: {
      'cp-old': { answer: 0, explanation: '' },
      'q-old': { answer: 0, explanation: '' },
    },
    attachments: [],
  };
  async function courseCommand(action: string, data: unknown) {
    const response = await admin.context.request.post(base + '/api/lms/commands', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { action, data, reason: 'Nghiệm thu khóa nhập câu hỏi giả lập' },
    });
    await status(response);
    return response.json();
  }
  const draft = await courseCommand('save-course', {
      code: 'questions-' + run,
      ownerUnitId: ids.unitA,
      expectedRevision: 0,
      spec,
    }),
    published = await courseCommand('publish-course', {
      courseId: draft.id,
      expectedRevision: draft.revision,
    });
  const publishedBefore = await (
    await learner.context.request.get(base + '/api/lms/course?versionId=' + published.versionId)
  ).json();
  assert.equal('answerKey' in publishedBefore.spec, false);
  await page.getByRole('tab', { name: 'Khóa học & nội dung', exact: true }).click();
  await page.getByLabel('Tìm khóa học quản lý', { exact: true }).fill(spec.title);
  await page.getByRole('button', { name: 'Thiết kế', exact: true }).click();
  await page.getByRole('tab', { name: /^Bài kiểm tra/ }).click();
  await page.getByRole('button', { name: 'Chọn từ ngân hàng', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Chọn câu hỏi dùng lại', exact: true });
  await picker.getByLabel('Tìm trong ngân hàng', { exact: true }).fill('Bộ câu hỏi ' + run);
  await picker.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  for (const entry of entries)
    await picker
      .getByRole('checkbox', { name: 'Chọn câu hỏi ' + entry.question.question, exact: true })
      .check();
  await scan(page, 'question-bank-picker');
  await picker.getByRole('button', { name: 'Thêm 3 câu vào bản nháp', exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Bài kiểm tra (4)', exact: true })).toBeVisible();
  assert.deepEqual(
    await (
      await learner.context.request.get(base + '/api/lms/course?versionId=' + published.versionId)
    ).json(),
    publishedBefore,
  );
  await page.getByRole('button', { name: 'Nhập Excel', exact: true }).click();
  await dialog.getByLabel('Tệp câu hỏi', { exact: true }).setInputFiles({
    name: 'replace.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(bytes),
  });
  await dialog.getByRole('button', { name: 'Kiểm tra tệp', exact: true }).click();
  await expect(dialog.getByText('3 câu hỏi hợp lệ · 0 lỗi', { exact: true })).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Cách nhập vào bản nháp', exact: true }).click();
  await page.getByRole('option', { name: 'Thay thế phần câu hỏi này', exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Nhập câu hỏi', exact: true })).toBeDisabled();
  await dialog
    .getByRole('checkbox', { name: 'Đồng ý thay thế câu hỏi trong bản nháp', exact: true })
    .check();
  await dialog.getByRole('button', { name: 'Nhập câu hỏi', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Bài kiểm tra (3)', exact: true })).toBeVisible();
  const courseExport = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất Excel', exact: true }).click();
  await (await courseExport).saveAs('.local/evidence/lms-course-question-export.xlsx');
  assert.equal(
    (
      await parseQuestionWorkbook(
        new Uint8Array(await readFile('.local/evidence/lms-course-question-export.xlsx')),
        'course.xlsx',
        'quiz',
      )
    ).items.length,
    3,
  );
  const draftBefore = (
    await (await admin.context.request.get(base + '/api/lms/manage/courses')).json()
  ).items.find((row: { id: string }) => row.id === draft.id);
  assert.equal(draftBefore.spec.checkpoints.length, 1);
  assert.equal(draftBefore.spec.questions.length, 3);
  stage = 'checkpoint workbook import and graded answers from imported versions';
  const checkpoints: QuestionEntry[] = entries.map((entry, index) => ({
    kind: 'checkpoint',
    question: {
      ...entry.question,
      id: 'cp-source-' + index,
      time: (index + 1) * 10,
      title: 'Điểm nhập ' + (index + 1),
    },
    key: entry.key,
  }));
  await page.getByRole('tab', { name: 'Điểm dừng (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Nhập Excel', exact: true }).click();
  await dialog.getByLabel('Tệp câu hỏi', { exact: true }).setInputFiles({
    name: 'diem-dung.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(exportQuestionWorkbook(checkpoints, 'checkpoint')),
  });
  await dialog.getByRole('button', { name: 'Kiểm tra tệp', exact: true }).click();
  await expect(dialog.getByText('3 câu hỏi hợp lệ · 0 lỗi', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Nhập câu hỏi', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Điểm dừng (4)', exact: true })).toBeVisible();
  const cpDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất Excel', exact: true }).click();
  await (await cpDownload).saveAs('.local/evidence/lms-checkpoint-export.xlsx');
  const cpParsed = await parseQuestionWorkbook(
    new Uint8Array(await readFile('.local/evidence/lms-checkpoint-export.xlsx')),
    'cp.xlsx',
    'checkpoint',
  );
  assert.deepEqual(cpParsed.errors, []);
  assert.equal(cpParsed.items.length, 4);
  await scan(page, 'course-imported-checkpoints');
  await page.screenshot({
    path: '.local/evidence/lms-question-course-checkpoints.png',
    fullPage: true,
  });
  const withCheckpoints = (
    await (await admin.context.request.get(base + '/api/lms/manage/courses')).json()
  ).items.find((row: { id: string }) => row.id === draft.id);
  const version = await courseCommand('publish-course', {
    courseId: draft.id,
    expectedRevision: withCheckpoints.revision,
  });
  const nextSpec = withCheckpoints.spec as CourseSpec;
  const currentPublic = await (
    await learner.context.request.get(base + '/api/lms/course?versionId=' + version.versionId)
  ).json();
  assert.equal(currentPublic.spec.questions.length, 3);
  assert.equal(currentPublic.spec.checkpoints.length, 4);
  assert.equal('answerKey' in currentPublic.spec, false);
  let progressRevision = 0;
  const learn = async (action: string, data: unknown) => {
    const response = await learner.context.request.post(base + '/api/lms/commands', {
      headers: {
        origin: base,
        'content-type': 'application/json',
        'x-csrf-token': learner.csrf,
        'idempotency-key': randomUUID(),
      },
      data: { action, data, reason: 'Kiểm thử bộ câu hỏi đã nhập' },
    });
    await status(response);
    return response.json();
  };
  for (const cp of nextSpec.checkpoints) {
    const progress = await learn('progress', {
      versionId: version.versionId,
      expectedRevision: progressRevision,
      position: 60,
    });
    const feedback = await learn('checkpoint', {
      versionId: version.versionId,
      expectedRevision: progress.revision,
      questionId: cp.id,
      answer: nextSpec.answerKey[cp.id]!.answer,
    });
    assert.equal(feedback.correct, true);
    progressRevision = feedback.revision;
  }
  await learn('progress', {
    versionId: version.versionId,
    expectedRevision: progressRevision,
    position: 60,
  });
  const submitted = await learn('submit', {
    versionId: version.versionId,
    answers: Object.fromEntries(
      nextSpec.questions.map((question) => [question.id, nextSpec.answerKey[question.id]!.answer]),
    ),
    tabSwitchCount: 0,
  });
  assert.equal(submitted.score, 100);
  assert.equal(submitted.review.length, 3);
  const beforeBankEdit = (
    await (await admin.context.request.get(base + '/api/lms/manage/courses')).json()
  ).items.find((row: { id: string }) => row.id === draft.id);
  stage = 'editing and archiving bank does not alter course snapshots';
  await page.getByRole('tab', { name: 'Ngân hàng câu hỏi', exact: true }).click();
  await page.getByLabel('Tìm câu hỏi hoặc nhóm', { exact: true }).fill('Bộ câu hỏi ' + run);
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: entries[0]!.question.question });
  await row.getByRole('button', { name: 'Sửa câu hỏi', exact: true }).click();
  await page.getByLabel('Câu hỏi bài kiểm tra', { exact: true }).fill('Đã sửa ' + run);
  await page.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ngân hàng câu hỏi', exact: true })).toBeVisible();
  const draftAfter = (
    await (await admin.context.request.get(base + '/api/lms/manage/courses')).json()
  ).items.find((row: { id: string }) => row.id === draft.id);
  assert.deepEqual(draftAfter, beforeBankEdit);
  const otherRow = page.getByRole('row').filter({ hasText: entries[1]!.question.question });
  await otherRow.getByRole('button', { name: 'Ngừng dùng', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Xác nhận trạng thái', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(otherRow).toHaveCount(0);
  stage = 'pagination, binary XLS, CSV and atomic import validation';
  const many = Array.from({ length: 53 }, (_, i): QuestionEntry => ({
    kind: 'quiz',
    question: { id: 'p-' + i, type: 'text', question: 'Phân trang ' + run + ' ' + i, options: [] },
    key: { answer: 'AIO', explanation: '' },
  }));
  const manyPreview = await previewRequest(exportQuestionWorkbook(many, 'quiz'), 'pages.xlsx');
  await status(manyPreview);
  const p = await manyPreview.json();
  await status(
    await command('apply-import', {
      previewId: p.id,
      destination: 'bank',
      category,
      mode: 'append',
    }),
  );
  const first = await (
    await admin.context.request.get(
      base + '/api/lms/question-bank?search=' + encodeURIComponent('Phân trang ' + run),
    )
  ).json();
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const second = await (
    await admin.context.request.get(
      base +
        '/api/lms/question-bank?search=' +
        encodeURIComponent('Phân trang ' + run) +
        '&cursor=' +
        encodeURIComponent(first.nextCursor),
    )
  ).json();
  assert.equal(second.items.length, 3);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((row: BankItem) => row.id)).size, 53);
  const legacy = XLSX.read(bytes, { type: 'array' }),
    xls = new Uint8Array(XLSX.write(legacy, { type: 'array', bookType: 'biff8' }));
  const xlsPreview = await previewRequest(xls, 'legacy.xls');
  await status(xlsPreview);
  assert.equal((await xlsPreview.json()).items.length, 3);
  const badPreview = await previewRequest(bad, 'invalid.csv');
  await status(badPreview);
  const invalid = await badPreview.json();
  await status(
    await command('apply-import', {
      previewId: invalid.id,
      destination: 'bank',
      category,
      mode: 'append',
    }),
    409,
  );
  stage = 'live administrator revocation clears bank and denies exports';
  const pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime) });
  let revocationPoolFailed = false;
  pool.on('error', () => {
    revocationPoolFailed = true;
    console.error('Question E2E database connection lost; details omitted.');
    process.exitCode = 1;
  });
  const prior = (
    await pool.query(
      "SELECT active FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code='aio-lms-sandbox'",
      [publisher.id, ids.tenantA],
    )
  ).rows[0].active;
  async function grant(active: boolean) {
    await pool.query(
      "WITH changed AS (UPDATE application_grants SET active=$1,revision=revision+1 WHERE account_id=$2 AND tenant_id=$3 AND app_code='aio-lms-sandbox' RETURNING account_id) INSERT INTO audit_events(actor_account_id,subject_account_id,tenant_id,app_code,action,reason,request_id) SELECT $2,account_id,$3,'aio-lms-sandbox','test.fixture_changed','Question bank live revocation and restoration',$4 FROM changed",
      [active, publisher.id, ids.tenantA, randomUUID()],
    );
  }
  try {
    await grant(false);
    await page.getByRole('button', { name: 'Tải lại ngân hàng', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Danh sách ngân hàng câu hỏi', exact: true }),
    ).toHaveCount(0);
    await status(
      await admin.context.request.get(base + '/api/lms/question-template?kind=quiz'),
      401,
    );
  } finally {
    await grant(prior);
    await pool.end();
  }
  assert.equal(revocationPoolFailed, false, 'Database transport failed during revocation test');
  await writeFile(
    '.local/evidence/lms-questions-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans,
        checks: [
          'Admin MFA and no learner answer-key access',
          'Workbook template/download XLSX and XLS/CSV server parser',
          'Row errors block apply; explicit replace confirmation',
          'Lost response retry imports once; 53-row pagination without truncation',
          'Bank create/edit/archive, course copy and published version preservation',
          'Checkpoint XLSX import/export and 100-point server grading of the imported single/multiple/text exam',
          'Exports roundtrip actual values and answer types',
          'Live grant revocation clears bank and denies downloads',
        ],
        courseId: draft.id,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: LMS question bank, XLSX/XLS/CSV, imports/exports, revision/retry/scope and ' +
      scans.length +
      ' axe scans.',
  );
} catch (error) {
  if (error instanceof Error)
    console.error(
      error.stack?.match(/lms-questions-e2e\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable',
    );
  console.error(
    'LMS question E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  if (
    current &&
    !current.isClosed() &&
    new URL(current.url()).origin === base &&
    new URL(current.url()).pathname === '/' &&
    !(await current.locator('input[type=password],#otp').count())
  )
    await current.screenshot({ path: '.local/evidence/lms-questions-failure.png', fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
  await worker?.mf.dispose();
  if (app) {
    app.server.closeAllConnections();
    await app.close();
  }
}
