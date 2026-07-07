import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border border-border bg-white/85 px-2.5 py-1 text-[11px] font-medium leading-none tracking-normal text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
