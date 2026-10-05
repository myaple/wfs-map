import type { Field } from './data.ts';
import type { JoinOptions, JoinResult } from './derived-datasets.ts';
import { createUUID } from './uuid.ts';
import { csvExportFilename } from './csv-export.ts';
import type { SavedSource } from './source-settings.ts';

export type JoinSource = { id: string; name: string; enabled: boolean; done: boolean; filtering: boolean; loaded: number; selected: number; request: number; filterRequest: number; fields: Field[]; metrics: { truncated?: boolean } };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const n = document.createElement(tag); n.textContent = text; return n; };
export class DerivedDatasetPanel {
    readonly root = el('section');
    private left = el('select'); private right = el('select');
    private leftField = el('select'); private rightField = el('select'); private mode = el('select'); private scope = el('select');
    private name = el('input'); private maxRows = el('input'); private status = el('p'); private error = el('p');
    private previewButton = el('button', 'Preview join'); private saveButton = el('button', 'Save joined dataset'); private cancelButton = el('button', 'Cancel join');
    private sample = el('div'); private inputStatus = el('p'); private controls = el('div');
    private columnChoices = el('div'); private columnLists = [el('div'), el('div')];
    private included: [Set<string>, Set<string>] = [new Set(), new Set()]; private schemas = ['', ''];
    private leftId = true; private rightId = true; private rightCoordinates = true;
    private result?: JoinResult; private controller?: AbortController; private activeSources: string[] = []; private saving = false; private version = ''; private inputsVersion = '';
    constructor(private sources: () => JoinSource[], private run: (left: string, right: string, options: JoinOptions, save: boolean, signal: AbortSignal, progress: (message: string) => void) => Promise<JoinResult>,
        private save: (source: SavedSource, blob: Blob) => Promise<void>) {
        this.root.id = 'derivedDatasets'; this.root.className = 'settings-card derived-datasets';
        const hint = el('p', 'Join two loaded datasets on an exact shared value, such as a UUID. Field types must agree; text matching is case-sensitive. Empty keys never match. Repeated keys produce every matching pair. Choose which columns to include; each output column is prefixed with its original dataset name. Duplicate dataset names and column collisions get a suffix. Left geometry coordinates are required for the map. An included time column comes from the left dataset.'); hint.className = 'hint';
        const durable = el('p', 'Save creates an independent CSV-backed copy in Data sources. Refreshing or removing the inputs does not change its saved data. The copy uses the same filters, charts, export and backup as an imported CSV.'); durable.className = 'hint';
        this.controls.className = 'derived-controls';
        const control = (label: string, input: HTMLElement, id: string) => { input.id = id; const host = el('div'), l = el('label', label); l.htmlFor = id; host.append(l, input); this.controls.append(host); };
        control('Left dataset', this.left, 'joinLeft'); control('Left match field', this.leftField, 'joinLeftField');
        control('Right dataset', this.right, 'joinRight'); control('Right match field', this.rightField, 'joinRightField');
        this.mode.append(new Option('Inner · matching pairs only', 'inner'), new Option('Left · retain unmatched left rows', 'left'));
        this.scope.append(new Option('All loaded rows', 'loaded'), new Option('Applied filters and timeline', 'applied'));
        control('Join type', this.mode, 'joinMode'); control('Input rows', this.scope, 'joinScope');
        this.name.placeholder = 'Joined dataset'; this.name.maxLength = 120; control('New dataset name', this.name, 'joinName');
        this.maxRows.type = 'number'; this.maxRows.min = '1'; this.maxRows.max = '50000000'; this.maxRows.step = '1'; this.maxRows.value = '1000000';
        control('Maximum output rows', this.maxRows, 'joinMaxRows');
        this.columnChoices.className = 'join-column-choices';
        for (const [i, side] of ['left', 'right'].entries()) { const details = el('details'); details.append(el('summary', `${side === 'left' ? 'Left' : 'Right'} columns to include`), this.columnLists[i]); this.columnLists[i].className = 'join-column-list'; this.columnChoices.append(details); }
        this.controls.append(this.columnChoices);
        this.status.setAttribute('role', 'status'); this.status.id = 'joinStatus'; this.error.setAttribute('role', 'alert'); this.error.className = 'error'; this.error.hidden = true;
        this.inputStatus.className = 'hint'; this.sample.className = 'join-sample'; this.sample.hidden = true;
        const actions = el('div'); actions.className = 'row'; this.saveButton.className = 'primary'; this.cancelButton.hidden = true;
        actions.append(this.previewButton, this.saveButton, this.cancelButton);
        this.root.append(el('h3', 'Join datasets'), hint, durable, this.controls, this.inputStatus, actions, this.status, this.error, this.sample);
        this.left.onchange = () => { this.fields(); this.invalidate(); this.update(); };
        this.right.onchange = () => { this.fields(); this.invalidate(); this.update(); };
        for (const input of [this.leftField, this.rightField, this.mode, this.scope, this.maxRows]) input.onchange = () => { this.invalidate(); this.update(); };
        this.name.oninput = () => this.update();
        this.previewButton.onclick = () => void this.execute(false); this.saveButton.onclick = () => void this.execute(true);
        this.cancelButton.onclick = () => this.controller?.abort();
        this.refresh();
    }
    private available() { return this.sources().filter(s => s.enabled); }
    private fields() {
        for (const [i, [source, select]] of ([[this.left, this.leftField], [this.right, this.rightField]] as const).entries()) {
            const old = select.value, fields = this.available().find(s => s.id === source.value)?.fields ?? [];
            select.replaceChildren(new Option('Choose match field…', ''), ...fields.map(f => new Option(`${f.name} (${f.kind})`, f.name)));
            if (fields.some(f => f.name === old)) select.value = old;
            const schema = JSON.stringify([source.value, fields]);
            if (this.schemas[i] !== schema) { this.schemas[i] = schema; this.included[i] = new Set(fields.map(f => f.name)); }
            const list = this.columnLists[i]; list.replaceChildren();
            const all = el('button', 'Include all'), none = el('button', 'Exclude all');
            all.onclick = () => { this.included[i] = new Set(fields.map(f => f.name)); if (i) this.rightId = this.rightCoordinates = true; else this.leftId = true; this.fields(); this.invalidate(); this.update(); };
            none.onclick = () => { this.included[i].clear(); if (i) this.rightId = this.rightCoordinates = false; else this.leftId = false; this.fields(); this.invalidate(); this.update(); }; list.append(all, none);
            for (const f of fields) {
                const label = el('label'), check = el('input'); check.type = 'checkbox'; check.checked = this.included[i].has(f.name);
                check.setAttribute('aria-label', `Include ${i ? 'right' : 'left'} column ${f.name}`);
                check.onchange = () => { if (check.checked) this.included[i].add(f.name); else this.included[i].delete(f.name); this.invalidate(); this.update(); };
                label.append(check, el('span', `${f.name} (${f.kind})`)); list.append(label);
            }
            const metadata = (labelText: string, checked: boolean, set: (value: boolean) => void) => {
                const label = el('label'), check = el('input'); check.type = 'checkbox'; check.checked = checked;
                check.onchange = () => { set(check.checked); this.invalidate(); this.update(); };
                label.append(check, el('span', labelText)); list.append(label);
            };
            metadata(`Include ${i ? 'right' : 'left'} record ID`, i ? this.rightId : this.leftId, checked => { if (i) this.rightId = checked; else this.leftId = checked; });
            if (i) metadata('Include right geometry coordinates', this.rightCoordinates, checked => { this.rightCoordinates = checked; });
            else list.append(el('p', 'Left geometry coordinates are always retained for the map.'));
        }
        this.inputsVersion = this.inputVersion();
    }
    private inputVersion() { return JSON.stringify([this.left.value, this.right.value].map(id => { const s = this.sources().find(s => s.id === id); return s ? [s.id, s.name, s.enabled, s.done, s.filtering, s.request, s.filterRequest, s.loaded, s.selected, s.fields] : null; })); }
    refresh() {
        const sources = this.available(), version = JSON.stringify(this.sources().map(s => [s.id, s.name, s.enabled, s.done, s.filtering, s.request, s.filterRequest, s.loaded, s.selected, s.fields, s.metrics.truncated]));
        if (version !== this.version) {
            this.version = version;
            if (!this.saving && this.inputsVersion !== this.inputVersion()) { this.controller?.abort(); this.invalidate(); }
            for (const select of [this.left, this.right]) { const old = select.value; select.replaceChildren(...sources.map(s => new Option(s.name, s.id))); if (sources.some(s => s.id === old)) select.value = old; }
            if (this.left.value === this.right.value && sources.length > 1) this.right.value = sources.find(s => s.id !== this.left.value)!.id;
            this.fields();
        }
        this.update();
    }
    invalidateSource(id: string) { if (this.activeSources.includes(id) && !this.saving) this.controller?.abort(); if ([this.left.value, this.right.value].includes(id)) this.invalidate(); }
    private invalidate() { this.result = undefined; this.sample.hidden = true; this.sample.replaceChildren(); this.status.textContent = ''; this.error.hidden = true; }
    private options(): JoinOptions { return { leftField: this.leftField.value, rightField: this.rightField.value, mode: this.mode.value as JoinOptions['mode'], scope: this.scope.value as JoinOptions['scope'], maxRows: Number(this.maxRows.value), leftColumns: [...this.included[0]], rightColumns: [...this.included[1]], leftId: this.leftId, rightId: this.rightId, rightCoordinates: this.rightCoordinates }; }
    private update() {
        const sources = this.available(), l = sources.find(s => s.id === this.left.value), r = sources.find(s => s.id === this.right.value), options = this.options();
        const ready = !!l?.done && !!r?.done && l.id !== r.id && !l.filtering && !r.filtering && !!options.leftField && !!options.rightField && l.fields.find(f => f.name === options.leftField)?.kind === r.fields.find(f => f.name === options.rightField)?.kind && this.maxRows.checkValidity();
        const busy = !!this.controller;
        this.controls.inert = busy; this.previewButton.disabled = busy || !ready;
        this.saveButton.disabled = busy || !ready || !this.name.value.trim() || !this.result?.report.outputRows || this.result.report.outputRows > options.maxRows || this.sources().length >= 8;
        this.cancelButton.hidden = !busy; this.cancelButton.disabled = this.saving;
        const count = (s: JoinSource) => (this.scope.value === 'applied' ? s.selected : s.loaded).toLocaleString();
        this.inputStatus.textContent = sources.length < 2 ? 'Load two enabled datasets to join them.' : !l || !r ? 'Choose both datasets.' : l.id === r.id ? 'Choose two different datasets.' : !l.done || !r.done ? 'Load both selected datasets to join them.' : `${count(l)} left input rows · ${count(r)} right input rows${l.filtering || r.filtering ? ' · Waiting for filters…' : ''}${l.metrics.truncated || r.metrics.truncated ? ' · A source hit its load limit; this joins loaded records only.' : ''}${this.sources().length >= 8 ? ' · Remove a source in Data sources to free a slot before saving.' : ''}`;
        if (options.leftField && options.rightField && l?.fields.find(f => f.name === options.leftField)?.kind !== r?.fields.find(f => f.name === options.rightField)?.kind) this.inputStatus.textContent += ' · Match fields must have the same type.';
    }
    private draw(result: JoinResult) {
        const r = result.report;
        this.status.textContent = `${r.outputRows.toLocaleString()} output rows · ${r.matchedLeft.toLocaleString()} matched left rows · ${r.unmatchedLeft.toLocaleString()} unmatched left rows · ${r.missingLeft.toLocaleString()} empty left keys · ${r.missingRight.toLocaleString()} empty right keys · ${r.duplicateRightKeys.toLocaleString()} repeated right keys${r.outputRows > this.options().maxRows ? ' · Above Maximum output rows; raise the limit or narrow inputs before saving.' : ''}`;
        const table = el('table'), head = el('thead'), tr = el('tr');
        for (const f of result.fields) tr.append(el('th', `${f.name} (${f.kind})`)); head.append(tr); table.append(head);
        const body = el('tbody'); for (const row of result.sample) { const tr = el('tr'); for (const v of row) tr.append(el('td', v == null ? 'null' : String(v))); body.append(tr); } table.append(body);
        this.sample.replaceChildren(el('p', `First ${result.sample.length} output rows`), table); this.sample.hidden = !result.sample.length;
    }
    private async execute(save: boolean) {
        if (this.controller) return;
        const controller = this.controller = new AbortController(); this.activeSources = [this.left.value, this.right.value]; this.error.hidden = true; this.status.textContent = 'Reading source snapshots…'; this.update();
        try {
            const result = await this.run(this.left.value, this.right.value, this.options(), save, controller.signal, message => { this.status.textContent = message; });
            if (controller.signal.aborted) throw Error('Join cancelled.');
            this.result = result; this.draw(result);
            if (save) {
                this.saving = true; this.status.textContent = 'Saving independent CSV copy…'; this.update();
                const name = this.name.value.trim(), ref = createUUID();
                await this.save({ id: createUUID(), name, enabled: true, config: { ...result.config, csvRef: ref, fileName: csvExportFilename(name).replace(/-filtered\.csv$/, '-joined.csv') } }, result.blob!);
                this.result = undefined; this.status.textContent = `Saved ${name} · ${result.report.outputRows.toLocaleString()} rows. Manage or remove it in Data sources.`;
            }
        } catch (e) {
            this.status.textContent = ''; this.error.textContent = controller.signal.aborted ? 'Join cancelled. Preview again when both inputs are ready.' : (e as Error).message; this.error.hidden = false;
        } finally { this.saving = false; this.controller = undefined; this.activeSources = []; this.update(); }
    }
}
