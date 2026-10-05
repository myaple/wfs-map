import { parseUTC, utcISO } from './time.ts';
import { mercator, type Feature, type Field } from './data.ts';
import type { Config } from './source-settings.ts';
import { validateTime, type QueryBounds } from './wfs-query.ts';

export type CSVIssue = { reason: string; count: number; lines: number[] };
export type CSVReport = { total: number; imported: number; rejected: number; filtered: number; issues: CSVIssue[] };
function addIssue(issues: CSVIssue[], reason: string, line: number) {
    let issue = issues.find(i => i.reason === reason);
    if (!issue) { issue = { reason, count: 0, lines: [] }; issues.push(issue); }
    issue.count++;
    if (issue.lines.length < 5) issue.lines.push(line);
}
export function csvImportSummary(report: CSVReport): string {
    const n = (value: number) => value.toLocaleString('en-GB');
    return `CSV: ${n(report.imported)} of ${n(report.total)} data rows imported; ${n(report.rejected)} rows not processed because of errors; ${n(report.filtered)} rows excluded by time/map bounds.`
        + report.issues.map(i => `\n${n(i.count)} row(s): ${i.reason} (CSV line${i.lines.length === 1 ? '' : 's'} ${i.lines.join(', ')}${i.count > i.lines.length ? ', …' : ''}).`).join('');
}

// RFC 4180 records with physical source lines, including multiline quoted cells.
// Row errors are recoverable; a broken header or unterminated quote is fatal.
export function parseCSV(text: string, delimiter = ',') {
    if (typeof text !== 'string' || !text.trim()) throw Error('CSV file is empty or unavailable. Choose a readable CSV file.');
    if (![',', ';', '\t'].includes(delimiter)) throw Error('Choose comma, semicolon or tab as the delimiter.');
    const rows: string[][] = [], rowLines: number[] = [], issues: CSVIssue[] = [];
    let headers: string[] | undefined, totalRows = 0;
    let row: string[] = [], value = '', quoted = false, closed = false, problem = '';
    let line = 1, recordLine = 1, touched = false;
    const field = () => { row.push(value); value = ''; closed = false; };
    const record = () => {
        field();
        if (touched) {
            if (!headers) {
                if (problem) throw Error(`CSV header at line ${recordLine}: ${problem}`);
                headers = row.map(v => v.trim());
                if (headers.some(v => !v) || new Set(headers).size !== headers.length) throw Error('CSV needs unique, non-empty column headers.');
            } else {
                totalRows++;
                const reason = problem || (row.length !== headers.length ? `Expected ${headers.length} columns; found ${row.length}` : '');
                if (reason) addIssue(issues, reason, recordLine);
                else { rows.push(row); rowLines.push(recordLine); }
            }
        }
        row = []; touched = false; problem = '';
    };
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
            else if (c === '"') { quoted = false; closed = true; }
            else { value += c; if (c === '\n' || c === '\r' && text[i + 1] !== '\n') line++; }
        } else if (c === delimiter) { touched = true; field(); }
        else if (c === '\n' || c === '\r') {
            record(); if (c === '\r' && text[i + 1] === '\n') i++;
            line++; recordLine = line;
        } else if (c === '"' && !value && !closed) { quoted = true; touched = true; }
        else {
            if (closed || c === '"') problem = 'Malformed CSV quoting';
            value += c;
            if (c.trim()) touched = true;
        }
    }
    if (quoted) throw Error(`CSV import stopped: unterminated quoted field starting on CSV line ${recordLine}. No rows imported; ${totalRows} complete data rows and the unfinished record were not processed. Fix the quoting and retry.`);
    if (touched) record();
    if (!headers) throw Error('CSV needs unique, non-empty column headers.');
    return { headers, rows, rowLines, totalRows, issues };
}

export function csvDataset(config: Config, bounds?: QueryBounds | null) {
    if (!config) throw Error('CSV source settings are missing. Configure the source and retry.');
    bounds ??= {};
    if (bounds.time) validateTime(bounds.time);
    const { headers, rows, rowLines, totalRows, issues } = parseCSV(config.csvText, config.delimiter);
    const report: CSVReport = { total: totalRows, imported: 0, rejected: issues.reduce((n, i) => n + i.count, 0), filtered: 0, issues };
    const index = (name: string, purpose: string) => {
        if (!name) throw Error(`${totalRows} data rows not processed: choose a CSV ${purpose} column in Data sources.`);
        const i = headers.indexOf(name);
        if (i < 0) throw Error(`${totalRows} data rows not processed: CSV ${purpose} column "${name}" was not found. Check the column mapping in Data sources.`);
        return i;
    };
    const xy = config.geometryMode === 'xy';
    if (!['xy', 'wkt', 'geojson'].includes(config.geometryMode)) throw Error('Choose longitude/latitude, WKT Point or GeoJSON Point as the CSV geometry format.');
    const lon = xy ? index(config.longitudeField, 'longitude') : -1, lat = xy ? index(config.latitudeField, 'latitude') : -1;
    const geometry = xy ? -1 : index(config.geometryField, 'geometry');
    const time = config.timeField ? index(config.timeField, 'time') : -1;
    if (bounds.time && time < 0) throw Error('Choose a CSV time attribute, or select All time.');
    const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
    const fields: Field[] = headers.map((name, i) => {
        const values = rows.map(r => r[i] ?? '').filter(v => v.trim() !== '');
        const kind = i === time ? 'date' : values.length && values.every(v => numeric.test(v.trim()) && Number.isFinite(Number(v))) ? 'number' : values.length && values.every(v => /^(true|false)$/i.test(v.trim())) ? 'boolean' : 'string';
        return { name, kind };
    });
    const features: Feature[] = [];
    const start = bounds.time ? parseUTC(bounds.time.start) : NaN, end = bounds.time ? parseUTC(bounds.time.end) : NaN;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i], cell = (column: number) => row[column] ?? '';
        try {
            let coordinates: number[];
            if (xy) {
                if (!cell(lon).trim()) throw Error(`Missing longitude in "${headers[lon]}"`);
                if (!cell(lat).trim()) throw Error(`Missing latitude in "${headers[lat]}"`);
                if (!numeric.test(cell(lon).trim()) || !numeric.test(cell(lat).trim())) throw Error('Longitude and latitude must be decimal numbers');
                coordinates = [Number(cell(lon)), Number(cell(lat))];
            } else if (config.geometryMode === 'wkt') {
                const match = /^\s*POINT\s*\(\s*([^\s]+)\s+([^\s]+)\s*\)\s*$/i.exec(cell(geometry));
                if (!match || !numeric.test(match[1]) || !numeric.test(match[2])) throw Error(`Expected WKT POINT (longitude latitude) in "${headers[geometry]}"`);
                coordinates = [Number(match[1]), Number(match[2])];
            } else {
                let point: unknown;
                try { point = JSON.parse(cell(geometry)); } catch { throw Error(`Invalid GeoJSON JSON in "${headers[geometry]}"`); }
                const p = point as { type?: unknown; coordinates?: unknown } | null;
                if (!p || p.type !== 'Point' || !Array.isArray(p.coordinates) || p.coordinates.length < 2 || p.coordinates.slice(0, 2).some(v => typeof v !== 'number')) throw Error(`Expected a GeoJSON Point geometry in "${headers[geometry]}"`);
                coordinates = p.coordinates;
            }
            // Keep coordinate validation consistent with the map projection.
            mercator(coordinates[0], coordinates[1]);
            const properties = Object.fromEntries(fields.map((f, j) => {
                const v = cell(j);
                if (!v.trim()) return [f.name, null];
                if (f.kind === 'date') {
                    if (!Number.isFinite(parseUTC(v))) throw Error(`Invalid ISO 8601 time in "${f.name}"`);
                    return [f.name, utcISO(v)];
                }
                return [f.name, f.kind === 'number' ? Number(v) : f.kind === 'boolean' ? v.trim().toLowerCase() === 'true' : v];
            }));
            const t = time < 0 || properties[config.timeField] === null ? NaN : parseUTC(String(properties[config.timeField]));
            if (bounds.time && !Number.isFinite(t)) {
                report.rejected++; addIssue(issues, `Missing time in "${config.timeField}" required by the selected time bounds`, rowLines[i]); continue;
            }
            if (bounds.time && (t < start || t > end)) { report.filtered++; continue; }
            if (bounds.bbox) {
                const b = bounds.bbox, [x, y] = coordinates;
                if (x < b.west || x > b.east || y < b.south || y > b.north) { report.filtered++; continue; }
            }
            features.push({ id: `csv.${rowLines[i]}`, geometry: { type: 'Point', coordinates }, properties });
        } catch (e) {
            report.rejected++;
            addIssue(issues, e instanceof Error ? e.message : 'Invalid CSV row', rowLines[i]);
        }
    }
    report.imported = features.length;
    if (report.total && report.rejected === report.total) throw Error(csvImportSummary(report));
    return { fields, features, report };
}
