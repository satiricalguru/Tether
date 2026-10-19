import { Lexer, type Token, type Tokens } from 'marked';
import { useMemo, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { MarkdownCodeBlock } from './code-block';
import './markdown.css';

/**
 * Model output → React elements, via marked's lexer only. Nothing is ever
 * parsed as HTML: raw HTML renders as text, links are restricted to
 * http(s)/mailto, and images are never fetched (a remote <img> would be
 * network egress and a tracking pixel), only shown as a link chip.
 */

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The href if it is an absolute http(s)/mailto URL, else null. */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Browsers ignore leading whitespace/control chars in hrefs; so do we.
  // eslint-disable-next-line no-control-regex -- intentionally stripping control chars
  const href = raw.replace(/^[\s\u0000-\u001f]+/, '');
  try {
    const url = new URL(href);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function inline(tokens: Token[] | undefined, key = 'i'): ReactNode[] {
  return (tokens ?? []).map((t, i) => renderInline(t, `${key}-${i}`));
}

function renderInline(token: Token, key: string): ReactNode {
  const t = token as Tokens.Generic;
  switch (token.type) {
    case 'text': {
      const tt = token as Tokens.Text;
      return tt.tokens ? <span key={key}>{inline(tt.tokens, key)}</span> : tt.text;
    }
    case 'escape':
      return (token as Tokens.Escape).text;
    case 'strong':
      return <strong key={key}>{inline((token as Tokens.Strong).tokens, key)}</strong>;
    case 'em':
      return <em key={key}>{inline((token as Tokens.Em).tokens, key)}</em>;
    case 'del':
      return <del key={key}>{inline((token as Tokens.Del).tokens, key)}</del>;
    case 'codespan':
      return (
        <code key={key} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">
          {(token as Tokens.Codespan).text}
        </code>
      );
    case 'br':
      return <br key={key} />;
    case 'link': {
      const link = token as Tokens.Link;
      const href = safeHref(link.href);
      const children = inline(link.tokens, key);
      if (!href) return <span key={key}>{children}</span>;
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-2"
          {...(link.title ? { title: link.title } : {})}
        >
          {children}
        </a>
      );
    }
    case 'image': {
      const img = token as Tokens.Image;
      const href = safeHref(img.href);
      const chip = (
        <>
          <span aria-hidden>🖼</span> {img.text || 'image'}
        </>
      );
      const cls =
        'inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs';
      const title = 'Image not loaded (Tether never fetches remote content)';
      return href ? (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          className={cls}
          data-testid="image-chip"
        >
          {chip}
        </a>
      ) : (
        <span key={key} title={title} className={cls} data-testid="image-chip">
          {chip}
        </span>
      );
    }
    case 'html':
      return (
        <code key={key} className="font-mono text-[0.85em] text-muted">
          {(token as Tokens.HTML).text}
        </code>
      );
    default:
      return 'tokens' in t && Array.isArray(t.tokens) ? (
        <span key={key}>{inline(t.tokens, key)}</span>
      ) : (
        t.raw
      );
  }
}

function listItem(item: Tokens.ListItem, key: string): ReactNode {
  // Loose items wrap paragraphs; tight items carry `text` tokens directly.
  const body = item.tokens.map((t, i) => {
    if (t.type === 'checkbox') return null;
    if (t.type === 'text' && !item.loose) {
      const tt = t as Tokens.Text;
      return (
        <span key={`${key}-${i}`}>{tt.tokens ? inline(tt.tokens, `${key}-${i}`) : tt.text}</span>
      );
    }
    return renderBlock(t, `${key}-${i}`, false);
  });
  return (
    <li key={key} className={item.task ? 'list-none' : undefined}>
      {item.task && (
        <input
          type="checkbox"
          checked={!!item.checked}
          disabled
          readOnly
          className="mr-1.5 align-middle"
        />
      )}
      {body}
    </li>
  );
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

function renderBlock(token: Token, key: string, streaming: boolean): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'heading': {
      const h = token as Tokens.Heading;
      const cls = [
        'mt-3 mb-1.5 text-lg font-semibold',
        'mt-3 mb-1.5 text-base font-semibold',
        'mt-2 mb-1 text-sm font-semibold',
        'mt-2 mb-1 text-sm font-semibold',
        'mt-2 mb-1 text-sm font-medium',
        'mt-2 mb-1 text-sm font-medium text-muted',
      ][h.depth - 1];
      const Tag = `h${Math.min(6, Math.max(1, h.depth))}` as 'h1';
      return (
        <Tag key={key} className={cls}>
          {inline(h.tokens, key)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="my-1.5">
          {inline((token as Tokens.Paragraph).tokens, key)}
        </p>
      );
    case 'text': {
      const t = token as Tokens.Text;
      return (
        <p key={key} className="my-1.5">
          {t.tokens ? inline(t.tokens, key) : t.text}
        </p>
      );
    }
    case 'code': {
      const c = token as Tokens.Code;
      return (
        <MarkdownCodeBlock
          key={key}
          code={c.text.replace(/\n+$/, '')}
          lang={c.lang ?? ''}
          streaming={streaming}
        />
      );
    }
    case 'blockquote':
      return (
        <blockquote key={key} className="my-2 border-l-2 border-border pl-3 text-muted">
          {(token as Tokens.Blockquote).tokens.map((t, i) =>
            renderBlock(t, `${key}-${i}`, streaming),
          )}
        </blockquote>
      );
    case 'list': {
      const l = token as Tokens.List;
      const items = l.items.map((item, i) => listItem(item, `${key}-${i}`));
      return l.ordered ? (
        <ol
          key={key}
          className="my-1.5 list-decimal pl-5"
          {...(typeof l.start === 'number' && l.start !== 1 ? { start: l.start } : {})}
        >
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-1.5 list-disc pl-5">
          {items}
        </ul>
      );
    }
    case 'hr':
      return <hr key={key} className="my-3 border-border" />;
    case 'table': {
      const t = token as Tokens.Table;
      const align = (i: number) => {
        const a = t.align[i];
        return a ? ALIGN[a] : 'text-left';
      };
      return (
        <div key={key} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {t.header.map((cell, i) => (
                  <th
                    key={i}
                    className={cn('border border-border px-2 py-1 font-semibold', align(i))}
                  >
                    {inline(cell.tokens, `${key}-h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} className={cn('border border-border px-2 py-1', align(i))}>
                      {inline(cell.tokens, `${key}-${r}-${i}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'html':
      return (
        <pre key={key} className="my-1.5 font-mono text-xs whitespace-pre-wrap text-muted">
          {(token as Tokens.HTML).text}
        </pre>
      );
    default: {
      const g = token as Tokens.Generic;
      return (
        <p key={key} className="my-1.5">
          {Array.isArray(g.tokens) ? inline(g.tokens, key) : g.raw}
        </p>
      );
    }
  }
}

export function Markdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  const tokens = useMemo(() => new Lexer({ gfm: true }).lex(text), [text]);
  return (
    <div className={cn('text-sm leading-relaxed break-words', className)} data-testid="markdown">
      {tokens.map((t, i) => renderBlock(t, `b${i}`, streaming))}
    </div>
  );
}
