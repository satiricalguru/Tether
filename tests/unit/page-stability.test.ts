import { describe, expect, it } from 'vitest';
import { waitForStable } from '@/agent/page/stability';

describe('waitForStable', () => {
  it('resolves once the DOM has been quiet', async () => {
    document.body.innerHTML = '<p>x</p>';
    let n = 0;
    const timer = setInterval(() => {
      if (n++ < 3) document.body.append(document.createElement('span'));
    }, 50);
    const r = await waitForStable(document, { quietMs: 120, capMs: 3000 });
    clearInterval(timer);
    expect(r.reason).toBe('quiet');
    expect(r.settledMs).toBeGreaterThanOrEqual(120);
    expect(r.settledMs).toBeLessThan(1000);
  });

  it('gives up at the cap on a page that never stops changing', async () => {
    const timer = setInterval(() => {
      document.body.append(document.createElement('i'));
    }, 20);
    const r = await waitForStable(document, { quietMs: 200, capMs: 400 });
    clearInterval(timer);
    expect(r.reason).toBe('cap');
  });
});
