import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoSource,
  sourceFromInput,
  videoEmbedUrl,
  publicVideoUrl,
} from '../src/lms/video-sources.js';
test('Versioned video sources accept known providers without accepting arbitrary iframe hosts', () => {
  assert.deepEqual(parseVideoSource({ kind: 'youtube', id: 'M7lc1UVf-VE' }, 1), {
    kind: 'youtube',
    id: 'M7lc1UVf-VE',
  });
  assert.throws(() => parseVideoSource({ kind: 'vimeo', id: '12345678' }, 1));
  assert.deepEqual(sourceFromInput('youtube', 'https://youtu.be/M7lc1UVf-VE'), {
    kind: 'youtube',
    id: 'M7lc1UVf-VE',
  });
  assert.deepEqual(sourceFromInput('vimeo', 'https://vimeo.com/12345678'), {
    kind: 'vimeo',
    id: '12345678',
  });
  const unlisted = sourceFromInput(
    'vimeo',
    'https://player.vimeo.com/video/76979871?h=8272103f6e',
  )!;
  assert.deepEqual(unlisted, { kind: 'vimeo', id: '76979871', hash: '8272103f6e' });
  assert.equal(videoEmbedUrl(unlisted), 'https://player.vimeo.com/video/76979871?h=8272103f6e');
  assert.throws(() => parseVideoSource({ kind: 'vimeo', id: '12345678', hash: '<script>' }, 2));
  assert.deepEqual(
    sourceFromInput('gdrive', 'https://drive.google.com/file/d/abc_DEF-123456/preview'),
    { kind: 'gdrive', id: 'abc_DEF-123456' },
  );
  assert.equal(
    videoEmbedUrl({ kind: 'gdrive', id: 'abc_DEF-123456' }),
    'https://drive.google.com/file/d/abc_DEF-123456/preview',
  );
  assert.throws(() =>
    sourceFromInput('youtube', 'https://youtube.com.evil.example/watch?v=M7lc1UVf-VE'),
  );
  assert.throws(() => sourceFromInput('gdrive', 'https://elsewhere.example/?id=abc_DEF-123456'));
  assert.equal(
    publicVideoUrl('https://media.example.com/training.mp4'),
    'https://media.example.com/training.mp4',
  );
  for (const url of [
    'javascript:alert(1)',
    'http://media.example.com/x.mp4',
    'https://127.0.0.1/x',
    'https://2130706433/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://office.internal/x',
    'https://name:password@media.example.com/x',
    'https://media.example.com:444/x',
  ])
    assert.equal(publicVideoUrl(url), null);
});
