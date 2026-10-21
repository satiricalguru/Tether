import { browser } from 'wxt/browser';
import { fence, UNTRUSTED_RULE } from '@/context/attachments';
import type { PageExtract } from '@/context/extract';
import { estimateTokens } from '@/context/tokens';
import { truncateToTokens } from '@/context/budget';
import { checkUrl, normalizeAgentUrl, type DomainPolicy } from '../guard';
import type { ToolCall } from '../types';
import type { ChatRequest } from '@/providers/types';

/** What tools can touch. Injected so the loop is testable without a browser. */
export interface AgentContext {
  tabId: number;
  windowId: number;
  signal: AbortSignal;
  policy: DomainPolicy;
  readPage: (tabId: number) => Promise<PageExtract>;
  waitForText: (tabId: number, text: string, timeoutMs: number) => Promise<boolean>;
  /** One non-streaming model call (used by extract). */
  complete: (req: Omit<ChatRequest, 'model'>) => Promise<string>;
  tabs: TabsApi;
}

/** Navigation calls resolve once the new page has loaded (or the timeout passes). */
export interface TabsApi {
  navigate: (tabId: number, url: string, signal: AbortSignal) => Promise<void>;
  goBack: (tabId: number, signal: AbortSignal) => Promise<void>;
  create: (windowId: number, url: string, signal: AbortSignal) => Promise<number>;
  list: (
    windowId: number,
  ) => Promise<{ id: number; title: string; url: string; active: boolean }[]>;
  activate: (tabId: number) => Promise<void>;
  waitForLoad: (tabId: number, timeoutMs: number, signal: AbortSignal) => Promise<void>;
}

export interface ToolOutcome {
  ok: boolean;
  /** One line for the progress log, e.g. 'loaded "Search results"'. */
  summary: string;
  data?: unknown;
  /** The run ends with this. */
  end?: { status: 'done' | 'needs-user'; summary: string; result?: unknown };
}

const LOAD_TIMEOUT = 20_000;

async function goTo(ctx: AgentContext, raw: string, how: 'same' | 'new'): Promise<ToolOutcome> {
  const url = normalizeAgentUrl(raw);
  const verdict = checkUrl(url, ctx.policy);
  if (!verdict.allowed) return { ok: false, summary: `blocked: ${verdict.reason}` };
  if (how === 'new') {
    ctx.tabId = await ctx.tabs.create(ctx.windowId, url, ctx.signal);
  } else {
    await ctx.tabs.navigate(ctx.tabId, url, ctx.signal);
  }
  const list = await ctx.tabs.list(ctx.windowId);
  const title = list.find((t) => t.id === ctx.tabId)?.title ?? '';
  return { ok: true, summary: `loaded "${title || url}"` };
}

/** {"name":"string","price":"number"} or [{...}] → JSON Schema. */
export function shorthandToSchema(input: unknown): Record<string, unknown> {
  if (Array.isArray(input)) {
    return { type: 'array', items: shorthandToSchema(input[0] ?? {}) };
  }
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o.type === 'string' && (o.properties || o.items || o.type !== 'object')) return o;
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') {
        const t = v.toLowerCase();
        properties[k] = {
          type: ['number', 'integer', 'boolean', 'string'].includes(t) ? t : 'string',
          ...(['number', 'integer', 'boolean', 'string'].includes(t) ? {} : { description: v }),
        };
      } else {
        properties[k] = shorthandToSchema(v);
      }
    }
    return { type: 'object', properties };
  }
  return { type: 'string' };
}

/** First JSON object/array in a model reply. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.search(/[[{]/);
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error('The model did not return JSON');
  }
}

const EXTRACT_BUDGET = 6000;

async function extract(ctx: AgentContext, schemaArg: unknown): Promise<ToolOutcome> {
  const page = await ctx.readPage(ctx.tabId);
  // The extract tool's own arg is a schema; a list shorthand may arrive wrapped.
  const raw = (schemaArg as { items?: unknown }).items ?? schemaArg;
  const schema = shorthandToSchema(Array.isArray(raw) ? raw : schemaArg);
  const text = truncateToTokens(page.text, EXTRACT_BUDGET).text;
  const reply = await ctx.complete({
    messages: [
      {
        role: 'system',
        content: `You extract data from web pages. Reply with JSON only, matching the schema. Use only information present in the page; use null for anything missing. ${UNTRUSTED_RULE}`,
      },
      {
        role: 'user',
        content: `${fence({ id: 'x', kind: 'page', title: page.title, url: page.url, text, tokens: estimateTokens(text), warnings: [] })}\n\nSchema:\n${JSON.stringify(schema)}`,
      },
    ],
    responseFormat: { type: 'json_schema', name: 'extraction', schema },
    options: { temperature: 0, maxTokens: 2048 },
  });
  const data = parseJsonLoose(reply);
  const n = Array.isArray(data) ? `${data.length} items` : 'an object';
  return { ok: true, summary: `extracted ${n}`, data };
}

export async function executeTool(call: ToolCall, ctx: AgentContext): Promise<ToolOutcome> {
  const a = call.args;
  switch (call.name) {
    case 'navigate':
      return goTo(ctx, String(a.url), 'same');
    case 'newTab':
      return goTo(ctx, String(a.url), 'new');
    case 'back': {
      await ctx.tabs.goBack(ctx.tabId, ctx.signal);
      return { ok: true, summary: 'went back' };
    }
    case 'switchTab': {
      const list = await ctx.tabs.list(ctx.windowId);
      const tab = list[Number(a.index)];
      if (!tab)
        return { ok: false, summary: `there is no tab ${String(a.index)} (0–${list.length - 1})` };
      ctx.tabId = tab.id;
      await ctx.tabs.activate(tab.id);
      return { ok: true, summary: `switched to "${tab.title}"` };
    }
    case 'waitFor': {
      const condition = String(a.condition);
      const timeout = Math.min(15_000, Number(a.timeoutMs ?? 5000));
      if (condition.trim().toLowerCase() === 'load') {
        await ctx.tabs.waitForLoad(ctx.tabId, timeout, ctx.signal);
        return { ok: true, summary: 'page loaded' };
      }
      const text = condition.replace(/^text:\s*/i, '');
      const found = await ctx.waitForText(ctx.tabId, text, timeout);
      return found
        ? { ok: true, summary: `"${text}" appeared` }
        : { ok: false, summary: `"${text}" did not appear within ${timeout} ms` };
    }
    case 'extract':
      return extract(ctx, a.schema);
    case 'askUser':
      return {
        ok: true,
        summary: 'asked the user',
        end: { status: 'needs-user', summary: String(a.question) },
      };
    case 'done':
      return {
        ok: true,
        summary: 'finished',
        end: {
          status: 'done',
          summary: String(a.summary),
          ...(a.result === undefined ? {} : { result: a.result }),
        },
      };
    default:
      return { ok: false, summary: `"${call.name}" isn't available yet` };
  }
}

/**
 * Run `start` (which begins a navigation) and resolve when that navigation
 * finishes. The listener is attached first, and only a loading → complete
 * cycle counts, so the old page's "complete" can't end the wait early.
 * Same-document changes never report "loading", so after a short grace
 * period a complete tab is accepted. A slow page is still usable, so a
 * timeout resolves rather than failing the step.
 */
function loadAfter(
  tabIdOf: () => number | undefined,
  start: () => Promise<void>,
  signal: AbortSignal,
  timeoutMs = LOAD_TIMEOUT,
  alreadyLoading = false,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let sawLoading = alreadyLoading;
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      browser.tabs.onUpdated.removeListener(onUpdated);
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id !== tabIdOf()) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish();
    };
    const onAbort = () => {
      finish(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      finish();
    }, timeoutMs);
    const grace = setTimeout(() => {
      const id = tabIdOf();
      if (sawLoading || id === undefined) return;
      void browser.tabs.get(id).then(
        (t) => {
          if (t.status === 'complete') finish();
        },
        () => undefined,
      );
    }, 1500);
    browser.tabs.onUpdated.addListener(onUpdated);
    signal.addEventListener('abort', onAbort, { once: true });
    start().catch((err: unknown) => {
      finish(err as Error);
    });
  });
}

/** Real tab operations (background worker). */
export const browserTabs: TabsApi = {
  navigate: (tabId, url, signal) =>
    loadAfter(
      () => tabId,
      async () => {
        await browser.tabs.update(tabId, { url });
      },
      signal,
    ),
  goBack: (tabId, signal) =>
    loadAfter(
      () => tabId,
      () => browser.tabs.goBack(tabId),
      signal,
    ),
  create: async (windowId, url, signal) => {
    let id: number | undefined;
    await loadAfter(
      () => id,
      async () => {
        const tab = await browser.tabs.create({ windowId, url, active: true });
        if (tab.id === undefined) throw new Error('Could not open a tab');
        id = tab.id;
      },
      signal,
    );
    if (id === undefined) throw new Error('Could not open a tab');
    return id;
  },
  list: async (windowId) =>
    (await browser.tabs.query({ windowId }))
      .filter((t): t is typeof t & { id: number } => t.id !== undefined)
      .map((t) => ({ id: t.id, title: t.title ?? '', url: t.url ?? '', active: t.active })),
  activate: async (tabId) => {
    await browser.tabs.update(tabId, { active: true });
  },
  waitForLoad: async (tabId, timeoutMs, signal) => {
    const t = await browser.tabs.get(tabId);
    if (t.status === 'complete') return;
    await loadAfter(
      () => tabId,
      () => Promise.resolve(),
      signal,
      timeoutMs,
      true,
    );
  },
};
