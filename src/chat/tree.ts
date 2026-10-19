import type { MessageRecord } from '@/lib/db';

/**
 * Pure operations over a conversation's message tree. Messages point at
 * their parent; regenerations and edits create siblings. The visible thread
 * is the path from the root to the conversation's active leaf.
 */

const byTime = (a: MessageRecord, b: MessageRecord) =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

export function childrenOf(messages: MessageRecord[], parentId: string | null): MessageRecord[] {
  return messages.filter((m) => m.parentId === parentId).sort(byTime);
}

/** Root → `leafId`. Empty if the leaf is unknown. Guards against cycles. */
export function pathTo(messages: MessageRecord[], leafId: string | null): MessageRecord[] {
  if (!leafId) return [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const path: MessageRecord[] = [];
  const seen = new Set<string>();
  let cur = byId.get(leafId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** Follow the most recent child from `fromId` down to a leaf. */
export function latestLeaf(messages: MessageRecord[], fromId: string): string {
  let id = fromId;
  // At most one step per message: bounds the walk even if pointers are corrupt.
  for (const _ of messages) {
    const last = childrenOf(messages, id).at(-1);
    if (!last) break;
    id = last.id;
  }
  return id;
}

export interface SiblingInfo {
  index: number;
  count: number;
  prevId?: string;
  nextId?: string;
}

export function siblingInfo(messages: MessageRecord[], message: MessageRecord): SiblingInfo {
  const sibs = childrenOf(messages, message.parentId);
  const index = Math.max(
    0,
    sibs.findIndex((s) => s.id === message.id),
  );
  const info: SiblingInfo = { index, count: sibs.length };
  const prev = sibs[index - 1];
  const next = sibs[index + 1];
  if (prev) info.prevId = prev.id;
  if (next) info.nextId = next.id;
  return info;
}

/** First line of the first user message, trimmed to a readable length. */
export function deriveTitle(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return 'New chat';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
