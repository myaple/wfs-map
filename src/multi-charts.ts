import type { ChartDomain, ChartResult, ChartSpec } from './analysis.ts';
export const seriesColors = ['#2463d4', '#d45b24', '#8b49ba', '#17836f', '#b34378', '#957119', '#466673', '#657c25'];
export function sharedDomain(domains: ChartDomain[]): ChartDomain {
    if (!domains.length || domains.some(d => d.kind !== domains[0].kind)) throw Error('Each shared axis must use the same attribute type across all sources. Numbers, text, dates and booleans cannot be mixed.');
    return { kind: domains[0].kind, min: Math.min(...domains.map(d => d.min)), max: Math.max(...domains.map(d => d.max)), minPositive: Math.min(...domains.map(d => d.minPositive ?? Infinity)), maxPositive: Math.max(...domains.map(d => d.maxPositive ?? -Infinity)), ...(domains[0].kind === 'string' ? { labels: [...new Set(domains.flatMap(d => d.labels ?? []))].sort().slice(0, 63) } : {}) };
}
export function combineSeries(spec: ChartSpec, series: NonNullable<ChartResult['series']>): ChartResult {
    const first = series[0].result, counts = new Uint32Array(first.counts.length);
    for (const s of series) for (let i = 0; i < counts.length; i++) counts[i] += s.result.counts[i];
    const result: ChartResult = { ...first, id: spec.id, counts, series, missing: series.reduce((n, s) => n + s.result.missing, 0) };
    if (first.raw) {
        const length = series.reduce((n, s) => n + s.result.raw!.rows.length, 0), stride = first.raw.precise ? 4 : 2;
        const positions = new Float32Array(length * stride), rows = new Uint32Array(length);
        let offset = 0;
        const ranges = series.map(s => {
            const raw = s.result.raw!, start = offset; positions.set(raw.positions, offset * stride); rows.set(raw.rows, offset); offset += raw.rows.length;
            return { start, end: offset, sourceId: s.sourceId, color: s.color, x: s.result.x.field, y: s.result.y!.field };
        });
        const extent = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
        for (const s of series) if (s.result.raw?.extent) { const e = s.result.raw.extent; extent[0] = Math.min(extent[0], e[0]); extent[1] = Math.min(extent[1], e[1]); extent[2] = Math.max(extent[2], e[2]); extent[3] = Math.max(extent[3], e[3]); }
        result.raw = { ...first.raw, positions, rows, series: ranges, extent };
    }
    return result;
}

/** Hide series from counts, percentages and selection without changing dataset filters. */
export function visibleSeries(spec: ChartSpec, result: ChartResult): ChartResult {
    if (!result.series || !spec.hiddenSources?.length) return result;
    const series = result.series.filter(s => !spec.hiddenSources!.includes(s.sourceId));
    if (result.raw) {
        // Keep the existing contiguous buffer; hide GPU draw ranges rather than
        // copying millions of positions when a legend entry is toggled.
        const extent = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
        for (const s of series) if (s.result.raw?.extent) {
            const e = s.result.raw.extent;
            extent[0] = Math.min(extent[0], e[0]); extent[1] = Math.min(extent[1], e[1]);
            extent[2] = Math.max(extent[2], e[2]); extent[3] = Math.max(extent[3], e[3]);
        }
        return { ...result, series, missing: series.reduce((n, s) => n + s.result.missing, 0),
            raw: { ...result.raw, series: result.raw.series?.filter(s => !spec.hiddenSources!.includes(s.sourceId)), extent } };
    }
    if (series.length) return combineSeries(spec, series);
    return { ...result, series: [], counts: new Uint32Array(result.counts.length), missing: 0 };
}
