import { afterEach, describe, expect, it, vi } from 'vitest';
import { echoStream, tokenize } from '@/background/echo';
import { isAbortError } from '@/lib/errors';
import { openStream, registerStreamHandlers, type StreamHandler } from '@/lib/ports';
import { fakePorts } from '../helpers/fake-ports';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('port streaming', () => {
  it('streams every chunk in order, then resolves done', async () => {
    registerStreamHandlers({ echo: echoStream });
    const stream = openStream('echo', { text: 'one two  three', delayMs: 0 });
    const chunks = await collect(stream);
    expect(chunks.map((c) => c.token).join('')).toBe('one two  three');
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    await expect(stream.done).resolves.toEqual({ count: 3 });
  });

  it('abort cancels the server handler and rejects with AbortError', async () => {
    let serverSignal: AbortSignal | undefined;
    let produced = 0;
    const slow: StreamHandler<'echo'> = async function* (_req, { signal }) {
      serverSignal = signal;
      for (;;) {
        await new Promise((r) => setTimeout(r, 5));
        produced += 1;
        yield { token: 'x', index: produced };
      }
    };
    registerStreamHandlers({ echo: slow });

    const stream = openStream('echo', { text: '' });
    const seen: string[] = [];
    const consumed = (async () => {
      for await (const c of stream) {
        seen.push(c.token);
        if (seen.length === 2) stream.abort();
      }
    })();

    const err = await consumed.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(await stream.done.catch((e: unknown) => e))).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(serverSignal?.aborted).toBe(true);
    const producedAtAbort = produced;
    await new Promise((r) => setTimeout(r, 20));
    expect(produced).toBe(producedAtAbort);
  });

  it('honours an external AbortSignal, including one aborted up front', async () => {
    registerStreamHandlers({ echo: echoStream });
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = openStream('echo', { text: 'a b' }, { signal: ctrl.signal });
    expect(isAbortError(await stream.done.catch((e: unknown) => e))).toBe(true);
  });

  it('delivers server errors to the client', async () => {
    // eslint-disable-next-line require-yield -- the failure is the point
    const failing: StreamHandler<'echo'> = async function* () {
      await Promise.resolve();
      throw new Error('model exploded');
    };
    registerStreamHandlers({ echo: failing });
    const stream = openStream('echo', { text: 'x' });
    await expect(collect(stream)).rejects.toThrow('model exploded');
    await expect(stream.done).rejects.toThrow('model exploded');
  });

  it('fails the stream if the server side goes away mid-stream', async () => {
    const hang: StreamHandler<'echo'> = async function* () {
      yield { token: 'first', index: 0 };
      await new Promise(() => undefined);
      return { count: 1 };
    };
    registerStreamHandlers({ echo: hang });
    const stream = openStream('echo', { text: 'x' });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: { token: 'first', index: 0 },
      done: false,
    });
    // Simulate the worker being killed: the server end disconnects.
    for (const port of fakePorts().serverPorts) port.disconnect();
    await expect(stream.done).rejects.toThrow('disconnected before completing');
  });

  it('reports the number of in-flight streams', async () => {
    const counts: number[] = [];
    registerStreamHandlers({ echo: echoStream }, { onActiveChange: (n) => counts.push(n) });
    const a = openStream('echo', { text: 'a b', delayMs: 0 });
    const b = openStream('echo', { text: 'c', delayMs: 0 });
    await Promise.all([a.done, b.done]);
    expect(counts).toContain(2);
    expect(counts.at(-1)).toBe(0);
  });

  it('ignores connections for streams it does not serve', async () => {
    registerStreamHandlers({});
    const stream = openStream('echo', { text: 'a' });
    await flush();
    stream.abort();
    expect(isAbortError(await stream.done.catch((e: unknown) => e))).toBe(true);
  });

  it('sends heartbeats while the server is silent', async () => {
    vi.useFakeTimers();
    const silent: StreamHandler<'echo'> = async function* () {
      await new Promise(() => undefined);
      yield { token: '', index: 0 };
      return { count: 0 };
    };
    registerStreamHandlers({ echo: silent });
    const stream = openStream('echo', { text: '' }, { heartbeatMs: 1000 });
    await vi.advanceTimersByTimeAsync(3500);
    const server = fakePorts().serverPorts.at(-1)!;
    const heartbeats = server.received.filter((m) => (m as { t: string }).t === 'heartbeat');
    expect(heartbeats).toHaveLength(3);
    stream.abort();
  });
});

describe('tokenize', () => {
  it('keeps whitespace attached so tokens rejoin exactly', () => {
    const text = '  hello  world\nnext ';
    expect(tokenize(text).join('')).toBe(text);
  });
  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});
