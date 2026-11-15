import { HttpError } from '../security.js';

export const cmsProviders = ['website', 'facebook', 'tiktok', 'zalo-oa'] as const;
export type CmsProvider = (typeof cmsProviders)[number];

export type CmsCapability = {
  targetKinds: ('page' | 'content')[];
  formats: string[];
  scheduling: boolean;
};

export const providerCapabilities: Record<CmsProvider, CmsCapability> = {
  website: { targetKinds: ['page', 'content'], formats: ['html', 'json'], scheduling: true },
  facebook: {
    targetKinds: ['page', 'content'],
    formats: ['post', 'photo', 'reel'],
    scheduling: true,
  },
  tiktok: { targetKinds: ['content'], formats: ['video'], scheduling: true },
  'zalo-oa': { targetKinds: ['content'], formats: ['article', 'photo', 'video'], scheduling: true },
};

export function cmsProvider(value: unknown): CmsProvider {
  if (typeof value !== 'string' || !cmsProviders.includes(value as CmsProvider))
    throw new HttpError(400, 'CMS_INVALID_PROVIDER');
  return value as CmsProvider;
}

export function parseCapabilities(provider: CmsProvider, value: unknown) {
  if (value === undefined) return providerCapabilities[provider];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'CMS_INVALID_CAPABILITY');
  const input = value as Record<string, unknown>;
  const formats = input.formats;
  if (
    !Array.isArray(formats) ||
    formats.some((item) => typeof item !== 'string' || item.length > 40)
  )
    throw new HttpError(400, 'CMS_INVALID_CAPABILITY');
  const targetKinds = input.targetKinds;
  if (
    !Array.isArray(targetKinds) ||
    targetKinds.some((item) => item !== 'page' && item !== 'content')
  )
    throw new HttpError(400, 'CMS_INVALID_CAPABILITY');
  if (typeof input.scheduling !== 'boolean') throw new HttpError(400, 'CMS_INVALID_CAPABILITY');
  return {
    targetKinds: targetKinds as ('page' | 'content')[],
    formats: formats as string[],
    scheduling: input.scheduling,
  };
}
