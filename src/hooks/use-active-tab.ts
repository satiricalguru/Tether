import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

/** URL of the active tab in this window (for per-site model rules). */
export function useActiveTabUrl(): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const read = () => {
      void browser.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) => {
          setUrl(tab?.url);
        })
        .catch(() => undefined);
    };
    read();
    const onActivated = () => {
      read();
    };
    const onUpdated = (_id: number, info: { url?: string }) => {
      if (info.url) read();
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);
  return url;
}
