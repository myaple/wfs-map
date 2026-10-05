import { transform, untransform, type Scale } from './scales.ts';
import { themeColor } from './theme.ts';
export type Point = [
    number,
    number
];
export type View = [
    number,
    number,
    number,
    number
];
export type PlotRect = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
};
export function plotRect(canvas: HTMLCanvasElement, dateY = false): PlotRect {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    return { left: dateY ? 106 : 68, right: Math.max(dateY ? 130 : 92, width - 18), top: 18, bottom: Math.max(40, height - 64), width, height };
}
export function tickText(value: number, kind: string | undefined, span: number): string[] {
    if (!Number.isFinite(value))
        return [''];
    if (kind === 'date') {
        const iso = new Date(Math.round(value)).toISOString();
        return [iso.slice(0, 10), iso.slice(11, span < 1000 ? 23 : span < 120000 ? 19 : 16) + ' UTC'];
    }
    if (value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 1e9))
        return [value.toExponential(2)];
    return [value.toLocaleString('en-GB', { maximumFractionDigits: 4 })];
}
export const interpolate = (lo: number, hi: number, t: number) => lo * (1 - t) + hi * t;
export function drawAxes(ctx: CanvasRenderingContext2D, p: PlotRect, view: View, bounds: View, xKind: string | undefined, yKind: string | undefined, xName: string, yName: string, xLabels?: string[], yLabels?: string[], xScale: Scale = 'linear', yScale: Scale = 'linear') {
    bounds = [transform(bounds[0], xScale), transform(bounds[1], yScale), transform(bounds[2], xScale), transform(bounds[3], yScale)];
    const grid = themeColor('chart-grid'), muted = themeColor('muted'), text = themeColor('text'), axis = themeColor('chart-axis');
    ctx.font = '11px system-ui';
    ctx.lineWidth = 1;
    const nx = Math.max(2, Math.min(6, Math.floor((p.right - p.left) / (xKind === 'date' ? 95 : 75)))), ny = Math.max(2, Math.min(6, Math.floor((p.bottom - p.top) / (yKind === 'date' ? 48 : 45))));
    const xspan = (bounds[2] - bounds[0]) * (view[2] - view[0]), yspan = (bounds[3] - bounds[1]) * (view[3] - view[1]);
    for (let i = 0; i <= nx; i++) {
        const t = i / nx, x = p.left + t * (p.right - p.left), v = interpolate(bounds[0], bounds[2], interpolate(view[0], view[2], t));
        ctx.strokeStyle = grid;
        ctx.beginPath();
        ctx.moveTo(x, p.top);
        ctx.lineTo(x, p.bottom);
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.textAlign = i === 0 ? 'left' : i === nx ? 'right' : 'center';
        (xKind === 'category' ? [] : tickText(untransform(v, xScale), xKind, xspan)).forEach((line, j) => ctx.fillText(line, x, p.bottom + 18 + j * 14));
    }
    for (let i = 0; i <= ny; i++) {
        const t = i / ny, y = p.bottom - t * (p.bottom - p.top), v = interpolate(bounds[1], bounds[3], interpolate(view[1], view[3], t));
        ctx.strokeStyle = grid;
        ctx.beginPath();
        ctx.moveTo(p.left, y);
        ctx.lineTo(p.right, y);
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.textAlign = 'right';
        (yKind === 'category' ? [] : tickText(untransform(v, yScale), yKind, yspan)).forEach((line, j) => ctx.fillText(line, p.left - 7, y + 4 + j * 13));
    }
    const categories = (labels: string[] | undefined, vertical: boolean) => {
        if (!labels) return;
        const lo = vertical ? view[1] : view[0], hi = vertical ? view[3] : view[2];
        if (labels.length * (hi - lo) > 12) return;
        labels.forEach((label, i) => {
            const t = ((i + .5) / labels.length - lo) / (hi - lo);
            if (t < 0 || t > 1) return;
            ctx.fillStyle = muted; ctx.textAlign = vertical ? 'right' : 'center';
            ctx.fillText(label, vertical ? p.left - 7 : p.left + t * (p.right - p.left), vertical ? p.bottom - t * (p.bottom - p.top) + 4 : p.bottom + 18, vertical ? p.left - 15 : (p.right - p.left) / Math.max(1, labels.length * (hi - lo)) - 3);
        });
    };
    categories(xLabels, false); categories(yLabels, true);
    ctx.strokeStyle = axis;
    ctx.strokeRect(p.left, p.top, p.right - p.left, p.bottom - p.top);
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.fillText(xName, (p.left + p.right) / 2, p.height - 8);
    ctx.save();
    ctx.translate(12, (p.top + p.bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yName, 0, 0);
    ctx.restore();
}
// The same local viewport and pointer gestures serve canvas and GPU plots.
export class ChartInteraction {
    view: View = [0, 0, 1, 1];
    private fitted: View = [0, 0, 1, 1];
    private start?: Point;
    private button = 0;
    private clickTimer?: ReturnType<typeof setTimeout>;
    private box: HTMLDivElement;
    constructor(private canvas: HTMLCanvasElement, container: HTMLElement, private rect: () => PlotRect, private redraw: () => void, private selected: (a: Point, b: Point) => void, private clicked: (p: Point) => void) {
        this.box = document.createElement('div');
        this.box.className = 'chart-brush';
        this.box.hidden = true;
        container.append(this.box);
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        canvas.onpointerdown = e => {
            if (![0, 2].includes(e.button))
                return;
            clearTimeout(this.clickTimer);
            e.preventDefault();
            const p = this.point(e), r = this.rect();
            if (p[0] < r.left || p[0] > r.right || p[1] < r.top || p[1] > r.bottom)
                return;
            this.start = p;
            this.button = e.button;
            canvas.setPointerCapture(e.pointerId);
        };
        canvas.onpointermove = e => {
            if (!this.start)
                return;
            const p = this.clamp(this.point(e)), a = this.start;
            this.box.hidden = false;
            this.box.dataset.action = this.button === 0 ? 'zoom' : 'select';
            this.box.style.left = Math.min(a[0], p[0]) + 'px';
            this.box.style.top = Math.min(a[1], p[1]) + 'px';
            this.box.style.width = Math.abs(p[0] - a[0]) + 'px';
            this.box.style.height = Math.abs(p[1] - a[1]) + 'px';
        };
        canvas.onpointercancel = () => this.cancel();
        canvas.onpointerup = e => {
            const a = this.start, b = this.clamp(this.point(e));
            this.cancel();
            if (!a)
                return;
            if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 5) {
                if (this.button === 2)
                    this.clicked(b);
                else {
                    clearTimeout(this.clickTimer);
                    this.clickTimer = setTimeout(() => this.clicked(b), 500);
                }
                return;
            }
            if (this.button === 2) {
                this.selected(a, b);
                return;
            }
            if (Math.abs(a[0] - b[0]) < 5 || Math.abs(a[1] - b[1]) < 5)
                return;
            const lo = this.data([Math.min(a[0], b[0]), Math.max(a[1], b[1])]), hi = this.data([Math.max(a[0], b[0]), Math.min(a[1], b[1])]);
            this.view = [lo[0], lo[1], hi[0], hi[1]];
            this.sync();
            this.redraw();
        };
        canvas.ondblclick = e => {
            if (e.button === 0) {
                e.preventDefault();
                this.reset();
            }
        };
        this.sync();
    }
    private point(e: PointerEvent): Point { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    private clamp(p: Point): Point { const r = this.rect(); return [Math.max(r.left, Math.min(r.right, p[0]) - 1e-7), Math.max(r.top, Math.min(r.bottom, p[1]) - 1e-7)]; }
    data(p: Point): Point { const r = this.rect(); return [interpolate(this.view[0], this.view[2], (p[0] - r.left) / (r.right - r.left)), interpolate(this.view[1], this.view[3], (r.bottom - p[1]) / (r.bottom - r.top))]; }
    screen(p: Point): Point { const r = this.rect(); return [r.left + (p[0] - this.view[0]) / (this.view[2] - this.view[0]) * (r.right - r.left), r.bottom - (p[1] - this.view[1]) / (this.view[3] - this.view[1]) * (r.bottom - r.top)]; }
    reset() { clearTimeout(this.clickTimer); this.cancel(); this.view = [...this.fitted]; this.sync(); this.redraw(); }
    setFit(view: View) {
        const automatic = this.view.every((v, i) => v === this.fitted[i]);
        this.fitted = view; this.canvas.dataset.fit = JSON.stringify(view);
        if (automatic) { this.view = [...view]; this.sync(); }
    }
    private sync() { this.canvas.dataset.view = JSON.stringify(this.view); }
    cancel() { this.start = undefined; this.box.hidden = true; }
    destroy() { clearTimeout(this.clickTimer); this.cancel(); this.box.remove(); }
}
// Intersect a rectangular brush with bounded donut sectors, including boxes
// whose corners lie outside the circle. Work depends on segments, not rows.
export function pieSegments(counts: Uint32Array, box: View, cx: number, cy: number, inner: number, outer: number): number[] {
    box = [box[0] + 1e-6, box[1] + 1e-6, box[2] - 1e-6, box[3] - 1e-6];
    const total = counts.reduce((a, b) => a + b, 0), selected: number[] = [];
    if (!total)
        return selected;
    const inside = (x: number, y: number) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
    const line = (x1: number, y1: number, x2: number, y2: number) => { let lo = 0, hi = 1; for (let axis = 0; axis < 2; axis++) {
        const a = axis ? y1 : x1, d = (axis ? y2 : x2) - a, min = box[axis], max = box[axis + 2];
        if (d === 0) {
            if (a < min || a > max)
                return false;
        }
        else {
            const t1 = (min - a) / d, t2 = (max - a) / d;
            lo = Math.max(lo, Math.min(t1, t2));
            hi = Math.min(hi, Math.max(t1, t2));
            if (lo > hi)
                return false;
        }
    } return true; };
    let start = -Math.PI / 2;
    for (let i = 0; i < counts.length; i++) {
        const end = start + counts[i] / total * Math.PI * 2;
        const angle = (x: number, y: number) => { let a = Math.atan2(y - cy, x - cx); if (a < -Math.PI / 2)
            a += Math.PI * 2; return a >= start - 1e-12 && a <= end + 1e-12; };
        let hit = false;
        if (counts[i]) {
            for (const x of [box[0], box[2]])
                for (const y of [box[1], box[3]]) {
                    const radius = Math.hypot(x - cx, y - cy);
                    if (radius >= inner && radius <= outer && angle(x, y))
                        hit = true;
                }
            for (const a of [start, end]) {
                const cos = Math.cos(a), sin = Math.sin(a);
                if (line(cx + inner * cos, cy + inner * sin, cx + outer * cos, cy + outer * sin))
                    hit = true;
            }
            for (const radius of [inner, outer]) {
                for (const x of [box[0], box[2]]) {
                    const square = radius * radius - (x - cx) ** 2;
                    if (square >= 0)
                        for (const y of [cy - Math.sqrt(square), cy + Math.sqrt(square)])
                            if (inside(x, y) && angle(x, y))
                                hit = true;
                }
                for (const y of [box[1], box[3]]) {
                    const square = radius * radius - (y - cy) ** 2;
                    if (square >= 0)
                        for (const x of [cx - Math.sqrt(square), cx + Math.sqrt(square)])
                            if (inside(x, y) && angle(x, y))
                                hit = true;
                }
            }
        }
        if (hit)
            selected.push(i);
        start = end;
    }
    return selected;
}
