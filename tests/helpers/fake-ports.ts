import { fakeBrowser } from 'wxt/testing/fake-browser';

/**
 * In-memory `runtime.connect` / `runtime.onConnect` for tests. Mirrors Chrome
 * semantics that the streaming code relies on:
 *  - messages are delivered asynchronously and structured-cloned
 *  - `disconnect()` fires `onDisconnect` on the *other* end only
 *  - posting on a disconnected port throws
 */

type Listener<A extends unknown[]> = (...args: A) => void;

class FakeEvent<A extends unknown[]> {
  private listeners: Listener<A>[] = [];
  addListener(l: Listener<A>) {
    this.listeners.push(l);
  }
  removeListener(l: Listener<A>) {
    this.listeners = this.listeners.filter((x) => x !== l);
  }
  hasListener(l: Listener<A>) {
    return this.listeners.includes(l);
  }
  hasListeners() {
    return this.listeners.length > 0;
  }
  emit(...args: A) {
    for (const l of [...this.listeners]) l(...args);
  }
}

export class FakePort {
  readonly onMessage = new FakeEvent<[unknown, FakePort]>();
  readonly onDisconnect = new FakeEvent<[FakePort]>();
  peer!: FakePort;
  connected = true;
  sender = { id: fakeBrowser.runtime.id };
  /** Every message this end has posted / received, for assertions. */
  readonly posted: unknown[] = [];
  readonly received: unknown[] = [];

  constructor(readonly name: string) {}

  postMessage(message: unknown) {
    if (!this.connected) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(message);
    const clone = structuredClone(message);
    const peer = this.peer;
    queueMicrotask(() => {
      if (!peer.connected) return;
      peer.received.push(clone);
      peer.onMessage.emit(clone, peer);
    });
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    const peer = this.peer;
    queueMicrotask(() => {
      if (!peer.connected) return;
      peer.connected = false;
      peer.onDisconnect.emit(peer);
    });
  }
}

export interface FakePorts {
  onConnect: FakeEvent<[FakePort]>;
  /** Server-side ends of every connection, in order. */
  serverPorts: FakePort[];
  uninstall(): void;
}

let current: FakePorts | undefined;

/** The fake port layer installed for the running test. */
export function fakePorts(): FakePorts {
  if (!current) throw new Error('fake ports are not installed');
  return current;
}

export function installFakePorts(): FakePorts {
  const onConnect = new FakeEvent<[FakePort]>();
  const serverPorts: FakePort[] = [];
  const runtime = fakeBrowser.runtime as unknown as Record<string, unknown>;
  const previous = { connect: runtime.connect, onConnect: runtime.onConnect };

  runtime.connect = (info?: { name?: string }) => {
    const name = info?.name ?? '';
    const client = new FakePort(name);
    const server = new FakePort(name);
    client.peer = server;
    server.peer = client;
    serverPorts.push(server);
    queueMicrotask(() => {
      onConnect.emit(server);
    });
    return client;
  };
  runtime.onConnect = onConnect;

  current = {
    onConnect,
    serverPorts,
    uninstall() {
      runtime.connect = previous.connect;
      runtime.onConnect = previous.onConnect;
      current = undefined;
    },
  };
  return current;
}
