import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { VideoSource } from '../../../src/lms/video-sources';
import { videoEmbedUrl } from '../../../src/lms/video-sources';
export type VideoControl = { play: () => void; pause: () => void; seek: (seconds: number) => void };
type Props = {
  source: VideoSource;
  versionId: string;
  title: string;
  start: number;
  maximum: number;
  paused: boolean;
  onTime: (seconds: number) => void;
  onEnded: () => void;
  onPause?: () => void;
  onReady?: () => void;
  onError: (message: string) => void;
};
type YtPlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, ahead: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  getIframe: () => HTMLIFrameElement;
  destroy: () => void;
};
type VimeoPlayer = {
  play: () => Promise<void>;
  pause: () => Promise<void>;
  setCurrentTime: (seconds: number) => Promise<number>;
  ready: () => Promise<void>;
  on: (name: string, callback: (event: unknown) => void) => void;
  destroy: () => Promise<void>;
};
type ProviderWindow = Window & {
  YT?: { Player: new (element: HTMLElement, options: Record<string, unknown>) => YtPlayer };
  Vimeo?: { Player: new (element: HTMLIFrameElement) => VimeoPlayer };
  onYouTubeIframeAPIReady?: () => void;
};
let youtubeLoad: Promise<void> | undefined, vimeoLoad: Promise<void> | undefined;
function playbackSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function vimeoSeconds(event: unknown) {
  if (event && typeof event === 'object' && 'seconds' in event && playbackSeconds(event.seconds))
    return event.seconds;
}
function sdk(kind: 'youtube' | 'vimeo') {
  const state = window as ProviderWindow;
  if ((kind === 'youtube' && state.YT?.Player) || (kind === 'vimeo' && state.Vimeo?.Player))
    return Promise.resolve();
  const existing = kind === 'youtube' ? youtubeLoad : vimeoLoad;
  if (existing) return existing;
  const pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src =
      kind === 'youtube'
        ? 'https://www.youtube.com/iframe_api'
        : 'https://player.vimeo.com/api/player.js';
    script.async = true;
    let done = false;
    const finish = (failed = false) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (failed) {
        script.remove();
        reject(new Error('Provider unavailable'));
      } else resolve();
    };
    const timeout = setTimeout(() => finish(true), 12000);
    script.onerror = () => finish(true);
    if (kind === 'youtube') {
      const prior = state.onYouTubeIframeAPIReady;
      state.onYouTubeIframeAPIReady = () => {
        prior?.();
        finish(!state.YT?.Player);
      };
    } else script.onload = () => finish(!state.Vimeo?.Player);
    document.head.appendChild(script);
  }).catch((error) => {
    if (kind === 'youtube') youtubeLoad = undefined;
    else vimeoLoad = undefined;
    throw error;
  });
  if (kind === 'youtube') youtubeLoad = pending;
  else vimeoLoad = pending;
  return pending;
}
export const LearningVideo = forwardRef<VideoControl, Props>(function LearningVideo(props, ref) {
  const native = useRef<HTMLVideoElement>(null),
    host = useRef<HTMLDivElement>(null),
    control = useRef<VideoControl | null>(null),
    latest = useRef(props);
  latest.current = props;
  useImperativeHandle(
    ref,
    () => ({
      play: () => control.current?.play(),
      pause: () => control.current?.pause(),
      seek: (seconds) => control.current?.seek(seconds),
    }),
    [],
  );
  const sourceKey = JSON.stringify(props.source);
  useEffect(() => {
    const p = latest.current;
    if (p.source.kind === 'file' || p.source.kind === 'direct') {
      control.current = {
        play: () => {
          void native.current
            ?.play()
            .catch(() =>
              latest.current.onError(
                'Không phát được video. Hãy kiểm tra liên kết hoặc quyền chia sẻ.',
              ),
            );
        },
        pause: () => native.current?.pause(),
        seek: (seconds) => {
          if (native.current)
            native.current.currentTime = Math.max(0, Math.min(seconds, latest.current.maximum));
        },
      };
      return () => {
        native.current?.pause();
        control.current = null;
      };
    }
    if (p.source.kind === 'gdrive') return;
    const element = host.current;
    if (!element) return;
    let disposed = false,
      youtube: YtPlayer | undefined,
      vimeo: VimeoPlayer | undefined,
      timer: ReturnType<typeof setInterval> | undefined,
      readinessTimer: ReturnType<typeof setTimeout> | undefined;
    const report = (seconds: number) => {
      if (disposed || !playbackSeconds(seconds)) return;
      const current = latest.current;
      if (seconds > current.maximum + 0.05) {
        control.current?.pause();
        control.current?.seek(current.maximum);
        current.onTime(current.maximum);
      } else current.onTime(seconds);
    };
    const fail = () => {
      if (!disposed)
        latest.current.onError(
          'Video nhúng chưa phát được. Kiểm tra quyền chia sẻ và kết nối tới nhà cung cấp.',
        );
    };
    void sdk(p.source.kind)
      .then(() => {
        if (disposed) return;
        readinessTimer = setTimeout(fail, 12000);
        const state = window as ProviderWindow;
        if (p.source.kind === 'youtube') {
          const target = document.createElement('iframe');
          target.title = p.title;
          target.referrerPolicy = 'strict-origin-when-cross-origin';
          target.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
          target.setAttribute('allowfullscreen', '');
          target.src =
            videoEmbedUrl(p.source)! +
            '?enablejsapi=1&playsinline=1&origin=' +
            encodeURIComponent(location.origin);
          element.appendChild(target);
          youtube = new state.YT!.Player(target, {
            videoId: p.source.id,
            host: 'https://www.youtube-nocookie.com',
            width: '100%',
            height: '100%',
            playerVars: { playsinline: 1, origin: location.origin, rel: 0 },
            events: {
              onReady: () => {
                if (disposed) return;
                clearTimeout(readinessTimer);
                const frame = youtube!.getIframe();
                frame.title = p.title;
                control.current = {
                  play: () => youtube?.playVideo(),
                  pause: () => youtube?.pauseVideo(),
                  seek: (seconds) =>
                    youtube?.seekTo(Math.min(seconds, latest.current.maximum), true),
                };
                if (p.start > 0) control.current.seek(p.start);
                latest.current.onReady?.();
                timer = setInterval(() => {
                  if (youtube?.getPlayerState() === 1) {
                    if (latest.current.paused) youtube.pauseVideo();
                    else report(youtube.getCurrentTime());
                  }
                }, 250);
              },
              onStateChange: (event: unknown) => {
                if (
                  disposed ||
                  !youtube ||
                  !event ||
                  typeof event !== 'object' ||
                  !('data' in event)
                )
                  return;
                if (event.data === 0) {
                  const seconds = youtube.getCurrentTime();
                  if (!playbackSeconds(seconds)) return;
                  report(seconds);
                  latest.current.onEnded();
                }
                if (event.data === 1 && latest.current.paused) youtube.pauseVideo();
              },
              onError: fail,
            },
          });
        } else if (p.source.kind === 'vimeo') {
          const frame = document.createElement('iframe');
          const address = new URL(videoEmbedUrl(p.source)!);
          address.searchParams.set('dnt', '1');
          frame.referrerPolicy = 'strict-origin-when-cross-origin';
          frame.src = address.href;
          frame.title = p.title;
          frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
          frame.setAttribute('allowfullscreen', '');
          frame.width = '100%';
          frame.height = '100%';
          element.appendChild(frame);
          vimeo = new state.Vimeo!.Player(frame);
          control.current = {
            play: () => {
              void vimeo?.play().catch(fail);
            },
            pause: () => {
              void vimeo?.pause().catch(() => {});
            },
            seek: (seconds) => {
              void vimeo?.setCurrentTime(Math.min(seconds, latest.current.maximum)).catch(fail);
            },
          };
          vimeo.on('timeupdate', (event) => {
            const seconds = vimeoSeconds(event);
            if (seconds !== undefined) report(seconds);
          });
          vimeo.on('play', () => {
            if (!disposed && latest.current.paused) control.current?.pause();
          });
          vimeo.on('ended', (event) => {
            const seconds = vimeoSeconds(event);
            if (disposed || seconds === undefined) return;
            report(seconds);
            latest.current.onEnded();
          });
          vimeo.on('error', fail);
          void vimeo
            .ready()
            .then(() => {
              if (!disposed) {
                clearTimeout(readinessTimer);
                if (p.start > 0) control.current?.seek(p.start);
                latest.current.onReady?.();
              }
            })
            .catch(fail);
        }
      })
      .catch(fail);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(readinessTimer);
      youtube?.destroy();
      void vimeo?.destroy().catch(() => {});
      element.replaceChildren();
      control.current = null;
    };
  }, [sourceKey, props.versionId]);
  useEffect(() => {
    if (props.paused) control.current?.pause();
  }, [props.paused]);
  if (props.source.kind === 'gdrive')
    return (
      <iframe
        title={props.title}
        src={videoEmbedUrl(props.source)!}
        allow="fullscreen"
        allowFullScreen
        className="aspect-video min-h-[220px] w-full rounded-lg border-0 bg-black"
      />
    );
  if (props.source.kind === 'youtube' || props.source.kind === 'vimeo')
    return (
      <div
        ref={host}
        className="relative aspect-video min-h-[220px] w-full overflow-hidden rounded-lg bg-black [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:h-full [&>iframe]:w-full"
      />
    );
  const src =
    props.source.kind !== 'direct'
      ? '/api/lms/media/' + props.source.id + '?versionId=' + props.versionId
      : props.source.url;
  return (
    <video
      ref={native}
      aria-label={props.title}
      src={src}
      controls
      playsInline
      preload="metadata"
      className="aspect-video w-full rounded-lg bg-black"
      onLoadedMetadata={() => {
        latest.current.onReady?.();
        if (native.current && props.start > 0)
          native.current.currentTime = Math.min(props.start, props.maximum);
      }}
      onPlay={() => {
        if (latest.current.paused) native.current?.pause();
      }}
      onSeeking={() => {
        if (native.current && native.current.currentTime > latest.current.maximum + 0.05) {
          native.current.currentTime = latest.current.maximum;
          native.current.pause();
          latest.current.onTime(latest.current.maximum);
        }
      }}
      onTimeUpdate={() => {
        if (native.current)
          latest.current.onTime(Math.min(native.current.currentTime, latest.current.maximum));
      }}
      onEnded={() => latest.current.onEnded()}
      onPause={() => latest.current.onPause?.()}
      onError={() =>
        latest.current.onError(
          'Không tải được video. Hãy tải lại bài học hoặc kiểm tra quyền truy cập.',
        )
      }
    />
  );
});
