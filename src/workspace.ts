import type { Field, Rule } from './data.ts';
import { all, type Expression, type ChartSpec, type ChartResult, type Axis } from './analysis.ts';
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const e = document.createElement(tag);
    if (text)
        e.textContent = text;
    return e;
};
const option = (value: string, label = value) => { const e = element('option', label); e.value = value; return e; };
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
    suspend() { this.results = []; for (const view of this.views.values())
        view.suspend(); this.settled(); }
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
    private start: number | null = null;
    private drag: number | null = null;
    private focus = 0;
    private hit = new Float32Array(0);
    constructor(target: HTMLElement, private spec: ChartSpec, private fields: Field[], changed: () => void, remove: () => void, private select: (expr: Expression, label: string) => void) {
        this.root.className = 'chart-card';
        this.root.dataset.chartId = spec.id;
        const head = element('div');
        head.className = 'chart-controls';
        this.type.setAttribute('aria-label', 'Chart type');
        this.type.append(option('bar', 'Bar chart'), option('scatter', 'Scatter plot'), option('time', 'Time series'), option('pie', 'Pie chart'));
        this.type.value = spec.type;
        this.x.setAttribute('aria-label', 'X attribute');
        this.y.setAttribute('aria-label', 'Y attribute');
        this.bins.setAttribute('aria-label', 'Number of bins');
        this.bins.append(...[8, 16, 24, 32, 48, 64].map(n => option(String(n), `${n} bins`)));
        this.bins.value = String(spec.bins);
        head.append(this.type, this.x, this.y, this.bins, button('×', remove));
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute('role', 'img');
        this.note.className = 'hint';
        const legend = element('details');
        legend.append(element('summary', 'Counts and keyboard selection'), this.list);
        this.root.append(head, this.canvas, this.note, legend);
        target.append(this.root);
        this.configure();
        this.type.onchange = () => { spec.type = this.type.value as ChartSpec['type']; this.configure(); changed(); };
        this.x.onchange = () => { spec.x = this.x.value; changed(); };
        this.y.onchange = () => { spec.y = this.y.value; changed(); };
        this.bins.onchange = () => { spec.bins = Number(this.bins.value); changed(); };
        this.canvas.onpointerdown = e => {
            if (!this.result)
                return;
            this.start = this.cell(e);
            this.canvas.setPointerCapture(e.pointerId);
        };
        this.canvas.onpointermove = e => {
            if (!this.result)
                return;
            const cell = this.cell(e);
            this.canvas.title = cell >= 0 ? this.description(cell) : '';
            if (this.start !== null && this.result.y) {
                this.drag = cell;
                this.draw();
            }
        };
        this.canvas.onpointercancel = () => { this.start = null; this.drag = null; this.draw(); };
        this.canvas.onpointerup = e => {
            const end = this.cell(e);
            if (this.start !== null && end >= 0)
                this.choose(this.start, end);
            this.start = null;
            this.drag = null;
            this.draw();
        };
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
        this.result = undefined;
        this.list.replaceChildren();
        this.draw();
        const allowed = this.fields.filter(f => this.spec.type === 'time' ? f.kind === 'date' : this.spec.type === 'scatter' ? ['number', 'date'].includes(f.kind) : true);
        this.x.replaceChildren(...allowed.map(f => option(f.name)));
        if (!allowed.some(f => f.name === this.spec.x))
            this.spec.x = allowed[0]?.name ?? '';
        this.x.value = this.spec.x;
        const numeric = this.fields.filter(f => ['number', 'date'].includes(f.kind));
        this.y.replaceChildren(...numeric.map(f => option(f.name)));
        if (!numeric.some(f => f.name === this.spec.y))
            this.spec.y = numeric.find(f => f.name !== this.spec.x)?.name ?? numeric[0]?.name;
        this.y.value = this.spec.y ?? '';
        this.y.hidden = this.spec.type !== 'scatter';
        this.x.disabled = !allowed.length;
        this.root.classList.toggle('unavailable', !allowed.length);
        this.note.textContent = allowed.length ? '' : 'No compatible attributes in this dataset. Choose another chart type.';
    }
    update(result: ChartResult) {
        this.result = result;
        this.focus = Math.min(this.focus, Math.max(0, result.counts.length - 1));
        this.draw();
        const total = result.counts.reduce((a, b) => a + b, 0);
        this.note.textContent = `${total.toLocaleString()} plotted · ${result.missing.toLocaleString()} missing · ${result.y ? 'Counted scatter bins; drag a rectangle to filter.' : 'Click a segment to filter.'}`;
        this.canvas.setAttribute('aria-label', `${result.type} chart of ${result.x.field}${result.y ? ' against ' + result.y.field : ''}. Arrow keys choose a bin; Enter filters it.`);
        this.list.replaceChildren();
        if (!result.y)
            for (let i = 0; i < result.counts.length; i++)
                this.list.append(button(this.description(i), () => this.choose(i, i)));
        else
            this.list.append(element('p', 'Focus the plot, use arrow keys to choose a cell, and press Enter. Each circle counts all points in its cell.'));
    }
    private description(i: number) { const r = this.result!, nx = r.x.labels.length; return `${r.x.field}: ${r.x.labels[i % nx]}${r.y ? ` · ${r.y.field}: ${r.y.labels[Math.floor(i / nx)]}` : ''} · ${(r.counts[i] ?? 0).toLocaleString()}`; }
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
    private cell(e: PointerEvent) {
        const r = this.result;
        if (!r)
            return -1;
        const box = this.canvas.getBoundingClientRect(), x = e.clientX - box.left, y = e.clientY - box.top;
        if (r.type === 'pie') {
            const dx = x - box.width / 2, dy = y - 120;
            if (Math.hypot(dx, dy) > 88 || Math.hypot(dx, dy) < 45)
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
        const w = canvas.clientWidth, h = 240, dpr = Math.min(devicePixelRatio, 2);
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);
        if (!r)
            return;
        this.hit = new Float32Array(0);
        const nx = r.x.labels.length, ny = r.y?.labels.length ?? 1, max = r.counts.reduce((a, b) => Math.max(a, b), 0), total = r.counts.reduce((a, b) => a + b, 0);
        if (!max) {
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
            let angle = -Math.PI / 2;
            for (let i = 0; i < r.counts.length; i++) {
                const end = angle + r.counts[i] / total * Math.PI * 2;
                ctx.beginPath();
                ctx.moveTo(w / 2, 120);
                ctx.arc(w / 2, 120, 88, angle, end);
                ctx.closePath();
                ctx.fillStyle = colors[i % colors.length];
                ctx.fill();
                angle = end;
            }
            ctx.beginPath();
            ctx.arc(w / 2, 120, 45, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.fillStyle = '#254557';
            ctx.textAlign = 'center';
            ctx.fillText(total.toLocaleString(), w / 2, 124);
            return;
        }
        const left = 48, right = w - 12, top = 16, bottom = 194, dx = (right - left) / Math.max(nx, 1), dy = (bottom - top) / Math.max(ny, 1);
        ctx.strokeStyle = '#e0e8ed';
        ctx.lineWidth = 1;
        for (let i = 0; i < 4; i++) {
            const y = bottom - (bottom - top) * i / 3;
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
            ctx.stroke();
            if (!r.y)
                ctx.fillText(Math.round(max * i / 3).toLocaleString(), 2, y + 4);
        }
        let prevX = 0, prevY = 0;
        for (let i = 0; i < r.counts.length; i++) {
            const xb = i % nx, yb = Math.floor(i / nx), x = left + (xb + .5) * dx, y = r.y ? bottom - (yb + .5) * dy : bottom - r.counts[i] / max * (bottom - top);
            this.hit.set([left + xb * dx, r.y ? bottom - (yb + 1) * dy : top, left + (xb + 1) * dx, r.y ? bottom - yb * dy : bottom], i * 4);
            ctx.fillStyle = i === this.focus && document.activeElement === canvas ? '#d29032' : '#0d9188';
            if (r.type === 'bar')
                ctx.fillRect(left + xb * dx + 1, y, Math.max(1, dx - 2), bottom - y);
            else if (r.type === 'time') {
                if (i) {
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
        if (r.y && this.start !== null && this.drag !== null && this.drag >= 0) {
            const a = this.start * 4, b = this.drag * 4;
            const x = Math.min(this.hit[a], this.hit[b]), y = Math.min(this.hit[a + 1], this.hit[b + 1]), right = Math.max(this.hit[a + 2], this.hit[b + 2]), bottom = Math.max(this.hit[a + 3], this.hit[b + 3]);
            ctx.fillStyle = '#3984cf33';
            ctx.fillRect(x, y, right - x, bottom - y);
            ctx.strokeStyle = '#3984cf';
            ctx.strokeRect(x, y, right - x, bottom - y);
        }
        ctx.fillStyle = '#546b7a';
        if (r.y) {
            ctx.textAlign = 'right';
            ctx.fillText(r.y.labels[ny - 1]?.split(' – ').at(-1) ?? '', left - 5, top + 8);
            ctx.fillText(r.y.labels[0]?.split(' – ')[0] ?? '', left - 5, bottom);
            ctx.save();
            ctx.translate(12, (top + bottom) / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillText(r.y.field, 0, 0);
            ctx.restore();
        }
        if (!r.x.ranges && !r.y && nx <= 8) {
            ctx.textAlign = 'center';
            for (let i = 0; i < nx; i++)
                ctx.fillText(r.x.labels[i], left + (i + .5) * dx, 213, Math.max(1, dx - 3));
        }
        else {
            ctx.textAlign = 'left';
            ctx.fillText(r.x.labels[0]?.split(' – ')[0] ?? '', left, 213);
            ctx.textAlign = 'right';
            ctx.fillText(r.x.labels[nx - 1]?.split(' – ').at(-1) ?? '', right, 213);
        }
        ctx.textAlign = 'center';
        ctx.fillText(r.x.field, w / 2, 232);
    }
    suspend() { this.result = undefined; this.list.replaceChildren(); this.note.textContent = 'Load this source to calculate charts.'; this.draw(); }
    destroy() { this.observer.disconnect(); this.root.remove(); }
}
