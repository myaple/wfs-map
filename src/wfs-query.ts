import { parseUTC, utcISO } from './time.ts';
import { filterLiteral, validateServerFilters, type ServerFilter } from './server-filters.ts';
export type TimeBounds = { start: string; end: string };
export type MapBounds = { west: number; south: number; east: number; north: number };
export type QueryBounds = { time?: TimeBounds; bbox?: MapBounds };
export type QueryFields = { time: string; geometry: string; namespaces?: Record<string, string>; attributes?: Record<string, string> };
const xml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
export function timeBounds(hours: number, now = Date.now()): TimeBounds {
    return { start: new Date(now - hours * 3600000).toISOString(), end: new Date(now).toISOString() };
}
export function validateTime(time: TimeBounds) {
    const start = parseUTC(time.start), end = parseUTC(time.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw Error('Enter a valid UTC start and end, with the start before the end.');
}
// Use standard XML Filter Encoding, including BBOX in the same AND expression:
// WFS KVP BBOX and FILTER are mutually exclusive. Envelope CRS/axis order is
// independent of the requested output CRS and GML decoding order.
export function queryFilter(version: string, bounds: QueryBounds, fields: QueryFields, rules: ServerFilter[] = []): string | undefined {
    const v2 = version === '2.0.0', v1 = version === '1.0.0', prefix = v2 ? 'fes' : 'ogc';
    const tag = (name: string, body: string) => `<${prefix}:${name}>${body}</${prefix}:${name}>`;
    const ref = (field: string) => tag(v2 ? 'ValueReference' : 'PropertyName', xml(field));
    const conditions: string[] = [];
    validateServerFilters(rules);
    const comparisons = { eq: 'PropertyIsEqualTo', ne: 'PropertyIsNotEqualTo', gt: 'PropertyIsGreaterThan', gte: 'PropertyIsGreaterThanOrEqualTo', lt: 'PropertyIsLessThan', lte: 'PropertyIsLessThanOrEqualTo' };
    for (const rule of rules) {
        const property = ref(fields.attributes?.[rule.field] ?? rule.field);
        if (rule.op === 'null' || rule.op === 'notnull') {
            const condition = tag('PropertyIsNull', property);
            conditions.push(rule.op === 'null' ? condition : tag('Not', condition));
        } else if (rule.op === 'contains') {
            // Escape LIKE metacharacters so the value is a literal substring.
            const literal = filterLiteral(rule).replace(/[!*?]/g, c => '!' + c);
            conditions.push(`<${prefix}:PropertyIsLike wildCard="*" singleChar="?" escape${v1 ? '' : 'Char'}="!" matchCase="true">${property}${tag('Literal', xml('*' + literal + '*'))}</${prefix}:PropertyIsLike>`);
        } else conditions.push(tag(comparisons[rule.op], property + tag('Literal', xml(filterLiteral(rule)))));
    }
    if (bounds.time) {
        validateTime(bounds.time);
        if (!fields.time) throw Error('Choose a time attribute in this source’s WFS settings, or select All time. No unbounded request was sent.');
        conditions.push(tag('PropertyIsGreaterThanOrEqualTo', ref(fields.time) + tag('Literal', utcISO(bounds.time.start))), tag('PropertyIsLessThanOrEqualTo', ref(fields.time) + tag('Literal', utcISO(bounds.time.end))));
    }
    if (bounds.bbox) {
        const { west, south, east, north } = bounds.bbox;
        if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || west > east || south < -90 || north > 90 || south > north) throw Error('Invalid map area bounds.');
        if (!fields.geometry) throw Error('Choose a geometry attribute in this source’s WFS settings. No unbounded request was sent.');
        const envelope = v1
            ? `<gml:Box srsName="EPSG:4326"><gml:coordinates>${west},${south} ${east},${north}</gml:coordinates></gml:Box>`
            : `<gml:Envelope srsName="urn:ogc:def:crs:OGC:1.3:CRS84"><gml:lowerCorner>${west} ${south}</gml:lowerCorner><gml:upperCorner>${east} ${north}</gml:upperCorner></gml:Envelope>`;
        conditions.push(tag('BBOX', ref(fields.geometry) + envelope));
    }
    if (!conditions.length) return;
    const namespaces = Object.entries(fields.namespaces ?? {}).filter(([name]) => /^[A-Za-z_][\w.-]*$/.test(name) && !['fes', 'ogc', 'gml', 'xml', 'xmlns'].includes(name)).map(([name, uri]) => ` xmlns:${name}="${xml(uri)}"`).join('');
    return `<${prefix}:Filter xmlns:${prefix}="http://www.opengis.net/${v2 ? 'fes/2.0' : 'ogc'}" xmlns:gml="http://www.opengis.net/gml${v2 ? '/3.2' : ''}"${namespaces}>${conditions.length > 1 ? tag('And', conditions.join('')) : conditions[0]}</${prefix}:Filter>`;
}
