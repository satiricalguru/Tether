import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-border bg-bg px-2 text-sm placeholder:text-muted focus:ring-2 focus:ring-ring focus:outline-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label className={cn('mb-1 block text-xs font-medium text-muted', className)} {...props} />
  );
}
