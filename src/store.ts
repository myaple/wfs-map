import { Analyzer, all } from './analysis.ts';
import { type Feature, type Field, type Rule, numericValue, toText } from './data.ts';
type Column = {
    field: Field;
    dictionary: string[];
    codes: Map<string, number>;
};
type Chunk = {
    offset: number;
    length: number;
    values: (Float64Array | Int32Array)[];
    ids: (string | number | null)[];
    lon: Float64Array;
    lat: Float64Array;
};
export class Store {
    fields: Field[];
    columns: Column[];
    chunks: Chunk[] = [];
    length = 0;
    seen = new Set<string>();
    bounds = [Infinity, Infinity, -Infinity, -Infinity];
    constructor(fields: Field[]) { this.fields = fields; this.columns = fields.map(field => ({ field, dictionary: [], codes: new Map() })); }
    append(features: Feature[]) {
        const chunk: Chunk = { offset: this.length, length: features.length, values: this.columns.map(c => c.field.kind === 'string' ? new Int32Array(features.length) : new Float64Array(features.length)), ids: [], lon: new Float64Array(features.length), lat: new Float64Array(features.length) };
        const names = new Set(this.fields.map(f => f.name));
        for (let i = 0; i < features.length; i++) {
            const f = features[i], props = f.properties ?? {};
            if (Object.keys(props).some(k => !names.has(k)))
                throw new Error('A new attribute appeared after the first page. Use DescribeFeatureType or choose a larger first page.');
            const id = f.id ?? null;
            if (id !== null) {
                const key = typeof id + ':' + id;
                if (this.seen.has(key))
                    throw new Error(`Repeated feature ID ${id}: server pagination is unstable or startIndex is ignored. Use a stable sort field.`);
                this.seen.add(key);
            }
            chunk.ids.push(id);
            const [lon, lat] = f.geometry.coordinates;
            chunk.lon[i] = lon;
            chunk.lat[i] = lat;
            this.bounds[0] = Math.min(this.bounds[0], lon);
            this.bounds[1] = Math.min(this.bounds[1], lat);
            this.bounds[2] = Math.max(this.bounds[2], lon);
            this.bounds[3] = Math.max(this.bounds[3], lat);
            for (let j = 0; j < this.columns.length; j++) {
                const c = this.columns[j], v = props[c.field.name];
                if (c.field.kind === 'string') {
                    if (v == null) {
                        chunk.values[j][i] = -1;
                        continue;
                    }
                    const text = toText(v);
                    let code = c.codes.get(text);
                    if (code === undefined) {
                        code = c.dictionary.length;
                        c.dictionary.push(text);
                        c.codes.set(text, code);
                    }
                    chunk.values[j][i] = code;
                }
                else
                    chunk.values[j][i] = numericValue(v, c.field.kind);
            }
        }
        this.chunks.push(chunk);
        this.length += features.length;
    }
    finish() { this.seen.clear(); for (const c of this.columns)
        c.codes.clear(); }
    get(index: number) {
        const chunk = this.chunks.find(c => index >= c.offset && index < c.offset + c.length);
        if (!chunk)
            throw new Error('Point index out of bounds');
        const i = index - chunk.offset, properties: Record<string, unknown> = {};
        this.columns.forEach((c, j) => {
            const v = chunk.values[j][i];
            properties[c.field.name] = c.field.kind === 'string' ? (v < 0 ? null : c.dictionary[v]) : Number.isNaN(v) ? null : c.field.kind === 'date' ? new Date(v).toISOString() : c.field.kind === 'boolean' ? Boolean(v) : v;
        });
        return { id: chunk.ids[i], coordinates: [chunk.lon[i], chunk.lat[i]], properties };
    }
    async filter(rules: Rule[], cancelled: () => boolean = () => false): Promise<Uint32Array | null> {
        return (await new Analyzer(this).run(all(rules), [], cancelled)).indices;
    }
}
