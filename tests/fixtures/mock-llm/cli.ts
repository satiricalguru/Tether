import { startMockLlm, type MockFlavor, type MockOptions } from './server.ts';

/**
 * Run a mock backend for manual development, e.g.
 *   pnpm mock-llm --flavor ollama --port 11434
 *   pnpm mock-llm --flavor ollama --reject-origins --allowed-origins chrome-extension://abc
 *   pnpm mock-llm --flavor openai --port 8000 --api-key secret
 */

const FLAVORS: MockFlavor[] = ['ollama', 'lmstudio', 'llamacpp', 'openai'];
const DEFAULT_PORTS: Record<MockFlavor, number> = {
  ollama: 11434,
  lmstudio: 1234,
  llamacpp: 8080,
  openai: 8000,
};

function parseArgs(argv: string[]): MockOptions {
  const opts: MockOptions = { flavor: 'ollama' };
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${String(arg)} needs a value`);
      return value;
    };
    switch (arg) {
      case '--flavor': {
        const f = next() as MockFlavor;
        if (!FLAVORS.includes(f)) throw new Error(`--flavor must be one of ${FLAVORS.join(', ')}`);
        opts.flavor = f;
        break;
      }
      case '--port':
        port = Number(next());
        break;
      case '--reject-origins':
        opts.rejectOrigins = true;
        break;
      case '--allowed-origins':
        opts.allowedOrigins = next().split(',');
        break;
      case '--api-key':
        opts.apiKey = next();
        break;
      case '--reply':
        opts.reply = next();
        break;
      case '--token-delay':
        opts.tokenDelayMs = Number(next());
        break;
      case '--help':
      case '-h':
        console.log(
          'pnpm mock-llm [--flavor ollama|lmstudio|llamacpp|openai] [--port N] [--reject-origins]\n' +
            '              [--allowed-origins a,b] [--api-key KEY] [--reply TEXT] [--token-delay MS]',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  opts.port = port ?? DEFAULT_PORTS[opts.flavor];
  return opts;
}

const options = parseArgs(process.argv.slice(2));
const server = await startMockLlm(options);
console.log(`mock ${options.flavor} listening on ${server.url}`);
console.log('model-name triggers: slow cold disconnect notools toolcall think error nousage');

const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
