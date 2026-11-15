import * as React from 'react';
import { cn } from 'cn';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { CheckIcon, MinusIcon } from 'lucide-react';

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer group/checkbox relative inline-flex size-11 min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md bg-transparent outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span
        data-slot="checkbox-control"
        aria-hidden="true"
        className="grid size-5 place-content-center rounded-[5px] border border-input bg-card text-primary-foreground shadow-xs transition-colors group-focus-visible/checkbox:ring-2 group-focus-visible/checkbox:ring-ring group-focus-visible/checkbox:ring-offset-2 group-aria-invalid/checkbox:border-destructive group-data-[state=checked]/checkbox:border-primary group-data-[state=checked]/checkbox:bg-primary group-data-[state=indeterminate]/checkbox:border-primary group-data-[state=indeterminate]/checkbox:bg-primary"
      >
        <CheckboxPrimitive.Indicator
          data-slot="checkbox-indicator"
          className="grid place-content-center"
        >
          <CheckIcon className="size-3.5 group-data-[state=indeterminate]/checkbox:hidden" />
          <MinusIcon className="hidden size-3.5 group-data-[state=indeterminate]/checkbox:block" />
        </CheckboxPrimitive.Indicator>
      </span>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
