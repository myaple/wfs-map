export type Scale = 'linear' | 'log10';
export const transform = (value: number, scale: Scale = 'linear') => scale === 'log10' ? value > 0 ? Math.log10(value) : NaN : value;
export const untransform = (value: number, scale: Scale = 'linear') => scale === 'log10' ? Math.max(Number.MIN_VALUE, Math.min(Number.MAX_VALUE, 10 ** value)) : value;
export function axisBounds(min: number, max: number, scale: Scale = 'linear', date = false): [number, number] {
    if (!Number.isFinite(transform(min, scale)) || !Number.isFinite(transform(max, scale))) return scale === 'log10' ? [1, 10] : [0, 1];
    if (min !== max) return [min, max];
    if (scale === 'log10') return [Math.max(Number.MIN_VALUE, min / Math.sqrt(10)), Math.min(Number.MAX_VALUE, max * Math.sqrt(10))];
    const pad = date ? 1000 : Math.max(1, Math.abs(min) * .05);
    return [Math.max(-Number.MAX_VALUE, min - pad), Math.min(Number.MAX_VALUE, max + pad)];
}
