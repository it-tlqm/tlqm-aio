export type VideoSource =
  | { kind: 'file' | 'youtube' | 'gdrive'; id: string }
  | { kind: 'vimeo'; id: string; hash?: string }
  | { kind: 'direct'; url: string };
export function publicVideoUrl(value: string): string | null {
  try {
    const url = new URL(value),
      host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.port ||
      !host.includes('.') ||
      host.startsWith('[') ||
      /^\d+(\.\d+){3}$/.test(host) ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
      value.length > 2000
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function parseVideoSource(value: unknown, version: number): VideoSource | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VIDEO_INVALID');
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'direct' && version >= 2 && typeof raw.url === 'string') {
    const url = publicVideoUrl(raw.url);
    if (url) return { kind: 'direct', url };
  }
  if (typeof raw.id === 'string') {
    if (raw.kind === 'file' && /^[0-9a-f-]{36}$/.test(raw.id)) return { kind: 'file', id: raw.id };
    if (raw.kind === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(raw.id))
      return { kind: 'youtube', id: raw.id };
    if (version >= 2 && raw.kind === 'vimeo' && /^\d{5,15}$/.test(raw.id)) {
      if (
        raw.hash !== undefined &&
        (typeof raw.hash !== 'string' || !/^[A-Za-z0-9]{6,64}$/.test(raw.hash))
      )
        throw new Error('VIDEO_INVALID');
      return {
        kind: 'vimeo',
        id: raw.id,
        ...(typeof raw.hash === 'string' ? { hash: raw.hash } : {}),
      };
    }
    if (version >= 2 && raw.kind === 'gdrive' && /^[A-Za-z0-9_-]{10,150}$/.test(raw.id))
      return { kind: 'gdrive', id: raw.id };
  }
  throw new Error('VIDEO_INVALID');
}
/** Only fixed known embed hosts are constructed; arbitrary iframe URLs are never accepted. */
export function videoEmbedUrl(source: VideoSource): string | null {
  if (source.kind === 'youtube') return 'https://www.youtube-nocookie.com/embed/' + source.id;
  if (source.kind === 'vimeo')
    return (
      'https://player.vimeo.com/video/' +
      source.id +
      (source.hash ? '?h=' + encodeURIComponent(source.hash) : '')
    );
  if (source.kind === 'gdrive') return 'https://drive.google.com/file/d/' + source.id + '/preview';
  return null;
}
export function sourceFromInput(kind: VideoSource['kind'], value: string): VideoSource | null {
  const text = value.trim();
  if (!text) return null;
  if (kind === 'direct') return parseVideoSource({ kind, url: text }, 2);
  let id = text;
  if (/^https?:\/\//.test(text)) {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('VIDEO_INVALID');
    if (
      kind === 'youtube' &&
      ['youtube.com', 'www.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(
        url.hostname,
      )
    )
      id =
        url.hostname === 'youtu.be'
          ? url.pathname.slice(1)
          : (url.searchParams.get('v') ?? url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    else if (
      kind === 'vimeo' &&
      ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(url.hostname)
    ) {
      const parts = url.pathname.match(/\/(\d{5,15})(?:\/([A-Za-z0-9]{6,64}))?\/?$/);
      id = parts?.[1] ?? '';
      const hash = url.searchParams.get('h') ?? parts?.[2];
      return parseVideoSource({ kind, id, ...(hash ? { hash } : {}) }, 2);
    } else if (kind === 'gdrive' && url.hostname === 'drive.google.com')
      id =
        url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? url.searchParams.get('id') ?? '';
    else throw new Error('VIDEO_INVALID');
  }
  return parseVideoSource({ kind, id }, 2);
}
