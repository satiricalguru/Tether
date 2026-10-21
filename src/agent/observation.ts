import { fence } from '@/context/attachments';
import { truncateToTokens } from '@/context/budget';
import type { PageExtract } from '@/context/extract';
import { estimateTokens } from '@/context/tokens';

/**
 * What the model sees each step. Compact on purpose: small context windows
 * are the binding constraint. Phase 5 adds the numbered element list.
 */

export interface ObservationInput {
  page: PageExtract | { error: string; url: string; title: string };
  tabs: { title: string; url: string; current: boolean }[];
  /** Tokens available for page text. */
  contentBudget: number;
}

export function renderObservation(o: ObservationInput): string {
  const tabs = o.tabs
    .map((t, i) => `[${i}${t.current ? '*' : ''}] ${t.title.slice(0, 60) || t.url}`)
    .join('  ');
  const head = [`URL: ${o.page.url}`, `TITLE: ${o.page.title}`, `TABS: ${tabs}`];
  if ('error' in o.page)
    return [...head, `CONTENT: (cannot read this page: ${o.page.error})`].join('\n');
  const links = renderLinks(o.page.links);
  // Links are what the agent navigates by; they get their share first.
  const t = truncateToTokens(o.page.text, Math.max(200, o.contentBudget - estimateTokens(links)));
  const body = fence({
    id: 'obs',
    kind: 'page',
    title: o.page.title,
    url: o.page.url,
    text: `${t.text || '(empty page)'}${links ? `\n\n${links}` : ''}`,
    tokens: estimateTokens(t.text),
    warnings: [],
  });
  return [...head, 'CONTENT:', body].join('\n');
}

/** "LINKS:" section: numbered, page order, labels trimmed. Inside the untrusted fence. */
export function renderLinks(links: { text: string; url: string }[]): string {
  if (links.length === 0) return '';
  return [
    'LINKS (to follow one, navigate to its URL):',
    ...links.map((l, i) => `[${i + 1}] ${l.text.slice(0, 60)} → ${l.url}`),
  ].join('\n');
}

/** "Step 3: navigate(url=…) → loaded "Results"" lines; only the last `keep`, older ones summarized. */
export function progressLog(lines: string[], keep = 8): string {
  if (lines.length === 0) return '(nothing yet)';
  const older = lines.length - keep;
  return [...(older > 0 ? [`(${older} earlier steps omitted)`] : []), ...lines.slice(-keep)].join(
    '\n',
  );
}

export function argsInline(args: Record<string, unknown>, max = 80): string {
  const s = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join(', ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
