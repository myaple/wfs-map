import { readCSVBlob } from './source-storage.ts';
import { ingestCSV, csvImportSummary } from './csv.ts';
import type { Config as SourceConfig } from './source-settings.ts';
import type { QueryBounds } from './wfs-query.ts';
import { Analyzer, all } from './analysis.ts';
import { timeField } from './timeline-data.ts';
import { decodePage, countFrom, inferFields, packPositions, latitudeClampWarning, spatialPage, wfsURL, type Field, type Rule } from './data.ts';
import { Store } from './store.ts';
import { RecordsIndex, recordsCSV } from './records.ts';
import { exportCSV } from './csv-export.ts';
type Config = {
    url: string;
    version: string;
    typeName: string;
    format: string;
    srs: string;
    axis: 'xy' | 'yx';
    pageSize: number;
    limit: number;
    sort: string;
    fields: Field[];
    filter?: string;
    timeField?: string;
};
const ctx = self as unknown as DedicatedWorkerGlobalScope;
let store: Store | undefined, revision = 0, colorRevision = 0, analyzer: Analyzer | undefined;
const chartRevisions = new Map<string, number>();
let applied: Uint32Array | null = null, records: RecordsIndex | undefined, recordsRevision = 0;
function post(message: unknown, transfers: Transferable[] = []) { ctx.postMessage(message, transfers); }
async function fetchText(url: string) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
    try {
        const r = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
        if (!r.ok)
            throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
        return await r.text();
    }
    finally {
        clearTimeout(timer);
    }
}
async function load(c: Config) {
    if (!Number.isSafeInteger(c.limit) || c.limit < 1 || c.limit > 50000000 || !Number.isSafeInteger(c.pageSize) || c.pageSize < 1 || c.pageSize > 100000)
        throw new Error('Invalid point limit or page size');
    const start = performance.now(), typeParam = c.version === '2.0.0' ? 'typeNames' : 'typeName', countParam = c.version === '2.0.0' ? 'count' : 'maxFeatures';
    const common: Record<string, string> = { [typeParam]: c.typeName, srsName: c.srs };
    if (c.filter) common.filter = c.filter;
    if (c.sort)
        common.sortBy = c.sort + ' A';
    let total: number | undefined, warning = '';
    // resultType=hits was introduced in WFS 1.1. GeoServer's 1.0 response
    // reports zero rather than the dataset size, so it must not stop a load.
    if (c.version === '1.0.0') warning = 'WFS 1.0 has no standard hits count; loading until empty page or limit. ';
    else {
        try {
            total = countFrom(await fetchText(wfsURL(c.url, c.version, 'GetFeature', { ...common, resultType: 'hits' })));
        }
        catch {
            warning = 'GetFeature hits unavailable; loading until empty page or limit. ';
        }
    }
    post({ type: 'init', capacity: Math.min(total ?? c.limit, c.limit), total, warning });
    let loaded = 0, pages = 0, parseMs = 0, bytes = 0, previousSignature = '', clamped = 0;
    const getPage = (offset: number) => fetchText(wfsURL(c.url, c.version, 'GetFeature', { ...common, outputFormat: c.format, startIndex: String(offset), [countParam]: String(Math.min(c.pageSize, c.limit - offset)) }));
    // One bounded lookahead request overlaps server generation/transfer with column packing.
    // Wrap rejections immediately so a failing prefetched request is never unhandled.
    let pending: Promise<{
        text: string;
    } | {
        error: unknown;
    }> | undefined;
    const prefetch = (offset: number) => getPage(offset).then(text => ({ text }), error => ({ error }));
    while (loaded < c.limit && (total === undefined || loaded < total)) {
        const response = await (pending ?? prefetch(loaded));
        pending = undefined;
        if ('error' in response)
            throw response.error;
        const text = response.text;
        bytes += new TextEncoder().encode(text).byteLength;
        const pstart = performance.now(), page = decodePage(text, c.axis);
        if (!page.features.length) {
            if (total !== undefined && loaded < total)
                throw new Error(`Premature empty page at ${loaded}; server reported ${total}.`);
            break;
        }
        if (page.features.length > Math.min(c.pageSize, c.limit - loaded))
            throw new Error('Server ignored the requested page count');
        if (page.numberMatched !== undefined) {
            if (total !== undefined && total !== page.numberMatched)
                throw new Error('Feature count changed during loading; use a stable snapshot');
            total = page.numberMatched;
        }
        const signature = JSON.stringify([page.features[0], page.features.at(-1)]);
        if (pages > 0 && signature === previousSignature)
            throw new Error('Server repeated a page; startIndex is not supported');
        previousSignature = signature;
        const next = loaded + page.features.length;
        if (next < c.limit && (total === undefined || next < total))
            pending = prefetch(next);
        if (!store) {
            store = new Store(inferFields(page.features, c.fields));
            post({ type: 'fields', fields: store.fields });
        }
        const positions = packPositions(page.features, count => clamped += count);
        const spatial = spatialPage(positions, loaded);
        store.append(page.features);
        parseMs += performance.now() - pstart;
        post({ type: 'chunk', offset: loaded, positions, ...spatial }, [positions.buffer, spatial.indices.buffer, spatial.groups.buffer]);
        loaded += page.features.length;
        pages++;
        post({ type: 'progress', loaded, total, pages, bytes, parseMs, elapsedMs: performance.now() - start });
    }
    if (total !== undefined && loaded > total)
        throw new Error('Received more features than the reported count');
    if (!store) { store = new Store(c.fields); post({ type: 'fields', fields: store.fields }); }
    store.finish();
    if (store)
        analyzer = new Analyzer(store);
    post({ type: 'done', loaded, total, timeline: timelineExtent(c.timeField), bounds: store?.bounds, pages, bytes, parseMs, elapsedMs: performance.now() - start,
        truncated: total !== undefined ? loaded < total : loaded === c.limit, warning: [warning.trim(), loaded && store?.chunks.some(c => c.ids.some(x => x === null)) ? 'Some features have no IDs; duplicate detection is limited.' : '', latitudeClampWarning(clamped)].filter(Boolean).join(' ') });
}
async function loadCSV(config: SourceConfig, bounds: QueryBounds, fileUser?: string) {
    const start = performance.now();
    if (!config) throw Error('CSV source settings are missing.');
    const file = config.csvText ? new Blob([config.csvText]) : await readCSVBlob(config.csvRef, fileUser);
    let pages = 0, clamped = 0, loaded = 0, capacity = 0;
    const dataset = await ingestCSV(file, config, bounds, (fields, size) => {
        store = new Store(fields); capacity = size;
        post({ type: 'init', capacity, total: capacity });
        post({ type: 'fields', fields });
    }, features => {
        const offset = loaded;
        const positions = packPositions(features, count => clamped += count), spatial = spatialPage(positions, offset);
        store!.append(features); pages++; loaded += features.length;
        post({ type: 'chunk', offset, positions, ...spatial }, [positions.buffer, spatial.indices.buffer, spatial.groups.buffer]);
        post({ type: 'progress', loaded, total: capacity, pages, elapsedMs: performance.now() - start });
    }, (phase, bytes, rows) => { if (phase === 'scan') post({ type: 'csvScan', bytes, fileBytes: file.size, rows }); });
    store!.finish(); analyzer = new Analyzer(store!);
    post({ type: 'done', loaded, total: loaded, timeline: timelineExtent(config.timeField), bounds: store!.bounds, pages, bytes: file.size, parseMs: performance.now() - start, elapsedMs: performance.now() - start, truncated: false, csvReport: dataset.report, warning: [csvImportSummary(dataset.report), latitudeClampWarning(clamped)].filter(Boolean).join('\n') });
}
function timelineExtent(configured?: string) {
    if (!store || !analyzer) return;
    const field = timeField(store.fields, configured);
    if (field && ['date', 'string'].includes(store.fields.find(f => f.name === field)!.kind)) return analyzer.timeline(field).extent;
}
ctx.onmessage = (event: MessageEvent) => {
    const m = event.data;
    if (['records', 'recordAt', 'recordsExport'].includes(m.type) && store) {
        const r = m.type === 'recordAt' ? recordsRevision : ++recordsRevision, dataRevision = revision, localStore = store;
        const cancelled = () => m.type === 'recordAt' ? dataRevision !== revision : r !== recordsRevision;
        records ??= new RecordsIndex(store);
        void records.query(applied, m.query, cancelled).then(async rows => {
            if (cancelled()) return;
            if (m.type === 'records') post({ type: 'records', request: m.request, total: rows.length, offset: Math.min(m.offset, Math.max(0, rows.length - 1)), rows: Array.from(rows.subarray(Math.min(m.offset, Math.max(0, rows.length - 1)), Math.min(m.offset, Math.max(0, rows.length - 1)) + Math.min(100, m.limit)), index => ({ index, data: localStore.get(index) })) });
            if (m.type === 'recordAt') { const index = rows[m.position]; post({ type: 'recordAt', request: m.request, row: index === undefined ? null : { index, data: localStore.get(index) } }); }
            if (m.type === 'recordsExport') { const blob = await recordsCSV(localStore, rows, m.columns, m.sourceName, () => r !== recordsRevision); if (r === recordsRevision) post({ type: 'recordsExported', request: m.request, blob, total: rows.length }); }
        }).catch(e => { if (!cancelled()) post({ type: 'recordsError', request: m.request, message: (e as Error).message }); });
    }
    if (m.type === 'inspectExpression' && store) {
        const r = revision;
        void new Analyzer(store).run(m.expression, []).then(result => {
            if (r !== revision) return;
            const rows = result.indices ?? Uint32Array.from({ length: store!.length }, (_, i) => i);
            const allowed = applied ? new Set(applied) : undefined;
            post({ type: 'inspectionMatches', token: m.token, indices: allowed ? rows.filter(i => allowed.has(i)) : rows });
        }).catch(e => post({ type: 'inspectionError', token: m.token, message: (e as Error).message }));
    }
    if (m.type === 'getMany' && store) post({ type: 'metadataMany', token: m.token, rows: m.indices.slice(0, 40).map((index: number) => ({ index, data: store!.get(index) })) });
    if (m.type === 'exportCSV') {
        const r = revision;
        if (!store) {
            post({ type: 'csvExportError', request: m.request, message: 'No loaded dataset' });
            return;
        }
        void exportCSV(store, m.indices, () => r !== revision).then(blob => {
            if (r === revision) post({ type: 'csvExported', request: m.request, blob });
        }).catch(e => post({ type: 'csvExportError', request: m.request, message: (e as Error).message }));
    }
    if (m.type === 'loadCSV')
        void loadCSV(m.config, m.bounds, m.fileUser).catch(e => post({ type: 'error', message: (e as Error).message }));
    if (m.type === 'load')
        void load(m.config).catch(e => post({ type: 'error', message: (e as Error).message }));
    if (m.type === 'get') {
        try {
            post({ type: 'metadata', request: m.request, index: m.index, token: m.token, data: store?.get(m.index) });
        }
        catch (e) {
            post({ type: 'error', message: (e as Error).message });
        }
    }
    if (m.type === 'colors' && store) {
        const r = ++colorRevision;
        analyzer ??= new Analyzer(store);
        void analyzer.colors(m.field, m.bins, () => r !== colorRevision, m.categories).then(result => { if (r === colorRevision)
            post({ type: 'colored', request: m.request, ...result }, [result.codes.buffer]); }).catch(e => { if (r === colorRevision)
            post({ type: 'colorError', request: m.request, message: (e as Error).message }); });
    }
    if ((m.type === 'chartDomain' || m.type === 'chartSeries') && store) {
        analyzer ??= new Analyzer(store);
        if (m.type === 'chartSeries') chartRevisions.set(m.spec.id, m.token);
        const task = m.type === 'chartDomain' ? analyzer.domain(m.field) : analyzer.run(m.expression, [m.spec], () => chartRevisions.get(m.spec.id) !== m.token, m.domains, m.timeline).then(r => r.charts[0]);
        void task.then(result => {
            const transfers: Transferable[] = [];
            if ('counts' in result) {
                transfers.push(result.counts.buffer);
                if (result.values) transfers.push(result.values.buffer);
                if (result.raw) transfers.push(result.raw.positions.buffer, result.raw.rows.buffer, result.raw.bounds.buffer);
                if (result.x.ranges) transfers.push(result.x.ranges.buffer);
                if (result.y?.ranges) transfers.push(result.y.ranges.buffer);
            }
            post({ type: 'chartReply', token: m.token, result }, transfers);
        }).catch(e => post({ type: 'chartReply', token: m.token, error: (e as Error).message }));
    }
    if (m.type === 'filter' || m.type === 'analyze') {
        const r = ++revision, start = performance.now();
        if (!store) {
            post({ type: 'error', message: 'No loaded dataset' });
            return;
        }
        analyzer ??= new Analyzer(store);
        void analyzer.run(m.expression ?? all(m.rules ?? []), m.charts ?? [], () => r !== revision, undefined, m.timeline).then(result => {
            if (r !== revision)
                return;
            const transfers: Transferable[] = result.indices ? [result.indices.buffer] : [];
            for (const chart of result.charts) {
                transfers.push(chart.counts.buffer);
                if (chart.values)
                    transfers.push(chart.values.buffer);
                if (chart.raw)
                    transfers.push(chart.raw.positions.buffer, chart.raw.rows.buffer, chart.raw.bounds.buffer);
                if (chart.x.ranges)
                    transfers.push(chart.x.ranges.buffer);
                if (chart.y?.ranges)
                    transfers.push(chart.y.ranges.buffer);
            }
            applied = result.indices?.slice() ?? null; records?.reset(); recordsRevision++;
            post({ type: 'filtered', request: m.request, ...result, elapsedMs: performance.now() - start }, transfers);
        }).catch(e => {
            if (r === revision)
                post({ type: 'filterError', request: m.request, message: (e as Error).message });
        });
    }
};
