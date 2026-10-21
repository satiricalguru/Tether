import { spawn, type ChildProcess } from 'node:child_process';

/**
 * A temporary `ollama serve` that allows extension origins, for tests that
 * need a real model. It never touches the user's own Ollama or its
 * configuration: OLLAMA_ORIGINS is set for this process only, on its own
 * port. The model resident in the main instance (if any) is unloaded first
 * so two copies don't compete for memory.
 */

export const MAIN_OLLAMA = 'http://127.0.0.1:11434';

export interface TempOllama {
  url: string;
  stop: () => Promise<void>;
}

export async function startTempOllama(model: string, port = 11435): Promise<TempOllama> {
  const url = `http://127.0.0.1:${port}`;
  const unload = (base: string) =>
    fetch(`${base}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model, keep_alive: 0 }),
    }).catch(() => undefined);
  await unload(MAIN_OLLAMA);
  const proc: ChildProcess = spawn('ollama', ['serve'], {
    env: {
      ...process.env,
      OLLAMA_HOST: `127.0.0.1:${port}`,
      OLLAMA_ORIGINS: 'chrome-extension://*',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${url}/api/version`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) {
      return {
        url,
        stop: async () => {
          await unload(url);
          proc.kill('SIGTERM');
        },
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill('SIGTERM');
  throw new Error('temporary ollama serve did not start');
}
