import type { Attachment } from './attachments';
import type { PageExtract } from './extract';
import { scanForInjection } from './injection';
import { estimateTokens } from './tokens';

/** Build an attachment from extracted text, scanning visible and hidden text. */
export function toAttachment(
  kind: Attachment['kind'],
  input: { title: string; url?: string; text: string; hiddenChars?: number; hiddenSample?: string },
): Attachment {
  const a: Attachment = {
    id: crypto.randomUUID(),
    kind,
    title: [input.title, input.url].find((t) => t?.trim()) ?? 'Untitled',
    text: input.text,
    tokens: estimateTokens(input.text),
    warnings: scanForInjection(input.text),
  };
  if (input.url) a.url = input.url;
  if (input.hiddenChars) {
    a.hiddenExcluded = {
      chars: input.hiddenChars,
      suspicious: scanForInjection(input.hiddenSample ?? '').length > 0,
    };
  }
  return a;
}

export function toAttachmentFromExtract(kind: Attachment['kind'], page: PageExtract): Attachment {
  return toAttachment(kind, {
    title: page.title,
    url: page.url,
    text: page.text,
    // Hidden text matters for the page itself, not a user's selection.
    ...(kind === 'selection'
      ? {}
      : { hiddenChars: page.hiddenChars, hiddenSample: page.hiddenSample }),
  });
}
