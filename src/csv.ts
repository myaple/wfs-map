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
type CSVRow = (row: string[], line: number, headers: string[]) => void;

/** Chunk boundaries may occur inside quotes, CRLF or UTF-8 characters. */
export class CSVParser {
    headers?: string[];
    totalRows = 0;
    validRows = 0;
    issues: CSVIssue[] = [];
    private row: string[] = [];
    private value = '';
    private quoted = false;
    private closed = false;
    private problem = '';
    private touched = false;
    private line = 1;
    private recordLine = 1;
    private previousCR = false;
    private first = true;
    private delimiter: string;
    private onRow: CSVRow;
    private headerOnly: boolean;
    constructor(delimiter = ',', onRow: CSVRow = () => {}, headerOnly = false) {
        this.delimiter = delimiter; this.onRow = onRow; this.headerOnly = headerOnly;
        if (![',', ';', '\t'].includes(delimiter)) throw Error('Choose comma, semicolon or tab as the delimiter.');
    }
    private field() { this.row.push(this.value); this.value = ''; this.closed = false; }
    private record() {
        this.field();
        if (this.touched) {
            if (!this.headers) {
                if (this.problem) throw Error(`CSV header at line ${this.recordLine}: ${this.problem}`);
                this.headers = this.row.map(v => v.trim());
                if (this.headers.some(v => !v) || new Set(this.headers).size !== this.headers.length) throw Error('CSV needs unique, non-empty column headers.');
            } else {
                this.totalRows++;
                const reason = this.problem || (this.row.length !== this.headers.length ? `Expected ${this.headers.length} columns; found ${this.row.length}` : '');
                if (reason) addIssue(this.issues, reason, this.recordLine);
                else { this.validRows++; this.onRow(this.row, this.recordLine, this.headers); }
            }
        }
        this.row = []; this.touched = false; this.problem = '';
    }
    feed(text: string) {
        for (const c of text) {
            if (this.first) { this.first = false; if (c === '\uFEFF') continue; }
            const crlf = c === '\n' && this.previousCR;
            if (this.quoted) {
                if (c === '"') { this.quoted = false; this.closed = true; }
                else this.value += c;
            } else if (c === '"' && this.closed) {
                this.value += '"'; this.quoted = true; this.closed = false;
            } else if (c === this.delimiter) { this.touched = true; this.field(); }
            else if (c === '\n' || c === '\r') {
                if (!crlf) this.record();
            } else if (c === '"' && !this.value && !this.closed) { this.quoted = true; this.touched = true; }
            else {
                if (this.closed || c === '"') this.problem = 'Malformed CSV quoting';
                this.value += c;
                if (c !== ' ' && c !== '\t') this.touched = true;
            }
            if (c === '\r' || c === '\n' && !crlf) this.line++;
            if (!this.quoted && (c === '\n' || c === '\r')) this.recordLine = this.line;
            this.previousCR = c === '\r';
            if (this.headerOnly && this.headers) return;
        }
    }
    finish() {
        if (this.quoted) throw Error(`CSV import stopped: unterminated quoted field starting on CSV line ${this.recordLine}. No rows imported; ${this.totalRows} complete data rows and the unfinished record were not processed. Fix the quoting and retry.`);
        if (this.touched && !(this.headerOnly && this.headers)) this.record();
        if (!this.headers) throw Error('CSV needs unique, non-empty column headers.');
        return { headers: this.headers, totalRows: this.totalRows, validRows: this.validRows, issues: this.issues };
    }
}

// Convenience API for exports, tests and small caller-owned strings.
export function parseCSV(text: string, delimiter = ',') {
    if (typeof text !== 'string' || !text.trim()) throw Error('CSV file is empty or unavailable. Choose a readable CSV file.');
    const rows: string[][] = [], rowLines: number[] = [];
    const parser = new CSVParser(delimiter, (row, line) => { rows.push(row); rowLines.push(line); });
    parser.feed(text);
    const { headers, totalRows, issues } = parser.finish();
    return { headers, rows, rowLines, totalRows, issues };
}
export async function csvHeaders(file: Blob, delimiter = ','): Promise<string[]> {
    const parser = new CSVParser(delimiter, undefined, true), decoder = new TextDecoder('utf-8', { fatal: true });
    for (let offset = 0; offset < file.size; offset += 65536) {
        parser.feed(decoder.decode(await file.slice(offset, offset + 65536).arrayBuffer(), { stream: true }));
        if (parser.headers) return parser.headers;
    }
    parser.feed(decoder.decode());
    return parser.finish().headers;
}
type ScanProgress = (bytes: number, rows: number) => void;
export async function streamCSV(file: Blob, delimiter: string, onRow: CSVRow, progress?: ScanProgress, chunkBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw Error('CSV chunk size must be a positive integer.');
    const parser = new CSVParser(delimiter, onRow), decoder = new TextDecoder('utf-8', { fatal: true });
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
        parser.feed(decoder.decode(await file.slice(offset, offset + chunkBytes).arrayBuffer(), { stream: true }));
        progress?.(Math.min(file.size, offset + chunkBytes), parser.totalRows);
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    parser.feed(decoder.decode());
    return parser.finish();
}
const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
type Inference = { present: boolean; number: boolean; boolean: boolean };
function inferRow(states: Inference[], row: string[]) {
    row.forEach((v, i) => {
        const text = v.trim(), state = states[i] ??= { present: false, number: true, boolean: true };
        if (!text) return;
        state.present = true;
        if (state.number && (!numeric.test(text) || !Number.isFinite(Number(text)))) state.number = false;
        if (state.boolean && !/^(true|false)$/i.test(text)) state.boolean = false;
    });
}
function inferredFields(headers: string[], states: Inference[], time: string): Field[] {
    return headers.map((name, i) => {
        const s = states[i];
        return { name, kind: name === time ? 'date' : s?.present && s.number ? 'number' : s?.present && s.boolean ? 'boolean' : 'string' };
    });
}
function rowDecoder(fields: Field[], config: Config, bounds: QueryBounds, totalRows: number) {
    const headers = fields.map(f => f.name);
    const index = (name: string, purpose: string) => {
        if (!name) throw Error(`${totalRows} data rows not processed: choose a CSV ${purpose} column in Data sources.`);
        const i = headers.indexOf(name);
        if (i < 0) throw Error(`${totalRows} data rows not processed: CSV ${purpose} column "${name}" was not found. Check the column mapping in Data sources.`);
        return i;
    };
    if (!['xy', 'wkt', 'geojson'].includes(config.geometryMode)) throw Error('Choose longitude/latitude, WKT Point or GeoJSON Point as the CSV geometry format.');
    const xy = config.geometryMode === 'xy', lon = xy ? index(config.longitudeField, 'longitude') : -1, lat = xy ? index(config.latitudeField, 'latitude') : -1;
    const geometry = xy ? -1 : index(config.geometryField, 'geometry'), time = config.timeField ? index(config.timeField, 'time') : -1;
    if (bounds.time) validateTime(bounds.time);
    if (bounds.time && time < 0) throw Error('Choose a CSV time attribute, or select All time.');
    const start = bounds.time ? parseUTC(bounds.time.start) : NaN, end = bounds.time ? parseUTC(bounds.time.end) : NaN;
    return (row: string[], line: number): Feature | null => {
        const cell = (column: number) => row[column] ?? '';
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
        mercator(coordinates[0], coordinates[1]);
        const properties: Record<string, unknown> = {};
        fields.forEach((f, j) => {
            const v = cell(j);
            if (!v.trim()) properties[f.name] = null;
            else if (f.kind === 'date') {
                if (!Number.isFinite(parseUTC(v))) throw Error(`Invalid ISO 8601 time in "${f.name}"`);
                properties[f.name] = utcISO(v);
            } else properties[f.name] = f.kind === 'number' ? Number(v) : f.kind === 'boolean' ? v.trim().toLowerCase() === 'true' : v;
        });
        if (bounds.time) {
            const t = properties[config.timeField] === null ? NaN : parseUTC(String(properties[config.timeField]));
            if (!Number.isFinite(t)) throw Error(`Missing time in "${config.timeField}" required by the selected time bounds`);
            if (t < start || t > end) return null;
        }
        if (bounds.bbox) {
            const b = bounds.bbox, [x, y] = coordinates;
            if (x < b.west || x > b.east || y < b.south || y > b.north) return null;
        }
        return { id: `csv.${line}`, geometry: { type: 'Point', coordinates }, properties };
    };
}
function reportFor(parsed: { totalRows: number; issues: CSVIssue[] }): CSVReport {
    return { total: parsed.totalRows, imported: 0, rejected: parsed.issues.reduce((n, i) => n + i.count, 0), filtered: 0, issues: parsed.issues };
}
function recordFeature(decode: ReturnType<typeof rowDecoder>, report: CSVReport, row: string[], line: number): Feature | undefined {
    try {
        const feature = decode(row, line);
        if (!feature) { report.filtered++; return; }
        report.imported++; return feature;
    } catch (e) {
        report.rejected++; addIssue(report.issues, e instanceof Error ? e.message : 'Invalid CSV row', line);
    }
}
function finishReport(report: CSVReport) { if (report.total && report.rejected === report.total) throw Error(csvImportSummary(report)); }
export function csvDataset(config: Config, bounds?: QueryBounds | null) {
    if (!config) throw Error('CSV source settings are missing. Configure the source and retry.');
    const parsed = parseCSV(config.csvText, config.delimiter), states: Inference[] = [];
    parsed.rows.forEach(row => inferRow(states, row));
    const fields = inferredFields(parsed.headers, states, config.timeField), report = reportFor(parsed);
    const decode = rowDecoder(fields, config, bounds ?? {}, report.total), features: Feature[] = [];
    parsed.rows.forEach((row, i) => { const feature = recordFeature(decode, report, row, parsed.rowLines[i]); if (feature) features.push(feature); });
    finishReport(report);
    return { fields, features, report };
}

/** Two bounded passes preserve whole-file types without retaining rows or features. */
export async function ingestCSV(file: Blob, config: Config, bounds: QueryBounds,
    ready: (fields: Field[], capacity: number) => void, batch: (features: Feature[]) => void,
    progress?: (phase: 'scan' | 'ingest', bytes: number, rows: number) => void) {
    const states: Inference[] = [];
    const scan = await streamCSV(file, config.delimiter, row => inferRow(states, row), (bytes, rows) => progress?.('scan', bytes, rows));
    const fields = inferredFields(scan.headers, states, config.timeField), report = reportFor(scan);
    const decode = rowDecoder(fields, config, bounds ?? {}, report.total);
    ready(fields, scan.validRows);
    let features: Feature[] = [];
    await streamCSV(file, config.delimiter, (row, line) => {
        const feature = recordFeature(decode, report, row, line);
        if (feature) features.push(feature);
        if (features.length === 25000) { batch(features); features = []; }
    }, (bytes, rows) => progress?.('ingest', bytes, rows));
    finishReport(report);
    if (features.length) batch(features);
    return { fields, report };
}
