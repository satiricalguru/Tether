import Dexie, { type EntityTable } from 'dexie';

/**
 * IndexedDB schema. Large and append-heavy data lives here; small settings
 * live in chrome.storage.local (see settings.ts).
 *
 * Schema changes: add a new `this.version(n)` block, never edit an old one.
 */

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: 0 | 1; // IndexedDB can't index booleans
  providerId?: string;
  model?: string;
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface MessageRecord {
  id: string;
  conversationId: string;
  /** Parent message id; branches share a parent. */
  parentId: string | null;
  role: MessageRole;
  content: string;
  createdAt: number;
}

export interface TraceRecord {
  id: string;
  runId: string;
  step: number;
  createdAt: number;
  url: string;
  action: string;
  args: unknown;
  elementName?: string;
  beforeHash?: string;
  afterHash?: string;
  outcome: 'ok' | 'error' | 'blocked' | 'noop';
  note?: string;
  thumbnail?: string;
}

export interface EmbeddingRecord {
  id: string;
  url: string;
  contentHash: string;
  model: string;
  chunkIndex: number;
  text: string;
  vector: Float32Array;
}

export class TetherDB extends Dexie {
  conversations!: EntityTable<ConversationRecord, 'id'>;
  messages!: EntityTable<MessageRecord, 'id'>;
  traces!: EntityTable<TraceRecord, 'id'>;
  embeddings!: EntityTable<EmbeddingRecord, 'id'>;

  constructor(name = 'tether') {
    super(name);
    this.version(1).stores({
      conversations: 'id, updatedAt, pinned',
      messages: 'id, conversationId, [conversationId+createdAt]',
      traces: 'id, runId, [runId+step], createdAt',
      embeddings: 'id, [url+contentHash+model], url',
    });
  }
}

let instance: TetherDB | undefined;

export function getDb(): TetherDB {
  instance ??= new TetherDB();
  return instance;
}

export function newId(): string {
  return crypto.randomUUID();
}
