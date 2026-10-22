import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createAgentStream, stopRun, stopRunInTab } from '@/background/agent';
import { createChatStream } from '@/background/chat';
import {
  contextHandlers,
  createQuickStream,
  openPanelNow,
  pendingFromMenu,
  putPending,
  setupContextMenus,
  syncRegistration,
} from '@/background/context';
import { echoStream } from '@/background/echo';
import { createBackgroundRegistry, providerHandlers, runDiscovery } from '@/background/providers';
import { KEEPALIVE_ALARM, onKeepaliveAlarm, setKeepalive } from '@/lib/keepalive';
import { createLogger } from '@/lib/logger';
import { registerHandlers, sendToTab } from '@/lib/messaging';
import { registerStreamHandlers } from '@/lib/ports';
import { watchSettings } from '@/lib/settings';
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
    const registry = createBackgroundRegistry();

    registerHandlers({
      ...providerHandlers(registry),
      ...contextHandlers(),
      // Stop from the page banner / Esc: by run id, else whatever run controls that tab.
      'bg:agent:stop': ({ runId }, sender) => ({
        stopped:
          (runId ? stopRun(runId) : false) ||
          (sender.tab?.id !== undefined && stopRunInTab(sender.tab.id)),
      }),
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

    const chat = createChatStream({
      getProvider: (id) => registry.provider(id),
      contextLength: async (id, model) => (await registry.capabilities(id, model)).contextLength,
    });
    registerStreamHandlers(
      {
        echo: echoStream,
        chat,
        agent: createAgentStream({
          chat,
          capabilities: (id, model) => registry.capabilities(id, model),
          runtimeContext: async (id, model) =>
            (await registry.provider(id)).runtimeContext?.(model),
        }),
        quick: createQuickStream({
          chat,
          capabilities: (id, model) => registry.capabilities(id, model),
        }),
      },
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

    browser.contextMenus.onClicked.addListener((info, tab) => {
      // Open first: the user gesture doesn't survive an await.
      void openPanelNow(tab?.windowId);
      void pendingFromMenu(info, tab).then((p) => (p ? putPending(p) : undefined));
    });

    // Keep the bubble's registration in step with grants and the setting.
    const resync = () => {
      syncRegistration().catch((err: unknown) => {
        log.warn('content script registration failed', err);
      });
    };
    browser.permissions.onAdded.addListener(resync);
    browser.permissions.onRemoved.addListener(resync);
    let bubbleSetting: boolean | undefined;
    watchSettings((s) => {
      if (s.page.bubble !== bubbleSetting) {
        bubbleSetting = s.page.bubble;
        resync();
      }
    });
    browser.runtime.onStartup.addListener(resync);

    browser.runtime.onInstalled.addListener(({ reason }) => {
      void setupContextMenus().catch((err: unknown) => {
        log.warn('context menu setup failed', err);
      });
      resync();
      log.info('installed', reason);
      // A worker restarted mid-stream may have left the alarm running.
      void setKeepalive(false);
      // First run: find whatever local servers are already running.
      if (reason === 'install') {
        runDiscovery(registry).catch((err: unknown) => {
          log.warn('first-run discovery failed', err);
        });
      }
    });

    configurePanelBehavior().catch((err: unknown) => {
      log.warn('could not configure side panel behaviour', err);
    });
  },
});
