import { describe, expect, it } from 'vitest';
import {
  HttpClient,
  ProviderError,
  diagnoseError,
  extractServerMessage,
  isLocalUrl,
  normalizeBaseUrl,
} from '@/providers/http';
import { fakeFetch, json } from '../helpers/fake-fetch';

function client(routes: Parameters<typeof fakeFetch>[0], allowed = ['http://127.0.0.1:1']) {
  const { impl, calls } = fakeFetch(routes);
  return {
    calls,
    http: new HttpClient({
      isAllowedOrigin: (o) => allowed.includes(o),
      hasHostPermission: (o) => Promise.resolve(o === 'http://granted.lan:8000'),
      fetchImpl: impl,
    }),
  };
}

async function errorOf(p: Promise<unknown>): Promise<ProviderError> {
  const e = await p.catch((err: unknown) => err);
  if (!(e instanceof ProviderError)) throw new Error(`expected ProviderError, got ${String(e)}`);
  return e;
}

describe('HttpClient', () => {
  it('refuses origins that are not configured, without fetching', async () => {
    const { http, calls } = client({ 'GET /x': () => json({}) });
    const err = await errorOf(http.request('http://evil.example/x'));
    expect(err.code).toBe('E_EGRESS_BLOCKED');
    expect(calls).toHaveLength(0);
  });

  it('requires a granted host permission for non-local origins', async () => {
    const { http, calls } = client({ 'GET /v1/models': () => json({ data: [] }) }, [
      'http://box.lan:8000',
      'http://granted.lan:8000',
    ]);
    expect((await errorOf(http.request('http://box.lan:8000/v1/models'))).code).toBe(
      'E_NEEDS_PERMISSION',
    );
    await expect(http.json('http://granted.lan:8000/v1/models')).resolves.toEqual({ data: [] });
    expect(calls).toHaveLength(1);
  });

  it('classifies connection failures, timeouts, origin blocks and auth', async () => {
    const { http } = client({
      'GET /slow': () => new Promise(() => undefined),
      'GET /forbidden': () => new Response('', { status: 403 }),
      'GET /auth': () => json({ error: { message: 'bad key' } }, 401),
      'GET /boom': () => json({ error: 'model not found' }, 404),
      'GET /text': () => new Response('not json'),
    });
    const base = 'http://127.0.0.1:1';
    const cases = await Promise.all([
      errorOf(http.request(`${base}/closed`)),
      errorOf(http.request(`${base}/slow`, { timeoutMs: 20 })),
      errorOf(http.request(`${base}/forbidden`)),
      errorOf(http.request(`${base}/auth`)),
      errorOf(http.request(`${base}/boom`)),
      errorOf(http.json(`${base}/text`)),
    ]);
    expect(cases.map((e) => e.code)).toEqual([
      'E_UNREACHABLE',
      'E_TIMEOUT',
      'E_ORIGIN_BLOCKED',
      'E_AUTH',
      'E_HTTP',
      'E_BAD_RESPONSE',
    ]);
    expect(cases.map(diagnoseError)).toEqual([
      'unreachable',
      'timeout',
      'origin-blocked',
      'auth-required',
      'http-error',
      'bad-response',
    ]);
    expect(cases[4].serverMessage).toBe('model not found');
    expect(cases[4].status).toBe(404);
  });

  it('propagates the caller abort rather than reporting a timeout', async () => {
    const { http } = client({ 'GET /slow': () => new Promise(() => undefined) });
    const ctrl = new AbortController();
    const p = http.request('http://127.0.0.1:1/slow', { signal: ctrl.signal, timeoutMs: 5000 });
    ctrl.abort(new DOMException('stop', 'AbortError'));
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('sends the API key as a bearer token and JSON content type for bodies', async () => {
    const { http, calls } = client({ 'POST /v1/x': () => json({}) });
    await http.json('http://127.0.0.1:1/v1/x', { method: 'POST', body: '{}', apiKey: 'sk-test' });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-test');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });
});

describe('url helpers', () => {
  it('normalizes base URLs', () => {
    expect(normalizeBaseUrl(' localhost:11434/ ')).toBe('http://localhost:11434');
    expect(normalizeBaseUrl('http://box:8000/v1/')).toBe('http://box:8000/v1');
    expect(normalizeBaseUrl('https://[::1]:1234')).toBe('https://[::1]:1234');
    expect(() => normalizeBaseUrl('http://')).toThrow();
  });

  it('recognizes loopback hosts', () => {
    expect(isLocalUrl('http://localhost:1')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:1')).toBe(true);
    expect(isLocalUrl('http://[::1]:1')).toBe(true);
    expect(isLocalUrl('http://192.168.1.4:1')).toBe(false);
  });

  it('extracts server messages from common error shapes', () => {
    expect(extractServerMessage('{"error":"x"}')).toBe('x');
    expect(extractServerMessage('{"error":{"message":"y"}}')).toBe('y');
    expect(extractServerMessage('{"detail":"z"}')).toBe('z');
    expect(extractServerMessage('plain text')).toBe('plain text');
    expect(extractServerMessage('  ')).toBeUndefined();
  });
});
