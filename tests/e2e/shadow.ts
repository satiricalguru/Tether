import type { Page } from '@playwright/test';

/**
 * The highlight bubble and inline compose live in *closed* shadow roots so
 * pages can't read or script them. Playwright locators can't see inside either, but the
 * DevTools protocol can (DOM.getDocument with pierce).
 */

interface CdpNode {
  nodeId: number;
  nodeName: string;
  nodeValue?: string;
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

function* walk(n: CdpNode): Generator<CdpNode> {
  yield n;
  // The bubble's stylesheet is not content.
  if (n.nodeName === 'STYLE') return;
  for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) yield* walk(c);
}

function text(n: CdpNode): string {
  return [...walk(n)]
    .filter((x) => x.nodeName === '#text')
    .map((x) => x.nodeValue ?? '')
    .join('');
}

export function bubbleRoot(page: Page) {
  return tetherUi(page, 'TETHER-BUBBLE');
}

/** Read and click inside one of Tether's closed-shadow UIs (host tag in upper case). */
export async function tetherUi(page: Page, hostTag: string) {
  const cdp = await page.context().newCDPSession(page);
  const snapshot = async () => {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: CdpNode;
    };
    const host = [...walk(root)].find((n) => n.nodeName === hostTag);
    return host?.shadowRoots?.[0];
  };
  return {
    /** Visible text inside the UI (empty if hidden or absent). */
    async text(): Promise<string> {
      const r = await snapshot();
      return r ? text(r) : '';
    },
    async buttons(): Promise<string[]> {
      const r = await snapshot();
      return r ? [...walk(r)].filter((n) => n.nodeName === 'BUTTON').map(text) : [];
    },
    /** Click the bubble button whose label is exactly `label`. */
    async click(label: string): Promise<void> {
      const r = await snapshot();
      const btn = r && [...walk(r)].find((n) => n.nodeName === 'BUTTON' && text(n) === label);
      if (!btn) throw new Error(`button "${label}" not found in ${hostTag}`);
      const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: btn.nodeId })) as {
        model: { content: number[] };
      };
      const [x1 = 0, y1 = 0, x2 = 0, , , y3 = 0] = model.content;
      await page.mouse.click((x1 + x2) / 2, (y1 + y3) / 2);
    },
    /** Text of every element with this tag name (e.g. INS / DEL in the compose preview). */
    async texts(tag: string): Promise<string[]> {
      const r = await snapshot();
      return r ? [...walk(r)].filter((n) => n.nodeName === tag).map(text) : [];
    },
  };
}
