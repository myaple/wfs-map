import { yieldEvents } from './analysis.ts';
import type { Field } from './data.ts';
import { defaultConfig, type Config } from './source-settings.ts';
import { Store } from './store.ts';
import { timeField as resolveTimeField } from './timeline-data.ts';

export type JoinOptions = { leftField: string; rightField: string; mode: 'inner' | 'left'; scope: 'loaded' | 'applied'; maxRows: number; leftColumns?: string[]; rightColumns?: string[]; leftId?: boolean; rightId?: boolean; rightCoordinates?: boolean };
export type JoinSnapshot = Pick<Store, 'fields' | 'columns' | 'chunks' | 'length'> & { indices: Uint32Array | null };
export type JoinReport = { leftRows: number; rightRows: number; matchedLeft: number; unmatchedLeft: number; missingLeft: number; missingRight: number; duplicateRightKeys: number; outputRows: number };
export type JoinResult = { report: JoinReport; fields: Field[]; sample: unknown[][]; config: Config; blob?: Blob };
const maxBytes = 512 * 1024 * 1024;

// Snapshots travel directly between workers. No source arrays are detached and
// no record objects or large CSV strings pass through the UI thread.
export function joinSnapshot(store: Store, indices: Uint32Array | null): JoinSnapshot {
    return { fields: store.fields, columns: store.columns, chunks: store.chunks, length: store.length, indices };
}
function keyReader(store: Store, name: string) {
    const column = store.columns.findIndex(c => c.field.name === name);
    if (column < 0) throw Error(`Join field "${name}" is no longer available. Reload and choose a field again.`);
    const c = store.columns[column];
    return (index: number): string | number | null => {
        let lo = 0, hi = store.chunks.length - 1;
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (store.chunks[mid].offset <= index) lo = mid; else hi = mid - 1; }
        const chunk = store.chunks[lo], v = chunk.values[column][index - chunk.offset];
        if (c.field.kind === 'string') { const text = v < 0 ? null : c.dictionary[v]; return text?.trim() ? text : null; }
        return Number.isFinite(v) ? v : null;
    };
}
function selectedFields(store: Store, selected?: string[]) {
    if (selected === undefined) return store.fields;
    if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(name => !store.fields.some(f => f.name === name))) throw Error('An included column is no longer available. Preview the join again.');
    return store.fields.filter(f => selected.includes(f.name));
}
function outputSchema(leftFields: Field[], rightFields: Field[], timeField: string, options: JoinOptions) {
    const fields: Field[] = [...leftFields.map(f => ({ ...f, name: `left.${f.name}` })), ...rightFields.map(f => ({ ...f, name: `right.${f.name}` }))];
    const used = new Set(fields.map(f => f.name));
    const identity = (prefix: string, name: string, kind: Field['kind']) => {
        let output = `${prefix}.${name}`, suffix = 2;
        while (used.has(output)) output = `${prefix}.${name}_${suffix++}`;
        used.add(output); fields.push({ name: output, kind }); return output;
    };
    if (options.leftId !== false) identity('left', '@id', 'string');
    if (options.rightId !== false) identity('right', '@id', 'string');
    const lon = identity('left', '@longitude', 'number'), lat = identity('left', '@latitude', 'number');
    if (options.rightCoordinates !== false) { identity('right', '@longitude', 'number'); identity('right', '@latitude', 'number'); }
    const config: Config = { ...defaultConfig, type: 'csv', geometryMode: 'xy', longitudeField: lon, latitudeField: lat,
        timeField: leftFields.some(f => f.name === timeField && f.kind === 'date') ? `left.${timeField}` : '',
        fieldTypes: JSON.stringify(Object.fromEntries(fields.map(f => [f.name, f.kind]))) };
    return { fields, config };
}
const cell = (value: unknown) => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export async function joinDatasets(leftInput: JoinSnapshot, rightInput: JoinSnapshot, options: JoinOptions, timeField = '', save = false,
    cancelled = () => false, progress: (message: string) => void = () => {}): Promise<JoinResult> {
    if (!['inner', 'left'].includes(options.mode) || !['loaded', 'applied'].includes(options.scope)) throw Error('Choose a valid join type and input rows.');
    if (!Number.isSafeInteger(options.maxRows) || options.maxRows < 1 || options.maxRows > 50000000) throw Error('Maximum output rows must be a whole number from 1 to 50,000,000.');
    const left = Object.assign(new Store(leftInput.fields), leftInput), right = Object.assign(new Store(rightInput.fields), rightInput);
    const leftKind = left.fields.find(f => f.name === options.leftField)?.kind, rightKind = right.fields.find(f => f.name === options.rightField)?.kind;
    if (!leftKind || !rightKind) throw Error('Choose a match field for both datasets.');
    if (leftKind !== rightKind) throw Error('Match fields must have the same type. Configure CSV column types in Data sources if needed.');
    const leftKey = keyReader(left, options.leftField), rightKey = keyReader(right, options.rightField);
    const li = options.scope === 'applied' ? leftInput.indices : null, ri = options.scope === 'applied' ? rightInput.indices : null;
    const report: JoinReport = { leftRows: li?.length ?? left.length, rightRows: ri?.length ?? right.length, matchedLeft: 0, unmatchedLeft: 0, missingLeft: 0, missingRight: 0, duplicateRightKeys: 0, outputRows: 0 };
    const check = () => { if (cancelled()) throw Error('Join cancelled.'); };
    const pause = async () => { await yieldEvents(); check(); };
    check();
    const index = new Map<string | number, number | number[]>();
    for (let k = 0; k < report.rightRows; k++) {
        const row = ri ? ri[k] : k, key = rightKey(row);
        if (key === null) report.missingRight++;
        else {
            const previous = index.get(key);
            if (previous === undefined) index.set(key, row);
            else if (typeof previous === 'number') { index.set(key, [previous, row]); report.duplicateRightKeys++; }
            else previous.push(row);
        }
        if (k % 16384 === 0) { progress(`Indexing right dataset · ${k.toLocaleString()} / ${report.rightRows.toLocaleString()} rows`); await pause(); }
    }
    const leftFields = selectedFields(left, options.leftColumns), rightFields = selectedFields(right, options.rightColumns);
    const { fields, config } = outputSchema(leftFields, rightFields, resolveTimeField(left.fields, timeField), options), sample: unknown[][] = [];
    const rowValues = (a: number, b: number | null) => {
        const l = left.get(a), r = b === null ? null : right.get(b);
        return [...leftFields.map(f => l.properties[f.name]), ...rightFields.map(f => r?.properties[f.name] ?? null),
            ...(options.leftId === false ? [] : [l.id]), ...(options.rightId === false ? [] : [r?.id ?? null]),
            ...l.coordinates, ...(options.rightCoordinates === false ? [] : r?.coordinates ?? [null, null])];
    };
    // Count multiplicities before allocating output: a repeated key must never
    // silently choose one match or build an unbounded Cartesian product.
    for (let k = 0; k < report.leftRows; k++) {
        const row = li ? li[k] : k, key = leftKey(row), matches = key === null ? undefined : index.get(key);
        if (key === null) report.missingLeft++;
        if (matches === undefined) { report.unmatchedLeft++; if (options.mode === 'left') report.outputRows++; }
        else { report.matchedLeft++; report.outputRows += typeof matches === 'number' ? 1 : matches.length; }
        if (sample.length < 8) {
            if (matches !== undefined) for (const match of (typeof matches === 'number' ? [matches] : matches).slice(0, 8 - sample.length)) sample.push(rowValues(row, match));
            else if (options.mode === 'left') sample.push(rowValues(row, null));
        }
        if (k % 16384 === 0) { progress(`Counting joined rows · ${k.toLocaleString()} / ${report.leftRows.toLocaleString()} left rows`); await pause(); }
    }
    check();
    if (!save) return { report, fields, sample, config };
    if (!report.outputRows) throw Error('The join produced no rows. Choose different fields or use a left join.');
    if (report.outputRows > options.maxRows) throw Error(`Join would create ${report.outputRows.toLocaleString()} rows, above the ${options.maxRows.toLocaleString()} row limit. Review duplicate keys or increase Maximum output rows.`);
    const parts: BlobPart[] = [fields.map(f => cell(f.name)).join(',') + '\r\n'];
    let lines: string[] = [], count = 0, bytes = 0;
    const flush = () => {
        const part = new Blob([lines.join('')]); bytes += part.size;
        if (bytes > maxBytes) throw Error('Joined CSV exceeds the 512 MiB limit. Filter the input rows or split the join into smaller datasets.');
        parts.push(part); lines = [];
    };
    for (let k = 0; k < report.leftRows; k++) {
        const row = li ? li[k] : k, key = leftKey(row), matches = key === null ? undefined : index.get(key);
        const rows = matches === undefined ? options.mode === 'left' ? [null] : [] : typeof matches === 'number' ? [matches] : matches;
        for (const match of rows) {
            lines.push(rowValues(row, match).map(cell).join(',') + '\r\n');
            if (++count % 10000 === 0) { flush(); progress(`Writing joined CSV · ${count.toLocaleString()} / ${report.outputRows.toLocaleString()} rows`); await pause(); }
        }
        if (k % 16384 === 0) await pause();
    }
    flush(); check();
    return { report, fields, sample, config, blob: new Blob(parts, { type: 'text/csv;charset=utf-8' }) };
}
