import { useEffect, useRef, useState } from 'react';
import { Upload, X, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { errorMessage } from '@/lib/messages';
import { ApiError } from '@/lib/api';
import { uploadCourseMedia } from './course-api';
import type { UploadedMedia } from './course-api';
export function MediaUpload({
  ownerUnitId,
  csrfToken,
  onUploaded,
  kind = 'video',
  onAccessError,
}: {
  ownerUnitId: string;
  csrfToken: string;
  onUploaded: (media: UploadedMedia) => void;
  kind?: 'video' | 'document';
  onAccessError?: (error: unknown) => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [percent, setPercent] = useState(0),
    [error, setError] = useState<unknown>(null),
    [complete, setComplete] = useState(false);
  const controller = useRef<AbortController | null>(null),
    operation = useRef({ id: crypto.randomUUID(), key: crypto.randomUUID() });
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function upload() {
    if (!file) return;
    if (file.size > (kind === 'video' ? 100 : 20) * 1024 * 1024) {
      setError(new ApiError(413, 'PAYLOAD_TOO_LARGE'));
      return;
    }
    if (!file.size) {
      setError(new ApiError(400, 'LMS_MEDIA_SIZE_INVALID'));
      return;
    }
    setError(null);
    setComplete(false);
    setBusy(true);
    const current = new AbortController();
    controller.current = current;
    try {
      const result = await uploadCourseMedia(
        file,
        ownerUnitId,
        csrfToken,
        current.signal,
        setPercent,
        operation.current,
      );
      if (!current.signal.aborted) {
        setComplete(true);
        onUploaded(result);
      }
    } catch (error) {
      if (!current.signal.aborted) {
        setError(error);
        if (error instanceof ApiError && [401, 403].includes(error.status)) onAccessError?.(error);
      }
    } finally {
      if (controller.current === current) {
        setBusy(false);
        controller.current = null;
      }
    }
  }
  const inputId = 'lms-upload-' + kind;
  return (
    <div
      role="group"
      aria-label={kind === 'video' ? 'Tải video lên' : 'Tải tài liệu lên'}
      className="space-y-3 rounded-lg border border-dashed bg-secondary/30 p-4"
    >
      <Label htmlFor={inputId}>{kind === 'video' ? 'Tải video lên' : 'Tải tài liệu lên'}</Label>
      <p className="text-xs text-muted-foreground">
        {kind === 'video'
          ? 'MP4, WebM, OGG, MOV · Tối đa 100 MB'
          : 'PDF, DOCX, XLSX · Tối đa 20 MB'}
      </p>
      <input
        ref={fileInput}
        hidden
        id={inputId}
        type="file"
        disabled={busy}
        accept={kind === 'video' ? '.mp4,.m4v,.webm,.ogg,.ogv,.mov' : '.pdf,.docx,.xlsx'}
        onChange={(event) => {
          controller.current?.abort();
          setFile(event.target.files?.[0] ?? null);
          operation.current = { id: crypto.randomUUID(), key: crypto.randomUUID() };
          setComplete(false);
          setError(null);
          setPercent(0);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          Chọn file
        </Button>
        <span className="min-w-0 break-all text-sm text-muted-foreground">
          {file?.name ?? 'Chưa chọn file'}
        </span>
      </div>
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      {busy && (
        <div className="space-y-2" role="status">
          <p className="text-sm">
            {percent < 99 ? 'Đang tải: ' + percent + '%' : 'Đang kiểm tra và lưu file…'}
          </p>
          <progress
            aria-label="Tiến độ tải file"
            max={100}
            value={percent}
            className="h-2 w-full accent-primary"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={!file || busy || !ownerUnitId || complete}
          onClick={() => void upload()}
        >
          <Upload aria-hidden="true" />
          Tải file
        </Button>
        {busy && (
          <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>
            <X aria-hidden="true" />
            Hủy tải
          </Button>
        )}
        {complete && (
          <span className="flex items-center gap-2 text-sm text-[var(--success)]" role="status">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            File đã lưu
          </span>
        )}
      </div>
    </div>
  );
}
