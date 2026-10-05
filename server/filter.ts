import { xmlDocument, fieldKind, type Field } from '../src/data.ts';
import { serverPredicate, type ServerFilter } from '../src/server-filters.ts';
import { fields as fixtureFields } from './demo.ts';
type Feature = { geometry: { coordinates: number[] }; properties: Record<string, unknown> };
const fields: Field[] = Object.entries(fixtureFields).map(([name, type]) => ({ name, kind: fieldKind(type) }));
// Deliberately bounded to the standard Filter Encoding subset emitted by the app.
export function fixtureFilter(raw?: string): (f: Feature) => boolean {
    if (!raw) return () => true;
    if (raw.length > 1_048_576 || /<!|<\?/.test(raw)) throw Error('Unsupported fixture filter');
    const root = xmlDocument(raw).Filter;
    let count = 0;
    const comparison: Record<string, ServerFilter['op']> = { PropertyIsEqualTo: 'eq', PropertyIsNotEqualTo: 'ne', PropertyIsGreaterThan: 'gt', PropertyIsGreaterThanOrEqualTo: 'gte', PropertyIsLessThan: 'lt', PropertyIsLessThanOrEqualTo: 'lte', PropertyIsNull: 'null', PropertyIsLike: 'contains' };
    const property = (node: any) => String(node.ValueReference ?? node.PropertyName ?? '').replace(/^demo:/, '');
    function compile(node: any, depth = 0): (f: Feature) => boolean {
        if (!node || typeof node !== 'object' || depth > 4) throw Error('Invalid fixture filter');
        const entries = Object.entries(node).filter(([key]) => !key.startsWith('@_'));
        if (!entries.length) throw Error('Empty fixture filter');
        const tests = entries.flatMap(([tag, values]) => (Array.isArray(values) ? values : [values]).map((value: any) => {
            if (++count > 300) throw Error('Fixture filter too large');
            if (tag === 'And') return compile(value, depth + 1);
            if (tag === 'Not') { const test = compile(value, depth + 1); return (f: Feature) => !test(f); }
            if (tag === 'BBOX') {
                if (property(value) !== 'geometry') throw Error('Unknown fixture geometry');
                const envelope = value.Envelope, box = value.Box;
                const b = envelope ? `${envelope.lowerCorner} ${envelope.upperCorner}`.split(/\s+/).map(Number) : String(box?.coordinates ?? '').split(/[\s,]+/).map(Number);
                const [west, south, east, north] = b;
                if (b.length !== 4 || !b.every(Number.isFinite) || west > east || south > north) throw Error('Invalid fixture filter bounds');
                return (f: Feature) => { const [x, y] = f.geometry.coordinates; return x >= west && x <= east && y >= south && y <= north; };
            }
            const field = fields.find(f => f.name === property(value)), op = comparison[tag];
            if (!field || !op) throw Error('Unsupported fixture attribute filter');
            let literal = String(value.Literal ?? '');
            if (op === 'contains') {
                if (value['@_wildCard'] !== '*' || value['@_singleChar'] !== '?' || (value['@_escapeChar'] ?? value['@_escape']) !== '!' || !literal.startsWith('*') || !literal.endsWith('*')) throw Error('Unsupported fixture LIKE filter');
                literal = literal.slice(1, -1).replace(/!([!*?])/g, '$1');
            }
            const matches = serverPredicate([{ field: field.name, kind: field.kind, op, value: literal }], fields);
            return (f: Feature) => matches(f.properties);
        }));
        return f => tests.every(test => test(f));
    }
    return compile(root);
}
