import { mercator, type Feature, type Field } from './data.ts';
import type { Config } from './source-settings.ts';
import type { QueryBounds } from './wfs-query.ts';

// RFC 4180 quoting, escaped quotes, embedded newlines, CRLF and UTF-8 BOM.
export function parseCSV(text: string, delimiter = ','): { headers: string[]; rows: string[][] } {
    if (![',', ';', '\t'].includes(delimiter)) throw Error('Choose comma, semicolon or tab as the delimiter.');
    const records: string[][] = [];
    let row: string[] = [], value = '', quoted = false, closed = false;
    const field = () => { row.push(value); value = ''; closed = false; };
    const record = () => { field(); if (row.some(v => v !== '')) records.push(row); row = []; };
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
            else if (c === '"') { quoted = false; closed = true; }
            else value += c;
        } else if (c === delimiter) field();
        else if (c === '\n' || c === '\r') { record(); if (c === '\r' && text[i + 1] === '\n') i++; }
        else if (c === '"' && !value && !closed) quoted = true;
        else {
            if (closed || c === '"') throw Error(`Malformed CSV near character ${i + 1}.`);
            value += c;
        }
    }
    if (quoted) throw Error('CSV contains an unterminated quoted field.');
    if (value || row.length || closed) record();
    const headers = (records.shift() ?? []).map(v => v.trim());
    if (!headers.length || headers.some(v => !v) || new Set(headers).size !== headers.length) throw Error('CSV needs unique, non-empty column headers.');
    records.forEach((r, i) => { if (r.length !== headers.length) throw Error(`CSV row ${i + 2} has ${r.length} columns; expected ${headers.length}.`); });
    return { headers, rows: records };
}

export function csvDataset(config: Config, bounds: QueryBounds = {}) {
    const { headers, rows } = parseCSV(config.csvText, config.delimiter);
    const index = (name: string) => {
        const i = headers.indexOf(name);
        if (i < 0) throw Error(`CSV column "${name}" was not found.`);
        return i;
    };
    const xy = config.geometryMode === 'xy';
    const lon = xy ? index(config.longitudeField) : -1, lat = xy ? index(config.latitudeField) : -1;
    const geometry = xy ? -1 : index(config.geometryField);
    const time = config.timeField ? index(config.timeField) : -1;
    if (bounds.time && time < 0) throw Error('Choose a CSV time attribute, or select All time.');
    const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
    const fields: Field[] = headers.map((name, i) => {
        const values = rows.map(r => r[i]).filter(v => v.trim() !== '');
        const kind = i === time ? 'date' : values.length && values.every(v => numeric.test(v.trim()) && Number.isFinite(Number(v))) ? 'number' : values.length && values.every(v => /^(true|false)$/i.test(v)) ? 'boolean' : 'string';
        return { name, kind };
    });
    const features: Feature[] = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
            let coordinates: number[];
            if (xy) {
                if (!row[lon].trim() || !row[lat].trim()) throw Error('Missing longitude or latitude.');
                coordinates = [Number(row[lon]), Number(row[lat])];
            } else if (config.geometryMode === 'wkt') {
                const match = /^\s*POINT\s*\(\s*([^\s]+)\s+([^\s]+)\s*\)\s*$/i.exec(row[geometry]);
                if (!match) throw Error('Expected WKT POINT (longitude latitude).');
                coordinates = [Number(match[1]), Number(match[2])];
            } else {
                const point = JSON.parse(…17987 tokens truncated…n the map to bound requests.';
    $('clearArea').hidden = !bbox;
    if (!mapReady) return;
    const data: Parameters<maplibregl.GeoJSONSource['setData']>[0] = { type: 'FeatureCollection', features: bbox ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[bbox.west, bbox.south], [bbox.east, bbox.south], [bbox.east, bbox.north], [bbox.west, bbox.north], [bbox.west, bbox.south]]] } }] : [] };
    const source = map.getSource('query-area') as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(data);
    else {
        map.addSource('query-area', { type: 'geojson', data });
        map.addLayer({ id: 'query-area-outline', type: 'line', source: 'query-area', paint: { 'line-color': '#3984cf', 'line-width': 2, 'line-dasharray': [3, 2] } });
    }
}
function chooseTime() {
    const custom = value('timeWindow') === 'custom';
    $('customTime').hidden = !custom;
    $('applyTime').textContent = custom ? 'Apply time range' : 'Refresh time window';
    if (custom) {
        const time = queryBounds.time ?? timeBounds(24);
        $<HTMLInputElement>('timeStart').value = time.start.slice(0, 19);
        $<HTMLInputElement>('timeEnd').value = time.end.slice(0, 19);
    } else applyTime();
}
function applyTime() {
    try {
        const choice = value('timeWindow');
        const time = choice === 'all' ? undefined : choice === 'custom'
            ? { start: value('timeStart') + 'Z', end: value('timeEnd') + 'Z' } : timeBounds(Number(choice));
        if (time) validateTime(time);
        queryBounds = { ...queryBounds, time };
        $('timeError').hidden = true;
        showQueryBounds(); reloadBounds();
    } catch (e) { $('timeError').textContent = (e as Error).message; $('timeError').hidden = false; }
}
$('timeWindow').onchange = chooseTime;
$('timeForm').onsubmit = e => { e.preventDefault(); applyTime(); };
$('clearArea').onclick = () => { queryBounds = { ...queryBounds, bbox: undefined }; showQueryBounds(); reloadBounds(); };
$<HTMLSelectElement>('timeWindow').value = queryBounds.time ? '24' : 'all';
showQueryBounds();
map.on('load', showQueryBounds);
