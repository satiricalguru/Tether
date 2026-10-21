import { describe, expect, it } from 'vitest';
import { describeSchema, validateArgs } from '@/agent/schema';
import type { ObjectSchema } from '@/agent/types';

const typeArgs: ObjectSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    text: { type: 'string' },
    submit: { type: 'boolean' },
  },
  required: ['id', 'text'],
};

const scrollArgs: ObjectSchema = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['up', 'down'] },
    amount: { type: 'integer', minimum: 1, maximum: 10 },
  },
};

describe('validateArgs', () => {
  it('accepts well-formed arguments unchanged', () => {
    expect(validateArgs(typeArgs, { id: 3, text: 'hello', submit: true })).toEqual({
      ok: true,
      value: { id: 3, text: 'hello', submit: true },
    });
  });

  it('coerces the unambiguous mistakes small models make', () => {
    expect(validateArgs(typeArgs, { id: '42', text: '  padded  ', submit: 'Yes' })).toEqual({
      ok: true,
      value: { id: 42, text: 'padded', submit: true },
    });
    expect(validateArgs(typeArgs, { id: '7.0', text: 5, submit: 0 })).toEqual({
      ok: true,
      value: { id: 7, text: '5', submit: false },
    });
    expect(validateArgs(scrollArgs, { direction: 'DOWN', amount: 3 })).toEqual({
      ok: true,
      value: { direction: 'down', amount: 3 },
    });
  });

  it('accepts a JSON string holding the arguments', () => {
    expect(validateArgs(typeArgs, '{"id": 1, "text": "x"}')).toEqual({
      ok: true,
      value: { id: 1, text: 'x' },
    });
  });

  it('drops unknown keys and nulls for optional properties', () => {
    expect(validateArgs(typeArgs, { id: 1, text: 'x', submit: null, reason: 'because' })).toEqual({
      ok: true,
      value: { id: 1, text: 'x' },
    });
  });

  it('reports the first problem specifically', () => {
    const err = (schema: ObjectSchema, args: unknown) => {
      const r = validateArgs(schema, args);
      return r.ok ? null : r.error;
    };
    expect(err(typeArgs, { text: 'x' })).toBe('missing required argument "id"');
    expect(err(typeArgs, { id: 'abc', text: 'x' })).toBe('args.id must be an integer (got "abc")');
    expect(err(typeArgs, { id: '4.5', text: 'x' })).toBe('args.id must be an integer (got "4.5")');
    expect(err(typeArgs, { id: 4.5, text: 'x' })).toBe('args.id must be an integer (got 4.5)');
    expect(err(typeArgs, { id: 0, text: 'x' })).toBe('args.id must be ≥ 1');
    expect(err(typeArgs, { id: 1, text: 'x', submit: 'maybe' })).toBe(
      'args.submit must be true or false (got "maybe")',
    );
    expect(err(typeArgs, { id: 1, text: { a: 1 } })).toBe(
      'args.text must be a string (got {"a":1})',
    );
    expect(err(typeArgs, { id: 1, text: null })).toBe('missing required argument "text"');
    expect(err(scrollArgs, { direction: 'sideways' })).toBe(
      'args.direction must be one of "up", "down"',
    );
    expect(err(scrollArgs, { amount: 11 })).toBe('args.amount must be ≤ 10');
    expect(err(typeArgs, 'not json')).toBe('args must be an object (got "not json")');
    expect(err(typeArgs, [1, 2])).toBe('args must be an object (got [1,2])');
  });

  it('truncates long values in error messages', () => {
    const r = validateArgs(typeArgs, { id: 'x'.repeat(100), text: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeLessThan(90);
  });

  it('validates arrays: wraps single values, parses JSON arrays, checks items and length', () => {
    const s: ObjectSchema = {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 3 } },
      required: ['ids'],
    };
    expect(validateArgs(s, { ids: 5 })).toEqual({ ok: true, value: { ids: [5] } });
    expect(validateArgs(s, { ids: '[1, "2"]' })).toEqual({ ok: true, value: { ids: [1, 2] } });
    expect(validateArgs(s, { ids: [1, 'x'] })).toEqual({
      ok: false,
      error: 'args.ids[1] must be an integer (got "x")',
    });
    expect(validateArgs(s, { ids: [1, 2, 3, 4] })).toEqual({
      ok: false,
      error: 'args.ids must have at most 3 items',
    });
  });

  it('validates nested objects with dotted paths', () => {
    const s: ObjectSchema = {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { min: { type: 'number' }, label: { type: 'string', maxLength: 5 } },
          required: ['min'],
        },
      },
      required: ['filter'],
    };
    expect(validateArgs(s, { filter: { min: '2.5e1' } })).toEqual({
      ok: true,
      value: { filter: { min: 25 } },
    });
    expect(validateArgs(s, { filter: '{"min": 1}' })).toEqual({
      ok: true,
      value: { filter: { min: 1 } },
    });
    expect(validateArgs(s, { filter: {} })).toEqual({
      ok: false,
      error: 'missing required argument "filter.min"',
    });
    expect(validateArgs(s, { filter: { min: 1, label: 'toolong' } })).toEqual({
      ok: false,
      error: 'args.filter.label must be at most 5 characters',
    });
  });

  it('keeps free-form objects as given', () => {
    const s: ObjectSchema = {
      type: 'object',
      properties: { schema: { type: 'object', properties: {}, additionalProperties: true } },
      required: ['schema'],
    };
    const value = { title: 'string', items: [{ price: 'number' }] };
    const r = validateArgs(s, { schema: value });
    expect(r).toEqual({ ok: true, value: { schema: value } });
    if (r.ok) expect(r.value.schema).not.toBe(value);
  });

  it('accepts an empty object for tools without arguments', () => {
    const none: ObjectSchema = { type: 'object', properties: {} };
    expect(validateArgs(none, {})).toEqual({ ok: true, value: {} });
    expect(validateArgs(none, { junk: 1 })).toEqual({ ok: true, value: {} });
  });

  it('never mutates the input', () => {
    const input = { id: '42', text: '  a  ', extra: true };
    const snapshot = structuredClone(input);
    validateArgs(typeArgs, input);
    expect(input).toEqual(snapshot);
  });
});

describe('describeSchema', () => {
  it('renders compact type text for prompts', () => {
    expect(describeSchema(typeArgs)).toBe('{ id: integer, text: string, submit?: boolean }');
    expect(describeSchema(scrollArgs)).toBe('{ direction?: "up" | "down", amount?: integer }');
    expect(describeSchema({ type: 'object', properties: {} })).toBe('{}');
    expect(describeSchema({ type: 'object', properties: {}, additionalProperties: true })).toBe(
      'object',
    );
    expect(describeSchema({ type: 'array', items: { type: 'string', enum: ['a', 'b'] } })).toBe(
      '("a" | "b")[]',
    );
    expect(describeSchema({ type: 'array', items: { type: 'number' } })).toBe('number[]');
  });
});
