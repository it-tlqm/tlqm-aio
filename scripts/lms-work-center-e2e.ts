import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import type { Page, APIResponse } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../src/app.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { lmsReminderRuntime } from './lms-reminders-runtime.js';
import { nextFixtureOtp } from './local-totp.js';
import type { FormsFixture } from './forms-fixtures.js';
import { defaultLearningPolicy } from '../src/lms/learning-policy.js';
import { hashToken, unseal } from '../src/security.js';
import type { LoginTokens } from '../src/oidc.js';
import { hash, unseal as lmsUnseal } from '../src/lms/security.js';
import type { LmsTokens } from '../src/lms/oidc.js';
import { portalWorkProof } from '../src/portal-work-proof.js';
type Row = Record<string, any>;
const runtime = await loadLocalConfig(),
  A = 'http://127.0.0.1:4100',
  L = 'http://127.0.0.1:4104',
  suffix = randomUUID().slice(0, 8),
  browser = await chromium.launch({ headless: true }),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 2 });
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const publisher = fixtures.users.find((u) => u.role === 'publisher')!;
let app: Awaited<ReturnType<typeof createApp>> | undefined,
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined,
  reminders: Awaited<ReturnType<typeof lmsReminderRuntime>> | undefined,
  current: Page | undefined,
  stage = 'startup',
  operator: Awaited<ReturnType<typeof login>> | undefined,
  author: Awaited<ReturnType<typeof login>> | undefined,
  policyBefore: Row | undefined,
  grantBefore: Row | undefined,
  batchId: string | undefined,
  blockedBatchId: string | undefined,
  policyTouched = false;
const scans: Row[] = [];
async function json(r: APIResponse, expected = 200) {
  const body = await r.json();
  if (r.status() !== expected)
    throw new Error(
      'HTTP_' +
        r.status() +
        '_' +
        (/^[A-Z0-9_]+$/.test(body.error ?? '') ? body.error : 'UNEXPECTED'),
    );
  return body as Row;
}
async function login(
  base: string,
  user: { id: string; username: string; password: string },
  mfa = false,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  current = page;
  await context.addInitScript(() => {
    (window as Window & { csp?: string[] }).csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as Window & { csp?: string[] }).csp?.push(e.violatedDirective),
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
  return { context, page, me: await json(await context.request.get(base + '/api/v1/me')) };
}
type Session = Awaited<ReturnType<typeof login>>;
async function send(s: Session, endpoint: string, action: string, data: Row) {
  return json(
    await s.context.request.post(L + endpoint, {
      headers: { origin: L, 'x-csrf-token': s.me.csrfToken, 'idempotency-key': randomUUID() },
      data: { action, data, reason: 'Nghiệm thu việc học giả lập ' + suffix },
    }),
  );
}
async function grant(active: boolean) {
  const old = (
    await json(
      await operator!.context.request.get(
        A + '/api/v1/manage/grants?tenantId=' + ids.tenantA + '&appCode=aio-lms-sandbox',
      ),
    )
  ).items.find((g: Row) => g.accountId === ids.learner);
  await json(
    await operator!.context.request.post(A + '/api/v1/manage/grants', {
      headers: {
        origin: A,
        'x-csrf-token': operator!.me.csrfToken,
        'idempotency-key': randomUUID(),
      },
      data: {
        tenantId: ids.tenantA,
        reason: 'Đối soát quyền nguồn việc học giả lập',
        expectedRevision: old.revision,
        data: {
          appCode: 'aio-lms-sandbox',
          accountId: ids.learner,
          active,
          validUntil: grantBefore?.validUntil ?? null,
        },
      },
    }),
  );
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}
async function scan(page: Page, name: string) {
  current = page;
  assert.ok([A, L].includes(new URL(page.url()).origin));
  assert.equal(await page.locator('input[type=password],#otp').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    name,
    violations: result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    incomplete: result.incomplete.map((v) => v.id),
  });
  await writeFile('.local/evidence/lms-work-center-axe.json', JSON.stringify(scans, null, 2));
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => (window as Window & { csp?: string[] }).csp), []);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: '.local/evidence/lms-work-center-' + name + '.png',
    fullPage: (await page.getByRole('dialog').count()) === 0,
  });
}
try {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  app = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((c) => c.code === 'aio-foundation')!,
    test: true,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 4100 });
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  reminders = await lmsReminderRuntime(runtime, worker.db, worker.config);
  operator = await login(
    A,
    runtime.users.find((u) => u.id === ids.admin)!,
    true,
  );
  author = await login(L, publisher, true);
  grantBefore = (
    await json(
      await operator.context.request.get(
        A + '/api/v1/manage/grants?tenantId=' + ids.tenantA + '&appCode=aio-lms-sandbox',
      ),
    )
  ).items.find((g: Row) => g.accountId === ids.learner);
  assert.equal(grantBefore?.active, true);
  const learner = await login(
    A,
    runtime.users.find((u) => u.id === ids.learner)!,
  );
  stage = 'course/path/batch fixtures';
  const title = 'Việc học ' + suffix,
    draft = await send(author, '/api/lms/commands', 'save-course', {
      code: 'work-' + suffix,
      ownerUnitId: ids.unitA,
      expectedRevision: 0,
      spec: {
        schemaVersion: 3,
        title: 'Nội dung ' + suffix,
        subtitle: 'Giả lập, không kiểm phát video trong suite này',
        series: 'TLQM',
        duration: 10,
        video: { kind: 'youtube', id: 'abcdefghijk' },
        deadline: '',
        isMandatory: true,
        audienceUnits: [ids.unitA],
        checkpoints: [],
        questions: [
          { id: 'q', type: 'single', question: 'Quy tắc giả lập?', options: ['Đúng', 'Sai'] },
        ],
        answerKey: { q: { answer: 0, explanation: 'Đã đối soát' } },
        attachments: [],
        policy: {
          ...defaultLearningPolicy,
          requireVideoCompletion: false,
          checkpointPolicy: 'none',
        },
      },
    }),
    course = await send(author, '/api/lms/commands', 'publish-course', {
      courseId: draft.id,
      expectedRevision: draft.revision,
    }),
    path = await send(author, '/api/lms/training-commands', 'save-path', {
      expectedRevision: 0,
      spec: {
        schemaVersion: 1,
        title: 'Lộ trình ' + suffix,
        description: 'Đợt nhắc hạn thử',
        courseVersionIds: [course.versionId],
        audienceUnits: [ids.unitA],
      },
    }),
    published = await send(author, '/api/lms/training-commands', 'publish-path', {
      id: path.id,
      expectedRevision: path.revision,
    });
  batchId = (
    await send(author, '/api/lms/training-commands', 'create-batch', {
      pathVersionId: published.versionId,
      ownerUnitId: ids.unitA,
      title,
      startsAt: Date.now() - 86400000,
      dueAt: Date.now() - 120000,
      accountIds: [ids.learner],
    })
  ).id;
  policyBefore = (
    await json(await author.context.request.get(L + '/api/lms/training-reminder-policies'))
  ).items.find((p: Row) => p.unit_id === ids.unitA);
  stage = 'native reminder configuration';
  current = author.page;
  await author.page.getByRole('tab', { name: 'Quản lý đào tạo', exact: true }).click();
  const trigger = author.page.getByRole('button', { name: 'Nhắc hạn đào tạo', exact: true });
  await trigger.click();
  let dialog = author.page.getByRole('dialog');
  await select(author.page, 'Đơn vị nhắc hạn đào tạo', 'Đào tạo');
  await dialog.getByRole('checkbox', { name: 'Bật nhắc hạn cho đơn vị', exact: true }).check();
  await dialog.getByLabel('Phút trước hạn', { exact: true }).fill('60');
  await dialog.getByLabel('Phút sau khi quá hạn', { exact: true }).fill('1');
  await dialog
    .getByLabel('Lý do thay đổi nhắc hạn', { exact: true })
    .fill('Nhắc hạn cho đợt đào tạo giả lập');
  await scan(author.page, 'settings-desktop');
  await author.page.setViewportSize({ width: 390, height: 844 });
  await dialog
    .getByRole('button', { name: 'Lưu nhắc hạn đào tạo', exact: true })
    .scrollIntoViewIfNeeded();
  await scan(author.page, 'settings-mobile');
  policyTouched = true;
  await dialog.getByRole('button', { name: 'Lưu nhắc hạn đào tạo', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Đã lưu chính sách');
  await author.page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await reminders.tick();
  await reminders.tick();
  assert.equal(
    (await worker.db
      .prepare(
        "SELECT count(*) AS n FROM lms_training_notifications WHERE batch_id=? AND account_id=? AND kind='overdue'",
      )
      .bind(batchId!, ids.learner)
      .first<{ n: number }>())!.n,
    1,
  );
  stage = 'Portal feed without a separate LMS session';
  current = learner.page;
  assert.equal(
    (await learner.context.cookies(L)).some((c) => c.name === 'aio_lms_session'),
    false,
  );
  const sessionsBefore = await worker.db
    .prepare('SELECT count(*) AS n FROM aio_sessions WHERE account_id=?')
    .bind(ids.learner)
    .first<{ n: number }>();
  await learner.page.goto(A + '/#work-center');
  await select(learner.page, 'Nguồn công việc', 'Đào tạo');
  await learner.page.getByLabel('Tìm việc học', { exact: true }).fill(suffix);
  await expect(learner.page.getByText(title, { exact: true })).toBeVisible();
  await scan(learner.page, 'portal-desktop');
  await learner.page.setViewportSize({ width: 390, height: 844 });
  await scan(learner.page, 'portal-mobile');
  await learner.page.getByRole('tab', { name: 'Thông báo đào tạo', exact: true }).click();
  await expect(learner.page.getByText('Đã quá hạn học', { exact: true })).toBeVisible();
  await scan(learner.page, 'portal-notices');
  assert.deepEqual(
    await worker.db
      .prepare('SELECT count(*) AS n FROM aio_sessions WHERE account_id=?')
      .bind(ids.learner)
      .first<{ n: number }>(),
    sessionsBefore,
  );
  stage = 'service proof and audience boundaries';
  const portalCookie = (await learner.context.cookies(A)).find(
      (c) => c.name === 'aio_session_aio-foundation',
    )!,
    sessionHash = hashToken(portalCookie.value),
    stored = (
      await pool.query('SELECT encrypted_payload FROM sessions WHERE hash=$1 AND app_code=$2', [
        sessionHash,
        'aio-foundation',
      ])
    ).rows[0],
    tokens = unseal<LoginTokens>(
      stored.encrypted_payload,
      runtime.encryptionKey,
      'session:aio-foundation',
    ),
    q = {
      instanceId: runtime.instanceId,
      environment: 'test' as const,
      tenantId: ids.tenantA,
      sessionHash,
    };
  const rawRequest = async (token: string, query: typeof q, proof: string) =>
    learner.context.request.post(L + '/api/integrations/portal-work', {
      headers: { authorization: 'Bearer ' + token, 'x-aio-service-proof': proof },
      data: query,
    });
  const proof = await portalWorkProof(
    worker.config.clientSecret,
    worker.config.clientId,
    tokens.accessToken,
    q,
    'request',
  );
  await json(await rawRequest(tokens.accessToken, q, proof), 200);
  await json(
    await rawRequest(tokens.accessToken, { ...q, sessionHash: '0'.repeat(64) }, proof),
    403,
  );
  await json(
    await rawRequest(
      tokens.accessToken,
      q,
      await portalWorkProof(
        worker.config.clientSecret,
        worker.config.clientId,
        tokens.accessToken,
        q,
        'authorize',
      ),
    ),
    403,
  );
  await json(
    await rawRequest(
      tokens.idToken,
      q,
      await portalWorkProof(
        worker.config.clientSecret,
        worker.config.clientId,
        tokens.idToken,
        q,
        'request',
      ),
    ),
    401,
  );
  const feed = await json(
    await learner.context.request.get(A + '/api/v1/work-center/training?tenantId=' + ids.tenantA),
  );
  assert.equal(JSON.stringify(feed).includes(tokens.accessToken), false);
  assert.equal(JSON.stringify(feed).includes(sessionHash), false);
  await json(
    await learner.context.request.get(A + '/api/v1/work-center/training?tenantId=' + ids.tenantB),
    403,
  );
  stage = 'source revocation clears displayed data';
  blockedBatchId = (
    await send(author, '/api/lms/training-commands', 'create-batch', {
      pathVersionId: published.versionId,
      ownerUnitId: ids.unitA,
      title: 'Đợt kiểm quyền riêng ' + randomUUID().slice(0, 6),
      startsAt: Date.now() - 86400000,
      dueAt: Date.now() - 120000,
      accountIds: [ids.learner],
    })
  ).id;
  await grant(false);
  await reminders.tick();
  assert.equal(
    (await worker.db
      .prepare(
        "SELECT count(*) AS n FROM lms_training_notifications WHERE batch_id=? AND kind='overdue'",
      )
      .bind(blockedBatchId!)
      .first<{ n: number }>())!.n,
    0,
  );
  await learner.page.getByRole('button', { name: 'Tải lại việc học', exact: true }).click();
  await expect(learner.page.getByRole('alert')).toBeVisible();
  await expect(learner.page.getByText(title, { exact: true })).toHaveCount(0);
  await grant(true);
  await learner.page.getByRole('button', { name: 'Tải lại việc học', exact: true }).click();
  await expect(learner.page.getByRole('alert')).toHaveCount(0);
  stage = 'source outage and storage-preserving restart';
  await reminders.close();
  reminders = undefined;
  await worker.mf.dispose();
  worker = undefined;
  await learner.page.getByRole('button', { name: 'Tải lại việc học', exact: true }).click();
  await expect(learner.page.getByRole('alert')).toBeVisible();
  await expect(learner.page.getByText(title, { exact: true })).toHaveCount(0);
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  reminders = await lmsReminderRuntime(runtime, worker.db, worker.config);
  await reminders.tick();
  assert.equal(
    (await worker.db
      .prepare(
        "SELECT count(*) AS n FROM lms_training_notifications WHERE batch_id=? AND account_id=? AND kind='overdue'",
      )
      .bind(batchId!, ids.learner)
      .first<{ n: number }>())!.n,
    1,
  );
  await learner.page.getByRole('button', { name: 'Tải lại việc học', exact: true }).click();
  await expect(learner.page.getByRole('alert')).toHaveCount(0);
  stage = 'deep link performs source SSO then native read state';
  await learner.page.getByRole('link', { name: 'Mở đợt đào tạo', exact: true }).first().click();
  await learner.page.getByRole('link', { name: 'Đăng nhập SSO', exact: true }).click();
  await learner.page.waitForURL(L + '/#training-batch/' + batchId);
  await expect(learner.page.getByText(title, { exact: true })).toBeVisible();
  await scan(learner.page, 'deep-link-mobile');
  const native = {
    ...learner,
    me: await json(await learner.context.request.get(L + '/api/v1/me')),
  };
  await learner.page.getByRole('button', { name: 'Về danh sách đợt', exact: true }).click();
  await learner.page.getByRole('button', { name: 'Việc học & nhắc hạn', exact: true }).click();
  await learner.page.getByRole('tab', { name: 'Thông báo đào tạo', exact: true }).click();
  await learner.page.getByLabel('Tìm việc học', { exact: true }).fill(suffix);
  await learner.page.getByRole('button', { name: 'Đánh dấu đã đọc', exact: true }).first().click();
  await expect(
    learner.page.getByRole('button', { name: 'Đánh dấu chưa đọc', exact: true }),
  ).toHaveCount(1);
  await scan(learner.page, 'native-notice');
  const nativeCookie = (await learner.context.cookies(L)).find(
      (c) => c.name === 'aio_lms_session',
    )!,
    nativeHash = await hash(nativeCookie.value),
    nativeRow = await worker.db
      .prepare('SELECT encrypted_payload FROM aio_sessions WHERE hash=?')
      .bind(nativeHash)
      .first<{ encrypted_payload: string }>(),
    nativeTokens = await lmsUnseal<LmsTokens>(
      worker.config,
      nativeRow!.encrypted_payload,
      'session:' + nativeHash,
    );
  await json(
    await rawRequest(
      nativeTokens.accessToken,
      q,
      await portalWorkProof(
        worker.config.clientSecret,
        worker.config.clientId,
        nativeTokens.accessToken,
        q,
        'request',
      ),
    ),
    401,
  );
  stage = 'completion removes active work and local Portal logout invalidates delegation';
  await send(native, '/api/lms/commands', 'submit', {
    versionId: course.versionId,
    answers: { q: 0 },
    tabSwitchCount: 0,
  });
  await reminders.tick();
  const completed = await json(
    await learner.context.request.get(A + '/api/v1/work-center/training?tenantId=' + ids.tenantA),
  );
  assert.equal(
    completed.items.some((i: Row) => i.id === batchId),
    false,
  );
  assert.equal(
    completed.notices.some((n: Row) => n.batchId === batchId),
    false,
  );
  await learner.page.goto(A + '/#work-center');
  await select(learner.page, 'Nguồn công việc', 'Đào tạo');
  await learner.page.getByLabel('Tìm việc học', { exact: true }).fill(suffix);
  await expect(learner.page.getByText('Không có kết quả phù hợp.', { exact: true })).toBeVisible();
  await scan(learner.page, 'completed-mobile');
  await json(
    await learner.context.request.post(A + '/auth/logout', {
      headers: { origin: A, 'x-csrf-token': learner.me.csrfToken },
      data: { global: false },
    }),
  );
  await json(
    await rawRequest(
      tokens.accessToken,
      q,
      await portalWorkProof(
        worker.config.clientSecret,
        worker.config.clientId,
        tokens.accessToken,
        q,
        'request',
      ),
    ),
    401,
  );
  await writeFile(
    '.local/evidence/lms-work-center-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        batchId,
        scans,
        checks: [
          'MFA configuration and native notice read',
          'Portal read without creating LMS session',
          'independent audience/service proof/session enforcement',
          'revocation clears data',
          'durable reminder deduplication',
          'source SSO deep link',
          'source outage/restart and current background recipient permissions',
          'real passing completion hides tasks/notices',
          'Portal local logout rejects delegation',
        ],
        credentialsExposed: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS LMS work feed, native reminders and Portal delegation via real SSO; ' +
      scans.length +
      ' axe scans.',
  );
} catch (e) {
  if (
    current &&
    [A, L].includes(new URL(current.url()).origin) &&
    !(await current.locator('input[type=password],#otp').count())
  )
    await current.screenshot({
      path: '.local/evidence/lms-work-center-failure.png',
      fullPage: true,
    });
  console.error(
    'LMS work center failed at ' +
      stage +
      '; ' +
      (e instanceof Error
        ? (e.message.startsWith('HTTP_') ? e.message : e.name) +
          ' ' +
          (e.stack?.match(/lms-work-center-e2e\.ts:\d+:\d+/)?.[0] ?? '')
        : 'unknown') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  if (author && policyTouched)
    try {
      const old = (
        await json(await author.context.request.get(L + '/api/lms/training-reminder-policies'))
      ).items.find((p: Row) => p.unit_id === ids.unitA);
      await send(author, '/api/lms/training-commands', 'save-reminder-policy', {
        unitId: ids.unitA,
        enabled: !!policyBefore?.enabled,
        beforeMinutes: policyBefore?.before_minutes ?? 1440,
        overdueMinutes: policyBefore?.overdue_minutes ?? 60,
        expectedRevision: old.revision,
      });
    } catch {
      console.error('Training reminder fixture policy restoration pending.');
      process.exitCode = 1;
    }
  if (operator && grantBefore)
    try {
      await grant(grantBefore.active);
    } catch {
      console.error('Training learner grant restoration pending.');
      process.exitCode = 1;
    }
  if (author)
    for (const cleanupId of [batchId, blockedBatchId].filter((id): id is string => !!id))
      try {
        const b = await json(
          await author.context.request.get(
            L + '/api/lms/training-batch?id=' + cleanupId + '&manage=true',
          ),
        );
        if (b.status === 'active')
          await send(author, '/api/lms/training-commands', 'update-batch', {
            id: cleanupId,
            expectedRevision: b.revision,
            title: b.title,
            startsAt: b.startsAt,
            dueAt: b.dueAt,
            status: 'cancelled',
          });
      } catch {
        console.error('Synthetic training batch cancellation pending.');
        process.exitCode = 1;
      }
  await reminders?.close();
  await browser.close();
  await worker?.mf.dispose();
  app?.server.closeAllConnections();
  await app?.close();
  await pool.end();
}
