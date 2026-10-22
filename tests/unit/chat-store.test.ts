import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toJson, toMarkdown, safeFilename } from '@/chat/export';
import {
  appendMessage,
  branchConversation,
  conversationMessages,
  createConversation,
  deleteConversation,
  listConversations,
  recoverInterrupted,
  selectBranch,
  updateConversation,
  wipeConversations,
} from '@/chat/store';
import { deriveTitle, latestLeaf, pathTo, siblingInfo } from '@/chat/tree';
import { getDb } from '@/lib/db';

const db = getDb();
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

async function conv() {
  return createConversation({ instanceId: 'ollama', model: 'llama3.2:3b' });
}
const reload = async (id: string) => (await db.conversations.get(id))!;

describe('conversation tree', () => {
  it('appends, titles from the first user message and tracks the active leaf', async () => {
    const c = await conv();
    const u = await appendMessage(c.id, null, {
      role: 'user',
      content: 'How do I   reverse a list in Python?',
    });
    const a = await appendMessage(c.id, u.id, { role: 'assistant', content: 'Use reversed().' });
    const fresh = await reload(c.id);
    expect(fresh.title).toBe('How do I reverse a list in Python?');
    expect(fresh.activeLeafId).toBe(a.id);
    expect(pathTo(await conversationMessages(c.id), fresh.activeLeafId).map((m) => m.id)).toEqual([
      u.id,
      a.id,
    ]);
  });

  it('regenerate = sibling; navigation between siblings follows newest leaves', async () => {
    const c = await conv();
    const u = await appendMessage(c.id, null, { role: 'user', content: 'q1' });
    const a1 = await appendMessage(c.id, u.id, { role: 'assistant', content: 'first' });
    const u2 = await appendMessage(c.id, a1.id, { role: 'user', content: 'follow-up' });
    const a2 = await appendMessage(c.id, u.id, { role: 'assistant', content: 'second' });
    let msgs = await conversationMessages(c.id);
    expect(siblingInfo(msgs, a2)).toEqual({ index: 1, count: 2, prevId: a1.id });
    expect(siblingInfo(msgs, a1)).toEqual({ index: 0, count: 2, nextId: a2.id });

    await selectBranch(c.id, a1.id);
    msgs = await conversationMessages(c.id);
    // Going back to the first answer restores its own continuation.
    expect((await reload(c.id)).activeLeafId).toBe(u2.id);
    expect(latestLeaf(msgs, a2.id)).toBe(a2.id);
  });

  it('branches the path into a new conversation without touching the source', async () => {
    const c = await conv();
    const u = await appendMessage(c.id, null, { role: 'user', content: 'start' });
    const a = await appendMessage(c.id, u.id, {
      role: 'assistant',
      content: 'reply',
      status: 'streaming',
    });
    await appendMessage(c.id, a.id, { role: 'user', content: 'later' });
    const b = await branchConversation(c.id, a.id);
    const copied = await conversationMessages(b.id);
    expect(pathTo(copied, b.activeLeafId).map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', 'start', undefined],
      ['assistant', 'reply', 'stopped'],
    ]);
    expect(b.branchedFrom).toEqual({ conversationId: c.id, messageId: a.id });
    expect(await conversationMessages(c.id)).toHaveLength(3);
  });

  it('keeps sibling order stable when created within the same millisecond', async () => {
    const c = await conv();
    const u = await appendMessage(c.id, null, { role: 'user', content: 'q' });
    const many = [];
    for (let i = 0; i < 5; i++)
      many.push(await appendMessage(c.id, u.id, { role: 'assistant', content: String(i) }));
    const msgs = await conversationMessages(c.id);
    expect(many.map((m) => siblingInfo(msgs, m).index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('survives a corrupted cycle in parent pointers', () => {
    const a = {
      id: 'a',
      conversationId: 'c',
      parentId: 'b',
      role: 'user' as const,
      content: '',
      createdAt: 1,
    };
    const b = {
      id: 'b',
      conversationId: 'c',
      parentId: 'a',
      role: 'user' as const,
      content: '',
      createdAt: 2,
    };
    expect(pathTo([a, b], 'a')).toHaveLength(2);
  });
});

describe('history', () => {
  it('searches titles and message text, pinned first then most recent', async () => {
    // Ordering is by updatedAt in ms: give every write its own timestamp, or
    // two writes in the same millisecond tie and the order flips.
    vi.useFakeTimers({ toFake: ['Date'] });
    let t = Date.now();
    const tick = () => vi.setSystemTime((t += 1000));
    try {
      tick();
      const a = await conv();
      tick();
      await appendMessage(a.id, null, { role: 'user', content: 'Rust lifetimes explained' });
      tick();
      const b = await conv();
      tick();
      await appendMessage(b.id, null, { role: 'user', content: 'Python tips' });
      const bu = (await reload(b.id)).activeLeafId!;
      tick();
      await appendMessage(b.id, bu, {
        role: 'assistant',
        content: 'Unlike Rust, Python has a GC.',
      });
      tick();
      const c = await conv();
      tick();
      await appendMessage(c.id, null, { role: 'user', content: 'Unrelated' });
      tick();
      await updateConversation(a.id, { pinned: 1 });

      expect((await listConversations('rust')).map((x) => x.id)).toEqual([a.id, b.id]);
      expect((await listConversations('')).map((x) => x.id)).toEqual([a.id, c.id, b.id]);
      expect(await listConversations('nothing-matches')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes a conversation with its messages, and wipes everything', async () => {
    const a = await conv();
    await appendMessage(a.id, null, { role: 'user', content: 'x' });
    const b = await conv();
    await deleteConversation(a.id);
    expect(await db.messages.count()).toBe(0);
    expect((await db.conversations.toArray()).map((x) => x.id)).toEqual([b.id]);
    await wipeConversations();
    expect(await db.conversations.count()).toBe(0);
  });

  it('marks replies left streaming by a closed panel as stopped', async () => {
    const c = await conv();
    const u = await appendMessage(c.id, null, { role: 'user', content: 'x' });
    const live = await appendMessage(c.id, u.id, {
      role: 'assistant',
      content: 'par',
      status: 'streaming',
    });
    const dead = await appendMessage(c.id, u.id, {
      role: 'assistant',
      content: 'tial',
      status: 'streaming',
    });
    expect(await recoverInterrupted(new Set([live.id]))).toBe(1);
    expect((await db.messages.get(dead.id))?.status).toBe('stopped');
    expect((await db.messages.get(live.id))?.status).toBe('streaming');
  });
});

describe('titles and export', () => {
  it('derives readable titles', () => {
    expect(deriveTitle('  ')).toBe('New chat');
    expect(deriveTitle('Short one')).toBe('Short one');
    const long = deriveTitle(
      'Explain the difference between processes and threads in operating systems please',
    );
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/\s…$/);
  });

  it('exports the visible branch as Markdown and the whole tree as JSON', async () => {
    const c = await conv();
    const u = await appendMessage(c.id, null, { role: 'user', content: 'Hi' });
    await appendMessage(c.id, u.id, { role: 'assistant', content: 'old answer' });
    await appendMessage(c.id, u.id, {
      role: 'assistant',
      content: 'Hello!',
      reasoning: 'greet them',
      model: 'llama3.2:3b',
    });
    const fresh = await reload(c.id);
    const msgs = await conversationMessages(c.id);
    const md = toMarkdown(fresh, msgs);
    expect(md).toContain('# Hi');
    expect(md).toContain('## You\n\nHi');
    expect(md).toContain('## llama3.2:3b\n\nHello!');
    expect(md).not.toContain('old answer');
    expect(md).not.toContain('greet them');
    expect(toMarkdown(fresh, msgs, { includeReasoning: true })).toContain('greet them');
    const json = toJson(fresh, msgs);
    expect(json.format).toBe('tether.conversation.v1');
    expect(json.messages).toHaveLength(3);
    expect(safeFilename('Hi: <script>/etc', 'md')).toBe('Hi-scriptetc.md');
    expect(safeFilename('???', 'json')).toBe('conversation.json');
  });
});
