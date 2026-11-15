import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CmsConnectorError,
  MapCmsSecretResolver,
  createRuntimePublicationAdapters,
  mapCmsConnectorError,
} from '../src/cms/connectors.js';
import type { CmsConnectorRequest } from '../src/cms/connectors.js';

const job = {
  id: 'publication-1',
  provider: 'facebook' as const,
  externalAccountId: 'page-1',
  targetKind: 'content' as const,
  targetId: 'entry-1',
  revisionId: 'revision-1',
  attemptCount: 0,
  tokenRef: 'facebook-page',
  payload: {
    title: 'Bài viết mới',
    body: 'Nội dung đã xuất bản',
    url: 'https://example.test/bai-viet',
  },
};

test('CMS runtime connector resolves a reference and converts Facebook payload', async () => {
  const requests: CmsConnectorRequest[] = [];
  const adapters = createRuntimePublicationAdapters({
    secretResolver: new MapCmsSecretResolver(new Map([['facebook-page', 'opaque-token']])),
    transport: async (request) => {
      requests.push(request);
      return { status: 200, headers: {}, body: { id: 'remote-post-1' } };
    },
  });
  const result = await adapters.facebook.publish(job);
  assert.deepEqual(result, { externalId: 'remote-post-1' });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.match(request.url, /graph\.facebook\.com\/v20\.0\/page-1\/feed$/);
  assert.equal(request.headers.authorization, 'Bearer opaque-token');
  assert.deepEqual(request.body, {
    message: 'Bài viết mới\n\nNội dung đã xuất bản',
    link: 'https://example.test/bai-viet',
  });
});

test('CMS runtime connector rejects TikTok jobs without a video asset', async () => {
  const adapters = createRuntimePublicationAdapters({
    secretResolver: new MapCmsSecretResolver(new Map([['facebook-page', 'opaque-token']])),
    transport: async () => ({ status: 200, headers: {}, body: { data: { publish_id: 'x' } } }),
  });
  await assert.rejects(
    () =>
      adapters.tiktok.publish({
        ...job,
        provider: 'tiktok',
        tokenRef: 'facebook-page',
      }),
    (error: unknown) =>
      error instanceof CmsConnectorError && error.code === 'CMS_TIKTOK_VIDEO_REQUIRED',
  );
});

test('CMS connector maps provider throttling without exposing response text', () => {
  const error = mapCmsConnectorError('zalo-oa', {
    status: 429,
    headers: { 'retry-after': '17' },
    body: { message: 'private provider response', token: 'must-not-be-copied' },
  });
  assert.equal(error.code, 'CMS_ZALO-OA_RATE_LIMITED');
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSeconds, 17);
  assert.equal(error.message, 'CMS_ZALO-OA_RATE_LIMITED');
  assert.doesNotMatch(error.message, /private|token|must-not/);
});
