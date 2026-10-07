import type { Feature } from './data.ts';
import { clampMapLatitude } from './data.ts';
export const EARTH_RADIUS = 6371008.8;
export const ellipseConfigKeys = ['ellipseMajorField', 'ellipseMinorField', 'ellipseOrientationField', 'ellipseMajorUnit', 'ellipseMinorUnit'] as const;
export type EllipseConfig = Record<typeof ellipseConfigKeys[number], string>;
export const ellipseDefaults: EllipseConfig = { ellipseMajorField: '', ellipseMinorField: '', ellipseOrientationField: '', ellipseMajorUnit: 'm', ellipseMinorUnit: 'm' };
export function validateEllipseConfig(c: EllipseConfig) {
    if (ellipseConfigKeys.some(k => typeof c[k] !== 'string')) throw Error('Invalid ellipse field mappings.');
    const fields = [c.ellipseMajorField, c.ellipseMinorField, c.ellipseOrientationField].filter(Boolean);
    if (fields.length && fields.length !== 3) throw Error('Choose all three ellipse fields, or clear them to disable ellipses.');
    if (![c.ellipseMajorUnit, c.ellipseMinorUnit].every(u => u === 'm' || u === 'nm')) throw Error('Ellipse axis units must be metres or nautical miles.');
}
// One compact record per point. A zero major axis means no ellipse; the point is retained.
export function packEllipses(features: Feature[], c: EllipseConfig): { data?: Float32Array; invalid: number; radius: number } {
    if (!c.ellipseMajorField) return { invalid: 0, radius: 0 };
    const data = new Float32Array(features.length * 4);
    let invalid = 0, radius = 0;
    const number = (v: unknown) => typeof v === 'number' || typeof v === 'string' && v.trim() ? Number(v) : NaN;
    for (let i = 0; i < features.length; i++) {
        const f = features[i], p = f.properties ?? {};
        let a = number(p[c.ellipseMajorField]) * (c.ellipseMajorUnit === 'nm' ? 1852 : 1);
        let b = number(p[c.ellipseMinorField]) * (c.ellipseMinorUnit === 'nm' ? 1852 : 1);
        let angle = number(p[c.ellipseOrientationField]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(angle) || a <= 0 || b <= 0 || a > Math.PI * EARTH_RADIUS || b > Math.PI * EARTH_RADIUS) { invalid++; continue; }
        // Preserve the supplied axis directions even if the columns are reversed.
        if (b > a) { [a, b] = [b, a]; angle += 90; }
        const lat = clampMapLatitude(f.geometry.coordinates[1]) * Math.PI / 180;
        data.set([a / EARTH_RADIUS, b / EARTH_RADIUS, ((angle % 360 + 360) % 360) * Math.PI / 180, lat], i * 4);
        radius = Math.max(radius, a / EARTH_RADIUS / (2 * Math.PI * Math.cos(Math.min(85.05112878 * Math.PI / 180, Math.abs(lat) + a / EARTH_RADIUS))));
    }
    return { data, invalid, radius };
}
export function ellipseWarning(invalid: number) { return invalid ? `${invalid.toLocaleString()} ${invalid === 1 ? 'point has' : 'points have'} missing or invalid ellipse values; their points are retained and their ellipses skipped.` : ''; }
export const ELLIPSE_ASPECT_BUCKETS = 64;
export const ELLIPSE_MAX_VERTICES = 128;
export function validateEllipseVertices(n: number) { if (!Number.isInteger(n) || n < 4 || n > ELLIPSE_MAX_VERTICES) throw Error('Ellipse vertices must be a whole number from 4 to 128.'); }
// Chord error is proportional to curvature × arc length². Sampling density in
// parameter space is therefore sqrt(curvature) × speed = 1/sqrt(speed), up to
// a constant. Invert its CDF so tips get more vertices than the flatter sides.
export function ellipseSamples(count: number, aspect: number): Float32Array {
    validateEllipseVertices(count);
    const steps = 4096, cdf = new Float64Array(steps + 1), ratio = Math.max(1, Math.min(1024, aspect));
    for (let i = 1; i <= steps; i++) {
        const t = (i - .5) * Math.PI * 2 / steps;
        cdf[i] = cdf[i - 1] + 1 / Math.sqrt(Math.hypot(ratio * Math.sin(t), Math.cos(t)));
    }
    const out = new Float32Array(count * 2);
    let k = 1;
    for (let i = 0; i < count; i++) {
        const target = cdf[steps] * i / count;
        while (cdf[k] < target) k++;
        const t = (k - 1 + (target - cdf[k - 1]) / (cdf[k] - cdf[k - 1])) * Math.PI * 2 / steps;
        out[i * 2] = Math.cos(t); out[i * 2 + 1] = Math.sin(t);
    }
    return out;
}
export function ellipseTemplates(count: number) {
    const data = new Float32Array(count * ELLIPSE_ASPECT_BUCKETS * 2);
    for (let bucket = 0; bucket < ELLIPSE_ASPECT_BUCKETS; bucket++) data.set(ellipseSamples(count, 2 ** (bucket * 10 / (ELLIPSE_ASPECT_BUCKETS - 1))), bucket * count * 2);
    return data;
}
