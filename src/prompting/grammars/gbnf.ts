import type { JsonSchema, ToolSpec } from '@/agent/types';
import { DEFAULT_MAX_THOUGHT } from './union';

/**
 * llama.cpp GBNF for the tier-2 step object
 *
 *   {"thought": "...", "action": "<tool>", "args": {...}}
 *
 * llama.cpp is the strongest constrained-decoding path (spec §4.2): with a
 * grammar the model physically cannot emit an unknown tool, a wrong
 * argument type or a missing required argument.
 *
 * Decisions:
 *  - Key order is fixed: thought, action, args at the top level, and schema
 *    property order inside args. Optional keys may be omitted but never
 *    reordered. Commas are placed correctly for every subset via rules
 *    memoized on (position, anything-emitted-yet), linear in the number of
 *    properties.
 *  - Bounded repetition (`{m,n}`, llama.cpp since 2024) caps the thought
 *    length and whitespace. Unbounded `ws` lets a model loop on whitespace
 *    forever, a known llama.cpp pitfall.
 *  - Numeric minimum/maximum are not encoded (no practical GBNF form); the
 *    argument validator enforces them after decoding.
 *  - Free-form objects (`additionalProperties: true`, e.g. extract's
 *    schema) use a generic JSON value grammar; any declared properties on
 *    such an object are not enforced by the grammar.
 */

const WS_MAX = 20;

const PRIMITIVES: Record<string, string> = {
  ws: `[ \\t\\n]{0,${WS_MAX}}`,
  char: `[^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})`,
  string: `"\\"" char* "\\""`,
  integer: `"-"? ("0" | [1-9] [0-9]{0,15})`,
  number: `"-"? ("0" | [1-9] [0-9]{0,15}) ("." [0-9]{1,16})? ([eE] [-+]? [0-9]{1,3})?`,
  boolean: `"true" | "false"`,
  null: `"null"`,
  value: `object | array | string | number | boolean | null`,
  object: `"{" ws ( string ws ":" ws value ( ws "," ws string ws ":" ws value )* )? ws "}"`,
  array: `"[" ws ( value ( ws "," ws value )* )? ws "]"`,
};

/** Rules the primitives depend on, so only what's used gets emitted. */
const PRIMITIVE_DEPS: Record<string, string[]> = {
  ws: [],
  char: [],
  string: ['char'],
  integer: [],
  number: [],
  boolean: [],
  null: [],
  value: ['object', 'array', 'string', 'number', 'boolean', 'null'],
  object: ['ws', 'string', 'value'],
  array: ['ws', 'value'],
};

function addPrimitive(name: string, rules: Map<string, string>): string {
  const body = PRIMITIVES[name];
  if (body === undefined) throw new Error(`unknown primitive ${name}`);
  if (!rules.has(name)) {
    rules.set(name, body);
    for (const dep of PRIMITIVE_DEPS[name] ?? []) addPrimitive(dep, rules);
  }
  return name;
}

/** GBNF string literal matching exactly `text`. */
export function gbnfLiteral(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** camelCase / anything → a valid, lowercase GBNF rule-name fragment. */
export function ruleFragment(name: string): string {
  const s = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'x';
}

function uniqueName(base: string, rules: Map<string, string>): string {
  if (!rules.has(base) && !(base in PRIMITIVES)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!rules.has(candidate) && !(candidate in PRIMITIVES)) return candidate;
  }
}

function repeatBounds(min: number | undefined, max: number | undefined): string {
  if (min === undefined && max === undefined) return '*';
  const lo = min ?? 0;
  return max === undefined ? `{${lo},}` : `{${lo},${max}}`;
}

/**
 * Define the rule(s) for `schema` and return the expression to reference it
 * (a rule name). Primitive types reuse the shared primitive rules.
 */
export function schemaToGbnf(
  schema: JsonSchema,
  ruleName: string,
  rules: Map<string, string>,
): string {
  switch (schema.type) {
    case 'string': {
      if (schema.enum) {
        const name = uniqueName(ruleName, rules);
        rules.set(name, schema.enum.map((e) => gbnfLiteral(JSON.stringify(e))).join(' | '));
        return name;
      }
      if (schema.minLength === undefined && schema.maxLength === undefined) {
        return addPrimitive('string', rules);
      }
      addPrimitive('char', rules);
      const name = uniqueName(ruleName, rules);
      rules.set(name, `"\\"" char${repeatBounds(schema.minLength, schema.maxLength)} "\\""`);
      return name;
    }
    case 'integer':
      return addPrimitive('integer', rules);
    case 'number':
      return addPrimitive('number', rules);
    case 'boolean':
      return addPrimitive('boolean', rules);
    case 'array': {
      addPrimitive('ws', rules);
      const name = uniqueName(ruleName, rules);
      rules.set(name, ''); // reserve before recursing
      const item = schemaToGbnf(schema.items, `${name}-item`, rules);
      const rest =
        schema.maxItems === undefined
          ? `( ws "," ws ${item} )*`
          : schema.maxItems <= 1
            ? ''
            : `( ws "," ws ${item} ){0,${schema.maxItems - 1}}`;
      rules.set(
        name,
        schema.maxItems === 0
          ? `"[" ws "]"`
          : `"[" ws ( ${item}${rest ? ` ${rest}` : ''} )? ws "]"`,
      );
      return name;
    }
    case 'object': {
      if (schema.additionalProperties === true) return addPrimitive('object', rules);
      addPrimitive('ws', rules);
      const name = uniqueName(ruleName, rules);
      rules.set(name, '');
      const props = Object.entries(schema.properties);
      const required = new Set(schema.required ?? []);
      if (props.length === 0) {
        rules.set(name, `"{" ws "}"`);
        return name;
      }

      const valueRefs = props.map(([k, s]) => schemaToGbnf(s, `${name}-${ruleFragment(k)}`, rules));
      const kv = (i: number) => {
        const [key] = props[i] ?? [''];
        return `${gbnfLiteral(JSON.stringify(key))} ws ":" ws ${valueRefs[i] ?? 'value'}`;
      };

      // seq(i, first): properties i.. given whether anything was emitted yet.
      // Returns a rule name, or null when nothing can follow.
      const memo = new Map<string, string | null>();
      const seq = (i: number, first: boolean): string | null => {
        if (i >= props.length) return null;
        const key = `${i}:${first ? 'f' : 'n'}`;
        if (memo.has(key)) return memo.get(key) ?? null;
        const ref = uniqueName(`${name}-p${i}${first ? 'f' : 'n'}`, rules);
        memo.set(key, ref);
        rules.set(ref, '');
        const prefix = first ? '' : 'ws "," ws ';
        const afterEmit = seq(i + 1, false);
        const emitted = `${prefix}${kv(i)}${afterEmit ? ` ${afterEmit}` : ''}`;
        const [propName] = props[i] ?? [''];
        if (required.has(propName)) {
          rules.set(ref, emitted);
        } else {
          const skipped = seq(i + 1, first);
          rules.set(ref, skipped ? `( ${emitted} ) | ${skipped}` : `( ${emitted} )?`);
        }
        return ref;
      };

      const body = seq(0, true);
      rules.set(name, body ? `"{" ws ${body} ws "}"` : `"{" ws "}"`);
      return name;
    }
  }
}

function render(rules: Map<string, string>): string {
  const names = [...rules.keys()];
  const custom = names.filter((n) => !(n in PRIMITIVES));
  const prims = Object.keys(PRIMITIVES).filter((n) => rules.has(n));
  return `${[...custom, ...prims].map((n) => `${n} ::= ${rules.get(n) ?? ''}`).join('\n')}\n`;
}

export function toolGrammar(tools: ToolSpec[], opts: { maxThoughtChars?: number } = {}): string {
  if (tools.length === 0) throw new Error('toolGrammar needs at least one tool');
  const rules = new Map<string, string>();
  rules.set('root', ''); // keep root first
  addPrimitive('ws', rules);
  addPrimitive('char', rules);
  rules.set('thought', `"\\"" char{0,${opts.maxThoughtChars ?? DEFAULT_MAX_THOUGHT}} "\\""`);

  const branches: string[] = [];
  for (const tool of tools) {
    const frag = ruleFragment(tool.name);
    const argsRef = schemaToGbnf(tool.parameters, uniqueName(`${frag}-args`, rules), rules);
    const actName = uniqueName(`act-${frag}`, rules);
    rules.set(
      actName,
      `${gbnfLiteral(JSON.stringify(tool.name))} ws "," ws "\\"args\\"" ws ":" ws ${argsRef}`,
    );
    branches.push(actName);
  }

  rules.set(
    'root',
    `"{" ws "\\"thought\\"" ws ":" ws thought ws "," ws "\\"action\\"" ws ":" ws ( ${branches.join(' | ')} ) ws "}"`,
  );
  return render(rules);
}
