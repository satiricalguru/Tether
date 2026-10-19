import { HttpClient } from '@/providers/http';
import { memoryOverrides } from '@/providers/overrides';
import { createProvider } from '@/providers/registry';
import type { ProviderConfig, ProviderKind } from '@/providers/types';

export interface FakeCall {
  method: string;
  url: string;
  body: unknown;
  headers: Headers;
}

type Route = (call: FakeCall) => Response | Promise<Response>;

/** fetch() stand-in routing on "METHOD /path". Unknown routes are connection failures. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: FakeCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const call: FakeCall = {
      method,
      url: url.href,
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : null,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason as Error;
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw new TypeError('Failed to fetch');
    const signal = init?.signal;
    if (!signal) return route(call);
    // Real fetch rejects as soon as its signal aborts, even mid-request.
    return Promise.race([
      route(call),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        );
      }),
    ]);
  }) as typeof fetch;
  return { impl, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function makeProvider(
  kind: ProviderKind,
  routes: Record<string, Route>,
  config: Partial<ProviderConfig> = {},
) {
  const { impl, calls } = fakeFetch(routes);
  const overrides = memoryOverrides();
  const http = new HttpClient({ isAllowedOrigin: () => true, fetchImpl: impl });
  const provider = createProvider(
    {
      instanceId: kind,
      kind,
      label: kind,
      baseUrl: 'http://127.0.0.1:9999',
      enabled: true,
      apiKey: '',
      useOpenAICompat: false,
      ...config,
    },
    { http, overrides },
  );
  return { provider, calls, overrides };
}
