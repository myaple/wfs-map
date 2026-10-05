import type { Field } from './data.ts';
import { identityColumns, recordText, recordValue, type RecordData, type RecordRef, type RecordRow } from './records.ts';
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const n = document.createElement(tag); n.textContent = text; return n; };
export type RecordsSource = { id: string; name: string; enabled: boolean; done: boolean; filtering: boolean; fields: Field[]; selected: number; metrics: { truncated?: boolean } };
export class RecordsPage {
    readonly root = el('section');
    readonly inspector = el('aside');
    get sourceId() { return this.source.value; }
    private source = el('select'); private search = el('input'); private status = el('p');
    private columns = el('details'); private scroll = el('div'); private table = el('table'); private body = el('tbody');
    private columnSummary = el('summary', 'Columns'); private columnOptions = el('div');
    private visible: string[] = []; private schema = ''; private sort = ''; private descending = false;
    private navigationRequest = 0; private focusPosition = 0;
    private scrollScale() { return Math.max(1, this.total * 34 / 8000000); }
    private request = 0; private total = 0; private offset = 0; private rows: RecordRow[] = [];
    private version = ''; private selected?: RecordRef; private selectedData?: RecordData;
    private exportButton = el('button', 'Download table CSV'); private copy = el('button', 'Copy record');
    constructor(private sources: () => RecordsSource[], private send: (id: string, message: unknown) => void, private inspect: (ref: RecordRef) => void, private sourceChanged: (id: string) => void) {
        this.root.id = 'records'; this.root.hidden = true; this.root.className = 'records-page';
        this.source.id = 'recordsSource'; this.source.setAttribute('aria-label', 'Records data source');
        this.search.type = 'search'; this.search.setAttribute('aria-label', 'Search applied records'); this.search.placeholder = 'Search all fields, IDs and coordinates';
        const controls = el('div'); controls.className = 'records-toolbar';
        const sourceControl = el('div'); sourceControl.className = 'records-source-control';
        const sourceLabel = el('label', 'Data source'); sourceLabel.htmlFor = this.source.id; sourceControl.append(sourceLabel, this.source);
        const searchControl = el('div'); searchControl.className = 'records-search-control'; this.search.id = 'recordsSearch';
        const searchLabel = el('label', 'Search records'); searchLabel.htmlFor = this.search.id; searchControl.append(searchLabel, this.search);
        const actions = el('div'); actions.className = 'records-actions'; actions.append(this.columns, this.exportButton);
        controls.append(sourceControl, searchControl, actions);
        this.columns.className = 'records-columns'; this.columnOptions.className = 'records-column-options';
        this.columnOptions.setAttribute('aria-label', 'Visible columns');
        this.columns.append(this.columnSummary, this.columnOptions); this.status.setAttribute('role', 'status');
        this.columns.addEventListener('keydown', event => { if (event.key === 'Escape') { this.columns.open = false; this.columnSummary.focus(); event.stopPropagation(); } });
        document.addEventListener('click', event => { if (!this.columns.contains(event.target as Node)) this.columns.open = false; });
        const layout = el('div'); layout.className = 'records-layout';
        this.scroll.className = 'records-scroll'; this.scroll.tabIndex = 0; this.scroll.setAttribute('aria-label', 'Records table. Arrow keys navigate; Enter inspects.');
        this.table.className = 'records-table'; this.table.append(el('thead'), this.body); this.scroll.append(this.table);
        this.inspector.className = 'record-inspector'; this.inspector.setAttribute('aria-label', 'Record inspector');
        layout.append(this.scroll, this.inspector); this.root.append(el('h2', 'Records'), el('p', 'Browse applied results. The filter sidebar and bottom timeline are shared across pages. Inspection highlights records without changing filters. Search narrows this table and its export.'), controls, this.status, layout);
        document.getElementById('app')!.append(this.root);
        this.source.onchange = () => { this.version = ''; this.reset(); this.refresh(); this.sourceChanged(this.source.value); };
        let timer: ReturnType<typeof setTimeout>;
        this.search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => this.reset(), 180); };
        this.scroll.onscroll = () => { const offset = Math.max(0, Math.min(Math.max(0, this.total - 40), Math.floor(this.scroll.scrollTop * this.scrollScale() / 34) - 4)); if (offset !== this.offset) { this.offset = offset; this.fetch(); } };
        this.scroll.onkeydown = e => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(e.key) || !this.total) return;
            e.preventDefault();
            const current = this.focusPosition;
            const position = e.key === 'Home' ? 0 : e.key === 'End' ? this.total - 1 : Math.max(0, Math.min(this.total - 1, current + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0)));
            this.focusPosition = position;
            this.send(this.source.value, { type: 'recordAt', request: ++this.navigationRequest, query: this.query(), position });
            this.scroll.scrollTop = Math.max(0, position * 34 / this.scrollScale() - 68);
        };
        this.exportButton.onclick = () => { this.exportButton.disabled = true; this.status.textContent = 'Preparing table export…'; this.send(this.source.value, { type: 'recordsExport', request: ++this.request, query: this.query(), columns: this.visible, sourceName: this.current()?.name }); };
        this.showInspector();
    }
    private current() { return this.sources().find(s => s.id === this.source.value && s.enabled); }
    private query() { return { search: this.search.value, sort: this.sort, descending: this.descending }; }
    private reset() { this.navigationRequest++; this.focusPosition = 0; this.offset = 0; this.scroll.scrollTop = 0; this.fetch(); }
    refresh() {
        const old = this.source.value, sources = this.sources().filter(s => s.enabled);
        this.source.replaceChildren(...sources.map(s => new Option(s.name, s.id))); if (sources.some(s => s.id === old)) this.source.value = old;
        this.source.disabled = !sources.length;
        const s = this.current(), version = s ? JSON.stringify([s.id, s.done, s.filtering, s.selected, s.fields]) : '';
        if (version === this.version) return;
        this.version = version;
        this.exportButton.disabled = !s?.done || s.filtering;
        if (!s?.done || s.filtering) { this.request++; this.body.replaceChildren(); this.status.textContent = s?.filtering ? 'Updating applied results…' : 'Load an enabled source to browse records.'; return; }
        const schema = JSON.stringify([s.id, s.fields]);
        if (schema !== this.schema) {
            this.schema = schema; this.visible = [...identityColumns, ...s.fields.map(f => f.name)]; this.sort = ''; this.search.value = '';
            this.columns.open = false; this.columnOptions.replaceChildren();
            for (const key of this.visible) {
                const check = el('input'); check.type = 'checkbox'; check.checked = true;
                const label = el('label'); label.append(check, el('span', this.label(key))); this.columnOptions.append(label);
                check.onchange = () => { this.visible = [...identityColumns, ...s.fields.map(f => f.name)].filter(k => k === key ? check.checked : this.visible.includes(k)); this.updateColumnSummary(); this.draw(); };
            }
            this.updateColumnSummary();
        }
        this.reset();
        if (this.selected && !this.sources().some(s => s.id === this.selected!.sourceId && s.enabled && s.done)) this.clearSelection();
    }
    invalidate(id: string) { if (id === this.source.value) { this.version = ''; this.refresh(); } }
    private updateColumnSummary() { this.columnSummary.textContent = `Columns · ${this.visible.length}/${this.columnOptions.childElementCount}`; }
    private label(key: string) { return key === '@source' ? 'Source' : key === '@id' ? 'Record ID' : key === '@longitude' ? 'Longitude' : key === '@latitude' ? 'Latitude' : `${key} (${this.current()?.fields.find(f => f.name === key)?.kind ?? 'unknown'})`; }
    private fetch() { const s = this.current(); if (!s?.done || s.filtering) return; this.send(s.id, { type: 'records', request: ++this.request, query: this.query(), offset: this.offset, limit: 40 }); }
    handle(id: string, m: any) {
        if (id !== this.source.value) return;
        if (m.type === 'recordAt') { if (m.request === this.navigationRequest && m.row) this.inspect({ sourceId: id, index: m.row.index }); return; }
        if (m.request !== this.request) return;
        if (m.type === 'records') { this.total = m.total; this.rows = m.rows; this.offset = m.offset; this.exportButton.disabled = false; this.status.textContent = `${m.total.toLocaleString()} table rows · ${this.current()?.selected.toLocaleString()} applied matches${this.current()?.metrics.truncated ? ' · load limit reached; loaded records only' : ''}`; this.draw(); }
        if (m.type === 'recordsExported') { const a = el('a'); a.href = URL.createObjectURL(m.blob); a.download = 'records.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); this.exportButton.disabled = false; this.status.textContent = `${m.total.toLocaleString()} table rows exported.`; }
        if (m.type === 'recordsError') { this.exportButton.disabled = false; this.status.textContent = m.message; }
    }
    private draw() {
        const head = el('tr');
        for (const key of this.visible) { const th = el('th'); th.setAttribute('aria-sort', this.sort === key ? this.descending ? 'descending' : 'ascending' : 'none'); const b = el('button', this.label(key)); b.onclick = () => { this.descending = this.sort === key && !this.descending; this.sort = key; this.reset(); }; th.append(b); head.append(th); }
        this.table.tHead!.replaceChildren(head); this.body.replaceChildren(); this.table.setAttribute('aria-rowcount', String(this.total + 1));
        const spacer = (height: number) => { const tr = el('tr'), td = el('td'); tr.setAttribute('aria-hidden', 'true'); td.colSpan = Math.max(1, this.visible.length); td.style.height = `${height}px`; td.style.padding = '0'; tr.append(td); this.body.append(tr); };
        spacer(this.offset * 34 / this.scrollScale());
        for (const [k, row] of this.rows.entries()) {
            const tr = el('tr'); tr.className = 'record-row'; tr.dataset.recordIndex = String(row.index); tr.setAttribute('aria-rowindex', String(this.offset + k + 2)); tr.setAttribute('aria-selected', String(row.index === this.selected?.index && this.source.value === this.selected?.sourceId));
            for (const key of this.visible) { const v = recordValue(row.data, key, this.current()?.name), td = el('td', recordText(v, this.current()?.fields.find(f => f.name === key)?.kind)); td.title = td.textContent!; if (v == null) td.className = 'null-value'; tr.append(td); }
            tr.onclick = () => { this.focusPosition = this.offset + k; this.inspect({ sourceId: this.source.value, index: row.index }); }; this.body.append(tr);
        }
        spacer(Math.max(0, this.total - this.offset - this.rows.length) * 34 / this.scrollScale());
    }
    selection(ref: RecordRef, data: RecordData) { this.selected = ref; this.selectedData = data; this.showInspector(); this.draw(); }
    clearSelection() { this.selected = undefined; this.selectedData = undefined; this.showInspector(); this.draw(); }
    private showInspector() {
        this.inspector.replaceChildren(el('h3', 'Record inspector'));
        const data = this.selectedData, source = this.sources().find(s => s.id === this.selected?.sourceId);
        if (!data || !source) { this.inspector.append(el('p', 'Choose a record in the table, map or plot.')); return; }
        const identity = el('p', `${source.name} · ${data.id == null ? `no stable ID · local row ${this.selected!.index + 1}` : `ID ${data.id}`}`);
        const table = el('table');
        for (const key of [...identityColumns, ...source.fields.map(f => f.name)]) { const tr = el('tr'), th = el('th', key.startsWith('@') ? key.slice(1) : `${key} (${source.fields.find(f => f.name === key)?.kind})`); tr.append(th, el('td', recordText(recordValue(data, key, source.name), source.fields.find(f => f.name === key)?.kind))); table.append(tr); }
        this.copy.onclick = async () => { const text = JSON.stringify({ source: source.name, id: data.id, coordinates: data.coordinates, properties: data.properties }, null, 2); try { await navigator.clipboard.writeText(text); this.copy.textContent = 'Copied'; } catch { const area = el('textarea'); area.value = text; area.setAttribute('aria-label', 'Copy record text'); this.inspector.append(area); area.select(); } };
        this.copy.textContent = 'Copy record'; const clear = el('button', 'Clear inspection'); clear.onclick = () => window.dispatchEvent(new CustomEvent('clearinspection'));
        const link = el('a', 'Open Records'); link.href = '#records'; this.inspector.append(identity, this.copy, clear, link, table);
    }
}
