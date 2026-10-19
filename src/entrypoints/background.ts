import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { echoStream } from '@/background/echo';
import { KEEPALIVE_ALARM, onKeepaliveAlarm, setKeepalive } from '@/lib/keepalive';
import { createLogger } from '@/lib/logger';
import { registerHandlers, sendToTab } from '@/lib/messaging';
import { registerStreamHandlers } from '@/lib/ports';
import { configurePanelBehavior } from '@/platform/sidePanel';

const log = createLogger('bg');

async function contentScriptAlive(tabId: number): Promise<boolean> {
  try {
    await sendToTab(tabId, 'content:ping', undefined, 0);
    return true;
  } catch {
    return false;
  }
}

export default defineBackground({
  type: 'module',
  main() {
    // Listeners must be registered synchronously on every worker start, or
    // events that woke the worker are dropped.
    registerHandlers({
      'bg:ping': () => ({
        pong: true,
        version: browser.runtime.getManifest().version,
        at: Date.now(),
      }),
      'bg:open-options': async () => {
        await browser.runtime.openOptionsPage();
        return undefined;
      },
      'bg:ensure-content-script': async ({ tabId }) => {
        if (await contentScriptAlive(tabId)) return { injected: false };
        await browser.scripting.executeScript({
          target: { tabId },
          files: ['/content-scripts/content.js'],
        });
        return { injected: true };
      },
    });

    registerStreamHandlers(
      { echo: echoStream },
      {
        onActiveChange: (active) => {
          setKeepalive(active > 0).catch((err: unknown) => {
            log.warn('keepalive toggle failed', err);
          });
        },
      },
    );

    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === KEEPALIVE_ALARM) void onKeepaliveAlarm();
    });

    browser.runtime.onInstalled.addListener(({ reason }) => {
      log.info('installed', reason);
      // A worker restarted mid-stream may have left the alarm running.
      void setKeepalive(false);
    });

    configurePanelBehavior().catch((err: unknown) => {
      log.warn('could not configure side panel behaviour', err);
    });
  },
});
