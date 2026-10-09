import { configureHighlights, highlightedRows, onHighlights, replaceHighlights, forgetHighlights } from './highlights.ts';
import { MapMeasure } from './map-measure.ts';
import { MapCoordinates } from './map-coordinates.ts';
import { ServerFilterPanel } from './server-filter-panel.ts';
import { validateServerFilters, type ServerFilter } from './server-filters.ts';
import { sharedDomain, combineSeries, seriesColors } from './multi-charts.ts';
import { Timeline } from './timeline.ts';
import { mountWorkspacePanels } from './workspace-panels.ts';
import type { TimelineExtent } from './timeline-data.ts';
import type { ChartDomain, ChartResult, ChartSpec } from './analysis.ts';
import { RecordsPage } from './records-page.ts';
import { mountPageNavigation } from './page-navigation.ts';
import { DerivedDatasetPanel } from './derived-dataset-panel.ts';
import type { JoinOptions, JoinResult } from './derived-datasets.ts';
import type { RecordRef, RecordData } from './records.ts';
import { colourStops } from './colour-schemes.ts';
import { MapLegend } from './map-legend.ts';
import { mountThemeToggle, themeColor } from './theme.ts';
import { formatUTC, utcISO, utcInput } from './time.ts';
import { createUUID } from './uuid.ts';
import { configurationState, localSettings, type AnalysisState, type SourceAnalysis } from './analysis-state.ts';
import { currentAnalysis, mountAnalysisControls, rememberBindings, localAnalysisKey } from './saved-analysis.ts';
import { fileUser } from './source-storage.ts';
import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { csvExportFilename } from './csv-export.ts';
import { PointsLayer } from './points-layer.ts';
import { metadataPopup } from './metadata-popup.ts';
import { wfsURL, fieldKind, xmlDocument, clampMapLatitude, type Field, type Rule } from './data.ts';
import { Workspace } from './workspace.ts';
import { all, type Expression } from './analysis.ts';
import { PointColors } from './point-colors.ts';
import { DataSources } from './data-sources.ts';
import { configIdentity, defaultConfig, readSettings, settingsKey, type Config, type Settings, type SavedSource, type MapSettings } from './source-settings.ts';
import { queryFilter, timeBounds, validateTime, type QueryBounds, type QueryFields, type MapBounds } from './wfs-query.ts';
import './style.css';
maplibregl.setWorkerUrl(mapLibreWorkerUrl);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
const params = new URLSearchParams(location.search);
$('app').innerHTML = `
<header class="topbar"><div><h1>WFS analysis</h1><span class="hint">Middle-drag to highlight · double-middle-click to clear highlights · Right-drag to filter loaded points · double-right-click to clear dataset filters · double-left-click for metadata</span></div><nav id="workspaceNavigation"></nav><button id="load" class="primary">Load enabled sources</button><button id="cancel" disabled>Cancel / clear</button></header>
<div class="load-strip"><progress id="progress" max="1" value="0"></progress><div id="status" role="status">Ready. Add a data source to get started.</div><div id="sourceSummary" class="hint"></div></div>
<section id="configuration" hidden></section>
<section id="analysis"><section class="query-panel" aria-labelledby="queryTitle"><div class="query-heading"><h2 id="queryTitle">Time &amp; map area</h2><span class="hint">Applies to all enabled sources · WFS requests and CSV rows</span></div><form id="timeForm" class="query-controls"><label for="timeWindow">Time window</label><select id="timeWindow"><option value="1">Last hour</option><option value="6">Last 6 hours</option><option value="24" selected>Last 24 hours</option><option value="168">Last 7 days</option><option value="custom">Custom range</option><option value="all">All time</option></select><div id="customTime" class="query-controls" hidden><span id="utcTimeHelp" class="hint">24-hour clock · UTC · YYYY-MM-DD HH:mm:ss</span><label for="timeStart">Start (UTC)</label><input id="timeStart" type="text" placeholder="YYYY-MM-DD HH:mm:ss" aria-describedby="utcTimeHelp"><label for="timeEnd">End (UTC)</label><input id="timeEnd" type="text" placeholder="YYYY-MM-DD HH:mm:ss" aria-describedby="utcTimeHelp"></div><button id="applyTime" class="primary" type="submit">Refresh time window</button></form><p id="timeSummary" class="hint" role="status"></p><p id="timeError" class="error" role="alert" hidden></p><div class="query-area"><span id="areaSummary" class="hint">All map areas · no area bound on loading.</span><button id="drawArea" type="button" aria-pressed="false">Draw load area on map</button><button id="clearArea" hidden>Clear map area</button></div><details id="advancedServerFilters" class="server-filter-panel"><summary>Advanced server filters</summary></details></section><div class="analysis-controls"><details class="colour-panel" open><summary>Point colouring</summary><p class="hint">Choose a source to style. Single colour for all points, discrete colours for text, or a gradient for numbers. Each source keeps its own settings.</p><div class="source-controls"><div class="source-control"><label for="colorSource">Colour data source</label><select id="colorSource"></select></div><div class="source-control"><label for="colorAttribute">Point colour attribute</label><select id="colorAttribute"></select></div><div id="solidColorControl" class="source-control"><label for="sourceColor">Single source colour</label><input id="sourceColor" type="color"></div><div data-gradient-control class="source-control"><label for="colorBins">Colour bins</label><select id="colorBins"><option>8</option><option selected>24</option><option>64</option></select></div><div data-gradient-control class="source-control"><label for="colorScale">Colour bin scale</label><select id="colorScale"><option value="linear">Linear</option><option value="log10">Log10</option></select></div><div data-gradient-control class="source-control"><label for="colorScheme">Colour scheme</label><select id="colorScheme"></select></div><span id="colorRamp" aria-hidden="true"></span></div><div id="categoryColors" hidden><label for="categorySearch">Find a value</label><input id="categorySearch" type="search" placeholder="Search unique values"><div id="categoryColorList"></div><button id="moreCategoryColors" type="button">Show more values</button><p id="categoryColorCount" class="hint"></p></div><p id="colorLegend" class="hint" role="status"></p></details><details class="filter-panel" open><summary>Dataset filters</summary><p class="hint">Filters apply to points already loaded for this source. Chart selections use the highlighted AND / OR group. Edit a group to select it.</p><div class="query-area"><span id="localAreaSummary" class="hint" role="status">All loaded map areas · right-drag a box on the map to filter all sources.</span><button id="clearLocalArea" type="button" hidden>Clear local map area</button></div><div class="source-controls"><div class="source-control"><label for="filterSource">Filter data source</label><select id="filterSource"></select></div><span id="filterOwner" class="hint"></span></div><div id="rules"></div><div class="row filter-actions"><button id="apply" class="primary" disabled>Apply filters</button><button id="reset" disabled>Clear filters</button><span id="filterStatus" role="status"></span></div></details></div>

<div class="analysis-grid"><div class="map-panel"><div class="map-tools"><button id="fit" disabled>Fit dataset</button><label for="size">Point size</label><input id="size" type="range" min="1" max="8" step="0.5" value="2"><label><input id="basemap" type="checkbox"> Basemap</label><span id="drawAreaHelp" class="hint" role="status" hidden>Left-drag to draw the load area · Escape to cancel</span><button id="toggleEllipses" aria-label="Show ellipses" aria-pressed="false" title="Show ellipses"><svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true"><ellipse cx="11" cy="8" rx="9" ry="5" transform="rotate(-25 11 8)" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button><button id="measureMap" type="button" aria-label="Measure distance" aria-pressed="false" title="Measure distance"><svg width="22" height="18" viewBox="0 0 22 18" aria-hidden="true"><path d="M3 14 16 1 21 6 8 19Z" transform="translate(0 -2)" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m7 8 3 3m1-7 3 3m1-7 3 3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button><details id="ellipseResolution" class="ellipse-resolution"><summary aria-label="Ellipse settings" title="Ellipse settings">⚙</summary><div class="ellipse-options">
<div class="ellipse-option"><label for="ellipseVertices">Vertices per ellipse</label><input id="ellipseVertices" type="number" min="4" max="128" step="1" value="12" aria-describedby="ellipseVerticesHint"><p id="ellipseVerticesHint" class="hint">4–128 · curved ends get more samples</p></div>
<div class="ellipse-option"><label for="ellipseDetail">Outline detail</label><select id="ellipseDetail"><option value="auto">Automatic (fast in dense views)</option><option value="all">Every point</option></select></div>
</div></details><button id="enlargeMap" aria-label="Enlarge map" aria-haspopup="dialog" aria-expanded="false">⤢</button></div><main id="map"><div id="hud">Loaded 0 points</div></main><aside id="mapLegend" class="map-legend" aria-label="Map legend" hidden></aside></div><section class="charts-panel"><div class="charts-head"><div><h2>Attribute charts</h2><span class="hint">Middle-drag to highlight · double-middle-click to clear highlights · Click a segment · left-drag charts to zoom · right-drag to select · double-left-click to reset zoom · double-right-click to clear dataset filters</span></div><div class="source-controls"><div class="source-control"><label for="chartSource">New chart data source</label><select id="chartSource"></select></div><button id="addChart" disabled>+ Add chart</button></div></div><div id="charts" aria-live="polite"><p class="empty">Load datasets to create charts from their attributes.</p></div></section></div>
<details class="colour-panel csv-export-panel" open><summary>CSV export</summary><p class="hint">Download one source’s displayed selection, including its attributes and coordinates. Respects applied dataset/chart filters and the time and map-area bounds.</p><div class="source-controls"><div class="source-control"><label for="exportSource">Export data source</label><select id="exportSource"></select></div><button id="exportCSV" disabled>Download CSV</button><span id="csvExportStatus" class="hint" role="status"></span></div></details>
<details class="measurements"><summary>Performance measurements</summary><div class="row"><button id="benchmark" disabled>Run pan / zoom test</button><button id="export">Download metrics</button></div><p class="hint">Offline grid by default. Frame intervals depend on GPU and point density.</p></details></section><div id="timelineHost" hidden></div>`;
mountThemeToggle(document.querySelector('.topbar')!);
const updateNavigation = mountPageNavigation($('workspaceNavigation'));
const derivedPage = document.createElement('section'); derivedPage.id = 'derived'; derivedPage.className = 'derived-page'; derivedPage.hidden = true;
const derivedHeading = document.createElement('h2'); derivedHeading.textContent = 'Derived datasets';
derivedPage.append(derivedHeading); $('app').append(derivedPage);
const mapLegend = new MapLegend($('mapLegend'), (id, visible) => {
    const s = sources.find(s => s.id === id);
    if (!s) return;
    s.mapVisible = visible;
    s.layer.visible = visible && (!s.mapHidden.size || !!s.layer.mapMask);
    if (!visible && inspection?.sourceId === id) { popup?.remove(); marker?.remove(); }
    mapLegend.update(sources);
    map.triggerRepaint();
}, (id, key, visible) => {
    const s = sources.find(s => s.id === id);
    if (!s) return;
    visible ? s.mapHidden.delete(key) : s.mapHidden.add(key);
    refreshMapMask(s);
    mapLegend.update(sources);
});
type Source = {
    id: string;
    name: string;
    enabled: boolean;
    mapVisible: boolean;
    mapHidden: Set<string>;
    mapMaskRequest: number;
    mapMaskPending: boolean;
    color: [
        number,
        number,
        number
    ];
    config: Config;
    serverFilters: ServerFilter[];
    loadedServerFilters?: string;
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
    timeline?: TimelineExtent;
    timelinePending?: boolean;
    loadedConfig?: string;
    loadedQuery?: string;
};
const colors: [
    number,
    number,
    number
][] = [[.02, .45, .68], [.83, .39, .17], [.5, .31, .71], [.05, .59, .42], [.75, .24, .43], [.35, .4, .55], [.57, .52, .15], [.1, .6, .65]];
let localAnalysis: AnalysisState | undefined;
if (!currentAnalysis) { try { localAnalysis = JSON.parse(localStorage.getItem(localAnalysisKey()) ?? 'null') ?? undefined; } catch {} }
const initialState = currentAnalysis?.state ?? localAnalysis;
const settings = readSettings();
const savedAnalyses = new Map((initialState?.analyses ?? []).map(s => [s.id, structuredClone(s)]));
let background = settings.background;
let mapSettings: MapSettings = settings.map ?? { center: [-3, 54], zoom: 5, pointSize: 2 };
let preserveMapView = !!settings.map;
$<HTMLInputElement>('size').value = String(mapSettings.pointSize);
const sources: Source[] = [];
configureHighlights({
    select: request => chartRPC(sources.find(s => s.id === request.sourceId)!, { type: 'highlightRows', ...request }),
    counts: (sourceId, chart, rows) => chartRPC(sources.find(s => s.id === sourceId)!, { type: 'highlightCounts', chart, rows })
});
onHighlights(() => {
    for (const source of sources) source.layer.setHighlights(highlightedRows.get(source.id) ?? new Uint32Array());
    map.getCanvas().dataset.highlighted = String([...highlightedRows.values()].reduce((n, rows) => n + rows.length, 0));
});

const queryPanel = document.querySelector<HTMLElement>('.query-panel')!;
const filterPanel = document.querySelector<HTMLElement>('.filter-panel')!;
const timeline = new Timeline($('timelineHost'), () => {
    clearInspection();
    for (const s of sources) if (s.enabled && s.done && s.timeline?.valid) {
        s.timelinePending = true;
        if (!s.filtering) filter(undefined, s, true);
    }
    refreshMultiCharts();
});
timeline.restoreWindow(initialState?.timeline);
const savedQuery = initialState?.query;
let queryBounds: QueryBounds = savedQuery ? { ...structuredClone(savedQuery.bounds), ...(savedQuery.choice === 'all' ? { time: undefined } : savedQuery.choice !== 'custom' ? { time: timeBounds(Number(savedQuery.choice)) } : {}) } : params.get('time') === 'all' ? {} : { time: timeBounds(24) };
if (queryBounds.time) queryBounds.time = { start: utcISO(queryBounds.time.start), end: utcISO(queryBounds.time.end) };
let localMapBounds: MapBounds | undefined = initialState?.localMapBounds ? structuredClone(initialState.localMapBounds) : undefined;
let filterSourceId = '', popup: maplibregl.Popup | undefined, benchmarkRunning = false, mapReady = false, loadSlots = 0;
const loadQueue: Source[] = [];
const layerOrder: Source[] = [];
function filterSource(): Source | undefined { return sources.find(s => s.enabled && s.id === filterSourceId) ?? sources.find(s => s.enabled); }
function createSource(input: {
    id?: string;
    name?: string;
    enabled?: boolean;
    config?: Config;
    serverFilters?: ServerFilter[];
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
    const s = { id, name: input.name ?? `Source ${sources.length + 1}`, enabled: input.enabled ?? false, color, config: { ...defaultConfig, ...input.config }, serverFilters: structuredClone(input.serverFilters ?? []), layer: new PointsLayer('source-' + id, color), rules, charts, fields: [], loaded: 0, selected: 0, loading: false, done: false, request: 0, filterRequest: 0, filtering: false, exportRequest: 0, exporting: false, exportStatus: '', colorRequest: 0, coloring: { field: '', bins: 24, low: '#2463d4', high: '#ee5539', ...input.coloring }, colorLegend: '', metrics: {}, status: 'Ready. Load this source to analyze it.', error: false, filterStatus: '' } as unknown as Source;
    s.workspace = new Workspace(() => filter(undefined, s), rules, charts, id, () => sources.map(source => ({ id: source.id, name: source.name, workspace: source.workspace, enabled: source.enabled, available: source.enabled && source.done })), expression => inspectExpression(s, expression), clearDatasetFilters);
    sources.push(s);
    s.mapVisible = true; s.mapHidden = new Set(); s.mapMaskRequest = 0; s.mapMaskPending = false;
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
    return { sources: sources.map(({ id, name, enabled, color, config, coloring, serverFilters }) => ({ id, name, enabled, color, config, coloring, serverFilters })), background: { ...background }, map: structuredClone(mapSettings) };
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
    serverFilterPanel.refresh();
}
const sourceSettings = new DataSources(snapshot(), applySettings, async config => (await describe(undefined, config)).fields.map(f => f.name));
const pointColors = new PointColors(() => sources, (source, previous) => {
    const s = sources.find(s => s.id === source.id)!;
    s.layer.color = s.color;
    sourceSettings.syncColoring(s); persist();
    if (previous.field !== s.coloring.field || previous.bins !== s.coloring.bins || (previous.scale ?? 'linear') !== (s.coloring.scale ?? 'linear')) {
        s.mapHidden.clear(); refreshMapMask(s);
    }
    if (s.fields.find(f => f.name === s.coloring.field)?.kind === 'number' && s.layer.colorCodes && previous.field === s.coloring.field && previous.bins === s.coloring.bins && (previous.scale ?? 'linear') === (s.coloring.scale ?? 'linear')) s.layer.setPalette(colourStops(s.coloring.scheme));
    else applyColors(s);
    mapLegend.update(sources);
    map.triggerRepaint();
});
const serverFilterPanel = new ServerFilterPanel($<HTMLDetailsElement>('advancedServerFilters'), () => sources,
    async input => {
        const s = sources.find(s => s.id === input.id)!;
        if (s.config.type !== 'csv') return (await describe(undefined, { ...s.config })).fields;
        return new Promise<Field[]>((resolve, reject) => {
            const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
            const timer = setTimeout(() => { worker.terminate(); reject(Error('CSV field discovery timed out. Retry after checking the file.')); }, 120000);
            worker.onmessage = e => { clearTimeout(timer); worker.terminate(); e.data.error ? reject(Error(e.data.error)) : resolve(e.data.fields); };
            worker.onerror = e => { clearTimeout(timer); worker.terminate(); reject(Error(e.message)); };
            worker.postMessage({ type: 'csvSchema', config: { ...s.config }, fileUser });
        });
    }, (input, rules) => {
        const s = sources.find(s => s.id === input.id)!;
        s.serverFilters = rules; sourceSettings.syncServerFilters(s); persist();
        loadSource(s); state();
    });
function applySettings(next: Settings, restore = false) {
    if (restore) setLocalMapBounds(undefined);
    for (const s of [...sources]) if (restore || !next.sources.some(n => n.id === s.id)) {
        clearSource(s); s.workspace.reset(); sources.splice(sources.indexOf(s), 1);
    }
    const load: Source[] = [];
    for (const input of next.sources) {
        let s = sources.find(s => s.id === input.id);
        if (!s) { s = createSource(input); if (s.enabled) load.push(s); }
        else {
            const changed = configIdentity(s.config) !== configIdentity(input.config) || JSON.stringify(s.serverFilters) !== JSON.stringify(input.serverFilters ?? []), wasEnabled = s.enabled;
            s.name = input.name; s.config = { ...input.config }; s.serverFilters = structuredClone(input.serverFilters ?? []); s.enabled = input.enabled;
            if (changed || !s.enabled) clearSource(s);
            if (changed) s.fields = [];
            if (s.enabled && (changed || !wasEnabled)) load.push(s);
        }
    }
    background = { ...next.background };
    if (next.map) {
        mapSettings = structuredClone(next.map);
        if (restore) preserveMapView = true;
        $<HTMLInputElement>('size').value = String(mapSettings.pointSize);
        for (const s of sources) s.layer.pointSize = mapSettings.pointSize;
        syncEllipses();
        map.jumpTo({ center: mapSettings.center, zoom: mapSettings.zoom });
    }
    applyBackground();
    if (!sources.length) {
        $('charts').replaceChildren();
        const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Add a data source to create charts from its attributes.'; $('charts').append(empty);
        popup?.remove();
    }
    serverFilterPanel.refresh(true);
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
    const config = location.hash === '#configuration', records = location.hash === '#records', derived = location.hash === '#derived';
    recordPage.root.hidden = !records;
    $('configuration').hidden = !config;
    $('analysis').hidden = config || records || derived;
    derivedPage.hidden = !derived;
    if (records) switchFilters(recordPage.sourceId);
    for (const s of sources)
        s.workspace.visibilityChanged();
    updateNavigation(config ? 'configuration' : derived ? 'derived' : records ? 'records' : 'analysis');
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
const recordPage = new RecordsPage(() => sources, (id, message) => sources.find(s => s.id === id)?.worker?.postMessage(message), inspectRecord, switchFilters);
mountWorkspacePanels($('app'), queryPanel, filterPanel, timeline.root, () => {
    for (const s of sources) s.workspace.visibilityChanged();
    map.resize();
});
const derivedPanel = new DerivedDatasetPanel(() => sources, runJoin, (source, blob) => sourceSettings.addDerivedSource(source, blob, snapshot()));
derivedPage.append(derivedPanel.root);
function runJoin(leftId: string, rightId: string, options: JoinOptions, save: boolean, signal: AbortSignal, progress: (message: string) => void): Promise<JoinResult> {
    const left = sources.find(s => s.id === leftId), right = sources.find(s => s.id === rightId);
    if (!left?.enabled || !right?.enabled || !left.done || !right.done || left.filtering || right.filtering || !left.worker || !right.worker || leftId === rightId) return Promise.reject(Error('Load two different enabled sources and wait for filters before joining.'));
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./derived-worker.ts', import.meta.url), { type: 'module' }), l = new MessageChannel(), r = new MessageChannel();
        // A source worker may fail before returning its snapshot. Bound that
        // wait; the actual join remains cancellable without a time limit.
        const timer = setTimeout(() => finish(Error('Could not read the source snapshots. Reload both sources and retry.')), 120000);
        const finish = (error?: Error, result?: JoinResult) => {
            clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate();
            for (const channel of [l, r]) { channel.port1.close(); channel.port2.close(); }
            if (error) reject(error); else resolve(result!);
        };
        const abort = () => finish(Error('Join cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        worker.onmessage = event => { const m = event.data; if (m.progress) { clearTimeout(timer); progress(m.progress); } else finish(m.error ? Error(m.error) : undefined, m.result); };
        worker.onerror = event => finish(Error(event.message));
        worker.onmessageerror = () => finish(Error('Could not read the joined dataset. Retry with fewer input rows.'));
        worker.postMessage({ leftPort: l.port1, rightPort: r.port1, options: { ...options, leftName: left.name, rightName: right.name }, save, timeField: left.config.timeField }, [l.port1, r.port1]);
        left.worker!.postMessage({ type: 'joinSnapshot', port: l.port2, scope: options.scope }, [l.port2]);
        right.worker!.postMessage({ type: 'joinSnapshot', port: r.port2, scope: options.scope }, [r.port2]);
    });
}
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
    mapSettings = { ...mapSettings, center: [center.lng, center.lat], zoom: map.getZoom(), pointSize: Number(value('size')) };
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
map.addControl(new MapCoordinates(), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 100 }), 'bottom-right');
const measurement = new MapMeasure(map, $<HTMLButtonElement>('measureMap'));
const mapPanel = document.querySelector<HTMLElement>('.map-panel')!;
function syncEllipses() {
    const enabled = mapSettings.ellipses ?? false;
    const toggle = $<HTMLButtonElement>('toggleEllipses');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.setAttribute('aria-label', enabled ? 'Hide ellipses' : 'Show ellipses');
    toggle.title = enabled ? 'Hide ellipses' : 'Show ellipses';
    $<HTMLInputElement>('ellipseVertices').value = String(mapSettings.ellipseVertices ?? 12);
    $<HTMLSelectElement>('ellipseDetail').value = mapSettings.ellipseFullDetail ? 'all' : 'auto';
    for (const s of sources) { s.layer.ellipsesEnabled = enabled; s.layer.ellipseVertices = mapSettings.ellipseVertices ?? 12; s.layer.ellipseFullDetail = mapSettings.ellipseFullDetail ?? false; }
    map.triggerRepaint();
}
$('ellipseDetail').onchange = () => { mapSettings.ellipseFullDetail = value('ellipseDetail') === 'all'; syncEllipses(); rememberMap(); window.dispatchEvent(new Event('analysischange')); };
$('toggleEllipses').onclick = () => { mapSettings.ellipses = !mapSettings.ellipses; syncEllipses(); rememberMap(); window.dispatchEvent(new Event('analysischange')); };
$('ellipseVertices').oninput = () => {
    const input = $<HTMLInputElement>('ellipseVertices');
    if (input.value && input.checkValidity()) { mapSettings.ellipseVertices = Number(input.value); syncEllipses(); rememberMap(); window.dispatchEvent(new Event('analysischange')); }
};
$('ellipseVertices').onchange = () => {
    const input = $<HTMLInputElement>('ellipseVertices');
    if (!input.checkValidity()) { input.reportValidity(); input.value = String(mapSettings.ellipseVertices ?? 12); return; }
    mapSettings.ellipseVertices = Number(input.value); syncEllipses(); rememberMap(); window.dispatchEvent(new Event('analysischange'));
};
syncEllipses();
const enlargeMap = $<HTMLButtonElement>('enlargeMap');
let mapDialog: HTMLDialogElement | undefined, mapPlaceholder: HTMLElement | undefined;
function restoreMap() {
    const dialog = mapDialog;
    if (!dialog) return;
    mapDialog = undefined;
    window.dispatchEvent(new CustomEvent('timelinehost'));
    $('map').after($('mapLegend'));
    mapPlaceholder?.replaceWith(mapPanel); mapPlaceholder = undefined;
    dialog.close(); dialog.remove();
    enlargeMap.textContent = '⤢';
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
    window.dispatchEvent(new CustomEvent('timelinehost', { detail: dialog }));
    $('map').append($('mapLegend'));
    enlargeMap.textContent = '⤡';
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
    timeline.update(sources.filter(s => s.enabled && s.done).map(s => ({ name: s.name, extent: s.timeline, loaded: s.loaded })), loadSlots === 0 && loadQueue.length === 0);
    recordPage.refresh();
    derivedPanel.refresh();
    const s = filterSource(), enabledSources = sources.filter(s => s.enabled);
    enabled('load', mapReady && enabledSources.some(s => !s.loading));
    enabled('cancel', sources.some(s => s.loading || s.loaded > 0));
    for (const id of ['apply', 'reset']) enabled(id, !!s && s.enabled && s.done && s.loaded > 0);
    const chartSource = sources.find(s => s.id === value('chartSource'));
    enabled('addChart', !!chartSource?.enabled && chartSource.done && chartSource.loaded > 0);
    for (const id of ['fit', 'benchmark']) enabled(id, enabledSources.some(s => s.done && s.loaded > 0));
    status(enabledSources.length ? enabledSources.map(s => s.name + ' · ' + s.status).join('\n') : 'Ready. Add or enable a data source to get started.', enabledSources.some(s => s.error));
    $('filterStatus').textContent = s?.filterStatus ? s.name + ' · ' + s.filterStatus : '';
    $('filterOwner').textContent = s ? `Filters for ${s.name} · ${s.loading ? 'loading…' : !s.done ? 'load source to edit filters' : s.selected.toLocaleString() + ' matching points'}` : 'Add or enable a data source to build filters.';
    $('rules').setAttribute('aria-label', s ? `Filters for ${s.name}` : 'Dataset filters');
    $('rules').inert = !s?.enabled || !s.done;
    $('sourceSummary').textContent = sources.map(s => `${s.name}: ${s.enabled ? s.loading ? 'loading' : s.selected.toLocaleString() + ' displayed' : 'disabled'}`).join(' · ');
    const progress = $<HTMLProgressElement>('progress');
    if (enabledSources.some(s => s.loading)) progress.removeAttribute('value');
    else progress.value = enabledSources.length && enabledSources.every(s => s.done) ? 1 : 0;
    const exportSource = sources.find(s => s.id === value('exportSource'));
    enabled('exportCSV', !!exportSource?.enabled && exportSource.done && !!exportSource.worker && !exportSource.filtering && !exportSource.exporting);
    let csvStatus = !exportSource ? 'Add or enable a data source to export.' : !exportSource.done ? 'Load this source to export.' : exportSource.filtering ? 'Updating selection…' : exportSource.exportStatus || `${exportSource.selected.toLocaleString()} matching points`;
    if (exportSource?.enabled && exportSource.done && exportSource.metrics.truncated) csvStatus += ' · load limit reached; exports loaded points only';
    $('csvExportStatus').textContent = csvStatus;
    pointColors.update();
    mapLegend.update(sources);
    hud();
}
function endpoint(config: Config) { return new URL(config.url, location.href).href; }
async function describe(s: Source | undefined, config: Config): Promise<{ fields: Field[]; queryFields: QueryFields }> {
    const controller = new AbortController();
    if (s) s.abort = controller;
    const timeout = setTimeout(() => controller.abort(), 45000);
    const fallback = { fields: [] as Field[], queryFields: { time: config.timeField, geometry: config.geometryField, attributes: {} } };
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
        return { fields, queryFields: { time: config.timeField || (dates.length === 1 ? reference(dates[0].name) : ''), geometry: config.geometryField || (geometries.length === 1 ? reference(geometries[0].getAttribute('name')!) : ''), namespaces, attributes: Object.fromEntries(fields.map(f => [f.name, reference(f.name)])) } };
    } catch { return fallback; }
    finally { clearTimeout(timeout); if (s?.abort === controller) s.abort = undefined; }
}
function clearSource(s: Source) {
    derivedPanel.invalidateSource(s.id);
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
    s.mapMaskRequest++; s.mapMaskPending = false;
    s.abort?.abort();
    s.worker?.terminate();
    s.worker = undefined;
    forgetHighlights(s.id);
    for (const [token, reply] of chartReplies) if (reply.source === s) { chartReplies.delete(token); reply.reject(Error('Chart source was cleared.')); }
    s.exportRequest++; s.exporting = s.filtering = false; s.exportStatus = '';
    s.timeline = undefined; s.timelinePending = false;
    s.complete?.();
    s.complete = undefined;
    if (mapReady && map.getLayer(s.layer.id))
        map.removeLayer(s.layer.id);
    s.layer = new PointsLayer('source-' + s.id, s.color);
    s.layer.visible = s.mapVisible && !s.mapHidden.size;
    s.layer.pointSize = Number(value('size'));
    s.layer.ellipsesEnabled = mapSettings.ellipses ?? false;
    s.layer.ellipseVertices = mapSettings.ellipseVertices ?? 12;
    s.layer.ellipseFullDetail = mapSettings.ellipseFullDetail ?? false;
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
    if (s.done && s.loadedConfig === configIdentity(s.config) && s.loadedQuery === JSON.stringify(queryBounds) && s.loadedServerFilters === JSON.stringify(s.serverFilters))
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
    if (!['#records', '#derived'].includes(location.hash)) location.hash = '#analysis';
    for (const s of sources)
        if (s.enabled)
            loadSource(s);
}
async function performLoad(s: Source) {
    const session = s.request, config = { ...s.config }, bounds = structuredClone(queryBounds), serverFilters = structuredClone(s.serverFilters);
    s.status = 'Reading feature schema…';
    state();
    const csv = config.type === 'csv';
    const schema = csv ? { fields: [], queryFields: { time: config.timeField, geometry: config.geometryField } } : await describe(s, config);
    if (session !== s.request || !s.enabled)
        return;
    validateServerFilters(serverFilters, csv ? undefined : schema.fields);
    const serverFilter = csv ? undefined : queryFilter(config.version, bounds, schema.queryFields, serverFilters);
    if (serverFilter && [...new URL(endpoint(config)).searchParams.keys()].some(key => ['bbox', 'filter', 'cql_filter', 'featureid', 'resourceid'].includes(key.toLowerCase()))) throw Error('Remove selection parameters from the endpoint URL before using time, map area or advanced server filters.');
    s.fields = schema.fields;
    map.addLayer(s.layer, 'record-highlights');
    layerOrder.push(s);
    s.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const began = performance.now();
    s.metrics = { sourceId: s.id, sourceName: s.name, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, queryBounds: bounds, serverFilters, pointsRequested: Number(new URL(endpoint(config)).searchParams.get('points')) || undefined, viewport: { width: map.getCanvas().width, height: map.getCanvas().height }, devicePixelRatio, pointSize: s.layer.pointSize, distribution: new URL(endpoint(config)).searchParams.get('distribution') ?? undefined, renderer: gpuName(), note: 'Worker and end-to-end frame observations; no GPU timer queries. JSON bytes are uncompressed.' };
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
            if (m.type === 'chartReply') { const reply = chartReplies.get(m.token); chartReplies.delete(m.token); if (m.error) reply?.reject(Error(m.error)); else reply?.resolve(m.result); return; }
            try {
                if (m.type === 'csvScan') s.status = `Scanning CSV types… ${Math.round(m.bytes / m.fileBytes * 100)}% · ${m.rows.toLocaleString()} rows checked`;
                if (m.type === 'init') {
                    s.total = m.total;
                    s.layer.allocate(m.capacity, m.limit);
                    s.status = (csv ? 'Importing CSV points… ' : 'Fetching paged WFS features… ') + (m.warning ?? '');
                }
                if (m.type === 'fields')
                    s.fields = m.fields;
                if (m.type === 'chunk') {
                    s.layer.append(m.offset, m.positions, m.indices, m.groups, m.ellipses, m.ellipseRadius, m.ellipseValidCount);
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
                    s.timeline = m.timeline;
                    s.loading = false;
                    s.done = true;
                    s.loadedConfig = configIdentity(config);
                    s.loadedQuery = JSON.stringify(bounds);
                    s.loadedServerFilters = JSON.stringify(serverFilters);
                    serverFilterPanel.refresh();
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
                    filter(undefined, s);
                    applyColors(s);
                    resolve();
                }
                if (m.type === 'error') {
                    fail('Load failed: ' + m.message + (s.loaded ? '\nPartial points are visible; this source’s filters are disabled.' : '\nNo points were imported.'));
                    return;
                }
                if (m.type === 'filtered' && m.request === s.filterRequest) {
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
                    if (s.timelinePending) filter(undefined, s, true);
                    else if (!sources.some(source => source.enabled && source.filtering)) refreshMultiCharts();
                }
                if (m.type === 'colored' && m.request === s.colorRequest) {
                    s.colorCategories = m.categories;
                    s.colorLabels = m.categories ? undefined : m.axis.labels;
                    s.layer.setColors(m.codes, colourStops(s.coloring.scheme), m.axis.labels.length, !!m.categories);
                    refreshMapMask(s);
                    s.colorLegend = m.categories ? `${m.categories.length.toLocaleString()} unique values · grey = missing` : `${s.coloring.scale === 'log10' ? 'Log10 · ' : ''}${m.axis.labels.length ? `${m.axis.labels[0]} … ${m.axis.labels.at(-1)}` : s.coloring.scale === 'log10' ? 'No positive values' : 'No values'} · grey = ${s.coloring.scale === 'log10' ? `missing or non-positive · ${(m.excluded ?? 0).toLocaleString()} non-positive values` : 'missing'}`;
                }
                if (m.type === 'mapVisibility' && m.request === s.mapMaskRequest) {
                    s.mapMaskPending = false; s.layer.setMapMask(m.mask); s.layer.visible = s.mapVisible;
                }
                if (m.type === 'mapVisibilityError' && m.request === s.mapMaskRequest) {
                    s.mapMaskPending = false; s.mapHidden.clear(); s.layer.setMapMask(undefined); s.layer.visible = s.mapVisible;
                    status('Could not update map visibility: ' + m.message, true);
                }
                if (m.type === 'colorError' && m.request === s.colorRequest) {
                    s.colorLegend = m.message;
                }
                if (m.type === 'filterError' && m.request === s.filterRequest) {
                    s.workspace.settled();
                    s.filtering = false;
                    s.filterStatus = 'Filter error: ' + m.message;
                    if (s.timelinePending) filter(undefined, s, true);
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
                    marker?.remove(); marker = new maplibregl.Marker({ color: '#ef9d19' }).setLngLat([m.data.coordinates[0], clampMapLatitude(m.data.coordinates[1])]).addTo(map);
                    window.dispatchEvent(new CustomEvent('recordinspection', { detail: inspection }));
                    if (m.token === undefined || !document.getElementById('analysis')!.hidden) showMetadata(m.data, s);
                }
                state();
            }
            catch (e) {
                fail((e as Error).message);
            }
        };
        if (csv) s.worker!.postMessage({ type: 'loadCSV', config, bounds, fileUser, serverFilters });
        else s.worker!.postMessage({ type: 'load', config: { url: endpoint(config), version: config.version, typeName: config.layer, format: config.format, srs: config.srs, axis: config.axis, pageSize: Number(config.pageSize), maxParallelRequests: Number(config.maxParallelRequests), stopOnShortPage: config.pagingEnd === 'short', limit: Number(config.limit), sort: config.sort, fields: schema.fields, filter: serverFilter, timeField: schema.queryFields.time, ellipseMajorField: config.ellipseMajorField, ellipseMinorField: config.ellipseMinorField, ellipseOrientationField: config.ellipseOrientationField, ellipseMajorUnit: config.ellipseMajorUnit, ellipseMinorUnit: config.ellipseMinorUnit } });
    });
    if (session === s.request)
        s.complete = undefined;
}
function fit() {
    const bounds = sources.filter(s => s.enabled && s.loaded && s.metrics.bounds?.every(Number.isFinite)).map(s => s.metrics.bounds);
    if (!bounds.length)
        return;
    map.fitBounds([[Math.min(...bounds.map(b => b[0])), clampMapLatitude(Math.min(...bounds.map(b => b[1])))], [Math.max(...bounds.map(b => b[2])), clampMapLatitude(Math.max(...bounds.map(b => b[3])))]], { padding: 35, duration: 0 });
}
const appliedExpressions = new WeakMap<Source, Expression>();
let chartToken = 0, chartGeneration = 0;
const chartReplies = new Map<number, { source: Source; resolve: (value: any) => void; reject: (e: Error) => void }>();
function chartRPC(s: Source, message: object): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!s.worker || !s.enabled || !s.done) { reject(Error(`${s.name} is not loaded. Enable and load every chart source.`)); return; }
        const token = ++chartToken;
        const timer = setTimeout(() => { chartReplies.delete(token); reject(Error('Chart calculation timed out. Reload the chart sources.')); }, 120000);
        chartReplies.set(token, { source: s, resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
        s.worker.postMessage({ ...message, token });
    });
}
let comparisonsRunning = false, comparisonsPending = false;
async function refreshMultiCharts() {
    if (comparisonsRunning) { comparisonsPending = true; return; }
    comparisonsRunning = true; comparisonsPending = false;
    const generation = ++chartGeneration;
    const window = timeline.window ? { ...timeline.window } : undefined;
    const tasks: Promise<void>[] = [];
    for (const owner of sources) for (const spec of owner.workspace.specs.filter(c => c.series?.length)) {
        // Retain the previous plotted snapshot during timeline scrubbing.
        if (!timeline.window) owner.workspace.chartPending(spec.id);
        tasks.push((async () => {
            const mappings = [{ sourceId: owner.id, x: spec.x, y: spec.y }, ...spec.series!];
            const members = mappings.map(m => { const s = sources.find(s => s.id === m.sourceId); if (!s?.enabled || !s.done) throw Error('Enable and load every chart source.'); return s; });
            const x = sharedDomain(await Promise.all(mappings.map((m, i) => chartRPC(members[i], { type: 'chartDomain', field: m.x }) as Promise<ChartDomain>)));
            const usesY = spec.type === 'scatter' || spec.type === 'time' && (spec.aggregate ?? 'count') !== 'count';
            const y = usesY ? sharedDomain(await Promise.all(mappings.map((m, i) => chartRPC(members[i], { type: 'chartDomain', field: m.y }) as Promise<ChartDomain>))) : undefined;
            const results: ChartResult[] = await Promise.all(mappings.map((m, i) => chartRPC(members[i], { type: 'chartSeries', spec: { ...spec, series: undefined, x: m.x, y: m.y }, domains: { x, y }, expression: withLocalMapBounds(appliedExpressions.get(members[i]) ?? all([])), timeline: window && members[i].timeline?.valid ? { ...window, field: members[i].timeline!.field } : undefined })));
            if (generation !== chartGeneration || !owner.workspace.specs.includes(spec) || members.some(s => !s.enabled || !s.done)) return;
            owner.workspace.updateComparison(combineSeries(spec, results.map((result, i) => ({ sourceId: members[i].id, name: members[i].name, color: seriesColors[i], result }))));
        })().catch(e => { if (generation === chartGeneration) owner.workspace.chartError(spec.id, (e as Error).message); }));
    }
    await Promise.all(tasks);
    comparisonsRunning = false;
    if (comparisonsPending) void refreshMultiCharts();
}
function timelineSelection(s: Source) {
    return timeline.window && s.timeline?.valid ? { ...timeline.window, field: s.timeline.field } : undefined;
}
function withLocalMapBounds(expression: Expression): Expression {
    return localMapBounds ? { op: 'and', children: [expression, { op: 'bbox', ...localMapBounds }] } : expression;
}
function filter(rules?: Rule[] | Expression, s = filterSource(), scrubbing = false) {
    if (!s?.enabled || !s.done)
        return;
    let expression: Expression;
    try { expression = scrubbing ? appliedExpressions.get(s) ?? all([]) : Array.isArray(rules) ? all(rules) : rules ?? s.workspace.expression(); }
    catch (error) { s.filterStatus = 'Filter error: ' + (error instanceof Error ? error.message : String(error)); state(); return; }
    s.filtering = true;
    s.timelinePending = false;
    s.exportRequest++; s.exporting = false; s.exportStatus = '';
    if (!scrubbing) s.workspace.pending();
    s.filterStatus = 'Updating selection and charts…';
    if (!scrubbing) clearInspection();
    if (!scrubbing) appliedExpressions.set(s, structuredClone(expression));
    if (!scrubbing) chartGeneration++; // Dataset predicates invalidate comparisons; scrubbing uses bounded snapshots.
    s.worker?.postMessage({ type: 'analyze', request: ++s.filterRequest, expression: withLocalMapBounds(expression), timeline: timelineSelection(s), charts: s.workspace.specs.filter(c => !c.series?.length && c.x && (c.type !== 'scatter' || c.y)) });
    state();
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
    popup = metadataPopup(map, [data.coordinates[0], clampMapLatitude(data.coordinates[1])], div);
}
map.on('dblclick', e => {
    e.preventDefault();
    if (measurement.active) return;
    const refs: RecordRef[] = [];
    for (const s of layerOrder) if (s.enabled && s.done && !s.filtering) for (const index of s.layer.pickAll(e.point.x, e.point.y)) refs.push({ sourceId: s.id, index });
    inspectionToken++; chooseRecords(refs);
});
map.on('webglcontextlost', () => status('GPU context lost; waiting for restoration.', true));
map.on('webglcontextrestored', () => {
    for (const s of sources)
        if (s.enabled && (s.loaded || s.loading) && !map.getLayer(s.layer.id))
            map.addLayer(s.layer, 'record-highlights');
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
$('addChart').onclick = () => { const s = sources.find(s => s.id === value('chartSource')); if (s) { s.workspace.addChart(); filter(undefined, s); } };
$('apply').onclick = () => filter();
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
(window as any).__WFS_MAP__ = { map, get layer() { return filterSource()?.layer; }, get metrics() { return filterSource()?.metrics; }, get done() { return filterSource()?.done ?? false; }, load, filter, benchmark, get queryBounds() { return structuredClone(queryBounds); }, get localMapBounds() { return localMapBounds && structuredClone(localMapBounds); }, get workspace() { return filterSource()?.workspace; }, get sources() { return sources; }, records: recordPage, inspectRecord, chooseRecords, get inspection() { return inspection; }, switchSource: switchFilters, filterSource: (id: string, rules: Rule[] | Expression) => {
        const s = sources.find(s => s.id === id);
        if (s)
            filter(rules, s);
    }, getPoint: (index: number) => { const s = filterSource(); s?.worker?.postMessage({ type: 'get', index, request: s.request }); } };
renderSources();
route();
map.on('load', () => {
    mapReady = true;
    map.addLayer({ id: 'record-highlights', type: 'custom', renderingMode: '2d', render: () => { for (const source of sources) if (source.enabled) source.layer.drawHighlights(); } });
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
function refreshMapMask(s: Source) {
    const request = ++s.mapMaskRequest;
    s.mapMaskPending = false;
    if (!s.mapHidden.size || !s.coloring.field) {
        s.layer.setMapMask(undefined); s.layer.visible = s.mapVisible; return;
    }
    if (!s.done || !s.worker) return;
    s.mapMaskPending = true;
    s.worker.postMessage({ type: 'mapVisibility', request, field: s.coloring.field, bins: s.coloring.bins, scale: s.coloring.scale, hidden: [...s.mapHidden] });
}
function applyColors(s: Source) {
    const request = ++s.colorRequest;
    s.colorCategories = s.colorLabels = undefined;
    if (s.done && s.coloring.field && !s.fields.some(f => f.name === s.coloring.field && ['number', 'string'].includes(f.kind))) {
        s.coloring = { ...s.coloring, field: '' }; sourceSettings.syncColoring(s); persist();
    }
    if (!s.coloring.field) { s.mapHidden.clear(); refreshMapMask(s); s.layer.setColors(undefined); s.colorLegend = ''; }
    else if (s.done) {
        s.colorLegend = 'Updating colours…';
        s.worker?.postMessage({ type: 'colors', request, field: s.coloring.field, bins: s.coloring.bins, scale: s.coloring.scale, categories: s.coloring.categories?.[s.coloring.field] });
    }
}
const mapCanvas = map.getCanvas(), geoBox = document.createElement('div');
geoBox.className = 'geo-box';
geoBox.hidden = true;
$('map').append(geoBox);
let geoStart: [number, number] | undefined, geoPointer: number | undefined;
let drawingLoadArea = false, geoTarget: 'local' | 'load' | 'highlight' = 'local', geoMoved = false;
let lastMiddleClick: { time: number; point: [number, number] } | undefined;
let lastRightClick: { time: number; point: [number, number] } | undefined;
const mapPoint = (e: PointerEvent): [number, number] => {
    const rect = mapCanvas.getBoundingClientRect();
    return [Math.max(0, Math.min(rect.width, e.clientX - rect.left)), Math.max(0, Math.min(rect.height, e.clientY - rect.top))];
};
function armLoadArea(armed: boolean) {
    drawingLoadArea = armed;
    $('drawArea').textContent = armed ? 'Cancel drawing load area' : 'Draw load area on map';
    $('drawArea').setAttribute('aria-pressed', String(armed));
    $('drawAreaHelp').hidden = !armed;
    mapCanvas.style.cursor = armed ? 'crosshair' : '';
}
function cancelGeo() {
    geoStart = undefined; geoBox.hidden = true; lastRightClick = undefined; lastMiddleClick = undefined;
    if (geoPointer !== undefined && mapCanvas.hasPointerCapture(geoPointer)) mapCanvas.releasePointerCapture(geoPointer);
    geoPointer = undefined;
    map.dragPan.enable();
}
mapCanvas.addEventListener('contextmenu', e => e.preventDefault());
mapCanvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
mapCanvas.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
mapCanvas.addEventListener('pointerdown', e => {
    if (e.button !== 2) lastRightClick = undefined;
    if (e.button !== 1) lastMiddleClick = undefined;
    if (measurement.picking || geoStart || !mapReady || !(e.button === 1 || e.button === 2 || e.button === 0 && drawingLoadArea)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    geoTarget = e.button === 0 ? 'load' : e.button === 1 ? 'highlight' : 'local';
    geoBox.dataset.action = geoTarget;
    if (geoTarget === 'local') armLoadArea(false);
    geoStart = mapPoint(e); geoPointer = e.pointerId; geoMoved = false;
    map.dragPan.disable(); mapCanvas.setPointerCapture(e.pointerId);
    geoBox.hidden = false;
    geoBox.style.left = geoStart[0] + 'px'; geoBox.style.top = geoStart[1] + 'px';
    geoBox.style.width = geoBox.style.height = '0';
}, true);
mapCanvas.addEventListener('pointermove', e => {
    if (!geoStart || e.pointerId !== geoPointer) return;
    const p = mapPoint(e);
    if (Math.hypot(p[0] - geoStart[0], p[1] - geoStart[1]) >= 4) geoMoved = true;
    geoBox.style.left = Math.min(p[0], geoStart[0]) + 'px'; geoBox.style.top = Math.min(p[1], geoStart[1]) + 'px';
    geoBox.style.width = Math.abs(p[0] - geoStart[0]) + 'px'; geoBox.style.height = Math.abs(p[1] - geoStart[1]) + 'px';
});
function endGeo(e: PointerEvent) {
    const a = geoStart, target = geoTarget, previousClick = lastRightClick, previousMiddleClick = lastMiddleClick;
    if (!a || e.pointerId !== geoPointer) return;
    const b = mapPoint(e); cancelGeo();
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4) {
        // Browsers do not emit dblclick for the right button. Count only completed
        // stationary clicks; a drag or cancellation breaks the click sequence.
        if (target === 'highlight' && e.button === 1 && !geoMoved) {
            const time = performance.now();
            if (previousMiddleClick && time - previousMiddleClick.time <= 500 && Math.hypot(b[0] - previousMiddleClick.point[0], b[1] - previousMiddleClick.point[1]) <= 6) replaceHighlights();
            else lastMiddleClick = { time, point: b };
        }
        if (target === 'local' && e.button === 2 && !geoMoved) {
            const time = performance.now();
            if (previousClick && time - previousClick.time <= 500 && Math.hypot(b[0] - previousClick.point[0], b[1] - previousClick.point[1]) <= 6) clearDatasetFilters();
            else lastRightClick = { time, point: b };
        }
        return;
    }
    if (target === 'highlight') {
        replaceHighlights(new Map(sources.filter(s => s.enabled && s.done).map(s => [s.id, s.layer.pickRectangle(a, b)])));
        return;
    }
    const nw = map.unproject([Math.min(a[0], b[0]), Math.min(a[1], b[1])]);
    const se = map.unproject([Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
    const bounds = { west: Math.max(-180, Math.min(180, nw.lng)), east: Math.max(-180, Math.min(180, se.lng)), south: Math.max(-90, se.lat), north: Math.min(90, nw.lat) };
    if (target === 'load') {
        armLoadArea(false);
        queryBounds = { ...queryBounds, bbox: bounds }; showQueryBounds(); reloadBounds();
    } else setLocalMapBounds(bounds);
}
mapCanvas.addEventListener('pointerup', endGeo);
mapCanvas.addEventListener('pointercancel', cancelGeo);
mapCanvas.addEventListener('lostpointercapture', () => { if (geoStart) cancelGeo(); });
window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (drawingLoadArea || geoStart)) {
        cancelGeo(); armLoadArea(false); e.preventDefault(); e.stopImmediatePropagation();
    }
}, true);
$('measureMap').onclick = () => {
    cancelGeo(); armLoadArea(false); measurement.toggle();
};
$('drawArea').onclick = () => {
    measurement.clear();
    cancelGeo(); armLoadArea(!drawingLoadArea);
    if (drawingLoadArea) { location.hash = '#analysis'; mapCanvas.focus(); }
};
function clearDatasetFilters() {
    localMapBounds = undefined;
    showLocalMapBounds(); clearInspection(); chartGeneration++;
    for (const s of sources) {
        // Clear disabled/loading sources too, so their saved predicates cannot
        // reappear when a load completes or the source is enabled again.
        savedAnalyses.delete(s.id);
        appliedExpressions.set(s, all([]));
        s.workspace.clearFilters();
    }
    state();
}
function setLocalMapBounds(bounds?: MapBounds) {
    localMapBounds = bounds;
    showLocalMapBounds(); clearInspection(); chartGeneration++;
    // Preserve each source's applied attribute filters, including OR groups and
    // unfinished editor changes. The one shared area is always intersected.
    for (const s of sources) if (s.enabled && s.done) filter(undefined, s, true);
}
$('clearLocalArea').onclick = () => setLocalMapBounds(undefined);
function showLocalMapBounds() {
    $('localAreaSummary').textContent = localMapBounds
        ? `Local map area: ${localMapBounds.west.toFixed(4)}, ${localMapBounds.south.toFixed(4)} to ${localMapBounds.east.toFixed(4)}, ${localMapBounds.north.toFixed(4)} · all data sources`
        : 'All loaded map areas · right-drag a box on the map to filter all sources.';
    $('clearLocalArea').hidden = !localMapBounds;
    showMapArea('local-area', localMapBounds, '#e49a2a', false);
}
function showMapArea(id: string, bbox: MapBounds | undefined, color: string, dashed: boolean) {
    if (!mapReady) return;
    const data: Parameters<maplibregl.GeoJSONSource['setData']>[0] = { type: 'FeatureCollection', features: bbox ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[bbox.west, bbox.south], [bbox.east, bbox.south], [bbox.east, bbox.north], [bbox.west, bbox.north], [bbox.west, bbox.south]]] } }] : [] };
    const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(data);
    else {
        map.addSource(id, { type: 'geojson', data });
        map.addLayer({ id: id + '-outline', type: 'line', source: id, paint: { 'line-color': color, 'line-width': 2, ...(dashed ? { 'line-dasharray': [3, 2] } : {}) } });
    }
}

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
    $('areaSummary').textContent = bbox ? `Map area: ${bbox.west.toFixed(4)}, ${bbox.south.toFixed(4)} to ${bbox.east.toFixed(4)}, ${bbox.north.toFixed(4)} · all enabled sources` : 'All map areas · no area bound on loading.';
    $('clearArea').hidden = !bbox;
    showMapArea('query-area', bbox, '#3984cf', true);
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
map.on('load', () => { showQueryBounds(); showLocalMapBounds(); });
showLocalMapBounds();

function savedState() {
    const pending = sourceSettings.pendingSettings();
    const analyses: SourceAnalysis[] = sources.filter(s => {
        const next = pending.sources.find(source => source.id === s.id);
        // Applying replacement/disabled sources clears load-specific selections.
        // Validate unchanged sources now; serialize changed ones after application.
        return next && next.enabled === s.enabled && configIdentity(next.config) === configIdentity(s.config);
    }).map(s => {
        const saved = savedAnalyses.get(s.id);
        return saved && !s.workspace.fields.length ? saved : { id: s.id, fields: s.workspace.fields, expression: s.workspace.expression(), charts: s.workspace.specs };
    });
    // A newly added source has no schema yet. Omitting its uninitialized workspace
    // lets loading create the usual default charts instead of restoring an empty set.
    return configurationState(pending, { choice: value('timeWindow'), bounds: queryBounds }, analyses.filter(s => s.fields.length || savedAnalyses.has(s.id)), timeline.savedWindow, localMapBounds);
}
mountAnalysisControls(savedState, $('remoteAnalysisControls'), timeline.root.querySelector('.timeline-bar')!, async () => {
    // Validate portable filters before committing sources, then persist the complete state.
    savedState();
    await sourceSettings.save();
    const state = savedState();
    localStorage.setItem(localAnalysisKey(), JSON.stringify(state));
    localStorage.setItem(settingsKey, JSON.stringify(localSettings(state)));
    return state;
});
