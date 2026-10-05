import type { Field } from './data.ts';
import { filterLiteral, serverOperators, validateServerFilters, type ServerFilter } from './server-filters.ts';

type Source = { id: string; name: string; enabled: boolean; fields: Field[]; serverFilters?: ServerFilter[] };
const labels: Record<ServerFilter['op'], string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'Contains', null: 'Is empty', notnull: 'Is not empty' };
export class ServerFilterPanel {
    private select = document.createElement('select');
    private rows = document.createElement('div');
    private message = document.createElement('p');
    private error = document.createElement('p');
    private add = document.createElement('button');
    private apply = document.createElement('button');
    private clear = document.createElement('button');
    private read = document.createElement('button');
    private drafts = new Map<string, ServerFilter[]>();
    private fields = new Map<string, Field[]>();
    private busy = new Set<string>();
    private generation = 0;
    constructor(private host: HTMLDetailsElement, private sources: () => Source[], private discover: (source: Source) => Promise<Field[]>, private commit: (source: Source, rules: ServerFilter[]) => void) {
        const hint = document.createElement('p'); hint.className = 'hint';
        hint.textContent = 'Limit data before loading: WFS filters run on the server; CSV filters run during import. All rules must match. Dataset filters below act on loaded points.';
        this.select.id = 'serverFilterSource';
        const label = document.createElement('label'); label.htmlFor = this.select.id; label.textContent = 'Server filter data source';
        const controls = document.createElement('div'); controls.className = 'query-controls';
        this.read.textContent = 'Read available fields'; this.read.type = 'button';
        controls.append(label, this.select, this.read);
        this.rows.id = 'serverFilterRules';
        this.message.className = 'hint'; this.message.setAttribute('role', 'status');
        this.error.className = 'error'; this.error.setAttribute('role', 'alert'); this.error.hidden = true;
        this.add.textContent = 'Add server rule'; this.apply.textContent = 'Apply and reload source'; this.apply.className = 'primary'; this.clear.textContent = 'Clear and reload source';
        const actions = document.createElement('div'); actions.className = 'row';
        for (const b of [this.add, this.apply, this.clear]) { b.type = 'button'; actions.append(b); }
        host.append(hint, controls, this.message, this.rows, actions, this.error);
        this.select.onchange = () => { this.error.hidden = true; this.render(); void this.ensureFields(); };
        host.ontoggle = () => { if (host.open) void this.ensureFields(); };
        this.read.onclick = () => void this.ensureFields(true);
        this.add.onclick = () => {
            const s = this.source(), field = s && this.available(s)[0];
            if (!s || !field) return;
            this.draft(s).push({ field: field.name, kind: field.kind, op: 'eq', value: field.kind === 'boolean' ? 'true' : '' }); this.render();
        };
        this.apply.onclick = () => this.save(false);
        this.clear.onclick = () => this.save(true);
    }
    private source() { return this.sources().find(s => s.id === this.select.value); }
    private available(s: Source) { return this.fields.get(s.id) ?? s.fields; }
    private draft(s: Source) {
        if (!this.drafts.has(s.id)) this.drafts.set(s.id, structuredClone(s.serverFilters ?? []));
        return this.drafts.get(s.id)!;
    }
    refresh(reset = false) {
        if (reset) { this.generation++; this.fields.clear(); this.drafts.clear(); this.busy.clear(); }
        const previous = this.select.value, sources = this.sources().filter(s => s.enabled);
        this.select.replaceChildren(...sources.map(s => new Option(s.name, s.id)));
        if (!sources.length) this.select.add(new Option('No enabled data sources', ''));
        if (sources.some(s => s.id === previous)) this.select.value = previous;
        this.select.disabled = !sources.length;
        this.render(); if (this.host.open) void this.ensureFields();
    }
    private async ensureFields(force = false) {
        const s = this.source(); if (!s || this.busy.has(s.id) || (!force && this.available(s).length)) return;
        const generation = this.generation;
        this.busy.add(s.id); this.error.hidden = true; this.render();
        try {
            const fields = await this.discover(s);
            if (generation !== this.generation) return;
            if (!fields.length) throw Error('No filterable attributes found. Check the source settings and try Read available fields again.');
            this.fields.set(s.id, fields);
        } catch (e) { if (generation === this.generation && this.source()?.id === s.id) this.showError(e); }
        finally { if (generation === this.generation) { this.busy.delete(s.id); if (this.source()?.id === s.id) this.render(); } }
    }
    private showError(e: unknown) { this.error.textContent = (e as Error).message; this.error.hidden = false; }
    private save(clear: boolean) {
        const s = this.source(); if (!s) return;
        try {
            const rules = clear ? [] : this.draft(s);
            validateServerFilters(rules, this.available(s));
            const normalized = rules.map(r => r.op === 'null' || r.op === 'notnull' ? { field: r.field, kind: r.kind, op: r.op } : { ...r, value: filterLiteral(r) });
            this.commit(s, normalized); this.drafts.set(s.id, structuredClone(normalized));
            this.error.hidden = true; this.render();
        } catch (e) { this.showError(e); }
    }
    private render() {
        const s = this.source(), fields = s ? this.available(s) : [], busy = !!s && this.busy.has(s.id);
        this.rows.replaceChildren();
        this.read.disabled = !s || busy;
        this.add.disabled = !s || !fields.length || busy || this.draft(s).length >= 100;
        this.apply.disabled = !s || busy || (!fields.length && !!this.draft(s).length);
        this.clear.disabled = !s || busy;
        this.message.textContent = !s ? 'Enable a data source to configure load filters.' : busy ? 'Reading available fields…' : `${s.serverFilters?.length ?? 0} applied rule(s) for ${s.name}. Edits take effect when you apply and reload.`;
        if (!s) return;
        const rules = this.draft(s);
        rules.forEach((rule, index) => {
            const row = document.createElement('div'); row.className = 'server-filter-row';
            const field = document.createElement('select'); field.setAttribute('aria-label', `Server rule ${index + 1} field`);
            field.replaceChildren(...fields.map(f => new Option(`${f.name} (${f.kind})`, f.name)));
            if (!fields.some(f => f.name === rule.field)) field.add(new Option(`${rule.field} (unavailable)`, rule.field));
            field.value = rule.field;
            field.onchange = () => { const f = fields.find(f => f.name === field.value)!; Object.assign(rule, { field: f.name, kind: f.kind, op: 'eq', value: f.kind === 'boolean' ? 'true' : '' }); this.render(); };
            const op = document.createElement('select'); op.setAttribute('aria-label', `Server rule ${index + 1} operator`);
            op.replaceChildren(...serverOperators(rule.kind).map(o => new Option(labels[o], o))); op.value = rule.op;
            op.onchange = () => { rule.op = op.value as ServerFilter['op']; this.render(); };
            const value = rule.kind === 'boolean' ? document.createElement('select') : document.createElement('input');
            value.setAttribute('aria-label', `Server rule ${index + 1} value`);
            if (value instanceof HTMLSelectElement) value.replaceChildren(new Option('True', 'true'), new Option('False', 'false'));
            else { value.type = rule.kind === 'number' ? 'number' : 'text'; if (rule.kind === 'number') value.step = 'any'; value.placeholder = rule.kind === 'date' ? 'YYYY-MM-DD HH:mm:ss (UTC)' : 'Value'; }
            value.value = rule.value ?? ''; value.hidden = rule.op === 'null' || rule.op === 'notnull';
            value.oninput = () => { rule.value = value.value; };
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove server rule ${index + 1}`);
            remove.onclick = () => { rules.splice(index, 1); this.render(); };
            row.append(field, op, value, remove); this.rows.append(row);
        });
    }
}
