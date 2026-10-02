import type { ChartResult, Expression } from './analysis.ts';
// A separate GL canvas keeps unbinned observations in contiguous GPU buffers.
export class RawScatter {
    container = document.createElement('div');
    canvas = document.createElement('canvas');
    private box = document.createElement('div');
    private labels = document.createElement('div');
    private focus = 0;
    private gl: WebGL2RenderingContext;
    private program!: WebGLProgram;
    private buffer!: WebGLBuffer;
    private result?: ChartResult;
    private start?: [
        number,
        number
    ];
    private observer: ResizeObserver;
    constructor(select: (e: Expression, label: string) => void) {
        this.container.className = 'raw-scatter';
        this.box.className = 'geo-box';
        this.box.hidden = true;
        this.labels.className = 'raw-scatter-labels';
        this.container.append(this.canvas, this.box, this.labels);
        this.canvas.setAttribute('aria-label', 'Unbinned scatter plot. Drag a rectangle to filter; click a point to select its observation.');
        this.canvas.tabIndex = 0;
        const gl = this.canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!;
        if (!gl)
            throw Error('WebGL 2 required for unbinned scatter');
        this.gl = gl;
        this.initialize();
        this.observer = new ResizeObserver(() => this.draw());
        this.observer.observe(this.canvas);
        this.canvas.onpointerdown = e => { if (e.button !== 0)
            return; this.start = this.point(e); this.box.hidden = false; this.box.style.width = '0'; this.box.style.height = '0'; this.canvas.setPointerCapture(e.pointerId); };
        this.canvas.onpointercancel = () => { this.start = undefined; this.box.hidden = true; };
        this.canvas.onpointermove = e => { if (!this.start)
            return; const b = this.point(e), a = this.start; this.box.style.left = Math.min(a[0], b[0]) + 'px'; this.box.style.top = Math.min(a[1], b[1]) + 'px'; this.box.style.width = Math.abs(a[0] - b[0]) + 'px'; this.box.style.height = Math.abs(a[1] - b[1]) + 'px'; };
        this.canvas.onpointerup = e => {
            const a = this.start, b = this.point(e), r = this.result;
            this.start = undefined;
            this.box.hidden = true;
            if (!a || !r?.raw)
                return;
            if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4) {
                this.draw(true);
                const pixel = new Uint8Array(4), d = this.canvas.width / this.canvas.clientWidth;
                gl.readPixels(Math.floor(b[0] * d), this.canvas.height - 1 - Math.floor(b[1] * d), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                const k = (pixel[0] + pixel[1] * 256 + pixel[2] * 65536 + pixel[3] * 16777216) - 1;
                this.draw();
                if (k >= 0 && k < r.raw.rows.length)
                    select({ op: 'row', index: r.raw.rows[k] }, `Observation ${r.raw.rows[k] + 1}`);
                return;
            }
            const bounds = r.raw.bounds, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
            const value = (v: number, dimension: number) => { const t = Math.max(0, Math.min(1, dimension === 0 ? (v / w - .06) / .88 : (.94 - v / h) / .88)), lo = bounds[dimension], hi = bounds[dimension + 2]; return lo * (1 - t) + hi * t; };
            const str = (v: number, axis: NonNullable<ChartResult['y']>, lower = false) => axis.kind === 'date' ? new Date(lower ? Math.ceil(v) : Math.floor(v)).toISOString() : String(v);
            const x1 = value(Math.min(a[0], b[0]), 0), x2 = value(Math.max(a[0], b[0]), 0), y1 = value(Math.max(a[1], b[1]), 1), y2 = value(Math.min(a[1], b[1]), 1);
            select({ op: 'and', children: [{ field: r.x.field, op: 'gte', value: str(x1, r.x, true) }, { field: r.x.field, op: 'lte', value: str(x2, r.x) }, { field: r.y!.field, op: 'gte', value: str(y1, r.y!, true) }, { field: r.y!.field, op: 'lte', value: str(y2, r.y!) }] }, `${r.x.field} × ${r.y!.field} rectangle`);
        };
        this.canvas.onkeydown = e => { const rows = this.result?.raw?.rows; if (!rows?.length)
            return; if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            this.focus = Math.max(0, Math.min(rows.length - 1, this.focus + (['ArrowRight', 'ArrowUp'].includes(e.key) ? 1 : -1)));
            this.labels.textContent = `Observation ${rows[this.focus] + 1}. Enter to select.`;
        }
        else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select({ op: 'row', index: rows[this.focus] }, `Observation ${rows[this.focus] + 1}`);
        } };
        this.canvas.addEventListener('webglcontextlost', e => e.preventDefault());
        this.canvas.addEventListener('webglcontextrestored', () => { this.initialize(); if (this.result)
            this.update(this.result); });
    }
    private initialize() {
        const gl = this.gl;
        const vs = `#version 300 es
        precision highp float;layout(location=0)in vec2 p;uniform float size;flat out uint id;void main(){gl_Position=vec4(p*.88,0,1);gl_PointSize=size;id=uint(gl_VertexID)+1u;}`;
        const fs = `#version 300 es
        precision highp float;precision highp int;flat in uint id;uniform bool picking;out vec4 c;void main(){c=picking?vec4(float(id&255u),float((id>>8u)&255u),float((id>>16u)&255u),float((id>>24u)&255u))/255.:vec4(.05,.57,.53,1);}`;
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
    private point(e: PointerEvent): [
        number,
        number
    ] { const b = this.canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }
    update(r: ChartResult) { this.result = r; this.focus = Math.min(this.focus, Math.max(0, r.raw!.rows.length - 1)); const b = r.raw!.bounds, str = (v: number, kind?: string) => !Number.isFinite(v) ? 'missing' : kind === 'date' ? new Date(v).toISOString() : Number(v.toPrecision(5)).toString(); this.labels.textContent = `${r.x.field}: ${str(b[0], r.x.kind)} … ${str(b[2], r.x.kind)} · ${r.y!.field}: ${str(b[1], r.y!.kind)} … ${str(b[3], r.y!.kind)}`; const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, r.raw!.positions, gl.STATIC_DRAW); this.draw(); }
    private draw(picking = false) { const gl = this.gl, d = Math.min(devicePixelRatio, 2); this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * d)); this.canvas.height = 240 * d; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(.97, .98, .99, 0); gl.clear(gl.COLOR_BUFFER_BIT); if (!this.result?.raw)
        return; gl.useProgram(this.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0); gl.uniform1i(gl.getUniformLocation(this.program, 'picking'), Number(picking)); gl.uniform1f(gl.getUniformLocation(this.program, 'size'), picking ? 6 * d : 2 * d); gl.disable(gl.DITHER); gl.drawArrays(gl.POINTS, 0, this.result.raw.rows.length); }
    destroy() { this.observer.disconnect(); this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program); this.result = undefined; this.container.remove(); this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
