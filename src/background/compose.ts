import type { ChatStreamRequest } from '@/background/chat';
import { composeMessages, type ComposeRequest } from '@/compose/prompt';
import { TetherError } from '@/lib/errors';
import type { StreamHandler } from '@/lib/ports';
import { getSettings, matchSiteRule } from '@/lib/settings';

/**
 * The `compose` stream (inline compose in a page's text field). Picks the
 * model the way the panel does: a site rule for the page, else the current
 * selection. The content script shows only `text` events, so reasoning
 * never reaches the field.
 */

export interface ComposeDeps {
  chat: StreamHandler<'chat'>;
  capabilities: (instanceId: string, model: string) => Promise<{ thinking?: boolean }>;
}

const MAX_DRAFT_CHARS = 40_000;

export async function buildComposeRequest(req: ComposeRequest): Promise<ChatStreamRequest> {
  if (req.mode === 'prompt' && !req.instruction?.trim()) {
    throw new TetherError('E_BAD_REQUEST', 'Type what you want written first.');
  }
  const s = await getSettings();
  const pick = matchSiteRule(s.siteRules, req.url) ?? s.selection;
  if (!pick.instanceId || !pick.model) {
    throw new TetherError('E_NO_MODEL', 'Open the Tether side panel and choose a model first.');
  }
  const draft: ComposeRequest = {
    ...req,
    text: req.text.slice(0, MAX_DRAFT_CHARS),
    ...(req.context ? { context: req.context.slice(0, MAX_DRAFT_CHARS) } : {}),
  };
  return {
    instanceId: pick.instanceId,
    model: pick.model,
    messages: composeMessages(draft),
    options: {
      // Edits should stay close to the draft; new text gets the usual temperature.
      temperature: req.mode === 'prompt' ? s.generation.temperature : 0.3,
      maxTokens: Math.min(s.generation.maxTokens, 2048),
      topP: s.generation.topP,
      ...(s.generation.numCtx > 0 ? { numCtx: s.generation.numCtx } : {}),
    },
    think: false,
  };
}

export function createComposeStream(deps: ComposeDeps): StreamHandler<'compose'> {
  return async function* compose(req, ctx) {
    const request = await buildComposeRequest(req);
    const caps = await deps.capabilities(request.instanceId, request.model).catch(() => undefined);
    // `think: false` only means something to thinking models (others may reject it).
    if (!caps?.thinking) delete request.think;
    return yield* deps.chat(request, ctx);
  };
}
