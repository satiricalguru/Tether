import { afterEach, describe, expect, it } from 'vitest';
import { TetherDB, newId } from '@/lib/db';

let db: TetherDB | undefined;

afterEach(async () => {
  if (db) {
    db.close();
    await db.delete();
  }
});

describe('db', () => {
  it('opens with every table', async () => {
    db = new TetherDB(`test-${newId()}`);
    await db.open();
    expect(db.tables.map((t) => t.name).sort()).toEqual([
      'conversations',
      'embeddings',
      'messages',
      'traces',
    ]);
  });

  it('queries messages in order through the compound index', async () => {
    db = new TetherDB(`test-${newId()}`);
    const conversationId = newId();
    await db.messages.bulkAdd([
      { id: 'b', conversationId, parentId: 'a', role: 'assistant', content: 'hi', createdAt: 2 },
      { id: 'a', conversationId, parentId: null, role: 'user', content: 'hello', createdAt: 1 },
      { id: 'z', conversationId: 'other', parentId: null, role: 'user', content: '', createdAt: 0 },
    ]);
    const rows = await db.messages
      .where('[conversationId+createdAt]')
      .between([conversationId, -Infinity], [conversationId, Infinity])
      .toArray();
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('stores Float32Array vectors losslessly', async () => {
    db = new TetherDB(`test-${newId()}`);
    const vector = new Float32Array([0.25, -1, 3.5]);
    await db.embeddings.add({
      id: 'e1',
      url: 'https://x',
      contentHash: 'h',
      model: 'nomic-embed-text',
      chunkIndex: 0,
      text: 't',
      vector,
    });
    const row = await db.embeddings.get('e1');
    expect(Array.from(row?.vector ?? [])).toEqual([0.25, -1, 3.5]);
  });

  it('generates unique ids', () => {
    expect(newId()).not.toBe(newId());
  });
});
