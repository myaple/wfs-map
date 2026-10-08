import type { ChartResult, Expression } from './analysis.ts';
export const HIGHLIGHT_COLOR = '#ff8c00';
export type HighlightRequest = { sourceId: string } & ({ expression: Expression } | { chart: ChartResult; cells: number[] });
// Transient row identities, scoped by source. Never part of saved filters/state.
export const highlightedRows = new Map<string, Uint32Array>();
const listeners = new Set<() => void>();
let generation = 0;
let backend: {
    select: (request: HighlightRequest) => Promise<Uint32Array>;
    counts: (sourceId: string, chart: ChartResult, rows: Uint32Array) => Promise<Uint32Array>;
};
export function configureHighlights(value: typeof backend) { backend = value; }
export function onHighlights(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function notify() { for (const listener of listeners) listener(); }
export function replaceHighlights(rows = new Map<string, Uint32Array>()) {
    generation++;
    highlightedRows.clear();
    for (const [id, indices] of rows) if (indices.length) highlightedRows.set(id, indices);
    notify();
}
export function forgetHighlights(sourceId: string) {
    generation++; // Invalidates any pending brush against a reloaded source.
    if (highlightedRows.delete(sourceId)) notify();
}
export async function selectHighlights(requests: HighlightRequest[]) {
    replaceHighlights();
    const token = generation;
    try {
        const results = await Promise.all(requests.map(async r => [r.sourceId, await backend.select(r)] as const));
        if (token === generation) replaceHighlights(new Map(results));
    } catch (error) {
        if (token === generation) console.error('Highlight selection failed', error);
    }
}
export function highlightCounts(sourceId: string, chart: ChartResult) {
    const rows = highlightedRows.get(sourceId);
    return rows?.length ? backend.counts(sourceId, chart, rows) : Promise.resolve(new Uint32Array(chart.counts.length));
}
