import { browser } from 'wxt/browser';
import type { Completion, CompleteFn } from '@/agent/harness';
import { runAgent, type AgentEvent, type ConfirmRequest, type RunResult } from '@/agent/loop';
import { browserTabs, type AgentContext, type PageApi } from '@/agent/tools/execute';
import type { ActResult, PageAction } from '@/agent/page/types';
import { COMPUTER_TOOLS } from '@/agent/tools/specs';
import { dbTraceSink } from '@/agent/trace';
import { sendToTab } from '@/lib/messaging';
import { type StreamHandler, directContext } from '@/lib/ports';
import { getSettings } from '@/lib/settings';
import type { Capabilities } from '@/providers/types';
import type { ChatStreamRequest } from './chat';
import { ensureBridge, extractTab } from './context';
import { cdpInsertText, cdpKey, cdpMouse, debuggerAvailable, detachAll } from './debugger';

/** Panel → running agent. */
export interface AgentInput {
  type: 'confirm';
  id: string;
  approved: boolean;
}

export interface AgentRunRequest {
  runId: string;
  task: string;
  instanceId: string;
  model: string;
  tabId: number;
  windowId: number;
}

/** Drain a chat stream into one completion (agent decisions don't stream to the UI). */
export function completer(chat: StreamHandler<'chat'>): CompleteFn {
  return async (req: ChatStreamRequest, signal: AbortSignal): Promise<Completion> => {
    const out: Completion = { text: '', reasoning: '', toolCalls: [] };
    const it = chat(req, directContext(signal));
    for (;;) {
      const step = await it.next();
      if (step.done) return out;
      const ev = step.value;
      if (ev.type === 'text') out.text += ev.text;
      else if (ev.type === 'reasoning') out.reasoning += ev.text;
      else if (ev.type === 'reclassify-reasoning') {
        out.reasoning += out.text;
        out.text = '';
      } else if (ev.type === 'tool_calls') out.toolCalls.push(...ev.calls);
    }
  };
}

/** Running agents by run id, so the page banner and Esc can stop one. */
const runs = new Map<string, { controller: AbortController; tabIds: Set<number> }>();

export function stopRun(runId: string): boolean {
  const r = runs.get(runId);
  r?.controller.abort(new DOMException('Stopped by the user', 'AbortError'));
  return !!r;
}

/** Stop whichever run controls this tab (Esc / Stop in the page banner). */
export function stopRunInTab(tabId: number): boolean {
  for (const [id, r] of runs) if (r.tabIds.has(tabId)) return stopRun(id);
  return false;
}

async function banner(tabId: number, on: boolean, runId: string): Promise<void> {
  try {
    await ensureBridge(tabId);
    await sendToTab(tabId, 'content:agent-banner', { on, runId }, 0);
  } catch {
    // A page we can't script just doesn't get a banner; the panel still shows the run.
  }
}

/** The page engine through the content script, with the chosen input backend. */
function pageApi(backend: 'scripting' | 'debugger', onFallback: (why: string) => void): PageApi {
  let useDebugger = backend === 'debugger';
  const viaContent = async (tabId: number, action: PageAction): Promise<ActResult> =>
    sendToTab(tabId, 'content:act', { action }, 0);
  return {
    snapshot: async (tabId, opts) => {
      await ensureBridge(tabId);
      return sendToTab(tabId, 'content:snapshot', { opts }, 0);
    },
    act: async (tabId, action) => {
      await ensureBridge(tabId);
      if (useDebugger && !(await debuggerAvailable())) {
        useDebugger = false;
        onFallback('Trusted input is on but the debugger permission isn’t granted; using scripted input.');
      }
      const trusted = useDebugger && (action.kind === 'click' || action.kind === 'rightClick' || action.kind === 'hover' || action.kind === 'type' || action.kind === 'pressKey');
      if (!trusted) return viaContent(tabId, action);
      if (action.kind === 'pressKey') {
        if (action.id) await viaContent(tabId, { kind: 'hover', id: action.id });
        return (await cdpKey(tabId, action.key)) ? { ok: true, detail: `pressed ${action.key}` } : viaContent(tabId, action);
      }
      const point = await sendToTab(tabId, 'content:point', { id: action.id }, 0);
      if (!point) return { ok: false, error: `Element [${action.id}] is no longer on the page.` };
      if (action.kind === 'type') {
        await cdpMouse(tabId, point, 'click');
        await cdpInsertText(tabId, action.text);
        if (action.submit) await cdpKey(tabId, 'Enter');
        return { ok: true, detail: `typed ${action.text.length} chars${action.submit ? ' and pressed Enter' : ''} (trusted input)` };
      }
      await cdpMouse(tabId, point, action.kind);
      return { ok: true, detail: `${action.kind} (trusted input)` };
    },
    stable: async (tabId) => {
      try {
        await sendToTab(tabId, 'content:stable', {}, 0);
      } catch {
        // Navigation tore the old page down mid-wait: that's settled enough.
      }
    },
  };
}

export function createAgentStream(deps: {
  chat: StreamHandler<'chat'>;
  capabilities: (instanceId: string, model: string) => Promise<Capabilities>;
}): StreamHandler<'agent'> {
  return async function* agent(req, { signal: portSignal, onInput }) {
    const settings = await getSettings();
    const caps = await deps.capabilities(req.instanceId, req.model);
    const complete = completer(deps.chat);
    const events: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const emit = (e: AgentEvent) => {
      events.push(e);
      wake?.();
    };

    // Stopped by the panel (port closes) or by the page banner / Esc.
    const controller = new AbortController();
    const signal = AbortSignal.any([portSignal, controller.signal]);
    const entry = { controller, tabIds: new Set<number>([req.tabId]) };
    runs.set(req.runId, entry);

    // Confirmations are answered by the panel over this port.
    const waiting = new Map<string, (approved: boolean) => void>();
    const unsubscribe = onInput((data) => {
      const msg = data as Partial<AgentInput>;
      if (msg.type === 'confirm' && typeof msg.id === 'string') {
        waiting.get(msg.id)?.(msg.approved === true);
        waiting.delete(msg.id);
      }
    });
    const confirm = (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        waiting.set(request.id, resolve);
        signal.addEventListener('abort', () => {
          resolve(false);
        }, { once: true });
      });

    const ctx: AgentContext = {
      tabId: req.tabId,
      windowId: req.windowId,
      signal,
      policy: settings.agent,
      readPage: (tabId) => extractTab(tabId),
      waitForText: async (tabId, text, timeoutMs) => {
        try {
          return (await sendToTab(tabId, 'content:wait-text', { text, timeoutMs }, 0)).found;
        } catch {
          return false;
        }
      },
      complete: async (r) => {
        const c = await complete({ ...r, instanceId: req.instanceId, model: req.model }, signal);
        return c.text;
      },
      tabs: browserTabs,
      page: pageApi(settings.agent.inputBackend, (why) => {
        emit({ type: 'warning', message: why });
      }),
    };

    // Keep the banner on whichever tab the agent is driving.
    let bannerTab = req.tabId;
    await banner(bannerTab, true, req.runId);
    const followTab = setInterval(() => {
      if (ctx.tabId !== bannerTab) {
        void banner(bannerTab, false, req.runId);
        bannerTab = ctx.tabId;
        entry.tabIds.add(bannerTab);
        void banner(bannerTab, true, req.runId);
      }
    }, 500);

    const run = runAgent({
      runId: req.runId,
      task: req.task,
      model: { instanceId: req.instanceId, model: req.model, caps },
      tools: COMPUTER_TOOLS,
      prefs: settings.agent,
      ctx,
      complete,
      trace: dbTraceSink(),
      emit,
      confirm,
      contentBudget: Math.max(600, Math.min(2000, Math.floor((settings.generation.numCtx || caps.contextLength) / 5))),
      elementBudget: Math.max(1000, Math.min(4000, Math.floor((settings.generation.numCtx || caps.contextLength) / 3))),
    }).finally(() => {
      clearInterval(followTab);
      unsubscribe();
      runs.delete(req.runId);
      void banner(bannerTab, false, req.runId);
      void detachAll();
    });

    let finished: RunResult | undefined;
    void run.then((r) => {
      finished = r;
      wake?.();
    });
    for (;;) {
      const next = events.shift();
      if (next) {
        yield next;
        continue;
      }
      if (finished) return finished;
      await new Promise<void>((r) => {
        wake = r;
      });
      wake = undefined;
    }
  };
}

/** The tab an agent run starts in: the page the user is looking at. */
export async function agentStartTab(
  windowId?: number,
): Promise<{ tabId: number; windowId: number } | null> {
  const own = browser.runtime.getURL('/');
  const tabs = await browser.tabs.query(
    windowId === undefined ? { currentWindow: true } : { windowId },
  );
  const pick =
    tabs.find((t) => t.active && !(t.url ?? '').startsWith(own)) ??
    tabs.find((t) => !(t.url ?? '').startsWith(own));
  return pick?.id === undefined ? null : { tabId: pick.id, windowId: pick.windowId };
}
