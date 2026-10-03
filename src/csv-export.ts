import type { Store } from './store.ts';

function cell(value: unknown): string {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Work directly from column chunks, retaining full coordinate precision and
// avoiding a per-row scan through Store.get's chunk list for large datasets.
export async function exportCSV(store: Store, indices: Uint32Array | null, cancelled = () => false): Promise<Blob> {
    if (cancelled()) throw Error('CSV export cancelled.');
    const names = new Set(store.fields.map(f => f.name));
    const unique = (name: string) => {
        let result = name, suffix = 2;
        while (names.has(result)) result = `${name}_${suffix++}`;
        names.add(result);
        return result;
    };
    const headers = ['featureId', 'longitude', 'latitude'].map(unique).concat(store.fields.map(f => f.name));
    const parts: BlobPart[] = [headers.map(cell).join(',') + '\r\n'];
    let lines: string[] = [], selected = 0, rows = 0;
    chunks: for (const chunk of store.chunks) {
        for (let i = 0; i < chunk.length; i++) {
            if (indices && selected === indices.length) break chunks;
            const index = chunk.offset + i;
            if (indices && indices[selected] !== index) continue;
            selected++;
            const values: unknown[] = [chunk.ids[i], chunk.lon[i], chunk.lat[i]];
            store.columns.forEach((column, j) => {
                const value = chunk.values[j][i], kind = column.field.kind;
                values.push(kind === 'string' ? (value < 0 ? null : column.dictionary[value]) : Number.isNaN(value) ? null : kind === 'date' ? new Date(value).toISOString() : kind === 'boolean' ? Boolean(value) : value);
            });
            lines.push(values.map(cell).join(',') + '\r\n');
            if (++rows % 10000 === 0) {
                parts.push(lines.join('')); lines = [];
                await new Promise(resolve => setTimeout(resolve, 0));
                if (cancelled()) throw Error('CSV export cancelled.');
            }
        }
    }
    if (cancelled()) throw Error('CSV export cancelled.');
    parts.push(lines.join(''));
    return new Blob(parts, { type: 'text/csv;charset=utf-8' });
}

export function csvExportFilename(name: string): string {
    return (name.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 100) || 'data-source') + '-filtered.csv';
}
