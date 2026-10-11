export function nextTimestamp(prev?: string, now: number = Date.now()): string {
  const floor = prev ? Date.parse(prev) + 1 : -Infinity;
  return new Date(Math.max(now, floor)).toISOString();
}
