import { useEffect, useState } from 'react';
import { openStream } from '@/lib/ports';

/**
 * Streams a short echo through the background worker once: proves the port
 * transport every model reply depends on is healthy.
 */
export function useTransportCheck(): 'checking' | 'ok' | 'failed' {
  const [state, setState] = useState<'checking' | 'ok' | 'failed'>('checking');
  useEffect(() => {
    const stream = openStream('echo', { text: 'tether transport check', delayMs: 0 });
    let alive = true;
    stream.done.then(
      (d) => {
        if (alive) setState(d.count === 3 ? 'ok' : 'failed');
      },
      () => {
        if (alive) setState('failed');
      },
    );
    return () => {
      alive = false;
      stream.abort();
    };
  }, []);
  return state;
}
