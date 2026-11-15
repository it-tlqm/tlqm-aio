import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { cmsDatabaseUrl, loadCmsConfig } from '../src/cms/database.js';
import { CmsService } from '../src/cms/service.js';
import { cmsPermissions } from '../src/cms/access.js';
import { ids } from '../src/fixtures.js';

const runtime = await loadLocalConfig();
const config = await loadCmsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: cmsDatabaseUrl(config, true, true), max: 1 });
const tenantId = ids.tenantA;
const actor = {
  appCode: 'aio-cms' as const,
  accountId: ids.admin,
  personId: ids.admin,
  tenantIds: [tenantId],
  permissions: Object.keys(cmsPermissions).map((permission) => ({
    tenantId,
    permission,
    orgUnitId: null,
  })),
};
const service = new CmsService(pool);
const command = (reason: string) => ({
  tenantId,
  actor: async () => actor,
  reason,
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
});

try {
  const existingWebsite = (
    await pool.query('SELECT * FROM cms_websites WHERE tenant_id=$1 AND code=$2', [
      tenantId,
      'cms-smoke',
    ])
  ).rows[0];
  const website =
    existingWebsite ??
    (await service.createWebsite(command('Create CMS smoke website'), {
      code: 'cms-smoke',
      name: 'CMS smoke website',
      defaultLocale: 'vi',
      locales: ['vi', 'en'],
    }));
  await pool.query("UPDATE cms_websites SET status='active' WHERE tenant_id=$1 AND id=$2", [
    tenantId,
    website.id,
  ]);

  let page = (
    await pool.query('SELECT * FROM cms_pages WHERE tenant_id=$1 AND website_id=$2 AND code=$3', [
      tenantId,
      website.id,
      'smoke-page',
    ])
  ).rows[0];
  if (!page) {
    const created = await service.createPage(command('Create CMS smoke page'), {
      websiteId: website.id,
      code: 'smoke-page',
      path: '/cms-smoke',
      kind: 'landing',
      locale: 'vi',
      document: {
        title: 'CMS smoke page',
        seo: { title: 'CMS smoke' },
        blocks: [{ id: 'hero', type: 'hero', data: { headline: 'Smoke' } }],
      },
    });
    page = (await pool.query('SELECT * FROM cms_pages WHERE id=$1', [created.page.id])).rows[0];
  }
  if (page.status !== 'published') {
    const published = await service.publish(
      command('Publish CMS smoke page'),
      page.id,
      page.revision,
      'vi',
    );
    page = (await pool.query('SELECT * FROM cms_pages WHERE id=$1', [published.page.id])).rows[0];
  }
  assert.equal(page.status, 'published');

  let type = (
    await pool.query(
      'SELECT * FROM cms_content_types WHERE tenant_id=$1 AND website_id=$2 AND code=$3',
      [tenantId, website.id, 'smoke-content'],
    )
  ).rows[0];
  if (!type)
    type = await service.createContentType(command('Create CMS smoke content type'), {
      websiteId: website.id,
      code: 'smoke-content',
      name: 'Smoke content',
      schema: { fields: { summary: 'text' } },
    });
  let entry = (
    await pool.query(
      'SELECT * FROM cms_content_entries WHERE tenant_id=$1 AND website_id=$2 AND content_type_id=$3 AND code=$4',
      [tenantId, website.id, type.id, 'smoke-entry'],
    )
  ).rows[0];
  if (!entry) {
    const created = await service.createContentEntry(command('Create CMS smoke content'), {
      websiteId: website.id,
      contentTypeCode: 'smoke-content',
      code: 'smoke-entry',
      locale: 'vi',
      document: { slug: 'smoke-entry', title: 'Smoke entry', seo: {}, data: { summary: 'Smoke' } },
    });
    entry = (await pool.query('SELECT * FROM cms_content_entries WHERE id=$1', [created.entry.id]))
      .rows[0];
  }
  if (entry.status !== 'published') {
    const published = await service.publishContent(
      command('Publish CMS smoke content'),
      entry.id,
      entry.revision,
      'vi',
    );
    entry = (
      await pool.query('SELECT * FROM cms_content_entries WHERE id=$1', [published.entry.id])
    ).rows[0];
  }
  assert.equal(entry.status, 'published');

  let channel = (
    await pool.query(
      'SELECT * FROM cms_channel_connections WHERE tenant_id=$1 AND website_id=$2 AND provider=$3 AND external_account_id=$4',
      [tenantId, website.id, 'website', 'cms-smoke'],
    )
  ).rows[0];
  if (!channel)
    channel = await service.createChannel(command('Create CMS smoke website channel'), {
      websiteId: website.id,
      provider: 'website',
      externalAccountId: 'cms-smoke',
      displayName: 'CMS smoke website',
    });
  const publication = await service.queuePublication(command('Queue CMS smoke publication'), {
    websiteId: website.id,
    connectionId: channel.id,
    targetKind: 'page',
    targetId: page.id,
    revisionId: page.published_revision_id,
  });
  assert.equal(publication.state, 'queued');

  const existingMenu = (
    await pool.query(
      'SELECT revision FROM cms_menus WHERE tenant_id=$1 AND website_id=$2 AND code=$3 AND locale=$4',
      [tenantId, website.id, 'main', 'vi'],
    )
  ).rows[0];
  const menu = await service.saveMenuDraft(command('Save CMS smoke menu'), {
    websiteId: website.id,
    code: 'main',
    name: 'Main menu',
    locale: 'vi',
    items: [{ id: 'home', label: 'Trang chủ', path: '/' }],
    ...(existingMenu ? { expectedRevision: existingMenu.revision } : {}),
  });
  const publishedMenu = await service.publishMenu(
    command('Publish CMS smoke menu'),
    menu.id,
    menu.revision,
  );
  assert.deepEqual(publishedMenu.published, [
    { id: 'home', label: 'Trang chủ', path: '/', children: [] },
  ]);

  const publicPage = await service.publicPage('cms-smoke', '/cms-smoke', 'vi');
  const publicContent = await service.publicContent(
    'cms-smoke',
    'smoke-content',
    'smoke-entry',
    'vi',
  );
  assert.equal(publicPage.code, 'smoke-page');
  assert.equal(publicContent.code, 'smoke-entry');

  const beforeRevision = (
    await pool.query(
      'SELECT revision,published_revision_id AS "publishedRevisionId" FROM cms_pages WHERE id=$1',
      [page.id],
    )
  ).rows[0];
  const draft = await service.saveDraft(
    command('Save CMS review draft'),
    page.id,
    beforeRevision.revision,
    'vi',
    {
      title: 'CMS smoke review',
      seo: {},
      blocks: [{ id: 'hero', type: 'hero', data: { headline: 'Review' } }],
    },
  );
  const reviewed = await service.submitPageReview(
    command('Submit CMS review'),
    page.id,
    draft.page.revision,
    'vi',
  );
  const republished = await service.publish(
    command('Publish CMS review'),
    page.id,
    reviewed.page.revision,
    'vi',
  );
  const rolledBack = await service.rollbackPage(
    command('Rollback CMS review'),
    page.id,
    beforeRevision.publishedRevisionId,
    republished.page.revision,
    'vi',
  );
  assert.equal(rolledBack.page.status, 'published');
  const beforeEntry = (
    await pool.query(
      'SELECT revision,published_revision_id AS "publishedRevisionId" FROM cms_content_entries WHERE id=$1',
      [entry.id],
    )
  ).rows[0];
  const contentDraft = await service.saveContentDraft(
    command('Save CMS content review draft'),
    entry.id,
    beforeEntry.revision,
    'vi',
    { slug: 'smoke-entry', title: 'Smoke content review', seo: {}, data: { summary: 'Review' } },
  );
  const contentReview = await service.submitContentReview(
    command('Submit CMS content review'),
    entry.id,
    contentDraft.entry.revision,
    'vi',
  );
  const contentRepublished = await service.publishContent(
    command('Publish CMS content review'),
    entry.id,
    contentReview.entry.revision,
    'vi',
  );
  const contentRolledBack = await service.rollbackContent(
    command('Rollback CMS content review'),
    entry.id,
    beforeEntry.publishedRevisionId,
    contentRepublished.entry.revision,
    'vi',
  );
  assert.equal(contentRolledBack.entry.status, 'published');
  await assert.rejects(
    () =>
      service.saveDraft(command('Reject stale CMS revision'), page.id, 1, 'vi', {
        title: 'Stale',
        seo: {},
        blocks: [],
      }),
    { code: 'CMS_REVISION_CONFLICT' },
  );
  const tenantBActor = {
    ...actor,
    tenantIds: [ids.tenantB],
    permissions: Object.keys(cmsPermissions).map((permission) => ({
      tenantId: ids.tenantB,
      permission,
      orgUnitId: null,
    })),
  };
  await assert.rejects(
    () => service.pages({ tenantId: ids.tenantB, actor: async () => tenantBActor }, website.id),
    { code: 'CMS_WEBSITE_NOT_FOUND' },
  );
  const auditCount = (
    await pool.query(
      'SELECT count(*)::integer AS count FROM cms_audit WHERE tenant_id=$1 AND website_id=$2',
      [tenantId, website.id],
    )
  ).rows[0].count;
  const receiptCount = (
    await pool.query('SELECT count(*)::integer AS count FROM cms_receipts WHERE tenant_id=$1', [
      tenantId,
    ])
  ).rows[0].count;
  assert.ok(auditCount > 0);
  assert.ok(receiptCount > 0);
  console.log('PASS: CMS service smoke website/page/content/menu/channel/public-read flow.');
} finally {
  await pool.end();
}
