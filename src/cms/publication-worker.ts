import type { Pool } from 'pg';
import type { CmsPublicationPayload } from './connectors.js';

export type PublicationJob = {
  id: string;
  provider: 'website' | 'facebook' | 'tiktok' | 'zalo-oa';
  externalAccountId: string;
  targetKind: 'page' | 'content';
  targetId: string;
  revisionId: string;
  attemptCount: number;
  tokenRef: string | null;
  payload?: CmsPublicationPayload;
};

export type PublicationAdapter = {
  publish: (job: PublicationJob) => Promise<{ externalId: string }>;
};

/** Local adapter records deterministic receipts for all supported channels. */
export const localPublicationAdapters: Record<PublicationJob['provider'], PublicationAdapter> = {
  website: {
    async publish(job) {
      return {
        externalId: `website:${job.externalAccountId}:${job.targetKind}:${job.targetId}:${job.revisionId}`,
      };
    },
  },
  facebook: {
    async publish(job) {
      return { externalId: `facebook:${job.externalAccountId}:${job.revisionId}` };
    },
  },
  tiktok: {
    async publish(job) {
      return { externalId: `tiktok:${job.externalAccountId}:${job.revisionId}` };
    },
  },
  'zalo-oa': {
    async publish(job) {
      return { externalId: `zalo-oa:${job.externalAccountId}:${job.revisionId}` };
    },
  },
};

export class CmsPublicationWorker {
  constructor(
    private readonly pool: Pool,
    private readonly adapters: Record<
      PublicationJob['provider'],
      PublicationAdapter
    > = localPublicationAdapters,
  ) {}

  async runOnce() {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const job = (
        await db.query<PublicationJob>(
          'SELECT p.id,c.provider,c.external_account_id AS "externalAccountId",p.target_kind AS "targetKind",p.target_id AS "targetId",p.revision_id AS "revisionId",p.attempt_count AS "attemptCount" FROM cms_publications p JOIN cms_channel_connections c ON c.tenant_id=p.tenant_id AND c.website_id=p.website_id AND c.id=p.connection_id WHERE p.state IN (\'queued\',\'scheduled\') AND (p.scheduled_at IS NULL OR p.scheduled_at<=now()) ORDER BY p.created_at FOR UPDATE OF p SKIP LOCKED LIMIT 1',
        )
      ).rows[0];
      if (!job) {
        await db.query('COMMIT');
        return { processed: false };
      }
      const connection = (
        await db.query(
          'SELECT c.token_ref AS "tokenRef" FROM cms_publications p JOIN cms_channel_connections c ON c.tenant_id=p.tenant_id AND c.website_id=p.website_id AND c.id=p.connection_id WHERE p.id=$1',
          [job.id],
        )
      ).rows[0];
      job.tokenRef = connection?.tokenRef ?? null;
      const revision = (
        await db.query(
          job.targetKind === 'page'
            ? "SELECT title,seo,blocks FROM cms_page_revisions WHERE id=$1 AND state='published'"
            : "SELECT title,seo,data,slug FROM cms_content_revisions WHERE id=$1 AND state='published'",
          [job.revisionId],
        )
      ).rows[0];
      if (revision) {
        const seo =
          revision.seo && typeof revision.seo === 'object' && !Array.isArray(revision.seo)
            ? (revision.seo as Record<string, unknown>)
            : {};
        const summary = typeof seo.description === 'string' ? seo.description : undefined;
        const url = typeof seo.canonical === 'string' ? seo.canonical : undefined;
        job.payload = {
          title: revision.title,
          body: JSON.stringify(job.targetKind === 'page' ? revision.blocks : revision.data),
          ...(summary ? { summary } : {}),
          ...(url ? { url } : {}),
        };
      }
      await db.query(
        "UPDATE cms_publications SET state='publishing',attempt_count=attempt_count+1,updated_at=now() WHERE id=$1",
        [job.id],
      );
      await db.query('COMMIT');
      const adapter = this.adapters[job.provider];
      try {
        const result = await adapter.publish(job);
        await this.pool.query(
          "UPDATE cms_publications SET state='published',external_id=$2,last_error=NULL,updated_at=now() WHERE id=$1",
          [job.id, result.externalId],
        );
        return { processed: true, id: job.id, state: 'published', externalId: result.externalId };
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : 'CMS_PROVIDER_ERROR';
        await this.pool.query(
          "UPDATE cms_publications SET state='failed',last_error=$2,updated_at=now() WHERE id=$1",
          [job.id, message],
        );
        return { processed: true, id: job.id, state: 'failed', error: message };
      }
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
}
