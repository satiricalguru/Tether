import Dexie, { type EntityTable } from 'dexie';
import type { ChatMetrics } from '@/background/chat';
import type { RunStatus, StepEvent } from '@/agent/loop';
import type { ToolTier } from '@/agent/types';
import type { Attachment } from '@/context/attachments';

/**
 * IndexedDB schema. Large and append-heavy data lives here; small settings
 * live in chrome.storage.local (see settings.ts).
 *
 * Schema changes: add a new `this.version(n)` block, never edit an old one.
 */

/** Per-conversation overrides of the global generation settings. */
export interface ConversationSettings {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: 0 | 1; // IndexedDB can't index booleans
  instanceId: string;
  model: string;
  /** Leaf of the visible branch; null for an empty conversation. */
  activeLeafId: string | null;
  settings: ConversationSettings;
  /** Set when the conversation was branched from another one. */
  branchedFrom?: { conversationId: string; messageId: string };
}

/** An agent run, stored on the assistant message that reports it. */
export interface AgentRunRecord {
  runId: string;
  status: RunStatus | 'running';
  tier?: ToolTier;
  steps: StepEvent[];
  result?: unknown;
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface MessageRecord {
  id: string;
  conversationId: string;
  /** Parent message id; regenerations and edits are siblings under one parent. */
  parentId: string | null;
  role: MessageRole;
  content: string;
  createdAt: number;
  /** Model reasoning, kept apart so it is never sent back to the model. */
  reasoning?: string;
  status?: MessageStatus;
  error?: { message: string; code?: string };
  metrics?: ChatMetrics;
  /** Page/selection/PDF context sent with a user message. */
  attachments?: Attachment[];
  /** Set on the assistant message of an agent run. */
  agent?: AgentRunRecord;
  /** Set on a user message that was sent as an agent task. */
  agentTask?: boolean;
  /** Which model produced an assistant message. */
  instanceId?: string;
  model?: string;
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
