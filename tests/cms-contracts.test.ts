import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cmsDocumentChecksum,
  parseCmsAsset,
  parseCmsContentDocument,
  parseCmsContentType,
  parseCmsPageDocument,
  parseCmsWebsite,
} from '../src/cms/contracts.js';
import { cmsProvider, parseCapabilities, providerCapabilities } from '../src/cms/channels.js';

test('CMS website contract requires default locale to be enabled', () => {
  assert.deepEqual(
    parseCmsWebsite({
      code: 'talung-logistics',
      name: 'Tà Lùng Logistics',
      defaultLocale: 'vi',
      locales: ['vi', 'en', 'zh'],
    }),
    {
      code: 'talung-logistics',
      name: 'Tà Lùng Logistics',
      defaultLocale: 'vi',
      locales: ['vi', 'en', 'zh'],
    },
  );
  assert.throws(
    () =>
      parseCmsWebsite({
        code: 'talung-logistics',
        name: 'Tà Lùng Logistics',
        defaultLocale: 'zh',
        locales: ['vi', 'en'],
      }),
    { code: 'CMS_DEFAULT_LOCALE_REQUIRED' },
  );
});

test('CMS structured content and asset contracts preserve locale and provider boundaries', () => {
  assert.deepEqual(
    parseCmsContentType({ code: 'service', name: 'Dịch vụ', schema: { fields: {} } }),
    {
      code: 'service',
      name: 'Dịch vụ',
      schema: { fields: {} },
    },
  );
  const document = parseCmsContentDocument({
    slug: 'kho-bai-ta-lung',
    title: 'Kho bãi Tà Lùng',
    seo: { description: 'Dịch vụ kho bãi' },
    data: { badge: '32 ha', locale: 'vi' },
  });
  assert.equal(document.slug, 'kho-bai-ta-lung');
  assert.deepEqual(
    parseCmsAsset({
      websiteId: null,
      storageProvider: 'external',
      storageKey: 'frontend/public/hero.jpg',
      publicUrl: '/hero.jpg',
      name: 'Hero',
      mimeType: 'image/jpeg',
      byteSize: 0,
      alt: { vi: 'Ảnh hero' },
      metadata: { source: 'reference' },
    }).alt,
    { vi: 'Ảnh hero' },
  );
  assert.throws(
    () =>
      parseCmsAsset({
        storageProvider: 'unknown',
        storageKey: 'x',
        publicUrl: '/x',
        name: 'x',
        mimeType: 'image/jpeg',
        byteSize: 0,
      }),
    { code: 'CMS_INVALID_STORAGE_PROVIDER' },
  );
});

test('CMS channel contracts expose provider capabilities without accepting secrets', () => {
  assert.equal(cmsProvider('facebook'), 'facebook');
  assert.deepEqual(parseCapabilities('tiktok', undefined), providerCapabilities.tiktok);
  assert.throws(() => cmsProvider('secret-token'), { code: 'CMS_INVALID_PROVIDER' });
  assert.throws(
    () =>
      parseCapabilities('facebook', {
        formats: ['post'],
        targetKinds: ['unknown'],
        scheduling: true,
      }),
    { code: 'CMS_INVALID_CAPABILITY' },
  );
});

test('CMS page document accepts structured blocks and produces a stable checksum', () => {
  const document = parseCmsPageDocument({
    title: 'Trang chủ',
    seo: { title: 'Tà Lùng Logistics', description: 'Logistics biên mậu' },
    blocks: [
      { id: 'hero-main', type: 'hero', data: { headline: 'Kết nối biên giới' } },
      { id: 'services', type: 'collection', data: { collection: 'services', limit: 5 } },
    ],
  });
  assert.equal(document.blocks.length, 2);
  assert.match(cmsDocumentChecksum(document), /^[0-9a-f]{64}$/);
  assert.throws(
    () =>
      parseCmsPageDocument({
        title: 'Trang chủ',
        seo: {},
        blocks: [{ id: 'bad id', type: 'hero', data: {} }],
      }),
    { code: 'CMS_INVALID_BLOCK_ID' },
  );
});
