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
function chartField(select: HTMLSelectElement, name: string, help: string) {
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
    private next = 0;
    private active?: HTMLDivElement;
    constructor(private changed: () => void, private rules: HTMLElement = document.getElementById('rules')!, private charts: HTMLElement = document.getElementById('charts')!) { }
    reset() {
        this.fields = [];
        this.specs = [];
        this.results = [];
        for (const view of this.views.values())
            view.destroy();
        this.views.clear();
        this.charts.replaceChildren();
        this.rules.replaceChildren();
        this.active = undefined;
        this.next = 0;
    }
    ready(fields: Field[]) {
        this.fields = fields;
        this.makeGroup(this.rules, 'and');
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
        const target = button('Add chart selections here', () => { this.active = group; this.markActive(); });
        target.className = 'target-group';
        const children = element('div');
        children.className = 'group-children';
        head.append(logic, target, button('+ Rule', () => this.addRule(group)), button('+ Group', () => { this.makeGroup(children, 'or'); this.markActive(); }));
        if (parent.id !== 'rules')
            head.append(button('×', () => {
                if (group.contains(this.active ?? null)) {
                    this.active = this.rules.querySelector<HTMLDivElement>(':scope > .filter-group') ?? undefined;
                }
                group.remove();
                this.markActive();
                this.changed();
            }));
        group.append(head, children);
        parent.append(group);
        this.active = group;
        this.markActive();
        return group;
    }
    private markActive() { this.rules.querySelectorAll('.filter-group').forEach(g => { g.classList.toggle('active-group', g === this.active); const b = g.querySelector<HTMLButtonElement>(':scope > .group-head > .target-group'); b?.setAttribute('aria-pressed', String(g === this.active)); }); }
    addRule(group = this.active) {
        if (!group)
            return;
        const row = element('div');
        row.className = 'rule';
        const field = element('select');
        field.setAttribute('aria-label', 'Attribute');
        field.append(...this.fields.map(f => option(f.name, `${f.name} (${f.kind})`)));
        const op = element('select');
        op.setAttribute('aria-label', 'Operator');
        for (const [v, t] of [['eq', '='], ['ne', '≠'], ['gte', '≥'], ['lte', '≤'], ['gt', '>'], ['lt', '<'], ['contains', 'contains'], ['null', 'is null'], ['notnull', 'not null']])
            op.append(option(v, t));
        const input = element('input');
        input.placeholder = 'Value · ISO 8601 for dates';
        input.setAttribute('aria-label', 'Filter value');
        op.onchange = () => input.disabled = ['null', 'notnull'].includes(op.value);
        row.append(field, op, input, button('×', () => { row.remove(); this.changed(); }));
        group.querySelector(':scope > .group-children')!.append(row);
    }
    private read(node: Element): Expression {
        if (node.classList.contains('filter-group'))
            return { op: (node.querySelector(':scope > .group-head > select') as HTMLSelectElement).value as 'and' | 'or', children: [...node.querySelector(':scope > .group-children')!.children].map(c => this.read(c)) };
        if (node.classList.contains('selection'))
            return (node as any).expression;
        const inputs = node.querySelectorAll('select,input');
        return { field: (inputs[0] as HTMLSelectElement).value, op: (inputs[1] as HTMLSelectElement).value as Rule['op'], value: (inputs[2] as HTMLInputElement).value };
    }
    expression(): Expression { const root = this.rules.querySelector(':scope > .filter-group'); return root ? this.read(root) : all([]); }
    clearFilters() { this.rules.replaceChildren(); this.makeGroup(this.rules, 'and'); this.changed(); }
    discardObservationSelections() {
        // Raw scatter observation indices belong to the previous loaded rows;
        // attribute predicates remain meaningful when server bounds change.
        const hasRow = (expr: Expression): boolean => expr.op === 'row' || ('children' in expr && expr.children.some(hasRow));
        for (const row of this.rules.querySelectorAll('.selection')) if (hasRow((row as any).expression)) row.remove();
    }
    select(expression: Expression, label: string) {
        if (!this.active)
            return;
        const row = element('div');
        row.className = 'selection';
        (row as any).expression = expression;
        const text = element('span', label);
        row.append(text, button('×', () => { row.remove(); this.changed(); }));
        this.active.querySelector(':scope > .group-children')!.append(row);
        this.changed();
    }
    addChart(type: ChartSpec['type'] = 'bar', x = this.fields[0]?.name, y?: string) {
        if (!x || this.specs.length >= 12)
            return;
        const spec: ChartSpec = { id: `chart-${++this.next}`, type, x, y, bins: 24 };
        this.specs.push(spec);
        this.views.set(spec.id, new ChartView(this.charts, spec, this.fields, () => this.changed(), () => { this.specs = this.specs.filter(s => s !== spec); this.views.get(spec.id)?.destroy(); this.views.delete(spec.id); this.changed(); }, (expr, label) => this.select(expr, label)));
    }
    update(results: ChartResult[]) {
        this.results = results;
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
    private x = element('select');
    private y = element('select');
    private type = element('select');
    private bins = element('select');
    private aggregate = element('select');
    private xField = chartField(this.x, 'X attribute', '');
    private yField = chartField(this.y, 'Y attribute', '');
    private binsField = chartField(this.bins, 'Binning', '');
    private aggregateField = chartField(this.aggregate, 'Y aggregation', '');
    private title = element('h3');
    private raw?: RawScatter;
    private plot = element('div');
    private interaction: ChartInteraction;
    private expand = element('button', 'Enlarge');
    private dialog?: HTMLDialogElement;
    private placeholder?: Comment;
    private focus = 0;
    private hit = new Float32Array(0);
    constructor(target: HTMLElement, private spec: ChartSpec, private fields: Field[], changed: () => void, remove: () => void, private select: (expr: Expression, label: string) => void) {
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
        const removeButton = button('×', remove);
        removeButton.setAttribute('aria-label', 'Remove chart');
        this.expand.setAttribute('aria-haspopup', 'dialog');
        this.expand.setAttribute('aria-expanded', 'false');
        this.expand.onclick = () => this.enlarge();
        actions.append(settings, this.expand, removeButton);
        const typeField = chartField(this.type, 'Chart type', '');
        typeField.hint.hidden = true;
        typeField.root.classList.add('chart-field-wide');
        header.append(this.title, actions);
        head.append(typeField.root, this.xField.root, this.aggregateField.root, this.yField.root, this.binsField.root);
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute('role', 'img');
        this.note.className = 'hint';
        const legend = element('details');
        legend.append(element('summary', 'Counts and keyboard selection'), this.list);
        this.plot.className = 'chart-plot';
        this.plot.append(this.canvas);
        this.root.append(header, head, this.plot, this.note, legend);
        target.append(this.root);
        this.configure();
        this.type.onchange = () => { spec.type = this.type.value as ChartSpec['type']; this.configure(); changed(); };
        this.x.onchange = () => { spec.x = this.x.value; this.refreshSettings(); changed(); };
        this.y.onchange = () => { spec.y = this.y.value; changed(); };
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
        this.interaction = new ChartInteraction(this.canvas, this.plot, () => this.result?.type === 'pie' ? { left: 0, right: this.canvas.clientWidth, top: 0, bottom: this.canvas.clientHeight, width: this.canvas.clientWidth, height: this.canvas.clientHeight } : plotRect(this.canvas, this.result?.y?.kind === 'date'), () => this.draw(), (a, b) => this.selectRectangle(a, b), p => {
            const cell = this.cellAt(p);
            if (cell >= 0)
                this.choose(cell, cell);
        });
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
        this.observer = new ResizeObserver(() => this.draw());
        this.observer.observe(this.canvas);
    }
    private configure() {
        this.interaction?.reset();
        if (this.spec.type !== 'scatter')
            this.spec.binned = true;
        this.result = undefined;
        this.raw?.destroy();
        this.raw = undefined;
        this.canvas.hidden = false;
        this.list.replaceChildren();
        this.draw();
        const allowed = this.fields.filter(f => this.spec.type === 'time' ? f.kind === 'date' : this.spec.type === 'scatter' ? ['number', 'date'].includes(f.kind) : true);
        this.x.replaceChildren(...allowed.map(f => option(f.name)));
        if (!allowed.some(f => f.name === this.spec.x))
            this.spec.x = allowed[0]?.name ?? '';
        this.x.value = this.spec.x;
        const numeric = this.fields.filter(f => this.spec.type === 'time' ? f.kind === 'number' : ['number', 'date'].includes(f.kind));
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
        const scatter = this.spec.type === 'scatter', time = this.spec.type === 'time';
        const kind = this.fields.find(f => f.name === this.spec.x)?.kind;
        const categorical = kind === 'string' || kind === 'boolean';
        this.xField.root.classList.toggle('chart-field-wide', categorical && !scatter && !time);
        this.xField.label.textContent = scatter ? 'X attribute' : time ? 'Time attribute' : 'Group by';
        this.xField.hint.textContent = scatter ? 'Horizontal axis: number or date.' : time ? 'Date attribute on the horizontal axis.' : kind === 'string' ? 'Count points in each category; less frequent categories go into Other.' : kind === 'boolean' ? 'Count points in the false and true groups.' : 'Count points in each value range.';
        this.yField.root.hidden = !scatter && (!time || (this.spec.aggregate ?? 'count') === 'count');
        this.yField.hint.textContent = scatter ? 'Vertical axis: number or date.' : 'Numeric attribute used by the Y aggregation.';
        this.aggregateField.root.hidden = !time;
        this.aggregateField.hint.textContent = (this.spec.aggregate ?? 'count') === 'count' ? 'Count points in each time interval.' : 'Calculate this measure of the Y attribute in each time interval.';
        this.binsField.root.hidden = categorical && !scatter && !time;
        this.binsField.root.classList.toggle('chart-field-wide', scatter);
        this.bins.replaceChildren(...(scatter ? [option('exact', 'No bins — individual points')] : []), ...[8, 16, 24, 32, 48, 64].map(n => option(String(n), scatter ? `${n} bins per axis` : time ? `${n} time intervals` : `${n} value ranges`)));
        this.bins.value = scatter && this.spec.binned === false ? 'exact' : String(this.spec.bins);
        this.binsField.hint.textContent = scatter ? this.spec.binned === false ? 'Draw every observation as a point, without grouping.' : 'Group nearby points into cells; circle size shows the point count. More bins give finer detail.' : time ? 'Split the full time span into equal intervals. More intervals give finer detail.' : 'Split the full value range into equal bins. More bins give finer detail.';
    }
    update(result: ChartResult) {
        if (this.result && (this.result.x.field !== result.x.field || this.result.y?.field !== result.y?.field))
            this.interaction.reset();
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
        const total = result.raw?.rows.length ?? result.counts.reduce((a, b) => a + b, 0);
        this.note.textContent = `${total.toLocaleString()} plotted · ${result.missing.toLocaleString()} missing · ${result.raw ? 'Individual observations. Left-drag to zoom; right-drag to select; double-click to reset.' : result.y ? 'Counted scatter bins. Left-drag to zoom; right-drag to select; double-click to reset.' : 'Click a segment to filter. Left-drag to zoom; right-drag to select; double-click to reset.'}`;
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
            this.raw ??= new RawScatter(this.select);
            if (!this.raw.container.isConnected)
                this.canvas.after(this.raw.container);
            this.raw.update(r);
        }
        else {
            this.raw?.destroy();
            this.raw = undefined;
        }
    }
    private description(i: number) { const r = this.result!, nx = r.x.labels.length; return `${r.x.field}: ${r.x.labels[i % nx]}${r.y ? ` · ${r.y.field}: ${r.y.labels[Math.floor(i / nx)]}` : ''} · ${(r.counts[i] ?? 0).toLocaleString()}${r.values ? ` · ${r.measure}: ${r.values[i]}` : ''}`; }
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
        this.select(children.length === 1 ? children[0] : { op: 'or', children }, `${r.x.field}: ${cells.length} segments`);
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
        this.select(expr, label);
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
        const plotted = r.values ?? r.counts, finite = Array.from(plotted).filter(Number.isFinite), low = r.values ? Math.min(0, ...finite) : 0;
        const nx = r.x.labels.length, ny = r.y?.labels.length ?? 1, max = finite.reduce((a, b) => Math.max(a, b), 0), total = r.counts.reduce((a, b) => a + b, 0);
        if (!r.counts.some(v => v > 0)) {
            ctx.fillStyle = '#607588';
            ctx.font = '14px system-ui';
            ctx.fillText('No matching values', 24, 110);
            return;
        }
        const colors = ['#0d9188', '#3984cf', '#8b69c7', '#d29032', '#c86579', '#4d9c50'];
        this.hit = new Float32Array(r.counts.length * 4);
        ctx.font = '11px system-ui';
        ctx.fillStyle = '#546b7a';
        if (r.type === 'pie') {
            const v = this.interaction.view, radius = Math.min(w, h) * .36;
            ctx.save();
            ctx.scale(1 / (v[2] - v[0]), 1 / (v[3] - v[1]));
            ctx.translate(-v[0] * w, -(1 - v[3]) * h);
            let angle = -Math.PI / 2;
            for (let i = 0; i < r.counts.length; i++) {
                const end = angle + r.counts[i] / total * Math.PI * 2;
                ctx.beginPath();
                ctx.moveTo(w / 2, h / 2);
                ctx.arc(w / 2, h / 2, radius, angle, end);
                ctx.closePath();
                ctx.fillStyle = colors[i % colors.length];
                ctx.fill();
                angle = end;
            }
            ctx.beginPath();
            ctx.arc(w / 2, h / 2, radius * .51, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.fillStyle = '#254557';
            ctx.textAlign = 'center';
            ctx.fillText(total.toLocaleString(), w / 2, h / 2 + 4);
            ctx.restore();
            return;
        }
        const p = plotRect(canvas, r.y?.kind === 'date'), { left, right, top, bottom } = p, view = this.interaction.view;
        const dx = (right - left) / Math.max(nx, 1) / (view[2] - view[0]), dy = (bottom - top) / Math.max(ny, 1) / (view[3] - view[1]);
        const xBounds = r.x.ranges ? [r.x.ranges[0], r.x.ranges.at(-1)!] : [0, nx], yBounds = r.y?.ranges ? [r.y.ranges[0], r.y.ranges.at(-1)!] : [low, max || 1];
        const bounds: View = [xBounds[0], yBounds[0], xBounds[1], yBounds[1]];
        drawAxes(ctx, p, view, bounds, r.x.ranges ? r.x.kind : 'category', r.y?.kind, r.x.field, r.y?.field ?? r.measure ?? 'Point count');
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, right - left, bottom - top);
        ctx.clip();
        const pointX = (i: number) => this.interaction.screen([(i + .5) / nx, 0])[0];
        let prevX = 0, prevY = 0;
        for (let i = 0; i < r.counts.length; i++) {
            const xb = i % nx, yb = Math.floor(i / nx), x = pointX(xb), y = this.interaction.screen([0, r.y ? (yb + .5) / ny : (plotted[i] - low) / (max - low || 1)])[1];
            const lo = this.interaction.screen([xb / nx, r.y ? (yb + 1) / ny : view[3]]), hi = this.interaction.screen([(xb + 1) / nx, r.y ? yb / ny : view[1]]);
            this.hit.set([lo[0], lo[1], hi[0], hi[1]], i * 4);
            ctx.fillStyle = i === this.focus && document.activeElement === canvas ? '#d29032' : '#0d9188';
            if (r.type === 'bar')
                ctx.fillRect(this.hit[i * 4] + 1, y, Math.max(1, dx - 2), this.interaction.screen([0, 0])[1] - y);
            else if (r.type === 'time') {
                if (!Number.isFinite(plotted[i])) {
                    prevY = NaN;
                    continue;
                }
                if (i && Number.isFinite(prevY)) {
                    ctx.strokeStyle = '#0d9188';
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
            else if (r.counts[i]) {
                ctx.globalAlpha = .35 + .65 * Math.sqrt(r.counts[i] / max);
                ctx.beginPath();
                ctx.arc(x, y, Math.max(1, Math.min(dx, dy) * .48 * Math.sqrt(r.counts[i] / max)), 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }
        ctx.restore();
        if (!r.x.ranges && !r.y) {
            ctx.fillStyle = '#546b7a';
            ctx.font = '11px system-ui';
            ctx.textAlign = 'center';
            for (let i = 0; i < nx; i++) {
                const x = pointX(i);
                if (x >= left && x <= right && nx * (view[2] - view[0]) <= 10)
                    ctx.fillText(r.x.labels[i], x, bottom + 18, Math.max(1, dx - 3));
            }
        }
    }
    private restoreSize() { const dialog = this.dialog; if (!dialog)
        return; this.dialog = undefined; this.placeholder?.replaceWith(this.root); this.placeholder = undefined; dialog.close(); dialog.remove(); this.expand.textContent = 'Enlarge'; this.expand.setAttribute('aria-expanded', 'false'); this.expand.focus(); this.draw(); }
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
        this.expand.textContent = 'Return to normal size';
        this.expand.setAttribute('aria-expanded', 'true');
        dialog.addEventListener('close', () => { if (this.dialog === dialog)
            this.restoreSize(); });
        dialog.showModal();
        this.expand.focus();
        this.draw();
    }
    suspend() { this.raw?.destroy(); this.raw = undefined; this.canvas.hidden = false; this.result = undefined; this.list.replaceChildren(); this.note.textContent = 'Load this source to calculate charts.'; this.draw(); }
    destroy() { this.restoreSize(); this.interaction.destroy(); this.raw?.destroy(); this.observer.disconnect(); this.root.remove(); }
}
