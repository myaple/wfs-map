// Deterministic random access: no database, allocation, or scan of earlier rows.
export function hash(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
export function feature(i: number, distribution = 'uk') {
  const a = hash(i + 1), b = hash(i + 123456789);
  const coordinates = distribution === 'world' ? [-179 + a * 358, -70 + b * 140]
    : distribution === 'dense' ? [-1.55 + a * .02, 53.99 + b * .02]
    : [-8 + a * 10, 50 + b * 9];
  return { type: 'Feature', id: `points.${i}`, geometry: { type: 'Point', coordinates }, properties: {
    id: i, category: ['sensor', 'vehicle', 'station', 'event'][i % 4],
    status: ['active', 'inactive', 'warning'][i % 3],
    value: Math.round(hash(i + 999) * 10000) / 100,
    timestamp: new Date(Date.UTC(2024, 0, 1) + Math.floor(hash(i + 424242) * 94694400000)).toISOString(),
    active: i % 3 !== 1, source: `source-${i % 16}`, quality: Math.round(hash(i + 88) * 100)
  }};
}
export const fields = { id: 'int', category: 'string', status: 'string', value: 'double',
  timestamp: 'dateTime', active: 'boolean', source: 'string', quality: 'int' };
export function boundedInteger(raw: string | null | undefined, fallback: number, max: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`Expected integer from 0 to ${max}`);
  return n;
}
