import type { ChatMetrics } from '@/background/chat';
import { isAbortError } from '@/lib/errors';
import { sendMessage } from '@/lib/messaging';
import { openStream, type StreamHandle } from '@/lib/ports';
import { getSettings, matchSiteRule } from '@/lib/settings';
import type { ConversationRecord, MessageRecord } from '@/lib/db';
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
const inFlight = new Map<string, StreamHandle<'chat'>>();

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

/** Append a user message under the visible leaf and answer it. */
export async function sendUserMessage(conv: ConversationRecord, text: string): Promise<void> {
  const user = await appendMessage(conv.id, conv.activeLeafId, { role: 'user', content: text });
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
  const edited = await appendMessage(conv.id, user.parentId, { role: 'user', content: text });
  await generateReply(conv, edited);
}
