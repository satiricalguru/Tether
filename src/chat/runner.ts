import type { ChatMetrics } from '@/background/chat';
import { isAbortError } from '@/lib/errors';
import { sendMessage } from '@/lib/messaging';
import { openStream } from '@/lib/ports';
import { getSettings, matchSiteRule } from '@/lib/settings';
import type { Attachment } from '@/context/attachments';
import type { AgentRunRecord, ConversationRecord, MessageRecord } from '@/lib/db';
import { currentPageTab } from '@/platform/tabs';
import { buildRequest } from './request';
import { appendMessage, conversationMessages, createConversation, updateMessage } from './store';
import { pathTo } from './tree';
import { useChatUi } from './ui-store';

/**
 * Drives generations for the side panel: creates the assistant record,
 * streams the `chat` port into it, and records the outcome. Lives in the UI
 * so a closed panel cleanly aborts (the partial reply is kept as stopped).
 */

const FLUSH_MS = 250;
const inFlight = new Map<string, { abort: () => void }>();

/** Ids of replies this panel is generating (for crash recovery on open). */
export function activeReplyIds(): Set<string> {
  return new Set(inFlight.keys());
}

export function isGenerating(conversationId: string, messages: MessageRecord[]): boolean {
  return messages.some((m) => m.conversationId === conversationId && inFlight.has(m.id));
}

export function stopAll(): void {
  for (const h of inFlight.values()) h.abort();
}

export function stopReply(messageId: string): void {
  inFlight.get(messageId)?.abort();
}

/** Start a conversation using the site rule for `pageUrl`, else the selected model. */
export async function startConversation(pageUrl?: string): Promise<ConversationRecord> {
  const s = await getSettings();
  const rule = matchSiteRule(s.siteRules, pageUrl);
  const pick = rule ?? s.selection;
  if (!pick.instanceId || !pick.model) throw new Error('Choose a model first');
  return createConversation({ instanceId: pick.instanceId, model: pick.model });
}

/** Generate an assistant reply to `parent` (a user message). */
export async function generateReply(
  conv: ConversationRecord,
  parent: MessageRecord,
): Promise<void> {
  const settings = await getSettings();
  const setLive = useChatUi.getState().setLive;

  const reply = await appendMessage(conv.id, parent.id, {
    role: 'assistant',
    content: '',
    status: 'streaming',
    instanceId: conv.instanceId,
    model: conv.model,
  });
  setLive(reply.id, 'waiting');

  let content = '';
  let reasoning = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    void updateMessage(reply.id, { content, reasoning, status: 'streaming' });
  };
  const schedule = () => {
    timer ??= setTimeout(flush, FLUSH_MS);
  };

  try {
    const caps = await sendMessage('bg:providers:capabilities', {
      instanceId: conv.instanceId,
      model: conv.model,
    });
    const thread = pathTo(await conversationMessages(conv.id), parent.id);
    const { request } = buildRequest({
      conversation: conv,
      thread,
      defaults: settings.generation,
      systemPrompt: settings.systemPrompt,
      reasoning: settings.reasoning,
      modelThinks: caps.thinking ?? false,
      contextLength: caps.contextLength,
    });

    const stream = openStream('chat', request);
    inFlight.set(reply.id, stream);
    for await (const ev of stream) {
      switch (ev.type) {
        case 'status':
          setLive(reply.id, ev.status);
          break;
        case 'text':
          content += ev.text;
          schedule();
          break;
        case 'reasoning':
          reasoning += ev.text;
          schedule();
          break;
        case 'reclassify-reasoning':
          reasoning += content;
          content = '';
          schedule();
          break;
        case 'tool_calls':
        case 'finish':
          break;
      }
    }
    const { metrics }: { metrics: ChatMetrics } = await stream.done;
    clearTimeout(timer);
    await updateMessage(reply.id, { content, reasoning, status: 'done', metrics });
  } catch (err) {
    clearTimeout(timer);
    if (isAbortError(err)) {
      await updateMessage(reply.id, { content, reasoning, status: 'stopped' });
    } else {
      const e = err as Error & { code?: string };
      await updateMessage(reply.id, {
        content,
        reasoning,
        status: 'error',
        error: { message: e.message, ...(e.code ? { code: e.code } : {}) },
      });
    }
  } finally {
    inFlight.delete(reply.id);
    setLive(reply.id, null);
  }
}

/** Append a user message (with any attached context) under the visible leaf and answer it. */
export async function sendUserMessage(
  conv: ConversationRecord,
  text: string,
  attachments: Attachment[] = [],
): Promise<void> {
  const user = await appendMessage(conv.id, conv.activeLeafId, {
    role: 'user',
    content: text,
    ...(attachments.length ? { attachments } : {}),
  });
  await generateReply(conv, user);
}

/** Regenerate: a new assistant sibling under the same user message. */
export async function regenerate(
  conv: ConversationRecord,
  assistant: MessageRecord,
): Promise<void> {
  const parent = (await conversationMessages(conv.id)).find((m) => m.id === assistant.parentId);
  if (parent) await generateReply(conv, parent);
}

/** Edit and resend: a new user sibling with the edited text, then a reply. */
export async function editAndResend(
  conv: ConversationRecord,
  user: MessageRecord,
  text: string,
): Promise<void> {
  // The edit keeps the context the original question was asked with.
  const edited = await appendMessage(conv.id, user.parentId, {
    role: 'user',
    content: text,
    ...(user.attachments?.length ? { attachments: user.attachments } : {}),
  });
  await generateReply(conv, edited);
}

/** Start a browsing-agent run for `task` on the user's current page. */
export async function startAgentRun(conv: ConversationRecord, task: string): Promise<void> {
  const setLive = useChatUi.getState().setLive;
  const user = await appendMessage(conv.id, conv.activeLeafId, {
    role: 'user',
    content: task,
    agentTask: true,
  });
  const runId = crypto.randomUUID();
  const agent: AgentRunRecord = { runId, status: 'running', steps: [] };
  const reply = await appendMessage(conv.id, user.id, {
    role: 'assistant',
    content: '',
    status: 'streaming',
    agent,
    instanceId: conv.instanceId,
    model: conv.model,
  });
  setLive(reply.id, 'waiting');
  const save = () => updateMessage(reply.id, { agent: { ...agent, steps: [...agent.steps] } });
  try {
    const tab = await currentPageTab();
    if (tab?.id === undefined) throw new Error('Open the page you want the agent to start on.');
    const stream = openStream('agent', {
      runId,
      task,
      instanceId: conv.instanceId,
      model: conv.model,
      tabId: tab.id,
      windowId: tab.windowId,
    });
    inFlight.set(reply.id, stream);
    for await (const ev of stream) {
      if (ev.type === 'tier') agent.tier = ev.tier;
      else if (ev.type === 'thinking') setLive(reply.id, 'generating');
      else agent.steps.push(ev.step);
      await save();
    }
    const r = await stream.done;
    agent.status = r.status;
    if (r.result !== undefined) agent.result = r.result;
    await updateMessage(reply.id, {
      content: r.summary,
      status: r.status === 'failed' ? 'error' : r.status === 'stopped' ? 'stopped' : 'done',
      ...(r.status === 'failed' ? { error: { message: r.summary, code: 'E_AGENT_FAILED' } } : {}),
      agent: { ...agent, steps: [...agent.steps] },
    });
  } catch (err) {
    agent.status = isAbortError(err) ? 'stopped' : 'failed';
    await updateMessage(reply.id, {
      status: isAbortError(err) ? 'stopped' : 'error',
      ...(isAbortError(err) ? {} : { error: { message: (err as Error).message } }),
      agent: { ...agent, steps: [...agent.steps] },
    });
  } finally {
    inFlight.delete(reply.id);
    setLive(reply.id, null);
  }
}
