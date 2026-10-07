import { ellipseConfigKeys, ellipseDefaults } from './ellipses.ts';
import { colourSchemes } from './colour-schemes.ts';
import { validateServerFilters } from './server-filters.ts';
import { createUUID } from './uuid.ts';
import { packArchive, unpackArchive } from './backup-archive.ts';
import { configKeys, defaultConfig, settingsMetadata, validateBackground, validateConfig, validateMapSettings, type Config, type Settings, type SavedSource } from './source-settings.ts';

type Manifest = { format: 'wfs-map-backup'; version: 1; settings: Settings; csvFiles: Record<string, string> };
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function validateSettings(input: unknown): asserts input is Settings {
    if (!object(input) || !Array.isArray(input.sources) || input.sources.length > 8 || !object(input.background)) throw Error('Invalid backup settings.');
    const background = input.background;
    if (typeof background.url !== 'string' || typeof background.attribution !== 'string' || typeof background.enabled !== 'boolean') throw Error('Invalid map background settings.');
    validateBackground(background as Settings['background']);
    if (input.map !== undefined) validateMapSettings(input.map);
    const ids = new Set<string>();
    for (const source of input.sources) {
        if (!object(source) || typeof source.id !== 'string' || !source.id || source.id.length > 128 || ids.has(source.id)
            || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 120 || typeof source.enabled !== 'boolean'
            || !object(source.config) || configKeys.filter(k => !['fieldTypes', 'pagingEnd'].includes(k) && !ellipseConfigKeys.includes(k as typeof ellipseConfigKeys[number])).some(key => typeof source.config[key] !== 'string')) throw Error('Invalid or duplicate data source in backup.');
        for (const key of ellipseConfigKeys) if (source.config[key] === undefined) source.config[key] = ellipseDefaults[key];
        if (source.config.pagingEnd === undefined) source.config.pagingEnd = defaultConfig.pagingEnd;
        if (typeof source.config.pagingEnd !== 'string') throw Error('Invalid WFS paging completion.');
        if (source.config.fieldTypes === undefined) source.config.fieldTypes = '{}';
        if (typeof source.config.fieldTypes !== 'string') throw Error('Invalid CSV column type overrides.');
        validateServerFilters(source.serverFilters ?? []);
        ids.add(source.id);
        if (source.color !== undefined && (!Array.isArray(source.color) || source.color.length !== 3 || source.color.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1))) throw Error('Invalid source colour.');
        const coloring = source.coloring;
        const hex = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
        if (coloring !== undefined) {
            if (!object(coloring) || typeof coloring.field !== 'string' || !Number.isInteger(coloring.bins) || coloring.bins < 1 || coloring.bins > 256 || !hex(coloring.low) || !hex(coloring.high)) throw Error('Invalid point colouring settings.');
            if (coloring.scheme !== undefined && !colourSchemes.some(s => s.id === coloring.scheme)) throw Error('Invalid colour scheme.');
            if (coloring.scale !== undefined && !['linear', 'log10'].includes(coloring.scale)) throw Error('Invalid colour bin scale.');
            if (coloring.categories !== undefined && (!object(coloring.categories) || Object.values(coloring.categories).some(values => !object(values) || Object.values(values).some(v => !hex(v))))) throw Error('Invalid category colours.');
        }
        if (source.config.type === 'csv' && ![',', ';', '\t'].includes(source.config.delimiter)) throw Error('Invalid CSV delimiter.');
        validateConfig(source.config as Config);
    }
}
export async function createBackup(settings: Settings, readCSV: (reference: string) => Promise<string>): Promise<Blob> {
    // Work from the configured files, never loaded/filtered worker rows. Disabled
    // sources and CSV rows outside the current bounds belong in the backup too.
    const snapshot = structuredClone(settings), files = new Map<string, Blob>();
    const csvFiles: Record<string, string> = Object.create(null);
    for (const [index, source] of snapshot.sources.entries()) {
        if (source.config.type === 'csv') {
            const text = source.config.csvText || await readCSV(source.config.csvRef);
            // Validate using the file text without retaining it in the manifest.
            source.config.csvText = text;
            const path = `csv/source-${index + 1}.csv`;
            files.set(path, new Blob([text], { type: 'text/csv;charset=utf-8' })); csvFiles[source.id] = path;
        } else { source.config.csvText = ''; source.config.csvRef = ''; }
    }
    validateSettings(snapshot);
    const metadata = settingsMetadata(snapshot);
    for (const source of metadata.sources) source.config.csvRef = '';
    const manifest: Manifest = { format: 'wfs-map-backup', version: 1, settings: metadata, csvFiles };
    const json = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    if (json.size > 1024 * 1024) throw Error('Backup manifest is too large.');
    return packArchive(new Map([['manifest.json', json], ...files]));
}
export async function readBackup(archive: Blob): Promise<Settings> {
    const files = await unpackArchive(archive), manifestFile = files.get('manifest.json');
    if (!manifestFile) throw Error('Backup is missing manifest.json.');
    const manifest = JSON.parse(utf8.decode(await manifestFile.arrayBuffer()));
    if (!object(manifest) || manifest.format !== 'wfs-map-backup' || manifest.version !== 1) throw Error('Unsupported backup format or version.');
    if (!object(manifest.csvFiles) || !object(manifest.settings) || !Array.isArray(manifest.settings.sources)) throw Error('Invalid backup manifest.');
    const used = new Set(['manifest.json']);
    let csvCount = 0;
    for (const source of manifest.settings.sources as SavedSource[]) {
        if (!object(source) || !object(source.config)) throw Error('Invalid data source in backup.');
        if (source.config.csvText !== '' || source.config.csvRef !== '') throw Error('Backup manifest must not contain local CSV contents or references.');
        if (source.config.type !== 'csv') continue;
        csvCount++;
        const path = Object.hasOwn(manifest.csvFiles, source.id) ? manifest.csvFiles[source.id] : undefined;
        const file = typeof path === 'string' && /^csv\/source-[1-8]\.csv$/.test(path) ? files.get(path) : undefined;
        if (!file || used.has(path)) throw Error('Backup is missing a CSV file or references it more than once.');
        used.add(path);
        source.config.csvText = utf8.decode(await file.arrayBuffer());
        if (!source.config.csvText.trim()) throw Error('Backup contains an empty CSV file.');
        // References are immutable and local to a browser. Fresh references also
        // prevent a same-ID backup from silently reusing a different saved file.
        source.config.csvRef = createUUID();
    }
    if (used.size !== files.size || csvCount !== Object.keys(manifest.csvFiles).length) throw Error('Backup contains unexpected files or CSV references.');
    validateSettings(manifest.settings);
    return manifest.settings;
}
