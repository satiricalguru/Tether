import { getDb, newId, type TraceRecord } from '@/lib/db';

/** Every step goes to IndexedDB; it's the debugging surface for agent runs. */
export interface TraceSink {
  write(rec: Omit<TraceRecord, 'id' | 'createdAt'>): Promise<void>;
}

export function dbTraceSink(): TraceSink {
  return {
    write: async (rec) => {
      await getDb().traces.add({ ...rec, id: newId(), createdAt: Date.now() });
    },
  };
}

export function memoryTraceSink(): TraceSink & {
  records: Omit<TraceRecord, 'id' | 'createdAt'>[];
} {
  const records: Omit<TraceRecord, 'id' | 'createdAt'>[] = [];
  return {
    records,
    write: (rec) => {
      records.push(rec);
      return Promise.resolve();
    },
  };
}

/** Patterns that look like secrets are masked before anything is stored. */
export function redactForTrace(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card]')
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]')
      .replace(/\b(sk|pk|rk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{8,}\b/g, '[token]');
  }
  if (Array.isArray(value)) return value.map(redactForTrace);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactForTrace(v)]));
  }
  return value;
}
