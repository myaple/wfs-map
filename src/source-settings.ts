import { ellipseConfigKeys, ellipseDefaults, validateEllipseConfig, validateEllipseVertices } from './ellipses.ts';
import { validateServerFilters, type ServerFilter } from './server-filters.ts';
import type { ColourScheme } from './colour-schemes.ts';
import { createUUID } from './uuid.ts';
export const configKeys = ['url', 'layer', 'version', 'format', 'srs', 'axis', 'sort', 'pageSize', 'maxParallelRequests', 'pagingEnd', 'limit', 'timeField', 'geometryField', 'type', 'csvText', 'csvRef', 'fileName', 'delimiter', 'geometryMode', 'longitudeField', 'latitudeField', 'fieldTypes', ...ellipseConfigKeys] as const;
export type Config = Record<typeof configKeys[number], string>;
export const defaultConfig: Config = { url: '', layer: '', version: '2.0.0', format: 'application/json', srs: 'urn:ogc:def:crs:OGC:1.3:CRS84', axis: 'xy', sort: '', pageSize: '50000', maxParallelRequests: '10', pagingEnd: 'empty', limit: '10000000', timeField: '', geometryField: '', type: 'wfs', csvText: '', csvRef: '', fileName: '', delimiter: ',', geometryMode: 'xy', longitudeField: '', latitudeField: '', fieldTypes: '{}', ...ellipseDefaults };
export type SavedSource = {
    id: string; name: string; enabled: boolean; config: Config;
    color?: [number, number, number];
    serverFilters?: ServerFilter[];
    coloring?: { scheme?: ColourScheme; scale?: 'linear' | 'log10'; field: string; bins: number; low: string; high: string; categories?: Record<string, Record<string, string>> };
};
export type Background = { url: string; attribution: string; enabled: boolean };
export type MapSettings = { center: [number, number]; zoom: number; pointSize: number; ellipses?: boolean; ellipseVertices?: number; ellipseFullDetail?: boolean };
export type Settings = { sources: SavedSource[]; background: Background; map?: MapSettings };
export let settingsKey = 'wfs-settings';
export function setSettingsScope(key: string) { settingsKey = key; }
const defaultBackground: Background = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', enabled: false };
// Old fixture settings become ordinary endpoint query parameters. Other servers
// keep their URLs verbatim, including vendor parameters and authentication tokens.
export function migrateSource(input: any): SavedSource | undefined {
    if (!input || typeof input.name !== 'string' || !input.config || typeof input.config.url !== 'string') return;
    const config = { ...defaultConfig };
    for (const key of configKeys) if (typeof input.config[key] === 'string') config[key] = input.config[key];
    if (config.type === 'csv' && config.csvText && !config.csvRef) config.csvRef = createUUID();
    try {
        const url = new URL(config.url, location.href);
        if (url.origin === location.origin && url.pathname === '/wfs' && ['points', 'distribution'].some(key => typeof input.config[key] === 'string')) {
            for (const key of ['points', 'distribution']) if (typeof input.config[key] === 'string' && !url.searchParams.has(key)) url.searchParams.set(key, input.config[key]);
            config.url = config.url.startsWith('/') ? url.pathname + url.search : url.href;
        }
    } catch { }
    if (input.serverFilters !== undefined) validateServerFilters(input.serverFilters);
    return { serverFilters: input.serverFilters ? structuredClone(input.serverFilters) : [], id: typeof input.id === 'string' ? input.id : createUUID(), name: input.name, enabled: input.enabled === true, config, color: input.color, coloring: input.coloring };
}
export function readSettings(): Settings {
    const empty = { sources: [], background: { ...defaultBackground } };
    try {
        const saved = JSON.parse(localStorage.getItem(settingsKey) ?? 'null');
        const oldSources = saved ? saved.sources : settingsKey !== 'wfs-settings' ? [] : JSON.parse(localStorage.getItem('wfs-sources') ?? 'null');
        const oldBackground = saved ? saved.background : settingsKey !== 'wfs-settings' ? null : JSON.parse(localStorage.getItem('wfs-basemap') ?? 'null');
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
export type CSVFieldKind = 'string' | 'number' | 'boolean' | 'date';
export function csvFieldTypes(config: Config): Record<string, CSVFieldKind> {
    let types: unknown;
    try { types = JSON.parse(config.fieldTypes || '{}'); } catch { throw Error('Invalid CSV column type overrides.'); }
    if (!types || typeof types !== 'object' || Array.isArray(types) || Object.values(types).some(v => !['string', 'number', 'boolean', 'date'].includes(v))) throw Error('Invalid CSV column type overrides.');
    const result = types as Record<string, CSVFieldKind>;
    if (config.timeField && Object.hasOwn(result, config.timeField) && result[config.timeField] !== 'date') throw Error('The selected CSV time attribute must use Date / time or Automatic.');
    return result;
}
export function validateConfig(config: Config) {
    validateEllipseConfig({ ...ellipseDefaults, ...config });
    if (config.type === 'csv') {
        csvFieldTypes(config);
        if (!config.csvRef && !config.csvText.trim()) throw Error('Choose a CSV file.');
        if (!['xy', 'wkt', 'geojson'].includes(config.geometryMode)) throw Error('Choose a CSV geometry format.');
        if (config.geometryMode === 'xy' ? !config.longitudeField || !config.latitudeField : !config.geometryField) throw Error('Choose the CSV geometry columns.');
        return;
    }
    if (config.type !== 'wfs') throw Error('Choose WFS or CSV as the source type.');
    const url = new URL(config.url, location.href);
    if (!config.url.trim() || !['http:', 'https:'].includes(url.protocol)) throw Error('Enter an HTTP(S) WFS endpoint or a relative URL.');
    if (!config.layer.trim()) throw Error('Enter a feature type or discover the server’s layers.');
    if (!['empty', 'short'].includes(config.pagingEnd)) throw Error('Choose when WFS paging should stop.');
    for (const [key, max] of [['pageSize', 100000], ['maxParallelRequests', 100], ['limit', 50000000]] as const) {
        const n = Number(config[key]);
        if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error(`${key === 'pageSize' ? 'Features per request' : key === 'maxParallelRequests' ? 'Maximum parallel requests' : 'Client point limit'} must be a whole number from 1 to ${max.toLocaleString()}.`);
    }
}
export function validateBackground(background: Background) {
    if (!background.url) return;
    const url = new URL(background.url, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || !['{z}', '{x}', '{y}'].every(token => background.url.includes(token))) throw Error('Use an HTTP(S) XYZ tile URL with {z}, {x}, and {y}, or leave it empty.');
}
export function validateMapSettings(map: MapSettings) {
    if (map?.ellipseVertices !== undefined) validateEllipseVertices(map.ellipseVertices);
    if (map?.ellipseFullDetail !== undefined && typeof map.ellipseFullDetail !== 'boolean') throw Error('Invalid ellipse detail setting.');
    if (map?.ellipses !== undefined && typeof map.ellipses !== 'boolean') throw Error('Invalid ellipse visibility.');
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
