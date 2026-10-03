export const configKeys = ['url', 'layer', 'version', 'format', 'srs', 'axis', 'sort', 'pageSize', 'limit', 'timeField', 'geometryField', 'type', 'csvText', 'csvRef', 'fileName', 'delimiter', 'geometryMode', 'longitudeField', 'latitudeField'] as const;
export type Config = Record<typeof configKeys[number], string>;
export const defaultConfig: Config = { url: '', layer: '', version: '2.0.0', format: 'application/json', srs: 'urn:ogc:def:crs:OGC:1.3:CRS84', axis: 'xy', sort: '', pageSize: '50000', limit: '10000000', timeField: '', geometryField: '', type: 'wfs', csvText: '', csvRef: '', fileName: '', delimiter: ',', geometryMode: 'xy', longitudeField: '', latitudeField: '' };
export type SavedSource = {
    id: string; name: string; enabled: boolean; config: Config;
    color?: [number, number, number];
    coloring?: { field: string; bins: number; low: string; high: string; categories?: Record<string, Record<string, string>> };
};
export type Background = { url: string; attribution: string; enabled: boolean };
export type MapSettings = { center: [number, number]; zoom: number; pointSize: number };
export type Settings = { sources: SavedSource[]; background: Background; map?: MapSettings };
export const settingsKey = 'wfs-settings';
const defaultBackground: Background = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', enabled: false };
// Old fixture settings become ordinary endpoint query parameters. Other servers
// keep their URLs verbatim, including vendor parameters and authentication tokens.
export function migrateSource(input: any): SavedSource | undefined {
    if (!input || typeof input.name !== 'string' || !input.config || typeof input.config.url !== 'string') return;
    const config = { ...defaultConfig };
    for (const key of configKeys) if (typeof input.config[key] === 'string') config[key] = input.config[key];
    if (config.type === 'csv' && config.csvText && !config.csvRef) config.csvRef = crypto.randomUUID();
    try {
        const url = new URL(config.url, location.href);
        if (url.origin === location.origin && url.pathname === '/wfs' && ['points', 'distribution'].some(key => typeof input.config[key] === 'string')) {
            for (const key of ['points', 'distribution']) if (typeof input.config[key] === 'string' && !url.searchParams.has(key)) url.searchParams.set(key, input.config[key]);
            config.url = config.url.startsWith('/') ? url.pathname + url.search : url.href;
        }
    } catch { }
    return { id: typeof input.id === 'string' ? input.id : crypto.randomUUID(), name: input.name, enabled: input.enabled === true, config, color: input.color, coloring: input.coloring };
}
export function readSettings(): Settings {
    const empty = { sources: [], background: { ...defaultBackground } };
    try {
        const saved = JSON.parse(localStorage.getItem(settingsKey) ?? 'null');
        const oldSources = saved ? saved.sources : JSON.parse(localStorage.getItem('wfs-sources') ?? 'null');
        const oldBackground = saved ? saved.background : JSON.parse(localStorage.getItem('wfs-basemap') ?? 'null');
        let candidates = Array.isArray(oldSources) ? oldSources : [];
        if (!saved && oldSources === null) {
            const legacy = JSON.parse(localStorage.getItem('wfs-configuration') ?? 'null');
            if (legacy && typeof legacy.url === 'string') candidates = [{ name: 'WFS source', enabled: true, config: legacy }];
        }
        const sources = candidates.map(migrateSource).filter((s): s is SavedSource => !!s).slice(0, 8);
        let map: MapSettings | undefined;
        try { if (saved?.map) { validateMapSettings(saved.map); map = saved.map; } } catch { }
        return { sources, background: { ...defaultBackground, ...oldBackground }, ...(map ? { map } : {}) };
    } catch { return empty; }
}
export function validateConfig(config: Config) {
    if (config.type === 'csv') {
        if (!config.csvRef && !config.csvText.trim()) throw Error('Choose a CSV file.');
        if (!['xy', 'wkt', 'geojson'].includes(config.geometryMode)) throw Error('Choose a CSV geometry format.');
        if (config.geometryMode === 'xy' ? !config.longitudeField || !config.latitudeField : !config.geometryField) throw Error('Choose the CSV geometry columns.');
        return;
    }
    if (config.type !== 'wfs') throw Error('Choose WFS or CSV as the source type.');
    const url = new URL(config.url, location.href);
    if (!config.url.trim() || !['http:', 'https:'].includes(url.protocol)) throw Error('Enter an HTTP(S) WFS endpoint or a relative URL.');
    if (!config.layer.trim()) throw Error('Enter a feature type or discover the server’s layers.');
    for (const [key, max] of [['pageSize', 100000], ['limit', 50000000]] as const) {
        const n = Number(config[key]);
        if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error(`${key === 'pageSize' ? 'Features per request' : 'Client point limit'} must be a whole number from 1 to ${max.toLocaleString()}.`);
    }
}
export function validateBackground(background: Background) {
    if (!background.url) return;
    const url = new URL(background.url, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || !['{z}', '{x}', '{y}'].every(token => background.url.includes(token))) throw Error('Use an HTTP(S) XYZ tile URL with {z}, {x}, and {y}, or leave it empty.');
}
export function validateMapSettings(map: MapSettings) {
    if (!map || !Array.isArray(map.center) || map.center.length !== 2 || !map.center.every(Number.isFinite)
        || Math.abs(map.center[0]) > 180 || Math.abs(map.center[1]) > 85.051129
        || !Number.isFinite(map.zoom) || map.zoom < 1 || map.zoom > 22
        || !Number.isFinite(map.pointSize) || map.pointSize < 1 || map.pointSize > 8) throw Error('Invalid map view or point size.');
}

// File references identify immutable CSV contents without comparing megabytes.
export function configIdentity(config: Config) {
    return JSON.stringify({ ...config, csvText: config.csvRef ? '' : config.csvText });
}
export function settingsMetadata(settings: Settings): Settings {
    return { ...settings, sources: settings.sources.map(s => ({ ...s, config: { ...s.config, csvText: '' } })) };
}
