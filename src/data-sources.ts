import { readCSVText, saveSettings } from './source-storage.ts';
import { parseCSV } from './csv.ts';
import { wfsURL, xmlDocument } from './data.ts';
import { configKeys, defaultConfig, settingsMetadata, validateConfig, validateBackground, type Config, type Settings, type SavedSource } from './source-settings.ts';
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
    private saving = false;
    private fileName = '';
    private fileRevision = 0;
    private removed?: { source: SavedSource; index: number };
    constructor(settings: Settings, private apply: (settings: Settings) => void) {
        this.draft = structuredClone(settings);
        this.saved = structuredClone(settings);
        $('configuration').innerHTML = `
        <div class="sources-page">
          <div class="sources-heading"><div><h2>Data sources</h2><p class="hint">Connect WFS servers or import CSV points to explore on the map.</p></div><button id="addSource" class="primary">+ Add data source</button></div>
          <section class="settings-card" aria-labelledby="sourcesTitle"><div class="settings-card-head"><h3 id="sourcesTitle">Your data sources</h3><span id="sourceCount" class="hint"></span></div><p class="hint">Enable a source to load it after saving. Configure opens its connection settings.</p><ul id="sourceList" class="source-list"></ul><div id="sourceUndo" hidden><span id="removedName"></span> <button id="undoRemove">Undo remove</button></div></section>
          <details class="settings-card" id="backgroundSettings"><summary>Map background</summary><div class="settings-fields"><label for="basemapURL">Raster basemap tile URL</label><input id="basemapURL" placeholder="https://…/{z}/{x}/{y}.png"><label for="basemapAttribution">Basemap attribution</label><input id="basemapAttribution"><p class="hint">XYZ raster tiles. Leave the URL empty to use the offline grid.</p></div></details>
          <details class="settings-card" id="testServer"><summary>Optional test WFS server</summary><p class="hint">Start a local server with generated points to try the app. Add its endpoint using the same connection settings as any WFS source.</p><div class="test-fields"><div><label for="points">Generated point count</label><input id="points" type="number" min="1" max="50000000" value="1000000" required></div><div><label for="distribution">Point distribution</label><select id="distribution"><option value="uk">UK spread</option><option value="world">Worldwide</option><option value="dense">Dense 2 km square</option></select></div></div><div class="row"><button id="startTestServer">Start test server</button><button id="addTestSource" disabled>Add as data source</button></div><p id="testServerStatus" class="hint" role="status">Requires the app’s Node server. The test endpoint stays running until that server restarts.</p><label for="testEndpoint" hidden id="testEndpointLabel">Test WFS endpoint</label><input id="testEndpoint" readonly hidden></details>
          <div class="settings-save"><div><strong id="saveState" role="status">All changes saved</strong><p class="hint">Save applies changes and keeps them in this browser for your next visit.</p><p id="saveError" class="error" role="alert" hidden></p></div><div class="row"><button id="discardSettings" disabled>Discard changes</button><button id="saveSettings" class="primary" disabled>Save changes</button></div></div>
        </div>
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
            <label for="timeField">Time attribute (optional override)</label><input id="timeField" placeholder="Auto-detect from schema"><p class="hint">Used for the global time window sent to WFS. Specify the date/time field if discovery is unavailable or ambiguous.</p>
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
            <label for="csvTime">Time attribute (optional)</label><select id="csvTime"></select><p class="hint">ISO 8601 dates/times. Use All time when no time column is selected. Coordinates must be longitude/latitude in WGS84; only points are supported.</p>
            <p class="hint">The imported file is saved in this browser with its settings. Available storage depends on your browser and device; a save error leaves your existing saved sources intact.</p>
          </fieldset>
          <p id="sourceError" class="error" role="alert" hidden></p>
        </div><div class="source-dialog-footer"><span class="hint">Save changes on the page to apply.</span><button id="cancelSource" type="button">Cancel</button><button id="updateSource" class="primary" type="submit">Add to list</button></div></form></dialog>`;
        $('type').onchange = () => { this.stopDiscovery(); this.showType(); };
        $('geometryMode').onchange = () => this.showGeometry();
        $('delimiter').onchange = () => { try { this.csvColumns(); } catch (e) { this.showError(e); } };
        $('csvFile').onchange = () => void this.readCSV();
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
            if (s) s.coloring = structuredClone(source.coloring);
        }
        this.updateState();
    }
    syncBackgroundEnabled(enabled: boolean) { this.saved.background.enabled = this.draft.background.enabled = enabled; }
    private updateState() {
        const dirty = JSON.stringify(settingsMetadata(this.draft)) !== JSON.stringify(settingsMetadata(this.saved));
        $('saveState').textContent = dirty ? 'Unsaved changes' : 'All changes saved';
        $<HTMLButtonElement>('saveSettings').disabled = this.saving || !dirty;
        $<HTMLButtonElement>('discardSettings').disabled = this.saving || !dirty;
        $('saveError').hidden = true;
        window.onbeforeunload = dirty ? e => { e.preventDefault(); e.returnValue = ''; } : null;
    }
    private render() {
        const list = $('sourceList');
        list.replaceChildren();
        if (!this.draft.sources.length) {
            const empty = document.createElement('li'); empty.className = 'source-empty';
            empty.textContent = 'No data sources yet. Add a WFS endpoint or import a CSV file.'; list.append(empty);
        }
        for (const s of this.draft.sources) {
            const row = document.createElement('li'); row.className = 'source-row'; row.dataset.sourceId = s.id;
            const check = document.createElement('input'); check.type = 'checkbox'; check.checked = s.enabled; check.setAttribute('aria-label', 'Enable ' + s.name);
            check.onchange = () => { s.enabled = check.checked; this.updateState(); };
            const description = document.createElement('div'); description.className = 'source-description';
            const name = document.createElement('strong'); name.textContent = s.name;
            const url = document.createElement('span'); url.textContent = s.config.type === 'csv' ? `CSV · ${s.config.fileName}` : s.config.url; url.className = 'hint';
            const layer = document.createElement('span'); layer.textContent = s.config.type === 'csv' ? (s.config.geometryMode === 'xy' ? `${s.config.longitudeField}, ${s.config.latitudeField}` : s.config.geometryField) : s.config.layer; layer.className = 'source-layer';
            description.append(name, url, layer);
            const actions = document.createElement('div'); actions.className = 'source-actions';
            const configure = document.createElement('button'); configure.textContent = 'Configure'; configure.setAttribute('aria-label', 'Configure ' + s.name); configure.setAttribute('aria-haspopup', 'dialog'); configure.onclick = () => this.open(s.config, s.name, s);
            const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.className = 'danger'; remove.setAttribute('aria-label', 'Remove ' + s.name);
            remove.onclick = () => { const index = this.draft.sources.indexOf(s); this.draft.sources.splice(index, 1); this.removed = { source: s, index }; this.render(); };
            actions.append(configure, remove); row.append(check, description, actions); list.append(row);
        }
        $('sourceCount').textContent = `${this.draft.sources.length} / 8 sources`;
        for (const id of ['addSource', 'addTestSource', 'undoRemove']) $<HTMLButtonElement>(id).disabled = this.draft.sources.length >= 8 || (id === 'addTestSource' && !input('testEndpoint').value);
        $('sourceUndo').hidden = !this.removed;
        $('removedName').textContent = this.removed ? `${this.removed.source.name} removed from the list.` : '';
        this.updateState();
    }
    private open(config: Config = defaultConfig, name = '', source?: SavedSource) {
        this.editing = source;
        this.fileRevision++;
        for (const key of configKeys) if (!['csvText', 'csvRef', 'fileName', 'longitudeField', 'latitudeField'].includes(key)) input(key).value = config[key];
        this.csvRef = config.csvRef; this.csvText = config.csvText; this.fileName = config.fileName;
        input('csvFile').value = '';
        this.csvColumns(config);
        this.showType();
        input('sourceName').value = name;
        $('sourceDialogTitle').textContent = source ? 'Configure data source' : 'Add data source';
        $<HTMLButtonElement>('updateSource').disabled = false;
        $('updateSource').textContent = source ? 'Update source' : 'Add to list';
        this.stopDiscovery(); this.resetLayers(true);
        $('sourceError').hidden = true; $('discoveryStatus').textContent = '';
        $<HTMLDetailsElement>('wfsCompatibility').open = false;
        $<HTMLDialogElement>('sourceDialog').showModal();
        input('sourceName').focus();
        if (config.type === 'csv' && config.csvRef && !config.csvText) void this.restoreCSV(config, this.fileRevision);
    }
    private async restoreCSV(config: Config, revision: number) {
        $<HTMLButtonElement>('updateSource').disabled = true;
        $('csvFileStatus').textContent = `Reading ${config.fileName}…`;
        try {
            const text = await readCSVText(config.csvRef);
            if (revision !== this.fileRevision) return;
            this.csvText = text; this.csvColumns(config);
        } catch (e) { if (revision === this.fileRevision) this.showError(e); }
        finally { if (revision === this.fileRevision) $<HTMLButtonElement>('updateSource').disabled = false; }
    }
    private stopDiscovery() {
        this.discovery?.abort(); this.discovery = undefined;
        $<HTMLButtonElement>('discover').disabled = false;
    }
    private close() { this.fileRevision++; this.csvText = ''; this.editing = undefined; this.stopDiscovery(); $<HTMLDialogElement>('sourceDialog').close(); }
    private resetLayers(selectCurrent = false) {
        this.capabilities = undefined;
        const name = input('layer').value;
        $('layerSelect').replaceChildren(...(selectCurrent && name ? [new Option(name, name)] : []), new Option('Custom layer name…', ''));
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
        this.showGeometry();
    }
    private showGeometry() {
        const xy = input('geometryMode').value === 'xy';
        $('csvXY').hidden = !xy; $('csvPoint').hidden = xy;
        for (const id of ['longitudeField', 'latitudeField']) { const select = $<HTMLSelectElement>(id); select.disabled = !xy; select.required = xy; }
        $<HTMLSelectElement>('csvGeometry').disabled = xy;
        $<HTMLSelectElement>('csvGeometry').required = !xy;
    }
    private csvColumns(config?: Config) {
        const headers = this.csvText ? parseCSV(this.csvText, input('delimiter').value).headers : [];
        const restoring = !this.csvText && !!this.csvRef;
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
    private async readCSV() {
        const file = input('csvFile').files?.[0], revision = ++this.fileRevision;
        if (!file) return;
        $<HTMLButtonElement>('updateSource').disabled = true;
        try {
            const text = await file.text();
            if (revision !== this.fileRevision) return;
            parseCSV(text, input('delimiter').value);
            this.csvText = text; this.csvRef = crypto.randomUUID(); this.fileName = file.name;
            this.csvColumns(); $('sourceError').hidden = true;
        } catch (e) { if (revision === this.fileRevision) this.showError(e); }
        finally { if (revision === this.fileRevision) $<HTMLButtonElement>('updateSource').disabled = false; }
    }
    private config(): Config {
        const config = { ...defaultConfig, ...Object.fromEntries(configKeys.filter(key => !['csvText', 'csvRef', 'fileName', 'longitudeField', 'latitudeField'].includes(key)).map(key => [key, key === 'delimiter' ? input(key).value : input(key).value.trim()])) } as Config;
        if (config.type === 'csv') Object.assign(config, { csvText: this.csvRef === this.editing?.config.csvRef ? this.editing.config.csvText : this.csvText, csvRef: this.csvRef, fileName: this.fileName, longitudeField: input('longitudeField').value, latitudeField: input('latitudeField').value, geometryField: input('csvGeometry').value, timeField: input('csvTime').value });
        return config;
    }
    private updateSource() {
        try {
            const config = this.config(); validateConfig(config);
            const name = input('sourceName').value.trim();
            if (!name) throw Error('Enter a source name.');
            if (this.editing) { this.editing.name = name; this.editing.config = config; }
            else if (this.draft.sources.length < 8) this.draft.sources.push({ id: crypto.randomUUID(), name, config, enabled: true });
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
