import { browser, type Browser } from 'wxt/browser';
import { AsyncQueue } from './async-queue';
import { deserializeError, serializeError, type SerializedError } from './errors';
import type { StreamChunk, StreamDone, StreamInput, StreamName, StreamRequest } from './protocol';

/**
 * Streaming over `runtime.Port`.
 *
 * A port is the right primitive for model output: it is ordered, it keeps the
 * MV3 service worker alive while messages flow, and disconnecting it is a
 * free, reliable cancellation signal in both directions.
 */

const PREFIX = 'tether:stream:';

type ClientMessage =
  | { t: 'start'; payload: unknown }
  | { t: 'heartbeat' }
  /** Client → server data during a stream (e.g. a confirmation answer). */
  | { t: 'input'; data: unknown };
type ServerMessage =
  | { t: 'chunk'; data: unknown }
  | { t: 'done'; data: unknown }
  | { t: 'error'; error: SerializedError };

type Port = Browser.runtime.Port;

export interface StreamHandle<K extends StreamName> extends AsyncIterable<StreamChunk<K>> {
  /** Resolves with the final value; rejects on error or abort. */
  readonly done: Promise<StreamDone<K>>;
  abort(): void;
  /** Send data to the running handler (streams that declare `input`). */
  send(data: StreamInput<K>): void;
}

export interface OpenStreamOptions {
  signal?: AbortSignal;
  /**
   * The client pings this often so the worker's idle timer resets even while
   * the server is silent (e.g. a cold model load before the first token).
   */
  heartbeatMs?: number;
}

function abortError(): DOMException {
  return new DOMException('The stream was aborted', 'AbortError');
}

export function openStream<K extends StreamName>(
  name: K,
  request: StreamRequest<K>,
  options: OpenStreamOptions = {},
): StreamHandle<K> {
  const { signal, heartbeatMs = 20_000 } = options;
  const queue = new AsyncQueue<StreamChunk<K>>();
  let settled = false;
  let resolveDone!: (v: StreamDone<K>) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<StreamDone<K>>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Consumers that only iterate shouldn't trigger unhandled-rejection noise.
  done.catch(() => undefined);

  const port = browser.runtime.connect({ name: PREFIX + name });
  const heartbeat = setInterval(() => {
    if (!settled) port.postMessage({ t: 'heartbeat' } satisfies ClientMessage);
  }, heartbeatMs);

  const finish = (outcome: { ok: true; value: StreamDone<K> } | { ok: false; error: unknown }) => {
    if (settled) return;
    settled = true;
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', abort);
    if (outcome.ok) {
      queue.end();
      resolveDone(outcome.value);
    } else {
      queue.fail(outcome.error);
      rejectDone(outcome.error);
    }
  };

  function abort() {
    if (settled) return;
    finish({ ok: false, error: abortError() });
    port.disconnect();
  }

  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as ServerMessage;
    switch (msg.t) {
      case 'chunk':
        queue.push(msg.data as StreamChunk<K>);
        break;
      case 'done':
        finish({ ok: true, value: msg.data as StreamDone<K> });
        port.disconnect();
        break;
      case 'error':
        finish({ ok: false, error: deserializeError(msg.error) });
        port.disconnect();
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    finish({ ok: false, error: new Error(`Stream "${name}" disconnected before completing`) });
  });

  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener('abort', abort);
    port.postMessage({ t: 'start', payload: request } satisfies ClientMessage);
  }

  const send = (data: StreamInput<K>) => {
    if (!settled) port.postMessage({ t: 'input', data } satisfies ClientMessage);
  };

  return {
    done,
    abort,
    send,
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  };
}

export interface StreamContext {
  /**
   * Subscribe to client input. Input that arrived before subscribing is
   * delivered on subscription. Returns an unsubscribe function.
   */
  onInput: (listener: (data: unknown) => void) => () => void;
  signal: AbortSignal;
  sender: Port['sender'];
}

export type StreamHandler<K extends StreamName> = (
  request: StreamRequest<K>,
  ctx: StreamContext,
) => AsyncGenerator<StreamChunk<K>, StreamDone<K>, void>;

export type StreamHandlerMap = { [K in StreamName]?: StreamHandler<K> };

export interface StreamServerOptions {
  /** Called whenever the number of in-flight streams changes. */
  onActiveChange?: (active: number) => void;
}

/**
 * Serve streams from this context (normally the background worker). Each
 * connection runs its handler with an AbortSignal that fires when the client
 * disconnects. Returns an unsubscribe function.
 */
export function registerStreamHandlers(
  handlers: StreamHandlerMap,
  options: StreamServerOptions = {},
): () => void {
  let active = 0;
  const setActive = (delta: number) => {
    active += delta;
    options.onActiveChange?.(active);
  };

  const onConnect = (port: Port) => {
    if (!port.name.startsWith(PREFIX)) return;
    const name = port.name.slice(PREFIX.length) as StreamName;
    const handler = handlers[name];
    if (!handler) return;

    const controller = new AbortController();
    let started = false;
    let disconnected = false;
    const pendingInput: unknown[] = [];
    const inputListeners = new Set<(data: unknown) => void>();
    const onInput = (listener: (data: unknown) => void) => {
      inputListeners.add(listener);
      for (const d of pendingInput.splice(0)) listener(d);
      return () => {
        inputListeners.delete(listener);
      };
    };

    const post = (msg: ServerMessage) => {
      if (disconnected) return;
      try {
        port.postMessage(msg);
      } catch {
        // Port closed between the check and the post.
        disconnected = true;
      }
    };

    port.onDisconnect.addListener(() => {
      disconnected = true;
      controller.abort(abortError());
    });

    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as ClientMessage;
      if (msg.t === 'input') {
        if (inputListeners.size === 0) pendingInput.push(msg.data);
        for (const l of inputListeners) l(msg.data);
        return;
      }
      if (msg.t !== 'start' || started) return;
      started = true;
      setActive(1);
      void (async () => {
        try {
          const iterator = handler(msg.payload as never, {
            signal: controller.signal,
            sender: port.sender,
            onInput,
          });
          for (;;) {
            const step = await iterator.next();
            if (controller.signal.aborted) {
              await iterator.return(undefined as never);
              break;
            }
            if (step.done) {
              post({ t: 'done', data: step.value });
              break;
            }
            post({ t: 'chunk', data: step.value });
          }
        } catch (err) {
          if (!controller.signal.aborted) post({ t: 'error', error: serializeError(err) });
        } finally {
          setActive(-1);
        }
      })();
    });
  };

  browser.runtime.onConnect.addListener(onConnect);
  return () => {
    browser.runtime.onConnect.removeListener(onConnect);
  };
}

/** Context for calling a stream handler directly (no port, no client input). */
export function directContext(signal: AbortSignal): StreamContext {
  return { signal, sender: undefined, onInput: () => () => undefined };
}
