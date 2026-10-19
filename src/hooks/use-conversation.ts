import { useLiveQuery } from 'dexie-react-hooks';
import { conversationMessages, listConversations } from '@/chat/store';
import { pathTo } from '@/chat/tree';
import { getDb, type ConversationRecord, type MessageRecord } from '@/lib/db';

export interface ConversationView {
  conversation: ConversationRecord | undefined;
  /** Every message in the tree (for sibling info). */
  messages: MessageRecord[];
  /** Root → active leaf. */
  thread: MessageRecord[];
  loading: boolean;
}

/** Live view of one conversation: re-renders as the runner writes. */
export function useConversation(id: string | null): ConversationView {
  const data = useLiveQuery(async () => {
    if (!id) return { conversation: undefined, messages: [] as MessageRecord[] };
    const [conversation, messages] = await Promise.all([
      getDb().conversations.get(id),
      conversationMessages(id),
    ]);
    return { conversation, messages };
  }, [id]);
  const conversation = data?.conversation;
  const messages = data?.messages ?? [];
  return {
    conversation,
    messages,
    thread: conversation ? pathTo(messages, conversation.activeLeafId) : [],
    loading: data === undefined,
  };
}

export function useConversationList(query: string): ConversationRecord[] | undefined {
  return useLiveQuery(() => listConversations(query), [query]);
}
