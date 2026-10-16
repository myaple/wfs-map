export const overlayKeys = ['overlayGeoJSON', 'overlayFileName', 'overlayColor'] as const;
export const overlayConfigKeys = overlayKeys;
export type OverlayConfig = Record<typeof overlayKeys[number], string>;
export const overlayDefaults: OverlayConfig = { overlayGeoJSON: '', overlayFileName: '', overlayColor: '#d45b24' };
// Hex colour list offered when adding a GeoJSON overlay. The first entry is
// the default so a fresh overlay is always visible against both basemaps.
export const overlayColors = [
    { id: '#d45b24', name: 'Orange' },
    { id: '#2463d4', name: 'Blue' },
    { id: '#17836f', name: 'Teal' },
    { id: '#8b49ba', name: 'Purple' },
    { id: '#b34378', name: 'Pink' },
    { id: '#957119', name: 'Olive' },
    { id: '#466673', name: 'Slate' },
    { id: '#657c25', name: 'Green' }
] as const;
export function validateOverlayConfig(c: OverlayConfig) {
    if (overlayKeys.some(k => typeof c[k] !== 'string')) throw Error('Invalid overlay settings.');
    if (c.overlayColor && !overlayColors.some(o => o.id === c.overlayColor)) throw Error('Choose an overlay colour from the list.');
}
export function isValidGeoJSON(text: string): boolean {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return false; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const doc = parsed as { type?: unknown };
    if (doc.type === 'FeatureCollection') {
        return Array.isArray((parsed as { features?: unknown }).features);
    }
    if (doc.type === 'Feature') return !!(parsed as { geometry?: unknown }).geometry;
    return ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(doc.type as string);
}
export function overlayWarning(text: string): string {
    try {
        const doc = JSON.parse(text) as any;
        const features = doc.type === 'FeatureCollection' ? doc.features : [doc];
        const points = features.filter((f: any) => f?.geometry?.type === 'Point' || f?.geometry?.type === 'MultiPoint').length;
        if (!points) return '';
        return `${points.toLocaleString()} point ${points === 1 ? 'feature' : 'features'} use the point size slider; lines and polygons use the overlay colour.`;
    } catch { return ''; }
}
