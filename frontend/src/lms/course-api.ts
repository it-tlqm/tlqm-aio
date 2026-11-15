import { useCallback, useRef } from 'react';
import { api, ApiError } from '@/lib/api';
import type {
  PublicCourseSpec,
  CourseSpec,
  AssessmentSnapshot,
} from '../../../src/lms/course-contracts';
export type CourseItem = {
  id: string;
  code: string;
  status: 'active' | 'archived';
  revision: number;
  ownerUnitId: string;
  versionId: string | null;
  version: number | null;
  spec: PublicCourseSpec;
  updatedAt: number;
  publishedTitle?: string | null;
  prerequisitesRemaining?: number;
  progress?: { position: number; watched: number; finished: boolean; passed: boolean };
};
export type ManagedCourse = Omit<CourseItem, 'spec'> & { spec: CourseSpec };
export type CourseDetail = {
  courseId: string;
  versionId: string;
  version: number;
  spec: PublicCourseSpec;
  assessment: { count: number; remaining: number | null; nextAllowedAt: number | null };
  progress: {
    position: number;
    watched: number;
    finished: boolean;
    revision: number;
    answeredCheckpoints: string[];
  };
  notes: { id: string; time: number; content: string; created_at: number }[];
};
export type AttemptResult = AssessmentSnapshot & {
  id: string;
  versionId: string;
  createdAt: number;
};
export type UploadedMedia = {
  id: string;
  name: string;
  kind: 'video' | 'document' | 'image';
  mimeType: string;
  size: number;
  createdAt: number;
};
export function useCourseCommands(csrfToken: string, endpoint = '/api/lms/commands') {
  const prior = useRef<Record<string, { payload: string; key: string }>>({});
  return useCallback(
    async <T>(
      action: string,
      data: unknown,
      options?: { key?: string; reason?: string },
    ): Promise<T> => {
      const reason = options?.reason ?? 'Thao tác đào tạo trên giao diện LMS';
      const payload = JSON.stringify({ data, reason });
      if (prior.current[action]?.payload !== payload)
        prior.current[action] = { payload, key: crypto.randomUUID() };
      return api<T>(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'idempotency-key': options?.key ?? prior.current[action]!.key,
        },
        body: JSON.stringify({ action, data, reason }),
      });
    },
    [csrfToken, endpoint],
  );
}
export async function uploadCourseMedia(
  file: File,
  ownerUnitId: string,
  csrfToken: string,
  signal: AbortSignal,
  progress: (value: number) => void,
  ids: { id: string; key: string },
) {
  progress(0);
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return new Promise<UploadedMedia>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/lms/media');
    const mime =
      file.type ||
      (
        {
          mp4: 'video/mp4',
          m4v: 'video/mp4',
          webm: 'video/webm',
          mov: 'video/quicktime',
          ogg: 'video/ogg',
          ogv: 'video/ogg',
          pdf: 'application/pdf',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        } as Record<string, string>
      )[file.name.split('.').at(-1)!.toLowerCase()] ||
      'application/octet-stream';
    const headers = {
      'content-type': mime,
      'x-csrf-token': csrfToken,
      'idempotency-key': ids.key,
      'x-media-id': ids.id,
      'x-owner-unit-id': ownerUnitId,
      'x-file-name': encodeURIComponent(file.name),
      'x-file-size': String(file.size),
      'x-file-sha256': sha256,
    };
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    const done = () => signal.removeEventListener('abort', abort);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onerror = () => {
      done();
      reject(new Error('Upload unavailable'));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    xhr.onload = () => {
      done();
      let body: UploadedMedia & { error?: string };
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(new ApiError(xhr.status, 'INVALID_RESPONSE'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        progress(100);
        resolve(body);
      } else reject(new ApiError(xhr.status, body.error ?? 'REQUEST_FAILED'));
    };
    xhr.send(file);
  });
}
