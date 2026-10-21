import type { ChatStreamRequest } from '@/background/chat';
import type { ToolTierSetting } from '@/lib/settings';
import { parseUnionResponse, toolUnionSchema } from '@/prompting/grammars/union';
import { toolGrammar } from '@/prompting/grammars/gbnf';
import { agentSystemPrompt, repairPrompt } from '@/prompting/system';
import { formatToolCall, parseToolCall } from '@/prompting/tools-fallback';
import type { Capabilities, ChatMessage, ToolCall as WireToolCall } from '@/providers/types';
import { normalizeAgentUrl } from './guard';
import { validateArgs } from './schema';
import type { ParseResult, ToolCall, ToolSpec, ToolTier } from './types';

/**
 * The tool harness: everything between "the model produced some output" and
 * "here is a validated call to run". It is the part that has to be good so
 * the model doesn't have to be.
 */

export interface Completion {
  text: string;
  reasoning: string;
  toolCalls: WireToolCall[];
}

export type CompleteFn = (req: ChatStreamRequest, signal: AbortSignal) => Promise<Completion>;

export interface ModelRef {
  instanceId: string;
  model: string;
  caps: Capabilities;
}

export function selectTier(caps: Capabilities, forced: ToolTierSetting = 'auto'): ToolTier {
  if (forced !== 'auto') return forced;
  if (caps.nativeTools) return 'native';
  if (caps.grammar || caps.jsonSchema) return 'constrained';
  return 'text';
}

/** The next tier down when a tier turns out not to work for this model. */
export function downgrade(tier: ToolTier, caps: Capabilities): ToolTier | null {
  if (tier === 'native') return caps.grammar || caps.jsonSchema ? 'constrained' : 'text';
  if (tier === 'constrained') return 'text';
  return null;
}

export function buildDecisionRequest(
  tier: ToolTier,
  model: ModelRef,
  tools: ToolSpec[],
  turn: ChatMessage[],
): ChatStreamRequest {
  const req: ChatStreamRequest = {
    instanceId: model.instanceId,
    model: model.model,
    messages: [{ role: 'system', content: agentSystemPrompt(tier, tools) }, ...turn],
    // Low temperature: decisions, not prose. Short: one action per turn.
    options: { temperature: 0.2, maxTokens: 700 },
  };
  // Thinking makes small models slow without making single steps better;
  // the action carries its own short thought.
  if (model.caps.thinking) req.think = false;
  if (tier === 'native') {
    req.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    }));
  } else if (tier === 'constrained') {
    if (model.caps.grammar) req.grammar = toolGrammar(tools);
    else
      req.responseFormat = {
        type: 'json_schema',
        name: 'agent_step',
        schema: toolUnionSchema(tools),
      };
  }
  return req;
}

const norm = (s: string) =>
  s
    .replace(/^(functions|default_api)\./, '')
    .replace(/[-_\s]/g, '')
    .toLowerCase();

export function resolveTool(tools: ToolSpec[], name: string): ToolSpec | undefined {
  return tools.find((t) => t.name === name) ?? tools.find((t) => norm(t.name) === norm(name));
}

/** Arguments arrive in shapes the schema didn't anticipate; normalize the known ones. */
function preprocess(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (
    name === 'done' &&
    args.result !== undefined &&
    (typeof args.result !== 'object' || Array.isArray(args.result))
  ) {
    return { ...args, result: { value: args.result } };
  }
  if (name === 'extract' && Array.isArray(args.schema)) {
    return { ...args, schema: { items: args.schema } };
  }
  // Log and trace the URL actually visited, not the model's shorthand.
  if ((name === 'navigate' || name === 'newTab') && typeof args.url === 'string') {
    return { ...args, url: normalizeAgentUrl(args.url) };
  }
  return args;
}

function finish(
  tools: ToolSpec[],
  raw: { name: string; args: unknown; thought?: string; thoughtSource?: 'output' | 'reasoning' },
  format: string,
): ParseResult {
  const spec = resolveTool(tools, raw.name);
  if (!spec) {
    return {
      ok: false,
      error: `Unknown action "${raw.name}". Available actions: ${tools.map((t) => t.name).join(', ')}.`,
    };
  }
  let args = raw.args;
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch (err) {
      return {
        ok: false,
        error: `The arguments for ${spec.name} are not valid JSON (${(err as Error).message}).`,
      };
    }
  }
  const v = validateArgs(
    spec.parameters,
    preprocess(spec.name, (args ?? {}) as Record<string, unknown>),
  );
  if (!v.ok) return { ok: false, error: `${spec.name}: ${v.error}` };
  const call: ToolCall = { name: spec.name, args: v.value };
  if (raw.thought) {
    call.thought = raw.thought;
    call.thoughtSource = raw.thoughtSource ?? 'output';
  }
  return { ok: true, call, format };
}

/** Turn one model completion into a validated call, or a specific error. */
export function interpret(tier: ToolTier, c: Completion, tools: ToolSpec[]): ParseResult {
  // Prefer what the model said out loud; fall back to its reasoning for
  // display only (tagged, so the loop never keeps it in memory).
  const reasoning = c.reasoning.trim().slice(0, 500);
  const withThought = (said: string | undefined) => {
    const visible = said?.trim().slice(0, 500);
    if (visible) return { thought: visible, thoughtSource: 'output' as const };
    if (reasoning) return { thought: reasoning, thoughtSource: 'reasoning' as const };
    return {};
  };
  if (tier === 'native' && c.toolCalls.length > 0) {
    const tc = c.toolCalls[0];
    if (tc) {
      return finish(tools, { name: tc.name, args: tc.arguments, ...withThought(c.text) }, 'native');
    }
  }
  if (tier === 'constrained') {
    const u = parseUnionResponse(c.text);
    if (u.ok) {
      return finish(
        tools,
        { name: u.name, args: u.args, ...withThought(u.thought) },
        'constrained',
      );
    }
  }
  // Text tier, or a model that answered in text despite tools / schema.
  const p = parseToolCall(c.text, tools);
  if (!p.ok) return p;
  return finish(
    tools,
    { name: p.call.name, args: p.call.args, ...withThought(p.call.thought) },
    p.format,
  );
}

export interface Decision {
  result: ParseResult;
  /** Raw outputs, for the trace (first attempt, then the repair). */
  raw: string[];
  repaired: boolean;
}

function echo(c: Completion): string {
  if (c.toolCalls.length) {
    return c.toolCalls
      .map((t) => {
        try {
          return formatToolCall({
            name: t.name,
            args: JSON.parse(t.arguments || '{}') as Record<string, unknown>,
          });
        } catch {
          return `${t.name}(${t.arguments})`;
        }
      })
      .join('\n');
  }
  return c.text;
}

/**
 * Ask for one action; if the reply can't be used, show the model its reply
 * and the exact problem, once. Invalid output doesn't cost a step.
 */
export async function decide(opts: {
  tier: ToolTier;
  model: ModelRef;
  tools: ToolSpec[];
  turn: ChatMessage[];
  complete: CompleteFn;
  signal: AbortSignal;
}): Promise<Decision> {
  const req = buildDecisionRequest(opts.tier, opts.model, opts.tools, opts.turn);
  const first = await opts.complete(req, opts.signal);
  const r1 = interpret(opts.tier, first, opts.tools);
  if (r1.ok) return { result: r1, raw: [echo(first)], repaired: false };

  const retry: ChatStreamRequest = {
    ...req,
    messages: [
      ...req.messages,
      { role: 'assistant', content: echo(first) || '(empty reply)' },
      { role: 'user', content: repairPrompt(r1.error, opts.tier) },
    ],
  };
  const second = await opts.complete(retry, opts.signal);
  const r2 = interpret(opts.tier, second, opts.tools);
  return { result: r2, raw: [echo(first), echo(second)], repaired: r2.ok };
}
