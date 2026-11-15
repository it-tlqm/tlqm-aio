import { Check, Copy, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export function CopyRouteButton({ label = 'Sao chép liên kết' }: { label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copy() {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="outline" onClick={() => void copy()} aria-label={label}>
        {copied ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
        {copied ? 'Đã sao chép' : label}
        {!copied && <Copy aria-hidden="true" />}
      </Button>
      {failed && (
        <span role="status" className="sr-only">
          Không thể sao chép liên kết. Hãy sao chép từ thanh địa chỉ.
        </span>
      )}
    </span>
  );
}
