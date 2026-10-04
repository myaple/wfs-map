import { Analyzer, yieldEvents, type Expression } from './analysis.ts';
import type { Store } from './store.ts';
export type SeriesSpec = { id: string; sourceId: string; label: string; x: string; y?: string; unit: string; scale: number; offset: number; converted: boolean; filter: Expression };
export type ComparisonSpec = { id: string; name: string; kind: 'histogram' | 'time'; unit: string; bins: number; bucketMs: number; aggregate: 'count' | 'mean' | 'sum' | 'min' | 'max'; series: SeriesSpec[] };
export type RelationshipSpec = { id: string; name: string; leftSource: string; rightSource: string; identifier?: { left: string; right: string }; time?: { left: string; right: string; toleranceMs: number }; spatial?: { radiusMetres: number }; match: 'all' | 'unique' | 'nearest' };
export type Projection = { sourceId: string; indices: Uint32Array; ids: (string | number | null)[]; longitude: Float64Array; latitude: Float64Array; columns: Record<string, (string | number | boolean | null)[]>; kinds: Record<string, string> };
export async function project(store: Store, sourceId: string, applied: Uint32Array | null, fields: string[], filter?: Expression, cancelled = () => false): Promise<Projection> {
    let indices = applied;
    if (filter) { const selected = (await new Analyzer(store).run(filter, [], cancelled)).indices; if (selected) { const allowed = applied ? new Set(applied) : undefined; indices = allowed ? selected.filter(i => allowed.has(i)) : selected; } }
    indices ??= Uint32Array.from({ length: store.length }, (_, i) => i);
    const columns: Projection['columns'] = Object.fromEntries(fields.map(f => [f, []])), kinds = Object.fromEntries(store.fields.map(f => [f.name, f.kind]));
    for (const field of fields) if (field !== '@id' && !store.fields.some(f => f.name === field)) throw Error(`Missing mapped field: ${field}`);
    const ids: Projection['ids'] = [], longitude = new Float64Array(indices.length), latitude = new Float64Array(indices.length);
    for (let k = 0; k < indices.length; k++) {
        const data = store.get(indices[k]); ids.push(data.id); longitude[k] = data.coordinates[0]; latitude[k] = data.coordinates[1];
        for (const field of fields) { const value = field === '@id' ? data.id : data.properties[field]; columns[field].push(value == null ? null : kinds[field] === 'date' ? Date.parse(String(value)) : value as string | number | boolean); }
        if (k % 32768 === 0) { await yieldEvents(); if (cancelled()) throw Error('Projection superseded'); }
    }
    return { sourceId, indices, ids, longitude, latitude, columns, kinds: { ...kinds, '@id': 'identifier' } };
}
export type ComparisonResult = { edges: number[]; series: { id: string; sourceId: string; label: string; counts: number[]; values: (number | null)[]; missing: number; members: number[][] }[] };
function numeric(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
export async function compare(spec: ComparisonSpec, data: Map<string, Projection>, cancelled = () => false): Promise<ComparisonResult> {
    if (spec.series.length < 2 || spec.series.length > 8 || !Number.isInteger(spec.bins) || spec.bins < 2 || spec.bins > 128) throw Error('Use 2–8 series and 2–128 bins.');
    if (spec.kind === 'time' && (!Number.isFinite(spec.bucketMs) || spec.bucketMs < 1)) throw Error('Time buckets must have a positive duration.');
    if (!spec.unit.trim() || spec.series.some(s => !s.unit.trim())) throw Error('Declare a unit for each measure, including dimensionless values.');
    let lo = Infinity, hi = -Infinity;
    const inputs: { spec: SeriesSpec; data: Projection; x: Float64Array; y: Float64Array }[] = [];
    for (const series of spec.series) {
        const d = data.get(series.id); if (!d) throw Error('Load every mapped source before comparing.');
        if (!Number.isFinite(series.scale) || series.scale === 0 || !Number.isFinite(series.offset)) throw Error('Conversion requires a finite, nonzero scale and finite offset.');
        if (series.unit !== spec.unit && !series.converted || !series.converted && (series.scale !== 1 || series.offset !== 0)) throw Error('Units differ: declare an explicit conversion before comparing.');
        if (spec.kind === 'time' ? d.kinds[series.x] !== 'date' : d.kinds[series.x] !== 'number') throw Error('Histogram X must be numeric; time X must be a date.');
        if (spec.kind === 'time' && spec.aggregate !== 'count' && (!series.y || d.kinds[series.y] !== 'number')) throw Error('Choose a numeric measure for each time series.');
        const x = new Float64Array(d.indices.length), y = new Float64Array(d.indices.length); x.fill(NaN); y.fill(NaN);
        for (let k = 0; k < d.indices.length; k++) {
            const rawX = numeric(d.columns[series.x][k]), rawY = spec.kind === 'time' && spec.aggregate !== 'count' ? numeric(d.columns[series.y!][k]) : 1;
            if (rawX !== undefined && rawY !== undefined) {
                x[k] = spec.kind === 'histogram' ? rawX * series.scale + series.offset : rawX; y[k] = spec.kind === 'time' && spec.aggregate !== 'count' ? rawY * series.scale + series.offset : 1;
                if (Number.isFinite(x[k]) && Number.isFinite(y[k])) { lo = Math.min(lo, x[k]); hi = Math.max(hi, x[k]); } else { x[k] = y[k] = NaN; }
            }
            if (k % 32768 === 0) { await yieldEvents(); if (cancelled()) throw Error('Comparison superseded'); }
        }
        inputs.push({ spec: series, data: d, x, y });
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    let bins = spec.bins;
    if (spec.kind === 'time') { lo = Math.floor(lo / spec.bucketMs) * spec.bucketMs; bins = Math.max(1, Math.floor((hi - lo) / spec.bucketMs) + 1); if (bins > 4096) throw Error('More than 4096 time buckets. Increase the bucket duration.'); hi = lo + bins * spec.bucketMs; }
    else if (lo === hi) { const pad = Math.max(1, Math.abs(lo) * .01); lo -= pad; hi += pad; }
    const edges = Array.from({ length: bins + 1 }, (_, i) => lo + (hi - lo) * i / bins);
    const output: ComparisonResult = { edges, series: [] };
    for (const input of inputs) {
        const counts = Array(bins).fill(0), sums = Array(bins).fill(0), min = Array(bins).fill(Infinity), max = Array(bins).fill(-Infinity), members: number[][] = Array.from({ length: bins }, () => []); let missing = 0;
        for (let k = 0; k < input.x.length; k++) {
            if (!Number.isFinite(input.x[k]) || !Number.isFinite(input.y[k])) { missing++; continue; }
            const bin = Math.max(0, Math.min(bins - 1, Math.floor((input.x[k] - lo) / (hi - lo) * bins)));
            counts[bin]++; sums[bin] += input.y[k]; min[bin] = Math.min(min[bin], input.y[k]); max[bin] = Math.max(max[bin], input.y[k]); members[bin].push(input.data.indices[k]);
            if (k % 32768 === 0) { await yieldEvents(); if (cancelled()) throw Error('Comparison superseded'); }
        }
        const aggregate = spec.kind === 'histogram' ? 'count' : spec.aggregate;
        const values = counts.map((n, i) => aggregate === 'count' ? n : !n ? null : aggregate === 'mean' ? sums[i] / n : aggregate === 'sum' ? sums[i] : aggregate === 'min' ? min[i] : max[i]);
        output.series.push({ id: input.spec.id, sourceId: input.spec.sourceId, label: input.spec.label, counts, values, missing, members });
    }
    return output;
}
export function distanceMetres(lon1: number, lat1: number, lon2: number, lat2: number) {
    const rad = Math.PI / 180, a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}
export type RelationshipResult = { leftTotal: number; rightTotal: number; matchedLeft: number; matchedRight: number; unmatchedLeft: number; unmatchedRight: number; multiplyLeft: number; multiplyRight: number; pairs: [number, number][]; preview: { left: number; id: string | number | null; candidates: number; matched: number[] }[] };
function lowerBound(values: { value: number; index: number }[], value: number, upper = false) { let lo = 0, hi = values.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid].value < value || upper && values[mid].value === value) lo = mid + 1; else hi = mid; } return lo; }
export async function relate(spec: RelationshipSpec, left: Projection, right: Projection, cancelled = () => false): Promise<RelationshipResult> {
    if (left.sourceId !== spec.leftSource || right.sourceId !== spec.rightSource || spec.leftSource === spec.rightSource) throw Error('Choose two different loaded sources.');
    if (!spec.identifier && !spec.time && !spec.spatial) throw Error('Choose at least one ID, time or spatial rule. Enabled rules are combined with AND.');
    if (spec.time && (!Number.isFinite(spec.time.toleranceMs) || spec.time.toleranceMs < 0 || left.kinds[spec.time.left] !== 'date' || right.kinds[spec.time.right] !== 'date')) throw Error('Time matching requires date fields and a nonnegative tolerance.');
    if (spec.spatial && (!Number.isFinite(spec.spatial.radiusMetres) || spec.spatial.radiusMetres < 0)) throw Error('Spatial radius must be nonnegative.');
    const ids = new Map<string, number[]>(), key = (v: unknown) => v == null ? undefined : typeof v + ':' + String(v);
    if (spec.identifier) {
        if (!left.columns[spec.identifier.left] || !right.columns[spec.identifier.right]) throw Error('Missing identifier mapping.');
        for (let j = 0; j < right.indices.length; j++) { const k = key(right.columns[spec.identifier.right][j]); if (k !== undefined) { const list = ids.get(k) ?? []; list.push(j); ids.set(k, list); } }
    }
    const indexedField = spec.time ? right.columns[spec.time.right] : Array.from(right.latitude);
    const sorted = spec.identifier ? [] : indexedField.map((v, index) => ({ value: Number(v), index })).filter((v, i) => indexedField[i] != null && Number.isFinite(v.value)).sort((a, b) => a.value - b.value);
    const pairs: [number, number][] = [], preview: RelationshipResult['preview'] = [], rightHits = new Uint32Array(right.indices.length); let matchedLeft = 0, multiplyLeft = 0, visits = 0;
    for (let i = 0; i < left.indices.length; i++) {
        let candidates: Iterable<number>;
        if (spec.identifier) candidates = ids.get(key(left.columns[spec.identifier.left][i]) ?? '') ?? [];
        else { const center = spec.time ? numeric(left.columns[spec.time.left][i]) : left.latitude[i], tolerance = spec.time ? spec.time.toleranceMs : spec.spatial!.radiusMetres / 111000;
            const lo = center === undefined ? 0 : lowerBound(sorted, center - tolerance), hi = center === undefined ? 0 : lowerBound(sorted, center + tolerance, true); candidates = sorted.slice(lo, hi).map(v => v.index); }
        const matches: { index: number; score: number; timeScore: number }[] = [];
        for (const j of candidates) {
            if (++visits > 10000000) throw Error('Relationship exceeds 10 million candidate checks. Tighten tolerances or add an identifier rule.');
            if (visits % 8192 === 0) { await yieldEvents(); if (cancelled()) throw Error('Relationship superseded'); }
            let score = 0, timeScore = 0;
            if (spec.time) { const a = numeric(left.columns[spec.time.left][i]), b = numeric(right.columns[spec.time.right][j]); if (a === undefined || b === undefined || Math.abs(a - b) > spec.time.toleranceMs) continue; score = timeScore = Math.abs(a - b); }
            if (spec.spatial) { const distance = distanceMetres(left.longitude[i], left.latitude[i], right.longitude[j], right.latitude[j]); if (distance > spec.spatial.radiusMetres) continue; score = distance; }
            matches.push({ index: j, score, timeScore });
        }
        if (matches.length > 1) multiplyLeft++;
        const chosen = spec.match === 'unique' && matches.length !== 1 ? [] : spec.match === 'nearest' ? matches.sort((a, b) => a.score - b.score || a.timeScore - b.timeScore || right.indices[a.index] - right.indices[b.index]).slice(0, 1) : matches;
        if (chosen.length) matchedLeft++;
        for (const match of chosen) { pairs.push([left.indices[i], right.indices[match.index]]); rightHits[match.index]++; if (pairs.length > 1000000) throw Error('Relationship exceeds one million links. Tighten rules or use unique/nearest matching.'); }
        if (preview.length < 50) preview.push({ left: left.indices[i], id: left.ids[i], candidates: matches.length, matched: chosen.map(v => right.indices[v.index]) });
        if (i % 8192 === 0) { await yieldEvents(); if (cancelled()) throw Error('Relationship superseded'); }
    }
    const matchedRight = rightHits.reduce((n, v) => n + Number(v > 0), 0), multiplyRight = rightHits.reduce((n, v) => n + Number(v > 1), 0);
    return { leftTotal: left.indices.length, rightTotal: right.indices.length, matchedLeft, matchedRight, unmatchedLeft: left.indices.length - matchedLeft, unmatchedRight: right.indices.length - matchedRight, multiplyLeft, multiplyRight, pairs, preview };
}
