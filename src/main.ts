import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { PointsLayer } from './points-layer.ts';
import { wfsURL, fieldKind, xmlDocument, type Field, type Rule } from './data.ts';
import { Workspace } from './workspace.ts';
import { all, type Expression } from './analysis.ts';
import { DataSources } from './data-sources.ts';
import { defaultConfig, readSettings, settingsKey, type Config, type Settings } from './source-settings.ts';
import { queryFilter, timeBounds, validateTime, type QueryBounds, type QueryFields } from './wfs-query.ts';
import './style.css';
maplibregl.setWorkerUrl(mapLibreWorkerUrl);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
const params = new URLSearchParams(location.search);
$('app').innerHTML = `
<header class="topbar"><div><h1>WFS analysis</h1><span class="hint">Explore every loaded point · double-click the map for metadata</span></div><nav><a href="#analysis" id="analysisLink">Analysis</a><a href="#configuration" id="configLink">Data sources</a></nav><button id="load" class="primary">Load enabled sources</button><button id="cancel" disabled>Cancel / clear</button></header>
<div class="load-strip"><progress id="progress" max="1" value="0"></progress><div id="status" role="status">Ready. Add a data source to get started.</div><div id="filterStatus" role="status"></div></div>
<section id="configuration" hidden></section>
<section id="analysis"><section class="query-panel" aria-labelledby="queryTitle"><div class="query-heading"><h2 id="queryTitle">Time &amp; map area</h2><span class="hint">Applies to all enabled sources · fetched from WFS</span></div><form id="timeForm" class="query-controls"><label for="timeWindow">Time window</label><select id="timeWindow"><option value="1">Last hour</option><option value="6">Last 6 hours</option><option value="24" selected>Last 24 hours</option><option value="168">Last 7 days</option><option value="custom">Custom range</option><option value="all">All time</option></select><div id="customTime" class="query-controls" hidden><label for="timeStart">Start (UTC)</label><input id="timeStart" type="datetime-local" step="1"><label for="timeEnd">End (UTC)</label><input id="timeEnd" type="datetime-local" step="1"></div><button id="applyTime" class="primary" type="submit">Refresh time window</button></form><p id="timeSummary" class="hint" role="status"></p><p id="timeError" class="error" role="alert" hidden></p><div class="query-area"><span id="areaSummary" class="hint">All map areas · right-drag a box on the map to bound requests.</span><button id="clearArea" hidden>Clear map area</button></div></section><div class="source-analysis"><label for="analysisSource">Analyze source</label><select id="analysisSource" aria-label="Analyze source"></select><label for="colorAttribute">Point colour</label><select id="colorAttribute" aria-label="Point colour attribute"></select><label for="colorBins">Colour bins</label><select id="colorBins"><option>8</option><option selected>24</option><option>64</option></select><input id="colorLow" type="color" aria-label="Low value colour" value="#2463d4"><input id="colorHigh" type="color" aria-label="High value colour" value="#ee5539"><span id="colorRamp" aria-hidden="true"></span><span id="colorLegend" class="hint"></span><span id="sourceSummary" class="hint"></span><button id="reloadSource">Reload this source</button></div><details class="filter-panel" open><summary>Dataset filters</summary><p class="hint">Nested AND / OR groups. Chart selections go into the highlighted group. Numeric and time bins use inclusive lower bounds and exclusive upper bounds (last bin includes the maximum). Charts and filters apply only to the chosen source. The map shows all enabled sources.</p><div id="rules"></div><div class="row filter-actions"><button id="addRule" disabled>+ Add rule</button><button id="apply" class="primary" disabled>Apply filters</button><button id="reset" disabled>Clear filters</button></div></details>
<div class="analysis-grid"><div class="map-panel"><div class="map-tools"><button id="fit" disabled>Fit dataset</button><label for="size">Point size</label><input id="size" type="range" min="1" max="8" step="0.5" value="2"><label><input id="basemap" type="checkbox"> Basemap</label><button id="enlargeMap" aria-label="Enlarge map" aria-haspopup="dialog" aria-expanded="false">Enlarge</button></div><main id="map"><div id="hud">Loaded 0 points</div></main></div><section class="charts-panel"><div class="charts-head"><div><h2>Attribute charts</h2><span class="hint">Click a segment · left-drag charts to zoom · right-drag to select · double-click charts to reset</span></div><button id="addChart" disabled>+ Add chart</button></div><div id="charts" aria-live="polite"><p class="empty">Load a dataset to create charts from its attributes.</p></div></section></div>
<details class="measurements"><summary>Performance measurements</summary><div class="row"><button id="benchmark" disabled>Run pan / zoom test</button><button id="export">Download metrics</button></div><p class="hint">Offline grid by default. Frame intervals depend on GPU and point density.</p></details></section>`;
type Source = {
    id: string;
    name: string;
    enabled: boolean;
    color: [
        number,
        number,
        number
    ];
    config: Config;
    layer: PointsLayer;
    worker?: Worker;
    abort?: AbortController;
    complete?: () => void;
    workspace: Workspace;
    rules: HTMLElement;
    charts: HTMLElement;
    fields: Field[];
    loaded: number;
    selected: number;
    total?: number;
    loading: boolean;
    done: boolean;
    request: number;
    filterRequest: number;
    colorRequest: number;
    coloring: {
        field: string;
        bins: number;
        low: string;
        high: string;
    };
    colorLegend: string;
    metrics: Record<string, any>;
    status: string;
    error: boolean;
    filterStatus: string;
    loadedConfig?: string;
    loadedQuery?: string;
};
const colors: [
    number,
    number,
    number
][] = [[.02, .45, .68], [.83, .39, .17], [.5, .31, .71], [.05, .59, .42], [.75, .24, .43], [.35, .4, .55], [.57, .52, .15], [.1, .6, .65]];
const settings = readSettings();
let background = settings.background;
const sources: Source[] = [];
let queryBounds: QueryBounds = params.get('time') === 'all' ? {} : { time: timeBounds(24) };
let activeId = '', popup: maplibregl.Popup | undefined, benchmarkRunning = false, mapReady = false, loadSlots = 0;
const loadQueue: Source[] = [];
const layerOrder: Source[] = [];
function active(): Source | undefined { return sources.find(s => s.id === activeId) ?? sources[0]; }
function createSource(input: {
    id?: string;
    name?: string;
    enabled?: boolean;
    config?: Config;
    coloring?: Source['coloring'];
    color?: [
        number,
        number,
        number
    ];
}, existing = false): Source {
    const id = input.id ?? crypto.randomUUID(), rules = existing ? $('rules') : document.createElement('div'), charts = existing ? $('charts') : document.createElement('div');
    rules.id = 'rules';
    charts.id = 'charts';
    charts.setAttribute('aria-live', 'polite');
    const color = input.color ?? colors[sources.length % colors.length];
    const s = { id, name: input.name ?? `Source ${sources.length + 1}`, enabled: input.enabled ?? false, color, config: { ...defaultConfig, ...input.config }, layer: new PointsLayer('source-' + id, color), rules, charts, fields: [], loaded: 0, selected: 0, loading: false, done: false, request: 0, filterRequest: 0, colorRequest: 0, coloring: { field: '', bins: 24, low: '#2463d4', high: '#ee5539', ...input.coloring }, colorLegend: '', metrics: {}, status: 'Ready. Load this source to analyze it.', error: false, filterStatus: '' } as unknown as Source;
    s.workspace = new Workspace(() => filter(undefined, s), rules, charts);
    sources.push(s);
    return s;
}
// Query-driven fixtures remain available for automated tests and benchmarks;
// an ordinary first visit starts with an empty, server-agnostic source list.
if (!settings.sources.length && (params.has('points') || params.has('url'))) {
    const url = new URL(params.get('url') ?? '/wfs', location.href);
    for (const key of ['points', 'distribution']) if (params.has(key)) url.searchParams.set(key, params.get(key)!);
    settings.sources.push({ id: crypto.randomUUID(), name: 'WFS source', enabled: true, config: { ...defaultConfig, url: url.href, layer: params.get('layer') ?? 'demo:points' } });
}
for (const [i, source] of settings.sources.entries()) createSource(source, i === 0);
activeId = sources[0]?.id ?? '';
function snapshot(): Settings {
    return { sources: sources.map(({ id, name, enabled, color, config, coloring }) => ({ id, name, enabled, color, config, coloring })), background: { ...background } };
}
function persist() {
    try { localStorage.setItem(settingsKey, JSON.stringify(snapshot())); }
    catch { status('Could not save analysis preferences in this browser.', true); }
}
function renderSources() {
    const select = $<HTMLSelectElement>('analysisSource');
    select.replaceChildren(...sources.map(s => new Option(s.name + (s.enabled ? '' : ' (disabled)'), s.id)));
    if (!sources.length) select.add(new Option('No data sources', ''));
    select.disabled = !sources.length;
    select.value = activeId;
}
const sourceSettings = new DataSources(snapshot(), applySettings);
function applySettings(next: Settings) {
    const oldActive = active();
    for (const s of [...sources]) if (!next.sources.some(n => n.id === s.id)) {
        clearSource(s); s.workspace.reset(); sources.splice(sources.indexOf(s), 1);
    }
    const load: Source[] = [];
    for (const input of next.sources) {
        let s = sources.find(s => s.id === input.id);
        if (!s) { s = createSource(input); if (s.enabled) load.push(s); }
        else {
            const changed = JSON.stringify(s.config) !== JSON.stringify(input.config), wasEnabled = s.enabled;
            s.name = input.name; s.config = { ...input.config }; s.enabled = input.enabled;
            if (changed || !s.enabled) clearSource(s);
            if (s.enabled && (changed || !wasEnabled)) load.push(s);
        }
    }
    background = { ...next.background };
    applyBackground();
    if (!sources.some(s => s.id === activeId)) activeId = sources[0]?.id ?? '';
    const current = active();
    if (current && current !== oldActive) switchAnalysis(current.id);
    if (!current) {
        $('rules').replaceChildren();
        $('charts').replaceChildren();
        const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Add a data source to create charts from its attributes.'; $('charts').append(empty);
        popup?.remove(); showColors();
    }
    renderSources(); state();
    for (const s of load) loadSource(s);
}
function switchAnalysis(id: string) {
    const previous = active();
    const s = sources.find(s => s.id === id);
    if (!s)
        return;
    activeId = id;
    $('rules').replaceWith(s.rules);
    $('charts').replaceWith(s.charts);
    previous?.workspace.visibilityChanged();
    s.workspace.visibilityChanged();
    $<HTMLSelectElement>('analysisSource').value = id;
    popup?.remove();
    showColors();
    state();
}
function route() {
    const config = location.hash === '#configuration';
    $('configuration').hidden = !config;
    $('analysis').hidden = config;
    for (const s of sources)
        s.workspace.visibilityChanged();
    $('configLink').classList.toggle('current', config);
    $('analysisLink').classList.toggle('current', !config);
    if (mapReady)
        requestAnimationFrame(() => map.resize());
    state();
}
window.addEventListener('hashchange', route);
$('analysisSource').onchange = () => switchAnalysis(value('analysisSource'));
const gridFeatures: any[] = [];
for (let x = -180; x <= 180; x += 10)
    gridFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[x, -85], [x, 85]] } });
for (let y = -80; y <= 80; y += 10)
    gridFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-180, y], [180, y]] } });
$<HTMLInputElement>('basemap').checked = background.enabled && !!background.url;
const style: StyleSpecification = { version: 8, sources: { grid: { type: 'geojson', data: { type: 'FeatureCollection', features: gridFeatures } }, osm: { type: 'raster', tiles: background.url ? [background.url] : [], tileSize: 256, attribution: background.attribution, maxzoom: 19 } }, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8eff3' } }, { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: background.enabled && background.url ? 'visible' : 'none' } }, { id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#b5c7d1', 'line-width': .5 } }] };
const map = new maplibregl.Map({ container: 'map', style, center: [-3, 54], zoom: 5, maxZoom: 22, minZoom: 1, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false, renderWorldCopies: false, pixelRatio: Math.min(devicePixelRatio, 2), canvasContextAttributes: { antialias: false }, attributionControl: { compact: true } });
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.doubleClickZoom.disable();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
const mapPanel = document.querySelector<HTMLElement>('.map-panel')!;
const enlargeMap = $<HTMLButtonElement>('enlargeMap');
let mapDialog: HTMLDialogElement | undefined, mapPlaceholder: HTMLElement | undefined;
function restoreMap() {
    const dialog = mapDialog;
    if (!dialog) return;
    mapDialog = undefined;
    mapPlaceholder?.replaceWith(mapPanel); mapPlaceholder = undefined;
    dialog.close(); dialog.remove();
    enlargeMap.textContent = 'Enlarge';
    enlargeMap.setAttribute('aria-label', 'Enlarge map');
    enlargeMap.setAttribute('aria-expanded', 'false');
    map.resize();
    enlargeMap.focus();
}
enlargeMap.onclick = () => {
    if (mapDialog) { restoreMap(); return; }
    // Keep the grid's height and the same live map, layers and canvas.
    mapPlaceholder = document.createElement('div');
    mapPlaceholder.style.height = `${mapPanel.getBoundingClientRect().height}px`;
    mapPlaceholder.setAttribute('aria-hidden', 'true');
    mapPanel.before(mapPlaceholder);
    const dialog = document.createElement('dialog');
    mapDialog = dialog;
    dialog.className = 'map-dialog';
    dialog.setAttribute('aria-label', 'Enlarged map');
    document.body.append(dialog); dialog.append(mapPanel);
    enlargeMap.textContent = 'Return to normal size';
    enlargeMap.setAttribute('aria-label', 'Return map to normal size');
    enlargeMap.setAttribute('aria-expanded', 'true');
    dialog.addEventListener('close', () => { if (mapDialog === dialog) restoreMap(); });
    dialog.showModal();
    map.resize();
    enlargeMap.focus();
};
new ResizeObserver(() => map.resize()).observe($('map'));

function status(text: string, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function enabled(id: string, on: boolean) { $<HTMLButtonElement>(id).disabled = !on; }
function state() {
    const s = active();
    enabled('load', mapReady && sources.some(s => s.enabled && !s.loading));
    enabled('cancel', sources.some(s => s.loading || s.loaded > 0));
    for (const id of ['addRule', 'apply', 'reset', 'addChart'])
        enabled(id, !!s && s.enabled && s.done && s.loaded > 0);
    enabled('reloadSource', mapReady && !!s && s.enabled && !s.loading);
    for (const id of ['fit', 'benchmark'])
        enabled(id, sources.some(s => !!s && s.enabled && s.done && s.loaded > 0));
    status(s ? s.name + ' · ' + s.status : 'Ready. Add a data source to get started.', s?.error);
    $('filterStatus').textContent = s?.filterStatus ? s.name + ' · ' + s.filterStatus : '';
    $('sourceSummary').textContent = sources.map(s => `${s.name}: ${s.enabled ? s.loading ? 'loading' : s.selected.toLocaleString() + ' displayed' : 'disabled'}`).join(' · ');
    const progress = $<HTMLProgressElement>('progress');
    if (s?.total !== undefined && s.total > 0)
        progress.value = s.loaded / s.total;
    else if (s?.loading)
        progress.removeAttribute('value');
    else
        progress.value = s?.done ? 1 : 0;
    hud();
}
function endpoint(config: Config) { return new URL(config.url, location.href).href; }
async function describe(s: Source, config: Config): Promise<{ fields: Field[]; queryFields: QueryFields }> {
    const controller = new AbortController();
    s.abort = controller;
    const timeout = setTimeout(() => controller.abort(), 45000);
    const fallback = { fields: [] as Field[], queryFields: { time: config.timeField, geometry: config.geometryField } };
    try {
        const r = await fetch(wfsURL(endpoint(config), config.version, 'DescribeFeatureType', { [config.version === '2.0.0' ? 'typeNames' : 'typeName']: config.layer }), { signal: controller.signal });
        const text = await r.text();
        xmlDocument(text);
        if (!r.ok) return fallback;
        const doc = new DOMParser().parseFromString(text, 'text/xml');
        // Restrict discovery to the selected feature type's complex type rather
        // than accidentally using fields from another type in the same schema.
        const localType = config.layer.split(':').at(-1);
        const feature = [...doc.getElementsByTagNameNS('*', 'element')].find(el => el.parentElement?.localName === 'schema' && el.getAttribute('name') === localType);
        const typeName = feature?.getAttribute('type')?.split(':').at(-1);
        const complex = [...doc.getElementsByTagNameNS('*', 'complexType')].find(el => el.getAttribute('name') === typeName);
        const sequences = [...(complex ?? doc).getElementsByTagNameNS('*', 'sequence')];
        const elements = sequences.flatMap(seq => [...seq.children]).filter(el => el.localName === 'element' && el.hasAttribute('name'));
        const isGeometry = (el: Element) => /geometry|point|polygon|curve|surface|line|location/i.test(el.getAttribute('type') ?? '') || (el.getAttribute('type') ?? '').split(':')[0] === 'gml';
        const fields = elements.filter(el => !isGeometry(el)).map(el => ({ name: el.getAttribute('name')!, kind: fieldKind(el.getAttribute('type') ?? 'string') }));
        const dates = fields.filter(f => f.kind === 'date'), geometries = elements.filter(isGeometry);
        const namespaces: Record<string, string> = {};
        for (const el of [doc.documentElement, ...elements]) for (const attr of [...el.attributes]) if (attr.name.startsWith('xmlns:')) namespaces[attr.name.slice(6)] = attr.value;
        const targetNamespace = doc.documentElement.getAttribute('targetNamespace');
        const prefix = Object.keys(namespaces).find(key => namespaces[key] === targetNamespace);
        const reference = (name: string) => prefix && doc.documentElement.getAttribute('elementFormDefault') === 'qualified' ? `${prefix}:${name}` : name;
        return { fields, queryFields: { time: config.timeField || (dates.length === 1 ? reference(dates[0].name) : ''), geometry: config.geometryField || (geometries.length === 1 ? reference(geometries[0].getAttribute('name')!) : ''), namespaces } };
    } catch { return fallback; }
    finally { clearTimeout(timeout); if (s.abort === controller) s.abort = undefined; }
}
function clearSource(s: Source) {
    const layerIndex = layerOrder.indexOf(s);
    if (layerIndex >= 0)
        layerOrder.splice(layerIndex, 1);
    for (let i = loadQueue.length - 1; i >= 0; i--)
        if (loadQueue[i] === s)
            loadQueue.splice(i, 1);
    s.request++;
    s.filterRequest++;
    s.colorRequest++;
    s.abort?.abort();
    s.worker?.terminate();
    s.worker = undefined;
    s.complete?.();
    s.complete = undefined;
    if (mapReady && map.getLayer(s.layer.id))
        map.removeLayer(s.layer.id);
    s.layer = new PointsLayer('source-' + s.id, s.color);
    s.layer.pointSize = Number(value('size'));
    s.loaded = s.selected = 0;
    s.loading = s.done = false;
    s.total = undefined;
    s.metrics = {};
    s.filterStatus = '';
    s.status = 'Cleared. Load to resume analysis.';
    s.error = false;
    s.workspace.discardObservationSelections();
    s.workspace.suspend();
    if (s.id === activeId)
        popup?.remove();
}
function clear() {
    for (const s of sources)
        clearSource(s);
    state();
}
function loadSource(s: Source) {
    if (!s.enabled || s.loading || !mapReady)
        return;
    if (s.done && s.loadedConfig === JSON.stringify(s.config) && s.loadedQuery === JSON.stringify(queryBounds))
        return;
    clearSource(s);
    s.loading = true;
    s.status = 'Queued for loading…';
    loadQueue.push(s);
    state();
    pumpLoads();
}
function pumpLoads() {
    while (loadSlots < 2 && loadQueue.length) {
        const s = loadQueue.shift()!;
        if (!s.loading || !s.enabled)
            continue;
        loadSlots++;
        const session = s.request;
        void performLoad(s).catch(e => { if (session === s.request) { clearSource(s); s.status = (e as Error).message; s.error = true; } }).finally(() => { loadSlots--; pumpLoads(); state(); });
    }
}
async function load() {
    location.hash = '#analysis';
    for (const s of sources)
        if (s.enabled)
            loadSource(s);
}
async function performLoad(s: Source) {
    const session = s.request, config = { ...s.config }, bounds = structuredClone(queryBounds);
    s.status = 'Reading feature schema…';
    state();
    const schema = await describe(s, config);
    if (session !== s.request || !s.enabled)
        return;
    const serverFilter = queryFilter(config.version, bounds, schema.queryFields);
    if (serverFilter && [...new URL(endpoint(config)).searchParams.keys()].some(key => ['bbox', 'filter', 'cql_filter', 'featureid', 'resourceid'].includes(key.toLowerCase()))) throw Error('Remove selection parameters from the endpoint URL before using the time or map area controls.');
    s.fields = schema.fields;
    map.addLayer(s.layer);
    layerOrder.push(s);
    s.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const began = performance.now();
    s.metrics = { sourceId: s.id, sourceName: s.name, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, queryBounds: bounds, pointsRequested: Number(new URL(endpoint(config)).searchParams.get('points')) || undefined, viewport: { width: map.getCanvas().width, height: map.getCanvas().height }, devicePixelRatio, pointSize: s.layer.pointSize, distribution: new URL(endpoint(config)).searchParams.get('distribution') ?? undefined, renderer: gpuName(), note: 'Worker and end-to-end frame observations; no GPU timer queries. JSON bytes are uncompressed.' };
    await new Promise<void>(resolve => {
        s.complete = resolve;
        const fail = (message: string) => {
            if (!s.loaded)
                clearSource(s);
            s.loading = false;
            s.done = false;
            s.error = true;
            s.status = message;
            s.worker?.terminate();
            s.workspace.settled();
            resolve();
            state();
        };
        s.worker!.onerror = e => fail(e.message);
        s.worker!.onmessage = e => {
            if (session !== s.request)
                return;
            const m = e.data;
            try {
                if (m.type === 'init') {
                    s.total = m.total;
                    s.layer.allocate(m.capacity);
                    s.status = 'Fetching paged WFS features… ' + (m.warning ?? '');
                }
                if (m.type === 'fields')
                    s.fields = m.fields;
                if (m.type === 'chunk') {
                    s.layer.append(m.offset, m.positions, m.indices, m.groups);
                    if (!s.metrics.firstPointsMs)
                        s.metrics.firstPointsMs = performance.now() - began;
                }
                if (m.type === 'progress' || m.type === 'done') {
                    s.loaded = m.loaded;
                    s.selected = m.loaded;
                    s.total = m.total;
                    s.metrics = { ...s.metrics, ...m };
                    delete s.metrics.type;
                    s.status = `${s.loaded.toLocaleString()}${s.total !== undefined ? ' / ' + s.total.toLocaleString() : ''} points · ${m.pages} pages · ${(m.elapsedMs / 1000).toFixed(1)} s`;
                }
                if (m.type === 'done') {
                    s.loading = false;
                    s.done = true;
                    s.loadedConfig = JSON.stringify(config);
                    s.loadedQuery = JSON.stringify(bounds);
                    if (JSON.stringify(s.workspace.fields) !== JSON.stringify(s.fields)) {
                        s.workspace.reset();
                        s.workspace.ready(s.fields);
                    }
                    s.metrics.readyMs = performance.now() - began;
                    s.metrics.gpuBytes = s.layer.gpuBytes;
                    s.status = `${s.loaded.toLocaleString()} points loaded in ${(m.elapsedMs / 1000).toFixed(1)} s.${m.truncated ? ' LIMIT REACHED: dataset is incomplete.' : ''}${m.warning ? '\n' + m.warning : ''}`;
                    if (!bounds.bbox) fit();
                    filter(undefined, s);
                    applyColors(s);
                    if (s.id === activeId)
                        showColors();
                    resolve();
                }
                if (m.type === 'error') {
                    fail('Load failed: ' + m.message + '\nPartial points are visible; this source’s filters are disabled.');
                    return;
                }
                if (m.type === 'filtered' && m.request === s.filterRequest) {
                    s.workspace.update(m.charts ?? []);
                    s.workspace.settled();
                    s.layer.filter(m.indices);
                    s.selected = m.count;
                    s.metrics.lastFilterMs = m.elapsedMs;
                    s.metrics.analysisCharts = (m.charts ?? []).map((c: any) => ({ id: c.id, type: c.type, bins: c.counts.length, plotted: c.raw?.rows.length ?? c.counts.reduce((a: number, b: number) => a + b, 0), missing: c.missing }));
                    s.metrics.filterCount = m.count;
                    s.metrics.gpuBytes = s.layer.gpuBytes;
                    s.filterStatus = `${s.selected.toLocaleString()} matches · ${m.elapsedMs.toFixed(0)} ms`;
                }
                if (m.type === 'colored' && m.request === s.colorRequest) {
                    s.layer.setColors(m.codes, s.coloring.low, s.coloring.high, m.axis.labels.length);
                    s.colorLegend = m.axis.labels.length ? `${m.axis.labels[0]} … ${m.axis.labels.at(-1)} · grey = missing` : 'No values';
                    if (s.id === activeId)
                        showColors();
                }
                if (m.type === 'colorError' && m.request === s.colorRequest) {
                    s.colorLegend = m.message;
                    if (s.id === activeId)
                        showColors();
                }
                if (m.type === 'filterError' && m.request === s.filterRequest) {
                    s.workspace.settled();
                    s.filterStatus = 'Filter error: ' + m.message;
                }
                if (m.type === 'metadata' && m.request === s.request && m.data)
                    showMetadata(m.data, s.name);
                state();
            }
            catch (e) {
                fail((e as Error).message);
            }
        };
        s.worker!.postMessage({ type: 'load', config: { url: endpoint(config), version: config.version, typeName: config.layer, format: config.format, srs: config.srs, axis: config.axis, pageSize: Number(config.pageSize), limit: Number(config.limit), sort: config.sort, fields: schema.fields, filter: serverFilter } });
    });
    if (session === s.request)
        s.complete = undefined;
}
function fit() {
    const bounds = sources.filter(s => s.enabled && s.loaded && s.metrics.bounds?.every(Number.isFinite)).map(s => s.metrics.bounds);
    if (!bounds.length)
        return;
    map.fitBounds([[Math.min(...bounds.map(b => b[0])), Math.min(...bounds.map(b => b[1]))], [Math.max(...bounds.map(b => b[2])), Math.max(...bounds.map(b => b[3]))]], { padding: 35, duration: 0 });
}
function filter(rules?: Rule[] | Expression, s = active()) {
    if (!s?.enabled || !s.done)
        return;
    const expression = Array.isArray(rules) ? all(rules) : rules ?? s.workspace.expression();
    s.workspace.pending();
    s.filterStatus = 'Updating selection and charts…';
    popup?.remove();
    s.worker?.postMessage({ type: 'analyze', request: ++s.filterRequest, expression, charts: s.workspace.specs.filter(c => c.x && (c.type !== 'scatter' || c.y)) });
    state();
}
function showMetadata(data: any, sourceName: string) {
    popup?.remove();
    const div = document.createElement('div');
    div.className = 'metadata';
    const table = document.createElement('table');
    for (const [k, v] of Object.entries({ wfsSource: sourceName, featureId: data.id, longitude: data.coordinates[0], latitude: data.coordinates[1], ...data.properties })) {
        const tr = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
        th.textContent = k;
        td.textContent = v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        tr.append(th, td);
        table.append(tr);
    }
    div.append(table);
    popup = new maplibregl.Popup({ maxWidth: '380px' }).setLngLat(data.coordinates).setDOMContent(div).addTo(map);
}
map.on('dblclick', e => {
    e.preventDefault();
    for (let i = layerOrder.length - 1; i >= 0; i--) {
        const s = layerOrder[i];
        if (!s.enabled || !s.loaded)
            continue;
        const started = performance.now(), index = s.layer.pick(e.point.x, e.point.y);
        s.metrics.lastPickMs = performance.now() - started;
        if (index !== null) {
            s.worker?.postMessage({ type: 'get', index, request: s.request });
            break;
        }
    }
});
map.on('webglcontextlost', () => status('GPU context lost; waiting for restoration.', true));
map.on('webglcontextrestored', () => {
    for (const s of sources)
        if (s.enabled && (s.loaded || s.loading) && !map.getLayer(s.layer.id))
            map.addLayer(s.layer);
    state();
});
map.on('error', e => status(e.error.message, true));
function gpuName() { const gl = map.getCanvas().getContext('webgl2'), ext = gl?.getExtension('WEBGL_debug_renderer_info'); return ext ? gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable'; }
function quantile(values: number[], q: number) {
    if (!values.length)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}
function hud() {
    const loaded = sources.filter(s => s.enabled).reduce((n, s) => n + s.loaded, 0);
    $('hud').textContent = `Loaded ${loaded.toLocaleString()} points`;
}
async function benchmark() {
    if (benchmarkRunning)
        return;
    benchmarkRunning = true;
    enabled('benchmark', false);
    fit();
    await new Promise(r => setTimeout(r, 200));
    const start = map.getCenter(), zoom = map.getZoom(), frames: number[] = [], raf: number[] = [];
    let prev = 0, rafPrev = 0, animationActive = true;
    const collect = () => {
        const t = performance.now();
        if (prev)
            frames.push(t - prev);
        prev = t;
    };
    const tick = (t: number) => {
        if (!animationActive)
            return;
        if (rafPrev)
            raf.push(t - rafPrev);
        rafPrev = t;
        requestAnimationFrame(tick);
    };
    const began = performance.now();
    map.on('render', collect);
    requestAnimationFrame(tick);
    for (const [dx, dy, dz] of [[.2, .1, .5], [-.2, -.1, 1], [0, 0, 0]])
        await new Promise<void>(resolve => { map.once('moveend', () => resolve()); map.easeTo({ center: [start.lng + dx, start.lat + dy], zoom: zoom + dz, duration: 2000, easing: t => t }); });
    animationActive = false;
    map.off('render', collect);
    const metrics = active()?.metrics ?? {};
    const selected = sources.filter(s => s.enabled).reduce((n, s) => n + s.selected, 0);
    metrics.panZoom = { nominalDurationMs: 6000, actualDurationMs: performance.now() - began, mapFrames: frames.length, frameMedianMs: quantile(frames, .5), frameP95Ms: quantile(frames, .95), frameMaxMs: Math.max(...frames, 0), over33ms: frames.filter(x => x > 33.34).length, rafMedianMs: quantile(raf, .5), rafP95Ms: quantile(raf, .95), pointSize: Number(value('size')), selected, renderer: gpuName() };
    benchmarkRunning = false;
    state();
    status(`Pan / zoom: median ${metrics.panZoom.frameMedianMs.toFixed(1)} ms · p95 ${metrics.panZoom.frameP95Ms.toFixed(1)} ms · ${frames.length} frames in 6 s. Export metrics for details.`);
    return metrics.panZoom;
}
$('load').onclick = () => void load();
$('cancel').onclick = clear;
$('reloadSource').onclick = () => { const s = active(); if (s) { clearSource(s); loadSource(s); } };
$('addRule').onclick = () => active()?.workspace.addRule();
$('addChart').onclick = () => { active()?.workspace.addChart(); filter(); };
$('apply').onclick = () => filter();
$('reset').onclick = () => active()?.workspace.clearFilters();
$('fit').onclick = fit;
$('benchmark').onclick = () => void benchmark();
$('size').oninput = () => {
    for (const s of sources)
        s.layer.pointSize = Number(value('size'));
    map.triggerRepaint();
};
$<HTMLInputElement>('basemap').onchange = () => { background.enabled = $<HTMLInputElement>('basemap').checked; sourceSettings.syncBackgroundEnabled(background.enabled); applyBackground(); persist(); };
$('export').onclick = () => { const blob = new Blob([JSON.stringify({ sources: sources.map(s => ({ id: s.id, name: s.name, enabled: s.enabled, metrics: s.metrics })) }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'wfs-map-metrics.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
(window as any).__WFS_MAP__ = { map, get layer() { return active()?.layer; }, get metrics() { return active()?.metrics; }, get done() { return active()?.done ?? false; }, load, filter, benchmark, get queryBounds() { return structuredClone(queryBounds); }, get workspace() { return active()?.workspace; }, get sources() { return sources; }, switchSource: switchAnalysis, filterSource: (id: string, rules: Rule[] | Expression) => {
        const s = sources.find(s => s.id === id);
        if (s)
            filter(rules, s);
    }, getPoint: (index: number) => { const s = active(); s?.worker?.postMessage({ type: 'get', index, request: s.request }); } };
renderSources();
route();
map.on('load', () => {
    mapReady = true;
    state();
    if (params.get('autoload') === '1')
        void load();
});
function applyBackground() {
    $<HTMLInputElement>('basemap').checked = background.enabled && !!background.url;
    if (!mapReady) return;
    if (map.getLayer('osm')) map.removeLayer('osm');
    if (map.getSource('osm')) map.removeSource('osm');
    if (background.url) {
        map.addSource('osm', { type: 'raster', tiles: [background.url], tileSize: 256, attribution: background.attribution, maxzoom: 22 });
        map.addLayer({ id: 'osm', type: 'raster', source: 'osm', layout: { visibility: background.enabled ? 'visible' : 'none' } }, 'grid');
    }
}
function showColors() {
    const s = active(), select = $<HTMLSelectElement>('colorAttribute');
    select.replaceChildren(new Option('Source colour', ''), ...(s?.fields ?? []).map(f => new Option(f.name, f.name)));
    select.value = s?.coloring.field ?? '';
    $<HTMLSelectElement>('colorBins').value = String(s?.coloring.bins ?? 24);
    $<HTMLInputElement>('colorLow').value = s?.coloring.low ?? '#2463d4';
    $<HTMLInputElement>('colorHigh').value = s?.coloring.high ?? '#ee5539';
    $('colorLegend').textContent = s?.colorLegend ?? '';
    $('colorRamp').hidden = !s?.coloring.field;
    if (s) $('colorRamp').style.background = `linear-gradient(to right,${s.coloring.low},${s.coloring.high})`;
    for (const id of ['colorAttribute', 'colorBins', 'colorLow', 'colorHigh']) $<HTMLInputElement | HTMLSelectElement>(id).disabled = !s?.done;
}
function applyColors(s: Source) { const request = ++s.colorRequest; if (!s.coloring.field) {
    s.layer.setColors(undefined);
    s.colorLegend = '';
    return;
} if (s.done)
    s.worker?.postMessage({ type: 'colors', request, field: s.coloring.field, bins: s.coloring.bins }); }
for (const id of ['colorAttribute', 'colorBins', 'colorLow', 'colorHigh'])
    $(id).onchange = () => { const s = active(); if (!s) return; const previous = s.coloring; s.coloring = { field: value('colorAttribute'), bins: Number(value('colorBins')), low: value('colorLow'), high: value('colorHigh') }; sourceSettings.syncColoring(s); persist(); if (s.layer.colorCodes && previous.field === s.coloring.field && previous.bins === s.coloring.bins) {
        s.layer.setPalette(s.coloring.low, s.coloring.high);
        showColors();
    }
    else
        applyColors(s); };
showColors();
const mapCanvas = map.getCanvas(), geoBox = document.createElement('div');
geoBox.className = 'geo-box';
geoBox.hidden = true;
$('map').append(geoBox);
let geoStart: [
    number,
    number
] | undefined;
const mapPoint = (e: PointerEvent): [
    number,
    number
] => { const rect = mapCanvas.getBoundingClientRect(); return [Math.max(0, Math.min(rect.width, e.clientX - rect.left)), Math.max(0, Math.min(rect.height, e.clientY - rect.top))]; };
mapCanvas.addEventListener('contextmenu', e => e.preventDefault());
mapCanvas.addEventListener('pointerdown', e => { if (e.button !== 2 || !mapReady)
    return; e.preventDefault(); e.stopImmediatePropagation(); geoStart = mapPoint(e); map.dragPan.disable(); mapCanvas.setPointerCapture(e.pointerId); geoBox.hidden = false; geoBox.style.left = geoStart[0] + 'px'; geoBox.style.top = geoStart[1] + 'px'; geoBox.style.width = '0'; geoBox.style.height = '0'; }, true);
mapCanvas.addEventListener('pointermove', e => { if (!geoStart)
    return; const p = mapPoint(e); geoBox.style.left = Math.min(p[0], geoStart[0]) + 'px'; geoBox.style.top = Math.min(p[1], geoStart[1]) + 'px'; geoBox.style.width = Math.abs(p[0] - geoStart[0]) + 'px'; geoBox.style.height = Math.abs(p[1] - geoStart[1]) + 'px'; });
function endGeo(e: PointerEvent, cancel = false) { const a = geoStart; geoStart = undefined; geoBox.hidden = true; map.dragPan.enable(); if (!a || cancel)
    return; const b = mapPoint(e); if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4)
    return; const nw = map.unproject([Math.min(a[0], b[0]), Math.min(a[1], b[1])]), se = map.unproject([Math.max(a[0], b[0]), Math.max(a[1], b[1])]); const west = Math.max(-180, Math.min(180, nw.lng)), east = Math.max(-180, Math.min(180, se.lng)), south = Math.max(-90, se.lat), north = Math.min(90, nw.lat); queryBounds = { ...queryBounds, bbox: { west, east, south, north } }; showQueryBounds(); reloadBounds(); }
mapCanvas.addEventListener('pointerup', e => { if (geoStart)
    endGeo(e); });
mapCanvas.addEventListener('pointercancel', e => { if (geoStart)
    endGeo(e, true); });

function reloadBounds() {
    // Cancel every old worker and queued load before pumping replacement work.
    // This prevents old pages/errors/counts from being applied to a newer query.
    for (const s of sources) clearSource(s);
    for (const s of sources) if (s.enabled) loadSource(s);
    state();
}
function showQueryBounds() {
    const time = queryBounds.time, bbox = queryBounds.bbox;
    $('timeSummary').textContent = time ? `${time.start.slice(0, 19).replace('T', ' ')} → ${time.end.slice(0, 19).replace('T', ' ')} · UTC` : 'All time · no time bound sent to WFS.';
    $('areaSummary').textContent = bbox ? `Map area: ${bbox.west.toFixed(4)}, ${bbox.south.toFixed(4)} to ${bbox.east.toFixed(4)}, ${bbox.north.toFixed(4)} · all enabled sources` : 'All map areas · right-drag a box on the map to bound requests.';
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
