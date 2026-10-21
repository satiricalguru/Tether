import type { JsonSchema, ParseResult, ToolCall, ToolSpec } from '@/agent/types';

/**
 * Tier 3: tool calls from plain text. Models without native tools or
 * constrained decoding are asked for one XML-ish block:
 *
 *   <thinking>short reasoning</thinking>
 *   <action name="click">
 *     <arg name="id">42</arg>
 *   </action>
 *
 * Small models don't reliably comply, and often leak their own training
 * formats instead, so the parser also accepts those (Hermes <tool_call>,
 * Llama <|python_tag|>, Mistral [TOOL_CALLS], Gemma tool_code, Phi
 * <|tool_call|>, bare JSON, Python-style calls). Failures produce short,
 * specific errors: they are fed back to the model in one repair round.
 *
 * String values are converted using the tool's schema (integer, number,
 * boolean, object, array) when unambiguous; anything else stays a string
 * for the validator to judge.
 */

interface Found {
  index: number;
  call: ToolCall;
  format: string;
}
type Attempt = Found | { index: number; error: string } | null;

const NO_ACTION = 'No action found. Reply with exactly one <action name="…"> block.';

// ---------- small utilities ----------

function unescapeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/** Comparison key: case-, separator- and prefix-insensitive. */
function nameKey(name: string): string {
  return name
    .trim()
    .replace(/^(default_api|functions|tools?)\./i, '')
    .replace(/[\s_-]/g, '')
    .toLowerCase();
}

type Resolved = { ok: true; tool: ToolSpec } | { ok: false; error: string };

export function resolveToolName(raw: string, tools: ToolSpec[]): Resolved {
  const name = raw.trim();
  if (!name) return { ok: false, error: 'The action has no name. Use <action name="…">.' };
  const exact = tools.find((t) => t.name === name);
  if (exact) return { ok: true, tool: exact };
  const key = nameKey(name);
  const loose = tools.find((t) => nameKey(t.name) === key);
  if (loose) return { ok: true, tool: loose };
  const scored = tools
    .map((t) => ({ t, d: levenshtein(key, nameKey(t.name)) }))
    .sort((a, b) => a.d - b.d);
  const [best, second] = scored;
  if (best?.d === 1 && key.length >= 5 && second?.d !== 1) return { ok: true, tool: best.t };
  const hint = best && best.d <= 2 ? ` Did you mean "${best.t.name}"?` : '';
  return {
    ok: false,
    error: `Unknown action "${name}". Available actions: ${tools.map((t) => t.name).join(', ')}.${hint}`,
  };
}

/** Convert a text value using the expected schema type, when unambiguous. */
function convert(value: string, schema: JsonSchema | undefined): unknown {
  const v = value.trim();
  switch (schema?.type) {
    case 'integer':
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    case 'boolean':
      if (/^(true|yes)$/i.test(v)) return true;
      if (/^(false|no)$/i.test(v)) return false;
      return v;
    case 'object':
    case 'array':
      try {
        return JSON.parse(v) as unknown;
      } catch {
        return v;
      }
    default:
      return v;
  }
}

function convertArgs(raw: Record<string, string>, tool: ToolSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = convert(v, tool.parameters.properties[k]);
  return out;
}

/** Strings from JSON forms keep their JSON types; arguments given as a JSON string are decoded. */
type ArgsResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function jsonArgs(raw: unknown): ArgsResult {
  const notObject: ArgsResult = { ok: false, error: 'The action arguments must be a JSON object.' };
  if (raw === undefined || raw === null) return { ok: true, args: {} };
  if (typeof raw === 'string') {
    if (!raw.trim()) return { ok: true, args: {} };
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { ok: true, args: parsed as Record<string, unknown> }
        : notObject;
    } catch (e) {
      return {
        ok: false,
        error: `The action arguments are not valid JSON (${(e as Error).message}).`,
      };
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw))
    return { ok: true, args: raw as Record<string, unknown> };
  return notObject;
}

// ---------- balanced JSON scanning ----------

/** End index (exclusive) of the balanced JSON value starting at `start`, or -1 if unterminated. */
function balancedEnd(text: string, start: number): number {
  const open = text[start];
  if (open !== '{' && open !== '[') return -1;
  const stack: string[] = [];
  let inString: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"') inString = '"';
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function jsonPositionError(src: string): string {
  try {
    JSON.parse(src);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

/** Interpret a parsed JSON value as a tool call, if it has a recognizable shape. */
function fromJsonValue(
  v: unknown,
  tools: ToolSpec[],
): { call: ToolCall } | { error: string } | null {
  if (Array.isArray(v)) return v.length ? fromJsonValue(v[0], tools) : null;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;

  if (Array.isArray(o.tool_calls)) return fromJsonValue(o.tool_calls[0], tools);
  if (o.function && typeof o.function === 'object') {
    const f = o.function as Record<string, unknown>;
    return fromJsonValue({ name: f.name, arguments: f.arguments ?? f.parameters }, tools);
  }
  if (o.function_call && typeof o.function_call === 'object')
    return fromJsonValue(o.function_call, tools);

  const nameField = ['action', 'name', 'tool', 'tool_name', 'function', 'command'].find(
    (k) => typeof o[k] === 'string',
  );
  if (!nameField) return null;
  const argsField = ['args', 'arguments', 'parameters', 'input', 'params', 'action_input'].find(
    (k) => k in o,
  );
  const resolved = resolveToolName(o[nameField] as string, tools);
  if (!resolved.ok) return { error: resolved.error };
  const args = jsonArgs(argsField ? o[argsField] : undefined);
  if (!args.ok) return { error: args.error };
  const call: ToolCall = { name: resolved.tool.name, args: args.args };
  const thought = o.thought ?? o.reasoning ?? o.thinking;
  if (typeof thought === 'string' && thought.trim()) call.thought = thought.trim();
  return { call };
}

function parseJsonAt(
  text: string,
  start: number,
  tools: ToolSpec[],
  format: string,
  strict: boolean,
): Attempt {
  const end = balancedEnd(text, start);
  if (end === -1) {
    return strict
      ? {
          index: start,
          error:
            'Your reply was cut off inside the tool call JSON. Reply again with one complete action.',
        }
      : null;
  }
  const src = text.slice(start, end);
  let value: unknown;
  try {
    value = JSON.parse(src);
  } catch {
    // Single quotes, True/False/None: Python-style literals are common enough to accept.
    try {
      const py = new PyParser(src);
      value = py.value();
      py.ws();
      if (py.i !== src.length) throw new Error('trailing input');
    } catch {
      if (!strict) return null;
      return {
        index: start,
        error: `The tool call is not valid JSON (${jsonPositionError(src)}).`,
      };
    }
  }
  const r = fromJsonValue(value, tools);
  if (!r) return strict ? { index: start, error: 'The tool call JSON has no "name".' } : null;
  if ('error' in r) return { index: start, error: r.error };
  return { index: start, call: r.call, format };
}

// ---------- Python-style calls ----------

class PyParser {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] ?? '')) this.i++;
  }

  value(): unknown {
    this.ws();
    const ch = this.s[this.i];
    if (ch === '"' || ch === "'") return this.str(ch);
    if (ch === '[' || ch === '(') return this.list(ch === '[' ? ']' : ')');
    if (ch === '{') return this.dict();
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|True|False|None|true|false|null)/.exec(
      this.s.slice(this.i),
    );
    if (!m) throw new Error(`unexpected "${this.s.slice(this.i, this.i + 10)}"`);
    this.i += m[0].length;
    const lit = m[0];
    if (lit === 'True' || lit === 'true') return true;
    if (lit === 'False' || lit === 'false') return false;
    if (lit === 'None' || lit === 'null') return null;
    return Number(lit);
  }

  str(q: string): string {
    // Triple-quoted strings.
    const triple = this.s.startsWith(q.repeat(3), this.i);
    const delim = triple ? q.repeat(3) : q;
    this.i += delim.length;
    let out = '';
    while (this.i < this.s.length) {
      if (this.s.startsWith(delim, this.i)) {
        this.i += delim.length;
        return out;
      }
      const ch = this.s[this.i] ?? '';
      if (ch === '\\') {
        const next = this.s[this.i + 1] ?? '';
        out += { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }[next] ?? next;
        this.i += 2;
        continue;
      }
      out += ch;
      this.i++;
    }
    throw new Error('unterminated string');
  }

  list(close: string): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === close) {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== close) throw new Error('expected , in list');
    }
  }

  dict(): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      const key = this.value();
      this.ws();
      if (this.s[this.i] !== ':') throw new Error('expected : in dict');
      this.i++;
      out[String(key)] = this.value();
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') throw new Error('expected , in dict');
    }
  }

  /** Arguments after the opening "(" up to the matching ")". */
  args(): { positional: unknown[]; keyword: Record<string, unknown> } {
    const positional: unknown[] = [];
    const keyword: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) throw new Error('unterminated call');
      if (this.s[this.i] === ')') {
        this.i++;
        return { positional, keyword };
      }
      const kw = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(this.s.slice(this.i));
      if (kw) {
        this.i += kw[0].length;
        keyword[kw[1] ?? ''] = this.value();
      } else {
        positional.push(this.value());
      }
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ')')
        throw new Error(`expected , or ) at "${this.s.slice(this.i, this.i + 10)}"`);
    }
  }
}

const CALL_RE = /(?:print\s*\(\s*)?\b((?:default_api|functions|tools?)\.)?([A-Za-z_][\w-]*)\s*\(/g;

/**
 * Find a Python-style call to a known tool. Outside a code block only names
 * that resolve exactly (case/separator-insensitively) count, so prose like
 * "see (above)" isn't mistaken for a call.
 */
function findPythonCall(text: string, tools: ToolSpec[], format: string, inCode: boolean): Attempt {
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(text))) {
    const rawName = m[2] ?? '';
    const prefixed = !!m[1];
    const known = tools.find((t) => nameKey(t.name) === nameKey(rawName));
    if (!known && !(inCode || prefixed)) continue;
    // In prose, "type (the text)" is not a call: require name( with no space.
    if (!inCode && !prefixed && /\s\($/.test(m[0])) continue;
    if (!known && ['print', 'range', 'len', 'str', 'int'].includes(rawName)) continue;
    const index = m.index;
    const resolved = resolveToolName(rawName, tools);
    if (!resolved.ok) return { index, error: resolved.error };
    const p = new PyParser(text);
    p.i = m.index + m[0].length;
    try {
      const { positional, keyword } = p.args();
      const order = Object.keys(resolved.tool.parameters.properties);
      const args: Record<string, unknown> = {};
      positional.forEach((v, i) => {
        const key = order[i];
        if (key) args[key] = v;
      });
      Object.assign(args, keyword);
      // Positional strings like click("42") still benefit from schema conversion.
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string') args[k] = convert(v, resolved.tool.parameters.properties[k]);
      }
      return { index, call: { name: resolved.tool.name, args }, format };
    } catch (e) {
      return {
        index,
        error: `Could not read the arguments of ${rawName}(…): ${(e as Error).message}.`,
      };
    }
  }
  return null;
}

// ---------- XML protocol ----------

const ATTR_RE = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src))) out[m[1] ?? ''] = unescapeHtml(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function cleanValue(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)(\]\]>|$)/.exec(raw);
  if (cdata) return cdata[1] ?? '';
  return unescapeHtml(raw).trim();
}

interface XmlBlock {
  index: number;
  name?: string;
  rawArgs: Record<string, string>;
  jsonArgs?: string;
  truncated?: string;
}

function readXmlBlock(text: string, index: number): XmlBlock {
  const open = /^<action\b([^>]*)>/i.exec(text.slice(index));
  if (!open) {
    return {
      index,
      rawArgs: {},
      truncated:
        'Your reply was cut off inside an <action> tag. Reply again with one complete <action> block.',
    };
  }
  const headSrc = open[1] ?? '';
  const selfClosing = /\/\s*$/.test(headSrc);
  const attrs = parseAttrs(headSrc.replace(/\/\s*$/, ''));
  const block: XmlBlock = { index, rawArgs: {} };
  if (attrs.name !== undefined) block.name = attrs.name;
  for (const [k, v] of Object.entries(attrs)) if (k !== 'name') block.rawArgs[k] = v;
  if (selfClosing) return block;

  const bodyStart = index + open[0].length;
  const rest = text.slice(bodyStart);
  const close = /<\/action\s*>|<action\b/i.exec(rest);
  const body = close ? rest.slice(0, close.index) : rest;

  // <name>click</name> when there was no name attribute.
  const nameTag = /<(name|tool|function)>\s*([^<]*?)\s*<\/\1>/i.exec(body);
  if (block.name === undefined && nameTag) block.name = unescapeHtml(nameTag[2] ?? '');

  // <arg name="x">value</arg>, tolerating a missing </arg>.
  const argRe = /<arg\b([^>]*)>([\s\S]*?)(?=<\/arg\s*>|<arg\b|$)/gi;
  let m: RegExpExecArray | null;
  let sawArg = false;
  while ((m = argRe.exec(body))) {
    sawArg = true;
    const a = parseAttrs(m[1] ?? '');
    const key = a.name ?? a.key;
    if (key) block.rawArgs[key] = cleanValue(m[2] ?? '');
  }
  if (sawArg) return block;

  // <args>{json}</args>, a bare JSON body, or <id>42</id> child elements.
  const argsTag = /<(args|arguments|parameters|input)>([\s\S]*?)(<\/\1>|$)/i.exec(body);
  const jsonSrc = (
    argsTag?.[2] ?? body.replace(/<(name|tool|function)>[\s\S]*?<\/\1>/gi, '')
  ).trim();
  if (jsonSrc.startsWith('{')) {
    block.jsonArgs = jsonSrc;
    return block;
  }
  const childRe = /<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>/g;
  while ((m = childRe.exec(body))) {
    const tag = m[1] ?? '';
    if (/^(name|tool|function|thinking|think)$/i.test(tag)) continue;
    block.rawArgs[tag] = cleanValue(m[2] ?? '');
  }
  return block;
}

function findXmlAction(text: string, tools: ToolSpec[]): Attempt {
  const starts: number[] = [];
  const re = /<action\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) starts.push(m.index);
  if (!starts.length) return null;

  let firstError: { index: number; error: string } | null = null;
  const found: { call: ToolCall; index: number }[] = [];
  for (const start of starts) {
    const b = readXmlBlock(text, start);
    if (b.truncated) {
      firstError ??= { index: start, error: b.truncated };
      continue;
    }
    if (b.name === undefined) {
      firstError ??= {
        index: start,
        error: 'The <action> tag has no name. Use <action name="…">.',
      };
      continue;
    }
    // The instructions show ACTION_NAME / ARG_NAME; small models sometimes copy them.
    if (b.name === 'ACTION_NAME' || 'ARG_NAME' in b.rawArgs) {
      firstError ??= {
        index: start,
        error:
          'Replace the placeholders: use a real action name in <action name="…"> and real argument names in <arg name="…">.',
      };
      continue;
    }
    const resolved = resolveToolName(b.name, tools);
    if (!resolved.ok) {
      firstError ??= { index: start, error: resolved.error };
      continue;
    }
    let args = convertArgs(b.rawArgs, resolved.tool);
    if (b.jsonArgs) {
      const parsed = jsonArgs(b.jsonArgs);
      if (!parsed.ok) {
        firstError ??= { index: start, error: parsed.error };
        continue;
      }
      args = { ...args, ...parsed.args };
    }
    found.push({ index: start, call: { name: resolved.tool.name, args } });
  }
  const [first] = found;
  if (!first) return firstError;
  const distinct = new Set(found.map((f) => JSON.stringify(f.call)));
  return {
    index: first.index,
    call: first.call,
    format: distinct.size > 1 ? 'xml-multi-first' : 'xml',
  };
}

// ---------- leaked native formats ----------

function findTagged(text: string, tools: ToolSpec[], open: RegExp, format: string): Attempt {
  const m = open.exec(text);
  if (!m) return null;
  const after = m.index + m[0].length;
  const rest = text.slice(after);
  const jsonStart = rest.search(/[{[]/);
  if (jsonStart !== -1 && !rest.slice(0, jsonStart).trim()) {
    const r = parseJsonAt(text, after + jsonStart, tools, format, true);
    if (r) return { ...r, index: m.index };
  }
  // <|python_tag|> may carry a Python call instead of JSON.
  const py = findPythonCall(rest, tools, format, true);
  if (py) return { ...py, index: m.index };
  return { index: m.index, error: `The ${format} block has no tool call inside it.` };
}

function findCodeFenceCall(text: string, tools: ToolSpec[]): Attempt {
  const fence = /```(tool_code|python|py)\s*\n([\s\S]*?)(```|$)/i.exec(text);
  if (!fence) return null;
  const r = findPythonCall(fence[2] ?? '', tools, 'tool_code', true);
  return r ? { ...r, index: fence.index } : null;
}

function findBareJson(text: string, tools: ToolSpec[]): Attempt {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const r = parseJsonAt(text, i, tools, 'json', false);
    if (r) return r;
  }
  return null;
}

// ---------- entry point ----------

const THINK_RE = /<(think|thinking)>([\s\S]*?)(<\/\1>|$)/gi;

function stripFences(text: string): string {
  // Unwrap ```xml / ```json fences; tool_code/python fences are handled as calls.
  return text.replace(/```(?!tool_code|python\b|py\b)[\w-]*\s*\n?([\s\S]*?)(```|$)/gi, '$1');
}

function pick(attempts: Attempt[]): Found | { error: string } | null {
  const ok = attempts
    .filter((a): a is Found => !!a && 'call' in a)
    .sort((a, b) => a.index - b.index);
  if (ok[0]) return ok[0];
  const errs = attempts.filter((a): a is { index: number; error: string } => !!a && 'error' in a);
  errs.sort((a, b) => a.index - b.index);
  return errs[0] ? { error: errs[0].error } : null;
}

function parseBody(text: string, tools: ToolSpec[]): Found | { error: string } | null {
  const body = stripFences(text);
  const xml = findXmlAction(body, tools);
  if (xml && 'call' in xml) return xml;
  const attempts: Attempt[] = [
    xml,
    findTagged(body, tools, /<tool_call>/i, 'hermes'),
    findTagged(body, tools, /<\|python_tag\|>/, 'llama-python-tag'),
    findTagged(body, tools, /\[TOOL_CALLS\]/, 'mistral'),
    findTagged(body, tools, /<\|tool_call\|>/, 'phi'),
    findCodeFenceCall(text, tools),
  ];
  const tagged = pick(attempts);
  if (tagged && 'call' in tagged) return tagged;
  const loose = pick([
    findBareJson(body, tools),
    findPythonCall(body, tools, 'python-call', false),
  ]);
  if (loose && 'call' in loose) return loose;
  return tagged ?? loose;
}

export function parseToolCall(text: string, tools: ToolSpec[]): ParseResult {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const thoughts: string[] = [];
  const outside = src.replace(THINK_RE, (_, _tag: string, inner: string) => {
    thoughts.push(inner.trim());
    return ' ';
  });

  let found = parseBody(outside, tools);
  // Some models put the action inside their thinking; use it only as a last resort.
  if (!found || !('call' in found)) {
    const inThought = thoughts.length ? parseBody(thoughts.join('\n'), tools) : null;
    if (inThought && 'call' in inThought) found = inThought;
  }
  if (!found) {
    // Output that stopped inside <thinking> usually hit the token limit.
    const unclosed = /<(think|thinking)>(?![\s\S]*<\/\1>)/i.test(src);
    return {
      ok: false,
      error: unclosed
        ? 'Your reply ended inside <thinking> with no action. Keep the thinking to one or two sentences and end with one <action> block.'
        : NO_ACTION,
    };
  }
  if (!('call' in found)) return { ok: false, error: found.error };

  const call = { ...found.call };
  const thought = thoughts.filter(Boolean).join('\n').trim();
  if (thought && !call.thought) call.thought = thought.slice(0, 500);
  if (!call.thought) {
    const before = outside
      .slice(0, Math.max(0, found.index))
      .replace(/```[\w-]*/g, '')
      .trim();
    if (before) call.thought = before.slice(0, 500);
  }
  return { ok: true, call, format: found.format };
}

// ---------- prompt side ----------

function typeLabel(s: JsonSchema): string {
  switch (s.type) {
    case 'string':
      return s.enum ? s.enum.map((e) => JSON.stringify(e)).join(' | ') : 'string';
    case 'array':
      return `${typeLabel(s.items)}[]`;
    default:
      return s.type;
  }
}

export function toolSignature(t: ToolSpec): string {
  const req = new Set(t.parameters.required ?? []);
  const params = Object.entries(t.parameters.properties)
    .map(([k, s]) => `${k}${req.has(k) ? '' : '?'}: ${typeLabel(s)}`)
    .join(', ');
  return `${t.name}(${params}) — ${t.description}`;
}

export function textProtocolInstructions(tools: ToolSpec[]): string {
  return [
    'Reply with exactly one action per turn, in this format:',
    '',
    '<thinking>one or two sentences about what to do next</thinking>',
    '<action name="ACTION_NAME">',
    '  <arg name="ARG_NAME">value</arg>',
    '</action>',
    '',
    'Rules:',
    '- Use one of the actions below and nothing else. Write nothing after </action>.',
    '- Write each argument as plain text; write object or list arguments as JSON.',
    '- Leave out optional arguments (marked ?) you do not need.',
    '',
    'Actions:',
    ...tools.map((t) => `- ${toolSignature(t)}`),
  ].join('\n');
}

export function formatToolCall(call: { name: string; args: Record<string, unknown> }): string {
  const args = Object.entries(call.args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const value = typeof v === 'string' ? escapeXml(v) : escapeXml(JSON.stringify(v));
      return `  <arg name="${escapeXml(k).replace(/"/g, '&quot;')}">${value}</arg>`;
    });
  return [`<action name="${call.name}">`, ...args, '</action>'].join('\n');
}
