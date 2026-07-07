import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-2xl border border-border bg-white/85 px-4 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-[#5bbf86] focus:ring-2 focus:ring-[#5bbf86]/30',
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = 'Input';
