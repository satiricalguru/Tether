import { TetherError } from '@/lib/errors';

/**
 * Incremental parsers for the two streaming formats local servers use:
 *   - Server-Sent Events (OpenAI-compatible: LM Studio, llama.cpp, vLLM, ...)
 *   - Newline-delimited JSON (Ollama native API)
 *
 * Network chunks split anywhere — mid-line, mid-JSON, between \r and \n,
 * inside a multi-byte UTF-8 sequence — so both parsers buffer and only emit
 * complete records. They are pure (`push(text)` → records) so they can be
 * tested exhaustively at every split offset.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private id: string | undefined;
  private hasData = false;

  push(text: string): SseEvent[] {
    this.buffer += text;
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      // A trailing \r might be the first half of \r\n; wait for more input.
      if (ch === '\r' && i === this.buffer.length - 1) break;
      const line = this.buffer.slice(start, i);
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
      this.line(line, out);
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** End of stream: dispatch a final event even if the blank line never came. */
  flush(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const rest = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      this.line(rest, out);
    }
    this.dispatch(out);
    return out;
  }

  private line(line: string, out: SseEvent[]) {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data.push(value);
        this.hasData = true;
        break;
      case 'event':
        this.event = value;
        break;
      case 'id':
        this.id = value;
        break;
      default:
        // `retry` and unknown fields are irrelevant for model streams.
        break;
    }
  }

  private dispatch(out: SseEvent[]) {
    if (this.hasData) {
      const ev: SseEvent = { event: this.event || 'message', data: this.data.join('\n') };
      if (this.id !== undefined) ev.id = this.id;
      out.push(ev);
    }
    this.data = [];
    this.event = '';
    this.hasData = false;
  }
}

export class NdjsonParser {
  private buffer = '';

  push(text: string): unknown[] {
    this.buffer += text;
    const out: unknown[] = [];
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.parseLine(line, out);
      nl = this.buffer.indexOf('\n');
    }
    return out;
  }

  flush(): unknown[] {
    const out: unknown[] = [];
    const rest = this.buffer;
    this.buffer = '';
    this.parseLine(rest, out);
    return out;
  }

  private parseLine(raw: string, out: unknown[]) {
    const line = raw.trim();
    if (!line) return;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new TetherError('E_BAD_STREAM', `Malformed NDJSON line: ${line.slice(0, 120)}`);
    }
  }
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** Max silence between chunks once the first byte has arrived. */
  idleTimeoutMs?: number;
  /** Max wait for the first byte (covers cold model loads). */
  firstByteTimeoutMs?: number;
}

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_FIRST_BYTE_MS = 10 * 60_000;

/** Decode a byte stream to text chunks, enforcing first-byte and idle timeouts. */
export async function* readText(
  body: ReadableStream<Uint8Array>,
  options: ReadOptions = {},
): AsyncGenerator<string, void, void> {
  const {
    signal,
    idleTimeoutMs = DEFAULT_IDLE_MS,
    firstByteTimeoutMs = DEFAULT_FIRST_BYTE_MS,
  } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let first = true;
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason as Error;
      const limit = first ? firstByteTimeoutMs : idleTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new TetherError(
              first ? 'E_FIRST_BYTE_TIMEOUT' : 'E_STALLED',
              first
                ? `No response from the model after ${Math.round(limit / 1000)}s`
                : `The stream stalled for ${Math.round(limit / 1000)}s`,
            ),
          );
        }, limit);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (signal?.aborted) throw signal.reason as Error;
      if (result.done) break;
      first = false;
      const text = decoder.decode(result.value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } catch (err) {
    reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A read was still pending after cancel; the stream is done either way.
    }
  }
}

export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  options?: ReadOptions,
): AsyncGenerator<SseEvent, void, void> {
  const parser = new SseParser();
  for await (const text of readText(body, options)) yield* parser.push(text);
  yield* parser.flush();
}

export async function* ndjsonRecords(
  body: ReadableStream<Uint8Array>,
  options?: ReadOptions,
): AsyncGenerator<unknown, void, void> {
  const parser = new NdjsonParser();
  for await (const text of readText(body, options)) yield* parser.push(text);
  yield* parser.flush();
}
