import { useEffect, useState } from 'react';
import { sendMessage } from '@/lib/messaging';
import type { PingResponse } from '@/lib/protocol';

export type BackgroundStatus =
  | { state: 'pending' }
  | { state: 'connected'; info: PingResponse; latencyMs: number }
  | { state: 'error'; message: string };

/** Ping the service worker on mount and every `intervalMs`. */
export function useBackgroundStatus(intervalMs = 10_000): BackgroundStatus {
  const [status, setStatus] = useState<BackgroundStatus>({ state: 'pending' });

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const started = performance.now();
      try {
        const info = await sendMessage('bg:ping');
        if (alive) {
          setStatus({ state: 'connected', info, latencyMs: performance.now() - started });
        }
      } catch (err) {
        if (alive) setStatus({ state: 'error', message: (err as Error).message });
      }
    };
    void ping();
    const timer = setInterval(() => void ping(), intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return status;
}
