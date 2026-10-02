// The dependency-free demo host accepts only the Filter Encoding subset emitted
// by the app. This is deliberately not a general-purpose XML/WFS interpreter.
export function fixtureFilter(raw?: string): (f: { geometry: { coordinates: number[] }; properties: { timestamp: string } }) => boolean {
    if (!raw) return () => true;
    if (raw.length > 20000 || /<!|<\?/.test(raw)) throw Error('Unsupported fixture filter');
    const normalized = raw.replace(/\s+xmlns(?::[\w.-]+)?="[^"]*"/g, '').replace(/(<\/?)[\w.-]+:/g, '$1').trim();
    const wrapper = /^<Filter>([\s\S]*)<\/Filter>$/.exec(normalized);
    if (!wrapper) throw Error('Invalid fixture filter');
    let body = wrapper[1];
    if (body.startsWith('<And>') && body.endsWith('</And>')) body = body.slice(5, -6);
    const tests: ((f: { geometry: { coordinates: number[] }; properties: { timestamp: string } }) => boolean)[] = [];
    while (body.trim()) {
        body = body.trim();
        const comparison = /^<(PropertyIsGreaterThanOrEqualTo|PropertyIsLessThanOrEqualTo)><ValueReference>(?:demo:)?timestamp<\/ValueReference><Literal>([^<]+)<\/Literal><\/\1>/.exec(body);
        if (comparison) {
            const time = Date.parse(comparison[2]);
            if (!Number.isFinite(time)) throw Error('Invalid fixture filter time');
            const lower = comparison[1] === 'PropertyIsGreaterThanOrEqualTo';
            tests.push(f => lower ? Date.parse(f.properties.timestamp) >= time : Date.parse(f.properties.timestamp) <= time);
            body = body.slice(comparison[0].length); continue;
        }
        const bbox = /^<BBOX><ValueReference>(?:demo:)?geometry<\/ValueReference><Envelope srsName="urn:ogc:def:crs:OGC:1.3:CRS84"><lowerCorner>([^<]+)<\/lowerCorner><upperCorner>([^<]+)<\/upperCorner><\/Envelope><\/BBOX>/.exec(body);
        if (bbox) {
            const bounds = [...bbox[1].trim().split(/\s+/), ...bbox[2].trim().split(/\s+/)].map(Number);
            const [west, south, east, north] = bounds;
            if (bounds.length !== 4 || !bounds.every(Number.isFinite) || west > east || south > north) throw Error('Invalid fixture filter bounds');
            tests.push(f => { const [lon, lat] = f.geometry.coordinates; return lon >= west && lon <= east && lat >= south && lat <= north; });
            body = body.slice(bbox[0].length); continue;
        }
        throw Error('Fixture supports only timestamp comparisons and geometry BBOX joined by AND.');
    }
    if (!tests.length) throw Error('Empty fixture filter');
    return f => tests.every(test => test(f));
}
