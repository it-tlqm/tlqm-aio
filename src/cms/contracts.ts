import { createHash } from 'node:crypto';
import { HttpError } from '../security.js';
import { cmsUuid } from './access.js';

export const cmsPageKinds = ['landing', 'collection', 'system'] as const;
export type CmsPageKind = (typeof cmsPageKinds)[number];
export const cmsPageStates = ['draft', 'published', 'archived'] as const;
export type CmsPageState = (typeof cmsPageStates)[number];

export type CmsSeo = {
  title?: string;
  description?: string;
  canonical?: string;
  ogImage?: string;
};

export type CmsBlock = {
  id: string;
  type: string;
  data: Record<string, unknown>;
};

export type CmsPageDocument = {
  title: string;
  seo: CmsSeo;
  blocks: CmsBlock[];
};

export type CmsContentDocument = {
  title: string;
  slug: string;
  seo: CmsSeo;
  data: Record<string, unknown>;
};

export type CmsAssetInput = {
  websiteId: string | null;
  storageProvider: 'local' | 's3' | 'cloudinary' | 'external';
  storageKey: string;
  publicUrl: string;
  name: string;
  mimeType: string;
  byteSize: number;
  checksum?: string;
  alt: Record<string, string>;
  metadata: Record<string, unknown>;
};

export type CmsMenuItem = {
  id: string;
  label: string;
  path?: string;
  externalUrl?: string;
  children: CmsMenuItem[];
};

const localePattern = /^[a-z]{2,8}(?:-[A-Z]{2})?$/;
const codePattern = /^[a-z][a-z0-9-]{2,50}$/;
const pathPattern = /^\/[A-Za-z0-9/_-]{0,239}$/;
const blockIdPattern = /^[a-z][a-z0-9_-]{1,63}$/;
const slugPattern = /^[a-z0-9][a-z0-9/_-]{0,200}$/;

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, code);
  return value as Record<string, unknown>;
}

function text(value: unknown, min: number, max: number, code: string) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw new HttpError(400, code);
  return value.trim();
}

export function cmsLocale(value: unknown) {
  if (typeof value !== 'string' || !localePattern.test(value))
    throw new HttpError(400, 'CMS_INVALID_LOCALE');
  return value;
}

export function cmsCode(value: unknown) {
  if (typeof value !== 'string' || !codePattern.test(value))
    throw new HttpError(400, 'CMS_INVALID_CODE');
  return value;
}

export function cmsPath(value: unknown) {
  if (typeof value !== 'string' || !pathPattern.test(value))
    throw new HttpError(400, 'CMS_INVALID_PATH');
  return value === '' ? '/' : value;
}

export function parseCmsWebsite(input: unknown) {
  const value = record(input, 'CMS_INVALID_WEBSITE');
  const locales = value.locales;
  if (
    !Array.isArray(locales) ||
    locales.length < 1 ||
    locales.length > 12 ||
    new Set(locales).size !== locales.length
  )
    throw new HttpError(400, 'CMS_INVALID_LOCALES');
  const parsedLocales = locales.map(cmsLocale);
  const defaultLocale = cmsLocale(value.defaultLocale);
  if (!parsedLocales.includes(defaultLocale))
    throw new HttpError(400, 'CMS_DEFAULT_LOCALE_REQUIRED');
  return {
    code: cmsCode(value.code),
    name: text(value.name, 1, 160, 'CMS_INVALID_WEBSITE_NAME'),
    defaultLocale,
    locales: parsedLocales,
  };
}

export function parseCmsPageDocument(input: unknown): CmsPageDocument {
  const value = record(input, 'CMS_INVALID_PAGE_DOCUMENT');
  const seoValue = value.seo === undefined ? {} : record(value.seo, 'CMS_INVALID_SEO');
  const blocksValue = value.blocks;
  if (!Array.isArray(blocksValue) || blocksValue.length > 100)
    throw new HttpError(400, 'CMS_INVALID_BLOCKS');
  const blocks = blocksValue.map((item) => {
    const block = record(item, 'CMS_INVALID_BLOCK');
    const data = record(block.data, 'CMS_INVALID_BLOCK_DATA');
    const id = text(block.id, 2, 64, 'CMS_INVALID_BLOCK_ID');
    if (!blockIdPattern.test(id)) throw new HttpError(400, 'CMS_INVALID_BLOCK_ID');
    return { id, type: text(block.type, 1, 64, 'CMS_INVALID_BLOCK_TYPE'), data };
  });
  const seo: CmsSeo = {};
  for (const key of ['title', 'description', 'canonical', 'ogImage'] as const) {
    if (seoValue[key] !== undefined) seo[key] = text(seoValue[key], 1, 500, 'CMS_INVALID_SEO');
  }
  return {
    title: text(value.title, 1, 240, 'CMS_INVALID_PAGE_TITLE'),
    seo,
    blocks,
  };
}

export function parseCmsContentType(input: unknown) {
  const value = record(input, 'CMS_INVALID_CONTENT_TYPE');
  return {
    code: cmsCode(value.code),
    name: text(value.name, 1, 160, 'CMS_INVALID_CONTENT_TYPE_NAME'),
    schema: record(value.schema ?? {}, 'CMS_INVALID_CONTENT_SCHEMA'),
  };
}

export function parseCmsContentDocument(input: unknown): CmsContentDocument {
  const value = record(input, 'CMS_INVALID_CONTENT_DOCUMENT');
  if (typeof value.slug !== 'string' || !slugPattern.test(value.slug))
    throw new HttpError(400, 'CMS_INVALID_SLUG');
  const seoValue = value.seo === undefined ? {} : record(value.seo, 'CMS_INVALID_SEO');
  const data = record(value.data, 'CMS_INVALID_CONTENT_DATA');
  const seo: CmsSeo = {};
  for (const key of ['title', 'description', 'canonical', 'ogImage'] as const) {
    if (seoValue[key] !== undefined) seo[key] = text(seoValue[key], 1, 500, 'CMS_INVALID_SEO');
  }
  return {
    title: text(value.title, 1, 240, 'CMS_INVALID_CONTENT_TITLE'),
    slug: value.slug,
    seo,
    data,
  };
}

export function parseCmsAsset(input: unknown): CmsAssetInput {
  const value = record(input, 'CMS_INVALID_ASSET');
  const providers = ['local', 's3', 'cloudinary', 'external'] as const;
  if (
    typeof value.storageProvider !== 'string' ||
    !providers.includes(value.storageProvider as (typeof providers)[number])
  )
    throw new HttpError(400, 'CMS_INVALID_STORAGE_PROVIDER');
  if (value.websiteId !== null && value.websiteId !== undefined) cmsUuid(value.websiteId);
  if (!Number.isInteger(value.byteSize) || Number(value.byteSize) < 0)
    throw new HttpError(400, 'CMS_INVALID_ASSET_SIZE');
  const altValue = record(value.alt ?? {}, 'CMS_INVALID_ASSET_ALT');
  const alt = Object.fromEntries(
    Object.entries(altValue).map(([locale, textValue]) => [
      cmsLocale(locale),
      text(textValue, 1, 500, 'CMS_INVALID_ASSET_ALT'),
    ]),
  );
  const checksumValue = value.checksum;
  if (
    checksumValue !== undefined &&
    (typeof checksumValue !== 'string' || !/^[0-9a-f]{64}$/.test(checksumValue))
  )
    throw new HttpError(400, 'CMS_INVALID_ASSET_CHECKSUM');
  return {
    websiteId: value.websiteId === undefined ? null : (value.websiteId as string | null),
    storageProvider: value.storageProvider as CmsAssetInput['storageProvider'],
    storageKey: text(value.storageKey, 1, 500, 'CMS_INVALID_ASSET_KEY'),
    publicUrl: text(value.publicUrl, 1, 2000, 'CMS_INVALID_ASSET_URL'),
    name: text(value.name, 1, 240, 'CMS_INVALID_ASSET_NAME'),
    mimeType: text(value.mimeType, 1, 120, 'CMS_INVALID_ASSET_MIME'),
    byteSize: Number(value.byteSize),
    ...(checksumValue !== undefined ? { checksum: checksumValue } : {}),
    alt,
    metadata: record(value.metadata ?? {}, 'CMS_INVALID_ASSET_METADATA'),
  };
}

export function parseCmsMenu(input: unknown, depth = 0): CmsMenuItem[] {
  if (!Array.isArray(input) || input.length > 100 || depth > 4)
    throw new HttpError(400, 'CMS_INVALID_MENU');
  return input.map((item) => {
    const value = record(item, 'CMS_INVALID_MENU_ITEM');
    const path = value.path;
    const externalUrl = value.externalUrl;
    if (
      path !== undefined &&
      (typeof path !== 'string' || !path.startsWith('/') || path.length > 240)
    )
      throw new HttpError(400, 'CMS_INVALID_MENU_ITEM');
    if (
      externalUrl !== undefined &&
      (typeof externalUrl !== 'string' ||
        !/^https?:\/\//i.test(externalUrl) ||
        externalUrl.length > 2000)
    )
      throw new HttpError(400, 'CMS_INVALID_MENU_ITEM');
    const children = parseCmsMenu(value.children ?? [], depth + 1);
    if (!path && !externalUrl && children.length === 0)
      throw new HttpError(400, 'CMS_INVALID_MENU_TARGET');
    return {
      id: text(value.id, 1, 64, 'CMS_INVALID_MENU_ITEM'),
      label: text(value.label, 1, 160, 'CMS_INVALID_MENU_ITEM'),
      ...(path !== undefined ? { path } : {}),
      ...(externalUrl !== undefined ? { externalUrl } : {}),
      children,
    };
  });
}

export function cmsDocumentChecksum(document: CmsPageDocument) {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}
