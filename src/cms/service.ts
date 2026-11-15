import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../security.js';
import {
  parseCmsAsset,
  parseCmsContentDocument,
  parseCmsContentType,
  parseCmsMenu,
  parseCmsPageDocument,
  parseCmsWebsite,
  cmsCode,
  cmsPath,
  cmsLocale,
} from './contracts.js';
import { cmsUuid, requireCmsPermission } from './access.js';
import type { CmsActor, CmsCommand, CmsContext, CmsPermission } from './access.js';
import type { CmsPageDocument } from './contracts.js';
import { cmsProvider, parseCapabilities, providerCapabilities } from './channels.js';

type Db = Pool | PoolClient;
type WebsiteRow = {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  status: string;
  default_locale: string;
  locales: string[];
  revision: number;
};

function checksum(document: CmsPageDocument) {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function contentChecksum(document: unknown) {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function documentSlug(value: string) {
  if (!/^[a-z0-9][a-z0-9/_-]{0,200}$/.test(value)) throw new HttpError(400, 'CMS_INVALID_SLUG');
  return value;
}

function validateCommand(command: CmsCommand) {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(command.idempotencyKey))
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  if (command.reason.trim().length < 5 || command.reason.length > 240)
    throw new HttpError(400, 'REASON_REQUIRED');
}

export class CmsService {
  constructor(readonly pool: Pool) {}

  private async actor(context: CmsContext) {
    cmsUuid(context.tenantId);
    const actor = await context.actor();
    if (actor.appCode !== 'aio-cms' || !actor.tenantIds.includes(context.tenantId))
      throw new HttpError(403, 'CMS_PERMISSION_DENIED');
    return actor;
  }

  private async website(db: Db, tenantId: string, id: string) {
    cmsUuid(id);
    const row = (
      await db.query('SELECT * FROM cms_websites WHERE tenant_id=$1 AND id=$2', [tenantId, id])
    ).rows[0] as WebsiteRow | undefined;
    if (!row) throw new HttpError(404, 'CMS_WEBSITE_NOT_FOUND');
    return row;
  }

  private async command<T>(
    context: CmsCommand,
    operation: string,
    input: unknown,
    permission: CmsPermission,
    action: (db: PoolClient, actor: CmsActor) => Promise<T>,
  ) {
    validateCommand(context);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'aio-cms:' + context.tenantId,
      ]);
      const actor = await this.actor(context);
      requireCmsPermission(actor, context.tenantId, permission);
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ operation, input, reason: context.reason }))
        .digest('hex');
      const prior = (
        await db.query(
          'SELECT operation,request_hash,response FROM cms_receipts WHERE tenant_id=$1 AND actor_account_id=$2 AND idempotency_key=$3',
          [context.tenantId, actor.accountId, context.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.operation !== operation || prior.request_hash !== requestHash)
          throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
        await db.query('COMMIT');
        return prior.response as T;
      }
      const response = JSON.parse(JSON.stringify(await action(db, actor))) as T;
      await db.query(
        'INSERT INTO cms_receipts(tenant_id,actor_account_id,idempotency_key,operation,request_hash,response) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          context.tenantId,
          actor.accountId,
          context.idempotencyKey,
          operation,
          requestHash,
          JSON.stringify(response),
        ],
      );
      await db.query('COMMIT');
      return response;
    } catch (error) {
      await db.query('ROLLBACK');
      const code = (error as { code?: string }).code;
      if (code === '23505') throw new HttpError(409, 'CMS_DUPLICATE_RECORD');
      if (code === '23503' || code === '23514') throw new HttpError(400, 'CMS_INVALID_DATA');
      throw error;
    } finally {
      db.release();
    }
  }

  async websites(context: CmsContext) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    return (
      await this.pool.query(
        'SELECT id,tenant_id AS "tenantId",code,name,status,default_locale AS "defaultLocale",locales,revision FROM cms_websites WHERE tenant_id=$1 ORDER BY code',
        [context.tenantId],
      )
    ).rows;
  }

  async createWebsite(context: CmsCommand, input: unknown) {
    const website = parseCmsWebsite(input);
    return this.command(context, 'cms.website.create', website, 'cms:manage', async (db, actor) => {
      const id = randomUUID();
      const row = (
        await db.query(
          'INSERT INTO cms_websites(id,tenant_id,code,name,default_locale,locales,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,tenant_id AS "tenantId",code,name,status,default_locale AS "defaultLocale",locales,revision',
          [
            id,
            context.tenantId,
            website.code,
            website.name,
            website.defaultLocale,
            website.locales,
            actor.accountId,
          ],
        )
      ).rows[0];
      await db.query(
        'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          context.tenantId,
          id,
          actor.accountId,
          'website.created',
          id,
          context.reason.trim(),
          context.requestId,
          JSON.stringify({ after: row }),
        ],
      );
      return row;
    });
  }

  async pages(context: CmsContext, websiteId: string) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    await this.website(this.pool, context.tenantId, websiteId);
    return (
      await this.pool.query(
        'SELECT id,website_id AS "websiteId",code,path,kind,status,revision,draft_revision_id AS "draftRevisionId",published_revision_id AS "publishedRevisionId",created_at AS "createdAt",updated_at AS "updatedAt" FROM cms_pages WHERE tenant_id=$1 AND website_id=$2 ORDER BY path',
        [context.tenantId, websiteId],
      )
    ).rows;
  }

  async pageDetail(context: CmsContext, pageId: string) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    cmsUuid(pageId);
    const page = (
      await this.pool.query(
        'SELECT id,website_id AS "websiteId",code,path,kind,status,revision,draft_revision_id AS "draftRevisionId",published_revision_id AS "publishedRevisionId" FROM cms_pages WHERE tenant_id=$1 AND id=$2',
        [context.tenantId, pageId],
      )
    ).rows[0];
    if (!page) throw new HttpError(404, 'CMS_PAGE_NOT_FOUND');
    const revisions = (
      await this.pool.query(
        'SELECT id,version,locale,state,title,seo,blocks,checksum,created_at AS "createdAt",published_at AS "publishedAt" FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 ORDER BY locale,version DESC',
        [context.tenantId, pageId],
      )
    ).rows;
    return { page, revisions };
  }

  async createPage(
    context: CmsCommand,
    input: {
      websiteId: string;
      code: string;
      path: string;
      kind: string;
      locale: string;
      document: unknown;
    },
  ) {
    const websiteId = cmsUuid(input.websiteId);
    const code = cmsCode(input.code);
    const path = cmsPath(input.path);
    const locale = cmsLocale(input.locale);
    const document = parseCmsPageDocument(input.document);
    if (!['landing', 'collection', 'system'].includes(input.kind))
      throw new HttpError(400, 'CMS_INVALID_PAGE_KIND');
    return this.command(
      context,
      'cms.page.create',
      { websiteId, code, path, kind: input.kind, locale, document },
      'cms:edit',
      async (db, actor) => {
        const website = await this.website(db, context.tenantId, websiteId);
        if (!website.locales.includes(locale)) throw new HttpError(400, 'CMS_LOCALE_NOT_ENABLED');
        const pageId = randomUUID();
        const revisionId = randomUUID();
        const page = (
          await db.query(
            'INSERT INTO cms_pages(id,tenant_id,website_id,code,path,kind,draft_revision_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,website_id AS "websiteId",code,path,kind,status,revision,draft_revision_id AS "draftRevisionId",published_revision_id AS "publishedRevisionId"',
            [pageId, context.tenantId, websiteId, code, path, input.kind, null, actor.accountId],
          )
        ).rows[0];
        const revision = (
          await db.query(
            'INSERT INTO cms_page_revisions(id,tenant_id,website_id,page_id,version,locale,title,seo,blocks,checksum,created_by) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10) RETURNING *',
            [
              revisionId,
              context.tenantId,
              websiteId,
              pageId,
              locale,
              document.title,
              JSON.stringify(document.seo),
              JSON.stringify(document.blocks),
              checksum(document),
              actor.accountId,
            ],
          )
        ).rows[0];
        await db.query('UPDATE cms_pages SET draft_revision_id=$3 WHERE tenant_id=$1 AND id=$2', [
          context.tenantId,
          pageId,
          revisionId,
        ]);
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,page_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            context.tenantId,
            websiteId,
            pageId,
            actor.accountId,
            'page.created',
            pageId,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ revision }),
          ],
        );
        return { page, revision };
      },
    );
  }

  async setWebsiteStatus(
    context: CmsCommand,
    websiteId: string,
    expectedRevision: number,
    status: 'draft' | 'active' | 'disabled',
  ) {
    cmsUuid(websiteId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new HttpError(400, 'REVISION_REQUIRED');
    return this.command(
      context,
      'cms.website.status',
      { websiteId, expectedRevision, status },
      'cms:manage',
      async (db, actor) => {
        const row = (
          await db.query('SELECT * FROM cms_websites WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
            context.tenantId,
            websiteId,
          ])
        ).rows[0];
        if (!row) throw new HttpError(404, 'CMS_WEBSITE_NOT_FOUND');
        if (row.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const updated = (
          await db.query(
            'UPDATE cms_websites SET status=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,code,name,status,revision',
            [context.tenantId, websiteId, status],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            websiteId,
            actor.accountId,
            'website.status_changed',
            websiteId,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ before: row.status, after: updated.status }),
          ],
        );
        return updated;
      },
    );
  }

  async domains(context: CmsContext, websiteId?: string) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    if (websiteId) await this.website(this.pool, context.tenantId, websiteId);
    return (
      await this.pool.query(
        'SELECT id,website_id AS "websiteId",host,environment,active,created_at AS "createdAt" FROM cms_domains WHERE tenant_id=$1 AND ($2::uuid IS NULL OR website_id=$2) ORDER BY host',
        [context.tenantId, websiteId ?? null],
      )
    ).rows;
  }

  async addDomain(context: CmsCommand, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new HttpError(400, 'CMS_INVALID_DOMAIN');
    const value = input as Record<string, unknown>;
    const websiteId = cmsUuid(value.websiteId);
    const host = typeof value.host === 'string' ? value.host.trim().toLowerCase() : '';
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) &&
      host !== 'localhost'
    )
      throw new HttpError(400, 'CMS_INVALID_DOMAIN');
    const environment = value.environment;
    if (environment !== 'local' && environment !== 'preview' && environment !== 'production')
      throw new HttpError(400, 'CMS_INVALID_DOMAIN');
    return this.command(
      context,
      'cms.domain.add',
      { websiteId, host, environment },
      'cms:manage',
      async (db, actor) => {
        await this.website(db, context.tenantId, websiteId);
        const row = (
          await db.query(
            'INSERT INTO cms_domains(id,tenant_id,website_id,host,environment) VALUES ($1,$2,$3,$4,$5) RETURNING id,website_id AS "websiteId",host,environment,active',
            [randomUUID(), context.tenantId, websiteId, host, environment],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            websiteId,
            actor.accountId,
            'domain.added',
            row.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: row }),
          ],
        );
        return row;
      },
    );
  }

  async saveDraft(
    context: CmsCommand,
    pageId: string,
    expectedRevision: number,
    locale: string,
    documentInput: unknown,
  ) {
    cmsUuid(pageId);
    const document = parseCmsPageDocument(documentInput);
    const parsedLocale = cmsLocale(locale);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new HttpError(400, 'REVISION_REQUIRED');
    return this.command(
      context,
      'cms.page.save_draft',
      { pageId, expectedRevision, locale: parsedLocale, document },
      'cms:edit',
      async (db, actor) => {
        const page = (
          await db.query('SELECT * FROM cms_pages WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
            context.tenantId,
            pageId,
          ])
        ).rows[0];
        if (!page) throw new HttpError(404, 'CMS_PAGE_NOT_FOUND');
        if (page.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const website = await this.website(db, context.tenantId, page.website_id);
        if (!website.locales.includes(parsedLocale))
          throw new HttpError(400, 'CMS_LOCALE_NOT_ENABLED');
        const version = Number(
          (
            await db.query(
              'SELECT COALESCE(max(version),0)+1 AS version FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 AND locale=$3',
              [context.tenantId, pageId, parsedLocale],
            )
          ).rows[0].version,
        );
        const revision = (
          await db.query(
            'INSERT INTO cms_page_revisions(id,tenant_id,website_id,page_id,version,locale,title,seo,blocks,checksum,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
            [
              randomUUID(),
              context.tenantId,
              page.website_id,
              pageId,
              version,
              parsedLocale,
              document.title,
              JSON.stringify(document.seo),
              JSON.stringify(document.blocks),
              checksum(document),
              actor.accountId,
            ],
          )
        ).rows[0];
        const updated = (
          await db.query(
            'UPDATE cms_pages SET draft_revision_id=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,revision,draft_revision_id AS "draftRevisionId",published_revision_id AS "publishedRevisionId",status',
            [context.tenantId, pageId, revision.id],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,page_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            context.tenantId,
            page.website_id,
            pageId,
            actor.accountId,
            'page.draft_saved',
            revision.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: revision }),
          ],
        );
        return { page: updated, revision };
      },
    );
  }

  async publish(context: CmsCommand, pageId: string, expectedRevision: number, locale: string) {
    cmsUuid(pageId);
    const parsedLocale = cmsLocale(locale);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new HttpError(400, 'REVISION_REQUIRED');
    return this.command(
      context,
      'cms.page.publish',
      { pageId, expectedRevision, locale: parsedLocale },
      'cms:publish',
      async (db, actor) => {
        const page = (
          await db.query('SELECT * FROM cms_pages WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
            context.tenantId,
            pageId,
          ])
        ).rows[0];
        if (!page) throw new HttpError(404, 'CMS_PAGE_NOT_FOUND');
        if (page.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const draft = (
          await db.query(
            "SELECT * FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 AND locale=$3 AND state IN ('draft','review') ORDER BY version DESC LIMIT 1",
            [context.tenantId, pageId, parsedLocale],
          )
        ).rows[0];
        if (!draft) throw new HttpError(409, 'CMS_DRAFT_NOT_FOUND');
        const version = Number(
          (
            await db.query(
              'SELECT COALESCE(max(version),0)+1 AS version FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 AND locale=$3',
              [context.tenantId, pageId, parsedLocale],
            )
          ).rows[0].version,
        );
        const revision = (
          await db.query(
            "INSERT INTO cms_page_revisions(id,tenant_id,website_id,page_id,version,locale,state,title,seo,blocks,checksum,created_by,published_by,published_at) VALUES ($1,$2,$3,$4,$5,$6,'published',$7,$8,$9,$10,$11,$12,now()) RETURNING *",
            [
              randomUUID(),
              context.tenantId,
              page.website_id,
              pageId,
              version,
              parsedLocale,
              draft.title,
              JSON.stringify(draft.seo),
              JSON.stringify(draft.blocks),
              draft.checksum,
              draft.created_by,
              actor.accountId,
            ],
          )
        ).rows[0];
        const updated = (
          await db.query(
            'UPDATE cms_pages SET published_revision_id=$3,status=\'published\',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,revision,status,published_revision_id AS "publishedRevisionId"',
            [context.tenantId, pageId, revision.id],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,page_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            context.tenantId,
            page.website_id,
            pageId,
            actor.accountId,
            'page.published',
            revision.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: revision }),
          ],
        );
        return { page: updated, revision };
      },
    );
  }

  async submitPageReview(
    context: CmsCommand,
    pageId: string,
    expectedRevision: number,
    locale: string,
  ) {
    cmsUuid(pageId);
    const parsedLocale = cmsLocale(locale);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new HttpError(400, 'REVISION_REQUIRED');
    return this.command(
      context,
      'cms.page.submit_review',
      { pageId, expectedRevision, locale: parsedLocale },
      'cms:edit',
      async (db, actor) => {
        const page = (
          await db.query('SELECT * FROM cms_pages WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
            context.tenantId,
            pageId,
          ])
        ).rows[0];
        if (!page) throw new HttpError(404, 'CMS_PAGE_NOT_FOUND');
        if (page.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const draft = (
          await db.query(
            "SELECT * FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 AND locale=$3 AND state IN ('draft','review') ORDER BY version DESC LIMIT 1",
            [context.tenantId, pageId, parsedLocale],
          )
        ).rows[0];
        if (!draft) throw new HttpError(409, 'CMS_DRAFT_NOT_FOUND');
        if (draft.state === 'review') return { page, revision: draft };
        const version = Number(
          (
            await db.query(
              'SELECT COALESCE(max(version),0)+1 AS version FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 AND locale=$3',
              [context.tenantId, pageId, parsedLocale],
            )
          ).rows[0].version,
        );
        const revision = (
          await db.query(
            "INSERT INTO cms_page_revisions(id,tenant_id,website_id,page_id,version,locale,state,title,seo,blocks,checksum,created_by) VALUES ($1,$2,$3,$4,$5,$6,'review',$7,$8,$9,$10,$11) RETURNING *",
            [
              randomUUID(),
              context.tenantId,
              page.website_id,
              pageId,
              version,
              parsedLocale,
              draft.title,
              JSON.stringify(draft.seo),
              JSON.stringify(draft.blocks),
              draft.checksum,
              actor.accountId,
            ],
          )
        ).rows[0];
        const updated = (
          await db.query(
            'UPDATE cms_pages SET draft_revision_id=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,revision,status,draft_revision_id AS "draftRevisionId"',
            [context.tenantId, pageId, revision.id],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,page_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            context.tenantId,
            page.website_id,
            pageId,
            actor.accountId,
            'page.review_submitted',
            revision.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: revision }),
          ],
        );
        return { page: updated, revision };
      },
    );
  }

  async rollbackPage(
    context: CmsCommand,
    pageId: string,
    targetRevisionId: string,
    expectedRevision: number,
    locale: string,
  ) {
    cmsUuid(pageId);
    cmsUuid(targetRevisionId);
    const parsedLocale = cmsLocale(locale);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new HttpError(400, 'REVISION_REQUIRED');
    return this.command(
      context,
      'cms.page.rollback',
      { pageId, targetRevisionId, expectedRevision, locale: parsedLocale },
      'cms:publish',
      async (db, actor) => {
        const page = (
          await db.query('SELECT * FROM cms_pages WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
            context.tenantId,
            pageId,
          ])
        ).rows[0];
        if (!page) throw new HttpError(404, 'CMS_PAGE_NOT_FOUND');
        if (page.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const target = (
          await db.query(
            "SELECT * FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 AND id=$3 AND locale=$4 AND state='published'",
            [context.tenantId, pageId, targetRevisionId, parsedLocale],
          )
        ).rows[0];
        if (!target) throw new HttpError(404, 'CMS_REVISION_NOT_FOUND');
        const version = Number(
          (
            await db.query(
              'SELECT COALESCE(max(version),0)+1 AS version FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 AND locale=$3',
              [context.tenantId, pageId, parsedLocale],
            )
          ).rows[0].version,
        );
        const revision = (
          await db.query(
            "INSERT INTO cms_page_revisions(id,tenant_id,website_id,page_id,version,locale,state,title,seo,blocks,checksum,created_by,published_by,published_at) VALUES ($1,$2,$3,$4,$5,$6,'published',$7,$8,$9,$10,$11,$12,now()) RETURNING *",
            [
              randomUUID(),
              context.tenantId,
              page.website_id,
              pageId,
              version,
              parsedLocale,
              target.title,
              JSON.stringify(target.seo),
              JSON.stringify(target.blocks),
              target.checksum,
              target.created_by,
              actor.accountId,
            ],
          )
        ).rows[0];
        const updated = (
          await db.query(
            'UPDATE cms_pages SET published_revision_id=$3,status=\'published\',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,revision,status,published_revision_id AS "publishedRevisionId"',
            [context.tenantId, pageId, revision.id],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,page_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            context.tenantId,
            page.website_id,
            pageId,
            actor.accountId,
            'page.rolled_back',
            revision.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ sourceRevisionId: targetRevisionId, after: revision }),
          ],
        );
        return { page: updated, revision };
      },
    );
  }

  async publicPage(websiteCode: string, path: string, locale: string) {
    const result = await this.pool.query(
      'SELECT p.id,p.code,p.path,p.kind,w.id AS "websiteId",w.code AS "websiteCode",r.id AS "revisionId",r.version,r.locale,r.title,r.seo,r.blocks,r.checksum,r.published_at AS "publishedAt" FROM cms_pages p JOIN cms_websites w ON w.tenant_id=p.tenant_id AND w.id=p.website_id AND w.code=$1 AND w.status=\'active\' JOIN LATERAL (SELECT r.* FROM cms_page_revisions r WHERE r.tenant_id=p.tenant_id AND r.website_id=p.website_id AND r.page_id=p.id AND r.state=\'published\' AND r.locale=$3 ORDER BY r.version DESC LIMIT 1) r ON true WHERE p.path=$2 AND p.status=\'published\'',
      [websiteCode, cmsPath(path), cmsLocale(locale)],
    );
    if (!result.rows[0]) throw new HttpError(404, 'CMS_PAGE_NOT_FOUND');
    return result.rows[0];
  }

  async contentTypes(context: CmsContext, websiteId: string) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    await this.website(this.pool, context.tenantId, websiteId);
    return (
      await this.pool.query(
        'SELECT id,website_id AS "websiteId",code,name,schema,active,revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM cms_content_types WHERE tenant_id=$1 AND website_id=$2 ORDER BY code',
        [context.tenantId, websiteId],
      )
    ).rows;
  }

  async createContentType(context: CmsCommand, input: unknown) {
    const value = parseCmsContentType(input);
    const websiteId = cmsUuid((input as Record<string, unknown>).websiteId);
    return this.command(
      context,
      'cms.content_type.create',
      { websiteId, ...value },
      'cms:manage',
      async (db, actor) => {
        await this.website(db, context.tenantId, websiteId);
        const id = randomUUID();
        const row = (
          await db.query(
            'INSERT INTO cms_content_types(id,tenant_id,website_id,code,name,schema,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,website_id AS "websiteId",code,name,schema,active,revision',
            [
              id,
              context.tenantId,
              websiteId,
              value.code,
              value.name,
              JSON.stringify(value.schema),
              actor.accountId,
            ],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            websiteId,
            actor.accountId,
            'content_type.created',
            id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: row }),
          ],
        );
        return row;
      },
    );
  }

  async contentEntries(context: CmsContext, websiteId: string, contentTypeCode?: string) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    await this.website(this.pool, context.tenantId, websiteId);
    const params: unknown[] = [context.tenantId, websiteId];
    const filter = contentTypeCode ? ' AND t.code=$3' : '';
    if (contentTypeCode) params.push(cmsCode(contentTypeCode));
    return (
      await this.pool.query(
        `SELECT e.id,e.website_id AS "websiteId",e.content_type_id AS "contentTypeId",t.code AS "contentTypeCode",e.code,e.status,e.revision,e.draft_revision_id AS "draftRevisionId",e.published_revision_id AS "publishedRevisionId",e.created_at AS "createdAt",e.updated_at AS "updatedAt" FROM cms_content_entries e JOIN cms_content_types t ON t.tenant_id=e.tenant_id AND t.website_id=e.website_id AND t.id=e.content_type_id WHERE e.tenant_id=$1 AND e.website_id=$2${filter} ORDER BY t.code,e.code`,
        params,
      )
    ).rows;
  }

  async createContentEntry(
    context: CmsCommand,
    input: {
      websiteId: string;
      contentTypeCode: string;
      code: string;
      locale: string;
      document: unknown;
    },
  ) {
    const websiteId = cmsUuid(input.websiteId);
    const code = cmsCode(input.code);
    const locale = cmsLocale(input.locale);
    const document = parseCmsContentDocument(input.document);
    return this.command(
      context,
      'cms.content_entry.create',
      { websiteId, contentTypeCode: input.contentTypeCode, code, locale, document },
      'cms:edit',
      async (db, actor) => {
        const website = await this.website(db, context.tenantId, websiteId);
        if (!website.locales.includes(locale)) throw new HttpError(400, 'CMS_LOCALE_NOT_ENABLED');
        const type = (
          await db.query(
            'SELECT * FROM cms_content_types WHERE tenant_id=$1 AND website_id=$2 AND code=$3 AND active',
            [context.tenantId, websiteId, cmsCode(input.contentTypeCode)],
          )
        ).rows[0];
        if (!type) throw new HttpError(404, 'CMS_CONTENT_TYPE_NOT_FOUND');
        const entryId = randomUUID();
        const revisionId = randomUUID();
        const entry = (
          await db.query(
            'INSERT INTO cms_content_entries(id,tenant_id,website_id,content_type_id,code,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,website_id AS "websiteId",content_type_id AS "contentTypeId",code,status,revision',
            [entryId, context.tenantId, websiteId, type.id, code, actor.accountId],
          )
        ).rows[0];
        const revision = (
          await db.query(
            'INSERT INTO cms_content_revisions(id,tenant_id,website_id,content_type_id,entry_id,version,locale,slug,title,data,seo,checksum,created_by) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
            [
              revisionId,
              context.tenantId,
              websiteId,
              type.id,
              entryId,
              locale,
              document.slug,
              document.title,
              JSON.stringify(document.data),
              JSON.stringify(document.seo),
              contentChecksum(document),
              actor.accountId,
            ],
          )
        ).rows[0];
        await db.query(
          'UPDATE cms_content_entries SET draft_revision_id=$3 WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, entryId, revisionId],
        );
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            websiteId,
            actor.accountId,
            'content_entry.created',
            entryId,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: revision }),
          ],
        );
        return { entry, revision };
      },
    );
  }

  async saveContentDraft(
    context: CmsCommand,
    entryId: string,
    expectedRevision: number,
    locale: string,
    documentInput: unknown,
  ) {
    cmsUuid(entryId);
    const parsedLocale = cmsLocale(locale);
    const document = parseCmsContentDocument(documentInput);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new HttpError(400, 'REVISION_REQUIRED');
    return this.command(
      context,
      'cms.content_entry.save_draft',
      { entryId, expectedRevision, locale: parsedLocale, document },
      'cms:edit',
      async (db, actor) => {
        const entry = (
          await db.query(
            'SELECT * FROM cms_content_entries WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [context.tenantId, entryId],
          )
        ).rows[0];
        if (!entry) throw new HttpError(404, 'CMS_CONTENT_ENTRY_NOT_FOUND');
        if (entry.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const website = await this.website(db, context.tenantId, entry.website_id);
        if (!website.locales.includes(parsedLocale))
          throw new HttpError(400, 'CMS_LOCALE_NOT_ENABLED');
        const version = Number(
          (
            await db.query(
              'SELECT COALESCE(max(version),0)+1 AS version FROM cms_content_revisions WHERE tenant_id=$1 AND entry_id=$2 AND locale=$3',
              [context.tenantId, entryId, parsedLocale],
            )
          ).rows[0].version,
        );
        const revision = (
          await db.query(
            'INSERT INTO cms_content_revisions(id,tenant_id,website_id,content_type_id,entry_id,version,locale,slug,title,data,seo,checksum,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
            [
              randomUUID(),
              context.tenantId,
              entry.website_id,
              entry.content_type_id,
              entryId,
              version,
              parsedLocale,
              document.slug,
              document.title,
              JSON.stringify(document.data),
              JSON.stringify(document.seo),
              contentChecksum(document),
              actor.accountId,
            ],
          )
        ).rows[0];
        const updated = (
          await db.query(
            'UPDATE cms_content_entries SET draft_revision_id=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,revision,status,draft_revision_id AS "draftRevisionId",published_revision_id AS "publishedRevisionId"',
            [context.tenantId, entryId, revision.id],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            entry.website_id,
            actor.accountId,
            'content_entry.draft_saved',
            revision.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: revision }),
          ],
        );
        return { entry: updated, revision };
      },
    );
  }

  async publishContent(
    context: CmsCommand,
    entryId: string,
    expectedRevision: number,
    locale: string,
  ) {
    cmsUuid(entryId);
    const parsedLocale = cmsLocale(locale);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new HttpError(400, 'REVISION_REQUIRED');
    return this.command(
      context,
      'cms.content_entry.publish',
      { entryId, expectedRevision, locale: parsedLocale },
      'cms:publish',
      async (db, actor) => {
        const entry = (
          await db.query(
            'SELECT * FROM cms_content_entries WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [context.tenantId, entryId],
          )
        ).rows[0];
        if (!entry) throw new HttpError(404, 'CMS_CONTENT_ENTRY_NOT_FOUND');
        if (entry.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const draft = (
          await db.query(
            "SELECT * FROM cms_content_revisions WHERE tenant_id=$1 AND entry_id=$2 AND locale=$3 AND state='draft' ORDER BY version DESC LIMIT 1",
            [context.tenantId, entryId, parsedLocale],
          )
        ).rows[0];
        if (!draft) throw new HttpError(409, 'CMS_DRAFT_NOT_FOUND');
        const version = Number(
          (
            await db.query(
              'SELECT COALESCE(max(version),0)+1 AS version FROM cms_content_revisions WHERE tenant_id=$1 AND entry_id=$2 AND locale=$3',
              [context.tenantId, entryId, parsedLocale],
            )
          ).rows[0].version,
        );
        const revision = (
          await db.query(
            "INSERT INTO cms_content_revisions(id,tenant_id,website_id,content_type_id,entry_id,version,locale,state,slug,title,data,seo,checksum,created_by,published_by,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8,$9,$10,$11,$12,$13,$14,now()) RETURNING *",
            [
              randomUUID(),
              context.tenantId,
              entry.website_id,
              entry.content_type_id,
              entryId,
              version,
              parsedLocale,
              draft.slug,
              draft.title,
              JSON.stringify(draft.data),
              JSON.stringify(draft.seo),
              draft.checksum,
              draft.created_by,
              actor.accountId,
            ],
          )
        ).rows[0];
        const updated = (
          await db.query(
            'UPDATE cms_content_entries SET published_revision_id=$3,status=\'published\',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,revision,status,published_revision_id AS "publishedRevisionId"',
            [context.tenantId, entryId, revision.id],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            entry.website_id,
            actor.accountId,
            'content_entry.published',
            revision.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: revision }),
          ],
        );
        return { entry: updated, revision };
      },
    );
  }

  async submitContentReview(
    context: CmsCommand,
    entryId: string,
    expectedRevision: number,
    locale: string,
  ) {
    cmsUuid(entryId);
    const parsedLocale = cmsLocale(locale);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new HttpError(400, 'REVISION_REQUIRED');
    return this.command(
      context,
      'cms.content_entry.submit_review',
      { entryId, expectedRevision, locale: parsedLocale },
      'cms:edit',
      async (db, actor) => {
        const entry = (
          await db.query(
            'SELECT * FROM cms_content_entries WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [context.tenantId, entryId],
          )
        ).rows[0];
        if (!entry) throw new HttpError(404, 'CMS_CONTENT_ENTRY_NOT_FOUND');
        if (entry.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const draft = (
          await db.query(
            "SELECT * FROM cms_content_revisions WHERE tenant_id=$1 AND entry_id=$2 AND locale=$3 AND state IN ('draft','review') ORDER BY version DESC LIMIT 1",
            [context.tenantId, entryId, parsedLocale],
          )
        ).rows[0];
        if (!draft) throw new HttpError(409, 'CMS_DRAFT_NOT_FOUND');
        if (draft.state === 'review') return { entry, revision: draft };
        const version = Number(
          (
            await db.query(
              'SELECT COALESCE(max(version),0)+1 AS version FROM cms_content_revisions WHERE tenant_id=$1 AND entry_id=$2 AND locale=$3',
              [context.tenantId, entryId, parsedLocale],
            )
          ).rows[0].version,
        );
        const revision = (
          await db.query(
            "INSERT INTO cms_content_revisions(id,tenant_id,website_id,content_type_id,entry_id,version,locale,state,slug,title,data,seo,checksum,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'review',$8,$9,$10,$11,$12,$13) RETURNING *",
            [
              randomUUID(),
              context.tenantId,
              entry.website_id,
              entry.content_type_id,
              entryId,
              version,
              parsedLocale,
              draft.slug,
              draft.title,
              JSON.stringify(draft.data),
              JSON.stringify(draft.seo),
              draft.checksum,
              actor.accountId,
            ],
          )
        ).rows[0];
        const updated = (
          await db.query(
            'UPDATE cms_content_entries SET draft_revision_id=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,revision,status,draft_revision_id AS "draftRevisionId"',
            [context.tenantId, entryId, revision.id],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            entry.website_id,
            actor.accountId,
            'content_entry.review_submitted',
            revision.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: revision }),
          ],
        );
        return { entry: updated, revision };
      },
    );
  }

  async rollbackContent(
    context: CmsCommand,
    entryId: string,
    targetRevisionId: string,
    expectedRevision: number,
    locale: string,
  ) {
    cmsUuid(entryId);
    cmsUuid(targetRevisionId);
    const parsedLocale = cmsLocale(locale);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new HttpError(400, 'REVISION_REQUIRED');
    return this.command(
      context,
      'cms.content_entry.rollback',
      { entryId, targetRevisionId, expectedRevision, locale: parsedLocale },
      'cms:publish',
      async (db, actor) => {
        const entry = (
          await db.query(
            'SELECT * FROM cms_content_entries WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [context.tenantId, entryId],
          )
        ).rows[0];
        if (!entry) throw new HttpError(404, 'CMS_CONTENT_ENTRY_NOT_FOUND');
        if (entry.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const target = (
          await db.query(
            "SELECT * FROM cms_content_revisions WHERE tenant_id=$1 AND entry_id=$2 AND id=$3 AND locale=$4 AND state='published'",
            [context.tenantId, entryId, targetRevisionId, parsedLocale],
          )
        ).rows[0];
        if (!target) throw new HttpError(404, 'CMS_REVISION_NOT_FOUND');
        const version = Number(
          (
            await db.query(
              'SELECT COALESCE(max(version),0)+1 AS version FROM cms_content_revisions WHERE tenant_id=$1 AND entry_id=$2 AND locale=$3',
              [context.tenantId, entryId, parsedLocale],
            )
          ).rows[0].version,
        );
        const revision = (
          await db.query(
            "INSERT INTO cms_content_revisions(id,tenant_id,website_id,content_type_id,entry_id,version,locale,state,slug,title,data,seo,checksum,created_by,published_by,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8,$9,$10,$11,$12,$13,$14,now()) RETURNING *",
            [
              randomUUID(),
              context.tenantId,
              entry.website_id,
              entry.content_type_id,
              entryId,
              version,
              parsedLocale,
              target.slug,
              target.title,
              JSON.stringify(target.data),
              JSON.stringify(target.seo),
              target.checksum,
              target.created_by,
              actor.accountId,
            ],
          )
        ).rows[0];
        const updated = (
          await db.query(
            'UPDATE cms_content_entries SET published_revision_id=$3,status=\'published\',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,revision,status,published_revision_id AS "publishedRevisionId"',
            [context.tenantId, entryId, revision.id],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            entry.website_id,
            actor.accountId,
            'content_entry.rolled_back',
            revision.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ sourceRevisionId: targetRevisionId, after: revision }),
          ],
        );
        return { entry: updated, revision };
      },
    );
  }

  async publicContent(websiteCode: string, contentTypeCode: string, slug: string, locale: string) {
    const result = await this.pool.query(
      'SELECT e.id,e.code,t.code AS "contentTypeCode",w.id AS "websiteId",w.code AS "websiteCode",r.id AS "revisionId",r.version,r.locale,r.slug,r.title,r.data,r.seo,r.checksum,r.published_at AS "publishedAt" FROM cms_content_entries e JOIN cms_content_types t ON t.tenant_id=e.tenant_id AND t.website_id=e.website_id AND t.id=e.content_type_id JOIN cms_websites w ON w.tenant_id=e.tenant_id AND w.id=e.website_id AND w.code=$1 AND w.status=\'active\' JOIN LATERAL (SELECT r.* FROM cms_content_revisions r WHERE r.tenant_id=e.tenant_id AND r.website_id=e.website_id AND r.entry_id=e.id AND r.state=\'published\' AND r.locale=$4 AND r.slug=$3 ORDER BY r.version DESC LIMIT 1) r ON true WHERE e.status=\'published\' AND t.code=$2',
      [websiteCode, cmsCode(contentTypeCode), documentSlug(slug), cmsLocale(locale)],
    );
    if (!result.rows[0]) throw new HttpError(404, 'CMS_CONTENT_ENTRY_NOT_FOUND');
    return result.rows[0];
  }

  async assets(context: CmsContext, websiteId?: string) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    if (websiteId) await this.website(this.pool, context.tenantId, websiteId);
    return (
      await this.pool.query(
        'SELECT id,website_id AS "websiteId",storage_provider AS "storageProvider",storage_key AS "storageKey",public_url AS "publicUrl",name,mime_type AS "mimeType",byte_size AS "byteSize",checksum,alt,metadata,status,created_at AS "createdAt",updated_at AS "updatedAt" FROM cms_assets WHERE tenant_id=$1 AND ($2::uuid IS NULL OR website_id=$2 OR website_id IS NULL) ORDER BY created_at DESC',
        [context.tenantId, websiteId ?? null],
      )
    ).rows;
  }

  async createAsset(context: CmsCommand, input: unknown) {
    const asset = parseCmsAsset(input);
    return this.command(context, 'cms.asset.create', asset, 'cms:edit', async (db, actor) => {
      if (asset.websiteId) await this.website(db, context.tenantId, asset.websiteId);
      const row = (
        await db.query(
          'INSERT INTO cms_assets(id,tenant_id,website_id,storage_provider,storage_key,public_url,name,mime_type,byte_size,checksum,alt,metadata,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,website_id AS "websiteId",storage_provider AS "storageProvider",storage_key AS "storageKey",public_url AS "publicUrl",name,mime_type AS "mimeType",byte_size AS "byteSize",checksum,alt,metadata,status,created_at AS "createdAt"',
          [
            randomUUID(),
            context.tenantId,
            asset.websiteId,
            asset.storageProvider,
            asset.storageKey,
            asset.publicUrl,
            asset.name,
            asset.mimeType,
            asset.byteSize,
            asset.checksum ?? null,
            JSON.stringify(asset.alt),
            JSON.stringify(asset.metadata),
            actor.accountId,
          ],
        )
      ).rows[0];
      await db.query(
        'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          context.tenantId,
          asset.websiteId,
          actor.accountId,
          'asset.created',
          row.id,
          context.reason.trim(),
          context.requestId,
          JSON.stringify({ after: row }),
        ],
      );
      return row;
    });
  }

  async channels(context: CmsContext, websiteId: string) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    await this.website(this.pool, context.tenantId, websiteId);
    return (
      await this.pool.query(
        'SELECT id,website_id AS "websiteId",provider,external_account_id AS "externalAccountId",display_name AS "displayName",capability,status,last_error AS "lastError",revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM cms_channel_connections WHERE tenant_id=$1 AND website_id=$2 ORDER BY provider,display_name',
        [context.tenantId, websiteId],
      )
    ).rows;
  }

  async createChannel(context: CmsCommand, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new HttpError(400, 'CMS_INVALID_CHANNEL');
    const value = input as Record<string, unknown>;
    const websiteId = cmsUuid(value.websiteId);
    const provider = cmsProvider(value.provider);
    const externalAccountId =
      typeof value.externalAccountId === 'string' && value.externalAccountId.trim()
        ? value.externalAccountId.trim()
        : (() => {
            throw new HttpError(400, 'CMS_INVALID_CHANNEL');
          })();
    const displayName =
      typeof value.displayName === 'string' && value.displayName.trim()
        ? value.displayName.trim()
        : (() => {
            throw new HttpError(400, 'CMS_INVALID_CHANNEL');
          })();
    const tokenRef = value.tokenRef;
    if (
      tokenRef !== undefined &&
      (typeof tokenRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(tokenRef))
    )
      throw new HttpError(400, 'CMS_INVALID_TOKEN_REFERENCE');
    const capability = parseCapabilities(provider, value.capability);
    return this.command(
      context,
      'cms.channel.create',
      {
        websiteId,
        provider,
        externalAccountId,
        displayName,
        capability,
        tokenRef: tokenRef ?? null,
      },
      'cms:manage',
      async (db, actor) => {
        await this.website(db, context.tenantId, websiteId);
        const row = (
          await db.query(
            'INSERT INTO cms_channel_connections(id,tenant_id,website_id,provider,external_account_id,display_name,capability,token_ref,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,website_id AS "websiteId",provider,external_account_id AS "externalAccountId",display_name AS "displayName",capability,status,revision',
            [
              randomUUID(),
              context.tenantId,
              websiteId,
              provider,
              externalAccountId,
              displayName,
              JSON.stringify(capability),
              tokenRef ?? null,
              actor.accountId,
            ],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            websiteId,
            actor.accountId,
            'channel.created',
            row.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: row }),
          ],
        );
        return row;
      },
    );
  }

  async publications(context: CmsContext, websiteId: string) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    await this.website(this.pool, context.tenantId, websiteId);
    return (
      await this.pool.query(
        'SELECT p.id,p.website_id AS "websiteId",p.connection_id AS "connectionId",c.provider,c.display_name AS "displayName",p.target_kind AS "targetKind",p.target_id AS "targetId",p.revision_id AS "revisionId",p.state,p.scheduled_at AS "scheduledAt",p.attempt_count AS "attemptCount",p.external_id AS "externalId",p.last_error AS "lastError",p.created_at AS "createdAt",p.updated_at AS "updatedAt" FROM cms_publications p JOIN cms_channel_connections c ON c.tenant_id=p.tenant_id AND c.website_id=p.website_id AND c.id=p.connection_id WHERE p.tenant_id=$1 AND p.website_id=$2 ORDER BY p.created_at DESC',
        [context.tenantId, websiteId],
      )
    ).rows;
  }

  async queuePublication(context: CmsCommand, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new HttpError(400, 'CMS_INVALID_PUBLICATION');
    const value = input as Record<string, unknown>;
    const websiteId = cmsUuid(value.websiteId);
    const connectionId = cmsUuid(value.connectionId);
    const targetId = cmsUuid(value.targetId);
    const revisionId = cmsUuid(value.revisionId);
    const targetKind = value.targetKind;
    if (targetKind !== 'page' && targetKind !== 'content')
      throw new HttpError(400, 'CMS_INVALID_PUBLICATION');
    const requestedAt = value.scheduledAt;
    const scheduledAt =
      requestedAt === undefined || requestedAt === null ? null : new Date(String(requestedAt));
    if (scheduledAt && Number.isNaN(scheduledAt.getTime()))
      throw new HttpError(400, 'CMS_INVALID_SCHEDULE');
    return this.command(
      context,
      'cms.publication.queue',
      {
        websiteId,
        connectionId,
        targetId,
        revisionId,
        targetKind,
        scheduledAt: scheduledAt?.toISOString() ?? null,
      },
      'cms:publish',
      async (db, actor) => {
        const connection = (
          await db.query(
            'SELECT * FROM cms_channel_connections WHERE tenant_id=$1 AND website_id=$2 AND id=$3 FOR UPDATE',
            [context.tenantId, websiteId, connectionId],
          )
        ).rows[0];
        if (!connection) throw new HttpError(404, 'CMS_CHANNEL_NOT_FOUND');
        const capability = parseCapabilities(connection.provider, connection.capability);
        if (!capability.targetKinds.includes(targetKind))
          throw new HttpError(400, 'CMS_PROVIDER_TARGET_UNSUPPORTED');
        if (connection.status !== 'connected') throw new HttpError(409, 'CMS_CHANNEL_UNAVAILABLE');
        if (connection.provider !== 'website' && !connection.token_ref)
          throw new HttpError(409, 'CMS_TOKEN_REFERENCE_REQUIRED');
        const revisionTable =
          targetKind === 'page' ? 'cms_page_revisions' : 'cms_content_revisions';
        const revision = (
          await db.query(
            `SELECT id FROM ${revisionTable} WHERE tenant_id=$1 AND website_id=$2 AND id=$3 AND state='published'`,
            [context.tenantId, websiteId, revisionId],
          )
        ).rows[0];
        if (!revision || String(revision.id) !== revisionId)
          throw new HttpError(409, 'CMS_REVISION_NOT_PUBLISHED');
        const state = scheduledAt && scheduledAt.getTime() > Date.now() ? 'scheduled' : 'queued';
        const row = (
          await db.query(
            'INSERT INTO cms_publications(id,tenant_id,website_id,connection_id,target_kind,target_id,revision_id,state,scheduled_at,request_key,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,website_id AS "websiteId",connection_id AS "connectionId",target_kind AS "targetKind",target_id AS "targetId",revision_id AS "revisionId",state,scheduled_at AS "scheduledAt",attempt_count AS "attemptCount"',
            [
              randomUUID(),
              context.tenantId,
              websiteId,
              connectionId,
              targetKind,
              targetId,
              revisionId,
              state,
              scheduledAt,
              context.idempotencyKey,
              actor.accountId,
            ],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            websiteId,
            actor.accountId,
            'publication.queued',
            row.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: row }),
          ],
        );
        return row;
      },
    );
  }

  async retryPublication(context: CmsCommand, publicationId: string) {
    cmsUuid(publicationId);
    return this.command(
      context,
      'cms.publication.retry',
      { publicationId },
      'cms:publish',
      async (db, actor) => {
        const row = (
          await db.query('SELECT * FROM cms_publications WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
            context.tenantId,
            publicationId,
          ])
        ).rows[0];
        if (!row) throw new HttpError(404, 'CMS_PUBLICATION_NOT_FOUND');
        if (row.state !== 'failed') throw new HttpError(409, 'CMS_PUBLICATION_NOT_RETRYABLE');
        if (row.attempt_count >= 3) throw new HttpError(409, 'CMS_PUBLICATION_RETRY_LIMIT');
        const updated = (
          await db.query(
            'UPDATE cms_publications SET state=\'queued\',last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,state,attempt_count AS "attemptCount"',
            [context.tenantId, publicationId],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            row.website_id,
            actor.accountId,
            'publication.retried',
            publicationId,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ before: row.state, after: updated.state }),
          ],
        );
        return updated;
      },
    );
  }

  async menus(context: CmsContext, websiteId: string, code?: string, locale?: string) {
    const actor = await this.actor(context);
    requireCmsPermission(actor, context.tenantId, 'cms:read');
    await this.website(this.pool, context.tenantId, websiteId);
    const params: unknown[] = [context.tenantId, websiteId];
    const filters: string[] = [];
    if (code) {
      params.push(cmsCode(code));
      filters.push(`code=$${params.length}`);
    }
    if (locale) {
      params.push(cmsLocale(locale));
      filters.push(`locale=$${params.length}`);
    }
    return (
      await this.pool.query(
        `SELECT id,website_id AS "websiteId",code,name,locale,revision,draft,published,updated_at AS "updatedAt" FROM cms_menus WHERE tenant_id=$1 AND website_id=$2${filters.length ? ' AND ' + filters.join(' AND ') : ''} ORDER BY code,locale`,
        params,
      )
    ).rows;
  }

  async saveMenuDraft(
    context: CmsCommand,
    input: {
      websiteId: string;
      code: string;
      name: string;
      locale: string;
      items: unknown;
      expectedRevision?: number;
    },
  ) {
    const websiteId = cmsUuid(input.websiteId);
    const code = cmsCode(input.code);
    const locale = cmsLocale(input.locale);
    const items = parseCmsMenu(input.items);
    return this.command(
      context,
      'cms.menu.save_draft',
      { websiteId, code, locale, items, expectedRevision: input.expectedRevision ?? 0 },
      'cms:edit',
      async (db, actor) => {
        const website = await this.website(db, context.tenantId, websiteId);
        if (!website.locales.includes(locale)) throw new HttpError(400, 'CMS_LOCALE_NOT_ENABLED');
        const existing = (
          await db.query(
            'SELECT * FROM cms_menus WHERE tenant_id=$1 AND website_id=$2 AND code=$3 AND locale=$4 FOR UPDATE',
            [context.tenantId, websiteId, code, locale],
          )
        ).rows[0];
        if (existing && existing.revision !== (input.expectedRevision ?? 0))
          throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const row = existing
          ? (
              await db.query(
                'UPDATE cms_menus SET draft=$5,revision=revision+1,updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND website_id=$2 AND code=$3 AND locale=$4 RETURNING *',
                [context.tenantId, websiteId, code, locale, JSON.stringify(items), actor.accountId],
              )
            ).rows[0]
          : (
              await db.query(
                'INSERT INTO cms_menus(id,tenant_id,website_id,code,name,locale,draft,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
                [
                  randomUUID(),
                  context.tenantId,
                  websiteId,
                  code,
                  input.name.trim(),
                  locale,
                  JSON.stringify(items),
                  actor.accountId,
                ],
              )
            ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            websiteId,
            actor.accountId,
            'menu.draft_saved',
            row.id,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: row }),
          ],
        );
        return row;
      },
    );
  }

  async publishMenu(context: CmsCommand, menuId: string, expectedRevision: number) {
    cmsUuid(menuId);
    return this.command(
      context,
      'cms.menu.publish',
      { menuId, expectedRevision },
      'cms:publish',
      async (db, actor) => {
        const row = (
          await db.query('SELECT * FROM cms_menus WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
            context.tenantId,
            menuId,
          ])
        ).rows[0];
        if (!row) throw new HttpError(404, 'CMS_MENU_NOT_FOUND');
        if (row.revision !== expectedRevision) throw new HttpError(409, 'CMS_REVISION_CONFLICT');
        const updated = (
          await db.query(
            'UPDATE cms_menus SET published=draft,revision=revision+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
            [context.tenantId, menuId, actor.accountId],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            row.website_id,
            actor.accountId,
            'menu.published',
            menuId,
            context.reason.trim(),
            context.requestId,
            JSON.stringify({ after: updated }),
          ],
        );
        return updated;
      },
    );
  }
}
