import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Serve a directory on 127.0.0.1 (inside Tether's host permissions). */
export async function startStaticServer(
  root: string,
  port = 0,
): Promise<{ url: string; close: () => Promise<void> }> {
  const base = resolve(root);
  const server: Server = createServer((req, res) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      const file = normalize(
        join(base, pathname.endsWith('/') ? `${pathname}index.html` : pathname),
      );
      if (!file.startsWith(base)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      }),
  };
}
