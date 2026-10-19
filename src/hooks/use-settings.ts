import { useCallback, useEffect, useState } from 'react';
import {
  getSettings,
  updateSettings,
  watchSettings,
  type DeepPartial,
  type Settings,
} from '@/lib/settings';

/** Live settings in React: loads once, then follows changes from any context. */
export function useSettings(): {
  settings: Settings | undefined;
  update: (patch: DeepPartial<Settings>) => Promise<Settings>;
} {
  const [settings, setSettings] = useState<Settings>();

  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => {
      if (alive) setSettings(s);
    });
    const unwatch = watchSettings(setSettings);
    return () => {
      alive = false;
      unwatch();
    };
  }, []);

  const update = useCallback((patch: DeepPartial<Settings>) => updateSettings(patch), []);
  return { settings, update };
}
