import type { ConversationRecord, MessageRecord } from '@/lib/db';
import { pathTo } from './tree';

export const EXPORT_FORMAT = 'tether.conversation.v1';

export interface ConversationExport {
  format: typeof EXPORT_FORMAT;
  exportedAt: string;
  conversation: ConversationRecord;
  /** The whole tree, including other branches. */
  messages: MessageRecord[];
}

/** The visible branch as Markdown. Reasoning is included only when asked. */
export function toMarkdown(
  conv: ConversationRecord,
  messages: MessageRecord[],
  opts: { includeReasoning?: boolean } = {},
): string {
  const lines = [
    `# ${conv.title}`,
    '',
    `_${conv.model} · ${new Date(conv.createdAt).toISOString()}_`,
    '',
  ];
  for (const m of pathTo(messages, conv.activeLeafId)) {
    if (m.role === 'system') continue;
    lines.push(`## ${m.role === 'user' ? 'You' : (m.model ?? 'Assistant')}`, '');
    if (opts.includeReasoning && m.reasoning) {
      lines.push(
        '<details><summary>Reasoning</summary>',
        '',
        m.reasoning.trim(),
        '',
        '</details>',
        '',
      );
    }
    lines.push(
      m.content.trim() || (m.status === 'error' ? `_Error: ${m.error?.message ?? 'unknown'}_` : ''),
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function toJson(conv: ConversationRecord, messages: MessageRecord[]): ConversationExport {
  return {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    conversation: conv,
    messages: [...messages].sort((a, b) => a.createdAt - b.createdAt),
  };
}

export function safeFilename(title: string, ext: string): string {
  const base = title
    .replace(/[^\p{L}\p{N}\-_ ]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${base || 'conversation'}.${ext}`;
}

/** Save via a temporary object-URL anchor; no `downloads` permission needed. */
export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
