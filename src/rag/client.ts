import type { Attachment } from '@/context/attachments';
import { createLogger } from '@/lib/logger';
import { sendMessage } from '@/lib/messaging';
import { retrievable } from './fit';

const log = createLogger('rag');

/**
 * At send time: replace page/tab/PDF attachments that the budget cut from the
 * top with the parts most relevant to the question (background `bg:rag:fit`).
 * `fitted` are the attachments as budgeted, `originals` the untrimmed drafts.
 * If retrieval can't run, the budgeted attachments go as they are.
 */
export async function withRetrieval(
  fitted: Attachment[],
  originals: Attachment[],
  question: string,
  instanceId: string,
): Promise<Attachment[]> {
  const items = fitted.flatMap((a) => {
    const original = originals.find((o) => o.id === a.id);
    return original && a.originalTokens !== undefined && retrievable(a)
      ? [{ attachment: original, share: a.tokens }]
      : [];
  });
  if (!items.length || !instanceId) return fitted;
  try {
    const out = await sendMessage('bg:rag:fit', { instanceId, question, items });
    return fitted.map((a) => out.find((o) => o.id === a.id) ?? a);
  } catch (err) {
    log.warn('retrieval unavailable; sending trimmed text', err);
    return fitted;
  }
}
