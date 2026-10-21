import { browser } from 'wxt/browser';
import type { Completion, CompleteFn } from '@/agent/harness';
import { runAgent, type AgentEvent, type RunResult } from '@/agent/loop';
import { browserTabs, type AgentContext } from '@/agent/tools/execute';
import { READ_ONLY_TOOLS } from '@/agent/tools/specs';
import { dbTraceSink } from '@/agent/trace';
import { sendToTab } from '@/lib/messaging';
import type { StreamHandler } from '@/lib/ports';
import { getSettings } from '@/lib/settings';
import type { Capabilities } from '@/providers/types';
import type { ChatStreamRequest } from './chat';
import { extractTab } from './context';

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
    const it = chat(req, { signal, sender: undefined });
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

export function createAgentStream(deps: {
  chat: StreamHandler<'chat'>;
  capabilities: (instanceId: string, model: string) => Promise<Capabilities>;
}): StreamHandler<'agent'> {
  return async function* agent(req, { signal }) {
    const settings = await getSettings();
    const caps = await deps.capabilities(req.instanceId, req.model);
    const complete = completer(deps.chat);
    const events: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const emit = (e: AgentEvent) => {
      events.push(e);
      wake?.();
    };

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
    };

    const run = runAgent({
      runId: req.runId,
      task: req.task,
      model: { instanceId: req.instanceId, model: req.model, caps },
      tools: READ_ONLY_TOOLS,
      prefs: settings.agent,
      ctx,
      complete,
      trace: dbTraceSink(),
      emit,
      contentBudget: Math.max(
        800,
        Math.min(3000, Math.floor((settings.generation.numCtx || caps.contextLength) / 3)),
      ),
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
