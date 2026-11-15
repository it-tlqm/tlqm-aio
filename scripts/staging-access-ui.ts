import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as XLSX from 'xlsx';
import { ids } from '../src/fixtures.js';
import { formTarget } from '../frontend/src/lib/form-target.js';
import { taskTarget } from '../frontend/src/lib/task-target.js';

const ui = expect.configure({ timeout: 10000 });
const navigate = (page: Page, hash: string) => page.goto(new URL('/#' + hash, page.url()).href);
const confirm = (page: Page) =>
  page.getByRole('alertdialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();

export async function verifyMobileDialog(
  page: Page,
  role: 'dialog' | 'alertdialog',
  name?: string,
) {
  const dialog = page.getByRole(role, name ? { name, exact: true } : {});
  await ui(dialog).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.ok(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    assert.ok(await dialog.evaluate((node) => node.contains(document.activeElement)));
  }
  const scan = await new AxeBuilder({ page })
    .include('[role="' + role + '"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  assert.deepEqual(
    scan.violations.map(({ id }) => id),
    [],
  );
  return dialog;
}

export async function verifyPortalTaskUi(
  page: Page,
  input: { baseUrl: string; project: string; task: string; title: string },
  login?: () => Promise<void>,
) {
  const previous = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await navigate(page, 'work-center');
    const select = page.getByRole('combobox', { name: 'Nguồn công việc' });
    await ui(select).toBeVisible();
    await select.focus();
    await page.keyboard.press('Enter');
    const option = page.getByRole('option', { name: 'Công việc', exact: true });
    await ui(option).toBeVisible();
    await option.focus();
    await page.keyboard.press('Enter');
    const search = page.getByRole('textbox', { name: 'Tìm công việc hoặc dự án' });
    await ui(search).toBeVisible();
    await search.fill(input.title);
    await search.press('Enter');
    const item = page.getByRole('link', { name: 'Mở công việc ' + input.title, exact: true });
    await ui(item).toHaveAttribute(
      'href',
      input.baseUrl +
        '/#tasks/tenant/' +
        ids.tenantA +
        '/project/' +
        input.project +
        '/' +
        input.task,
    );
    await item.focus();
    await ui(item).toBeFocused();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const scan = await new AxeBuilder({ page })
      .include('section[aria-label="Công việc được giao"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    assert.deepEqual(
      scan.violations.map(({ id }) => id),
      [],
    );
    await item.press('Enter');
    await login?.();
    await ui(page.getByRole('dialog', { name: input.title, exact: true })).toBeVisible();
  } finally {
    if (previous) await page.setViewportSize(previous);
  }
}

export async function verifyFormsUi(
  respondent: Page,
  operator: Page,
  formId: string,
  apiAnswer: string,
  uiAnswer: string,
  fromPortal?: { page: Page; formsBase: string; portalOrigin?: string; resumeDraft?: boolean },
) {
  const openFromPortal = async (label: string, target: string) => {
    await navigate(respondent, 'work-center');
    await respondent.getByRole('combobox', { name: 'Nguồn công việc' }).press('Enter');
    await respondent.getByRole('option', { name: 'Biểu mẫu', exact: true }).press('Enter');
    const link = respondent.getByRole('link', { name: label, exact: true });
    await ui(link).toHaveAttribute('href', target);
    await link.press('Enter');
    await ui(respondent).toHaveURL(target);
  };
  if (fromPortal) {
    respondent = fromPortal.page;
    const target = fromPortal.formsBase + '/' + formTarget(ids.tenantA, formId);
    await openFromPortal('Điền biểu mẫu Khảo sát staging', target);
    if (fromPortal.resumeDraft) {
      const answer = respondent.getByRole('textbox', { name: /^Phản hồi\b/u });
      await answer.fill(uiAnswer);
      await respondent.getByRole('button', { name: 'Lưu nháp phiếu', exact: true }).press('Enter');
      await ui(respondent.getByText('Đã lưu bản nháp.', { exact: true })).toBeVisible();
      const portal = fromPortal.portalOrigin;
      assert.ok(portal);
      await respondent.goto(portal + '/');
      await openFromPortal('Tiếp tục bản nháp Khảo sát staging', target);
      await ui(answer).toHaveValue(uiAnswer);
    }
  } else await navigate(respondent, 'forms/' + formId);
  await ui(
    respondent.getByRole('heading', { name: 'Khảo sát staging', exact: true }).first(),
  ).toBeVisible();
  await ui(respondent.getByRole('button', { name: 'Gửi phiếu', exact: true })).toBeEnabled();
  await respondent.locator('#answer-feedback').fill(uiAnswer);
  const viewport = respondent.viewportSize();
  const submit = respondent.getByRole('button', { name: 'Gửi phiếu', exact: true });
  try {
    if (fromPortal) {
      await respondent.setViewportSize({ width: 390, height: 844 });
      await submit.press('Enter');
      const dialog = await verifyMobileDialog(respondent, 'alertdialog');
      await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).press('Enter');
    } else {
      await submit.click();
      await confirm(respondent);
    }
  } finally {
    if (fromPortal && viewport) await respondent.setViewportSize(viewport);
  }
  await ui(
    respondent.getByText('Đã gửi phiếu. Nội dung đã gửi được giữ nguyên.', { exact: true }),
  ).toBeVisible();
  await ui(respondent.getByRole('button', { name: 'Tải CSV', exact: true })).toHaveCount(0);

  await navigate(operator, 'forms/' + formId);
  await operator.getByRole('tab', { name: 'Tổng hợp', exact: true }).click();
  const download = operator.waitForEvent('download', { timeout: 15000 });
  await operator.getByRole('button', { name: 'Tải CSV', exact: true }).click();
  await confirm(operator);
  const csv = await readFile((await (await download).path())!, 'utf8');
  assert.ok(csv.includes(apiAnswer) && csv.includes(uiAnswer));
}

export async function verifyScopedFormsUi(
  reviewer: Page,
  analyst: Page,
  formId: string,
  allowedAnswers: string[],
  outsideAnswer: string,
) {
  await navigate(reviewer, 'forms/' + formId);
  const responses = reviewer.getByRole('button', { name: 'Xem phiếu', exact: true });
  await ui(responses).toHaveCount(allowedAnswers.length);
  await responses.first().click();
  const dialog = reviewer.getByRole('dialog');
  await ui(dialog.getByText(allowedAnswers.at(-1)!, { exact: true })).toBeVisible();
  await ui(dialog.getByText(outsideAnswer, { exact: true })).toHaveCount(0);
  await ui(reviewer.getByRole('button', { name: 'Tải CSV', exact: true })).toHaveCount(0);
  await navigate(analyst, 'forms/' + formId);
  await ui(
    analyst.getByText(allowedAnswers.length + ' phiếu đã gửi trong phạm vi', { exact: true }),
  ).toBeVisible();
  const pending = analyst.waitForEvent('download', { timeout: 15000 });
  await analyst.getByRole('button', { name: 'Tải CSV', exact: true }).click();
  await confirm(analyst);
  const csv = await readFile((await (await pending).path())!, 'utf8');
  assert.ok(allowedAnswers.every((answer) => csv.includes(answer)) && !csv.includes(outsideAnswer));
}

export async function verifyPortalWorkflowUi(
  portal: Page,
  owner: Page,
  work: { baseUrl: string; route: string; title: string; privateAnswer: string },
  privateFile: { fileName: string; content: string; id: string } | undefined,
  phase: (name: string) => void,
) {
  const portalOrigin = new URL(portal.url()).origin;
  await navigate(portal, 'work-center');
  await portal.getByRole('textbox', { name: 'Tìm công việc', exact: true }).fill(work.title);
  await portal.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  const row = portal.getByRole('row').filter({ hasText: work.title });
  await ui(row).toHaveCount(1);
  const link = row.getByRole('link', { name: 'Mở hồ sơ', exact: true });
  await ui(link).toHaveAttribute('href', work.baseUrl + work.route);
  await link.click();
  phase('Workflow deep link and private field UI');
  await portal.waitForURL(work.baseUrl + work.route);
  await ui(portal.getByRole('button', { name: 'Tải lại lượt chạy', exact: true })).toBeVisible();
  const approver = portal.getByRole('button', { name: 'Phê duyệt', exact: true });
  await ui(approver).toBeEnabled();
  await ui(portal.getByText(work.privateAnswer, { exact: true })).toHaveCount(0);
  await owner.goto(work.baseUrl + work.route.split('/').slice(0, 3).join('/'));
  await ui(owner.getByText(work.privateAnswer, { exact: true })).toBeVisible();
  await ui(owner.getByRole('button', { name: 'Phê duyệt', exact: true })).toHaveCount(0);
  if (privateFile) {
    phase('Workflow file link, exact download and direct denial');
    await portal.getByRole('tab', { name: 'Tệp đính kèm', exact: true }).click();
    await ui(portal.getByText(privateFile.fileName, { exact: true })).toHaveCount(0);
    const denied = await portal.evaluate(
      async (path) => (await fetch(path)).status,
      '/api/v1/workflows/attachments/' + privateFile.id + '?tenantId=' + ids.tenantA,
    );
    assert.equal(denied, 404);
    await owner.getByRole('tab', { name: 'Tệp đính kèm', exact: true }).click();
    const file = owner.getByRole('link', { name: privateFile.fileName, exact: true });
    const [download] = await Promise.all([
      owner.waitForEvent('download', { timeout: 15000 }),
      file.click(),
    ]);
    assert.equal(await readFile((await download.path())!, 'utf8'), privateFile.content);
    await portal.getByRole('tab', { name: 'Thông tin & xử lý', exact: true }).click();
  }
  phase('Workflow assigned handler approval UI');
  await approver.click();
  const dialog = portal.getByRole('dialog', { name: 'Phê duyệt đề nghị?', exact: true });
  await dialog.getByLabel('Ý kiến / lý do', { exact: true }).fill('Xác nhận từ giao diện staging');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await ui(dialog).toBeHidden();
  await portal.goto(portalOrigin + '/');
}

export async function verifyTaskUi(
  page: Page,
  data: {
    projectId: string;
    projectName: string;
    privateName: string;
    title: string;
    itemPath: string;
    recipient: string;
  },
  phase: (name: string) => void,
) {
  phase('Tasks project list and membership UI');
  await navigate(page, 'tasks');
  await page.reload();
  await ui(page.getByText(data.projectName, { exact: true }).first()).toBeVisible();
  await ui(page.getByText(data.privateName, { exact: true })).toHaveCount(0);
  phase('Tasks project item search UI');
  await navigate(page, 'tasks/project/' + data.projectId);
  await ui(page.getByRole('heading', { name: data.projectName, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Danh sách', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Tìm công việc', exact: true });
  const submit = page.getByRole('button', { name: 'Tìm', exact: true });
  const task = page.getByRole('button', { name: data.title, exact: true });
  await ui(task).toBeVisible();
  const filter = async (query: string) => {
    await search.fill(query);
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return (
          url.pathname.endsWith('/projects/' + data.projectId + '/items') &&
          url.searchParams.get('search') === query
        );
      }),
      submit.click(),
    ]);
    assert.equal(response.status(), 200);
  };
  await filter('không-trùng-fixture');
  await ui(task).toHaveCount(0);
  await filter(data.title);
  await task.click();
  const dialog = page.getByRole('dialog', { name: data.title, exact: true });
  await ui(dialog.getByRole('button', { name: 'Cập nhật tiến độ', exact: true })).toBeVisible();
  phase('Tasks handoff UI');
  await dialog.getByRole('button', { name: 'Bàn giao', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Người nhận bàn giao', exact: true }).click();
  await page.getByRole('option', { name: data.recipient, exact: true }).click();
  await dialog.getByLabel('Lý do', { exact: true }).fill('Bàn giao từ giao diện staging');
  const [handoff] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === data.itemPath + '/handoff' &&
        response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: 'Xác nhận bàn giao', exact: true }).click(),
  ]);
  assert.equal(handoff.status(), 200);
  await ui(dialog.getByRole('button', { name: 'Cập nhật tiến độ', exact: true })).toHaveCount(0);
  return (await handoff.json()) as { id: string; revision: number };
}

export async function verifySavedTaskStageUi(
  worker: Page,
  projectId: string,
  stageName: string,
  title: string,
) {
  const page = await worker.context().newPage();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(new URL(taskTarget(ids.tenantA, projectId), worker.url()).href);
    const board = page.getByRole('button', { name: 'Bảng Kanban', exact: true });
    await ui(board).toBeVisible();
    const [items] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/tasks/projects/' + projectId + '/items',
      ),
      board.press('Enter'),
    ]);
    assert.equal(items.status(), 200);
    const data = (await items.json()) as { items: { title: string; stageName: string }[] };
    assert.equal(data.items.find((item) => item.title === title)?.stageName, stageName);
    const column = page
      .getByRole('region', { name: 'Bảng công việc' })
      .getByRole('region', { name: stageName });
    const item = column.getByRole('button', { name: title, exact: true });
    await ui(item).toBeVisible();
    const mine = page.getByRole('checkbox', { name: 'Việc giao cho tôi' });
    await mine.check();
    const save = page.getByRole('button', { name: 'Lưu góc nhìn', exact: true });
    await save.press('Enter');
    await ui(page.getByRole('status').filter({ hasText: 'Đã lưu góc nhìn' })).toBeVisible();
    await page.reload();
    await ui(board).toHaveAttribute('aria-pressed', 'true');
    await ui(mine).toBeChecked();
    await ui(item).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  } finally {
    await page.close();
  }
}

export async function verifyLmsUi(
  operator: Page,
  learner: Page,
  courseTitle: string,
  attachment: { path: string; content: string },
  learnerName: string,
  phase: (name: string) => void,
  mobileAssessment = false,
) {
  phase('LMS course catalog, learner permissions and media download UI');
  await learner.reload();
  const start = learner.getByRole('button', { name: 'Bắt đầu học: ' + courseTitle, exact: true });
  await ui(start).toBeVisible();
  await ui(learner.getByRole('tab', { name: 'Bảng điểm & báo cáo', exact: true })).toHaveCount(0);
  await start.click();
  const file = learner.getByRole('link', { name: 'Tài liệu staging', exact: true });
  await ui(file).toHaveAttribute('href', attachment.path);
  const [download] = await Promise.all([
    learner.waitForEvent('download', { timeout: 15000 }),
    file.click(),
  ]);
  assert.equal(await readFile((await download.path())!, 'utf8'), attachment.content);
  if (mobileAssessment) {
    phase('LMS assessment keyboard and reflow at 390px');
    const viewport = learner.viewportSize();
    await learner.setViewportSize({ width: 390, height: 844 });
    try {
      await learner.getByRole('button', { name: 'Làm bài kiểm tra', exact: true }).press('Enter');
      const answer = learner.getByRole('radio', { name: 'A', exact: true });
      await answer.press('Space');
      await ui(answer).toBeChecked();
      const submit = learner.getByRole('button', { name: 'Nộp bài kiểm tra', exact: true });
      await submit.press('Enter');
      const dialog = await verifyMobileDialog(learner, 'dialog', 'Nộp bài kiểm tra?');
      await dialog.getByRole('button', { name: 'Kiểm tra lại', exact: true }).press('Enter');
      await ui(dialog).toHaveCount(0);
      await ui(submit).toBeFocused();
    } finally {
      if (viewport) await learner.setViewportSize(viewport);
    }
  }

  phase('LMS report search and Excel download UI');
  await openLmsReport(operator, courseTitle);
  await searchLmsReport(operator, learnerName);
  const results = operator.getByRole('region', { name: 'Bảng điểm học viên', exact: true });
  await ui(results.getByRole('row').filter({ hasText: learnerName })).toBeVisible();
  const rows = await downloadLmsReport(operator);
  assert.equal(rows.length, 1);
  assert.ok(JSON.stringify(rows).includes(learnerName));
}

async function openLmsReport(page: Page, courseTitle: string) {
  await page.getByRole('tab', { name: 'Bảng điểm & báo cáo', exact: true }).click();
  await page.getByRole('combobox', { name: 'Khóa học', exact: true }).click();
  await page.getByRole('option', { name: courseTitle + ' · v1', exact: true }).click();
}

async function searchLmsReport(page: Page, name: string) {
  await page.getByRole('textbox', { name: 'Tìm học viên hoặc mã', exact: true }).fill(name);
  const [search] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/lms/report' && url.searchParams.get('search') === name;
    }),
    page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click(),
  ]);
  assert.equal(search.status(), 200);
}

export function gradebookRows(bytes: Buffer) {
  const book = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['Tong_quan', 'Bang_diem', 'Chi_tiet', 'Don_vi']);
  return XLSX.utils.sheet_to_json(book.Sheets.Bang_diem!);
}

async function downloadLmsReport(page: Page) {
  const download = page.waitForEvent('download', { timeout: 15000 });
  // Observe the browser result separately so an HTTP failure is not reported as a download timeout.
  void download.catch(() => {});
  const [response] = await Promise.all([
    page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === '/api/lms/report-export' &&
        result.request().method() === 'POST',
      { timeout: 15000 },
    ),
    page.getByRole('button', { name: 'Xuất báo cáo Excel', exact: true }).click(),
  ]);
  if (response.status() !== 200) {
    const problem: unknown = await response.json().catch(() => null);
    const code =
      problem && typeof problem === 'object' && 'error' in problem ? problem.error : null;
    const errorCode =
      typeof code === 'string' && /^[A-Z_]{2,80}$/.test(code) ? code : 'LMS_EXPORT_FAILED';
    throw Object.assign(new Error('Staging LMS export failed.'), {
      code: errorCode,
      actual: response.status(),
    });
  }
  const exported = await download;
  return gradebookRows(await readFile((await exported.path())!));
}

export async function verifyScopedLmsUi(
  page: Page,
  courseTitle: string,
  learnerName: string,
  outsideName: string,
  phase: (name: string) => void,
) {
  phase('LMS manager opens scoped gradebook');
  await openLmsReport(page, courseTitle);
  const table = page.getByRole('region', { name: 'Bảng điểm học viên', exact: true });
  await ui(table.getByRole('row').filter({ hasText: learnerName })).toBeVisible();
  await ui(table.getByRole('row').filter({ hasText: outsideName })).toHaveCount(0);
  phase('LMS manager searches for excluded learner');
  await searchLmsReport(page, outsideName);
  await ui(
    page.getByText('Không có học viên phù hợp trong phạm vi hiện hành.', { exact: true }),
  ).toBeVisible();
  phase('LMS manager searches for permitted learner');
  await searchLmsReport(page, learnerName);
  await ui(table.getByRole('row').filter({ hasText: learnerName })).toBeVisible();
  phase('LMS manager exports scoped gradebook');
  const rows = await downloadLmsReport(page);
  assert.equal(rows.length, 1);
  assert.ok(
    JSON.stringify(rows).includes(learnerName) && !JSON.stringify(rows).includes(outsideName),
  );
}
