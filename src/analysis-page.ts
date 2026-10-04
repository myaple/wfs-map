import { sharedDomain, combineSeries, seriesColors } from './multi-charts.ts';
import type { ChartDomain, ChartResult, ChartSpec } from './analysis.ts';
import { RecordsPage } from './records-page.ts';
import type { RecordRef, RecordData } from './records.ts';
import { MapLegend } from './map-legend.ts';
import { mountThemeToggle, themeColor } from './theme.ts';
import { formatUTC, utcISO, utcInput } from './time.ts';
import { createUUID } from './uuid.ts';
import { configurationState, type SourceAnalysis } from './analysis-state.ts';
import { currentAnalysis, mountAnalysisControls, rememberBindings } from './saved-analysis.ts';
import { fileUser } from './source-storage.ts';
import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { csvExportFilename } from './csv-export.ts';
import { PointsLayer } from './points-layer.ts';
import { metadataPopup } from './metadata-popup.ts';
import { wfsURL, fieldKind, xmlDocument, type Field, type Rule } from './data.ts';
import { Workspace } from './workspace.ts';
import { all, type Expression } from './analysis.ts';
import { PointColors } from './point-colors.ts';
import { DataSources } from './data-sources.ts';
import { configIdentity, defaultConfig, readSettings, settingsKey, type Config, type Settings, type SavedSource, type MapSettings } from './source-settings.ts';
import { queryFilter, timeBounds, validateTime, type QueryBounds, type QueryFields } from './wfs-query.ts';
import './style.css';
maplibregl.setWorkerUrl(mapLibreWorkerUrl);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
const params = new URLSearchParams(location.search);
$('app').innerHTML = `
<header class="topbar"><div><h1>WFS analysis</h1><span class="hint">Explore every loaded point · double-click the map for metadata</span></div><nav><a href="#analysis" id="analysisLink">Analysis</a><a href="#records" id="recordsLink">Records</a><a href="#configuration" id="configLink">Data sources</a></nav><button id="load" class="primary">Load enabled sources</button><button id="cancel" disabled>Cancel / clear</button></header>
<div class="load-strip"><progress id="progress" max="1" value="0"></progress><div id="status" role="status">Ready. Add a data source to get started.</div><div id="sourceSummary" class="hint"></div></div>
<section id="configuration" hidden></section>
<section id="analysis"><section class="query-panel" aria-labelledby="queryTitle"><div class="query-heading"><h2 id="queryTitle">Time &amp; map area</h2><span class="hint">Applies to all enabled sources · WFS requests and CSV rows</span></div><form id="timeForm" class="query-controls"><label for="timeWindow">Time window</label><select id="timeWindow"><option value="1">Last hour</option><option value="6">Last 6 hours</option><option value="24" selected>Last 24 hours</option><option value="168">Last 7 days</option><option value="custom">Custom range</option><option value="all">All time</option></select><div id="customTime" class="query-controls" hidden><span id="utcTimeHelp" class="hint">24-hour clock · UTC · YYYY-MM-DD HH:mm:ss</span><label for="timeStart">Start (UTC)</label><input id="timeStart" type="text" placeholder="YYYY-MM-DD HH:mm:ss" aria-describedby="utcTimeHelp"><label for="timeEnd">End (UTC)</label><input id="timeEnd" type="text" placeholder="YYYY-MM-DD HH:mm:ss" aria-describedby="utcTimeHelp"></div><button id="applyTime" class="primary" type="submit">Refresh time window</button></form><p id="timeSummary" class="hint" role="status"></p><p id="timeError" class="error" role="alert" hidden></p><div class="query-area"><span id="areaSummary" class="hint">All map areas · right-drag a box on the map to bound requests.</span><button id="clearArea" hidden>Clear map area</button></div></section><div class="analysis-controls"><details class="colour-panel" open><summary>Point colouring</summary><p class="hint">Choose a source to style. Single colour for all points, discrete colours for text, or a gradient for numbers. Each source keeps its own settings.</p><div class="source-controls"><div class="source-control"><label for="colorSource">Colour data source</label><select id="colorSource"></select></div><div class="source-control"><label for="colorAttribute">Point colour attribute</label><select id="colorAttribute"></select></div><div id="solidColorControl" class="source-control"><label for="sourceColor">Single source colour</label><input id="sourceColor" type="color"></div><div data-gradient-control class="source-control"><label for="colorBins">Colour bins</label><select id="colorBins"><option>8</option><option selected>24</option><option>64</option></select></div><div data-gradient-control class="source-control"><label for="colorLow">Low value colour</label><input id="colorLow" type="color" value="#2463d4"></div><div data-gradient-control class="source-control"><label for="colorHigh">High value colour</label><input id="colorHigh" type="color" value="#ee5539"></div><span id="colorRamp" aria-hidden="true"></span></div><div id="categoryColors" hidden><label for="categorySearch">Find a value</label><input id="categorySearch" type="search" placeholder="Search unique values"><div id="categoryColorList"></div><button id="moreCategoryColors" type="button">Show more values</button><p id="categoryColorCount" class="hint"></p></div><p id="colorLegend" class="hint" role="status"></p></details><details class="filter-panel" open><summary>Dataset filters</summary><p class="hint">Filters apply only to this source. All edits, removals and chart selections wait for Apply filters. Chart selections use the highlighted AND / OR group.</p><div class="source-controls"><div class="source-control"><label for="filterSource">Filter data source</label><select id="filterSource"></select></div><span id="filterOwner" class="hint"></span></div><div id="rules"></div><div class="row filter-actions"><button id="apply" class="primary" disabled>Apply filters</button><button id="reset" disabled>Clear filters</button><button id="discardFilters" disabled>Discard edits</button><button id="undoFilters" disabled>Undo query</button><button id="redoFilters" disabled>Redo query</button><span id="draftStatus" class="hint" role="status"></span><span id="filterStatus" role="status"></span></div></details></div>

<div class="analysis-grid"><div class="map-panel"><div class="map-tools"><button id="fit" disabled>Fit dataset</button><label for="size">Point size</label><input id="size" type="range" min="1" max="8" step="0.5" value="2"><label><input id="basemap" type="checkbox"> Basemap</label><button id="enlargeMap" aria-label="Enlarge map" aria-haspopup="dialog" aria-expanded="false">Enlarge</button></div><main id="map"><div id="hud">Loaded 0 points</div></main><aside id="mapLegend" class="map-legend" aria-label="Map legend" hidden></aside></div><section class="charts-panel"><div class="charts-head"><div><h2>Attribute charts</h2><span class="hint">Click a segment · left-drag charts to zoom · right-drag to add draft filters · Apply filters to update results · double-click charts to reset</span></div><div class="source-controls"><div class="source-control"><label for="chartSource">New chart data source</label><select id="chartSource"></select></div><button id="addChart" disabled>+ Add chart</button></div></div><div id="charts" aria-live="polite"><p class="empty">Load datasets to create charts from their attributes.</p></div></section></div>
<details class="colour-panel csv-export-panel" open><summary>CSV export</summary><p class="hint">Download one source’s displayed selection, including its attributes and coordinates. Respects applied dataset/chart filters and the time and map-area bounds.</p><div class="source-controls"><div class="source-control"><label for="exportSource">Export data source</label><select id="exportSource"></select></div><button id="exportCSV" disabled>Download CSV</button><span id="csvExportStatus" class="hint" role="status"></span></div></details>
<details class="measurements"><summary>Performance measurements</summary><div class="row"><button id="benchmark" disabled>Run pan / zoom test</button><button id="export">Download metrics</button></div><p class="hint">Offline grid by default. Frame intervals depend on GPU and point density.</p></details></section>`;
mountThemeToggle(document.querySelector('.topbar')!);
const mapLegend = new MapLegend($('mapLegend'));
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
    filtering: boolean;
    pendingQuery?: { expression: Expression; action: 'commit' | 'undo' | 'redo' | 'refresh' };
    queryWaiters: ((ok: boolean) => void)[];
    exportRequest: number;
    exporting: boolean;
    exportStatus: string;
    colorRequest: number;
    coloring: NonNullable<SavedSource['coloring']>;
    colorCategories?: string[];
    colorLabels?: string[];
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
const savedAnalyses = new Map((currentAnalysis?.state.analyses ?? []).map(s => [s.id, structuredClone(s)]));
let background = settings.background;
let mapSettings: MapSettings = settings.map ?? { center: [-3, 54], zoom: 5, pointSize: 2 };
let preserveMapView = !!settings.map;
$<HTMLInputElement>('size').value = String(mapSettings.pointSize);
const sources: Source[] = [];
const savedQuery = currentAnalysis?.state.query;
let queryBounds: QueryBounds = savedQuery ? { ...structuredClone(savedQuery.bounds), ...(savedQuery.choice === 'all' ? { time: undefined } : savedQuery.choice !== 'custom' ? { time: timeBounds(Number(savedQuery.choice)) } : {}) } : params.get('time') === 'all' ? {} : { time: timeBounds(24) };
if (queryBounds.time) queryBounds.time = { start: utcISO(queryBounds.time.start), end: utcISO(queryBounds.time.end) };
let filterSourceId = '', popup: maplibregl.Popup | undefined, benchmarkRunning = false, mapReady = false, loadSlots = 0;
const loadQueue: Source[] = [];
const layerOrder: Source[] = [];
function filterSource(): Source | undefined { return sources.find(s => s.enabled && s.id === filterSourceId) ?? sources.find(s => s.enabled); }
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
    const id = input.id ?? createUUID(), rules = existing ? $('rules') : document.createElement('div'), charts = $('charts');
    rules.id = 'rules';
    charts.id = 'charts';
    charts.setAttribute('aria-live', 'polite');
    const color = input.color ?? colors[sources.length % colors.length];
    const s = { id, name: input.name ?? `Source ${sources.length + 1}`, enabled: input.enabled ?? false, color, config: { ...defaultConfig, ...input.config }, layer: new PointsLayer('source-' + id, color), rules, charts, fields: [], loaded: 0, selected: 0, loading: false, done: false, request: 0, filterRequest: 0, filtering: false, queryWaiters: [], exportRequest: 0, exporting: false, exportStatus: '', colorRequest: 0, coloring: { field: '', bins: 24, low: '#2463d4', high: '#ee5539', ...input.coloring }, colorLegend: '', metrics: {}, status: 'Ready. Load this source to analyze it.', error: false, filterStatus: '' } as unknown as Source;
    s.workspace = new Workspace(kind => { if (kind === 'charts') void refreshQuery(s); else state(); }, rules, charts, id, () => sources.map(source => ({ id: source.id, name: source.name, workspace: source.workspace, enabled: source.enabled, available: source.enabled && source.done })), expression => inspectExpression(s, expression));
    sources.push(s);
    const saved = savedAnalyses.get(id);
    if (saved) {
        s.fields = structuredClone(saved.fields);
        s.workspace.fields = s.fields;
        s.workspace.restore(saved.expression, saved.charts);
    }
    return s;
}
// Query-driven fixtures remain available for automated tests and benchmarks;
// an ordinary first visit starts with an empty, server-agnostic source list.
if (!settings.sources.length && (params.has('points') || params.has('url'))) {
    const url = new URL(params.get('url') ?? '/wfs', location.href);
    for (const key of ['points', 'distribution']) if (params.has(key)) url.searchParams.set(key, params.get(key)!);
    settings.sources.push({ id: createUUID(), name: 'WFS source', enabled: true, config: { ...defaultConfig, url: url.href, layer: params.get('layer') ?? 'demo:points' } });
}
for (const [i, source] of settings.sources.entries()) createSource(source, i === 0);
filterSourceId = filterSource()?.id ?? '';
function snapshot(): Settings {
    return { sources: sources.map(({ id, name, enabled, color, config, coloring }) => ({ id, name, enabled, color, config, coloring })), background: { ...background }, map: structuredClone(mapSettings) };
}
function persist() {
    try { localStorage.setItem(settingsKey, JSON.stringify(snapshot())); }
    catch { status('Could not save analysis preferences in this browser.', true); }
}
function renderSources() {
    const enabledSources = sources.filter(s => s.enabled);
    filterSourceId = filterSource()?.id ?? '';
    for (const id of ['filterSource', 'chartSource', 'exportSource']) {
        const select = $<HTMLSelectElement>(id), previous = select.value;
        select.replaceChildren(...enabledSources.map(s => new Option(s.name, s.id)));
        if (!enabledSources.length) select.add(new Option('No enabled data sources', ''));
        select.disabled = !enabledSources.length;
        if (enabledSources.some(s => s.id === previous)) select.value = previous;
    }
    $<HTMLSelectElement>('filterSource').value = filterSourceId;
    const current = filterSource();
    if (current && $('rules') !== current.rules) switchFilters(current.id);
    if (!current) {
        // Detach the old editor so its filters survive disabling/re-enabling.
        const empty = document.createElement('div'); empty.id = 'rules';
        $('rules').replaceWith(empty);
    }
    pointColors.refresh();
}
const sourceSettings = new DataSources(snapshot(), applySettings);
const pointColors = new PointColors(() => sources, (source, previous) => {
    const s = sources.find(s => s.id === source.id)!;
    s.layer.color = s.color;
    sourceSettings.syncColoring(s); persist();
    if (s.fields.find(f => f.name === s.coloring.field)?.kind === 'number' && s.layer.colorCodes && previous.field === s.coloring.field && previous.bins === s.coloring.bins) s.layer.setPalette(s.coloring.low, s.coloring.high);
    else applyColors(s);
    mapLegend.update(sources);
    map.triggerRepaint();
});
function applySettings(next: Settings, restore = false) {
    for (const s of [...sources]) if (restore || !next.sources.some(n => n.id === s.id)) {
        clearSource(s); s.workspace.reset(); sources.splice(sources.indexOf(s), 1);
    }
    const load: Source[] = [];
    for (const input of next.sources) {
        let s = sources.find(s => s.id === input.id);
        if (!s) { s = createSource(input); if (s.enabled) load.push(s); }
        else {
            const changed = configIdentity(s.config) !== configIdentity(input.config), wasEnabled = s.enabled;
            s.name = input.name; s.config = { ...input.config }; s.enabled = input.enabled;
            if (changed || !s.enabled) clearSource(s);
            if (s.enabled && (changed || !wasEnabled)) load.push(s);
        }
    }
    background = { ...next.background };
    if (next.map) {
        mapSettings = structuredClone(next.map);
        if (restore) preserveMapView = true;
        $<HTMLInputElement>('size').value = String(mapSettings.pointSize);
        for (const s of sources) s.layer.pointSize = mapSettings.pointSize;
        map.jumpTo({ center: mapSettings.center, zoom: mapSettings.zoom });
    }
    applyBackground();
    if (!sources.length) {
        $('charts').replaceChildren();
        const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Add a data source to create charts from its attributes.'; $('charts').append(empty);
        popup?.remove();
    }
    renderSources();
    for (const s of sources) s.workspace.refreshSources();
    state();
    for (const s of load) loadSource(s);
    if (currentAnalysis) rememberBindings(snapshot());
}
function switchFilters(id: string) {
    const previous = filterSource();
    const s = sources.find(s => s.enabled && s.id === id);
    if (!s)
        return;
    filterSourceId = id;
    $('rules').replaceWith(s.rules);
    previous?.workspace.visibilityChanged();
    s.workspace.visibilityChanged();
    $<HTMLSelectElement>('filterSource').value = id;
    state();
}
function route() {
    const config = location.hash === '#configuration', records = location.hash === '#records';
    recordPage.root.hidden = !records;
    $('configuration').hidden = !config;
    $('analysis').hidden = config || records;
    for (const s of sources)
        s.workspace.visibilityChanged();
    $('configLink').classList.toggle('current', config);
    $('analysisLink').classList.toggle('current', !config && !records);
    $('recordsLink').classList.toggle('current', records);
    for (const [id, active] of [['analysisLink', !config && !records], ['configLink', config], ['recordsLink', records]] as const) $(id).setAttribute('aria-current', active ? 'page' : 'false');
    if (mapReady) {
        requestAnimationFrame(() => map.resize());
        if (!config) ensureSourcesLoaded();
    }
    state();
}
window.addEventListener('hashchange', route);
$('filterSource').onchange = () => switchFilters(value('filterSource'));
$('chartSource').onchange = state;
$('exportSource').onchange = state;
const gridFeatures: any[] = [];
for (let x = -180; x <= 180; x += 10)
    gridFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[x, -85], [x, 85]] } });
for (let y = -80; y <= 80; y += 10)
    gridFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-180, y], [180, y]] } });
$<HTMLInputElement>('basemap').checked = background.enabled && !!background.url;
const style: StyleSpecification = { version: 8, sources: { grid: { type: 'geojson', data: { type: 'FeatureCollection', features: gridFeatures } }, osm: { type: 'raster', tiles: background.url ? [background.url] : [], tileSize: 256, attribution: background.attribution, maxzoom: 19 } }, layers: [{ id: 'background', type: 'background', paint: { 'background-color': themeColor('map-background') } }, { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: background.enabled && background.url ? 'visible' : 'none' } }, { id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': themeColor('map-grid'), 'line-width': .5 } }] };
const map = new maplibregl.Map({ container: 'map', style, center: mapSettings.center, zoom: mapSettings.zoom, maxZoom: 22, minZoom: 1, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false, renderWorldCopies: false, pixelRatio: Math.min(devicePixelRatio, 2), canvasContextAttributes: { antialias: false }, attributionControl: { compact: true } });
const recordPage = new RecordsPage(() => sources, (id, message) => sources.find(s => s.id === id)?.worker?.postMessage(message), inspectRecord);
let inspectionToken = 0, inspection: RecordRef | undefined, marker: maplibregl.Marker | undefined;
const chooser = document.createElement('dialog'); chooser.className = 'record-chooser'; chooser.setAttribute('aria-label', 'Choose overlapping record'); document.body.append(chooser);
let choices: RecordRef[] = [], choiceOffset = 0;
function inspectRecord(ref: RecordRef) {
    const s = sources.find(s => s.id === ref.sourceId && s.enabled && s.done && !s.filtering); if (!s) return;
    inspectionBatch = undefined;
    inspection = ref; s.worker?.postMessage({ type: 'get', index: ref.index, request: s.request, token: ++inspectionToken });
}
let inspectionQueue: { source: Source; expression: Expression }[] = [];
let inspectionBatch: { token: number; pending: Set<string>; refs: RecordRef[] } | undefined;
function inspectExpression(s: Source, expression: Expression) {
    if ('index' in expression) { inspectRecord({ sourceId: s.id, index: expression.index }); return; }
    if (!s.enabled || !s.done || s.filtering) return;
    inspectionQueue.push({ source: s, expression });
    if (inspectionQueue.length > 1) return;
    // A shared bin emits one field-specific expression per source in the same turn.
    // Collect them before requesting records, so slower sources are not discarded.
    queueMicrotask(() => {
        const queued = inspectionQueue; inspectionQueue = [];
        if (!queued.length) return;
        const token = ++inspectionToken;
        inspectionBatch = { token, pending: new Set(queued.map(q => q.source.id)), refs: [] };
        for (const q of queued) q.source.worker?.postMessage({ type: 'inspectExpression', expression: q.expression, token });
    });
}
function chooseRecords(refs: RecordRef[]) {
    choices = refs; choiceOffset = 0;
    if (refs.length === 1) { inspectRecord(refs[0]); return; }
    if (!refs.length) return;
    drawChooser(); if (!chooser.open) chooser.showModal();
}
function drawChooser() {
    chooser.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = `Choose a record · ${choices.length.toLocaleString()} matches`;
    const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => chooser.close();
    const list = document.createElement('div'); list.className = 'record-choices';
    for (const [k, ref] of choices.slice(choiceOffset, choiceOffset + 30).entries()) {
        const b = document.createElement('button'); b.dataset.sourceId = ref.sourceId; b.dataset.index = String(ref.index); b.textContent = `${sources.find(s => s.id === ref.sourceId)?.name} · row ${ref.index + 1}`; b.onclick = () => { chooser.close(); inspectRecord(ref); }; list.append(b);
        if (!k) setTimeout(() => { if (chooser.open) b.focus(); }, 0);
    }
    const prev = document.createElement('button'), next = document.createElement('button'); prev.textContent = 'Previous matches'; next.textContent = 'Next matches'; prev.disabled = choiceOffset === 0; next.disabled = choiceOffset + 30 >= choices.length;
    prev.onclick = () => { choiceOffset -= 30; drawChooser(); }; next.onclick = () => { choiceOffset += 30; drawChooser(); };
    chooser.append(heading, close, list, prev, next);
    for (const source of sources) { const indices = choices.slice(choiceOffset, choiceOffset + 30).filter(r => r.sourceId === source.id).map(r => r.index); if (indices.length) source.worker?.postMessage({ type: 'getMany', indices, token: inspectionToken }); }
}
function clearInspection() {
    inspectionBatch = undefined; inspectionQueue = [];
    inspectionToken++; inspection = undefined; marker?.remove(); marker = undefined; popup?.remove(); if (chooser.open) chooser.close(); recordPage.clearSelection(); window.dispatchEvent(new CustomEvent('recordinspection', { detail: null }));
}
window.addEventListener('clearinspection', clearInspection);
function rememberMap() {
    const center = map.getCenter().wrap();
    mapSettings = { center: [center.lng, center.lat], zoom: map.getZoom(), pointSize: Number(value('size')) };
    sourceSettings.syncMap(mapSettings);
    // Layout/initial camera events also emit moveend. Keep a first visit and
    // unsaved source drafts unpersisted until the user explicitly saves them.
    if (localStorage.getItem(settingsKey) !== null) persist();
}
map.on('moveend', rememberMap);
const updateMapTheme = () => {
    if (!map.getLayer('background')) return;
    map.setPaintProperty('background', 'background-color', themeColor('map-background'));
    map.setPaintProperty('grid', 'line-color', themeColor('map-grid'));
};
window.addEventListener('themechange', updateMapTheme);
map.on('load', updateMapTheme);
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
    $('map').after($('mapLegend'));
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
    $('map').append($('mapLegend'));
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
    recordPage.refresh();
    const s = filterSource(), enabledSources = sources.filter(s => s.enabled);
    enabled('load', mapReady && enabledSources.some(s => !s.loading));
    enabled('cancel', sources.some(s => s.loading || s.loaded > 0));
    const editable = !!s?.enabled && s.done && !s.filtering;
    enabled('apply', editable);
    enabled('reset', editable);
    enabled('discardFilters', editable && !!s?.workspace.unapplied);
    enabled('undoFilters', editable && !s?.workspace.unapplied && !!s?.workspace.query.canUndo);
    enabled('redoFilters', editable && !s?.workspace.unapplied && !!s?.workspace.query.canRedo);
    $('draftStatus').textContent = s?.workspace.unapplied ? `${s.name} · Unapplied changes` : '';
    $('undoFilters').title = $('redoFilters').title = 'Undo or redo the selected source’s applied filters. Apply or discard draft edits first.';
    const chartSource = sources.find(s => s.id === value('chartSource'));
    enabled('addChart', !!chartSource?.enabled && chartSource.done && chartSource.loaded > 0);
    for (const id of ['fit', 'benchmark']) enabled(id, enabledSources.some(s => s.done && s.loaded > 0));
    status(enabledSources.length ? enabledSources.map(s => s.name + ' · ' + s.status).join('\n') : 'Ready. Add or enable a data source to get started.', enabledSources.some(s => s.error));
    $('filterStatus').textContent = s?.filterStatus ? s.name + ' · ' + s.filterStatus : '';
    $('filterOwner').textContent = s ? `Filters for ${s.name} · ${s.loading ? 'loading…' : !s.done ? 'load source to edit filters' : s.selected.toLocaleString() + ' matching points'}` : 'Add or enable a data source to build filters.';
    $('rules').setAttribute('aria-label', s ? `Filters for ${s.name}` : 'Dataset filters');
    $('rules').inert = !s?.enabled || !s.done;
    $('sourceSummary').textContent = sources.map(s => `${s.name}: ${s.enabled ? s.loading ? 'loading' : s.selected.toLocaleString() + ' displayed' : 'disabled'}${s.workspace.unapplied ? ' · Unapplied changes' : ''}`).join(' · ');
    const progress = $<HTMLProgressElement>('progress');
    if (enabledSources.some(s => s.loading)) progress.removeAttribute('value');
    else progress.value = enabledSources.length && enabledSources.every(s => s.done) ? 1 : 0;
    const exportSource = sources.find(s => s.id === value('exportSource'));
    enabled('exportCSV', !!exportSource?.enabled && exportSource.done && !!exportSource.worker && !exportSource.filtering && !exportSource.exporting);
    let csvStatus = !exportSource ? 'Add or enable a data source to export.' : !exportSource.done ? 'Load this source to export.' : exportSource.filtering ? 'Updating selection…' : exportSource.exportStatus || `${exportSource.selected.toLocaleString()} matching points`;
    if (exportSource?.workspace.unapplied) csvStatus += ' · unapplied edits excluded';
    if (exportSource?.enabled && exportSource.done && exportSource.metrics.truncated) csvStatus += ' · load limit reached; exports loaded points only';
    $('csvExportStatus').textContent = csvStatus;
    pointColors.update();
    mapLegend.update(sources);
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
    if (inspection?.sourceId === s.id || choices.some(r => r.sourceId === s.id)) clearInspection();
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
    finishQuery(s, false);
    s.exportRequest++; s.exporting = s.filtering = false; s.exportStatus = '';
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
    s.colorLabels = s.colorCategories = undefined; s.colorLegend = '';
    s.status = 'Cleared. Load to resume analysis.';
    s.error = false;
    s.workspace.discardObservationSelections();
    s.workspace.suspend();
    s.workspace.refreshSources();
    if (s.id === filterSourceId)
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
    if (s.done && s.loadedConfig === configIdentity(s.config) && s.loadedQuery === JSON.stringify(queryBounds))
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
    const csv = config.type === 'csv';
    const schema = csv ? { fields: [], queryFields: { time: config.timeField, geometry: config.geometryField } } : await describe(s, config);
    if (session !== s.request || !s.enabled)
        return;
    const serverFilter = csv ? undefined : queryFilter(config.version, bounds, schema.queryFields);
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
            finishQuery(s, false); s.filtering = false;
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
            if (m.type === 'chartReply') { const reply = chartReplies.get(m.token); chartReplies.delete(m.token); if (m.error) reply?.reject(Error(m.error)); else reply?.resolve(m.result); return; }
            try {
                if (m.type === 'init') {
                    s.total = m.total;
                    s.layer.allocate(m.capacity);
                    s.status = (csv ? 'Importing CSV points… ' : 'Fetching paged WFS features… ') + (m.warning ?? '');
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
                    s.loadedConfig = configIdentity(config);
                    s.loadedQuery = JSON.stringify(bounds);
                    if (JSON.stringify(s.workspace.fields) !== JSON.stringify(s.fields)) {
                        if (!s.workspace.fields.length) s.workspace.ready(s.fields);
                        else s.workspace.reconfigure(s.fields);
                    }
                    const saved = savedAnalyses.get(s.id);
                    if (saved) {
                        if (saved.fields.every(f => s.fields.some(current => current.name === f.name && current.kind === f.kind))) s.workspace.restore(saved.expression, saved.charts);
                        savedAnalyses.delete(s.id);
                    }
                    for (const source of sources) source.workspace.refreshSources();
                    s.metrics.readyMs = performance.now() - began;
                    s.metrics.gpuBytes = s.layer.gpuBytes;
                    s.status = `${s.loaded.toLocaleString()} points loaded in ${(m.elapsedMs / 1000).toFixed(1)} s.${m.truncated ? ' LIMIT REACHED: dataset is incomplete.' : ''}${m.warning ? '\n' + m.warning : ''}`;
                    if (!bounds.bbox && !preserveMapView) fit();
                    void refreshQuery(s);
                    applyColors(s);
                    resolve();
                }
                if (m.type === 'error') {
                    fail('Load failed: ' + m.message + '\nPartial points are visible; this source’s filters are disabled.');
                    return;
                }
                if (m.type === 'filtered' && m.request === s.filterRequest) {
                    const pending = s.pendingQuery;
                    if (pending) {
                        if (pending.action === 'commit') s.workspace.query.commit(pending.expression);
                        else if (pending.action !== 'refresh') s.workspace.query.move(pending.action);
                    }
                    s.filtering = false;
                    s.workspace.update(m.charts ?? []);
                    s.workspace.settled();
                    s.layer.filter(m.indices);
                    s.selected = m.count;
                    s.metrics.lastFilterMs = m.elapsedMs;
                    s.metrics.analysisCharts = (m.charts ?? []).map((c: any) => ({ id: c.id, type: c.type, bins: c.counts.length, plotted: c.raw?.rows.length ?? c.counts.reduce((a: number, b: number) => a + b, 0), missing: c.missing }));
                    s.metrics.filterCount = m.count;
                    s.metrics.gpuBytes = s.layer.gpuBytes;
                    s.filterStatus = `${s.selected.toLocaleString()} matches · ${m.elapsedMs.toFixed(0)} ms`;
                    recordPage.invalidate(s.id);
                    finishQuery(s, true);
                    void refreshMultiCharts();
                }
                if (m.type === 'colored' && m.request === s.colorRequest) {
                    s.colorCategories = m.categories;
                    s.colorLabels = m.categories ? undefined : m.axis.labels;
                    s.layer.setColors(m.codes, s.coloring.low, s.coloring.high, m.axis.labels.length, !!m.categories);
                    s.colorLegend = m.categories ? `${m.categories.length.toLocaleString()} unique values · grey = missing` : m.axis.labels.length ? `${m.axis.labels[0]} … ${m.axis.labels.at(-1)} · grey = missing` : 'No values';
                }
                if (m.type === 'colorError' && m.request === s.colorRequest) {
                    s.colorLegend = m.message;
                }
                if (m.type === 'filterError' && m.request === s.filterRequest) {
                    s.workspace.settled();
                    s.filtering = false;
                    s.filterStatus = 'Filter error: ' + m.message;
                    finishQuery(s, false);
                    void refreshMultiCharts();
                }
                if (m.type === 'csvExported' && m.request === s.exportRequest && s.enabled && s.done) {
                    s.exporting = false;
                    download(m.blob, csvExportFilename(s.name));
                    s.exportStatus = `${s.selected.toLocaleString()} points exported.`;
                }
                if (m.type === 'csvExportError' && m.request === s.exportRequest) {
                    s.exporting = false;
                    s.exportStatus = 'CSV export failed: ' + m.message;
                }
                recordPage.handle(s.id, m);
                if (m.type === 'inspectionMatches' && m.token === inspectionToken && inspectionBatch && inspectionBatch.token === m.token) {
                    inspectionBatch.refs = inspectionBatch.refs.concat(Array.from(m.indices as Uint32Array, index => ({ sourceId: s.id, index })));
                    inspectionBatch.pending.delete(s.id);
                    if (!inspectionBatch.pending.size) { const refs = inspectionBatch.refs; inspectionBatch = undefined; chooseRecords(refs); }
                }
                if (m.type === 'inspectionError' && m.token === inspectionToken) status(m.message, true);
                if (m.type === 'metadataMany' && m.token === inspectionToken && chooser.open) for (const row of m.rows) {
                    const b = [...chooser.querySelectorAll<HTMLButtonElement>('[data-index]')].find(b => b.dataset.sourceId === s.id && Number(b.dataset.index) === row.index);
                    if (b) b.textContent = `${s.name} · ID ${row.data.id ?? 'null'} · ${row.data.coordinates.join(', ')}`;
                }
                if (m.type === 'metadata' && m.request === s.request && m.data && (m.token === undefined || m.token === inspectionToken)) {
                    inspection = { sourceId: s.id, index: m.index }; recordPage.selection(inspection, m.data);
                    marker?.remove(); marker = new maplibregl.Marker({ color: '#ef9d19' }).setLngLat(m.data.coordinates).addTo(map);
                    window.dispatchEvent(new CustomEvent('recordinspection', { detail: inspection }));
                    if (m.token === undefined || !document.getElementById('analysis')!.hidden) showMetadata(m.data, s);
                }
                state();
            }
            catch (e) {
                fail((e as Error).message);
            }
        };
        if (csv) s.worker!.postMessage({ type: 'loadCSV', config, bounds, fileUser });
        else s.worker!.postMessage({ type: 'load', config: { url: endpoint(config), version: config.version, typeName: config.layer, format: config.format, srs: config.srs, axis: config.axis, pageSize: Number(config.pageSize), limit: Number(config.limit), sort: config.sort, fields: schema.fields, filter: serverFilter } });
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
let chartToken = 0, chartGeneration = 0;
const chartReplies = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>();
function chartRPC(s: Source, message: object): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!s.worker || !s.enabled || !s.done) { reject(Error(`${s.name} is not loaded. Enable and load every chart source.`)); return; }
        const token = ++chartToken;
        const timer = setTimeout(() => { chartReplies.delete(token); reject(Error('Chart calculation timed out. Reload the chart sources.')); }, 120000);
        chartReplies.set(token, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
        s.worker.postMessage({ ...message, token });
    });
}
async function refreshMultiCharts() {
    const generation = ++chartGeneration;
    for (const owner of sources) for (const spec of owner.workspace.specs.filter(c => c.series?.length)) {
        owner.workspace.chartPending(spec.id);
        void (async () => {
            const mappings = [{ sourceId: owner.id, x: spec.x, y: spec.y }, ...spec.series!];
            const members = mappings.map(m => { const s = sources.find(s => s.id === m.sourceId); if (!s?.enabled || !s.done) throw Error('Enable and load every chart source.'); return s; });
            const x = sharedDomain(await Promise.all(mappings.map((m, i) => chartRPC(members[i], { type: 'chartDomain', field: m.x }) as Promise<ChartDomain>)));
            const usesY = spec.type === 'scatter' || spec.type === 'time' && (spec.aggregate ?? 'count') !== 'count';
            const y = usesY ? sharedDomain(await Promise.all(mappings.map((m, i) => chartRPC(members[i], { type: 'chartDomain', field: m.y }) as Promise<ChartDomain>))) : undefined;
            const results: ChartResult[] = await Promise.all(mappings.map((m, i) => chartRPC(members[i], { type: 'chartSeries', spec: { ...spec, series: undefined, x: m.x, y: m.y }, domains: { x, y }, expression: members[i].workspace.query.applied })));
            if (generation !== chartGeneration || !owner.workspace.specs.includes(spec) || members.some(s => !s.enabled || !s.done)) return;
            owner.workspace.updateComparison(combineSeries(spec, results.map((result, i) => ({ sourceId: members[i].id, name: members[i].name, color: seriesColors[i], result }))));
        })().catch(e => { if (generation === chartGeneration) owner.workspace.chartError(spec.id, (e as Error).message); });
    }
}
function finishQuery(s: Source, ok: boolean) {
    s.pendingQuery = undefined;
    for (const resolve of s.queryWaiters.splice(0)) resolve(ok);
}
function analyzeQuery(s: Source): Promise<boolean> {
    if (!s.enabled || !s.done || !s.worker || !s.pendingQuery) return Promise.resolve(false);
    s.filtering = true;
    s.exportRequest++; s.exporting = false; s.exportStatus = '';
    s.workspace.pending();
    s.filterStatus = 'Updating selection and charts…';
    clearInspection();
    const completed = new Promise<boolean>(resolve => s.queryWaiters.push(resolve));
    s.worker.postMessage({ type: 'analyze', request: ++s.filterRequest, expression: s.pendingQuery.expression, charts: s.workspace.specs.filter(c => !c.series?.length && c.x && (c.type !== 'scatter' || c.y)) });
    state();
    return completed;
}
function refreshQuery(s: Source) {
    if (!s.enabled || !s.done) return Promise.resolve(false);
    // Presentation changes may supersede a calculation, but preserve an explicit
    // Apply already in flight. They never read the draft editor.
    s.pendingQuery ??= { expression: s.workspace.query.applied, action: 'refresh' };
    void refreshMultiCharts();
    return analyzeQuery(s);
}
function filter(rules?: Rule[] | Expression, s = filterSource()): Promise<boolean> {
    if (!s?.enabled || !s.done) return Promise.resolve(false);
    let expression: Expression;
    try { expression = Array.isArray(rules) ? all(rules) : rules ?? s.workspace.expression(); }
    catch (error) { s.filterStatus = 'Filter error: ' + (error instanceof Error ? error.message : String(error)); state(); return Promise.resolve(false); }
    expression = 'children' in expression ? expression : { op: 'and', children: [expression] };
    // Programmatic applications must also keep the editor aligned with the query.
    if (rules) s.workspace.restoreFilters(expression);
    s.pendingQuery = { expression: structuredClone(expression), action: 'commit' };
    return analyzeQuery(s);
}
function travelQuery(direction: 'undo' | 'redo') {
    const s = filterSource();
    if (!s?.done || s.filtering || s.workspace.unapplied) return;
    const expression = s.workspace.query.target(direction);
    if (!expression) return;
    s.workspace.restoreFilters(expression);
    s.pendingQuery = { expression, action: direction };
    void analyzeQuery(s);
}
function showMetadata(data: any, source: Source) {
    popup?.remove();
    const div = document.createElement('div');
    div.className = 'metadata';
    div.tabIndex = 0;
    div.setAttribute('role', 'region');
    div.setAttribute('aria-label', 'Point metadata');
    const table = document.createElement('table');
    for (const [k, v] of Object.entries({ wfsSource: source.name, featureId: data.id, longitude: data.coordinates[0], latitude: data.coordinates[1], ...data.properties })) {
        const tr = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
        th.textContent = k;
        td.textContent = v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : source.fields.some(f => f.name === k && f.kind === 'date') ? formatUTC(String(v)) : String(v);
        tr.append(th, td);
        table.append(tr);
    }
    div.append(table);
    popup = metadataPopup(map, data.coordinates, div);
}
map.on('dblclick', e => {
    e.preventDefault();
    const refs: RecordRef[] = [];
    for (const s of layerOrder) if (s.enabled && s.done && !s.filtering) for (const index of s.layer.pickAll(e.point.x, e.point.y)) refs.push({ sourceId: s.id, index });
    inspectionToken++; chooseRecords(refs);
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
    const metrics = filterSource()?.metrics ?? {};
    const selected = sources.filter(s => s.enabled).reduce((n, s) => n + s.selected, 0);
    metrics.panZoom = { nominalDurationMs: 6000, actualDurationMs: performance.now() - began, mapFrames: frames.length, frameMedianMs: quantile(frames, .5), frameP95Ms: quantile(frames, .95), frameMaxMs: Math.max(...frames, 0), over33ms: frames.filter(x => x > 33.34).length, rafMedianMs: quantile(raf, .5), rafP95Ms: quantile(raf, .95), pointSize: Number(value('size')), selected, renderer: gpuName() };
    benchmarkRunning = false;
    state();
    status(`Pan / zoom: median ${metrics.panZoom.frameMedianMs.toFixed(1)} ms · p95 ${metrics.panZoom.frameP95Ms.toFixed(1)} ms · ${frames.length} frames in 6 s. Export metrics for details.`);
    return metrics.panZoom;
}
$('load').onclick = () => void load();
$('cancel').onclick = clear;
$('addChart').onclick = () => { const s = sources.find(s => s.id === value('chartSource')); if (s) { s.workspace.addChart(); void refreshQuery(s); } };
$('apply').onclick = () => { void filter(); };
$('discardFilters').onclick = () => filterSource()?.workspace.discardDraft();
$('undoFilters').onclick = () => travelQuery('undo');
$('redoFilters').onclick = () => travelQuery('redo');
$('reset').onclick = () => filterSource()?.workspace.clearFilters();
$('fit').onclick = fit;
$('benchmark').onclick = () => void benchmark();
$('size').oninput = () => {
    for (const s of sources)
        s.layer.pointSize = Number(value('size'));
    map.triggerRepaint();
    rememberMap();
};
$<HTMLInputElement>('basemap').onchange = () => { background.enabled = $<HTMLInputElement>('basemap').checked; sourceSettings.syncBackgroundEnabled(background.enabled); applyBackground(); persist(); };
function download(blob: Blob, filename: string) {
    const a = document.createElement('a'), url = URL.createObjectURL(blob);
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('exportCSV').onclick = () => {
    const s = sources.find(s => s.id === value('exportSource'));
    if (!s?.enabled || !s.done || !s.worker || s.filtering || s.exporting) return;
    s.exporting = true; s.exportStatus = `Preparing ${s.selected.toLocaleString()} points…`;
    // Clone the exact applied map indices; never transfer/detach the map's buffer.
    s.worker.postMessage({ type: 'exportCSV', request: ++s.exportRequest, indices: s.layer.indices });
    state();
};
$('export').onclick = () => { const blob = new Blob([JSON.stringify({ sources: sources.map(s => ({ id: s.id, name: s.name, enabled: s.enabled, metrics: s.metrics })) }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'wfs-map-metrics.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
(window as any).__WFS_MAP__ = { map, get layer() { return filterSource()?.layer; }, get metrics() { return filterSource()?.metrics; }, get done() { return filterSource()?.done ?? false; }, load, filter, benchmark, get queryBounds() { return structuredClone(queryBounds); }, get workspace() { return filterSource()?.workspace; }, get sources() { return sources; }, records: recordPage, inspectRecord, chooseRecords, get inspection() { return inspection; }, switchSource: switchFilters, filterSource: (id: string, rules: Rule[] | Expression) => {
        const s = sources.find(s => s.id === id);
        if (s)
            filter(rules, s);
    }, getPoint: (index: number) => { const s = filterSource(); s?.worker?.postMessage({ type: 'get', index, request: s.request }); } };
renderSources();
route();
map.on('load', () => {
    mapReady = true;
    state();
    ensureSourcesLoaded();
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
function ensureSourcesLoaded() {
    for (const s of sources) if (s.enabled && !s.error) loadSource(s);
}
function applyColors(s: Source) {
    const request = ++s.colorRequest;
    s.colorCategories = s.colorLabels = undefined;
    if (s.done && s.coloring.field && !s.fields.some(f => f.name === s.coloring.field && ['number', 'string'].includes(f.kind))) {
        s.coloring = { ...s.coloring, field: '' }; sourceSettings.syncColoring(s); persist();
    }
    if (!s.coloring.field) { s.layer.setColors(undefined); s.colorLegend = ''; }
    else if (s.done) {
        s.colorLegend = 'Updating colours…';
        s.worker?.postMessage({ type: 'colors', request, field: s.coloring.field, bins: s.coloring.bins, categories: s.coloring.categories?.[s.coloring.field] });
    }
}
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
    $('timeSummary').textContent = time ? `${formatUTC(time.start)} → ${formatUTC(time.end)}` : 'All time · no time bound sent to WFS.';
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
        $<HTMLInputElement>('timeStart').value = utcInput(time.start);
        $<HTMLInputElement>('timeEnd').value = utcInput(time.end);
    } else applyTime();
}
function applyTime() {
    try {
        const choice = value('timeWindow');
        const time = choice === 'all' ? undefined : choice === 'custom'
            ? { start: value('timeStart'), end: value('timeEnd') } : timeBounds(Number(choice));
        if (time) validateTime(time);
        queryBounds = { ...queryBounds, time: time ? { start: utcISO(time.start), end: utcISO(time.end) } : undefined };
        $('timeError').hidden = true;
        if (choice === 'custom' && queryBounds.time) {
            $<HTMLInputElement>('timeStart').value = utcInput(queryBounds.time.start);
            $<HTMLInputElement>('timeEnd').value = utcInput(queryBounds.time.end);
        }
        showQueryBounds(); reloadBounds();
    } catch (e) { $('timeError').textContent = (e as Error).message; $('timeError').hidden = false; }
}
$('timeWindow').onchange = chooseTime;
$('timeForm').onsubmit = e => { e.preventDefault(); applyTime(); };
$('clearArea').onclick = () => { queryBounds = { ...queryBounds, bbox: undefined }; showQueryBounds(); reloadBounds(); };
$<HTMLSelectElement>('timeWindow').value = savedQuery?.choice ?? (queryBounds.time ? '24' : 'all');
if (savedQuery?.choice === 'custom') {
    $('customTime').hidden = false; $('applyTime').textContent = 'Apply time range';
    $<HTMLInputElement>('timeStart').value = queryBounds.time ? utcInput(queryBounds.time.start) : '';
    $<HTMLInputElement>('timeEnd').value = queryBounds.time ? utcInput(queryBounds.time.end) : '';
}
showQueryBounds();
map.on('load', showQueryBounds);

async function savedState() {
    if (sources.some(s => s.filtering)) {
        const ok = await Promise.all(sources.filter(s => s.filtering).map(s => new Promise<boolean>(resolve => s.queryWaiters.push(resolve))));
        if (ok.some(result => !result)) throw Error('The query could not be applied. Review the filter error before saving.');
    }
    const drafts = sources.filter(s => s.workspace.unapplied);
    if (drafts.length) {
        const choice = await resolveDrafts(drafts.map(s => s.name));
        if (choice === 'cancel') throw Error('Save cancelled. Unapplied edits are still available.');
        if (choice === 'discard') drafts.forEach(s => s.workspace.discardDraft());
        else {
            // Validate every source before changing any applied query.
            const expressions = drafts.map(s => s.workspace.expression());
            if (drafts.some(s => !s.enabled || !s.done)) throw Error('Enable and load sources with unapplied filters before applying and saving. You can also discard their edits.');
            const ok = await Promise.all(drafts.map((s, i) => filter(expressions[i], s)));
            if (ok.some(result => !result)) throw Error('The query could not be applied. Review the filter error before saving.');
        }
    }
    const analyses: SourceAnalysis[] = sources.map(s => {
        const saved = savedAnalyses.get(s.id);
        return saved && !s.workspace.fields.length ? saved : { id: s.id, fields: s.workspace.fields, expression: s.workspace.query.applied, charts: s.workspace.specs };
    });
    return configurationState(snapshot(), { choice: value('timeWindow'), bounds: queryBounds }, analyses);
}
function resolveDrafts(names: string[]): Promise<'apply' | 'discard' | 'cancel'> {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog'); dialog.className = 'query-resolution'; dialog.setAttribute('aria-label', 'Resolve unapplied filters');
        const title = document.createElement('h2'); title.textContent = 'Unapplied filters';
        const description = document.createElement('p'); description.textContent = `Unapplied changes in ${names.join(', ')}. Apply these filters before saving, or discard edits and save the currently applied query.`;
        const actions = document.createElement('div'); actions.className = 'row';
        let choice: 'apply' | 'discard' | 'cancel' = 'cancel';
        for (const [value, label] of [['apply', 'Apply and continue'], ['discard', 'Discard edits and continue'], ['cancel', 'Cancel']] as const) {
            const button = document.createElement('button'); button.textContent = label; button.onclick = () => { choice = value; dialog.close(); }; actions.append(button);
        }
        dialog.append(title, description, actions); document.body.append(dialog);
        dialog.addEventListener('close', () => { dialog.remove(); state(); resolve(choice); }, { once: true });
        dialog.showModal();
    });
}
mountAnalysisControls(savedState);
