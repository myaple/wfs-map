import { yieldEvents } from './analysis.ts';
import type { Store } from './store.ts';
import { formatUTC } from './time.ts';
export type RecordData = ReturnType<Store['get']>;
export type RecordRef = { sourceId: string; index: number };
export type RecordRow = { index: number; data: RecordData };
// Reserved column keys cannot collide with user attribute names.
export const identityColumns = ['@source', '@id', '@longitude', '@latitude'];
export function recordValue(data: RecordData, key: string, source = ''): unknown {
    if (key === '@source') return source;
    if (key === '@id') return data.id;
    if (key === '@longitude') return data.coordinates[0];
    if (key === '@latitude') return data.coordinates[1];
    return data.properties[key];
}
export function recordText(value: unknown, kind?: string): string {
    return value == null ? 'null' : kind === 'date' ? formatUTC(String(value)) : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export type RecordsQuery = { search: string; sort: string; descending: boolean };
export class RecordsIndex {
    private cache?: { key: string; rows: Uint32Array };
    private store: Store;
    constructor(store: Store) { this.store = store; }
    reset() { this.cache = undefined; }
    async query(applied: Uint32Array | null, query: RecordsQuery, cancelled = () => false): Promise<Uint32Array> {
        const key = JSON.stringify(query);
        if (this.cache?.key === key) return this.cache.rows;
        const search = query.search.trim().toLocaleLowerCase(), rows: number[] = [];
        for (let k = 0, n = applied?.length ?? this.store.length; k < n; k++) {
            const index = applied ? applied[k] : k;
            if (!search || Object.values(this.store.get(index)).flatMap(v => typeof v === 'object' && v !== null ? Object.values(v) : [v]).some(v => recordText(v).toLocaleLowerCase().includes(search))) rows.push(index);
            if (k % 32768 === 0) { await yieldEvents(); if (cancelled()) throw Error('Records query superseded'); }
        }
        const sort = query.sort;
        if (sort && sort !== '@source') {
            const kind = this.store.fields.find(f => f.name === sort)?.kind;
            const value = (i: number) => recordValue(this.store.get(i), sort);
            // Only one value per matching row; no cloned record objects for sorting.
            const values = new Map(rows.map(i => [i, value(i)]));
            rows.sort((a, b) => {
                let x = values.get(a), y = values.get(b);
                if (x == null || y == null) return x == null && y == null ? a - b : x == null ? 1 : -1;
                if (kind === 'date') { x = Date.parse(String(x)); y = Date.parse(String(y)); }
                const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
                return (query.descending ? -order : order) || a - b;
            });
        }
        if (cancelled()) throw Error('Records query superseded');
        const result = Uint32Array.from(rows); this.cache = { key, rows: result }; return result;
    }
}
export async function recordsCSV(store: Store, rows: Uint32Array, columns: string[], source: string, cancelled = () => false): Promise<Blob> {
    const cell = (value: unknown) => { const s = value == null ? '' : String(value); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
    const names = columns.map(key => key.startsWith('@') ? key.slice(1) : key);
    const parts: BlobPart[] = [names.map(cell).join(',') + '\r\n'];
    for (let k = 0; k < rows.length; k += 10000) {
        if (cancelled()) throw Error('Records export superseded');
        const lines: string[] = [];
        for (const index of rows.subarray(k, k + 10000)) { const data = store.get(index); lines.push(columns.map(c => cell(recordValue(data, c, source))).join(',') + '\r\n'); }
        parts.push(lines.join('')); await yieldEvents();
    }
    return new Blob(parts, { type: 'text/csv;charset=utf-8' });
}
