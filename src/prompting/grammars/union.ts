import type { JsonSchema, ToolSpec } from '@/agent/types';

/**
 * Tier-2 output contract as JSON Schema: one step is
 *
 *   {"thought": "...", "action": "<tool>", "args": {...}}
 *
 * expressed as `anyOf` with one branch per tool, so the server's
 * schema-constrained decoder (Ollama `format`, llama.cpp `json_schema`,
 * LM Studio / vLLM `response_format`) can only produce a valid tool name
 * with arguments of the right shape.
 *
 * Action names use `enum: [name]` rather than `const`: llama.cpp's
 * json-schema-to-grammar (which Ollama uses) supports both, but enum is the
 * more widely supported keyword across the other OpenAI-compatible
 * backends' guided-decoding engines. Adding both would be redundant.
 */

export const DEFAULT_MAX_THOUGHT = 400;

function toJsonSchema(s: JsonSchema): Record<string, unknown> {
  switch (s.type) {
    case 'string': {
      const out: Record<string, unknown> = { type: 'string' };
      if (s.enum) out.enum = [...s.enum];
      if (s.minLength !== undefined) out.minLength = s.minLength;
      if (s.maxLength !== undefined) out.maxLength = s.maxLength;
      if (s.description) out.description = s.description;
      return out;
    }
    case 'integer':
    case 'number': {
      const out: Record<string, unknown> = { type: s.type };
      if (s.minimum !== undefined) out.minimum = s.minimum;
      if (s.maximum !== undefined) out.maximum = s.maximum;
      if (s.description) out.description = s.description;
      return out;
    }
    case 'boolean':
      return s.description ? { type: 'boolean', description: s.description } : { type: 'boolean' };
    case 'array': {
      const out: Record<string, unknown> = { type: 'array', items: toJsonSchema(s.items) };
      if (s.maxItems !== undefined) out.maxItems = s.maxItems;
      if (s.description) out.description = s.description;
      return out;
    }
    case 'object': {
      const free = s.additionalProperties === true;
      if (free && Object.keys(s.properties).length === 0) {
        return s.description ? { type: 'object', description: s.description } : { type: 'object' };
      }
      const out: Record<string, unknown> = {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]),
        ),
        required: [...(s.required ?? [])],
        additionalProperties: free,
      };
      if (s.description) out.description = s.description;
      return out;
    }
  }
}

export function toolUnionSchema(
  tools: ToolSpec[],
  opts: { maxThoughtChars?: number } = {},
): Record<string, unknown> {
  const maxLength = opts.maxThoughtChars ?? DEFAULT_MAX_THOUGHT;
  return {
    anyOf: tools.map((t) => ({
      type: 'object',
      properties: {
        thought: { type: 'string', maxLength },
        action: { type: 'string', enum: [t.name] },
        args: toJsonSchema(t.parameters),
      },
      required: ['thought', 'action', 'args'],
      additionalProperties: false,
    })),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** First balanced `{...}` in `text`, respecting strings and escapes. */
export function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  for (let s = start; s !== -1; s = text.indexOf('{', s + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = s; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(s, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break; // try the next '{'
          }
        }
      }
    }
  }
  return undefined;
}

export type UnionParse =
  | { ok: true; name: string; args: Record<string, unknown>; thought?: string }
  | { ok: false; error: string };

/**
 * Parse a tier-2 reply. Constrained decoding normally yields exactly the
 * object, but servers without real grammar support may wrap it in a fence
 * or prose, so those are tolerated.
 */
export function parseUnionResponse(text: string): UnionParse {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const candidate = firstJsonObject(body);
    if (candidate === undefined) {
      return {
        ok: false,
        error: body ? 'no JSON object found in the reply' : 'the reply was empty',
      };
    }
    parsed = JSON.parse(candidate);
  }
  if (!isPlainObject(parsed)) return { ok: false, error: 'the reply must be a JSON object' };

  const nameRaw = parsed.action ?? parsed.name ?? parsed.tool;
  if (typeof nameRaw !== 'string' || !nameRaw.trim()) {
    return { ok: false, error: 'missing "action" (the tool name)' };
  }
  let argsRaw: unknown = parsed.args ?? parsed.arguments ?? parsed.parameters ?? {};
  if (typeof argsRaw === 'string') {
    try {
      argsRaw = JSON.parse(argsRaw);
    } catch {
      return { ok: false, error: '"args" must be a JSON object' };
    }
  }
  if (!isPlainObject(argsRaw)) return { ok: false, error: '"args" must be a JSON object' };

  const out: UnionParse = { ok: true, name: nameRaw.trim(), args: argsRaw };
  if (typeof parsed.thought === 'string' && parsed.thought.trim())
    out.thought = parsed.thought.trim();
  return out;
}
