import { cn } from '@/lib/cn';

export type Status = 'ok' | 'warn' | 'error' | 'pending';

const COLORS: Record<Status, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  error: 'bg-danger',
  pending: 'bg-muted animate-pulse',
};

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', COLORS[status], className)}
    />
  );
}
