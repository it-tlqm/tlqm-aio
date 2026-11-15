import emblem from '@/assets/brand/emblem-color.png';

export function Brand({ module = 'Nền tảng dùng chung' }: { module?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3" data-brand="tlqm">
      <img
        src={emblem}
        alt="Tà Lùng Quang Minh"
        width={52}
        height={52}
        className="h-13 w-13 shrink-0 object-contain"
        decoding="async"
      />
      <div className="min-w-0">
        <p className="whitespace-nowrap text-base font-bold tracking-tight text-[var(--brand-navy)]">
          TLQM <span className="text-primary">AIO</span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{module}</p>
      </div>
    </div>
  );
}
