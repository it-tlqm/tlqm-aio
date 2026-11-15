import { cmsProvider, type CmsProvider } from './channels.js';
import type { PublicationAdapter, PublicationJob } from './publication-worker.js';

/** Provider credentials are resolved by reference and never persisted in CMS. */
export type CmsSecretResolver = {
  resolve: (reference: string) => Promise<string | undefined>;
};

export class MapCmsSecretResolver implements CmsSecretResolver {
  constructor(private readonly values: ReadonlyMap<string, string>) {}

  async resolve(reference: string) {
    return this.values.get(reference);
  }
}

/** Local-only resolver for CMS_CONNECTOR_SECRET_<REFERENCE> environment entries. */
export class EnvironmentCmsSecretResolver implements CmsSecretResolver {
  async resolve(reference: string) {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(reference)) return undefined;
    const key = 'CMS_CONNECTOR_SECRET_' + reference.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    const value = process.env[key];
    return value && value.length > 0 ? value : undefined;
  }
}

export type CmsConnectorRequest = {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type CmsConnectorResponse = {
  status: number;
  headers: Headers | Record<string, string | undefined>;
  body: unknown;
};

export type CmsConnectorTransport = (request: CmsConnectorRequest) => Promise<CmsConnectorResponse>;

export type CmsPublicationPayload = {
  title: string;
  body?: string;
  summary?: string;
  url?: string;
  mediaUrl?: string;
  mimeType?: string;
  locale?: string;
};

export class CmsConnectorError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'CmsConnectorError';
  }
}

function headerValue(headers: CmsConnectorResponse['headers'], name: string) {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((value) => value.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function retryAfter(headers: CmsConnectorResponse['headers']) {
  const value = headerValue(headers, 'retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(86400, Math.ceil((date - Date.now()) / 1000)));
}

function bodyRecord(body: unknown) {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export function mapCmsConnectorError(
  provider: CmsProvider,
  response: CmsConnectorResponse,
): CmsConnectorError {
  const retryable = response.status === 429 || response.status >= 500;
  const record = bodyRecord(response.body);
  if (response.status === 401 || response.status === 403)
    return new CmsConnectorError(
      'CMS_' + provider.toUpperCase() + '_AUTH_FAILED',
      false,
      response.status,
    );
  if (response.status === 429)
    return new CmsConnectorError(
      'CMS_' + provider.toUpperCase() + '_RATE_LIMITED',
      true,
      response.status,
      retryAfter(response.headers),
    );
  const providerCode = typeof record.code === 'string' ? record.code : undefined;
  return new CmsConnectorError(
    retryable
      ? 'CMS_' + provider.toUpperCase() + '_TEMPORARY_ERROR'
      : 'CMS_' +
          provider.toUpperCase() +
          '_REJECTED' +
          (providerCode ? '_' + providerCode.slice(0, 40) : ''),
    retryable,
    response.status,
    retryAfter(response.headers),
  );
}

async function fetchTransport(request: CmsConnectorRequest): Promise<CmsConnectorResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json')
    ? await response.json().catch(() => ({}))
    : await response.text();
  return { status: response.status, headers: response.headers, body };
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function externalId(body: unknown) {
  const root = bodyRecord(body);
  const data = bodyRecord(root.data);
  for (const value of [
    root.id,
    root.post_id,
    root.publish_id,
    root.article_id,
    data.id,
    data.post_id,
    data.publish_id,
    data.article_id,
  ]) {
    const result = stringValue(value);
    if (result) return result;
  }
  throw new CmsConnectorError('CMS_PROVIDER_RESPONSE_MISSING_ID', false);
}

async function requireToken(job: PublicationJob, resolver: CmsSecretResolver) {
  if (!job.tokenRef) throw new CmsConnectorError('CMS_CONNECTOR_TOKEN_REFERENCE_REQUIRED', false);
  const token = await resolver.resolve(job.tokenRef);
  if (!token) throw new CmsConnectorError('CMS_CONNECTOR_SECRET_UNAVAILABLE', false);
  return token;
}

function requirePayload(job: PublicationJob): CmsPublicationPayload {
  if (!job.payload?.title) throw new CmsConnectorError('CMS_PUBLICATION_PAYLOAD_REQUIRED', false);
  return job.payload;
}

function commonHeaders(token: string) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: 'Bearer ' + token,
  };
}

async function publishRequest(
  provider: CmsProvider,
  transport: CmsConnectorTransport,
  request: CmsConnectorRequest,
) {
  let response: CmsConnectorResponse;
  try {
    response = await transport(request);
  } catch {
    throw new CmsConnectorError('CMS_' + provider.toUpperCase() + '_NETWORK_ERROR', true);
  }
  if (response.status < 200 || response.status >= 300)
    throw mapCmsConnectorError(provider, response);
  return externalId(response.body);
}

function facebookAdapter(
  resolver: CmsSecretResolver,
  transport: CmsConnectorTransport,
  graphVersion: string,
): PublicationAdapter {
  return {
    async publish(job) {
      const token = await requireToken(job, resolver);
      const payload = requirePayload(job);
      const body: Record<string, unknown> = {
        message: [payload.title, payload.body].filter(Boolean).join('\n\n'),
      };
      if (payload.url) body.link = payload.url;
      if (payload.mediaUrl) body.url = payload.mediaUrl;
      return {
        externalId: await publishRequest('facebook', transport, {
          method: 'POST',
          url: `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(job.externalAccountId)}/feed`,
          headers: commonHeaders(token),
          body,
        }),
      };
    },
  };
}

function tiktokAdapter(
  resolver: CmsSecretResolver,
  transport: CmsConnectorTransport,
): PublicationAdapter {
  return {
    async publish(job) {
      const token = await requireToken(job, resolver);
      const payload = requirePayload(job);
      if (!payload.mediaUrl || !payload.mimeType?.startsWith('video/'))
        throw new CmsConnectorError('CMS_TIKTOK_VIDEO_REQUIRED', false);
      return {
        externalId: await publishRequest('tiktok', transport, {
          method: 'POST',
          url: 'https://open.tiktokapis.com/v2/post/publish/video/init/',
          headers: commonHeaders(token),
          body: {
            post_info: {
              title: payload.title,
              description: payload.body ?? payload.summary ?? '',
              privacy_level: 'PUBLIC_TO_EVERYONE',
              disable_duet: false,
              disable_comment: false,
              disable_stitch: false,
            },
            source_info: { source: 'PULL_FROM_URL', video_url: payload.mediaUrl },
          },
        }),
      };
    },
  };
}

function zaloAdapter(
  resolver: CmsSecretResolver,
  transport: CmsConnectorTransport,
  endpoint: string,
): PublicationAdapter {
  return {
    async publish(job) {
      const token = await requireToken(job, resolver);
      const payload = requirePayload(job);
      return {
        externalId: await publishRequest('zalo-oa', transport, {
          method: 'POST',
          url: endpoint,
          headers: commonHeaders(token),
          body: {
            type: 'normal',
            title: payload.title,
            description: payload.summary ?? payload.body ?? '',
            body: payload.body ?? payload.summary ?? '',
            thumb: payload.mediaUrl,
            link: payload.url,
          },
        }),
      };
    },
  };
}

export type RuntimeConnectorOptions = {
  secretResolver: CmsSecretResolver;
  transport?: CmsConnectorTransport;
  facebookGraphVersion?: string;
  zaloArticleEndpoint?: string;
};

export function createRuntimePublicationAdapters(
  options: RuntimeConnectorOptions,
): Record<CmsProvider, PublicationAdapter> {
  const transport = options.transport ?? fetchTransport;
  return {
    website: {
      async publish(job) {
        return {
          externalId: `website:${job.externalAccountId}:${job.targetKind}:${job.targetId}:${job.revisionId}`,
        };
      },
    },
    facebook: facebookAdapter(
      options.secretResolver,
      transport,
      options.facebookGraphVersion ?? 'v20.0',
    ),
    tiktok: tiktokAdapter(options.secretResolver, transport),
    'zalo-oa': zaloAdapter(
      options.secretResolver,
      transport,
      options.zaloArticleEndpoint ?? 'https://openapi.zalo.me/v2.0/oa/article/create',
    ),
  };
}

export function validateRuntimeProvider(value: unknown) {
  return cmsProvider(value);
}
