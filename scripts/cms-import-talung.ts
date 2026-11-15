import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadLocalConfig } from '../src/config.js';
import { cmsDatabaseUrl, loadCmsConfig } from '../src/cms/database.js';
import { ids } from '../src/fixtures.js';

const sourceRoot = 'D:/thanhnx/OpenCode/quangminh-smart-border/quangminh-smart-border';
const websiteCode = 'talung-logistics';
const creator = ids.admin;
const tenant = ids.tenantA;
const locales = ['vi', 'en', 'zh'] as const;
type Locale = (typeof locales)[number];

const runtime = await loadLocalConfig();
const config = await loadCmsConfig(runtime.instanceId);
const pool = new pg.Pool({ connectionString: cmsDatabaseUrl(config, false, true), max: 1 });

function stableId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function pick(value: unknown, path: string) {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function text(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

const [aboutContent, messagesModule, servicesModule] = await Promise.all([
  readFile(sourceRoot + '/frontend/src/data/aboutContent.json', 'utf8').then(
    (value) => JSON.parse(value) as Record<string, Record<string, unknown>>,
  ),
  Promise.all(
    locales.map((locale) =>
      readFile(`${sourceRoot}/frontend/src/messages/${locale}.json`, 'utf8').then(
        (value) => [locale, JSON.parse(value)] as const,
      ),
    ),
  ).then((values) => Object.fromEntries(values) as Record<Locale, Record<string, unknown>>),
  import(pathToFileURL(sourceRoot + '/frontend/src/data/servicesB2BData.ts').href),
]);

const services = servicesModule.SERVICES_B2B_DATA as Record<string, Record<string, unknown>>;
const serviceTitles: Record<string, Record<Locale, string>> = {
  'dich-vu-dai-ly-hai-quan': {
    vi: 'Dịch vụ đại lý hải quan',
    en: 'Customs brokerage service',
    zh: '海关代理服务',
  },
  'kho-bai-ta-lung': { vi: 'Kho bãi Tà Lùng', en: 'Ta Lung warehousing', zh: '塔隆仓储服务' },
  'sang-tai-luu-do': {
    vi: 'Sang tải và lưu đỗ',
    en: 'Transloading and storage',
    zh: '过驳与堆存服务',
  },
  'van-tai': { vi: 'Vận tải xuyên biên giới', en: 'Cross-border transport', zh: '跨境运输服务' },
  'logistics-tron-goi': {
    vi: 'Logistics trọn gói',
    en: 'End-to-end logistics',
    zh: '综合物流服务',
  },
};

async function website() {
  const existing = (
    await pool.query('SELECT * FROM cms_websites WHERE tenant_id=$1 AND code=$2', [
      tenant,
      websiteCode,
    ])
  ).rows[0];
  if (existing) return existing;
  return (
    await pool.query(
      "INSERT INTO cms_websites(id,tenant_id,code,name,status,default_locale,locales,created_by) VALUES ($1,$2,$3,$4,'active','vi',$5,$6) RETURNING *",
      [
        stableId('website:' + websiteCode),
        tenant,
        websiteCode,
        'Tà Lùng Quang Minh Logistics',
        locales,
        creator,
      ],
    )
  ).rows[0];
}

async function contentType(
  siteId: string,
  code: string,
  name: string,
  schema: Record<string, unknown>,
) {
  const existing = (
    await pool.query(
      'SELECT * FROM cms_content_types WHERE tenant_id=$1 AND website_id=$2 AND code=$3',
      [tenant, siteId, code],
    )
  ).rows[0];
  if (existing) return existing;
  return (
    await pool.query(
      'INSERT INTO cms_content_types(id,tenant_id,website_id,code,name,schema,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [
        stableId(`content-type:${websiteCode}:${code}`),
        tenant,
        siteId,
        code,
        name,
        JSON.stringify(schema),
        creator,
      ],
    )
  ).rows[0];
}

async function importServiceEntries(siteId: string, typeId: string) {
  let imported = 0;
  for (const [code, source] of Object.entries(services)) {
    const entry =
      (
        await pool.query(
          'SELECT * FROM cms_content_entries WHERE tenant_id=$1 AND website_id=$2 AND content_type_id=$3 AND code=$4',
          [tenant, siteId, typeId, code],
        )
      ).rows[0] ??
      (
        await pool.query(
          'INSERT INTO cms_content_entries(id,tenant_id,website_id,content_type_id,code,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [stableId(`entry:${websiteCode}:service:${code}`), tenant, siteId, typeId, code, creator],
        )
      ).rows[0];
    for (const locale of locales) {
      const already = await pool.query(
        'SELECT 1 FROM cms_content_revisions WHERE tenant_id=$1 AND entry_id=$2 AND locale=$3 AND version=1',
        [tenant, entry.id, locale],
      );
      if (already.rowCount) continue;
      const title = serviceTitles[code]?.[locale] ?? code;
      const document = {
        slug: code,
        title,
        seo: {
          title,
          description: text((source.badge as Record<string, unknown> | undefined)?.[locale], title),
        },
        data: { ...source, locale },
      };
      const revisionId = stableId(`revision:${websiteCode}:service:${code}:${locale}:1`);
      await pool.query(
        "INSERT INTO cms_content_revisions(id,tenant_id,website_id,content_type_id,entry_id,version,locale,state,slug,title,data,seo,checksum,created_by,published_by,published_at) VALUES ($1,$2,$3,$4,$5,1,$6,'published',$7,$8,$9,$10,$11,$12,$13,now())",
        [
          revisionId,
          tenant,
          siteId,
          typeId,
          entry.id,
          locale,
          code,
          title,
          JSON.stringify(document.data),
          JSON.stringify(document.seo),
          createHash('sha256').update(JSON.stringify(document)).digest('hex'),
          creator,
          creator,
        ],
      );
      imported++;
    }
    await pool.query(
      "UPDATE cms_content_entries SET status='published',published_revision_id=(SELECT id FROM cms_content_revisions WHERE tenant_id=$1 AND entry_id=$2 AND locale='vi' AND version=1),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenant, entry.id],
    );
  }
  return imported;
}

async function importPages(siteId: string) {
  const pages = [
    { code: 'homepage', path: '/', title: ['Hero.title', 'Trang chủ'] },
    { code: 'about', path: '/about', title: ['AboutPage.heroTitle', 'Về chúng tôi'] },
    { code: 'services', path: '/services', title: ['Navigation.services', 'Dịch vụ'] },
    { code: 'news', path: '/news', title: ['Navigation.news', 'Tin tức'] },
    { code: 'careers', path: '/careers', title: ['Navigation.careers', 'Tuyển dụng'] },
    { code: 'contact', path: '/contact', title: ['Navigation.contact', 'Liên hệ'] },
    {
      code: 'infrastructure',
      path: '/infrastructure',
      title: ['Navigation.infrastructure', 'Năng lực hạ tầng'],
    },
    { code: 'manifesto', path: '/manifesto', title: ['Navigation.manifesto', 'Tuyên ngôn'] },
  ] as const;
  let imported = 0;
  for (const pageSpec of pages) {
    const page =
      (
        await pool.query(
          'SELECT * FROM cms_pages WHERE tenant_id=$1 AND website_id=$2 AND code=$3',
          [tenant, siteId, pageSpec.code],
        )
      ).rows[0] ??
      (
        await pool.query(
          "INSERT INTO cms_pages(id,tenant_id,website_id,code,path,kind,status,created_by) VALUES ($1,$2,$3,$4,$5,'landing','published',$6) RETURNING *",
          [
            stableId(`page:${websiteCode}:${pageSpec.code}`),
            tenant,
            siteId,
            pageSpec.code,
            pageSpec.path,
            creator,
          ],
        )
      ).rows[0];
    for (const locale of locales) {
      const already = await pool.query(
        'SELECT 1 FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 AND locale=$3 AND version=1',
        [tenant, page.id, locale],
      );
      if (already.rowCount) continue;
      const dictionary = messagesModule[locale];
      const title = text(pick(dictionary, pageSpec.title[0]), pageSpec.title[1]);
      const about = aboutContent[locale] ?? aboutContent.vi ?? {};
      const blocks =
        pageSpec.code === 'about'
          ? [
              {
                id: 'hero',
                type: 'hero',
                data: { title, subtitle: text(about.about_hero_subtitle, '') },
              },
              {
                id: 'story',
                type: 'rich-text',
                data: { content: text(about.about_story_content, '') },
              },
            ]
          : pageSpec.code === 'services'
            ? [
                { id: 'hero', type: 'hero', data: { title } },
                {
                  id: 'service-list',
                  type: 'collection',
                  data: { contentType: 'service', limit: 20 },
                },
              ]
            : [{ id: 'hero', type: 'hero', data: { title } }];
      const document = { title, seo: { title }, blocks };
      const revisionId = stableId(`page-revision:${websiteCode}:${pageSpec.code}:${locale}:1`);
      await pool.query(
        "INSERT INTO cms_page_revisions(id,tenant_id,website_id,page_id,version,locale,state,title,seo,blocks,checksum,created_by,published_by,published_at) VALUES ($1,$2,$3,$4,1,$5,'published',$6,$7,$8,$9,$10,$11,now())",
        [
          revisionId,
          tenant,
          siteId,
          page.id,
          locale,
          title,
          JSON.stringify(document.seo),
          JSON.stringify(document.blocks),
          createHash('sha256').update(JSON.stringify(document)).digest('hex'),
          creator,
          creator,
        ],
      );
      imported++;
    }
    await pool.query(
      "UPDATE cms_pages SET status='published',published_revision_id=(SELECT id FROM cms_page_revisions WHERE tenant_id=$1 AND page_id=$2 AND locale='vi' AND version=1),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenant, page.id],
    );
  }
  return imported;
}

async function importAssets(siteId: string) {
  const assets = [
    ['frontend/public/figma/home/hero.jpg', '/figma/home/hero.jpg', 'Homepage hero'],
    ['frontend/public/figma/services-hero.jpg', '/figma/services-hero.jpg', 'Services hero'],
    ['frontend/public/figma/news-hero.jpg', '/figma/news-hero.jpg', 'News hero'],
    ['frontend/public/figma/careers-hero.jpg', '/figma/careers-hero.jpg', 'Careers hero'],
  ];
  let imported = 0;
  for (const [key, url, name] of assets) {
    const result = await pool.query(
      "INSERT INTO cms_assets(id,tenant_id,website_id,storage_provider,storage_key,public_url,name,mime_type,byte_size,alt,metadata,created_by) VALUES ($1,$2,$3,'external',$4,$5,$6,'image/jpeg',0,$7,$8,$9) ON CONFLICT (tenant_id,website_id,storage_provider,storage_key) DO NOTHING",
      [
        stableId(`asset:${websiteCode}:${key}`),
        tenant,
        siteId,
        key,
        url,
        name,
        JSON.stringify({ vi: name }),
        JSON.stringify({ source: 'quangminh-smart-border' }),
        creator,
      ],
    );
    imported += result.rowCount ?? 0;
  }
  return imported;
}

try {
  const site = await website();
  const serviceType = await contentType(site.id, 'service', 'Dịch vụ logistics', {
    fields: {
      badge: 'localized',
      metrics: 'array',
      specs: 'array',
      workflow: 'array',
      faqs: 'array',
    },
  });
  const newsType = await contentType(site.id, 'news', 'Tin tức', {
    fields: { excerpt: 'localized', content: 'localized', coverImage: 'asset' },
  });
  const careerType = await contentType(site.id, 'career', 'Tuyển dụng', {
    fields: { location: 'localized', description: 'localized', requirements: 'localized' },
  });
  const servicesImported = await importServiceEntries(site.id, serviceType.id);
  const pagesImported = await importPages(site.id);
  const assetsImported = await importAssets(site.id);
  await pool.query(
    'INSERT INTO cms_audit(tenant_id,website_id,actor_account_id,action,target_id,reason,request_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      tenant,
      site.id,
      creator,
      'import.completed',
      site.id,
      'Nhập nội dung public từ website tham chiếu',
      randomUUID(),
      JSON.stringify({
        servicesImported,
        pagesImported,
        assetsImported,
        contentTypes: [serviceType.code, newsType.code, careerType.code],
      }),
    ],
  );
  console.log(
    `PASS: CMS import ${websiteCode} ready. Services ${servicesImported}, page revisions ${pagesImported}, assets ${assetsImported}.`,
  );
} finally {
  await pool.end();
}
