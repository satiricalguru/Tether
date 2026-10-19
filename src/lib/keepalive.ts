import { browser } from 'wxt/browser';

/**
 * MV3 workers are killed after ~30s without events. While a generation is in
 * flight the open port keeps the worker alive as long as messages flow, but a
 * cold model load can be silent for a minute. A periodic alarm guarantees an
 * event at least every 30s (Chrome's minimum alarm period) until the last
 * stream finishes.
 */

export const KEEPALIVE_ALARM = 'tether:keepalive';
const PERIOD_MINUTES = 0.5;

export async function setKeepalive(active: boolean): Promise<void> {
  if (active) {
    const existing = await browser.alarms.get(KEEPALIVE_ALARM);
    if (!existing)
      await browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: PERIOD_MINUTES });
  } else {
    await browser.alarms.clear(KEEPALIVE_ALARM);
  }
}

/** Alarm handler body: touching any extension API resets the idle timer. */
export async function onKeepaliveAlarm(): Promise<void> {
  await browser.runtime.getPlatformInfo();
}
