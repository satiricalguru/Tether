import { TetherError } from '@/lib/errors';
import type { Diagnosis } from './types';

/**
 * The only way Tether talks to the network. Every request is checked against
 * the set of origins the user configured; anything else is refused before a
 * socket is opened. This is the runtime half of the zero-egress guarantee.
 */

export type ProviderErrorCode =
  | 'E_UNREACHABLE'
  | 'E_TIMEOUT'
  | 'E_ORIGIN_BLOCKED'
  | 'E_NEEDS_PERMISSION'
  | 'E_AUTH'
  | 'E_HTTP'
  | 'E_BAD_RESPONSE'
  | 'E_EGRESS_BLOCKED';

export class ProviderError extends TetherError {
  readonly status?: number;
  readonly serverMessage?: string;

  constructor(
    code: ProviderErrorCode,
    message: string,
    extra: { status?: number; serverMessage?: string; cause?: unknown } = {},
  ) {
    super(code, message, { cause: extra.cause });
    this.name = 'ProviderError';
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.serverMessage !== undefined) this.serverMessage = extra.serverMessage;
  }
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalUrl(url: string | URL): boolean {
  const u = typeof url === 'string' ? new URL(url) : url;
  return LOCAL_HOSTNAMES.has(u.hostname);
}

/** Normalize a user-entered base URL: trim, default scheme, no trailing slash. */
export function normalizeBaseUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

/** Pull a human message out of common error bodies: {error:"…"} / {error:{message}} / text. */
export function extractServerMessage(body: string): string | undefined {
  const text = body.trim();
  if (!text) return undefined;
  try {
    const json = JSON.parse(text) as unknown;
    if (json && typeof json === 'object') {
      const err =
        (json as Record<string, unknown>).error ?? (json as Record<string, unknown>).detail;
      if (typeof err === 'string') return err;
      if (err && typeof err === 'object') {
        const msg = (err as Record<string, unknown>).message;
        if (typeof msg === 'string') return msg;
      }
      const msg = (json as Record<string, unknown>).message;
      if (typeof msg === 'string') return msg;
    }
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}

export interface HttpClientOptions {
  /** Is this origin one the user configured (or a discovery candidate)? */
  isAllowedOrigin: (origin: string) => boolean;
  /** Non-local origins also need a granted host permission. */
  hasHostPermission?: (origin: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions extends Omit<RequestInit, 'signal'> {
  signal?: AbortSignal;
  /** Abort if the response headers haven't arrived in time. */
  timeoutMs?: number;
  apiKey?: string;
}

export class HttpClient {
  constructor(private readonly opts: HttpClientOptions) {}

  async request(url: string, options: RequestOptions = {}): Promise<Response> {
    const { timeoutMs, apiKey, signal, headers, ...init } = options;
    const origin = originOf(url);
    if (!this.opts.isAllowedOrigin(origin)) {
      throw new ProviderError(
        'E_EGRESS_BLOCKED',
        `Refusing to contact ${origin}: it is not a configured model endpoint`,
      );
    }
    if (
      !isLocalUrl(url) &&
      this.opts.hasHostPermission &&
      !(await this.opts.hasHostPermission(origin))
    ) {
      throw new ProviderError('E_NEEDS_PERMISSION', `Tether needs permission to reach ${origin}`);
    }

    const finalHeaders = new Headers(headers);
    if (apiKey) finalHeaders.set('Authorization', `Bearer ${apiKey}`);
    if (init.body !== undefined && !finalHeaders.has('Content-Type')) {
      finalHeaders.set('Content-Type', 'application/json');
    }

    const timeout = timeoutMs === undefined ? undefined : new AbortController();
    const timer =
      timeout &&
      setTimeout(() => {
        timeout.abort(new DOMException('timeout', 'TimeoutError'));
      }, timeoutMs);
    const signals = [signal, timeout?.signal].filter((s): s is AbortSignal => !!s);
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, { ...init, headers: finalHeaders, signal: combined });
    } catch (err) {
      if (signal?.aborted) throw signal.reason as Error;
      if (timeout?.signal.aborted) {
        throw new ProviderError('E_TIMEOUT', `${origin} did not answer within ${timeoutMs}ms`, {
          cause: err,
        });
      }
      throw new ProviderError('E_UNREACHABLE', `Could not connect to ${origin}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return res;

    const body = await res.text().catch(() => '');
    const serverMessage = extractServerMessage(body);
    if (res.status === 403 && !body.trim()) {
      throw new ProviderError(
        'E_ORIGIN_BLOCKED',
        `${origin} rejected the request's origin (HTTP 403)`,
        { status: 403 },
      );
    }
    if (res.status === 401) {
      throw new ProviderError('E_AUTH', `${origin} requires an API key (HTTP 401)`, {
        status: 401,
        ...(serverMessage === undefined ? {} : { serverMessage }),
      });
    }
    throw new ProviderError(
      'E_HTTP',
      `${origin} returned HTTP ${res.status}${serverMessage ? `: ${serverMessage}` : ''}`,
      { status: res.status, ...(serverMessage === undefined ? {} : { serverMessage }) },
    );
  }

  async json(url: string, options: RequestOptions = {}): Promise<unknown> {
    const res = await this.request(url, options);
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new ProviderError('E_BAD_RESPONSE', `${originOf(url)} returned invalid JSON`, {
        status: res.status,
        cause: err,
      });
    }
  }
}

export function diagnoseError(err: unknown): Diagnosis {
  if (!(err instanceof ProviderError)) return 'http-error';
  switch (err.code as ProviderErrorCode) {
    case 'E_UNREACHABLE':
    case 'E_EGRESS_BLOCKED':
      return 'unreachable';
    case 'E_TIMEOUT':
      return 'timeout';
    case 'E_ORIGIN_BLOCKED':
      return 'origin-blocked';
    case 'E_NEEDS_PERMISSION':
      return 'needs-permission';
    case 'E_AUTH':
      return 'auth-required';
    case 'E_BAD_RESPONSE':
      return 'bad-response';
    case 'E_HTTP':
      return 'http-error';
  }
}
