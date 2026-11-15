import { useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { Download, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/messages';
import { defaultAttachmentField } from '../../../src/forms/attachment-fields';
import type { FormField } from '../../../src/forms/contracts';
import type { AttachmentSummary } from '../../../src/workflows/attachments';

export type AttachmentContext = {
  files: Record<string, AttachmentSummary>;
  href: (id: string) => string;
  upload?: (fieldId: string, files: File[]) => Promise<AttachmentSummary[]>;
  unavailableMessage?: string;
};

export function AttachmentLinks({
  ids,
  context,
  remove,
}: {
  ids: string[];
  context?: AttachmentContext;
  remove?: (id: string) => void;
}) {
  if (!ids.length) return null;
  return (
    <ul className="space-y-2">
      {ids.map((id) => {
        const item = context?.files[id];
        return (
          <li key={id} className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-1">
            {item && context ? (
              <a
                href={context.href(id)}
                download
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-sm text-primary underline-offset-4 hover:underline"
              >
                <Download className="size-4 shrink-0" aria-hidden />
                <span className="break-all">{item.fileName}</span>
              </a>
            ) : (
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">Tệp đính kèm</span>
            )}
            {remove && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={'Bỏ tệp ' + (item?.fileName ?? '')}
                onClick={() => remove(id)}
              >
                <X className="size-4" />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AttachmentPicker({
  field,
  value,
  context,
  onChange,
  id,
  disabled: readOnly,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: {
  field: FormField;
  value: unknown;
  context?: AttachmentContext;
  onChange: (ids: string[]) => void;
} & Pick<ComponentProps<'button'>, 'id' | 'disabled' | 'aria-describedby' | 'aria-invalid'>) {
  const ids = Array.isArray(value) ? (value as string[]) : [];
  const policy = field.attachments ?? defaultAttachmentField();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const editable = !readOnly && !!context?.upload;
  const disabled = !editable || loading || ids.length >= policy.maxFiles;
  return (
    <div className="space-y-2">
      <AttachmentLinks
        ids={ids}
        context={context}
        remove={
          editable && !loading ? (id) => onChange(ids.filter((item) => item !== id)) : undefined
        }
      />
      <input
        ref={input}
        hidden
        type="file"
        multiple={policy.maxFiles > 1}
        accept={policy.formats
          .map((format) => (format === 'jpeg' ? '.jpg,.jpeg' : '.' + format))
          .join(',')}
        disabled={disabled}
        onChange={async (event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (!files.length || !context?.upload) return;
          if (
            ids.length + files.length > policy.maxFiles ||
            files.some((file) => file.size > policy.maxBytes || !file.size)
          ) {
            setError('Kiểm tra số lượng và dung lượng tệp.');
            return;
          }
          setError('');
          setLoading(true);
          try {
            const result = await context.upload(field.id, files);
            if (!mounted.current) return;
            const ready = result.filter((item) => item.status === 'ready');
            if (ready.length) onChange([...ids, ...ready.map((item) => item.id)]);
            if (ready.length !== result.length)
              setError('Một số tệp không vượt qua kiểm tra định dạng.');
          } catch (error) {
            if (mounted.current) setError(errorMessage(error));
          } finally {
            if (mounted.current) setLoading(false);
          }
        }}
      />
      <Button
        id={id}
        type="button"
        variant="outline"
        aria-label={'Chọn tệp cho ' + field.label}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Upload className="size-4" aria-hidden />
        Chọn tệp
      </Button>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Đang kiểm tra tệp…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {context?.unavailableMessage ??
          'Tối đa ' +
            policy.maxFiles +
            ' tệp, ' +
            (policy.maxBytes / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) +
            ' MiB mỗi tệp.'}
      </p>
    </div>
  );
}
