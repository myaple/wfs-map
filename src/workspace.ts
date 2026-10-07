import { transform, axisBounds, type Scale } from './scales.ts';
import { seriesColors, visibleSeries } from './multi-charts.ts';
import { themeColor } from './theme.ts';
import { parseUTC, utcISO, utcInput } from './time.ts';
import { createUUID } from './uuid.ts';
import { ChartInteraction, plotRect, drawAxes, pieSegments, type Point, type View } from './chart-plot.ts';
import { RawScatter } from './raw-scatter.ts';
import type { Field, Rule } from './data.ts';
import { all, type Expression, type ChartSpec, type ChartResult, type Axis } from './analysis.ts';
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const e = document.createElement(tag);
    if (text)
        e.textContent = text;
    return e;
};
const option = (value: string, label = value) => { const e = element('option', label); e.value = value; return e; };
let nextChartControl = 0;
let nextFilterGroup = 0;
export type ChartSource = { id: string; name: string; workspace: Workspace; enabled: boolean; available: boolean };
function chartField(select: HTMLSelectElement | HTMLInputElement, name: string, help: string) {
    const root = element('div'), label = element('label', name), hint = element('div', help);
    root.className = 'chart-field';
    select.id = `chart-control-${++nextChartControl}`;
    label.htmlFor = select.id;
    hint.id = `${select.id}-help`;
    hint.className = 'chart-field-help';
    select.setAttribute('aria-describedby', hint.id);
    root.append(label, select, hint);
    return { root, label, hint };
}
function button(text: string, click: () => void) { const b = element('button', text); b.type = 'button'; b.onclick = click; return b; }
export class Workspace {
    fields: Field[] = [];
    specs: ChartSpec[] = [];
    results: ChartResult[] = [];
    private views = new Map<string, ChartView>();
    private owners = new Map<string, { workspace: Workspace }>();
    private active?: HTMLDivElement;
    constructor(private changed: () => void, private rules: HTMLElement = document.getElementById('rules')!, private charts: HTMLElement = document.getElementById('charts')!, private sourceId = '', private chartSources: () => ChartSource[] = () => [], private inspect?: (expression: Expression) => void, private clearDatasetFilters: () => void = () => this.clearFilters()) { }
    reset() {
        this.fields = [];
        this.specs = [];
        this.results = [];
        for (const view of this.views.values())
            view.destroy();
        this.views.clear();
        this.owners.clear();
        this.rules.replaceChildren();
        this.active = undefined;
    }
    ready(fields: Field[]) {
        this.fields = fields;
        if (!this.rules.querySelector(':scope > .filter-group')) this.makeGroup(this.rules, 'and');
        if (this.specs.length) {
            for (const view of this.views.values()) view.setFields(fields);
            return;
        }
        const categorical = fields.find(f => f.kind === 'string' || f.kind === 'boolean'), numeric = fields.filter(f => f.kind === 'number'), date = fields.find(f => f.kind === 'date');
        if (categorical)
            this.addChart('bar', categorical.name);
        if (date)
            this.addChart('time', date.name);
        if (numeric.length)
            this.addChart('scatter', numeric.find(f => f.name !== 'id')?.name ?? numeric[0].name, numeric.find(f => f.name !== 'id' && f.name !== numeric.find(f => f.name !== 'id')?.name)?.name ?? numeric[0].name);
        if (!this.specs.length && fields.length)
            this.addChart('bar', fields[0].name);
    }
    private makeGroup(parent: HTMLElement, op: 'and' | 'or') {
        const group = element('div');
        group.className = 'filter-group';
        const head = element('div');
        head.className = 'group-head';
        const logic = element('select');
        logic.setAttribute('aria-label', 'Group logic');
        logic.append(option('and', 'AND · match all'), option('or', 'OR · match any'));
        logic.value = op;
        const children = element('div');
        children.className = 'group-children';
        children.id = `filter-group-${++nextFilterGroup}`;
        const toggle = button('▾', () => {
            children.hidden = !children.hidden;
            group.classList.toggle('collapsed', children.hidden);
            toggle.textContent = children.hidden ? '▸' : '▾';
            toggle.setAttribute('aria-expanded', String(!children.hidden));
            toggle.setAttribute('aria-label', children.hidden ? 'Expand filter group' : 'Collapse filter group');
        });
        toggle.setAttribute('aria-controls', children.id);
        toggle.setAttribute('aria-expanded', 'true');
        toggle.setAttribute('aria-label', 'Collapse filter group');
        const count = element('span');
        count.className = 'group-count hint';
        const addRule = button('+ Rule', () => this.addRule(group));
        const addGroup = button('+ Group', () => { this.makeGroup(children, 'or'); this.markActive(); });
        addRule.className = addGroup.className = 'group-add';
        head.append(toggle, logic, count, addRule, addGroup);
        if (parent !== this.rules)
            head.append(button('×', () => {
                if (group.contains(this.active ?? null)) {
                    this.active = this.rules.querySelector<HTMLDivElement>(':scope > .filter-group') ?? undefined;
                }
                group.remove();
                this.markActive();
                this.changed();
            }));
        // Editing a group chooses the destination for subsequent chart selections.
        // Ignore bubbled events from nested groups so they keep their own target.
        const activate = (event: Event) => {
            if ((event.target as Element).closest('.filter-group') === group) { this.active = group; this.markActive(); }
        };
        group.addEventListener('focusin', activate);
        group.addEventListener('change', activate);
        group.addEventListener('pointerdown', activate);
        group.append(head, children);
        parent.append(group);
        this.active = group;
        this.markActive();
        return group;
    }
    private updateGroupCounts() {
        this.rules.querySelectorAll('.filter-group').forEach(group => {
            const count = group.querySelectorAll('.rule').length;
            group.querySelector(':scope > .group-head > .group-count')!.textContent = `${count} ${count === 1 ? 'rule' : 'rules'}`;
        });
    }
    private markActive() {
        this.rules.querySelectorAll('.filter-group').forEach(g => g.classList.toggle('active-group', g === this.active));
        this.updateGroupCounts();
    }
    addRule(group = this.active, rule?: Rule) {
        if (!group)
            return;
        const row = element('div');
        row.className = 'rule';
        const field = element('select');
        field.setAttribute('aria-label', 'Attribute');
        field.append(...this.fields.map(f => option(f.name, `${f.name} (${f.kind})`)));
        if (rule && !this.fields.some(f => f.name === rule.field)) field.append(option(rule.field));
        if (rule) field.value = rule.field;
        const op = element('select');
        op.setAttribute('aria-label', 'Operator');
        for (const [v, t] of [['eq', '='], ['ne', '≠'], ['gte', '≥'], ['lte', '≤'], ['gt', '>'], ['lt', '<'], ['contains', 'contains'], ['null', 'is null'], ['notnull', 'not null'], ['in', 'is one of'], ['notin', 'is not one of']])
            op.append(option(v, t));
        if (rule) op.value = rule.op;
        const input = element('input');
        input.placeholder = 'Value · YYYY-MM-DD HH:mm:ss UTC for dates';
        input.setAttribute('aria-label', 'Filter value');
        const setOp = () => ['in', 'notin'].includes(op.value);
        input.value = rule ? setOp() ? JSON.stringify(rule.values ?? []) : this.fields.find(f => f.name === rule.field)?.kind === 'date' && rule.value && Number.isFinite(parseUTC(rule.value)) ? utcInput(rule.value) : rule.value ?? '' : '';
        let wasSet = setOp();
        const updateInput = () => {
            input.disabled = ['null', 'notnull'].includes(op.value);
            input.placeholder = setOp() ? '["first value", "second value"]' : 'Value · YYYY-MM-DD HH:mm:ss UTC for dates';
            input.title = setOp() ? 'Category values as a JSON list of strings. Values may contain commas.' : '';
            input.setCustomValidity('');
        };
        op.onchange = () => {
            if (setOp() !== wasSet) {
                if (setOp()) input.value = JSON.stringify([input.value]);
                else { try { input.value = JSON.parse(input.value)[0] ?? ''; } catch { input.value = ''; } }
            }
            wasSet = setOp(); updateInput();
        };
        input.oninput = () => input.setCustomValidity('');
        updateInput();
        row.append(field, op, input, button('×', () => { row.remove(); this.updateGroupCounts(); this.changed(); }));
        group.querySelector(':scope > .group-children')!.append(row);
        this.updateGroupCounts();
        return row;
    }
    private read(node: Element): Expression {
        if (node.classList.contains('filter-group'))
            return { op: (node.querySelector(':scope > .group-head > select') as HTMLSelectElement).value as 'and' | 'or', children: [...node.querySelector(':scope > .group-children')!.children].map(c => this.read(c)) };
        if ((node as any).expression)
            return (node as any).expression;
        const inputs = node.querySelectorAll('select,input');
        const field = (inputs[0] as HTMLSelectElement).value, op = (inputs[1] as HTMLSelectElement).value as Rule['op'], input = inputs[2] as HTMLInputElement;
        if (['in', 'notin'].includes(op)) {
            let values: unknown;
            try { values = JSON.parse(input.value); } catch { /* Report invalid lists below. */ }
            if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) {
                const message = 'Category values must be a JSON list of strings, such as ["station", "sensor"].';
                input.setCustomValidity(message); input.reportValidity(); throw Error(message);
            }
            return { field, op, values };
        }
        const date = this.fields.find(f => f.name === field)?.kind === 'date' && !['null', 'notnull'].includes(op) && Number.isFinite(parseUTC(input.value));
        const value = date ? utcISO(input.value) : input.value;
        if (date) input.value = utcInput(value);
        return { field, op, value };
    }
    expression(): Expression { const root = this.rules.querySelector(':scope > .filter-group'); return root ? this.read(root) : all([]); }
    clearFilters() { this.rules.replaceChildren(); this.makeGroup(this.rules, 'and'); this.changed(); }
    discardObservationSelections() {
        // Raw scatter observation indices belong to the previous loaded rows;
        // attribute predicates remain meaningful when server bounds change.
        for (const selection of this.rules.querySelectorAll('.selection, .observation-selection')) {
            // Read only the immutable observation markers; unfinished attribute
            // edits must not prevent discarding indices from the previous load.
            if ([selection, ...selection.querySelectorAll('.rule')].some(row => (row as any).expression?.op === 'row')) {
                if (selection.contains(this.active ?? null)) this.active = selection.parentElement?.closest<HTMLDivElement>('.filter-group') ?? undefined;
                selection.remove();
            }
        }
        this.markActive();
    }
    private appendExpression(group: HTMLDivElement, expression: Expression): HTMLElement {
        if ('children' in expression) {
            const nested = this.makeGroup(group.querySelector<HTMLElement>(':scope > .group-children')!, expression.op);
            for (const child of expression.children) this.appendExpression(nested, child);
            return nested;
        }
        if ('field' in expression) return this.addRule(group, expression)!;
        // Observation indices and geographic boxes are not attribute predicates.
        // Keep their exact semantics, displayed in the same compact control row.
        const row = element('div'); row.className = expression.op === 'row' ? 'rule observation-selection' : 'rule';
        (row as any).expression = structuredClone(expression);
        const field = element('select'), op = element('select'), value = element('input');
        field.setAttribute('aria-label', 'Attribute'); op.setAttribute('aria-label', 'Operator'); value.setAttribute('aria-label', 'Filter value');
        field.append(option(expression.op, expression.op === 'row' ? 'Observation' : 'Map area'));
        op.append(option(expression.op, expression.op === 'row' ? '=' : 'within'));
        field.disabled = op.disabled = true; value.readOnly = true;
        value.value = expression.op === 'row' ? String(expression.index) : `W ${expression.west}, S ${expression.south}, E ${expression.east}, N ${expression.north}`;
        row.append(field, op, value, button('×', () => { row.remove(); this.updateGroupCounts(); this.changed(); }));
        group.querySelector(':scope > .group-children')!.append(row);
        this.updateGroupCounts();
        return row;
    }
    select(expression: Expression, _label: string) {
        if (!this.active)
            return;
        const target = this.active;
        this.appendExpression(target, expression).classList.add('selection');
        this.active = target; this.markActive();
        this.changed();
    }
    addChart(type: ChartSpec['type'] = 'bar', x = this.fields[0]?.name, y?: string, saved?: ChartSpec) {
        if (!x || this.specs.length >= 12)
            return;
        const spec: ChartSpec = saved ? structuredClone(saved) : { id: `chart-${createUUID()}`, type, x, y, bins: 24 };
        this.charts.querySelector('.empty')?.remove();
        this.specs.push(spec);
        const owner = { workspace: this };
        this.owners.set(spec.id, owner);
        const view = new ChartView(this.charts, spec, this.fields,
            () => owner.workspace.changed(),
            () => owner.workspace.removeChart(spec.id),
            (expr, label, inspection, sourceId) => { const workspace = sourceId ? owner.workspace.chartSources().find(s => s.id === sourceId)?.workspace : owner.workspace; if (inspection) workspace?.inspect?.(expr); else workspace?.select(expr, label); },
            id => {
                const target = owner.workspace.chartSources().find(s => s.id === id)?.workspace;
                if (target) owner.workspace.moveChart(spec.id, target);
            }, () => owner.workspace.clearDatasetFilters());
        this.views.set(spec.id, view);
        this.refreshSources();
    }
    restore(expression: Expression, charts: ChartSpec[]) {
        for (const view of this.views.values()) view.destroy();
        this.views.clear(); this.owners.clear(); this.specs = []; this.results = [];
        this.rules.replaceChildren();
        const root = this.makeGroup(this.rules, 'children' in expression ? expression.op : 'and');
        for (const child of 'children' in expression ? expression.children : [expression]) this.appendExpression(root, child);
        this.active = root; this.markActive();
        for (const chart of charts) this.addChart(chart.type, chart.x, chart.y, chart);
    }
    private removeChart(id: string) {
        this.specs = this.specs.filter(s => s.id !== id);
        this.results = this.results.filter(r => r.id !== id);
        this.views.get(id)?.destroy(); this.views.delete(id); this.owners.delete(id);
        this.changed();
    }
    private moveChart(id: string, target: Workspace) {
        if (target === this) return;
        const spec = this.specs.find(s => s.id === id), view = this.views.get(id), owner = this.owners.get(id);
        if (!spec || !view || !owner) return;
        // Keep the live card (including its expanded dialog) in place, but
        // route every change and selection to the selected source's worker.
        this.specs = this.specs.filter(s => s !== spec);
        this.results = this.results.filter(r => r.id !== id);
        this.views.delete(id); this.owners.delete(id);
        target.specs.push(spec); target.views.set(id, view); target.owners.set(id, owner);
        owner.workspace = target;
        view.setFields(target.fields);
        target.refreshSources();
        this.changed(); target.changed();
    }
    reconfigure(fields: Field[]) {
        this.fields = fields;
        this.rules.replaceChildren(); this.makeGroup(this.rules, 'and');
        this.results = [];
        for (const view of this.views.values()) view.setFields(fields);
    }
    refreshSources() {
        const sources = this.chartSources();
        for (const view of this.views.values()) view.setSources(this.sourceId, sources);
    }

    chartPending(id: string) { this.views.get(id)?.error('Updating chart…'); }
    chartError(id: string, message: string) { this.results = this.results.filter(r => r.id !== id); this.views.get(id)?.error(message); }
    updateComparison(result: ChartResult) { this.results = [...this.results.filter(r => r.id !== result.id), result]; this.views.get(result.id)?.update(result); }
    update(results: ChartResult[]) {
        this.results = [...results, ...this.results.filter(r => this.specs.some(s => s.id === r.id && s.series?.length))];
        for (const result of results)
            this.views.get(result.id)?.update(result);
    }
    visibilityChanged() {
        for (const view of this.views.values())
            view.refreshRaw();
    }
    suspend() {
        this.results = [];
        for (const view of this.views.values())
            view.suspend();
        this.settled();
    }
    pending() { this.charts.setAttribute('aria-busy', 'true'); }
    settled() { this.charts.setAttribute('aria-busy', 'false'); }
}
function interval(axis: Axis, lo: number, hi: number): Expression {
    if (axis.ranges) {
        const first = axis.rules[lo] as {
            children: Expression[];
        }, last = axis.rules[hi] as {
            children: Expression[];
        };
        return { op: 'and', children: [first.children[0], last.children[1]] };
    }
    return lo === hi ? axis.rules[lo] : { op: 'or', children: axis.rules.slice(lo, hi + 1) };
}
class ChartView {
    private root = element('article');
    private canvas = element('canvas');
    private note = element('div');
    private list = element('div');
    private result?: ChartResult;
    private observer: ResizeObserver;
    private source = element('select');
    private sourceName = element('span');
    private seriesControls = element('div');
    private seriesLegend = element('div');
    private sources: ChartSource[] = [];
    private changed: () => void = () => {};
    private addSeries = element('button', '+ Add source');
    private x = element('select');
    private y = element('select');
    private type = element('select');
    private bins = element('select');
    private aggregate = element('select');
    private xScale = element('select');
    private yScale = element('select');
    private xScaleField = chartField(this.xScale, 'X axis scale', 'Log10 requires positive numeric values.');
    private yScaleField = chartField(this.yScale, 'Y axis scale', 'Log10 omits zero and negative values.');
    private xField = chartField(this.x, 'X attribute', '');
    private yField = chartField(this.y, 'Y attribute', '');
    private binsField = chartField(this.bins, 'Binning', '');
    private aggregateField = chartField(this.aggregate, 'Y aggregation', '');
    private title = element('h3');
    private raw?: RawScatter;
    private plot = element('div');
    private interaction: ChartInteraction;
    private expand = element('button', 'Enlarge');
    private help = element('p');
    private dialog?: HTMLDialogElement;
    private placeholder?: Comment;
    private focus = 0;
    private onThemeChange = () => this.draw();
    private hit = new Float32Array(0);
    private fullResult?: ChartResult;
    private pointSize = element('input');
    private pointSizeField = chartField(this.pointSize, 'Point size', 'Size of scatter points; binned circles retain relative counts.');
    private action = element('select');
    constructor(target: HTMLElement, private spec: ChartSpec, private fields: Field[], changed: () => void, remove: () => void, private select: (expr: Expression, label: string, inspection?: boolean, sourceId?: string) => void, sourceChanged: (id: string) => void, private clearDatasetFilters: () => void) {
        this.changed = changed;
        this.root.className = 'chart-card';
        this.root.dataset.chartId = spec.id;
        const header = element('div'), head = element('div');
        header.className = 'chart-header';
        head.className = 'chart-controls';
        head.id = `chart-settings-${++nextChartControl}`;
        head.hidden = true;
        head.setAttribute('role', 'group');
        head.setAttribute('aria-label', 'Chart settings');
        this.type.setAttribute('aria-label', 'Chart type');
        this.type.append(option('bar', 'Bar chart'), option('scatter', 'Scatter plot'), option('time', 'Time series'), option('pie', 'Pie chart'));
        this.type.value = spec.type;
        this.aggregate.append(...[['count', 'Point count'], ['sum', 'Sum'], ['mean', 'Average'], ['min', 'Minimum'], ['max', 'Maximum']].map(([v, label]) => option(v, label)));
        this.aggregate.value = spec.aggregate ?? 'count';
        const actions = element('div');
        actions.className = 'chart-actions';
        const settings = button('Settings', () => {
            head.hidden = !head.hidden;
            settings.setAttribute('aria-expanded', String(!head.hidden));
        });
        settings.setAttribute('aria-controls', head.id);
        settings.setAttribute('aria-expanded', 'false');
        const removeButton = button('×', () => {
            if (confirm('Delete this attribute chart?')) remove();
        });
        removeButton.setAttribute('aria-label', 'Remove chart');
        removeButton.title = 'Remove chart';
        removeButton.className = 'chart-icon';
        this.expand.className = 'chart-icon';
        this.expand.textContent = '⤢';
        this.expand.setAttribute('aria-label', 'Enlarge');
        this.expand.title = 'Enlarge';
        this.expand.setAttribute('aria-haspopup', 'dialog');
        this.expand.setAttribute('aria-expanded', 'false');
        this.expand.onclick = () => this.enlarge();
        this.action.setAttribute('aria-label', 'Chart selection action'); this.action.append(option('filter', 'Filter on selection'), option('inspect', 'Inspect without filtering'));
        actions.append(button('Fit data', () => { this.interaction.reset(); this.raw?.fit(); }), settings, this.expand, removeButton);
        const typeField = chartField(this.type, 'Chart type', '');
        typeField.hint.hidden = true;
        typeField.root.classList.add('chart-field-wide');
        const sourceField = chartField(this.source, 'Data source', 'First series. Each source uses its own applied dataset filters.');
        sourceField.root.classList.add('chart-field-wide');
        this.source.onchange = () => sourceChanged(this.source.value);
        this.sourceName.className = 'hint chart-source-name';
        const heading = element('div'); heading.append(this.title, this.sourceName);
        header.append(heading, actions);
        head.append(chartField(this.action, 'Selection action', 'Inspect records without changing filters, or add selected values to filters.').root, sourceField.root, typeField.root, this.xField.root, this.aggregateField.root, this.yField.root, this.xScaleField.root, this.yScaleField.root, this.binsField.root, this.pointSizeField.root);
        this.seriesControls.className = 'chart-series-controls';
        this.seriesLegend.className = 'chart-series-legend'; this.seriesLegend.setAttribute('aria-label', 'Chart source legend');
        this.addSeries.type = 'button';
        this.addSeries.onclick = () => {
            const source = this.sources.find(s => s.enabled && s.available && s.id !== this.root.dataset.sourceId && !this.spec.series?.some(m => m.sourceId === s.id));
            if (!source) return;
            const kind = this.fields.find(f => f.name === this.spec.x)?.kind, ykind = this.fields.find(f => f.name === this.spec.y)?.kind;
            const x = source.workspace.fields.find(f => f.kind === kind)?.name ?? source.workspace.fields[0]?.name ?? '';
            const y = source.workspace.fields.find(f => f.kind === ykind && f.name !== x)?.name ?? source.workspace.fields.find(f => f.kind === ykind)?.name;
            (this.spec.series ??= []).push({ sourceId: source.id, x, y }); this.renderSeries(); changed();
        };
        head.append(this.seriesControls, this.addSeries);
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute('role', 'img');
        this.note.className = 'hint';
        const legend = element('details');
        this.help.className = 'chart-help';
        legend.append(element('summary', 'Counts and keyboard selection'), this.help, this.list);
        this.plot.className = 'chart-plot';
        this.plot.append(this.canvas);
        this.root.append(header, head, this.plot, this.seriesLegend, this.note, legend);
        target.append(this.root);
        this.xScale.append(option('linear', 'Linear'), option('log10', 'Log10'));
        this.yScale.append(option('linear', 'Linear'), option('log10', 'Log10'));
        this.pointSize.type = 'range'; this.pointSize.min = '1'; this.pointSize.max = '12'; this.pointSize.step = '0.5';
        this.pointSize.oninput = () => { spec.pointSize = Number(this.pointSize.value); this.raw?.setPointSize(spec.pointSize); this.draw(); window.dispatchEvent(new Event('analysischange')); };
        this.configure();
        this.type.onchange = () => { spec.type = this.type.value as ChartSpec['type']; this.configure(); changed(); };
        this.x.onchange = () => { spec.x = this.x.value; this.refreshSettings(); changed(); };
        this.y.onchange = () => { spec.y = this.y.value; this.refreshSettings(); changed(); };
        for (const [control, key] of [[this.xScale, 'xScale'], [this.yScale, 'yScale']] as const) {
            control.onchange = () => { spec[key] = control.value as Scale; this.interaction.reset(); this.result = undefined; this.raw?.destroy(); this.raw = undefined; this.refreshSettings(); changed(); };
        }
        this.aggregate.onchange = () => { spec.aggregate = this.aggregate.value as ChartSpec['aggregate']; this.refreshSettings(); changed(); };
        this.bins.onchange = () => {
            const binned = this.bins.value !== 'exact';
            if (binned !== (spec.binned !== false)) {
                this.interaction.reset();
                this.result = undefined;
                this.raw?.destroy();
                this.raw = undefined;
            }
            spec.binned = binned;
            if (binned)
                spec.bins = Number(this.bins.value);
            this.refreshSettings();
            changed();
        };
        this.interaction = new ChartInteraction(this.canvas, this.plot, () => this.result?.type === 'pie' ? { left: 0, right: this.canvas.clientWidth, top: 0, bottom: this.canvas.clientHeight, width: this.canvas.clientWidth, height: this.canvas.clientHeight } : plotRect(this.canvas, this.result?.y?.kind === 'date', this.result?.x?.kind === 'date'), () => this.draw(), (a, b) => this.selectRectangle(a, b), p => {
            const cell = this.cellAt(p);
            if (cell >= 0)
                this.choose(cell, cell);
        }, this.clearDatasetFilters);
        this.canvas.addEventListener('pointermove', e => {
            if (!this.result)
                return;
            const b = this.canvas.getBoundingClientRect(), cell = this.cellAt([e.clientX - b.left, e.clientY - b.top]);
            this.canvas.title = cell >= 0 ? this.description(cell) : '';
        });
        this.canvas.onkeydown = e => {
            if (!this.result)
                return;
            const nx = this.result.x.labels.length;
            let next = this.focus;
            if (e.key === 'ArrowRight')
                next++;
            else if (e.key === 'ArrowLeft')
                next--;
            else if (e.key === 'ArrowUp')
                next += nx;
            else if (e.key === 'ArrowDown')
                next -= nx;
            else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.choose(this.focus, this.focus);
                return;
            }
            else
                return;
            e.preventDefault();
            this.focus = Math.max(0, Math.min(this.result.counts.length - 1, next));
            this.draw();
            this.note.textContent = this.description(this.focus);
        };
        this.canvas.onfocus = () => this.draw();
        this.canvas.onblur = () => this.draw();
        window.addEventListener('themechange', this.onThemeChange);
        this.observer = new ResizeObserver(() => this.draw());
        this.observer.observe(this.canvas);
    }
    setFields(fields: Field[]) { this.fields = fields; this.configure(); }
    setSources(id: string, sources: ChartSource[]) {
        this.sources = sources;
        const enabledSources = sources.filter(s => s.enabled && !this.spec.series?.some(m => m.sourceId === s.id));
        this.source.replaceChildren(...enabledSources.map(s => option(s.id, s.name + (s.available ? '' : ' (not loaded)'))));
        this.source.disabled = !enabledSources.length;
        if (!enabledSources.some(s => s.id === id)) {
            const placeholder = option('', enabledSources.length ? 'Choose an enabled data source' : 'No enabled data sources');
            placeholder.disabled = true;
            this.source.prepend(placeholder);
        }
        this.source.value = enabledSources.some(s => s.id === id) ? id : '';
        const source = sources.find(s => s.id === id);
        this.sourceName.textContent = source?.name ?? '';
        this.sourceName.title = this.sourceName.textContent;
        this.root.dataset.sourceId = id;
        this.renderSeries();
        if (source && !source.available || this.spec.series?.some(m => !sources.some(s => s.id === m.sourceId && s.enabled && s.available))) this.error('Load this source and every additional chart source to calculate charts.');
    }
    private renderSeries() {
        for (const option of this.source.options) option.disabled = !!this.spec.series?.some(s => s.sourceId === option.value) || !option.value;
        this.seriesControls.replaceChildren();
        for (const [i, mapping] of (this.spec.series ?? []).entries()) {
            const row = element('div'); row.className = 'chart-series-row';
            const source = element('select'), x = element('select'), y = element('select');
            source.append(...this.sources.filter(s => s.enabled && (s.id === mapping.sourceId || s.id !== this.root.dataset.sourceId && !this.spec.series?.some(m => m.sourceId === s.id))).map(s => option(s.id, s.name)));
            if (!this.sources.some(s => s.id === mapping.sourceId && s.enabled)) source.prepend(option(mapping.sourceId, 'Source unavailable'));
            source.value = mapping.sourceId;
            const fields = this.sources.find(s => s.id === mapping.sourceId)?.workspace.fields ?? [];
            const allowed = fields.filter(f => this.spec.type === 'time' ? f.kind === 'date' : true);
            x.append(...allowed.map(f => option(f.name))); x.value = mapping.x;
            const yFields = fields.filter(f => this.spec.type === 'time' ? f.kind === 'number' : true);
            y.append(...yFields.map(f => option(f.name))); y.value = mapping.y ?? '';
            const sourceField = chartField(source, `Source ${i + 2}`, 'Uses this source’s applied filters.'), xField = chartField(x, `Source ${i + 2} X attribute`, 'Shared axis types must match.'), yField = chartField(y, `Source ${i + 2} Y attribute`, 'Shared axis types must match.');
            yField.root.hidden = this.spec.type !== 'scatter' && (this.spec.type !== 'time' || (this.spec.aggregate ?? 'count') === 'count');
            source.onchange = () => { mapping.sourceId = source.value; const fields = this.sources.find(s => s.id === source.value)!.workspace.fields; mapping.x = fields.find(f => f.kind === this.fields.find(f => f.name === this.spec.x)?.kind)?.name ?? ''; mapping.y = fields.find(f => f.kind === this.fields.find(f => f.name === this.spec.y)?.kind)?.name; this.renderSeries(); this.changed(); };
            x.onchange = () => { mapping.x = x.value; this.changed(); }; y.onchange = () => { mapping.y = y.value; this.changed(); };
            row.append(sourceField.root, xField.root, yField.root, button(`Remove source ${i + 2}`, () => { this.spec.series!.splice(i, 1); this.renderSeries(); this.changed(); }));
            this.seriesControls.append(row);
        }
        this.addSeries.disabled = !this.sources.some(s => s.enabled && s.available && s.id !== this.root.dataset.sourceId && !this.spec.series?.some(m => m.sourceId === s.id));
        this.seriesLegend.replaceChildren();
        const validSources = new Set([this.root.dataset.sourceId, ...(this.spec.series ?? []).map(s => s.sourceId)]);
        if (this.spec.hiddenSources && this.root.dataset.sourceId) this.spec.hiddenSources = this.spec.hiddenSources.filter(id => validSources.has(id));
        const mappings = [{ sourceId: this.root.dataset.sourceId! }, ...(this.spec.series ?? [])];
        mappings.forEach((m, i) => {
            const item = button('', () => {
                const hidden = new Set(this.spec.hiddenSources ?? []);
                if (hidden.has(m.sourceId)) hidden.delete(m.sourceId); else hidden.add(m.sourceId);
                this.spec.hiddenSources = [...hidden]; this.renderSeries();
                if (this.fullResult) this.renderResult(visibleSeries(this.spec, this.fullResult));
                window.dispatchEvent(new Event('analysischange'));
            });
            const swatch = element('span'), mapping = i === 0 ? this.spec : this.spec.series![i - 1];
            const visible = !this.spec.hiddenSources?.includes(m.sourceId);
            item.setAttribute('aria-pressed', String(visible));
            item.dataset.sourceId = m.sourceId;
            item.title = `${visible ? 'Hide' : 'Show'} this source · X: ${mapping.x} · Y: ${this.spec.type === 'scatter' || this.spec.type === 'time' && this.spec.aggregate !== 'count' ? mapping.y : 'Point count'}`;
            swatch.className = 'chart-series-swatch'; swatch.style.background = seriesColors[i]; swatch.setAttribute('aria-hidden', 'true');
            item.append(swatch, document.createTextNode(this.sources.find(s => s.id === m.sourceId)?.name ?? 'Unavailable source'));
            this.seriesLegend.append(item);
        });
        this.seriesLegend.hidden = !this.spec.series?.length;
    }
    error(message: string) { this.suspend(); this.note.textContent = message; }
    private configure() {
        this.fullResult = undefined;
        this.interaction?.reset();
        if (this.spec.type !== 'scatter')
            this.spec.binned = true;
        this.result = undefined;
        this.raw?.destroy();
        this.raw = undefined;
        this.canvas.hidden = false;
        this.list.replaceChildren();
        this.draw();
        const allowed = this.fields.filter(f => this.spec.type === 'time' ? f.kind === 'date' : true);
        this.x.replaceChildren(...allowed.map(f => option(f.name)));
        if (!allowed.some(f => f.name === this.spec.x))
            this.spec.x = allowed[0]?.name ?? '';
        this.x.value = this.spec.x;
        const numeric = this.fields.filter(f => this.spec.type === 'time' ? f.kind === 'number' : true);
        this.y.replaceChildren(...numeric.map(f => option(f.name)));
        if (!numeric.some(f => f.name === this.spec.y))
            this.spec.y = numeric.find(f => f.name !== this.spec.x)?.name ?? numeric[0]?.name;
        this.y.value = this.spec.y ?? '';
        this.refreshSettings();
        this.x.disabled = !allowed.length;
        this.root.classList.toggle('unavailable', !allowed.length);
        this.note.textContent = allowed.length ? '' : 'No compatible attributes in this dataset. Choose another chart type.';
    }
    private refreshSettings() {
        this.title.textContent = this.type.selectedOptions[0].textContent;
        this.pointSizeField.root.hidden = this.spec.type !== 'scatter';
        this.pointSize.value = String(this.spec.pointSize ?? 2);
        const scatter = this.spec.type === 'scatter', time = this.spec.type === 'time';
        const kind = this.fields.find(f => f.name === this.spec.x)?.kind;
        const categorical = kind === 'string' || kind === 'boolean';
        this.xField.root.classList.toggle('chart-field-wide', categorical && !scatter && !time);
        this.xField.label.textContent = scatter ? 'X attribute' : time ? 'Time attribute' : 'Group by';
        this.xField.hint.textContent = scatter ? 'Horizontal axis: number, date or category.' : time ? 'Date attribute on the horizontal axis.' : kind === 'string' ? 'Count points in each category; less frequent categories go into Other.' : kind === 'boolean' ? 'Count points in the false and true groups.' : 'Count points in each value range.';
        this.yField.root.hidden = !scatter && (!time || (this.spec.aggregate ?? 'count') === 'count');
        this.yField.hint.textContent = scatter ? 'Vertical axis: number, date or category.' : 'Numeric attribute used by the Y aggregation.';
        this.aggregateField.root.hidden = !time;
        this.aggregateField.hint.textContent = (this.spec.aggregate ?? 'count') === 'count' ? 'Count points in each time interval.' : 'Calculate this measure of the Y attribute in each time interval.';
        const pie = this.spec.type === 'pie';
        this.xScaleField.root.hidden = this.yScaleField.root.hidden = pie;
        this.xScale.disabled = kind !== 'number';
        this.yScale.disabled = scatter && this.fields.find(f => f.name === this.spec.y)?.kind !== 'number';
        if (this.xScale.disabled || pie) this.spec.xScale = 'linear';
        if (this.yScale.disabled || pie) this.spec.yScale = 'linear';
        this.xScale.value = this.spec.xScale ?? 'linear'; this.yScale.value = this.spec.yScale ?? 'linear';
        this.binsField.root.hidden = categorical && !scatter && !time;
        this.binsField.root.classList.toggle('chart-field-wide', scatter);
        this.bins.replaceChildren(...(scatter ? [option('exact', 'No bins — individual points')] : []), ...[8, 16, 24, 32, 48, 64].map(n => option(String(n), scatter ? `${n} bins per axis` : time ? `${n} time intervals` : `${n} value ranges`)));
        this.bins.value = scatter && this.spec.binned === false ? 'exact' : String(this.spec.bins);
        this.renderSeries();
        this.binsField.hint.textContent = scatter ? this.spec.binned === false ? 'Draw every observation as a point, without grouping.' : 'Group nearby points into cells; circle size shows the point count. More bins give finer detail.' : time ? 'Split the full time span into equal intervals. More intervals give finer detail.' : 'Split the full value range into equal bins. More bins give finer detail.';
    }
    update(result: ChartResult) {
        this.fullResult = result;
        this.renderResult(visibleSeries(this.spec, result));
    }
    private renderResult(result: ChartResult) {
        if (this.result && (this.result.x.field !== result.x.field || this.result.y?.field !== result.y?.field))
            this.interaction.reset();
        const nx = result.x.labels.length, ny = result.y?.labels.length ?? 1;
        let loX = nx, hiX = 0, loY = ny, hiY = 0;
        result.counts.forEach((n, i) => { if (n) { const x = i % nx, y = Math.floor(i / nx); loX = Math.min(loX, x); hiX = Math.max(hiX, x + 1); loY = Math.min(loY, y); hiY = Math.max(hiY, y + 1); } });
        const fit: View = [0, 0, 1, 1];
        if (loX < hiX && result.type !== 'pie') {
            const pad = .04 * (hiX - loX) / nx;
            fit[0] = loX / nx - pad; fit[2] = hiX / nx + pad;
            if (result.y && loY < hiY) { const padY = .04 * (hiY - loY) / ny; fit[1] = loY / ny - padY; fit[3] = hiY / ny + padY; }
        }
        this.interaction.setFit(fit);
        this.result = result;
        this.focus = Math.min(this.focus, Math.max(0, result.counts.length - 1));
        this.canvas.hidden = !!result.raw;
        if (result.raw)
            this.refreshRaw();
        else {
            this.raw?.destroy();
            this.raw = undefined;
            this.draw();
        }
        const total = result.raw ? result.raw.series?.reduce((n, s) => n + s.end - s.start, 0) ?? result.raw.rows.length : result.counts.reduce((a, b) => a + b, 0);
        this.note.textContent = `${total.toLocaleString()} plotted · ${result.missing.toLocaleString()} missing${this.spec.xScale === 'log10' || this.spec.yScale === 'log10' ? ' · Log10 omits non-positive values' : ''}`;
        this.help.textContent = `${result.raw ? 'Individual observations.' : result.y ? 'Counted scatter bins.' : 'Click a segment to filter.'} Left-drag to zoom; right-drag to select; double-left-click to reset zoom; double-right-click to clear dataset filters.`;
        this.canvas.setAttribute('aria-label', `${result.type} chart of ${result.x.field}${result.y ? ' against ' + result.y.field : ''}. Arrow keys choose a bin; Enter filters it.`);
        this.list.replaceChildren();
        if (!result.y)
            for (let i = 0; i < result.counts.length; i++)
                this.list.append(button(this.description(i), () => this.choose(i, i)));
        else
            this.list.append(element('p', result.raw ? 'Focus the plot and use arrow keys to step through original observations; Enter selects one. Overlapping points return one observation on click.' : 'Focus the plot, use arrow keys to choose a cell, and press Enter. Each circle counts all points in its cell.'));
    }
    refreshRaw() {
        const r = this.result;
        if (!r?.raw)
            return;
        if (this.root.isConnected && !document.getElementById('analysis')?.hidden) {
            this.raw ??= new RawScatter((expr, label, sourceId) => this.select(expr, label, this.action.value === 'inspect', sourceId), () => this.root.dataset.sourceId ?? '', this.clearDatasetFilters);
            if (!this.raw.container.isConnected)
                this.canvas.after(this.raw.container);
            this.raw.setPointSize(this.spec.pointSize ?? 2);
            this.raw.update(r);
        }
        else {
            this.raw?.destroy();
            this.raw = undefined;
        }
    }
    private description(i: number) {
        const r = this.result!, nx = r.x.labels.length;
        const details = r.series ? r.series.map(s => `${s.name}: ${s.result.counts[i]}${s.result.values ? ` · ${s.result.measure}: ${Number.isFinite(s.result.values[i]) ? s.result.values[i] : 'no values'}` : ''}`).join(' · ') : r.values ? `${r.measure}: ${r.values[i]}` : '';
        return `${r.x.field}: ${r.x.labels[i % nx]}${r.y ? ` · ${r.y.field}: ${r.y.labels[Math.floor(i / nx)]}` : ''} · ${(r.counts[i] ?? 0).toLocaleString()}${details ? ' · ' + details : ''}${r.type === 'pie' ? ` · ${(100 * r.counts[i] / (r.counts.reduce((a, b) => a + b, 0) || 1)).toFixed(1)}%` : ''}`;
    }
    private selectRectangle(a: Point, b: Point) {
        const r = this.result;
        if (!r)
            return;
        if (r.type !== 'pie') {
            const first = this.cellAt(a), last = this.cellAt(b);
            if (first >= 0 && last >= 0)
                this.choose(first, last);
            return;
        }
        const lo = this.interaction.data([Math.min(a[0], b[0]), Math.max(a[1], b[1])]), hi = this.interaction.data([Math.max(a[0], b[0]), Math.min(a[1], b[1])]), w = this.canvas.clientWidth, h = this.canvas.clientHeight, radius = Math.min(w, h) * .36;
        const cells = pieSegments(r.counts, [lo[0] * w, (1 - hi[1]) * h, hi[0] * w, (1 - lo[1]) * h], w / 2, h / 2, radius * .51, radius);
        if (!cells.length)
            return;
        const children: Expression[] = [];
        for (let i = 0; i < cells.length;) {
            const lo = cells[i];
            let hi = lo;
            while (i + 1 < cells.length && cells[i + 1] === hi + 1) {
                i++;
                hi = cells[i];
            }
            children.push(interval(r.x, lo, hi));
            i++;
        }
        this.emit(children.length === 1 ? children[0] : { op: 'or', children }, `${r.x.field}: ${cells.length} segments`);
    }
    private emit(expr: Expression, label: string) {
        const r = this.result;
        if (!r?.series) { this.select(expr, label, this.action.value === 'inspect'); return; }
        for (const series of r.series) {
            const translate = (e: Expression): Expression => 'children' in e ? { ...e, children: e.children.map(translate) } : 'field' in e ? { ...e, field: e.field === r.x.field ? series.result.x.field : e.field === r.y?.field ? series.result.y!.field : e.field } : e;
            this.select(translate(expr), label, this.action.value === 'inspect', series.sourceId);
        }
    }
    private choose(a: number, b: number) {
        const r = this.result;
        if (!r || !r.counts.length || a < 0 || b < 0)
            return;
        const nx = r.x.labels.length, loX = Math.min(a % nx, b % nx), hiX = Math.max(a % nx, b % nx);
        let expr = interval(r.x, loX, hiX), label = `${r.x.field}: ${r.x.labels[loX]}${loX !== hiX ? ' … ' + r.x.labels[hiX] : ''}`;
        if (r.y) {
            const loY = Math.min(Math.floor(a / nx), Math.floor(b / nx)), hiY = Math.max(Math.floor(a / nx), Math.floor(b / nx));
            expr = { op: 'and', children: [expr, interval(r.y, loY, hiY)] };
            label += ` · ${r.y.field}: ${r.y.labels[loY]}${loY !== hiY ? ' … ' + r.y.labels[hiY] : ''}`;
        }
        if (r.series) for (const series of r.series) {
            let expression = interval(series.result.x, loX, hiX);
            if (series.result.y) expression = { op: 'and', children: [expression, interval(series.result.y, Math.min(Math.floor(a / nx), Math.floor(b / nx)), Math.max(Math.floor(a / nx), Math.floor(b / nx)))] };
            this.select(expression, label, this.action.value === 'inspect', series.sourceId);
        } else this.emit(expr, label);
    }
    private cellAt(point: Point) {
        const r = this.result;
        if (!r)
            return -1;
        const box = { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
        let [x, y] = point;
        if (r.type === 'pie') {
            const data = this.interaction.data(point);
            x = data[0] * box.width;
            y = (1 - data[1]) * box.height;
            const radius = Math.min(box.width, box.height) * .36, cx = box.width / 2, cy = box.height / 2, dx = x - cx, dy = y - cy;
            if (Math.hypot(dx, dy) > radius || Math.hypot(dx, dy) < radius * .51)
                return -1;
            let angle = Math.atan2(dy, dx) + Math.PI / 2;
            if (angle < 0)
                angle += Math.PI * 2;
            const total = r.counts.reduce((a, b) => a + b, 0);
            let cursor = 0;
            for (let i = 0; i < r.counts.length; i++) {
                cursor += r.counts[i] / total * Math.PI * 2;
                if (angle < cursor)
                    return i;
            }
            return -1;
        }
        for (let i = 0; i < this.hit.length; i += 4)
            if (x >= this.hit[i] && x < this.hit[i + 2] && y >= this.hit[i + 1] && y < this.hit[i + 3])
                return i / 4;
        return -1;
    }
    private draw() {
        const r = this.result, canvas = this.canvas, ctx = canvas.getContext('2d');
        if (!ctx)
            return;
        const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(devicePixelRatio, 2);
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);
        if (!r)
            return;
        this.hit = new Float32Array(0);
        const datasets = r.series?.map(s => s.result) ?? [r], yScale = this.spec.yScale ?? 'linear', finite = datasets.flatMap(s => Array.from(s.values ?? s.counts).filter(v => Number.isFinite(v) && (yScale !== 'log10' || v > 0))), low = yScale === 'log10' || r.values ? Math.min(...finite) : 0;
        const nx = r.x.labels.length, ny = r.y?.labels.length ?? 1, max = finite.length ? Math.max(...finite) : 1, total = r.counts.reduce((a, b) => a + b, 0);
        if (!r.counts.some(v => v > 0)) {
            ctx.fillStyle = themeColor('muted');
            ctx.font = '14px system-ui';
            ctx.fillText('No matching values', 24, 110);
            return;
        }
        const colors = [themeColor('chart-point'), '#3984cf', '#8b69c7', '#d29032', '#c86579', '#4d9c50'];
        this.hit = new Float32Array(r.counts.length * 4);
        ctx.font = '11px system-ui';
        ctx.fillStyle = themeColor('muted');
        if (r.type === 'pie') {
            const v = this.interaction.view, radius = Math.min(w, h) * .36;
            ctx.save();
            ctx.scale(1 / (v[2] - v[0]), 1 / (v[3] - v[1]));
            ctx.translate(-v[0] * w, -(1 - v[3]) * h);
            let angle = -Math.PI / 2;
            for (let i = 0; i < r.counts.length; i++) {
                const slices = r.series?.map(s => ({ count: s.result.counts[i], color: s.color })) ?? [{ count: r.counts[i], color: colors[i % colors.length] }];
                for (const slice of slices) {
                const end = angle + slice.count / total * Math.PI * 2;
                ctx.beginPath();
                ctx.moveTo(w / 2, h / 2);
                ctx.arc(w / 2, h / 2, radius, angle, end);
                ctx.closePath();
                ctx.fillStyle = slice.color;
                ctx.fill();
                angle = end;
                }
            }
            ctx.beginPath();
            ctx.arc(w / 2, h / 2, radius * .51, 0, Math.PI * 2);
            ctx.fillStyle = themeColor('surface');
            ctx.fill();
            ctx.fillStyle = themeColor('text');
            ctx.textAlign = 'center';
            ctx.fillText(total.toLocaleString(), w / 2, h / 2 + 4);
            ctx.restore();
            return;
        }
        const p = plotRect(canvas, r.y?.kind === 'date', r.x.kind === 'date'), { left, right, top, bottom } = p, view = this.interaction.view;
        canvas.dataset.plotRect = JSON.stringify(p);
        const dx = (right - left) / Math.max(nx, 1) / (view[2] - view[0]), dy = (bottom - top) / Math.max(ny, 1) / (view[3] - view[1]);
        const xBounds = r.x.ranges ? [r.x.ranges[0], r.x.ranges.at(-1)!] : [0, nx], yBounds = r.y?.ranges ? [r.y.ranges[0], r.y.ranges.at(-1)!] : r.y ? [0, ny] : axisBounds(Number.isFinite(low) ? low : 0, max || 1, yScale);
        if (!r.y && yScale === 'linear' && yBounds[1] !== yBounds[0]) { const pad = (yBounds[1] - yBounds[0]) * .05; yBounds[1] += pad; if (r.values) yBounds[0] -= pad; }
        else if (!r.y && yScale === 'log10' && yBounds[1] !== yBounds[0]) { yBounds[0] = Math.max(Number.MIN_VALUE, yBounds[0] / 1.1); yBounds[1] = Math.min(Number.MAX_VALUE, yBounds[1] * 1.1); }
        const bounds: View = [xBounds[0], yBounds[0], xBounds[1], yBounds[1]];
        drawAxes(ctx, p, view, bounds, r.x.ranges ? r.x.kind : 'category', r.y && !r.y.ranges ? 'category' : r.y?.kind, r.x.field + (r.x.scale === 'log10' ? ' (log10)' : ''), (r.y?.field ?? r.measure ?? 'Point count') + ((r.y?.scale ?? yScale) === 'log10' ? ' (log10)' : ''), r.x.ranges ? undefined : r.x.labels, r.y && !r.y.ranges ? r.y.labels : undefined, r.x.scale, r.y?.scale ?? yScale);
        canvas.dataset.scaleX = r.x.scale ?? 'linear'; canvas.dataset.scaleY = r.y?.scale ?? yScale;
        canvas.dataset.bounds = JSON.stringify(bounds);
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, right - left, bottom - top);
        ctx.clip();
        const pointX = (i: number) => this.interaction.screen([(i + .5) / nx, 0])[0];
        for (const [seriesIndex, dataset] of datasets.entries()) {
        const plotted = dataset.values ?? dataset.counts, color = r.series?.[seriesIndex].color ?? themeColor('chart-point');
        let prevX = 0, prevY = 0;
        for (let i = 0; i < r.counts.length; i++) {
            const xb = i % nx, yb = Math.floor(i / nx), x = pointX(xb) + (r.type === 'scatter' && datasets.length > 1 ? (seriesIndex - (datasets.length - 1) / 2) * Math.min(4, dx / datasets.length) : 0), y = this.interaction.screen([0, r.y ? (yb + .5) / ny : (transform(plotted[i], yScale) - transform(yBounds[0], yScale)) / (transform(yBounds[1], yScale) - transform(yBounds[0], yScale) || 1)])[1];
            const lo = this.interaction.screen([xb / nx, r.y ? (yb + 1) / ny : view[3]]), hi = this.interaction.screen([(xb + 1) / nx, r.y ? yb / ny : view[1]]);
            this.hit.set([lo[0], lo[1], hi[0], hi[1]], i * 4);
            ctx.fillStyle = i === this.focus && document.activeElement === canvas ? '#d29032' : color;
            if (!r.y && !Number.isFinite(transform(plotted[i], yScale))) { prevY = NaN; continue; }
            if (r.type === 'bar')
                ctx.fillRect(this.hit[i * 4] + seriesIndex * dx / datasets.length + 1, y, Math.max(1, dx / datasets.length - 2), this.interaction.screen([0, yScale === 'log10' ? 0 : (0 - yBounds[0]) / (yBounds[1] - yBounds[0])])[1] - y);
            else if (r.type === 'time') {
                if (!Number.isFinite(plotted[i])) {
                    prevY = NaN;
                    continue;
                }
                if (i && Number.isFinite(prevY)) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(prevX, prevY);
                    ctx.lineTo(x, y);
                    ctx.stroke();
                }
                ctx.beginPath();
                ctx.arc(x, y, 3, 0, Math.PI * 2);
                ctx.fill();
                prevX = x;
                prevY = y;
            }
            else if (dataset.counts[i]) {
                ctx.globalAlpha = .35 + .65 * Math.sqrt(dataset.counts[i] / max);
                ctx.beginPath();
                ctx.arc(x, y, Math.max(1, Math.min(dx, dy) * .48 * Math.sqrt(dataset.counts[i] / max) * (this.spec.pointSize ?? 2) / 2), 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }
        }
        ctx.restore();
    }

    private restoreSize() { const dialog = this.dialog; if (!dialog)
        return; this.dialog = undefined; window.dispatchEvent(new CustomEvent('timelinehost')); this.placeholder?.replaceWith(this.root); this.placeholder = undefined; dialog.close(); dialog.remove(); this.expand.textContent = '⤢'; this.expand.setAttribute('aria-label', 'Enlarge'); this.expand.title = 'Enlarge'; this.expand.setAttribute('aria-expanded', 'false'); this.expand.focus(); this.draw(); }
    private enlarge() {
        if (this.dialog) {
            this.restoreSize();
            return;
        }
        this.placeholder = document.createComment('chart position');
        this.root.before(this.placeholder);
        const dialog = element('dialog');
        this.dialog = dialog;
        dialog.className = 'chart-dialog';
        dialog.setAttribute('aria-label', 'Enlarged attribute chart');
        document.body.append(dialog);
        dialog.append(this.root);
        window.dispatchEvent(new CustomEvent('timelinehost', { detail: dialog }));
        this.expand.textContent = '⤡';
        this.expand.setAttribute('aria-label', 'Return to normal size');
        this.expand.title = 'Return to normal size';
        this.expand.setAttribute('aria-expanded', 'true');
        dialog.addEventListener('close', () => { if (this.dialog === dialog)
            this.restoreSize(); });
        dialog.showModal();
        this.expand.focus();
        this.draw();
    }
    suspend() { this.fullResult = undefined; this.raw?.destroy(); this.raw = undefined; this.canvas.hidden = false; this.result = undefined; this.list.replaceChildren(); this.note.textContent = 'Load this source to calculate charts.'; this.draw(); }
    destroy() { window.removeEventListener('themechange', this.onThemeChange); this.restoreSize(); this.interaction.destroy(); this.raw?.destroy(); this.observer.disconnect(); this.root.remove(); }
}
