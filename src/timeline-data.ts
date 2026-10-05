import { parseUTC } from './time.ts';
import type { Store } from './store.ts';

export type TimeWindow = { start: number; end: number };
export type TimelineExtent = TimeWindow & { field: string; valid: number; missing: number };
export type TimelineSelection = TimeWindow & { field: string };

/** Reuse packed dates; decode text dates once, never during scrubbing. */
export class TimelineIndex {
    readonly values: Float64Array[] = [];
    readonly extent: TimelineExtent;
    constructor(store: Store, field: string) {
        const column = store.fields.findIndex(f => f.name === field);
        if (column < 0 || !['date', 'string'].includes(store.fields[column].kind)) throw Error('Choose a date/time attribute for the timeline.');
        const c = store.columns[column], dictionary = c.field.kind === 'string' ? c.dictionary.map(parseUTC) : undefined;
        let start = Infinity, end = -Infinity, valid = 0;
        for (const chunk of store.chunks) {
            const packed = chunk.values[column];
            const values = dictionary ? Float64Array.from(packed, code => code < 0 ? NaN : dictionary[code]) : packed as Float64Array;
            this.values.push(values);
            for (const stamp of values) if (Number.isFinite(stamp)) { start = Math.min(start, stamp); end = Math.max(end, stamp); valid++; }
        }
        this.extent = { field, start, end, valid, missing: store.length - valid };
    }
}

export function timeField(fields: Store['fields'], configured = ''): string {
    if (configured) return fields.find(f => f.name === configured)?.name ?? fields.find(f => f.name === configured.split(':').at(-1))?.name ?? '';
    const dates = fields.filter(f => f.kind === 'date');
    return dates.length === 1 ? dates[0].name : '';
}

export function moveWindow(window: TimeWindow, extent: TimeWindow, delta: number): TimeWindow {
    const shift = Math.max(extent.start - window.start, Math.min(extent.end - window.end, delta));
    return { start: window.start + shift, end: window.end + shift };
}

export function resizeWindow(window: TimeWindow, extent: TimeWindow, edge: 'start' | 'end', stamp: number): TimeWindow {
    return edge === 'start' ? { start: Math.max(extent.start, Math.min(window.end, stamp)), end: window.end }
        : { start: window.start, end: Math.min(extent.end, Math.max(window.start, stamp)) };
}
