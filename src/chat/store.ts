import {
  getDb,
  newId,
  type ConversationRecord,
  type ConversationSettings,
  type MessageRecord,
  type TetherDB,
} from '@/lib/db';
import { deriveTitle, latestLeaf, pathTo } from './tree';

/** Persistence for conversations. Everything is local IndexedDB. */

export async function createConversation(
  init: { instanceId: string; model: string; settings?: ConversationSettings; title?: string },
  db: TetherDB = getDb(),
): Promise<ConversationRecord> {
  const now = Date.now();
  const conv: ConversationRecord = {
    id: newId(),
    title: init.title ?? 'New chat',
    createdAt: now,
    updatedAt: now,
    pinned: 0,
    instanceId: init.instanceId,
    model: init.model,
    activeLeafId: null,
    settings: init.settings ?? {},
  };
  await db.conversations.add(conv);
  return conv;
}

export function conversationMessages(
  conversationId: string,
  db: TetherDB = getDb(),
): Promise<MessageRecord[]> {
  return db.messages.where('conversationId').equals(conversationId).toArray();
}

/** Add a message under `parentId` and make it the visible leaf. */
export async function appendMessage(
  conversationId: string,
  parentId: string | null,
  fields: Omit<MessageRecord, 'id' | 'conversationId' | 'parentId' | 'createdAt'>,
  db: TetherDB = getDb(),
): Promise<MessageRecord> {
  return db.transaction('rw', db.conversations, db.messages, async () => {
    const conv = await db.conversations.get(conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);
    // Strictly increasing timestamps keep sibling order stable within a tick.
    const last = await db.messages
      .where('[conversationId+createdAt]')
      .between([conversationId, -Infinity], [conversationId, Infinity])
      .last();
    const createdAt = Math.max(Date.now(), (last?.createdAt ?? 0) + 1);
    const msg: MessageRecord = { ...fields, id: newId(), conversationId, parentId, createdAt };
    await db.messages.add(msg);
    const isFirstUser = fields.role === 'user' && conv.title === 'New chat' && parentId === null;
    await db.conversations.update(conversationId, {
      activeLeafId: msg.id,
      updatedAt: createdAt,
      ...(isFirstUser ? { title: deriveTitle(fields.content) } : {}),
    });
    return msg;
  });
}

export async function updateMessage(
  id: string,
  patch: Partial<Omit<MessageRecord, 'id' | 'conversationId' | 'parentId'>>,
  db: TetherDB = getDb(),
): Promise<void> {
  await db.messages.update(id, patch);
}

/** Show the branch containing `messageId` (descending to its newest leaf). */
export async function selectBranch(
  conversationId: string,
  messageId: string,
  db: TetherDB = getDb(),
): Promise<void> {
  const messages = await conversationMessages(conversationId, db);
  await db.conversations.update(conversationId, { activeLeafId: latestLeaf(messages, messageId) });
}

/** Copy the path up to `messageId` into a new conversation. */
export async function branchConversation(
  conversationId: string,
  messageId: string,
  db: TetherDB = getDb(),
): Promise<ConversationRecord> {
  return db.transaction('rw', db.conversations, db.messages, async () => {
    const conv = await db.conversations.get(conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);
    const path = pathTo(await conversationMessages(conversationId, db), messageId);
    const now = Date.now();
    const copy: ConversationRecord = {
      ...conv,
      id: newId(),
      title: `${conv.title} (branch)`,
      createdAt: now,
      updatedAt: now,
      pinned: 0,
      activeLeafId: null,
      branchedFrom: { conversationId, messageId },
    };
    let parentId: string | null = null;
    const copies: MessageRecord[] = path.map((m, i) => {
      const id = newId();
      const c: MessageRecord = {
        ...m,
        id,
        conversationId: copy.id,
        parentId,
        createdAt: now + i,
        // An in-flight reply in the source is a finished partial in the copy.
        ...(m.status === 'streaming' ? { status: 'stopped' as const } : {}),
      };
      parentId = id;
      return c;
    });
    copy.activeLeafId = parentId;
    await db.conversations.add(copy);
    await db.messages.bulkAdd(copies);
    return copy;
  });
}

export async function deleteConversation(id: string, db: TetherDB = getDb()): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, async () => {
    await db.messages.where('conversationId').equals(id).delete();
    await db.conversations.delete(id);
  });
}

export async function updateConversation(
  id: string,
  patch: Partial<
    Pick<ConversationRecord, 'title' | 'pinned' | 'instanceId' | 'model' | 'settings'>
  >,
  db: TetherDB = getDb(),
): Promise<void> {
  await db.conversations.update(id, patch);
}

/**
 * Conversations whose title or any message matches `query` (case-insensitive),
 * pinned first, then most recently updated.
 */
export async function listConversations(
  query = '',
  db: TetherDB = getDb(),
): Promise<ConversationRecord[]> {
  const all = await db.conversations.toArray();
  const q = query.trim().toLowerCase();
  let matches = all;
  if (q) {
    const hitIds = new Set<string>();
    await db.messages.each((m) => {
      if (m.content.toLowerCase().includes(q)) hitIds.add(m.conversationId);
    });
    matches = all.filter((c) => c.title.toLowerCase().includes(q) || hitIds.has(c.id));
  }
  return matches.sort((a, b) => b.pinned - a.pinned || b.updatedAt - a.updatedAt);
}

/**
 * Replies that were streaming when their panel closed can never finish.
 * Mark them stopped so the UI doesn't show a reply generating forever.
 */
export async function recoverInterrupted(
  activeIds: Set<string>,
  db: TetherDB = getDb(),
): Promise<number> {
  const stale = (await db.messages.toArray()).filter(
    (m) => m.status === 'streaming' && !activeIds.has(m.id),
  );
  await Promise.all(stale.map((m) => db.messages.update(m.id, { status: 'stopped' })));
  return stale.length;
}

export async function wipeConversations(db: TetherDB = getDb()): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, async () => {
    await db.messages.clear();
    await db.conversations.clear();
  });
}
