import type { JsonSchema, ObjectSchema, ValidationResult } from './types';

/**
 * Validates tool arguments against the JSON Schema subset in types.ts.
 *
 * Small local models are sloppy in predictable ways ("42" for 42, "True"
 * for true, a single value where a list was wanted, junk extra keys). Where
 * the fix is unambiguous the value is coerced; otherwise the first problem
 * is reported in a short, specific message the repair prompt can quote.
 *
 * Hand-written rather than ajv: ajv compiles validators with `new Function`,
 * which the extension CSP (`script-src 'self'`) forbids.
 */

type Result = { ok: true; value: unknown } | { ok: false; error: string };

const INT_RE = /^[+-]?\d+(\.0+)?$/;
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  let s: string;
  try {
    // JSON.stringify returns undefined for undefined/functions despite its type.
    const json = JSON.stringify(v) as string | undefined;
    s = json ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/** Parse a JSON string that should hold an object/array; undefined when it doesn't. */
function parseJsonish(v: string, want: 'object' | 'array'): unknown {
  const t = v.trim();
  if (!(want === 'object' ? t.startsWith('{') : t.startsWith('['))) return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    if (want === 'object' ? isPlainObject(parsed) : Array.isArray(parsed)) return parsed;
  } catch {
    // not JSON
  }
  return undefined;
}

function validateValue(schema: JsonSchema, value: unknown, path: string): Result {
  switch (schema.type) {
    case 'string': {
      let s: string;
      if (typeof value === 'string') s = value.trim();
      else if (typeof value === 'number' && Number.isFinite(value)) s = String(value);
      else if (typeof value === 'boolean') s = String(value);
      else return { ok: false, error: `${path} must be a string (got ${show(value)})` };
      if (schema.enum) {
        const match = schema.enum.find((e) => e.toLowerCase() === s.toLowerCase());
        if (match === undefined) {
          return {
            ok: false,
            error: `${path} must be one of ${schema.enum.map((e) => `"${e}"`).join(', ')}`,
          };
        }
        s = match;
      }
      if (schema.minLength !== undefined && s.length < schema.minLength) {
        return { ok: false, error: `${path} must be at least ${schema.minLength} characters` };
      }
      if (schema.maxLength !== undefined && s.length > schema.maxLength) {
        return { ok: false, error: `${path} must be at most ${schema.maxLength} characters` };
      }
      return { ok: true, value: s };
    }

    case 'integer':
    case 'number': {
      let n: number;
      if (typeof value === 'number') {
        n = value;
      } else if (typeof value === 'string') {
        const t = value.trim();
        const re = schema.type === 'integer' ? INT_RE : NUM_RE;
        if (!re.test(t)) {
          return {
            ok: false,
            error: `${path} must be ${schema.type === 'integer' ? 'an integer' : 'a number'} (got ${show(value)})`,
          };
        }
        n = Number(t);
      } else {
        return {
          ok: false,
          error: `${path} must be ${schema.type === 'integer' ? 'an integer' : 'a number'} (got ${show(value)})`,
        };
      }
      if (!Number.isFinite(n)) return { ok: false, error: `${path} must be a finite number` };
      if (schema.type === 'integer' && !Number.isInteger(n)) {
        return { ok: false, error: `${path} must be an integer (got ${show(value)})` };
      }
      if (schema.minimum !== undefined && n < schema.minimum) {
        return { ok: false, error: `${path} must be ≥ ${schema.minimum}` };
      }
      if (schema.maximum !== undefined && n > schema.maximum) {
        return { ok: false, error: `${path} must be ≤ ${schema.maximum}` };
      }
      return { ok: true, value: n };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (typeof value === 'string') {
        const t = value.trim().toLowerCase();
        if (t === 'true' || t === 'yes') return { ok: true, value: true };
        if (t === 'false' || t === 'no') return { ok: true, value: false };
      }
      if (value === 0 || value === 1) return { ok: true, value: value === 1 };
      return { ok: false, error: `${path} must be true or false (got ${show(value)})` };
    }

    case 'array': {
      let arr: unknown[];
      if (Array.isArray(value)) arr = value;
      else if (typeof value === 'string' && parseJsonish(value, 'array') !== undefined) {
        arr = parseJsonish(value, 'array') as unknown[];
      } else if (value === undefined || value === null) {
        return { ok: false, error: `${path} must be a list (got ${show(value)})` };
      } else arr = [value];
      if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
        return { ok: false, error: `${path} must have at most ${schema.maxItems} items` };
      }
      const out: unknown[] = [];
      for (let i = 0; i < arr.length; i++) {
        const r = validateValue(schema.items, arr[i], `${path}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }

    case 'object':
      return validateObject(schema, value, path);
  }
}

function validateObject(schema: ObjectSchema, value: unknown, path: string): Result {
  let obj: Record<string, unknown>;
  if (isPlainObject(value)) obj = value;
  else if (typeof value === 'string' && parseJsonish(value, 'object') !== undefined) {
    obj = parseJsonish(value, 'object') as Record<string, unknown>;
  } else {
    return { ok: false, error: `${path} must be an object (got ${show(value)})` };
  }

  const required = new Set(schema.required ?? []);
  const out: Record<string, unknown> = {};
  const prefix = path === 'args' ? '' : `${path.replace(/^args\./, '')}.`;

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const v = obj[key];
    if (v === undefined || v === null) {
      if (required.has(key))
        return { ok: false, error: `missing required argument "${prefix}${key}"` };
      continue;
    }
    const r = validateValue(propSchema, v, `${path}.${key}`);
    if (!r.ok) return r;
    out[key] = r.value;
  }

  if (schema.additionalProperties === true) {
    for (const [key, v] of Object.entries(obj)) {
      if (!(key in schema.properties)) out[key] = structuredCloneSafe(v);
    }
  }
  // Otherwise unknown keys are dropped: small models add junk keys often.
  return { ok: true, value: out };
}

function structuredCloneSafe(v: unknown): unknown {
  try {
    return structuredClone(v);
  } catch {
    return v;
  }
}

export function validateArgs(schema: ObjectSchema, args: unknown): ValidationResult {
  const r = validateObject(schema, args, 'args');
  if (!r.ok) return r;
  return { ok: true, value: r.value as Record<string, unknown> };
}

/** Compact type text for prompts, e.g. `{ id: integer, text: string, submit?: boolean }`. */
export function describeSchema(schema: JsonSchema): string {
  switch (schema.type) {
    case 'string':
      return schema.enum ? schema.enum.map((e) => `"${e}"`).join(' | ') : 'string';
    case 'integer':
    case 'number':
    case 'boolean':
      return schema.type;
    case 'array': {
      const inner = describeSchema(schema.items);
      return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
    }
    case 'object': {
      const entries = Object.entries(schema.properties);
      if (entries.length === 0) return schema.additionalProperties === true ? 'object' : '{}';
      const required = new Set(schema.required ?? []);
      const parts = entries.map(
        ([k, s]) => `${k}${required.has(k) ? '' : '?'}: ${describeSchema(s)}`,
      );
      if (schema.additionalProperties === true) parts.push('...');
      return `{ ${parts.join(', ')} }`;
    }
  }
}
