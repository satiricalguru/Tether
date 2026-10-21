import { AlertTriangle, EyeOff, FileText, Globe, Layers, TextSelect } from 'lucide-react';
import type { Attachment } from '@/context/attachments';
import { formatTokens } from '@/lib/format';
import { cn } from '@/lib/cn';

const ICON = { page: Globe, selection: TextSelect, tab: Layers, pdf: FileText } as const;

export function attachmentWarning(a: Attachment): string | undefined {
  const parts: string[] = [];
  if (a.warnings.length) {
    parts.push(
      `Contains text that looks like instructions to an AI: “${a.warnings[0]?.excerpt ?? ''}”. Tether treats it as page data and tells the model not to follow it.`,
    );
  }
  if (a.hiddenExcluded?.suspicious) {
    parts.push('Hidden text that looked like instructions was found on this page and left out.');
  }
  return parts.length ? parts.join(' ') : undefined;
}

/** Context sent with a user message, shown above its text. */
export function AttachmentChips({
  attachments,
  className,
}: {
  attachments: Attachment[];
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-wrap justify-end gap-1', className)}
      data-testid="msg-attachments"
    >
      {attachments.map((a) => {
        const Icon = ICON[a.kind];
        const warn = attachmentWarning(a);
        return (
          <span
            key={a.id}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-muted',
              warn && 'border-warn/50 text-warn',
            )}
            title={[a.url, warn].filter(Boolean).join('\n')}
            data-testid="msg-attachment"
            data-kind={a.kind}
            data-warning={warn ? 'yes' : 'no'}
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{a.title}</span>
            <span className="shrink-0 tabular-nums">· {formatTokens(a.tokens)}</span>
            {a.originalTokens && <span className="shrink-0">(trimmed)</span>}
            {warn && (
              <AlertTriangle className="size-3 shrink-0" aria-label="Possible prompt injection" />
            )}
            {a.hiddenExcluded && !warn && (
              <EyeOff className="size-3 shrink-0" aria-label="Hidden text left out" />
            )}
          </span>
        );
      })}
    </div>
  );
}
