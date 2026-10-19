/**
 * Leveled, scoped logger. Everything passes through `redact` first: API keys
 * for OpenAI-compatible servers live in settings and must never reach the
 * console, traces or exported logs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = import.meta.env.DEV ? 'debug' : 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

const SECRET_KEY = /^(api[-_]?key|authorization|token|secret|password|bearer)$/i;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]'],
  [/([?&](?:api[-_]?key|key|token)=)[^&\s]+/gi, '$1[redacted]'],
];

export function redactString(input: string): string {
  let out = input;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) {
    const err = new Error(redactString(value.message));
    err.name = value.name;
    if (value.stack) err.stack = redactString(value.stack);
    return err;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && v ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, args: unknown[]) => {
    if (ORDER[level] < ORDER[threshold]) return;
    // eslint-disable-next-line no-console -- this module is the console sink
    console[level](`[tether:${scope}]`, ...args.map((a) => redact(a)));
  };
  return {
    debug: (...a) => {
      emit('debug', a);
    },
    info: (...a) => {
      emit('info', a);
    },
    warn: (...a) => {
      emit('warn', a);
    },
    error: (...a) => {
      emit('error', a);
    },
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
