import assert from 'node:assert/strict';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { cmsDatabaseUrl, loadCmsConfig } from '../src/cms/database.js';

const runtime = await loadLocalConfig();
const config = await loadCmsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: cmsDatabaseUrl(config, false, true), max: 1 });
try {
  const marker = (await pool.query('SELECT instance_id,purpose FROM environment_marker')).rows[0];
  assert.equal(marker.instance_id, runtime.instanceId);
  assert.equal(marker.purpose, 'tlqm-aio-cms-local');
  const counts = (
    await pool.query(`SELECT
    (SELECT count(*)::integer FROM cms_websites) AS websites,
    (SELECT count(*)::integer FROM cms_pages) AS pages,
    (SELECT count(*)::integer FROM cms_page_revisions) AS page_revisions,
    (SELECT count(*)::integer FROM cms_content_types) AS content_types,
    (SELECT count(*)::integer FROM cms_content_entries) AS content_entries,
    (SELECT count(*)::integer FROM cms_content_revisions) AS content_revisions,
    (SELECT count(*)::integer FROM cms_assets) AS assets`)
  ).rows[0];
  assert.ok(counts.websites >= 1);
  assert.ok(counts.pages >= 1);
  assert.ok(counts.page_revisions >= 3);
  assert.ok(counts.content_types >= 3);
  assert.ok(counts.content_entries >= 1);
  assert.ok(counts.content_revisions >= 3);
  assert.ok(counts.assets >= 1);
  const constraints = (
    await pool.query(
      "SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='cms_content_revisions' AND constraint_type='UNIQUE' ORDER BY constraint_name",
    )
  ).rows.map((row) => row.constraint_name);
  const publicPage = (
    await pool.query(
      "SELECT p.code,r.locale,r.state FROM cms_pages p JOIN cms_page_revisions r ON r.tenant_id=p.tenant_id AND r.page_id=p.id WHERE p.code='homepage' AND r.locale=ANY($1::text[]) AND r.state='published' LIMIT 1",
      [['vi', 'en', 'zh']],
    )
  ).rows[0];
  assert.ok(publicPage);
  console.log('PASS: CMS local marker and imported website/content/media counts are valid.');
  console.log(JSON.stringify({ ...counts, constraints }));
} finally {
  await pool.end();
}
