import { parseUTC, utcISO } from './time.ts';
import { mercator, type Feature, type Field } from './data.ts';
import { csvOptions } from './csv-options.ts';
import type { Config } from './source-settings.ts';
import type { QueryBounds } from './wfs-query.ts';
export type CSVProgress = (stage: string, completed: number, total: number) => void;
export type ParsedCSV = { headers: string[]; rows: string[][]; recordNumbers?: number[] };

// RFC 4180 quoting, escaped quotes, embedded newlines, CRLF and UTF-8 BOM.
// Row numbers throughout are logical record numbers, with the header as record 1.
export function parseCSV(text: string, delimiter = ',', allowInvalidRows = false, progress?: CSVProgress): ParsedCSV {
    if (![',', ';', '\t'].includes(delimiter)) throw Error('Choose comma, semicolon or tab as the delimiter.');
    const records: string[][] = [], recordNumbers: number[] = [];
    let recordNumber = 0;
    let row: string[] = [], value = '', quoted = false, closed = false;
    const field = () => { row.push(value); value = ''; closed = false; };
    const record = () => { const explicit = row.length > 0 || value !== '' || closed; field(); if (!explicit && recordNumber === 0) { row = []; return; } recordNumber++; if (explicit) { records.push(row); recordNumbers.push(recordNumber); } row = []; };
    const start = text.startsWith('\uFEFF') ? 1 : 0;
    for (let i = start; i < text.length; i++) {
        if (i % 262144 === 0) progress?.('Reading records', i, text.length);
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
    recordNumbers.shift();
    if (!headers.length || headers.some(v => !v) || new Set(headers).size !== headers.length) throw Error('CSV needs unique, non-empty column headers.');
    if (!allowInvalidRows) records.forEach((r, i) => { if (r.length !== headers.length) throw Error(`CSV row ${recordNumbers[i]} has ${r.length} columns; expected ${headers.length}.`); });
    return { headers, rows: records, ...(allowInvalidRows ? { recordNumbers } : {}) };
}
const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const isNumber = (v: string) => numeric.test(v.trim()) && Number.isFinite(Number(v));
const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
export type CSVPreview = {
    fields: Field[]; inferred: Field[]; missing: number[]; failed: number[];
    total: number; accepted: number; rejected: number;
    samples: { row: number; raw: string[]; values: unknown[]; errors: string[] }[];
    diagnostics: Blob;
};

// Shared by preview and loading: inference, casts and geometry validation cannot drift.
function csvReader(config: Config, parsed: ParsedCSV, progress?: CSVProgress) {
    const { headers, rows } = parsed, { types, missing, policy } = csvOptions(config);
    for (const name of Object.keys(types)) if (!headers.includes(name)) throw Error(`CSV column "${name}" was not found.`);
    const flags = headers.map(() => ({ count: 0, number: true, boolean: true, date: true, leadingZero: false }));
    for (let i = 0; i < rows.length; i++) {
        if (i % 10000 === 0) progress?.('Inferring column types', i, rows.length);
        if (rows[i].length !== headers.length) continue;
        rows[i].forEach((raw, j) => {
            const v = raw.trim(), f = flags[j];
            if (missing.has(v)) return;
            f.count++; f.number &&= isNumber(v) && (!Number.isInteger(Number(v)) || Number.isSafeInteger(Number(v)));
            f.boolean &&= /^(true|false)$/i.test(v);
            f.date &&= Number.isFinite(parseUTC(v));
            f.leadingZero ||= /^[+-]?0\d/.test(v);
        });
    }
    const inferred: Field[] = headers.map((name, j) => {
        const f = flags[j];
        return { name, kind: name === config.timeField ? 'date' : !f.count ? 'string' : f.number && !f.leadingZero ? 'number' : f.boolean ? 'boolean' : f.date ? 'date' : 'string' };
    });
    const fields = inferred.map(f => ({ ...f, kind: types[f.name] ?? f.kind }));
    const index = (name: string) => {
        if (!name) return -1;
        const i = headers.indexOf(name);
        if (i < 0) throw Error(`CSV column "${name}" was not found.`);
        return i;
    };
    const xy = config.geometryMode === 'xy';
    const lon = xy ? index(config.longitudeField) : -1, lat = xy ? index(config.latitudeField) : -1;
    const geometry = xy ? -1 : index(config.geometryField);
    if (config.timeField && fields[index(config.timeField)].kind !== 'date') throw Error('The selected time attribute must use the date/time type.');
    const cast = (raw: string, kind: Field['kind']) => {
        if (missing.has(raw.trim())) return null;
        if (kind === 'number') { if (!isNumber(raw)) throw Error('Expected a finite number.'); return Number(raw); }
        if (kind === 'boolean') { if (!/^(true|false)$/i.test(raw.trim())) throw Error('Expected true or false.'); return raw.trim().toLowerCase() === 'true'; }
        if (kind === 'date') { if (!Number.isFinite(parseUTC(raw))) throw Error('Invalid ISO 8601 time.'); return utcISO(raw); }
        return raw;
    };
    const read = (row: string[]) => {
        const errors: { column: number; message: string }[] = [], values: unknown[] = [];
        if (row.length !== headers.length) return { values, errors: [{ column: -1, message: `Has ${row.length} columns; expected ${headers.length}.` }], coordinates: [] as number[] };
        fields.forEach((f, j) => {
            try { values[j] = cast(row[j], f.kind); }
            catch (e) { values[j] = null; errors.push({ column: j, message: `${(e as Error).message} In ${f.name}.` }); }
        });
        let coordinates: number[] = [];
        try {
            if (xy) {
                if (lon < 0 || lat < 0) throw Error('Choose longitude and latitude columns.');
                if (missing.has(row[lon].trim()) || missing.has(row[lat].trim())) throw Error('Missing longitude or latitude.');
                if (!isNumber(row[lon]) || !isNumber(row[lat])) throw Error('Longitude and latitude must be finite numbers.');
                coordinates = [Number(row[lon]), Number(row[lat])];
            } else if (config.geometryMode === 'wkt') {
                if (geometry < 0) throw Error('Choose a geometry column.');
                const match = /^\s*POINT\s*\(\s*([^\s]+)\s+([^\s]+)\s*\)\s*$/i.exec(row[geometry]);
                if (!match || !isNumber(match[1]) || !isNumber(match[2])) throw Error('Expected WKT POINT (longitude latitude).');
                coordinates = [Number(match[1]), Number(match[2])];
            } else if (config.geometryMode === 'geojson') {
                if (geometry < 0) throw Error('Choose a geometry column.');
                const point = JSON.parse(row[geometry]);
                if (point?.type !== 'Point' || !Array.isArray(point.coordinates) || point.coordinates.length < 2 || point.coordinates.slice(0, 2).some((v: unknown) => typeof v !== 'number')) throw Error('Expected a GeoJSON Point geometry.');
                coordinates = point.coordinates;
            } else throw Error('Choose a CSV geometry format.');
            mercator(coordinates[0], coordinates[1]);
        } catch (e) { errors.push({ column: -1, message: (e as Error).message }); }
        return { values, coordinates, errors };
    };
    return { fields, inferred, missing, policy, read };
}
export function previewCSV(config: Config, parsed = parseCSV(config.csvText, config.delimiter, true), progress?: CSVProgress): CSVPreview {
    const reader = csvReader(config, parsed, progress), { headers, rows } = parsed;
    const missing = headers.map(() => 0), failed = headers.map(() => 0);
    let accepted = 0, rejected = 0;
    const sampleIndices = new Set<number>();
    for (let i = 0; i < Math.min(6, rows.length); i++) sampleIndices.add(Math.round(i * (rows.length - 1) / Math.max(1, Math.min(6, rows.length) - 1)));
    const samples: CSVPreview['samples'] = [], parts: BlobPart[] = ['record,column,raw_value,error,raw_record\r\n'];
    let lines: string[] = [], invalidSamples = 0;
    for (let i = 0; i < rows.length; i++) {
        if (i % 10000 === 0) progress?.('Validating records', i, rows.length);
        const row = rows[i], { values, errors } = reader.read(row);
        headers.forEach((_, j) => { if (j < row.length && reader.missing.has(row[j].trim())) missing[j]++; });
        if (errors.length) {
            rejected++;
            if (invalidSamples++ < 3) sampleIndices.add(i);
            for (const error of errors) {
                if (error.column >= 0) failed[error.column]++;
                lines.push([parsed.recordNumbers?.[i] ?? i + 2, error.column < 0 ? '(record/geometry)' : headers[error.column], error.column < 0 ? '' : row[error.column], error.message, JSON.stringify(row)].map(cell).join(',') + '\r\n');
            }
        } else accepted++;
        if (sampleIndices.has(i)) samples.push({ row: parsed.recordNumbers?.[i] ?? i + 2, raw: row, values, errors: errors.map(e => e.message) });
        if (lines.length >= 1000) { parts.push(lines.join('')); lines = []; }
    }
    parts.push(lines.join(''));
    return { fields: reader.fields, inferred: reader.inferred, missing, failed, total: rows.length, accepted, rejected, samples, diagnostics: new Blob(parts, { type: 'text/csv;charset=utf-8' }) };
}
export function csvDataset(config: Config, bounds: QueryBounds = {}, progress?: CSVProgress) {
    const parsed = parseCSV(config.csvText, config.delimiter, true, progress), { rows } = parsed;
    const { fields, policy, read } = csvReader(config, parsed, progress);
    if (bounds.time && !config.timeField) throw Error('Choose a CSV time attribute, or select All time.');
    const features: Feature[] = [];
    let accepted = 0, rejected = 0;
    for (let i = 0; i < rows.length; i++) {
        if (i % 10000 === 0) progress?.('Validating records', i, rows.length);
        const { values, coordinates, errors } = read(rows[i]);
        if (errors.length) {
            if (policy === 'reject') throw Error(`CSV row ${parsed.recordNumbers?.[i] ?? i + 2}: ${errors.map(e => e.message).join(' ')}`);
            rejected++; continue;
        }
        accepted++;
        const properties = Object.fromEntries(fields.map((f, j) => [f.name, values[j]]));
        if (bounds.time) {
            const t = parseUTC(String(properties[config.timeField]));
            if (!Number.isFinite(t) || t < parseUTC(bounds.time.start) || t > parseUTC(bounds.time.end)) continue;
        }
        if (bounds.bbox) {
            const b = bounds.bbox, [x, y] = coordinates;
            if (x < b.west || x > b.east || y < b.south || y > b.north) continue;
        }
        features.push({ id: `csv.${parsed.recordNumbers?.[i] ?? i + 2}`, geometry: { type: 'Point', coordinates }, properties });
    }
    return { fields, features, accepted, rejected };
}
