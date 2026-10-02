import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { PointsLayer } from './points-layer.ts';
import { wfsURL, fieldKind, xmlDocument, type Field, type Rule } from './data.ts';
import { Workspace } from './workspace.ts';
import { all, type Expression } from './analysis.ts';
import './style.css';
maplibregl.setWorkerUrl(mapLibreWorkerUrl);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
const params = new URLSearchParams(location.search);
$('app').innerHTML = `
<header class="topbar"><div><h1>WFS analysis</h1><span class="hint">Explore every loaded point · double-click the map for metadata</span></div><nav><a href="#analysis" id="analysisLink">Analysis</a><a href="#configuration" id="configLink">Data sources</a></nav><button id="load" class="primary">Load enabled sources</button><button id="cancel" disabled>Cancel / clear</button></header>
<div class="load-strip"><progress id="progress" max="1" value="0"></progress><div id="status" role="status">Ready. Configure a source or load the development dataset.</div><div id="filterStatus" role="status"></div></div>
<section id="configuration" hidden><div class="config-card"><h2>Map background</h2><label for="basemapURL">Raster basemap tile URL</label><input id="basemapURL" placeholder="https://…/{z}/{x}/{y}.png"><label for="basemapAttribution">Basemap attribution</label><input id="basemapAttribution"><p class="hint">XYZ raster tiles. Leave empty for the offline grid.</p><h2>WFS data sources</h2><p class="hint">Enable multiple sources to draw them together. Choose a source in Analysis to filter it independently.</p><div id="sourceList"></div><div class="row"><select id="sourceEditor" aria-label="Edit WFS source"></select><button id="addSource">+ Add source</button><button id="removeSource">Remove source</button></div><label for="sourceName">Source name</label><input id="sourceName"><p class="hint">Connection settings and generated development data.</p>
  <label for="url">WFS endpoint</label><input id="url" value="/wfs">
  <div class="row"><button id="discover">Discover layers</button><select id="layer" aria-label="Feature type"><option>demo:points</option></select></div>
  <label for="points">Generated dataset size (development WFS only)</label><input id="points" type="number" min="1" max="50000000" value="3000000">
  <label for="distribution">Generated distribution</label><select id="distribution"><option value="uk">UK spread</option><option value="world">Worldwide</option><option value="dense">Dense 2 km square</option></select>
  <details><summary>WFS compatibility and limits</summary>
    <label for="version">WFS version</label><select id="version"><option>2.0.0</option><option>1.1.0</option><option>1.0.0</option></select>
    <label for="format">Output format (as advertised by your server)</label><input id="format" value="application/json">
    <label for="srs">Requested coordinate reference system</label><input id="srs" value="urn:ogc:def:crs:OGC:1.3:CRS84">
    <label for="axis">GML coordinate order (GeoJSON is always lon/lat)</label><select id="axis"><option value="xy">Longitude, latitude</option><option value="yx">Latitude, longitude</option></select>
    <label for="sort">Stable unique sort attribute (optional)</label><input id="sort" placeholder="e.g. id">
    <label for="pageSize">Features per request</label><input id="pageSize" type="number" value="50000" min="1" max="100000">
    <label for="limit">Client point limit (truncation is reported)</label><input id="limit" type="number" value="10000000" min="1" max="50000000">
    <p class="hint">Requires paging and GeoJSON or simple GML Point output. Use a stable server snapshot. CORS must permit this page's origin. WFS 1.x paging is a server extension.</p>
  </details>

<p class="hint">Settings are saved in this browser. Return to Analysis to load and explore.</p></div></section>
<section id="analysis"><div class="source-analysis"><label for="analysisSource">Analyze source</label><select id="analysisSource" aria-label="Analyze source"></select><label for="colorAttribute">Point colour</label><select id="colorAttribute" aria-label="Point colour attribute"></select><label for="colorBins">Colour bins</label><select id="colorBins"><option>8</option><option selected>24</option><option>64</option></select><input id="colorLow" type="color" aria-label="Low value colour" value="#2463d4"><input id="colorHigh" type="color" aria-label="High value colour" value="#ee5539"><span id="colorRamp" aria-hidden="true"></span><span id="colorLegend" class="hint"></span><span id="sourceSummary" class="hint"></span><button id="reloadSource">Reload this source</button></div><details class="filter-panel" open><summary>Dataset filters</summary><p class="hint">Nested AND / OR groups. Chart selections go into the highlighted group. Numeric and time bins use inclusive lower bounds and exclusive upper bounds (last bin includes the maximum). Charts and filters apply only to the chosen source. The map shows all enabled sources.</p><div id="rules"></div><div class="row filter-actions"><button id="addRule" disabled>+ Add rule</button><button id="apply" class="primary" disabled>Apply filters</button><button id="reset" disabled>Clear filters</button></div></details>
<div class="analysis-grid"><div class="map-panel"><div class="map-tools"><button id="fit" disabled>Fit dataset</button><label for="size">Point size</label><input id="size" type="range" min="1" max="8" step="0.5" value="2"><label><input id="basemap" type="checkbox"> Basemap</label></div><main id="map"><div id="hud">Starting map…</div></main></div><section class="charts-panel"><div class="charts-head"><div><h2>Attribute charts</h2><span class="hint">Click a segment; drag a scatter rectangle; right-drag the map to filter</span></div><button id="addChart" disabled>+ Add chart</button></div><div id="charts" aria-live="polite"><p class="empty">Load a dataset to create charts from its attributes.</p></div></section></div>
<details class="measurements"><summary>Performance measurements</summary><div class="row"><button id="benchmark" disabled>Run pan / zoom test</button><button id="export">Download metrics</button></div><p class="hint">Offline grid by default. Frame intervals depend on GPU and point density.</p></details></section>`;
const configKeys = ['url', 'layer', 'points', 'distribution', 'version', 'format', 'srs', 'axis', 'sort', 'pageSize', 'limit'];
type Config = Record<string, string>;
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
};
const colors: [
    number,
    number,
    number
][] = [[.02, .45, .68], [.83, .39, .17], [.5, .31, .71], [.05, .59, .42], [.75, .24, .43], [.35, .4, .55], [.57, .52, .15], [.1, .6, .65]];
const defaultConfig = Object.fromEntries(configKeys.map(key => [key, value(key)]));
const sources: Source[] = [];
let editingId = '', activeId = '', popup: maplibregl.Popup | undefined, benchmarkRunning = false, mapReady = false, loadSlots = 0;
const loadQueue: Source[] = [];
const layerOrder: Source[] = [];
function active() { return sources.find(s => s.id === activeId) ?? sources[0]; }
function edited() { return sources.find(s => s.id === editingId) ?? sources[0]; }
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
let stored: any[] = [];
try {
    const saved = JSON.parse(localStorage.getItem('wfs-sources') ?? 'null');
    if (Array.isArray(saved))
        stored = saved.filter(s => typeof s.id === 'string' && typeof s.name === 'string' && s.config && configKeys.every(k => typeof s.config[k] === 'string')).slice(0, 8);
}
catch { }
if (!stored.length) {
    let legacy: Config = {};
    try {
        legacy = JSON.parse(localStorage.getItem('wfs-configuration') ?? '{}');
    }
    catch { }
    stored = [{ name: 'Development WFS', enabled: true, config: { ...defaultConfig, ...legacy } }];
}
for (const [i, s] of stored.entries())
    createSource(s, i === 0);
activeId = editingId = sources[0].id;
for (const key of ['points', 'distribution', 'url'])
    if (params.has(key))
        sources[0].config[key] = params.get(key)!;
function persist() {
    try {
        localStorage.setItem('wfs-sources', JSON.stringify(sources.map(({ id, name, enabled, color, config, coloring }) => ({ id, name, enabled, color, config, coloring }))));
    }
    catch { }
}
function saveConfig() { const s = edited(); s.name = value('sourceName').trim() || 'Unnamed source'; s.config = Object.fromEntries(configKeys.map(key => [key, value(key)])); persist(); renderSources(); }
function showConfig(id: string) {
    editingId = id;
    const s = edited();
    for (const key of configKeys) {
        const input = $<HTMLInputElement | HTMLSelectElement>(key);
        if (input instanceof HTMLSelectElement && !Array.from(input.options).some(o => o.value === s.config[key]))
            input.add(new Option(s.config[key], s.config[key]));
        input.value = s.config[key];
    }
    $<HTMLInputElement>('sourceName').value = s.name;
    $<HTMLSelectElement>('sourceEditor').value = s.id;
    state();
}
function cssColor(s: Source) { return `rgb(${s.color.map(v => Math.round(v * 255)).join(',')})`; }
function renderSources() {
    $('sourceList').replaceChildren(...sources.map(s => {
        const row = document.createElement('div');
        row.className = 'source-row';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = s.enabled;
        check.setAttribute('aria-label', 'Enable ' + s.name);
        check.onchange = () => {
            s.enabled = check.checked;
            persist();
            if (!s.enabled)
                clearSource(s);
            renderSources();
            if (s.enabled && mapReady)
                loadSource(s);
            state();
        };
        const name = document.createElement('span');
        name.textContent = s.name;
        name.style.color = cssColor(s);
        const endpoint = document.createElement('span');
        endpoint.className = 'hint';
        endpoint.textContent = s.config.url;
        const edit = document.createElement('button');
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label', 'Edit ' + s.name);
        edit.onclick = () => showConfig(s.id);
        row.append(check, name, endpoint, edit);
        return row;
    }));
    for (const key of ['sourceEditor', 'analysisSource']) {
        const select = $<HTMLSelectElement>(key);
        select.replaceChildren(...sources.map(s => new Option(s.name + (s.enabled ? '' : ' (disabled)'), s.id)));
        select.value = key === 'sourceEditor' ? editingId : activeId;
    }
    enabled('removeSource', sources.length > 1);
    enabled('addSource', sources.length < 8);
}
function switchAnalysis(id: string) {
    const previous = active();
    const s = sources.find(s => s.id === id);
    if (!s)
        return;
    activeId = id;
    $('rules').replaceWith(s.rules);
    $('charts').replaceWith(s.charts);
    previous.workspace.visibilityChanged();
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
for (const key of [...configKeys, 'sourceName'])
    $(key).addEventListener('change', saveConfig);
$('sourceEditor').onchange = () => { const id = value('sourceEditor'); saveConfig(); showConfig(id); };
$('analysisSource').onchange = () => switchAnalysis(value('analysisSource'));
$('addSource').onclick = () => {
    saveConfig();
    if (sources.length >= 8)
        return;
    const s = createSource({ config: { ...defaultConfig, points: '1000000' } });
    persist();
    renderSources();
    showConfig(s.id);
};
$('removeSource').onclick = () => {
    if (sources.length <= 1)
        return;
    const s = edited();
    clearSource(s);
    s.workspace.reset();
    sources.splice(sources.indexOf(s), 1);
    editingId = sources[0].id;
    if (activeId === s.id)
        switchAnalysis(sources[0].id);
    persist();
    renderSources();
    showConfig(editingId);
};
const gridFeatures: any[] = [];
for (let x = -180; x <= 180; x += 10)
    gridFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[x, -85], [x, 85]] } });
for (let y = -80; y <= 80; y += 10)
    gridFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-180, y], [180, y]] } });
let background = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', enabled: false };
try {
    background = { ...background, ...JSON.parse(localStorage.getItem('wfs-basemap') ?? '{}') };
}
catch { }
$<HTMLInputElement>('basemapURL').value = background.url;
$<HTMLInputElement>('basemapAttribution').value = background.attribution;
$<HTMLInputElement>('basemap').checked = background.enabled && !!background.url;
const style: StyleSpecification = { version: 8, sources: { grid: { type: 'geojson', data: { type: 'FeatureCollection', features: gridFeatures } }, osm: { type: 'raster', tiles: background.url ? [background.url] : [], tileSize: 256, attribution: background.attribution, maxzoom: 19 } }, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8eff3' } }, { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: background.enabled && background.url ? 'visible' : 'none' } }, { id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#b5c7d1', 'line-width': .5 } }] };
const map = new maplibregl.Map({ container: 'map', style, center: [-3, 54], zoom: 5, maxZoom: 22, minZoom: 1, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false, renderWorldCopies: false, pixelRatio: Math.min(devicePixelRatio, 2), canvasContextAttributes: { antialias: false }, attributionControl: { compact: true } });
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.doubleClickZoom.disable();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
function status(text: string, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function enabled(id: string, on: boolean) { $<HTMLButtonElement>(id).disabled = !on; }
function state() {
    const s = location.hash === '#configuration' ? edited() : active();
    enabled('load', mapReady && sources.some(s => s.enabled && !s.loading));
    enabled('discover', !edited().loading);
    enabled('cancel', sources.some(s => s.loading || s.loaded > 0));
    for (const id of ['addRule', 'apply', 'reset', 'addChart'])
        enabled(id, s.enabled && s.done && s.loaded > 0);
    enabled('reloadSource', mapReady && s.enabled && !s.loading);
    for (const id of ['fit', 'benchmark'])
        enabled(id, sources.some(s => s.enabled && s.done && s.loaded > 0));
    status(s.name + ' · ' + s.status, s.error);
    $('filterStatus').textContent = s.name + ' · ' + s.filterStatus;
    $('sourceSummary').textContent = sources.map(s => `${s.name}: ${s.enabled ? s.loading ? 'loading' : s.selected.toLocaleString() + ' displayed' : 'disabled'}`).join(' · ');
    const progress = $<HTMLProgressElement>('progress');
    if (s.total !== undefined && s.total > 0)
        progress.value = s.loaded / s.total;
    else if (s.loading)
        progress.removeAttribute('value');
    else
        progress.value = s.done ? 1 : 0;
    hud();
}
function endpoint(config: Config) {
    const u = new URL(config.url, location.href);
    if (u.origin === location.origin && u.pathname === '/wfs') {
        u.searchParams.set('points', config.points);
        u.searchParams.set('distribution', config.distribution);
    }
    return u.href;
}
async function discover() {
    saveConfig();
    const s = edited(), config = { ...s.config };
    enabled('discover', false);
    try {
        const response = await fetch(wfsURL(endpoint(config), config.version, 'GetCapabilities'));
        const text = await response.text();
        xmlDocument(text);
        if (!response.ok)
            throw Error(`HTTP ${response.status}`);
        const doc = new DOMParser().parseFromString(text, 'text/xml');
        const types = [...doc.getElementsByTagNameNS('*', 'FeatureType')].map(el => el.getElementsByTagNameNS('*', 'Name')[0]?.textContent ?? '').filter(Boolean);
        if (!types.length)
            throw Error('No feature types in GetCapabilities');
        if (editingId === s.id) {
            $('layer').replaceChildren(...types.map(name => new Option(name, name)));
            saveConfig();
        }
        s.status = `Discovered ${types.length} layer(s). Select one, then load.`;
        s.error = false;
    }
    catch (e) {
        s.status = (e as Error).message;
        s.error = true;
    }
    finally {
        state();
    }
}
async function describe(s: Source, config: Config): Promise<Field[]> {
    const controller = new AbortController();
    s.abort = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const r = await fetch(wfsURL(endpoint(config), config.version, 'DescribeFeatureType', { [config.version === '2.0.0' ? 'typeNames' : 'typeName']: config.layer }), { signal: controller.signal });
        const text = await r.text();
        xmlDocument(text);
        if (!r.ok)
            return [];
        const doc = new DOMParser().parseFromString(text, 'text/xml');
        const elements = [...doc.getElementsByTagNameNS('*', 'sequence')].flatMap(seq => [...seq.children]).filter(el => el.localName === 'element');
        return elements.filter(el => el.hasAttribute('name') && !/gml:|geometry|point|polygon|curve|surface/i.test(el.getAttribute('type') ?? '')).map(el => ({ name: el.getAttribute('name')!, kind: fieldKind(el.getAttribute('type') ?? 'string') }));
    }
    catch {
        return [];
    }
    finally {
        clearTimeout(timeout);
        if (s.abort === controller)
            s.abort = undefined;
    }
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
    if (s.done && s.loadedConfig === JSON.stringify(s.config))
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
        void performLoad(s).catch(e => { clearSource(s); s.status = (e as Error).message; s.error = true; }).finally(() => { loadSlots--; pumpLoads(); state(); });
    }
}
async function load() {
    saveConfig();
    location.hash = '#analysis';
    for (const s of sources)
        if (s.enabled)
            loadSource(s);
}
async function performLoad(s: Source) {
    const session = s.request, config = { ...s.config };
    s.status = 'Reading feature schema…';
    state();
    const schemaHints = await describe(s, config);
    if (session !== s.request || !s.enabled)
        return;
    map.addLayer(s.layer);
    layerOrder.push(s);
    s.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const began = performance.now();
    s.metrics = { sourceId: s.id, sourceName: s.name, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, pointsRequested: Number(config.points), viewport: { width: map.getCanvas().width, height: map.getCanvas().height }, devicePixelRatio, pointSize: s.layer.pointSize, distribution: config.distribution, renderer: gpuName(), note: 'Worker and end-to-end frame observations; no GPU timer queries. JSON bytes are uncompressed.' };
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
                    if (JSON.stringify(s.workspace.fields) !== JSON.stringify(s.fields)) {
                        s.workspace.reset();
                        s.workspace.ready(s.fields);
                    }
                    s.metrics.readyMs = performance.now() - began;
                    s.metrics.gpuBytes = s.layer.gpuBytes;
                    s.status = `${s.loaded.toLocaleString()} points loaded in ${(m.elapsedMs / 1000).toFixed(1)} s.${m.truncated ? ' LIMIT REACHED: dataset is incomplete.' : ''}${m.warning ? '\n' + m.warning : ''}`;
                    fit();
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
        s.worker!.postMessage({ type: 'load', config: { url: endpoint(config), version: config.version, typeName: config.layer, format: config.format, srs: config.srs, axis: config.axis, pageSize: Number(config.pageSize), limit: Number(config.limit), sort: config.sort, fields: schemaHints } });
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
    if (!s.enabled || !s.done)
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
const intervals: number[] = [];
let lastRender = 0, lastHud = 0;
map.on('render', () => {
    const t = performance.now();
    if (map.isMoving() && lastRender) {
        const dt = t - lastRender;
        if (dt < 1000)
            intervals.push(dt);
        if (intervals.length > 300)
            intervals.shift();
    }
    lastRender = t;
    if (t - lastHud > 250) {
        hud();
        lastHud = t;
    }
});
function quantile(values: number[], q: number) {
    if (!values.length)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}
function hud() { const visible = sources.filter(s => s.enabled), loaded = visible.reduce((n, s) => n + s.loaded, 0), selected = visible.reduce((n, s) => n + s.selected, 0), bytes = visible.reduce((n, s) => n + s.layer.gpuBytes, 0); $('hud').textContent = `Loaded ${loaded.toLocaleString()} · displayed ${selected.toLocaleString()} · ${visible.length} enabled source(s)\nGPU buffers ${(bytes / 1048576).toFixed(1)} MiB\nMoving frame interval: median ${quantile(intervals, .5).toFixed(1)} ms · p95 ${quantile(intervals, .95).toFixed(1)} ms\nZoom ${map.getZoom().toFixed(2)} · point diameter ${value('size')} px`; }
setInterval(hud, 1000);
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
    const metrics = active().metrics;
    const selected = sources.filter(s => s.enabled).reduce((n, s) => n + s.selected, 0);
    metrics.panZoom = { nominalDurationMs: 6000, actualDurationMs: performance.now() - began, mapFrames: frames.length, frameMedianMs: quantile(frames, .5), frameP95Ms: quantile(frames, .95), frameMaxMs: Math.max(...frames, 0), over33ms: frames.filter(x => x > 33.34).length, rafMedianMs: quantile(raf, .5), rafP95Ms: quantile(raf, .95), pointSize: Number(value('size')), selected, renderer: gpuName() };
    benchmarkRunning = false;
    state();
    status(`Pan / zoom: median ${metrics.panZoom.frameMedianMs.toFixed(1)} ms · p95 ${metrics.panZoom.frameP95Ms.toFixed(1)} ms · ${frames.length} frames in 6 s. Export metrics for details.`);
    return metrics.panZoom;
}
$('discover').onclick = () => void discover();
$('load').onclick = () => void load();
$('cancel').onclick = clear;
$('reloadSource').onclick = () => { saveConfig(); const s = active(); clearSource(s); loadSource(s); };
$('addRule').onclick = () => active().workspace.addRule();
$('addChart').onclick = () => { active().workspace.addChart(); filter(); };
$('apply').onclick = () => filter();
$('reset').onclick = () => active().workspace.clearFilters();
$('fit').onclick = fit;
$('benchmark').onclick = () => void benchmark();
$('size').oninput = () => {
    for (const s of sources)
        s.layer.pointSize = Number(value('size'));
    map.triggerRepaint();
};
$<HTMLInputElement>('basemap').onchange = () => { background.enabled = $<HTMLInputElement>('basemap').checked; saveBackground(); };
$('export').onclick = () => { const blob = new Blob([JSON.stringify({ sources: sources.map(s => ({ id: s.id, name: s.name, enabled: s.enabled, metrics: s.metrics })) }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'wfs-map-metrics.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
(window as any).__WFS_MAP__ = { map, get layer() { return active().layer; }, get metrics() { return active().metrics; }, get done() { return active().done; }, load, filter, benchmark, get workspace() { return active().workspace; }, get sources() { return sources; }, switchSource: switchAnalysis, filterSource: (id: string, rules: Rule[] | Expression) => {
        const s = sources.find(s => s.id === id);
        if (s)
            filter(rules, s);
    }, getPoint: (index: number) => active().worker?.postMessage({ type: 'get', index, request: active().request }) };
renderSources();
showConfig(editingId);
route();
map.on('load', () => {
    mapReady = true;
    state();
    if (params.get('autoload') === '1')
        void load();
});
function saveBackground() {
    const url = value('basemapURL').trim();
    try {
        if (url) {
            const parsed = new URL(url, location.href);
            if (!['http:', 'https:'].includes(parsed.protocol) || !['{z}', '{x}', '{y}'].every(token => url.includes(token)))
                throw Error('Use an HTTP(S) XYZ tile URL with {z}, {x}, and {y}.');
        }
        background.url = url;
        background.attribution = value('basemapAttribution');
        localStorage.setItem('wfs-basemap', JSON.stringify(background));
        if (mapReady) {
            if (map.getLayer('osm'))
                map.removeLayer('osm');
            if (map.getSource('osm'))
                map.removeSource('osm');
            if (url) {
                map.addSource('osm', { type: 'raster', tiles: [url], tileSize: 256, attribution: background.attribution, maxzoom: 22 });
                map.addLayer({ id: 'osm', type: 'raster', source: 'osm', layout: { visibility: background.enabled ? 'visible' : 'none' } }, 'grid');
            }
        }
        $('basemapURL').removeAttribute('aria-invalid');
    }
    catch (e) {
        $('basemapURL').setAttribute('aria-invalid', 'true');
        status((e as Error).message, true);
    }
}
$('basemapURL').onchange = saveBackground;
$('basemapAttribution').onchange = saveBackground;
function showColors() { const s = active(), select = $<HTMLSelectElement>('colorAttribute'); select.replaceChildren(new Option('Source colour', ''), ...s.fields.map(f => new Option(f.name, f.name))); select.value = s.coloring.field; $<HTMLSelectElement>('colorBins').value = String(s.coloring.bins); $<HTMLInputElement>('colorLow').value = s.coloring.low; $<HTMLInputElement>('colorHigh').value = s.coloring.high; $('colorLegend').textContent = s.colorLegend; $('colorRamp').hidden = !s.coloring.field; $('colorRamp').style.background = `linear-gradient(to right,${s.coloring.low},${s.coloring.high})`; select.disabled = !s.done; }
function applyColors(s: Source) { const request = ++s.colorRequest; if (!s.coloring.field) {
    s.layer.setColors(undefined);
    s.colorLegend = '';
    return;
} if (s.done)
    s.worker?.postMessage({ type: 'colors', request, field: s.coloring.field, bins: s.coloring.bins }); }
for (const id of ['colorAttribute', 'colorBins', 'colorLow', 'colorHigh'])
    $(id).onchange = () => { const s = active(), previous = s.coloring; s.coloring = { field: value('colorAttribute'), bins: Number(value('colorBins')), low: value('colorLow'), high: value('colorHigh') }; persist(); if (s.layer.colorCodes && previous.field === s.coloring.field && previous.bins === s.coloring.bins) {
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
] | undefined, geoSource: Source | undefined;
const mapPoint = (e: PointerEvent): [
    number,
    number
] => { const rect = mapCanvas.getBoundingClientRect(); return [Math.max(0, Math.min(rect.width, e.clientX - rect.left)), Math.max(0, Math.min(rect.height, e.clientY - rect.top))]; };
mapCanvas.addEventListener('contextmenu', e => e.preventDefault());
mapCanvas.addEventListener('pointerdown', e => { if (e.button !== 2 || !active().done)
    return; e.preventDefault(); e.stopImmediatePropagation(); geoStart = mapPoint(e); geoSource = active(); map.dragPan.disable(); mapCanvas.setPointerCapture(e.pointerId); geoBox.hidden = false; geoBox.style.left = geoStart[0] + 'px'; geoBox.style.top = geoStart[1] + 'px'; geoBox.style.width = '0'; geoBox.style.height = '0'; }, true);
mapCanvas.addEventListener('pointermove', e => { if (!geoStart)
    return; const p = mapPoint(e); geoBox.style.left = Math.min(p[0], geoStart[0]) + 'px'; geoBox.style.top = Math.min(p[1], geoStart[1]) + 'px'; geoBox.style.width = Math.abs(p[0] - geoStart[0]) + 'px'; geoBox.style.height = Math.abs(p[1] - geoStart[1]) + 'px'; });
function endGeo(e: PointerEvent, cancel = false) { const a = geoStart, s = geoSource; geoStart = undefined; geoSource = undefined; geoBox.hidden = true; map.dragPan.enable(); if (!a || !s || cancel || !s.done)
    return; const b = mapPoint(e); if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4)
    return; const nw = map.unproject([Math.min(a[0], b[0]), Math.min(a[1], b[1])]), se = map.unproject([Math.max(a[0], b[0]), Math.max(a[1], b[1])]); const west = Math.max(-180, Math.min(180, nw.lng)), east = Math.max(-180, Math.min(180, se.lng)), south = Math.max(-90, se.lat), north = Math.min(90, nw.lat); s.workspace.select({ op: 'bbox', west, east, south, north }, `Map box: ${west.toFixed(4)}, ${south.toFixed(4)} to ${east.toFixed(4)}, ${north.toFixed(4)}`); }
mapCanvas.addEventListener('pointerup', e => { if (geoStart)
    endGeo(e); });
mapCanvas.addEventListener('pointercancel', e => { if (geoStart)
    endGeo(e, true); });
