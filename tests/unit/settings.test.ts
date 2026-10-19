import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  getSettings,
  mergeDeep,
  migrate,
  resetSettings,
  updateSettings,
  watchSettings,
  type Settings,
} from '@/lib/settings';

describe('settings', () => {
  it('returns defaults when nothing is stored', async () => {
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('persists updates', async () => {
    await updateSettings({ theme: 'dark' });
    await expect(getSettings()).resolves.toMatchObject({ theme: 'dark' });
    const raw = await fakeBrowser.storage.local.get(SETTINGS_KEY);
    expect((raw[SETTINGS_KEY] as Settings).theme).toBe('dark');
  });

  it('fills in fields added after the data was stored', async () => {
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { schemaVersion: 1 } });
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('drops unknown keys and wrongly typed values from corrupted storage', async () => {
    await fakeBrowser.storage.local.set({
      [SETTINGS_KEY]: { theme: 42, bogus: true, schemaVersion: 1 },
    });
    const s = await getSettings();
    expect(s.theme).toBe('system');
    expect(s).not.toHaveProperty('bogus');
  });

  it('migrates non-object storage to defaults', () => {
    expect(migrate('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(migrate(null)).toEqual(DEFAULT_SETTINGS);
    expect(migrate([1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it('notifies watchers on change and stops after unsubscribe', async () => {
    const seen: string[] = [];
    const off = watchSettings((s) => seen.push(s.theme));
    await updateSettings({ theme: 'light' });
    off();
    await updateSettings({ theme: 'dark' });
    expect(seen).toEqual(['light']);
  });

  it('resets to defaults', async () => {
    await updateSettings({ theme: 'dark' });
    await resetSettings();
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });
});

describe('mergeDeep', () => {
  const base = { a: 1, nested: { b: 'x', c: true }, list: [1, 2] };

  it('merges nested objects and replaces arrays', () => {
    expect(mergeDeep(base, { nested: { b: 'y' }, list: [9] })).toEqual({
      a: 1,
      nested: { b: 'y', c: true },
      list: [9],
    });
  });

  it('rejects type mismatches', () => {
    expect(mergeDeep(base, { a: 'one', nested: 'flat', list: 'nope' })).toEqual(base);
  });

  it('does not mutate the base', () => {
    const copy = structuredClone(base);
    mergeDeep(base, { nested: { b: 'z' } });
    expect(base).toEqual(copy);
  });
});
