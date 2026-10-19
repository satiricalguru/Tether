import { describe, expect, it, vi } from 'vitest';
import { createLogger, redact, redactString, setLogLevel } from '@/lib/logger';

describe('redaction', () => {
  it('scrubs bearer tokens, sk- keys and key query params', () => {
    expect(redactString('Authorization: Bearer abcdefgh12345678')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactString('key sk-proj_ABCDEFGH1234 used')).toBe('key sk-[redacted] used');
    expect(redactString('http://h/v1?api_key=s3cret&x=1')).toBe(
      'http://h/v1?api_key=[redacted]&x=1',
    );
  });

  it('scrubs secret-named fields recursively', () => {
    expect(redact({ baseUrl: 'http://x', apiKey: 'k', nested: [{ token: 't', ok: 1 }] })).toEqual({
      baseUrl: 'http://x',
      apiKey: '[redacted]',
      nested: [{ token: '[redacted]', ok: 1 }],
    });
  });

  it('leaves empty secrets alone so missing keys stay visible', () => {
    expect(redact({ apiKey: '' })).toEqual({ apiKey: '' });
  });

  it('redacts error messages', () => {
    const out = redact(new Error('failed with Bearer abcdefgh12345678')) as Error;
    expect(out.message).toBe('failed with Bearer [redacted]');
  });
});

describe('logger', () => {
  it('prefixes scope, respects level and redacts', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    setLogLevel('warn');
    const log = createLogger('test').child('sub');
    log.debug('hidden');
    log.warn('visible', { apiKey: 'secret' });
    expect(debug).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('[tether:test:sub]', 'visible', { apiKey: '[redacted]' });
    setLogLevel('debug');
  });
});
