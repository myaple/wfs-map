import { numericValue, type Rule } from './data.ts';
import type { Store } from './store.ts';
export type Expression = Rule | {
    op: 'bbox';
    west: number;
    east: number;
    south: number;
    north: number;
} | {
    op: 'row';
    index: number;
} | {
    op: 'and' | 'or';
    children: Expression[];
};
export type ChartSpec = {
    id: string;
    type: 'bar' | 'pie' | 'time' | 'scatter';
    x: string;
    y?: string;
    bins: number;
    binned?: boolean;
    aggregate?: 'count' | 'sum' | 'mean' | 'min' | 'max';
};
export type Axis = {
    kind?: string;
    field: string;
    labels: string[];
    ranges?: Float64Array;
    rules: Expression[];
};
export type ChartResult = {
    id: string;
    type: ChartSpec['type'];
    x: Axis;
    y?: Axis;
    counts: Uint32Array;
    missing: number;
    values?: Float64Array;
    measure?: string;
    raw?: {
        positions: Float32Array;
        precise?: boolean;
        rows: Uint32Array;
        bounds: Float64Array;
    };
};
const normalize = (v: number, lo: number, hi: number) => {
    if (hi === lo)
        return 0;
    const width = hi - lo;
    return (Number.isFinite(width) ? (v - lo) / width : (v / 2 - lo / 2) / (hi / 2 - lo / 2)) * 2 - 1;
};
const BLOCK = 32768;
export async function yieldEvents() {
    if ((globalThis as any).scheduler?.yield)
        return (globalThis as any).scheduler.yield();
    if (typeof MessageChannel !== 'undefined')
        return new Promise<void>(resolve => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
            channel.port2.postMessage(null);
        });
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}
const group = (op: 'and' | 'or', children: Expression[]): Expression => ({ op, children });
export const all = (rules: Rule[]): Expression => group('and', rules);
type Node = {
    mask: Uint8Array;
    children?: Node[];
    union?: boolean;
    column?: number;
    op?: Rule['op'];
    target?: number;
    pass?: Uint8Array;
    text?: boolean;
    geo?: {
        west: number;
        east: number;
        south: number;
        north: number;
    };
    row?: number;
};
async function compile(store: Store, expression: Expression, cancelled: () => boolean): Promise<Node> {
    let size = 0;
    async function visit(expr: Expression, depth: number): Promise<Node> {
        if (++size > 128 || depth > 8)
            throw new Error('Filters support up to 128 nodes and 8 levels of nesting');
        const node: Node = { mask: new Uint8Array(BLOCK) };
        if ('children' in expr) {
            if (!['and', 'or'].includes(expr.op) || !Array.isArray(expr.children))
                throw new Error('Invalid filter group');
            node.children = [];
            for (const child of expr.children)
                node.children.push(await visit(child, depth + 1));
            node.union = expr.op === 'or';
            return node;
        }
        if (expr.op === 'row') {
            if (!Number.isInteger(expr.index) || expr.index < 0 || expr.index >= store.length)
                throw Error('Invalid point index');
            node.row = expr.index;
            return node;
        }
        if (expr.op === 'bbox') {
            const { west, east, south, north } = expr;
            if (![west, east, south, north].every(Number.isFinite) || west < -180 || east > 180 || east < -180 || west > 180 || south < -90 || north > 90 || south > north)
                throw Error('Invalid geographic bounds');
            node.geo = { west, east, south, north };
            return node;
        }
        const column = store.fields.findIndex(f => f.name === expr.field);
        if (column < 0)
            throw new Error(`Unknown attribute ${expr.field}`);
        const c = store.columns[column], op = expr.op;
        if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'null', 'notnull', 'in', 'notin'].includes(op))
            throw new Error('Invalid filter operator');
        const nullOp = op === 'null' || op === 'notnull', setOp = op === 'in' || op === 'notin';
        if (!nullOp && !setOp && expr.value == null)
            throw new Error('Missing filter value');
        if (op === 'contains' && c.field.kind !== 'string')
            throw new Error('Contains requires a text attribute');
        node.column = column;
        node.op = op;
        node.text = c.field.kind === 'string';
        if (node.text && !nullOp) {
            const set = new Set(expr.values ?? []);
            if (setOp && !Array.isArray(expr.values))
                throw new Error('Missing category values');
            const target = expr.value ?? '';
            node.pass = new Uint8Array(c.dictionary.length);
            for (let i = 0; i < c.dictionary.length; i++) {
                if (i > 0 && i % BLOCK === 0) {
                    await yieldEvents();
                    if (cancelled())
                        throw new Error('Superseded');
                }
                const v = c.dictionary[i];
                node.pass[i] = Number(op === 'in' ? set.has(v) : op === 'notin' ? !set.has(v) :
                    op === 'eq' ? v === target : op === 'ne' ? v !== target : op === 'contains' ? v.includes(target) :
                        op === 'gt' ? v > target : op === 'gte' ? v >= target : op === 'lt' ? v < target : v <= target);
            }
        }
        else {
            if (setOp)
                throw new Error('Category sets require a text attribute');
            node.target = nullOp ? 0 : numericValue(expr.value, c.field.kind);
        }
        return node;
    }
    return visit(expression, 0);
}
function evaluate(node: Node, values: (Float64Array | Int32Array)[], base: number, n: number, lon: Float64Array, lat: Float64Array, offset: number): Uint8Array {
    const out = node.mask;
    if (node.children) {
        out.fill(node.union ? 0 : 1, 0, n);
        for (const child of node.children) {
            const next = evaluate(child, values, base, n, lon, lat, offset);
            if (node.union)
                for (let i = 0; i < n; i++)
                    out[i] |= next[i];
            else
                for (let i = 0; i < n; i++)
                    out[i] &= next[i];
        }
        return out;
    }
    if (node.row !== undefined) {
        for (let i = 0; i < n; i++)
            out[i] = Number(offset + base + i === node.row);
        return out;
    }
    if (node.geo) {
        const g = node.geo;
        for (let i = 0; i < n; i++) {
            const x = lon[base + i], y = lat[base + i];
            out[i] = Number(y >= g.south && y <= g.north && (g.west <= g.east ? x >= g.west && x <= g.east : x >= g.west || x <= g.east));
        }
        return out;
    }
    const column = values[node.column!], target = node.target!, op = node.op!;
    if (node.pass) {
        for (let i = 0; i < n; i++) {
            const v = column[base + i];
            out[i] = v < 0 ? 0 : node.pass[v];
        }
        return out;
    }
    for (let i = 0; i < n; i++) {
        const v = column[base + i], missing = node.text ? v < 0 : !Number.isFinite(v);
        out[i] = Number(op === 'null' ? missing : op === 'notnull' ? !missing : !missing &&
            (op === 'eq' ? v === target : op === 'ne' ? v !== target : op === 'gt' ? v > target :
                op === 'gte' ? v >= target : op === 'lt' ? v < target : v <= target));
    }
    return out;
}
type Profile = {
    min: number;
    max: number;
    top?: number[];
};
type Prepared = {
    result: ChartResult;
    xi: number;
    yi: number;
    xbin: (v: number) => number;
    ybin?: (v: number) => number;
    spec: ChartSpec;
    measure: number;
    rawCount: number;
};
export class Analyzer {
    private profiles = new Map<number, Profile>();
    private store: Store;
    constructor(store: Store) { this.store = store; }
    private async profile(j: number, cancelled: () => boolean): Promise<Profile> {
        const cached = this.profiles.get(j);
        if (cached)
            return cached;
        const c = this.store.columns[j], counts = c.field.kind === 'string' ? new Uint32Array(c.dictionary.length) : undefined;
        let min = Infinity, max = -Infinity;
        for (const chunk of this.store.chunks)
            for (let base = 0; base < chunk.length; base += BLOCK) {
                const values = chunk.values[j], end = Math.min(base + BLOCK, chunk.length);
                for (let i = base; i < end; i++) {
                    const v = values[i];
                    if (counts) {
                        if (v >= 0)
                            counts[v]++;
                    }
                    else if (Number.isFinite(v)) {
                        if (v < min)
                            min = v;
                        if (v > max)
                            max = v;
                    }
                }
                await yieldEvents();
                if (cancelled())
                    throw new Error('Superseded');
            }
        const top: number[] = [];
        if (counts)
            for (let code = 0; code < counts.length; code++) {
                let p = 0;
                while (p < top.length && counts[top[p]] >= counts[code])
                    p++;
                if (p < 23) {
                    top.splice(p, 0, code);
                    if (top.length > 23)
                        top.pop();
                }
                if (code % BLOCK === 0) {
                    await yieldEvents();
                    if (cancelled())
                        throw new Error('Superseded');
                }
            }
        const result = { min, max, top: counts ? top : undefined };
        this.profiles.set(j, result);
        return result;
    }
    private async axis(name: string, bins: number, cancelled: () => boolean): Promise<{
        axis: Axis;
        column: number;
        bin: (v: number) => number;
    }> {
        const j = this.store.fields.findIndex(f => f.name === name);
        if (j < 0)
            throw new Error(`Unknown chart attribute ${name}`);
        const c = this.store.columns[j], p = await this.profile(j, cancelled);
        if (c.field.kind === 'string') {
            const codes = p.top!, labels = codes.map(code => c.dictionary[code]);
            const rules: Expression[] = labels.map(value => ({ field: name, op: 'eq', value }));
            const other = c.dictionary.length > codes.length;
            const map = new Uint8Array(c.dictionary.length);
            map.fill(codes.length);
            codes.forEach((code, i) => map[code] = i);
            if (other) {
                rules.push({ field: name, op: 'notin', values: [...labels] });
                labels.push('Other categories');
            }
            return { column: j, axis: { field: name, labels, rules }, bin: v => v < 0 ? -1 : map[v] };
        }
        if (c.field.kind === 'boolean')
            return { column: j, axis: { field: name, labels: ['false', 'true'], rules: [{ field: name, op: 'eq', value: 'false' }, { field: name, op: 'eq', value: 'true' }] }, bin: v => Number.isFinite(v) ? v : -1 };
        if (!Number.isFinite(p.min))
            return { column: j, axis: { field: name, labels: [], rules: [] }, bin: () => -1 };
        const n = p.min === p.max ? 1 : bins, width = (p.max - p.min) / n;
        const ranges = new Float64Array(n + 1), labels: string[] = [], rules: Expression[] = [];
        const str = (v: number) => c.field.kind === 'date' ? new Date(v).toISOString() : String(v);
        const label = (v: number) => c.field.kind === 'date' ? new Date(v).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC') : Number(v.toPrecision(4)).toString();
        const regular = Number.isFinite(width) && width > 0;
        for (let i = 0; i <= n; i++) {
            const edge = regular ? p.min + width * i : p.min * (1 - i / n) + p.max * (i / n);
            ranges[i] = i === n ? p.max : c.field.kind === 'date' ? Math.ceil(edge) : edge;
        }
        for (let i = 0; i < n; i++) {
            labels.push(n === 1 ? label(p.min) : `${label(ranges[i])} – ${label(ranges[i + 1])}`);
            rules.push(group('and', [{ field: name, op: 'gte', value: str(ranges[i]) }, { field: name, op: i === n - 1 ? 'lte' : 'lt', value: str(ranges[i + 1]) }]));
        }
        const bin = (v: number) => {
            if (!Number.isFinite(v))
                return -1;
            if (n === 1)
                return 0;
            if (!regular) {
                let lo = 0, hi = n;
                while (lo + 1 < hi) {
                    const mid = (lo + hi) >>> 1;
                    if (v >= ranges[mid])
                        lo = mid;
                    else
                        hi = mid;
                }
                return lo;
            }
            let index = Math.min(n - 1, Math.max(0, Math.floor((v - p.min) / width)));
            // Correct IEEE rounding at exact bin edges; filters use these same edges.
            while (index > 0 && v < ranges[index])
                index--;
            while (index < n - 1 && v >= ranges[index + 1])
                index++;
            return index;
        };
        return { column: j, axis: { field: name, labels, ranges, rules }, bin };
    }
    async colors(name: string, bins: number, cancelled: () => boolean = () => false) {
        if (!Number.isInteger(bins) || bins < 2 || bins > 64)
            throw Error('Invalid colour bins');
        const a = await this.axis(name, bins, cancelled), codes = new Uint8Array(this.store.length);
        codes.fill(255);
        for (const chunk of this.store.chunks)
            for (let base = 0; base < chunk.length; base += BLOCK) {
                const end = Math.min(base + BLOCK, chunk.length);
                for (let i = base; i < end; i++) {
                    const bin = a.bin(chunk.values[a.column][i]);
                    if (bin >= 0)
                        codes[chunk.offset + i] = bin;
                }
                await yieldEvents();
                if (cancelled())
                    throw Error('Superseded');
            }
        return { codes, axis: a.axis };
    }
    async run(expression: Expression, specs: ChartSpec[], cancelled: () => boolean = () => false) {
        if (specs.length > 12)
            throw new Error('Up to 12 charts are supported');
        const root = await compile(this.store, expression, cancelled), prepared: Prepared[] = [];
        for (const s of specs) {
            if (!['bar', 'pie', 'time', 'scatter'].includes(s.type) || !Number.isInteger(s.bins) || s.bins < 2 || s.bins > 64)
                throw new Error('Invalid chart configuration');
            const field = this.store.fields.find(f => f.name === s.x);
            if (s.type === 'time' && field?.kind !== 'date')
                throw new Error('Time series requires a date attribute');
            if (s.type === 'scatter' && (!s.y || !['number', 'date'].includes(field?.kind ?? '') || !['number', 'date'].includes(this.store.fields.find(f => f.name === s.y)?.kind ?? '')))
                throw new Error('Scatter axes require numeric or date attributes');
            const x = await this.axis(s.x, s.bins, cancelled), y = s.type === 'scatter' ? await this.axis(s.y!, s.bins, cancelled) : undefined;
            x.axis.kind = field?.kind;
            if (y)
                y.axis.kind = this.store.fields[y.column].kind;
            const aggregate = s.aggregate ?? 'count', measure = s.type === 'time' && aggregate !== 'count' ? this.store.fields.findIndex(f => f.name === s.y && f.kind === 'number') : -1;
            if (s.type === 'time' && (!['count', 'sum', 'mean', 'min', 'max'].includes(aggregate) || aggregate !== 'count' && measure < 0))
                throw Error('Time series Y requires a numeric attribute and aggregation');
            const size = x.axis.labels.length * (y?.axis.labels.length ?? 1);
            const result: ChartResult = { id: s.id, type: s.type, x: x.axis, y: y?.axis, counts: new Uint32Array(size), missing: 0 };
            if (measure >= 0) {
                result.values = new Float64Array(size);
                result.values.fill(aggregate === 'min' ? Infinity : aggregate === 'max' ? -Infinity : 0);
                result.measure = `${aggregate}(${s.y})`;
            }
            if (s.binned === false && s.type === 'scatter') {
                const xp = await this.profile(x.column, cancelled), yp = await this.profile(y!.column, cancelled);
                const precise = field?.kind === 'date' || this.store.fields[y!.column].kind === 'date';
                result.raw = { precise, positions: new Float32Array(this.store.length * (precise ? 4 : 2)), rows: new Uint32Array(this.store.length), bounds: new Float64Array([xp.min, yp.min, xp.max, yp.max]) };
                result.counts = new Uint32Array(0);
            }
            prepared.push({ result, xi: x.column, yi: y?.column ?? -1, xbin: x.bin, ybin: y?.bin, spec: s, measure, rawCount: 0 });
        }
        const unfiltered = 'children' in expression && expression.op === 'and' && !expression.children.length;
        const indices = unfiltered ? null : new Uint32Array(this.store.length);
        let count = 0;
        for (const chunk of this.store.chunks)
            for (let base = 0; base < chunk.length; base += BLOCK) {
                const n = Math.min(BLOCK, chunk.length - base), mask = evaluate(root, chunk.values, base, n, chunk.lon, chunk.lat, chunk.offset);
                for (let i = 0; i < n; i++)
                    if (mask[i]) {
                        if (indices)
                            indices[count] = chunk.offset + base + i;
                        count++;
                    }
                for (const chart of prepared) {
                    const x = chunk.values[chart.xi], y = chart.yi >= 0 ? chunk.values[chart.yi] : undefined, nx = chart.result.x.labels.length;
                    for (let i = 0; i < n; i++)
                        if (mask[i]) {
                            const r = chart.result, v = x[base + i], yv = y?.[base + i], mv = chart.measure >= 0 ? chunk.values[chart.measure][base + i] : 0;
                            if (r.raw) {
                                if (!Number.isFinite(v) || !Number.isFinite(yv!)) {
                                    r.missing++;
                                    continue;
                                }
                                const k = chart.rawCount++, b = r.raw.bounds;
                                const xn = normalize(v, b[0], b[2]), yn = normalize(yv!, b[1], b[3]);
                                if (r.raw.precise) {
                                    const hx = Math.fround(xn), hy = Math.fround(yn);
                                    r.raw.positions[k * 4] = hx;
                                    r.raw.positions[k * 4 + 1] = hy;
                                    r.raw.positions[k * 4 + 2] = xn - hx;
                                    r.raw.positions[k * 4 + 3] = yn - hy;
                                }
                                else {
                                    r.raw.positions[k * 2] = xn;
                                    r.raw.positions[k * 2 + 1] = yn;
                                }
                                r.raw.rows[k] = chunk.offset + base + i;
                                continue;
                            }
                            let xb = chart.xbin(v), yb = y ? chart.ybin!(yv!) : 0;
                            if (xb < 0 || yb < 0 || chart.measure >= 0 && !Number.isFinite(mv))
                                r.missing++;
                            else {
                                const k = yb * nx + xb;
                                r.counts[k]++;
                                if (r.values) {
                                    const a = chart.spec.aggregate;
                                    r.values[k] = a === 'min' ? Math.min(r.values[k], mv) : a === 'max' ? Math.max(r.values[k], mv) : r.values[k] + mv;
                                }
                            }
                        }
                }
                await yieldEvents();
                if (cancelled())
                    throw new Error('Superseded');
            }
        for (const chart of prepared) {
            const r = chart.result;
            if (r.raw) {
                r.raw.positions = chart.rawCount < this.store.length / 2 ? r.raw.positions.slice(0, chart.rawCount * (r.raw.precise ? 4 : 2)) : r.raw.positions.subarray(0, chart.rawCount * (r.raw.precise ? 4 : 2));
                r.raw.rows = chart.rawCount < this.store.length / 2 ? r.raw.rows.slice(0, chart.rawCount) : r.raw.rows.subarray(0, chart.rawCount);
            }
            if (r.values)
                for (let i = 0; i < r.values.length; i++)
                    r.values[i] = !r.counts[i] ? NaN : chart.spec.aggregate === 'mean' ? r.values[i] / r.counts[i] : r.values[i];
        }
        return { indices: indices?.subarray(0, count) ?? null, count, charts: prepared.map(p => p.result) };
    }
}
