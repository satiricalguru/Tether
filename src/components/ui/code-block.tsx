import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';

/** A copyable command/snippet. */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  };
  return (
    <div className={cn('group relative', className)}>
      <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 pr-9 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {code}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
        className="absolute top-1.5 right-1.5 rounded p-1 text-muted hover:bg-border hover:text-fg"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
