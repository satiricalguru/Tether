/** 131072 → "128K", 4096 → "4K", 1500 → "1.5K". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1024;
  if (Number.isInteger(n / 1024)) return `${k}K`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i] ?? 'TB'}`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export const selectionKey = (instanceId: string, model: string) => `${instanceId}::${model}`;

export function parseSelectionKey(key: string): { instanceId: string; model: string } | null {
  const i = key.indexOf('::');
  if (i <= 0) return null;
  return { instanceId: key.slice(0, i), model: key.slice(i + 2) };
}
