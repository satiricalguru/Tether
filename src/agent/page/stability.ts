/**
 * Wait for the page to settle after an action: the document has loaded and
 * the DOM has been quiet for `quietMs`, or `capMs` has passed. Pages that
 * animate forever (tickers, carousels) hit the cap; that's fine.
 */
export function waitForStable(
  doc: Document,
  opts: { quietMs?: number; capMs?: number } = {},
): Promise<{ settledMs: number; reason: 'quiet' | 'cap' }> {
  const quietMs = opts.quietMs ?? 350;
  const capMs = opts.capMs ?? 8000;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    let done = false;
    const finish = (reason: 'quiet' | 'cap') => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      observer?.disconnect();
      doc.defaultView?.removeEventListener('load', onLoad);
      resolve({ settledMs: elapsed(), reason });
    };
    const capTimer = setTimeout(() => {
      finish('cap');
    }, capMs);
    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        finish('quiet');
      }, quietMs);
    };
    const watch = () => {
      observer = new MutationObserver(armQuiet);
      observer.observe(doc.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      armQuiet();
    };
    const onLoad = () => {
      watch();
    };
    if (doc.readyState === 'complete') watch();
    else doc.defaultView?.addEventListener('load', onLoad, { once: true });
  });
}
