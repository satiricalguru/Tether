import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown, safeHref } from '@/components/markdown/markdown';

afterEach(cleanup);

function md(text: string, streaming = false) {
  return render(<Markdown text={text} streaming={streaming} />).container;
}

describe('Markdown constructs', () => {
  it('renders headings, emphasis, strikethrough, inline code and breaks', () => {
    const c = md('# Title\n\n## Sub\n\nSome **bold**, *em*, ~~gone~~ and `a<b && c`.  \nnext line');
    expect(c.querySelector('h1')?.textContent).toBe('Title');
    expect(c.querySelector('h2')?.textContent).toBe('Sub');
    expect(c.querySelector('strong')?.textContent).toBe('bold');
    expect(c.querySelector('em')?.textContent).toBe('em');
    expect(c.querySelector('del')?.textContent).toBe('gone');
    expect(c.querySelector('code')?.textContent).toBe('a<b && c');
    expect(c.querySelector('br')).not.toBeNull();
  });

  it('shows entities and escapes as the characters, never as &amp; text', () => {
    const c = md('Tom & Jerry say "hi" <3 \\*not em\\* and \'quoted\'');
    expect(c.textContent).toContain('Tom & Jerry say "hi"');
    expect(c.textContent).toContain('*not em*');
    expect(c.textContent).toContain("'quoted'");
    expect(c.textContent).not.toMatch(/&amp;|&quot;|&#39;|&lt;/);
  });

  it('renders ordered lists with start, nested lists and task lists', () => {
    const c = md('3. three\n4. four\n   - nested\n\n- [x] done\n- [ ] todo');
    const ol = c.querySelector('ol');
    expect(ol?.getAttribute('start')).toBe('3');
    expect(ol?.querySelector('ul li')?.textContent).toBe('nested');
    const boxes = c.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.checked).toBe(true);
    expect(boxes[1]?.checked).toBe(false);
    for (const b of boxes) expect(b.disabled).toBe(true);
    expect(c.textContent).toContain('done');
    expect(c.textContent).toContain('todo');
  });

  it('renders blockquotes and horizontal rules', () => {
    const c = md('> quoted **text**\n\n---\n\nafter');
    expect(c.querySelector('blockquote strong')?.textContent).toBe('text');
    expect(c.querySelector('hr')).not.toBeNull();
  });

  it('renders GFM tables with alignment', () => {
    const c = md('| L | C | R |\n|:--|:-:|--:|\n| a | **b** | c |');
    const th = c.querySelectorAll('th');
    expect([...th].map((x) => x.textContent)).toEqual(['L', 'C', 'R']);
    expect(th[0]?.className).toContain('text-left');
    expect(th[1]?.className).toContain('text-center');
    expect(th[2]?.className).toContain('text-right');
    expect(c.querySelector('td strong')?.textContent).toBe('b');
  });

  it('renders fenced and indented code blocks with a language label', () => {
    const c = md('```python\nprint("hi")\n```\n\n    indented()\n');
    const blocks = c.querySelectorAll('[data-testid=code-block]');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.getAttribute('data-lang')).toBe('python');
    expect(blocks[0]?.querySelector('pre')?.textContent).toBe('print("hi")');
    expect(blocks[1]?.querySelector('pre')?.textContent).toBe('indented()');
  });

  it('renders an unterminated fence while streaming as a code block', () => {
    const c = md('Here:\n\n```ts\nconst a = 1;\nconst b', true);
    const block = c.querySelector('[data-testid=code-block]');
    expect(block?.getAttribute('data-lang')).toBe('ts');
    expect(block?.querySelector('pre')?.textContent).toBe('const a = 1;\nconst b');
  });

  it('highlights code once the grammar loads', async () => {
    const c = md('```ts\nconst x: number = 1;\n```');
    await waitFor(
      () => {
        expect(c.querySelectorAll('.md-token').length).toBeGreaterThan(2);
      },
      { timeout: 5000 },
    );
    expect(c.querySelector('pre')?.textContent).toBe('const x: number = 1;');
    const tok = c.querySelector<HTMLElement>('.md-token');
    expect(tok?.style.getPropertyValue('--sl')).toMatch(/^#/);
    expect(tok?.style.getPropertyValue('--sd')).toMatch(/^#/);
  });

  it('copies code to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    md('```\nsecret sauce\n```');
    await act(async () => {
      fireEvent.click(screen.getByTestId('code-copy'));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('secret sauce');
    expect(screen.getByTestId('code-copy').textContent).toContain('Copied');
  });

  it('renders safe links in a new tab with noopener', () => {
    const c = md(
      '[docs](https://example.com/a?b=1 "Title") and <https://auto.example> and [m](mailto:a@b.c)',
    );
    const links = [...c.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/a?b=1',
      'https://auto.example/',
      'mailto:a@b.c',
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(links[0]?.getAttribute('title')).toBe('Title');
  });
});

describe('Markdown safety', () => {
  const CORPUS = [
    '<script>alert(1)</script>',
    'inline <script>alert(1)</script> in text',
    '<img src=x onerror=alert(1)>',
    'text <img src=x onerror="alert(1)"> text',
    '[x](javascript:alert(1))',
    '[x](JAVASCRIPT:alert(1))',
    '[x]( javascript:alert(1))',
    '[x](&#106;avascript:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox(1))',
    '[x](chrome-extension://abc/options.html)',
    '[x](/relative/path)',
    '![t](https://tracker.example/p.gif)',
    '![t](javascript:alert(1))',
    '<javascript:alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)" onclick="alert(1)">click</a>',
    '<svg onload=alert(1)><circle/></svg>',
    '<style>body{display:none}</style>',
    '<object data="x"></object><embed src="x">',
    '[ref][1]\n\n[1]: javascript:alert(1)',
  ];

  it.each(CORPUS)('neutralizes %s', (input) => {
    const c = md(input);
    expect(c.querySelectorAll('script, img, iframe, svg, style, object, embed')).toHaveLength(0);
    for (const el of c.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) expect(attr.startsWith('on')).toBe(false);
    }
    for (const a of c.querySelectorAll('[href]')) {
      expect(a.getAttribute('href')).toMatch(/^(https?:|mailto:)/);
    }
  });

  it('shows raw HTML as literal text', () => {
    const c = md('<b>not bold</b>');
    expect(c.querySelector('b')).toBeNull();
    expect(c.textContent).toContain('<b>not bold</b>');
  });

  it('renders a remote image as a chip, never an <img>', () => {
    const c = md('See ![a chart](https://tracker.example/pixel.gif)');
    expect(c.querySelector('img')).toBeNull();
    const chip = screen.getByTestId('image-chip');
    expect(chip.textContent).toContain('a chart');
    expect(chip.getAttribute('href')).toBe('https://tracker.example/pixel.gif');
    expect(chip.getAttribute('title')).toBe(
      'Image not loaded (Tether never fetches remote content)',
    );
  });

  it('safeHref allows only absolute http(s) and mailto', () => {
    expect(safeHref('https://a.b/c')).toBe('https://a.b/c');
    expect(safeHref('  http://a.b')).toBe('http://a.b/');
    expect(safeHref('mailto:x@y.z')).toBe('mailto:x@y.z');
    for (const bad of [
      'javascript:x',
      'JaVaScRiPt:x',
      '\u0001javascript:x',
      'data:x',
      'file:///etc/passwd',
      '/rel',
      'rel',
      '',
      null,
    ]) {
      expect(safeHref(bad)).toBeNull();
    }
  });
});
