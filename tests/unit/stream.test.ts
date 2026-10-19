import { describe, expect, it, vi } from 'vitest';
import { NdjsonParser, SseParser, ndjsonRecords, readText, sseEvents } from '@/providers/stream';
import { collect, fixtureBytes, randomCuts, streamOf } from '../helpers/streams';

const SSE_FIXTURES = [
  'lmstudio-sse-usage.sse',
  'llamacpp-sse-timings.sse',
  'vllm-sse-tools.sse',
  'openai-sse-untagged-think.sse',
  'sse-crlf-comments.sse',
  // Captured from a real Ollama 0.40.6 (ornith-1.5:9b).
  'real-ollama-v1-sse.sse',
  'real-ollama-v1-tools.sse',
];
const NDJSON_FIXTURES = [
  'ollama-chat-basic.ndjson',
  'ollama-chat-tools.ndjson',
  'ollama-chat-thinking.ndjson',
  'ollama-chat-error.ndjson',
  'real-ollama-chat-nothink.ndjson',
  'real-ollama-chat-think.ndjson',
];

describe('SseParser', () => {
  it('parses events, ignores comments and joins multi-line data', () => {
    const p = new SseParser();
    const events = [
      ...p.push(': comment\n\nevent: delta\nid: 7\ndata: a\ndata: b\n\ndata:no-space\n\n'),
      ...p.flush(),
    ];
    expect(events).toEqual([
      { event: 'delta', data: 'a\nb', id: '7' },
      // Per the SSE spec the last event ID persists until a new one is sent.
      { event: 'message', data: 'no-space', id: '7' },
    ]);
  });

  it('handles CRLF and bare CR line endings, including \\r\\n split across pushes', () => {
    const p = new SseParser();
    const events = [...p.push('data: one\r'), ...p.push('\n\r\ndata: two\r\r'), ...p.flush()];
    expect(events.map((e) => e.data)).toEqual(['one', 'two']);
  });

  it('dispatches a trailing event without the final blank line', () => {
    const p = new SseParser();
    expect([...p.push('data: [DONE]'), ...p.flush()]).toEqual([
      { event: 'message', data: '[DONE]' },
    ]);
  });

  it('ignores events without data', () => {
    const p = new SseParser();
    expect([...p.push('event: ping\n\n'), ...p.flush()]).toEqual([]);
  });
});

describe('NdjsonParser', () => {
  it('parses lines, skips blanks, flushes a final unterminated line', () => {
    const p = new NdjsonParser();
    expect([...p.push('{"a":1}\n\n  \n{"b"'), ...p.push(':2}'), ...p.flush()]).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it('reports malformed lines with an excerpt', () => {
    const p = new NdjsonParser();
    expect(() => p.push('{"a":\n')).toThrow(/Malformed NDJSON line: \{"a":/);
  });
});

describe.each(SSE_FIXTURES)('SSE fixture %s', (name) => {
  const bytes = fixtureBytes(name);

  it('parses identically at every single split offset', async () => {
    const whole = await collect(sseEvents(streamOf(bytes)));
    expect(whole.length).toBeGreaterThan(1);
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await collect(sseEvents(streamOf(bytes, [cut])))).toEqual(whole);
    }
  });

  it('parses identically when shredded into many random pieces', async () => {
    const whole = await collect(sseEvents(streamOf(bytes)));
    for (let seed = 1; seed <= 25; seed++) {
      const cuts = randomCuts(bytes.length, 12, seed);
      expect(await collect(sseEvents(streamOf(bytes, cuts)))).toEqual(whole);
    }
  });

  it('parses identically one byte at a time', async () => {
    const whole = await collect(sseEvents(streamOf(bytes)));
    const everyByte = Array.from({ length: bytes.length }, (_, i) => i);
    expect(await collect(sseEvents(streamOf(bytes, everyByte)))).toEqual(whole);
  });
});

describe.each(NDJSON_FIXTURES)('NDJSON fixture %s', (name) => {
  const bytes = fixtureBytes(name);

  it('parses identically at every single split offset', async () => {
    const whole = await collect(ndjsonRecords(streamOf(bytes)));
    expect(whole.length).toBeGreaterThan(1);
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await collect(ndjsonRecords(streamOf(bytes, [cut])))).toEqual(whole);
    }
  });

  it('parses identically one byte at a time', async () => {
    const whole = await collect(ndjsonRecords(streamOf(bytes)));
    const everyByte = Array.from({ length: bytes.length }, (_, i) => i);
    expect(await collect(ndjsonRecords(streamOf(bytes, everyByte)))).toEqual(whole);
  });
});

describe('multi-byte UTF-8', () => {
  it('reassembles characters split inside their byte sequence', async () => {
    const bytes = fixtureBytes('ollama-chat-basic.ndjson');
    const records = (await collect(
      ndjsonRecords(
        streamOf(
          bytes,
          Array.from({ length: bytes.length }, (_, i) => i),
        ),
      ),
    )) as { message?: { content?: string } }[];
    expect(records.map((r) => r.message?.content ?? '').join('')).toBe('Bonjour — ça va? 👋 你好');
  });
});

describe('readText', () => {
  it('times out waiting for the first byte', async () => {
    vi.useFakeTimers();
    const never = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const p = collect(readText(never, { firstByteTimeoutMs: 1000 })).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1001);
    const err = (await p) as Error & { code: string };
    expect(err.code).toBe('E_FIRST_BYTE_TIMEOUT');
    vi.useRealTimers();
  });

  it('times out when an active stream stalls', async () => {
    vi.useFakeTimers();
    let sent = false;
    const stalls = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(new TextEncoder().encode('data: x\n\n'));
          return;
        }
        return new Promise(() => undefined);
      },
    });
    const p = collect(readText(stalls, { idleTimeoutMs: 500 })).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(501);
    expect(((await p) as { code: string }).code).toBe('E_STALLED');
    vi.useRealTimers();
  });

  it('stops promptly when aborted', async () => {
    const ctrl = new AbortController();
    const never = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const p = collect(readText(never, { signal: ctrl.signal })).catch((e: unknown) => e);
    ctrl.abort(new DOMException('stop', 'AbortError'));
    expect(((await p) as Error).name).toBe('AbortError');
  });
});
