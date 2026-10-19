import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { TetherError } from '@/lib/errors';
import { isEnvelope, registerHandlers, sendMessage } from '@/lib/messaging';

describe('messaging', () => {
  it('round-trips a typed request through registered handlers', async () => {
    registerHandlers({
      'bg:ping': () => ({ pong: true, version: '9.9.9', at: 1 }),
    });
    await expect(sendMessage('bg:ping')).resolves.toEqual({ pong: true, version: '9.9.9', at: 1 });
  });

  it('passes payload and supports async handlers', async () => {
    registerHandlers({
      'bg:ensure-content-script': async ({ tabId }) => {
        await Promise.resolve();
        return { injected: tabId === 7 };
      },
    });
    await expect(sendMessage('bg:ensure-content-script', { tabId: 7 })).resolves.toEqual({
      injected: true,
    });
  });

  it('propagates handler errors with their code instead of hanging', async () => {
    registerHandlers({
      'bg:ping': () => {
        throw new TetherError('E_NOPE', 'nope');
      },
    });
    const err = await sendMessage('bg:ping').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TetherError);
    expect((err as TetherError).code).toBe('E_NOPE');
    expect((err as TetherError).message).toBe('nope');
  });

  it('only answers its own message types so other contexts can respond', async () => {
    registerHandlers({ 'offscreen:ping': () => ({ pong: true, version: 'off', at: 2 }) });
    registerHandlers({ 'bg:ping': () => ({ pong: true, version: 'bg', at: 3 }) });
    await expect(sendMessage('bg:ping')).resolves.toMatchObject({ version: 'bg' });
    await expect(sendMessage('offscreen:ping')).resolves.toMatchObject({ version: 'off' });
  });

  it('rejects clearly when nobody handles a type', async () => {
    registerHandlers({ 'bg:ping': () => ({ pong: true, version: 'x', at: 0 }) });
    await expect(sendMessage('offscreen:ping')).rejects.toThrow(
      'No handler responded to "offscreen:ping"',
    );
  });

  it('ignores foreign messages', async () => {
    registerHandlers({ 'bg:ping': () => ({ pong: true, version: 'x', at: 0 }) });
    await expect(fakeBrowser.runtime.sendMessage({ type: 'bg:ping' })).resolves.toBeUndefined();
  });

  it('unsubscribes', async () => {
    const off = registerHandlers({ 'bg:ping': () => ({ pong: true, version: 'x', at: 0 }) });
    off();
    registerHandlers({ 'offscreen:ping': () => ({ pong: true, version: 'y', at: 0 }) });
    await expect(sendMessage('bg:ping')).rejects.toThrow('No handler responded');
  });

  it('recognises envelopes', () => {
    expect(isEnvelope({ __tether: 1, type: 'bg:ping' })).toBe(true);
    expect(isEnvelope({ type: 'bg:ping' })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope('bg:ping')).toBe(false);
  });
});
