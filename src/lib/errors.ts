/**
 * Errors crossing a message boundary are structured-cloned, which drops the
 * prototype and usually the message. Everything that leaves a context is
 * converted to this plain shape first.
 */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export class TetherError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TetherError';
    this.code = code;
  }
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof TetherError) {
    return { name: err.name, message: err.message, code: err.code, stack: err.stack };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (typeof err === 'string') return { name: 'Error', message: err };
  try {
    return { name: 'Error', message: JSON.stringify(err) };
  } catch {
    return { name: 'Error', message: String(err) };
  }
}

export function deserializeError(err: SerializedError): Error {
  const out = err.code ? new TetherError(err.code, err.message) : new Error(err.message);
  out.name = err.name;
  if (err.stack) out.stack = err.stack;
  return out;
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}
