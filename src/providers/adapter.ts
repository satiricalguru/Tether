import { ProviderError, diagnoseError, type HttpClient } from './http';
import type { CapabilityOverrides } from './overrides';
import type { HealthResult } from './types';

export interface AdapterDeps {
  http: HttpClient;
  overrides: CapabilityOverrides;
}

/** Discovery and health checks give up after this long (spec §4.3). */
export const HEALTH_TIMEOUT_MS = 1200;

/**
 * Run a health probe and turn its outcome into a HealthResult. `check`
 * returns the server version (or undefined), or throws; a thrown
 * `{ notThisServer }` marks a reachable server that isn't the expected kind.
 */
export async function probeHealth(check: () => Promise<string | undefined>): Promise<HealthResult> {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  try {
    const version = await check();
    return { ok: true, latencyMs: latency(), diagnosis: 'ok', ...(version ? { version } : {}) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: latency(),
      diagnosis: err instanceof WrongServerError ? 'bad-response' : diagnoseError(err),
      detail: (err as Error).message,
      ...(err instanceof ProviderError && err.status ? { status: err.status } : {}),
    };
  }
}

/** The port answered, but not with the API we expected. */
export class WrongServerError extends Error {
  constructor(expected: string) {
    super(`Something is listening here, but it isn't ${expected}`);
    this.name = 'WrongServerError';
  }
}

/** `${baseUrl}/v1` unless the user already included the version segment. */
export function openAIApiBase(baseUrl: string): string {
  return /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}
