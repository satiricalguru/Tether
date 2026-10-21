import { describe, expect, it } from 'vitest';
import { validateArgs } from '@/agent/schema';
import type { ObjectSchema, ToolSpec } from '@/agent/types';
import { gbnfLiteral, ruleFragment, schemaToGbnf, toolGrammar } from '@/prompting/grammars/gbnf';
import { firstJsonObject, parseUnionResponse, toolUnionSchema } from '@/prompting/grammars/union';
import { accepts, parseGbnf } from '../helpers/gbnf';

const id = { type: 'integer' } as const;
const str = { type: 'string' } as const;
const obj = (
  properties: ObjectSchema['properties'] = {},
  required: string[] = [],
  additionalProperties?: boolean,
): ObjectSchema => ({
  type: 'object',
  properties,
  required,
  ...(additionalProperties ? { additionalProperties } : {}),
});
const free: ObjectSchema = { type: 'object', properties: {}, additionalProperties: true };
const tool = (name: string, parameters: ObjectSchema, terminal?: boolean): ToolSpec => ({
  name,
  description: name,
  parameters,
  ...(terminal ? { terminal } : {}),
});

/** The full spec §6.2 action space. */
const TOOLS: ToolSpec[] = [
  tool('navigate', obj({ url: str }, ['url'])),
  tool('back', obj()),
  tool('forward', obj()),
  tool('reload', obj()),
  tool('click', obj({ id }, ['id'])),
  tool('rightClick', obj({ id }, ['id'])),
  tool('hover', obj({ id }, ['id'])),
  tool('type', obj({ id, text: str, submit: { type: 'boolean' } }, ['id', 'text'])),
  tool('clear', obj({ id }, ['id'])),
  tool('setValue', obj({ id, value: str }, ['id', 'value'])),
  tool('select', obj({ id, option: str }, ['id', 'option'])),
  tool('check', obj({ id, state: { type: 'boolean' } }, ['id', 'state'])),
  tool('pressKey', obj({ key: str }, ['key'])),
  tool('scroll', obj({ direction: { type: 'string', enum: ['up', 'down'] }, id, amount: id })),
  tool('newTab', obj({ url: str })),
  tool('switchTab', obj({ index: id }, ['index'])),
  tool('closeTab', obj({ index: id }, ['index'])),
  tool('screenshot', obj()),
  tool('extract', obj({ schema: free }, ['schema'])),
  tool('waitFor', obj({ condition: str, timeoutMs: id }, ['condition'])),
  tool('askUser', obj({ question: str }, ['question']), true),
  tool('done', obj({ summary: str, result: free }, ['summary']), true),
];

const grammarText = toolGrammar(TOOLS);
const grammar = parseGbnf(grammarText);

const step = (action: string, args: unknown, thought = 'next step') =>
  JSON.stringify({ thought, action, args });

const VALID: string[] = [
  step('navigate', { url: 'https://example.com/search?q=laptop&x=1' }),
  step('back', {}),
  step('forward', {}),
  step('reload', {}),
  step('click', { id: 42 }),
  step('click', { id: 0 }),
  step('click', { id: -3 }),
  step('rightClick', { id: 7 }),
  step('hover', { id: 1 }),
  step('type', { id: 3, text: 'hello "quoted" \\ back\nslash' }),
  step('type', { id: 3, text: 'café ☕ 你好', submit: true }),
  step('type', { id: 3, text: '', submit: false }),
  step('clear', { id: 9 }),
  step('setValue', { id: 2, value: '2026-10-21' }),
  step('select', { id: 4, option: 'Large' }),
  step('check', { id: 5, state: false }),
  step('pressKey', { key: 'Enter' }),
  step('scroll', {}),
  step('scroll', { direction: 'down' }),
  step('scroll', { amount: 3 }),
  step('scroll', { id: 12, amount: 2 }),
  step('scroll', { direction: 'up', id: 12, amount: 2 }),
  step('newTab', {}),
  step('newTab', { url: 'https://a.example' }),
  step('switchTab', { index: 1 }),
  step('closeTab', { index: 0 }),
  step('screenshot', {}),
  step('extract', {
    schema: {
      title: 'string',
      items: [{ name: 'string', price: 'number' }],
      n: 3,
      ok: true,
      x: null,
    },
  }),
  step('extract', { schema: {} }),
  step('waitFor', { condition: 'text:Results', timeoutMs: 5000 }),
  step('waitFor', { condition: 'load' }),
  step('askUser', { question: 'Which size?' }),
  step('done', { summary: 'Found 3 laptops' }),
  step('done', { summary: 'ok', result: { prices: [899, 1099.5, 1.2e3] } }),
  step('click', { id: 1 }, ''),
  step('click', { id: 1 }, 'x'.repeat(400)),
  step('click', { id: 1 }, 'escapes \\u00e9 \t tab'),
  // Pretty-printed, as some servers emit.
  JSON.stringify({ thought: 't', action: 'type', args: { id: 1, text: 'x' } }, null, 2),
];

const INVALID: [string, string][] = [
  ['unknown action', step('purchase', { id: 1 })],
  ['wrong arg type', '{"thought":"t","action":"click","args":{"id":"abc"}}'],
  ['number for integer', '{"thought":"t","action":"click","args":{"id":1.5}}'],
  ['missing required arg', step('navigate', {})],
  ['missing one of two required', step('type', { id: 1 })],
  ['extra key in args', step('click', { id: 1, force: true })],
  ['extra top-level key', '{"thought":"t","action":"click","args":{"id":1},"extra":1}'],
  ['wrong key order (action first)', '{"action":"click","thought":"t","args":{"id":1}}'],
  ['wrong arg order', step('type', { text: 'x', id: 1 })],
  ['optional out of order', step('scroll', { amount: 2, direction: 'up' })],
  ['unescaped quote', '{"thought":"he said "hi"","action":"back","args":{}}'],
  ['raw newline in string', '{"thought":"a\nb","action":"back","args":{}}'],
  ['leading-zero int', '{"thought":"t","action":"click","args":{"id":042}}'],
  ['bad enum', step('scroll', { direction: 'left' })],
  ['boolean as string', '{"thought":"t","action":"check","args":{"id":1,"state":"true"}}'],
  ['over-long thought', step('click', { id: 1 }, 'x'.repeat(401))],
  ['missing thought', '{"action":"click","args":{"id":1}}'],
  ['trailing comma', '{"thought":"t","action":"click","args":{"id":1,}}'],
  ['args not an object', '{"thought":"t","action":"back","args":[]}'],
  ['extract schema not an object', '{"thought":"t","action":"extract","args":{"schema":"string"}}'],
  ['prose around JSON', `Sure! ${step('back', {})}`],
  ['truncated', step('click', { id: 1 }).slice(0, -2)],
  // The grammar starts at "{": constrained output has no surrounding
  // whitespace (parseUnionResponse tolerates it for unconstrained servers).
  ['leading whitespace', `  ${step('back', {})}`],
  ['too much whitespace', `{${' '.repeat(21)}"thought":"t","action":"back","args":{}}`],
];

describe('toolGrammar (GBNF)', () => {
  it('is well-formed: every referenced rule is defined, names are valid, root exists', () => {
    expect(grammar.rules.has('root')).toBe(true);
    for (const ref of grammar.refs) expect(grammar.rules.has(ref), `rule ${ref}`).toBe(true);
    for (const name of grammar.rules.keys()) expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(grammarText.split('\n')[0]?.startsWith('root ::= ')).toBe(true);
  });

  it.each(VALID.map((v) => [v.slice(0, 70), v]))('accepts %s', (_label, text) => {
    expect(accepts(grammar, text)).toBe(true);
  });

  it.each(INVALID)('rejects: %s', (_label, text) => {
    expect(accepts(grammar, text)).toBe(false);
  });

  it('everything it accepts also validates and parses back (cross-check)', () => {
    for (const text of VALID) {
      const parsed = parseUnionResponse(text);
      expect(parsed.ok, text).toBe(true);
      if (!parsed.ok) continue;
      const spec = TOOLS.find((t) => t.name === parsed.name);
      expect(spec, parsed.name).toBeDefined();
      if (!spec) continue;
      const v = validateArgs(spec.parameters, parsed.args);
      expect(v, text).toMatchObject({ ok: true });
      // Strict outputs need no coercion: validation is the identity on them.
      if (v.ok) expect(v.value).toEqual(parsed.args);
    }
  });

  it('matches the golden grammar for a two-tool set', () => {
    expect(
      toolGrammar(
        [
          tool('click', obj({ id }, ['id'])),
          tool('scroll', obj({ direction: { type: 'string', enum: ['up', 'down'] }, amount: id })),
        ],
        { maxThoughtChars: 200 },
      ),
    ).toBe(
      [
        'root ::= "{" ws "\\"thought\\"" ws ":" ws thought ws "," ws "\\"action\\"" ws ":" ws ( act-click | act-scroll ) ws "}"',
        'thought ::= "\\"" char{0,200} "\\""',
        'click-args ::= "{" ws click-args-p0f ws "}"',
        'click-args-p0f ::= "\\"id\\"" ws ":" ws integer',
        'act-click ::= "\\"click\\"" ws "," ws "\\"args\\"" ws ":" ws click-args',
        'scroll-args ::= "{" ws scroll-args-p0f ws "}"',
        'scroll-args-direction ::= "\\"up\\"" | "\\"down\\""',
        'scroll-args-p0f ::= ( "\\"direction\\"" ws ":" ws scroll-args-direction scroll-args-p1n ) | scroll-args-p1f',
        'scroll-args-p1n ::= ( ws "," ws "\\"amount\\"" ws ":" ws integer )?',
        'scroll-args-p1f ::= ( "\\"amount\\"" ws ":" ws integer )?',
        'act-scroll ::= "\\"scroll\\"" ws "," ws "\\"args\\"" ws ":" ws scroll-args',
        'ws ::= [ \\t\\n]{0,20}',
        'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})',
        'integer ::= "-"? ("0" | [1-9] [0-9]{0,15})',
        '',
      ].join('\n'),
    );
  });

  it('honours maxThoughtChars', () => {
    const g = parseGbnf(toolGrammar([tool('back', obj())], { maxThoughtChars: 5 }));
    expect(accepts(g, step('back', {}, 'abcde'))).toBe(true);
    expect(accepts(g, step('back', {}, 'abcdef'))).toBe(false);
  });

  it('rejects an empty tool set', () => {
    expect(() => toolGrammar([])).toThrow();
  });
});

describe('schemaToGbnf building blocks', () => {
  const check = (schema: Parameters<typeof schemaToGbnf>[0], good: string[], bad: string[]) => {
    const rules = new Map<string, string>();
    const ref = schemaToGbnf(schema, 'v', rules);
    const text = `root ::= ${ref}\n${[...rules].map(([n, b]) => `${n} ::= ${b}`).join('\n')}\n`;
    const g = parseGbnf(text);
    for (const s of good) expect(accepts(g, s), s).toBe(true);
    for (const s of bad) expect(accepts(g, s), s).toBe(false);
  };

  it('numbers, booleans and bounded strings', () => {
    check(
      { type: 'number' },
      ['0', '-1.5', '3e10', '2.5E-3', '12'],
      ['01', '1.', '.5', '+1', 'NaN'],
    );
    check({ type: 'boolean' }, ['true', 'false'], ['True', '1', 'null']);
    check({ type: 'string', minLength: 2, maxLength: 3 }, ['"ab"', '"abc"'], ['"a"', '"abcd"']);
  });

  it('arrays of items with maxItems', () => {
    check(
      { type: 'array', items: { type: 'integer' } },
      ['[]', '[1]', '[1, 2,3]'],
      ['[1,]', '["a"]'],
    );
    check({ type: 'array', items: { type: 'integer' }, maxItems: 2 }, ['[]', '[1,2]'], ['[1,2,3]']);
    check({ type: 'array', items: { type: 'integer' }, maxItems: 1 }, ['[]', '[7]'], ['[7,8]']);
  });

  it('objects: every subset of optional keys, commas always right', () => {
    const s = obj({ a: id, b: id, c: id }, ['b']);
    check(
      s,
      ['{"b":1}', '{"a":1,"b":2}', '{"b":2,"c":3}', '{"a":1,"b":2,"c":3}'],
      ['{}', '{"a":1}', '{"a":1,"c":3}', '{,"b":1}', '{"b":1,}', '{"b":1,"a":2}'],
    );
    check(
      obj({ a: id, b: id }),
      ['{}', '{"a":1}', '{"b":2}', '{"a":1,"b":2}'],
      ['{"b":2,"a":1}', '{,}', '{"a":1,}'],
    );
  });

  it('free-form objects take any JSON object', () => {
    check(free, ['{}', '{"x":[1,{"y":null}],"z":"s"}'], ['[]', '"s"', '{"x":}']);
  });

  it('literals and rule names are escaped safely', () => {
    expect(gbnfLiteral('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(gbnfLiteral('\u0001')).toBe('"\\x01"');
    expect(ruleFragment('rightClick')).toBe('right-click');
    expect(ruleFragment('my_tool.v2')).toBe('my-tool-v2');
    expect(ruleFragment('***')).toBe('x');
  });

  it('tool names that collide with primitives still produce distinct rules', () => {
    const g = toolGrammar([tool('string', obj({ value: str }, ['value'])), tool('value', obj())]);
    const parsed = parseGbnf(g);
    expect(accepts(parsed, step('string', { value: 'x' }))).toBe(true);
    expect(accepts(parsed, step('value', {}))).toBe(true);
  });
});

describe('toolUnionSchema (JSON Schema)', () => {
  const schema = toolUnionSchema(TOOLS);

  it('has one branch per tool, serializes, and fixes the keys', () => {
    const anyOf = schema.anyOf as Record<string, unknown>[];
    expect(anyOf).toHaveLength(TOOLS.length);
    expect(() => JSON.stringify(schema)).not.toThrow();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    for (const [i, branch] of anyOf.entries()) {
      expect(branch).toMatchObject({
        type: 'object',
        required: ['thought', 'action', 'args'],
        additionalProperties: false,
        properties: {
          thought: { type: 'string', maxLength: 400 },
          action: { type: 'string', enum: [TOOLS[i]?.name] },
        },
      });
      expect(Object.keys(branch.properties as Record<string, unknown>)).toEqual([
        'thought',
        'action',
        'args',
      ]);
    }
  });

  it('maps arg schemas faithfully', () => {
    const anyOf = schema.anyOf as { properties: { args: unknown } }[];
    const typeBranch = anyOf[TOOLS.findIndex((t) => t.name === 'type')];
    expect(typeBranch?.properties.args).toEqual({
      type: 'object',
      properties: {
        id: { type: 'integer' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    });
    const extractBranch = anyOf[TOOLS.findIndex((t) => t.name === 'extract')];
    expect(extractBranch?.properties.args).toEqual({
      type: 'object',
      properties: { schema: { type: 'object' } },
      required: ['schema'],
      additionalProperties: false,
    });
    expect(toolUnionSchema(TOOLS.slice(0, 1), { maxThoughtChars: 50 })).toMatchObject({
      anyOf: [{ properties: { thought: { maxLength: 50 } } }],
    });
  });
});

describe('parseUnionResponse', () => {
  it('parses plain, fenced and embedded objects', () => {
    expect(parseUnionResponse('{"thought":"go","action":"click","args":{"id":4}}')).toEqual({
      ok: true,
      name: 'click',
      args: { id: 4 },
      thought: 'go',
    });
    expect(parseUnionResponse('  {"action":"back","args":{}}\n')).toEqual({
      ok: true,
      name: 'back',
      args: {},
    });
    expect(parseUnionResponse('```json\n{"action":"back","args":{}}\n```')).toEqual({
      ok: true,
      name: 'back',
      args: {},
    });
    expect(
      parseUnionResponse(
        'Here you go: {"thought":"x","action":"done","args":{"summary":"a {b} c"}} ok',
      ),
    ).toEqual({ ok: true, name: 'done', args: { summary: 'a {b} c' }, thought: 'x' });
  });

  it('tolerates name/arguments aliases, string args and missing args', () => {
    expect(parseUnionResponse('{"name":"click","arguments":"{\\"id\\":1}"}')).toEqual({
      ok: true,
      name: 'click',
      args: { id: 1 },
    });
    expect(parseUnionResponse('{"action":"reload"}')).toEqual({
      ok: true,
      name: 'reload',
      args: {},
    });
  });

  it('reports what is wrong', () => {
    expect(parseUnionResponse('')).toEqual({ ok: false, error: 'the reply was empty' });
    expect(parseUnionResponse('I will click it')).toEqual({
      ok: false,
      error: 'no JSON object found in the reply',
    });
    expect(parseUnionResponse('{"thought":"x","args":{}}')).toEqual({
      ok: false,
      error: 'missing "action" (the tool name)',
    });
    expect(parseUnionResponse('{"action":"click","args":[1]}')).toEqual({
      ok: false,
      error: '"args" must be a JSON object',
    });
    expect(parseUnionResponse('[1,2]')).toEqual({
      ok: false,
      error: 'the reply must be a JSON object',
    });
  });

  it('firstJsonObject skips invalid brace runs and respects strings', () => {
    expect(firstJsonObject('{bad} then {"a":"}"}')).toBe('{"a":"}"}');
    expect(firstJsonObject('no braces')).toBeUndefined();
    expect(firstJsonObject('{"unterminated": ')).toBeUndefined();
  });
});
