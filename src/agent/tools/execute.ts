import { browser } from 'wxt/browser';
import { fence, UNTRUSTED_RULE } from '@/context/attachments';
import type { PageExtract } from '@/context/extract';
import { estimateTokens } from '@/context/tokens';
import { truncateToTokens } from '@/context/budget';
import { checkUrl, normalizeAgentUrl, type DomainPolicy } from '../guard';
import type { ActResult, PageAction, PageSnapshot, SnapshotOptions } from '../page/types';
import type { ToolCall } from '../types';
import type { SetOfMarksResult } from '../vision/draw';
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
  /** The page engine (Phase 5). Without it the agent is read-only. */
  page?: PageApi;
  /** Vision tier: present only when the model has vision and the user turned it on. */
  vision?: VisionApi;
}

export interface VisionApi {
  /** Capture the visible tab with the snapshot's ids drawn on it. */
  capture: (tabId: number, snap: PageSnapshot) => Promise<SetOfMarksResult>;
}

export interface PageApi {
  snapshot: (tabId: number, opts: SnapshotOptions) => Promise<PageSnapshot>;
  act: (tabId: number, action: PageAction) => Promise<ActResult>;
  /** Resolve once the page has settled after an action. */
  stable: (tabId: number) => Promise<void>;
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
  goForward?: (tabId: number, signal: AbortSignal) => Promise<void>;
  reload?: (tabId: number, signal: AbortSignal) => Promise<void>;
  close?: (tabId: number) => Promise<void>;
}

const PAGE_ACTIONS = new Set([
  'click',
  'rightClick',
  'hover',
  'type',
  'clear',
  'setValue',
  'select',
  'check',
  'pressKey',
  'scroll',
]);

/** Tool call → page-engine action (args already validated). */
export function toPageAction(call: ToolCall): PageAction | null {
  const a = call.args;
  const id = typeof a.id === 'string' || typeof a.id === 'number' ? String(a.id) : undefined;
  switch (call.name) {
    case 'click':
    case 'rightClick':
    case 'hover':
      return id ? { kind: call.name, id } : null;
    case 'type':
      return id
        ? { kind: 'type', id, text: String(a.text), ...(a.submit === true ? { submit: true } : {}) }
        : null;
    case 'clear':
      return id ? { kind: 'clear', id } : null;
    case 'setValue':
      return id ? { kind: 'setValue', id, value: String(a.value) } : null;
    case 'select':
      return id ? { kind: 'select', id, option: String(a.option) } : null;
    case 'check':
      return id ? { kind: 'check', id, state: a.state === true } : null;
    case 'pressKey':
      return { kind: 'pressKey', key: String(a.key), ...(id ? { id } : {}) };
    case 'scroll':
      return {
        kind: 'scroll',
        ...(a.direction === 'up' || a.direction === 'down' ? { direction: a.direction } : {}),
        ...(id ? { id } : {}),
        ...(typeof a.amount === 'number' ? { amount: a.amount } : {}),
      };
    default:
      return null;
  }
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
  const here = (await ctx.tabs.list(ctx.windowId)).find((t) => t.id === ctx.tabId)?.url;
  const url = normalizeAgentUrl(raw, here);
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
    case 'screenshot':
      // The next observation carries a fresh screenshot; nothing to do here.
      return {
        ok: true,
        summary: ctx.vision ? 'took a fresh screenshot' : 'screenshots are off for this run',
      };
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
    case 'forward': {
      if (!ctx.tabs.goForward) return { ok: false, summary: 'forward is not available' };
      await ctx.tabs.goForward(ctx.tabId, ctx.signal);
      return { ok: true, summary: 'went forward' };
    }
    case 'reload': {
      if (!ctx.tabs.reload) return { ok: false, summary: 'reload is not available' };
      await ctx.tabs.reload(ctx.tabId, ctx.signal);
      return { ok: true, summary: 'reloaded' };
    }
    case 'closeTab': {
      const list = await ctx.tabs.list(ctx.windowId);
      const tab = list[Number(a.index)];
      if (!tab) return { ok: false, summary: `there is no tab ${String(a.index)}` };
      if (list.length === 1) return { ok: false, summary: 'can’t close the last tab' };
      await ctx.tabs.close?.(tab.id);
      if (tab.id === ctx.tabId) {
        const next =
          (await ctx.tabs.list(ctx.windowId)).find((t) => t.active) ??
          list.find((t) => t.id !== tab.id);
        if (next) ctx.tabId = next.id;
      }
      return { ok: true, summary: `closed "${tab.title}"` };
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
    default: {
      const action = PAGE_ACTIONS.has(call.name) ? toPageAction(call) : null;
      if (!action || !ctx.page) return { ok: false, summary: `"${call.name}" isn't available` };
      const r = await ctx.page.act(ctx.tabId, action);
      if (!r.ok) return { ok: false, summary: r.error ?? `${call.name} failed` };
      await ctx.page.stable(ctx.tabId);
      return { ok: true, summary: r.detail ?? `${call.name} done` };
    }
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
  goForward: (tabId, signal) =>
    loadAfter(
      () => tabId,
      () => browser.tabs.goForward(tabId),
      signal,
    ),
  reload: (tabId, signal) =>
    loadAfter(
      () => tabId,
      () => browser.tabs.reload(tabId),
      signal,
    ),
  close: (tabId) => browser.tabs.remove(tabId),
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
