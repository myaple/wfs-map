Warning: truncated output (original token count: 11859)
Total output lines: 526

import { createUUID } from './uuid.ts';
import { currentAnalysis } from './saved-analysis.ts';
import { readCSVText, saveSettings } from './source-storage.ts';
import type { CSVPreview } from './csv.ts';
import { csvOptionDefaults, type CSVKind } from './csv-options.ts';
import { createBackup, readBackup } from './source-backup.ts';
import { wfsURL, xmlDocument } from './data.ts';
import { configKeys, defaultConfig, settingsMetadata, validateConfig, validateBackground, type Config, type Settings, type SavedSource, type MapSettings } from './source-settings.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
export class DataSources {
    private draft: Settings;
    private saved: Settings;
    private editing?: SavedSource;
    private discovery?: AbortController;
    private capabilities?: Document;
    private csvText = '';
    private csvRef = '';
    private csvHeaders: string[] = [];
    private csvTypes: Record<string, CSVKind> = {};
    private csvWorker?: Worker;
    private csvRequest = 0;
    private csvReport?: CSVPreview;
    private csvParsing = false;
    private saving = false;
    private fileName = '';
    private fileRevision = 0;
    private removed?: { source: SavedSource; index: number };
    private backupBusy = false;
    private pendingBackup?: Settings;
    constructor(settings: Settings, private apply: (settings: Settings, restore?: boolean) => void) {
        this.draft = structuredClone(settings);
        this.saved = structuredClone(settings);
        $('configuration').innerHTML = `
        <div class="sources-page">
          <div class="sources-heading"><div><h2>Data sources</h2><p class="hint">Connect WFS servers or import CSV points to explore on the map.</p></div><button id="addSource" class="primary">+ Add data source</button></div>
          <section class="settings-card" aria-labelledby="sourcesTitle"><div class="settings-card-head"><h3 id="sourcesTitle">Your data sources</h3><span id="sourceCount" class="hint"></span></div><p class="hint">Enable a source to load it after saving. Configure opens its connection settings.</p><ul id="sourceList" class="source-list"></ul><div id="sourceUndo" hidden><span id="removedName"></span> <button id="undoRemove">Undo remove</button></div></section>
          <details class="settings-card" id="backgroundSettings"><summary>Map background</summary><div class="settings-fields"><label for="basemapURL">Raster basemap tile URL</label><input id="basemapURL" placeholder="https://…/{z}/{x}/{y}.png"><label for="basemapAttribution">Basemap attribution</label><input id="basemapAttribution"><p class="hint">XYZ raster tiles. Leave the URL empty to use the offline grid.</p></div></details>
          <section class="settings-card" aria-labelledby="backupTitle"><h3 id="backupTitle">Backup &amp; share</h3><p class="hint">Download the current list, including unsaved changes and disabled sources, as a .tar.gz. Includes complete CSV files, WFS connection settings, source colours, and map background, view and point size. WFS features are fetched again when loaded.</p><div class="row"><button id="exportBackup">Download backup</button><button id="importBackup">Import backup</button><input id="backupFile" type="file" accept=".tar.gz,.tgz,application/gzip" hidden aria-label="Choose backup archive"></div><p id="backupStatus" class="hint" role="status"></p><p id="backupError" class="error" role="alert" hidden></p></section>
          <details class="settings-card" id="testServer"><summary>Optional test WFS server</summary><p class="hint">Start a local server with generated points to try the app. Add its endpoint using the same connection settings as any WFS source.</p><div class="test-fields"><div><label for="points">Generated point count</label><input id="points" type="number" min="1" max="50000000" value="1000000" required></div><div><label for="distribution">Point distribution</label><select id="distribution"><option value="uk">UK spread</option><option value="world">Worldwide</option><option value="dense">Dense 2 km square</option></select></div></div><div class="row"><button id="startTestServer">Start test server</button><button id="addTestSource" disabled>Add as data source</button></div><p id="testServerStatus" class="hint" role="status">Requires the app’s Node server. The test endpoint stays running until that server restarts.</p><label for="testEndpoint" hidden id="testEndpointLabel">Test WFS endpoint</label><input id="testEndpoint" readonly hidden></details>
          <div class="settings-save"><div><strong id="saveState" role="status">All changes saved</strong><p class="hint">${currentAnalysis ? 'Save applies source changes locally. Use Save analysis above to save the complete setup remotely.' : 'Save applies changes and keeps them in this browser for your next visit.'}</p><p id="saveError" class="error" role="alert" hidden></p></div><div class="row"><button id="discardSettings" disabled>Discard changes</button><button id="saveSettings" class="primary" disabled>Save changes</button></div></div>
        </div>
        <dialog id="backupDialog" class="source-dialog backup-dialog" aria-labelledby="backupDialogTitle"><h2 id="backupDialogTitle">Restore backup</h2><p>This replaces your current source list and map settings, including unsaved changes. Dataset filters and charts are reset. CSV files will be saved in this browser.</p><p id="backupSummary"></p><ul id="backupSources"></ul><p id="restoreError" class="error" role="alert" hidden></p><div class="row"><button id="cancelBackup">Cancel</button><button id="restoreBackup" class="primary">Replace sources &amp; restore</button></div></dialog>
        <dialog id="sourceDialog" class="source-dialog" aria-labelledby="sourceDialogTitle"><form id="sourceForm"><div class="source-dialog-head"><div><h2 id="sourceDialogTitle">Add data source</h2><p class="hint">Choose a source type and configure its dataset.</p></div><button id="closeSource" type="button" aria-label="Close source settings">×</button></div><div class="settings-fields">
          <label for="sourceName">Source name</label><input id="sourceName" required maxlength="120" placeholder="e.g. Weather stations">
          <label for="type">Source type</label><select id="type"><option value="wfs">WFS server</option><option value="csv">CSV file</option></select>
          <fieldset id="wfsFields" class="source-type-fields"><label for="url">WFS endpoint</label><input id="url" required placeholder="https://example.org/geoserver/wfs" aria-describedby="endpointHelp"><p id="endpointHelp" class="hint">HTTP(S) or a relative URL. Server-specific query parameters are kept as entered.</p>
          <div class="discovery-head"><label for="layerSelect">Feature layer</label><button id="discover" type="button">Discover layers</button></div><select id="layerSelect" aria-describedby="layerHelp"></select><div id="customLayer"><label for="layer">Custom layer name</label><input id="layer" required placeholder="e.g. workspace:stations" aria-describedby="layerHelp"></div><p id="layerHelp" class="hint">Discover layers to choose a dataset, or select Custom layer name to enter one yourself.</p><p id="discoveryStatus" class="hint" role="status"></p>
          <details id="wfsCompatibility"><summary>WFS compatibility and limits</summary><div class="settings-fields">
            <label for="version">WFS version</label><select id="version"><option>2.0.0</option><option>1.1.0</option><option>1.0.0</option></select>
            <label for="format">Output format</label><input id="format" required><p class="hint">Use the exact format advertised by the server. GeoJSON is recommended.</p>
            <label for="srs">Requested coordinate reference system</label><input id="srs" required>
            <label for="axis">GML coordinate order</label><select id="axis"><option value="xy">Longitude, latitude</option><option value="yx">Latitude, longitude</option></select><p class="hint">GeoJSON always uses longitude, latitude.</p>
            <label for="timeField">Time attribute (optional override)</label><input id="timeField" placeholder="Auto-detect from schema"><p class="hint">Used for the global time window sent to WFS. Specify the date/time field if discovery is unavailable or ambiguous. Times without a timezone are assumed UTC; explicit offsets are converted to UTC.</p>
            <label for="geometryField">Geometry attribute (optional override)</label><input id="geometryField" placeholder="Auto-detect from schema"><p class="hint">Used for map area requests. Enter the server’s geometry property name, e.g. the_geom.</p>
            <label for="sort">Stable unique sort attribute (optional)</label><input id="sort" placeholder="e.g. id">
            <label for="pageSize">Features per request</label><input id="pageSize" type="number" min="1" max="100000" required>
            <label for="limit">Client point limit</label><input id="limit" type="number" min="1" max="50000000" required>
            <p class="hint">Requires paged GeoJSON or simple GML points and CORS access. WFS 1.x paging depends on the server. Truncation at the client limit is reported.</p>
          </div></details>
          </fieldset><fieldset id="csvFields" class="source-type-fields" hidden disabled>
            <label for="csvFile">CSV file</label><input id="csvFile" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values"><p id="csvFileStatus" class="hint" role="status"></p>
            <label for="delimiter">Delimiter</label><select id="delimiter"><option value=",">Comma</option><option value=";">Semicolon</option><option value="&#9;">Tab</option></select>
            <label for="geometryMode">Geometry format</label><select id="geometryMode"><option value="xy">Longitude / latitude columns</option><option value="wkt">WKT Point column</option><option value="geojson">GeoJSON Point column</option></select>
            <div id="csvXY" class="settings-fields"><label for="longitudeField">Longitude column</label><select id="longitudeField" required></select><label for="latitudeField">Latitude column</label><select id="latitudeField" required></select></div>
            <div id="csvPoint" class="settings-fields" hidden><label for="csvGeometry">Geometry column</label><select id="csvGeometry"></select></div>
            <label for="csvTime">Time attribute (optional)</label><select id="csvTime"></select><p class="hint">ISO 8601 dates/times, using a 24-hour clock. Times without a timezone are assumed UTC; explicit offsets are converted to UTC. Use All time when no time column is selected. Coordinates must be longitude/latitude in WGS84; only points are supported.</p>
            <label for="csvMissingValues">Missing-value tokens (one per line)</label><textarea id="csvMissingValues" rows="3" spellcheck="false" aria-describedby="csvMissingHelp"></textarea><p id="csvMissingHelp" class="hint">Blank or whitespace-only cells are always missing. Other tokens are trimmed and case sensitive; defaults include N/A, NA and NULL.</p>
            <label for="csvInvalidRows">Invalid records</label><select id="csvInvalidRows"><option value="reject">Reject entire import if any record is invalid</option><option value="quarantine">Quarantine invalid records; import valid records only</option></select><p class="hint">Invalid records stay in the original file but are excluded from maps, plots and filtered exports. Malformed quoting or headers always require fixing the file.</p>
            <section class="csv-review" aria-labelledby="csvReviewTitle"><h3 id="csvReviewTitle">Review import</h3><p id="csvReviewStatus" role="status" aria-live="polite">Choose a file to preview.</p><div class="row"><button type="button" id="refreshCSV">Review file</button><button type="button" id="cancelCSV" hidden>Cancel review</button><button type="button" id="csvDiagnostics" disabled>Download diagnostics</button></div><p class="hint">Full-file validation runs locally. Record numbers count the header as 1; quoted newlines stay within their record. Text preserves leading zeros. Date/time values use UTC.</p><div class="csv-table-scroll" tabindex="0" aria-label="Column schema"><table id="csvSchema"></table></div><details id="csvRecordPreview" open><summary>Representative records — raw → interpreted</summary><div class="csv-table-scroll" tabindex="0" aria-label="Representative CSV records"><table id="csvSamples"></table></div></details></section>
            <p class="hint">The imported file is saved in this browser with its settings. Available storage depends on your browser and device; a save error leaves your existing saved sources intact.</p>
          </fieldset>
          <p id="sourceError" class="error" role="alert" hidden></p>
        </div><div class="source-dialog-footer"><span class="hint">Save changes on the page to apply.</span><button id="cancelSource" type="button">Cancel</button><button id="updateSource" class="primary" type="submit">Add to list</button></div></form></dialog>`;
        $('type').onchange = () => { this.stopDiscovery(); this.showType(); };
        $('geometryMode').onchange = () => { this.showGeometry(); this.reviewCSV(); };
        $('delimiter').onchange = () => this.inspectCSV();
        for (const id of ['longitudeField', 'latitudeField', 'csvGeometry', 'csvTime', 'csvInvalidRows']) $(id).onchange = () => this.reviewCSV();
        $('csvMissingValues').oninput = () => { this.csvRequest++; this.csvReport = undefined; this.csvSubmitState(); $<HTMLButtonElement>('csvDiagnostics').disabled = true; $('csvReviewStatus').textContent = 'Missing-value tokens changed. Leave this field or click Review file to validate.'; };
        $('csvMissingValues').onchange = () => this.reviewCSV();
        $('refreshCSV').onclick = () => {
            if (this.csvText) this.inspectCSV();
            else if (input('csvFile').files?.length) void this.readCSV();
            else if (this.csvRef) void this.restoreCSV(this.config(), this.fileRevision);
            else this.showError(Error('Choose a CSV file.'));
        };
        $('cancelCSV').onclick = () => this.cancelCSV();
        $('csvDiagnostics').onclick = () => { if (this.csvReport) this.downloadCSVReport(this.csvReport.diagnostics); };
        $('csvFile').onchange = () => void this.readCSV();
        $('exportBackup').onclick = () => void this.exportBackup();
        $('importBackup').onclick = () => input('backupFile').click();
        $('backupFile').onchange = () => void this.importBackup();
        $('cancelBackup').onclick = () => this.cancelBackup();
        $<HTMLDialogElement>('backupDialog').addEventListener('cancel', e => { e.preventDefault(); this.cancelBackup(); });
        $('restoreBackup').onclick = () => void this.restoreBackup();
        input('basemapURL').value = settings.background.url;
        input('basemapAttribution').value = settings.background.attribution;
        for (const id of ['basemapURL', 'basemapAttribution']) $(id).oninput = () => {
            this.draft.background.url = input('basemapURL').value.trim();
            this.draft.background.attribution = input('basemapAttribution').value;
            this.updateState();
        };
        $('addSource').onclick = () => this.open();
        for (const id of ['closeSource', 'cancelSource']) $(id).onclick = () => this.close();
        $<HTMLDialogElement>('sourceDialog').addEventListener('cancel', () => this.close());
        $('sourceForm').onsubmit = e => { e.preventDefault(); this.updateSource(); };
        for (const id of ['url', 'version']) $(id).addEventListener('input', () => { this.stopDiscovery(); this.resetLayers(); $('discoveryStatus').textContent = ''; });
        $('layerSelect').onchange = () => {
            const name = $<HTMLSelectElement>('layerSelect').value;
            if (name) input('layer').value = name;
            this.showCustomLayer();
            if (name) this.updateDiscoveredFormat();
            else input('layer').focus();
        };
        $('discover').onclick = () => void this.discover();
        $('saveSettings').onclick = () => this.save();
        $('discardSettings').onclick = () => { this.draft = structuredClone(this.saved); input('basemapURL').value = this.draft.background.url; input('basemapAttribution').value = this.draft.background.attribution; this.removed = undefined; this.render(); };
        $('undoRemove').onclick = () => { if (this.removed) this.draft.sources.splice(this.removed.index, 0, this.removed.source); this.removed = undefined; this.render(); };
        $('startTestServer').onclick = () => void this.startTestServer();
        $('addTestSource').onclick = () => this.open({ ...defaultConfig, url: input('testEndpoint').value, layer: 'demo:points' }, 'Test WFS');
        this.render();
    }
    syncColoring(source: SavedSource) {
        for (const settings of [this.saved, this.draft]) {
            const s = settings.sources.find(s => s.id === source.id);
            if (s) { s.coloring = structuredClone(source.coloring); s.color = source.color ? [...source.color] : undefined; }
        }
        this.updateState();
    }
    syncBackgroundEnabled(enabled: boolean) { this.saved.background.enabled = this.draft.background.enabled = enabled; }
    syncMap(map: MapSettings) { this.saved.map = structuredClone(map); this.draft.map = structuredClone(map); }
    private setBackupBusy(busy: boolean) {
        this.backupBusy = busy;
        document.querySelector<HTMLElement>('.sources-page')!.inert = busy;
        for (const id of ['restoreBackup', 'cancelBackup']) $<HTMLButtonElement>(id).disabled = busy;
    }
    private async exportBackup() {
        if (this.backupBusy || this.saving) return;
        this.setBackupBusy(true); $('backupError').hidden = true; $('backupStatus').textContent = 'Preparing complete backup…';
        try {
            const blob = await createBackup(this.draft, readCSVText);
            const link = document.createElement('a'), url = URL.createObjectURL(blob);
            link.href = url; link.download = `wfs-map-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            $('backupStatus').textContent = 'Backup downloaded.';
        } catch (e) { this.backupError('Could not export backup', e); }
        finally { this.setBackupBusy(false); }
    }
    private backupError(prefix: string, e: unknown) {
        $('backupStatus').textContent = '';
        $('backupError').textContent = `${prefix}: ${(e as Error).message}`; $('backupError').hidden = false;
    }
    private async importBackup() {
        const file = input('backupFile').files?.[0]; input('backupFile').value = '';
        if (!file || this.backupBusy || this.saving) return;
        this.setBackupBusy(true); $('backupError').hidden = true; $('backupStatus').textContent = 'Checking backup…';
        try {
            this.pendingBackup = await readBackup(file);
            const sources = this.pendingBackup.sources, csv = sources.filter(s => s.config.type === 'csv').length;
            $('backupSummary').textContent = `${sources.length} sources: ${csv} CSV files and ${sources.length - csv} WFS connections.`;
            $('backupSources').replaceChildren(...sources.map(s => { const item = document.createElement('li'); item.textContent = `${s.name} (${s.config.type.toUpperCase()}, ${s.enabled ? 'enabled' : 'disabled'})`; return item; }));
            $('restoreError').hidden = true; $('backupStatus').textContent = '';
            $<HTMLDialogElement>('backupDialog').showModal();
        } catch (e) { this.pendingBackup = undefined; this.backupError('Could not import backup', e); }
        finally { this.setBackupBusy(false); }
    }
    private cancelBackup() {
        if (this.backupBusy) return;
        this.pendingBackup = undefined; $<HTMLDialogElement>('backupDialog').close(…1859 tokens truncated…), new Option('Custom layer name…', ''));
        this.showCustomLayer();
    }
    private showCustomLayer() {
        const custom = !$<HTMLSelectElement>('layerSelect').value;
        $('customLayer').hidden = !custom;
        // The selected name is still read by config(); hidden custom input
        // validation must not prevent submitting a discovered layer.
        input('layer').required = custom;
    }
    private updateDiscoveredFormat() {
        const doc = this.capabilities;
        if (!doc) return;
        // deegree advertises outputFormat globally; GeoServer usually puts
        // it on GetFeature. Per-layer formats take precedence over both.
        const featureType = [...doc.getElementsByTagNameNS('*', 'FeatureType')].find(el => el.getElementsByTagNameNS('*', 'Name')[0]?.textContent?.trim() === input('layer').value);
        const layerFormats = [...(featureType?.getElementsByTagNameNS('*', 'OutputFormats') ?? [])].flatMap(el => [...el.getElementsByTagNameNS('*', 'Format')].map(v => v.textContent?.trim() ?? ''));
        const parameters = [...doc.getElementsByTagNameNS('*', 'Parameter')].filter(el => el.getAttribute('name') === 'outputFormat' && (el.parentElement?.localName === 'OperationsMetadata' || el.parentElement?.getAttribute('name') === 'GetFeature'));
        const formats = layerFormats.length ? layerFormats : parameters.flatMap(el => [...el.getElementsByTagNameNS('*', 'Value')].map(v => v.textContent?.trim() ?? ''));
        const json = formats.find(f => /^application\/(?:geo\+)?json$/i.test(f)) ?? formats.find(f => /^json$/i.test(f));
        let formatNotice = '';
        if (formats.length && !formats.includes(input('format').value) && json) {
            input('format').value = json;
            formatNotice = ` Output format set to ${json}.`;
        }
        const count = $<HTMLSelectElement>('layerSelect').options.length - 1;
        $('discoveryStatus').textContent = `${count} layer(s) found. Choose a feature layer above.${formatNotice}`;
    }
    private showType() {
        const csv = input('type').value === 'csv';
        for (const [id, active] of [['wfsFields', !csv], ['csvFields', csv]] as const) {
            const fields = $<HTMLFieldSetElement>(id); fields.hidden = !active; fields.disabled = !active;
        }
        this.showGeometry(); this.csvSubmitState();
    }
    private showGeometry() {
        const xy = input('geometryMode').value === 'xy';
        $('csvXY').hidden = !xy; $('csvPoint').hidden = xy;
        for (const id of ['longitudeField', 'latitudeField']) { const select = $<HTMLSelectElement>(id); select.disabled = !xy; select.required = xy; }
        $<HTMLSelectElement>('csvGeometry').disabled = xy;
        $<HTMLSelectElement>('csvGeometry').required = !xy;
    }
    private csvColumns(config?: Config) {
        const headers = this.csvHeaders;
        const restoring = !headers.length && !!this.csvRef;
        for (const id of ['longitudeField', 'latitudeField', 'csvGeometry', 'csvTime']) {
            const select = $<HTMLSelectElement>(id), previous = config ? config[id === 'csvGeometry' ? 'geometryField' : id === 'csvTime' ? 'timeField' : id as 'longitudeField' | 'latitudeField'] : select.value;
            // Preserve saved mappings while IndexedDB loads the file, including
            // when a replacement is chosen before that read finishes. The new
            // file's headers validate each mapping once its contents are ready.
            const columns = restoring && previous ? [previous] : headers;
            select.replaceChildren(new Option(id === 'csvTime' ? 'No time attribute' : 'Choose column…', ''), ...columns.map(h => new Option(h, h)));
            select.value = columns.includes(previous) ? previous : '';
            if (!select.value && id !== 'csvTime') {
                const pattern = id === 'longitudeField' ? /^(lon|lng|longitude|x)$/i : id === 'latitudeField' ? /^(lat|latitude|y)$/i : /^(geometry|geom|wkt)$/i;
                select.value = headers.find(h => pattern.test(h)) ?? '';
            }
        }
        $('csvFileStatus').textContent = this.fileName ? restoring ? `Reading ${this.fileName}…` : `${this.fileName} · ${headers.length} columns` : 'Choose a file to populate its columns.';
    }
    private showError(e: unknown) { $('sourceError').textContent = (e as Error).message; $('sourceError').hidden = false; }
    private downloadCSVReport(blob: Blob) {
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = 'csv-import-diagnostics.csv'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    private csvSubmitState() {
        if (input('type').value !== 'csv') { $<HTMLButtonElement>('updateSource').disabled = false; return; }
        const report = this.csvReport;
        $<HTMLButtonElement>('updateSource').disabled = this.csvParsing || !report || (report.rejected > 0 && input('csvInvalidRows').value === 'reject');
    }
    private cancelCSV() {
        this.csvRequest++; this.fileRevision++;
        this.csvWorker?.terminate(); this.csvWorker = undefined;
        this.csvParsing = false; this.csvReport = undefined;
        $('cancelCSV').hidden = true; $<HTMLButtonElement>('csvDiagnostics').disabled = true;
        $('csvReviewStatus').textContent = 'Review cancelled. Click Review file to restart.';
        this.csvSubmitState();
    }
    private inspectCSV(config?: Config) {
        this.csvWorker?.terminate(); this.csvReport = undefined;
        if (!this.csvText) { this.csvParsing = false; $('cancelCSV').hidden = true; this.csvSubmitState(); this.showError(Error('Choose a non-empty CSV file.')); return; }
        this.csvParsing = true; this.csvSubmitState();
        $('cancelCSV').hidden = false; $<HTMLButtonElement>('csvDiagnostics').disabled = true;
        $('csvReviewStatus').textContent = 'Reading records…';
        $('csvSchema').replaceChildren(); $('csvSamples').replaceChildren();
        const worker = this.csvWorker = new Worker(new URL('./csv-preview-worker.ts', import.meta.url), { type: 'module' });
        worker.onerror = e => { this.csvParsing = false; this.csvReport = undefined; this.showError(Error(e.message)); this.csvSubmitState(); $('cancelCSV').hidden = true; };
        worker.onmessage = e => {
            const m = e.data;
            if (m.request !== this.csvRequest) return;
            if (m.type === 'progress') $('csvReviewStatus').textContent = `${m.stage}… ${m.total ? Math.floor(m.completed / m.total * 100) : 100}%`;
            if (m.type === 'headers') {
                this.csvHeaders = m.headers;
                const required = this.editing?.config.type === 'csv' ? [...Object.keys(this.csvTypes), ...['longitudeField', 'latitudeField', 'geometryField', 'timeField'].map(k => this.editing!.config[k as keyof Config]), ...(currentAnalysis?.state.analyses.find(s => s.id === this.editing!.id)?.fields.map(f => f.name) ?? [])] : [];
                const missing = [...new Set(required)].filter(k => k && !this.csvHeaders.includes(k));
                if (missing.length) {
                    worker.terminate(); this.csvWorker = undefined; this.csvParsing = false; this.csvSubmitState(); $('cancelCSV').hidden = true;
                    this.showError(Error('The chosen CSV is missing configured columns: ' + missing.join(', '))); return;
                }
                this.csvColumns(config); this.reviewCSV();
            }
            if (m.type === 'preview') {
                this.csvParsing = false; this.csvReport = m.report; $('sourceError').hidden = true;
                $('cancelCSV').hidden = true; this.renderCSVReview(); this.csvSubmitState();
            }
            if (m.type === 'error') {
                this.csvParsing = false; this.csvReport = undefined; this.csvSubmitState();
                $('cancelCSV').hidden = true; $('csvReviewStatus').textContent = 'Review failed. Correct the file or import settings.'; this.showError(Error(m.message));
            }
        };
        worker.postMessage({ type: 'parse', text: this.csvText, delimiter: input('delimiter').value, request: ++this.csvRequest });
    }
    private reviewCSV() {
        this.csvReport = undefined; $<HTMLButtonElement>('csvDiagnostics').disabled = true;
        $('csvSamples').replaceChildren();
        if (!this.csvWorker || !this.csvHeaders.length) { this.csvSubmitState(); return; }
        this.csvParsing = true; this.csvSubmitState(); $('cancelCSV').hidden = false;
        $('csvReviewStatus').textContent = 'Validating records…';
        this.csvWorker.postMessage({ type: 'preview', config: { ...this.config(), csvText: '' }, request: ++this.csvRequest });
    }
    private renderCSVReview() {
        const r = this.csvReport!;
        const blocked = r.rejected > 0 && input('csvInvalidRows').value === 'reject';
        $('csvReviewStatus').textContent = `${r.total.toLocaleString()} records · ${r.accepted.toLocaleString()} valid · ${r.rejected.toLocaleString()} invalid. ${blocked ? 'Entire import rejected. Fix the errors or choose quarantine.' : `${r.accepted.toLocaleString()} accepted / ${r.rejected.toLocaleString()} quarantined on import.`}`;
        $<HTMLButtonElement>('csvDiagnostics').disabled = !r.rejected;
        const heading = (table: HTMLElement, labels: string[]) => {
            table.replaceChildren(); const head = document.createElement('thead'), row = document.createElement('tr');
            for (const label of labels) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; row.append(th); }
            head.append(row); table.append(head); const body = document.createElement('tbody'); table.append(body); return body;
        };
        const td = (row: HTMLElement, text: string) => { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); return cell; };
        const labels: Record<CSVKind, string> = { string: 'Text', number: 'Number', boolean: 'Boolean', date: 'Date/time (UTC)' };
        const schema = heading($('csvSchema'), ['Column', 'Inferred', 'Import as', 'Missing', 'Failed casts']);
        for (const [i, field] of r.fields.entries()) {
            const row = document.createElement('tr'); td(row, field.name); td(row, labels[r.inferred[i].kind]);
            const control = td(row, ''), select = document.createElement('select'); select.setAttribute('aria-label', `Import type for ${field.name}`);
            select.append(new Option('Auto', ''), ...Object.entries(labels).map(([value, label]) => new Option(label, value)));
            select.value = this.csvTypes[field.name] ?? '';
            select.onchange = () => { if (select.value) this.csvTypes[field.name] = select.value as CSVKind; else delete this.csvTypes[field.name]; this.reviewCSV(); };
            control.append(select); td(row, r.missing[i].toLocaleString()); td(row, r.failed[i].toLocaleString()); schema.append(row);
        }
        const samples = heading($('csvSamples'), ['Record / validation', ...r.fields.map(f => f.name)]);
        for (const sample of r.samples) {
            const row = document.createElement('tr'); td(row, `${sample.row} · ${sample.errors.join(' ') || 'Valid'}`);
            r.fields.forEach((_, j) => td(row, `${JSON.stringify(sample.raw[j] ?? '')} → ${sample.values[j] == null ? '∅ (missing or failed)' : JSON.stringify(sample.values[j])}`)); samples.append(row);
        }
    }
    private async readCSV() {
        const file = input('csvFile').files?.[0];
        if (!file) return;
        this.cancelCSV(); const revision = this.fileRevision;
        this.csvText = ''; this.csvRef = ''; this.csvHeaders = []; this.fileName = file.name;
        $('csvSchema').replaceChildren(); $('csvSamples').replaceChildren();
        this.csvParsing = true; this.csvSubmitState(); $('cancelCSV').hidden = false;
        $('csvFileStatus').textContent = `Reading ${file.name}…`;
        try {
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
            if (revision !== this.fileRevision) return;
            this.csvText = text; this.csvRef = createUUID(); this.fileName = file.name;
            this.csvHeaders = []; this.inspectCSV(this.editing?.config);
        } catch (e) { if (revision === this.fileRevision) { this.csvParsing = false; this.showError(e); this.csvSubmitState(); } }
    }
    private config(): Config {
        const config = { ...defaultConfig, ...Object.fromEntries(configKeys.filter(key => !['csvText', 'csvRef', 'fileName', 'longitudeField', 'latitudeField', 'csvTypes', 'csvMissingValues', 'csvInvalidRows'].includes(key)).map(key => [key, key === 'delimiter' ? input(key).value : input(key).value.trim()])) } as Config;
        if (config.type === 'csv') Object.assign(config, { csvText: this.csvRef === this.editing?.config.csvRef ? this.editing.config.csvText : this.csvText, csvRef: this.csvRef, fileName: this.fileName, longitudeField: input('longitudeField').value, latitudeField: input('latitudeField').value, geometryField: input('csvGeometry').value, timeField: input('csvTime').value, csvTypes: JSON.stringify(this.csvTypes), csvMissingValues: JSON.stringify(['', ...$<HTMLTextAreaElement>('csvMissingValues').value.split('\n').map(v => v.trim()).filter(Boolean)]), csvInvalidRows: input('csvInvalidRows').value });
        return config;
    }
    private updateSource() {
        try {
            const config = this.config(); validateConfig(config);
            if (config.type === 'csv' && (!this.csvReport || this.csvParsing || (this.csvReport.rejected && config.csvInvalidRows === 'reject'))) throw Error('Complete CSV review and resolve invalid records before importing.');
            const name = input('sourceName').value.trim();
            if (!name) throw Error('Enter a source name.');
            if (this.editing) { this.editing.name = name; this.editing.config = config; }
            else if (this.draft.sources.length < 8) this.draft.sources.push({ id: createUUID(), name, config, enabled: true });
            this.close(); this.render();
        } catch (e) { $('sourceError').textContent = (e as Error).message; $('sourceError').hidden = false; }
    }
    private async save() {
        if (this.saving) return;
        this.saving = true;
        // Prevent edits/discard while the file transaction is pending.
        document.querySelector<HTMLElement>('.sources-page')!.inert = true;
        this.updateState(); $('saveState').textContent = 'Saving changes…';
        try {
            for (const s of this.draft.sources) validateConfig(s.config);
            validateBackground(this.draft.background);
            this.draft = await saveSettings(this.draft);
            input('basemapURL').removeAttribute('aria-invalid');
            this.saved = structuredClone(this.draft); this.removed = undefined;
            this.csvText = '';
            this.apply(structuredClone(this.saved)); this.render();
            $('saveState').textContent = 'Saved in this browser';
        } catch (e) {
            this.updateState();
            $('saveError').textContent = `Could not save changes: ${(e as Error).message}`; $('saveError').hidden = false;
            input('basemapURL').setAttribute('aria-invalid', String(!this.validBackground()));
        } finally {
            this.saving = false;
            document.querySelector<HTMLElement>('.sources-page')!.inert = false;
            const dirty = JSON.stringify(settingsMetadata(this.draft)) !== JSON.stringify(settingsMetadata(this.saved));
            $<HTMLButtonElement>('saveSettings').disabled = !dirty;
            $<HTMLButtonElement>('discardSettings').disabled = !dirty;
        }
    }
    private validBackground() { try { validateBackground(this.draft.background); return true; } catch { return false; } }
    private async discover() {
        this.stopDiscovery(); const controller = new AbortController(); this.discovery = controller;
        const config = this.config();
        $('discoveryStatus').textContent = 'Reading available layers…'; $<HTMLButtonElement>('discover').disabled = true;
        const timeout = setTimeout(() => controller.abort(), 45000);
        try {
            const url = new URL(config.url, location.href);
            if (!config.url || !['http:', 'https:'].includes(url.protocol)) throw Error('Enter an HTTP(S) WFS endpoint first.');
            const response = await fetch(wfsURL(url.href, config.version, 'GetCapabilities'), { signal: controller.signal });
            const text = await response.text(); xmlDocument(text);
            if (!response.ok) throw Error(`HTTP ${response.status}`);
            const doc = new DOMParser().parseFromString(text, 'text/xml');
            const layers = new Map<string, string>();
            for (const el of doc.getElementsByTagNameNS('*', 'FeatureType')) {
                const name = el.getElementsByTagNameNS('*', 'Name')[0]?.textContent?.trim();
                const title = el.getElementsByTagNameNS('*', 'Title')[0]?.textContent?.trim();
                if (name) layers.set(name, title && title !== name ? `${title} (${name})` : name);
            }
            if (!layers.size) throw Error('No feature types found in GetCapabilities.');
            if (controller.signal.aborted) return;
            this.capabilities = doc;
            const select = $<HTMLSelectElement>('layerSelect');
            select.replaceChildren(...[...layers].map(([name, title]) => new Option(title, name)), new Option('Custom layer name…', ''));
            // Keep an existing selection or manual override. A blank new
            // source starts with the first advertised layer.
            if (!input('layer').value) input('layer').value = layers.keys().next().value!;
            select.value = layers.has(input('layer').value) ? input('layer').value : '';
            this.showCustomLayer();
            this.updateDiscoveredFormat();
        } catch (e) { if (this.discovery === controller && $<HTMLDialogElement>('sourceDialog').open) $('discoveryStatus').textContent = `Discovery failed: ${(e as Error).message}. You can enter a feature type manually.`; }
        finally { clearTimeout(timeout); if (this.discovery === controller) { $<HTMLButtonElement>('discover').disabled = false; this.discovery = undefined; } }
    }
    private async startTestServer() {
        const points = input('points');
        if (!points.reportValidity()) return;
        $<HTMLButtonElement>('startTestServer').disabled = true;
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch('/api/test-wfs/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
            if (!response.ok) throw Error(`HTTP ${response.status}`);
            const result = await response.json();
            if (!result.running || result.endpoint !== '/test-wfs') throw Error('Unexpected server response');
            const url = new URL(result.endpoint, location.href); url.searchParams.set('points', points.value); url.searchParams.set('distribution', input('distribution').value);
            input('testEndpoint').value = url.pathname + url.search;
            input('testEndpoint').hidden = $('testEndpointLabel').hidden = false;
            $('testServerStatus').textContent = 'Test server is running. Add this endpoint as a data source, then save changes.';
            $('startTestServer').textContent = 'Update test endpoint';
            this.render();
        } catch (e) { $('testServerStatus').textContent = `Could not start the test server (${(e as Error).message}). Run the app’s Node server, or add a WFS endpoint directly.`; }
        finally { clearTimeout(timeout); $<HTMLButtonElement>('startTestServer').disabled = false; }
    }
}
