import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { highlight, normalizeLang, type HighlightedLine } from './highlight';

/** Minimum gap between re-highlights while a block is still streaming. */
const STREAM_DEBOUNCE_MS = 250;

export function MarkdownCodeBlock({
  code,
  lang,
  streaming = false,
}: {
  code: string;
  lang?: string;
  streaming?: boolean;
}) {
  const [lines, setLines] = useState<HighlightedLine[] | null>(null);
  const [copied, setCopied] = useState(false);
  const label = lang?.trim().split(/\s/)[0] ?? '';
  const supported = normalizeLang(lang) !== undefined;

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const run = () => {
      void highlight(code, lang).then((out) => {
        if (!cancelled) setLines(out);
      });
    };
    if (!streaming) {
      run();
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(run, STREAM_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, lang, streaming, supported]);

  // Highlighting can lag the text while streaming; never show stale content.
  const shown =
    lines?.map((l) => l.map((t) => t.content).join('')).join('\n') === code ? lines : null;

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  };

  return (
    <div
      className="my-2 overflow-hidden rounded-md border border-border bg-surface-2"
      data-testid="code-block"
      data-lang={label}
    >
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-[11px] text-muted">
        <span className="font-mono">{label || 'text'}</span>
        <button
          type="button"
          data-testid="code-copy"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-border hover:text-fg"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-2 font-mono text-xs leading-relaxed">
        <code>
          {shown
            ? shown.map((line, i) => (
                <span key={i}>
                  {line.map((t, j) => (
                    <span
                      key={j}
                      className="md-token"
                      style={{ '--sl': t.light, '--sd': t.dark } as CSSProperties}
                    >
                      {t.content}
                    </span>
                  ))}
                  {i < shown.length - 1 ? '\n' : null}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
