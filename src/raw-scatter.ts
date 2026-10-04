import { themeColor } from './theme.ts';
import type { ChartResult, Expression } from './analysis.ts';
import { ChartInteraction, plotRect, drawAxes, interpolate, tickText, type Point, type View } from './chart-plot.ts';
// One contiguous GPU buffer; gestures update viewport uniforms, never point objects.
export class RawScatter {
    container = document.createElement('div');
    canvas = document.createElement('canvas');
    private axes = document.createElement('canvas');
    private labels = document.createElement('div');
    private focus = 0;
    private gl: WebGL2RenderingContext;
    private program!: WebGLProgram;
    private buffer!: WebGLBuffer;
    private result?: ChartResult;
    private observer: ResizeObserver;
    private onThemeChange = () => this.draw();
    private interaction: ChartInteraction;
    constructor(private select: (e: Expression, label: string) => void) {
        this.container.className = 'raw-scatter';
        this.axes.className = 'raw-scatter-axes';
        this.axes.setAttribute('aria-hidden', 'true');
        this.labels.className = 'raw-scatter-labels';
        this.container.append(this.canvas, this.axes, this.labels);
        this.canvas.setAttribute('aria-label', 'Unbinned scatter plot. Left-drag to zoom, right-drag to select, double-click to reset.');
        this.canvas.tabIndex = 0;
        const gl = this.canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!;
        if (!gl)
            throw Error('WebGL 2 required for unbinned scatter');
        this.gl = gl;
        this.initialize();
        this.interaction = new ChartInteraction(this.canvas, this.container, () => plotRect(this.canvas, this.result?.y?.kind === 'date'), () => this.draw(), (a, b) => this.brush(a, b), p => this.pick(p));
        this.canvas.addEventListener('pointermove', e => {
            if (!this.result?.raw)
                return;
            const box = this.canvas.getBoundingClientRect(), t = this.interaction.data([e.clientX - box.left, e.clientY - box.top]), b = this.bounds();
            this.canvas.title = `${this.result.x.field}: ${tickText(interpolate(b[0], b[2], t[0]), this.result.x.kind, (b[2] - b[0]) * (this.interaction.view[2] - this.interaction.view[0])).join(' ')} · ${this.result.y!.field}: ${tickText(interpolate(b[1], b[3], t[1]), this.result.y?.kind, (b[3] - b[1]) * (this.interaction.view[3] - this.interaction.view[1])).join(' ')}`;
        });
        window.addEventListener('themechange', this.onThemeChange);
        this.observer = new ResizeObserver(() => this.draw());
        this.observer.observe(this.canvas);
        this.canvas.onkeydown = e => {
            const rows = this.result?.raw?.rows;
            if (!rows?.length)
                return;
            if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(e.key)) {
                e.preventDefault();
                this.focus = Math.max(0, Math.min(rows.length - 1, this.focus + (['ArrowRight', 'ArrowUp'].includes(e.key) ? 1 : -1)));
                this.labels.textContent = `Observation ${rows[this.focus] + 1}. Enter to select.`;
            }
            else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.select({ op: 'row', index: rows[this.focus] }, `Observation ${rows[this.focus] + 1}`);
            }
        };
        this.canvas.addEventListener('webglcontextlost', e => e.preventDefault());
        this.canvas.addEventListener('webglcontextrestored', () => {
            this.initialize();
            if (this.result)
                this.update(this.result);
        });
    }
    private initialize() {
        const gl = this.gl;
        const vs = `#version 300 es
        precision highp float;layout(location=0)in vec4 p;uniform float size;uniform vec4 center;uniform vec2 scale;uniform bool precise;flat out uint id;void main(){vec2 relative=(p.xy-center.xy)+((precise?p.zw:vec2(0.))-center.zw);gl_Position=vec4(relative*scale-1.,0,1);gl_PointSize=size;id=uint(gl_VertexID)+1u;}`;
        const fs = `#version 300 es
        precision highp float;precision highp int;flat in uint id;uniform bool picking;uniform vec3 pointColor;out vec4 c;void main(){c=picking?vec4(float(id&255u),float((id>>8u)&255u),float((id>>16u)&255u),float((id>>24u)&255u))/255.:vec4(pointColor,1);}`;
        this.program = gl.createProgram()!;
        for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, src);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                throw Error(gl.getShaderInfoLog(shader)!);
            gl.attachShader(this.program, shader);
            gl.deleteShader(shader);
        }
        gl.linkProgram(this.program);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
            throw Error(gl.getProgramInfoLog(this.program)!);
        this.buffer = gl.createBuffer()!;
    }
    private brush(a: Point, b: Point) {
        const r = this.result;
        if (!r?.raw?.rows.length)
            return;
        const lo = this.interaction.data([Math.min(a[0], b[0]), Math.max(a[1], b[1])]), hi = this.interaction.data([Math.max(a[0], b[0]), Math.min(a[1], b[1])]), bounds = this.bounds();
        const str = (v: number, kind?: string, lower = false) => kind === 'date' ? new Date(lower ? Math.ceil(v) : Math.floor(v)).toISOString() : String(v);
        this.select({ op: 'and', children: [{ field: r.x.field, op: 'gte', value: str(interpolate(bounds[0], bounds[2], lo[0]), r.x.kind, true) }, { field: r.x.field, op: 'lte', value: str(interpolate(bounds[0], bounds[2], hi[0]), r.x.kind) }, { field: r.y!.field, op: 'gte', value: str(interpolate(bounds[1], bounds[3], lo[1]), r.y!.kind, true) }, { field: r.y!.field, op: 'lte', value: str(interpolate(bounds[1], bounds[3], hi[1]), r.y!.kind) }] }, `${r.x.field} × ${r.y!.field} rectangle`);
    }
    private pick(p: Point) {
        const r = this.result;
        if (!r?.raw)
            return;
        this.draw(true);
        const gl = this.gl, pixel = new Uint8Array(4), d = this.canvas.width / this.canvas.clientWidth;
        gl.readPixels(Math.floor(p[0] * d), this.canvas.height - 1 - Math.floor(p[1] * d), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const k = (pixel[0] + pixel[1] * 256 + pixel[2] * 65536 + pixel[3] * 16777216) - 1;
        this.draw();
        if (k >= 0 && k < r.raw.rows.length)
            this.select({ op: 'row', index: r.raw.rows[k] }, `Observation ${r.raw.rows[k] + 1}`);
    }
    private bounds(): View {
        const b = this.result!.raw!.bounds;
        const out: View = [b[0], b[1], b[2], b[3]];
        for (let i = 0; i < 2; i++)
            if (out[i] === out[i + 2]) {
                const pad = (i === 0 ? this.result!.x.kind : this.result!.y?.kind) === 'date' ? 1000 : Math.max(1, Math.abs(out[i]) * .01);
                out[i] -= pad;
                out[i + 2] += pad;
            }
        return out;
    }
    update(r: ChartResult) {
        if (this.result && (this.result.x.field !== r.x.field || this.result.y?.field !== r.y?.field))
            this.interaction.reset();
        this.result = r;
        this.focus = Math.min(this.focus, Math.max(0, r.raw!.rows.length - 1));
        this.labels.textContent = 'Left-drag: zoom · right-drag: select · double-click: reset';
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, r.raw!.positions, gl.STATIC_DRAW);
        this.draw();
    }
    private draw(picking = false) {
        const gl = this.gl, d = Math.min(devicePixelRatio, 2), p = plotRect(this.canvas, this.result?.y?.kind === 'date');
        this.canvas.width = Math.max(1, Math.round(p.width * d));
        this.canvas.height = Math.max(1, Math.round(p.height * d));
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!this.result?.raw)
            return;
        const view = this.interaction.view;
        gl.viewport(Math.round(p.left * d), Math.round((p.height - p.bottom) * d), Math.max(1, Math.round((p.right - p.left) * d)), Math.max(1, Math.round((p.bottom - p.top) * d)));
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(Math.round(p.left * d), Math.round((p.height - p.bottom) * d), Math.max(1, Math.round((p.right - p.left) * d)), Math.max(1, Math.round((p.bottom - p.top) * d)));
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, this.result.raw.precise ? 4 : 2, gl.FLOAT, false, this.result.raw.precise ? 16 : 8, 0);
        const x = view[0] * 2 - 1, y = view[1] * 2 - 1, hx = Math.fround(x), hy = Math.fround(y);
        gl.uniform4f(gl.getUniformLocation(this.program, 'center'), hx, hy, x - hx, y - hy);
        gl.uniform2f(gl.getUniformLocation(this.program, 'scale'), 1 / (view[2] - view[0]), 1 / (view[3] - view[1]));
        gl.uniform1i(gl.getUniformLocation(this.program, 'precise'), Number(!!this.result.raw.precise));
        gl.uniform1i(gl.getUniformLocation(this.program, 'picking'), Number(picking));
        const color = themeColor('chart-point');
        gl.uniform3f(gl.getUniformLocation(this.program, 'pointColor'), ...([1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255) as [number, number, number]));
        gl.uniform1f(gl.getUniformLocation(this.program, 'size'), picking ? 6 * d : 2 * d);
        gl.disable(gl.DITHER);
        gl.drawArrays(gl.POINTS, 0, this.result.raw.rows.length);
        gl.disable(gl.SCISSOR_TEST);
        if (!picking) {
            this.axes.width = this.canvas.width;
            this.axes.height = this.canvas.height;
            const ctx = this.axes.getContext('2d')!;
            ctx.scale(d, d);
            drawAxes(ctx, p, view, this.bounds(), this.result.x.kind, this.result.y?.kind, this.result.x.field, this.result.y!.field);
            this.canvas.dataset.axisX = this.result.x.kind ?? 'number';
            this.canvas.dataset.axisY = this.result.y?.kind ?? 'number';
        }
    }
    destroy() { window.removeEventListener('themechange', this.onThemeChange); this.observer.disconnect(); this.interaction.destroy(); this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program); this.result = undefined; this.container.remove(); this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
