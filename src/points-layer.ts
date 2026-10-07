import { EllipsesRenderer } from './ellipses-renderer.ts';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as LibreMap } from 'maplibre-gl';
import { numericPalette } from './colour-schemes.ts';
import { mercator } from './data.ts';
const vertex = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec4 a_position;
layout(location=1) in uvec3 a_bin;
layout(location=2) in uint a_visible;
flat out uint v_visible;
uniform bool u_colored;
uniform bool u_categorical;
uniform vec3 u_palette[64];
uniform vec3 u_color;
flat out vec3 v_color;
uniform vec4 u_center;
uniform vec2 u_scale;
uniform float u_size;
uniform bool u_pick;
uniform vec2 u_pickCenter;
uniform vec2 u_pickScale;
flat out vec4 v_id;
void main() {
  // Subtract high parts BEFORE adding low parts. Keeps subpixel precision at high zoom.
  vec2 relative=(a_position.xy-u_center.xy)+(a_position.zw-u_center.zw);
  vec2 clip=relative*u_scale;
  if(u_pick) clip=(clip-u_pickCenter)*u_pickScale;
  gl_Position=vec4(clip,0.0,1.0);
  gl_PointSize=u_size;
  v_visible=a_visible;
  v_color=u_colored?(u_categorical?vec3(a_bin)/255.0:(a_bin.x==255u?vec3(.5):u_palette[min(a_bin.x,63u)])):u_color;
  uint id=uint(gl_VertexID)+1u;
  v_id=vec4(float(id&255u),float((id>>8u)&255u),float((id>>16u)&255u),float((id>>24u)&255u))/255.0;
}`;
const fragment = `#version 300 es
precision highp float;
precision highp int;
uniform bool u_pick;
flat in vec3 v_color;
flat in vec4 v_id;
flat in uint v_visible;
out vec4 color;
void main() {
  if(v_visible==0u) discard;
  if(length(gl_PointCoord-vec2(.5))>.5) discard;
  color=u_pick?v_id:vec4(v_color,1.0);
}`;
export class PointsLayer implements CustomLayerInterface {
    id: string;
    color: [
        number,
        number,
        number
    ];
    visible = true;
    constructor(id = 'million-points', color: [
        number,
        number,
        number
    ] = [.02, .45, .68]) { this.id = id; this.color = color; }
    type = 'custom' as const;
    renderingMode = '2d' as const;
    map!: LibreMap;
    gl!: WebGL2RenderingContext;
    program!: WebGLProgram;
    vao!: WebGLVertexArrayObject;
    positionBuffer!: WebGLBuffer;
    indexBuffer!: WebGLBuffer;
    spatialBuffer!: WebGLBuffer;
    colorBuffer!: WebGLBuffer;
    colorCodes?: Uint8Array;
    mapMask?: Uint8Array;
    private mapMaskBuffer!: WebGLBuffer;
    palette = new Float32Array(64 * 3);
    private paletteBins = 24;
    categorical = false;
    capacity = 0;
    private capacityLimit = 0;
    count = 0;
    pointSize = 2;
    ellipsesEnabled = false;
    ellipseVertices = 12;
    ellipseFullDetail = false;
    private ellipseValidCount = 0;
    private maskCount?: number;
    ellipseRadius = 0;
    private ellipses?: EllipsesRenderer;
    private ellipseStylesDirty = true;
    ellipsesDrawnLastFrame = 0;
    chunks: {
        offset: number;
        positions: Float32Array;
        indices: Uint32Array;
        groups: Float64Array;
        ellipses?: Float32Array;
    }[] = [];
    private bounds = [Infinity, Infinity, -Infinity, -Infinity];
    drawnLastFrame = 0;
    indices: Uint32Array | null = null;
    private uniform: Record<string, WebGLUniformLocation | null> = {};
    private framebuffer?: WebGLFramebuffer;
    private texture?: WebGLTexture;
    onAdd(map: LibreMap, gl: WebGL2RenderingContext) {
        this.map = map;
        this.gl = gl;
        if (!(gl instanceof WebGL2RenderingContext))
            throw new Error('WebGL 2 required');
        const shaders = [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER].map((type, i) => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, i === 0 ? vertex : fragment);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compilation failed');
            return shader;
        });
        this.program = gl.createProgram()!;
        for (const s of shaders)
            gl.attachShader(this.program, s);
        gl.linkProgram(this.program);
        for (const s of shaders)
            gl.deleteShader(s);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(this.program) ?? 'Shader link failed');
        for (const name of ['center', 'scale', 'size', 'pick', 'pickCenter', 'pickScale', 'color', 'colored', 'categorical', 'palette'])
            this.uniform[name] = gl.getUniformLocation(this.program, 'u_' + name);
        this.vao = gl.createVertexArray()!;
        this.positionBuffer = gl.createBuffer()!;
        this.indexBuffer = gl.createBuffer()!;
        this.spatialBuffer = gl.createBuffer()!;
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 16, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        for (const c of this.chunks)
            gl.bufferSubData(gl.ARRAY_BUFFER, c.offset * 16, c.positions);
        if (this.indices)
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.spatialBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.capacity * 4, gl.STATIC_DRAW);
        for (const c of this.chunks)
            gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, c.offset * 4, c.indices);
        this.colorBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.colorCodes ?? new Uint8Array(1), gl.STATIC_DRAW);
        gl.vertexAttribIPointer(1, this.categorical ? 3 : 1, gl.UNSIGNED_BYTE, this.categorical ? 3 : 1, 0);
        if (this.colorCodes)
            gl.enableVertexAttribArray(1);
        else {
            gl.disableVertexAttribArray(1);
            gl.vertexAttribI4ui(1, 255, 0, 0, 0);
        }
        this.mapMaskBuffer = gl.createBuffer()!;
        this.uploadMapMask();
        gl.bindVertexArray(null);
        this.framebuffer = undefined;
        this.texture = undefined;
        if (this.chunks.some(c => c.ellipses)) this.initializeEllipses();
    }
    private initializeEllipses() {
        this.ellipses = new EllipsesRenderer(this.gl);
        this.ellipses.resize(this.capacity, this.chunks);
        this.ellipses.setFilter(this.indices);
        this.ellipseStylesDirty = true;
    }
    allocate(capacity: number, limit = capacity) {
        this.capacityLimit = limit;
        this.resize(capacity);
    }
    private resize(capacity: number) {
        this.capacity = capacity;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * 16, gl.STATIC_DRAW);
        for (const c of this.chunks)
            gl.bufferSubData(gl.ARRAY_BUFFER, c.offset * 16, c.positions);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.spatialBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, capacity * 4, gl.STATIC_DRAW);
        for (const c of this.chunks)
            gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, c.offset * 4, c.indices);
        gl.bindVertexArray(null);
        this.ellipses?.resize(capacity, this.chunks);
        if (gl.getError() !== gl.NO_ERROR)
            throw new Error('GPU allocation failed; lower point limit');
    }
    append(offset: number, positions: Float32Array, indices: Uint32Array, groups: Float64Array, ellipses?: Float32Array, ellipseRadius = 0, ellipseValidCount?: number) {
        const required = offset + positions.length / 4;
        if (required > this.capacityLimit)
            throw new Error('WFS exceeded allocated count');
        if (required > this.capacity)
            this.resize(Math.min(this.capacityLimit, Math.max(required, this.capacity * 2)));
        const chunk = { offset, positions, indices, groups, ellipses };
        this.chunks.push(chunk);
        if (ellipses) this.ellipseValidCount += ellipseValidCount ?? positions.length/4;
        this.ellipseRadius = Math.max(this.ellipseRadius, ellipseRadius);
        if (ellipses) {
            if (!this.ellipses) this.initializeEllipses();
            else this.ellipses.append(chunk);
        }
        this.ellipseStylesDirty = true;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, offset * 16, positions);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.spatialBuffer);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset * 4, indices);
        gl.bindVertexArray(null);
        for (let i = 0; i < groups.length; i += 6) {
            this.bounds[0] = Math.min(this.bounds[0], groups[i + 2]);
            this.bounds[1] = Math.min(this.bounds[1], groups[i + 3]);
            this.bounds[2] = Math.max(this.bounds[2], groups[i + 4]);
            this.bounds[3] = Math.max(this.bounds[3], groups[i + 5]);
        }
        this.count = offset + positions.length / 4;
        this.map.triggerRepaint();
    }
    filter(indices: Uint32Array | null) {
        this.indices = indices;
        this.ellipses?.setFilter(indices);
        const gl = this.gl;
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        if (indices)
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
        else
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
        gl.bindVertexArray(null);
        this.map.triggerRepaint();
    }
    setColors(codes: Uint8Array | undefined, stops: readonly string[] = ['#2463d4', '#ee5539'], bins = 24, categorical = false) {
        this.ellipseStylesDirty = true;
        this.categorical = categorical;
        this.colorCodes = codes;
        this.paletteBins = bins;
        this.setPalette(stops);
        const gl = this.gl;
        if (!gl)
            return;
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, codes ?? new Uint8Array(1), gl.STATIC_DRAW);
        gl.vertexAttribIPointer(1, categorical ? 3 : 1, gl.UNSIGNED_BYTE, categorical ? 3 : 1, 0);
        if (codes)
            gl.enableVertexAttribArray(1);
        else {
            gl.disableVertexAttribArray(1);
            gl.vertexAttribI4ui(1, 255, 0, 0, 0);
        }
        gl.bindVertexArray(null);
        this.map.triggerRepaint();
    }
    setMapMask(mask?: Uint8Array) {
        this.ellipseStylesDirty = true;
        this.mapMask = mask;
        this.maskCount = mask ? mask.reduce((sum, v) => sum + (v ? 1 : 0),0) : undefined;
        if (this.gl) this.uploadMapMask();
        this.map?.triggerRepaint();
    }
    private uploadMapMask() {
        const gl = this.gl;
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.mapMaskBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.mapMask ?? new Uint8Array(1), gl.STATIC_DRAW);
        gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, 1, 0);
        if (this.mapMask) gl.enableVertexAttribArray(2);
        else { gl.disableVertexAttribArray(2); gl.vertexAttribI4ui(2, 1, 0, 0, 0); }
        gl.bindVertexArray(null);
    }
    setPalette(stops: readonly string[]) {
        this.palette.set(numericPalette(stops, this.paletteBins));
        this.map?.triggerRepaint();
    }
    private draw(picking: boolean, center: [
        number,
        number
    ] = [0, 0], scale: [
        number,
        number
    ] = [1, 1], ellipses = false) {
        if (!this.visible)
            return;
        const gl = this.gl, canvas = this.map.getCanvas(), size = this.map.getContainer().getBoundingClientRect();
        const [x, y] = mercator(this.map.getCenter().lng, this.map.getCenter().lat);
        const hx = Math.fround(x), hy = Math.fround(y), world = 512 * 2 ** this.map.getZoom();
        const dpr = canvas.width / size.width;
        gl.useProgram(this.program);
        gl.uniform3f(this.uniform.color, ...this.color);
        gl.uniform1i(this.uniform.colored, this.colorCodes ? 1 : 0);
        gl.uniform1i(this.uniform.categorical, this.categorical ? 1 : 0);
        gl.uniform3fv(this.uniform.palette, this.palette);
        gl.bindVertexArray(this.vao);
        gl.uniform4f(this.uniform.center, hx, hy, x - hx, y - hy);
        gl.uniform2f(this.uniform.scale, world * 2 / size.width, -world * 2 / size.height);
        gl.uniform1f(this.uniform.size, (picking ? Math.max(this.pointSize, 6) : this.pointSize) * dpr);
        gl.uniform1i(this.uniform.pick, picking ? 1 : 0);
        gl.uniform2f(this.uniform.pickCenter, ...center);
        gl.uniform2f(this.uniform.pickScale, ...scale);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.BLEND);
        if (ellipses) {
            if (!this.ellipses || !this.ellipsesEnabled || this.ellipseRadius * world < .75) return;
            if (this.ellipseStylesDirty) {
                this.ellipses.setStyles(this.count, this.colorCodes, this.categorical, this.mapMask);
                this.ellipseStylesDirty = false;
            }
            this.ellipses.prepare(this.ellipseVertices, [hx, hy, x-hx, y-hy], [world*2/size.width, -world*2/size.height], world, this.color, this.palette);
        }
        let ellipseStride = 1;
        const draw = (buffer: WebGLBuffer, count: number, offset = 0) => {
            if (ellipses) this.ellipses!.draw(buffer === this.indexBuffer, count, offset, ellipseStride);
            else { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer); gl.drawElements(gl.POINTS, count, gl.UNSIGNED_INT, offset*4); }
        };
        const eligibleFraction = this.count ? Math.min(1,this.ellipseValidCount/this.count) * (this.maskCount === undefined ? 1 : this.maskCount/this.count) : 1;
        const budget = Math.max(2000, Math.floor(size.width * size.height / 100));
        if (this.indices) {
            if (ellipses && !this.ellipseFullDetail) {
                const halfX = size.width / world / 2 + this.ellipseRadius, halfY = size.height / world / 2 + this.ellipseRadius;
                const area = (this.bounds[2]-this.bounds[0])*(this.bounds[3]-this.bounds[1]);
                const overlap = Math.max(0,Math.min(x+halfX,this.bounds[2])-Math.max(x-halfX,this.bounds[0]))*Math.max(0,Math.min(y+halfY,this.bounds[3])-Math.max(y-halfY,this.bounds[1]));
                const visible = area ? this.indices.length * Math.min(1,overlap/area) : this.indices.length;
                ellipseStride = Math.max(1,Math.ceil(visible*eligibleFraction/budget));
            }
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
            draw(this.indexBuffer, this.indices.length);
            if (!picking) {
                if (ellipses) this.ellipsesDrawnLastFrame = Math.ceil(this.indices.length/ellipseStride);
                else this.drawnLastFrame = this.indices.length;
            }
        }
        else {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.spatialBuffer);
            const margin = picking ? Math.max(this.pointSize, 6) : this.pointSize;
            const radius = ellipses ? this.ellipseRadius : 0;
            const halfX = (size.width / 2 + margin) / world + radius, halfY = (size.height / 2 + margin) / world + radius;
            const left = x - halfX, right = x + halfX, top = y - halfY, bottom = y + halfY;
            const area = (this.bounds[2] - this.bounds[0]) * (this.bounds[3] - this.bounds[1]);
            const overlap = Math.max(0, Math.min(right, this.bounds[2]) - Math.max(left, this.bounds[0])) * Math.max(0, Math.min(bottom, this.bounds[3]) - Math.max(top, this.bounds[1]));
            if (ellipses && !this.ellipseFullDetail) {
                let candidates = 0;
                if (overlap >= area*.5) candidates = this.count;
                else for (const chunk of this.chunks) for (let i=0;i<chunk.groups.length;i+=6) {
                    const g=chunk.groups;
                    if(g[i+2]<=right && g[i+4]>=left && g[i+3]<=bottom && g[i+5]>=top) candidates += g[i+1];
                }
                ellipseStride = Math.max(1,Math.ceil(candidates*eligibleFraction/budget));
            }
            let drawn = 0;
            if (overlap >= area * .5) {
                draw(this.spatialBuffer, this.count);
                drawn = ellipses ? Math.ceil(this.count/ellipseStride) : this.count;
            }
            else if (overlap > 0 || area === 0) {
                let start = -1, count = 0;
                const flush = () => {
                    if (count) {
                        draw(this.spatialBuffer, count, start);
                        drawn += ellipses ? Math.ceil(count/ellipseStride) : count;
                    }
                    count = 0;
                    start = -1;
                };
                for (const chunk of this.chunks)
                    for (let i = 0; i < chunk.groups.length; i += 6) {
                        const g = chunk.groups, visible = g[i + 2] <= right && g[i + 4] >= left && g[i + 3] <= bottom && g[i + 5] >= top;
                        if (visible) {
                            if (start < 0)
                                start = g[i];
                            else if (start + count !== g[i]) {
                                flush();
                                start = g[i];
                            }
                            count += g[i + 1];
                        }
                        else
                            flush();
                    }
                flush();
            }
            if (!picking) {
                if (ellipses) this.ellipsesDrawnLastFrame = drawn;
                else this.drawnLastFrame = drawn;
            }
        }
        gl.bindVertexArray(null);
        gl.activeTexture(gl.TEXTURE0);
        gl.enable(gl.BLEND);
    }
    render(_gl: WebGL2RenderingContext, _options: CustomRenderMethodInput) {
        this.ellipsesDrawnLastFrame = 0;
        if (this.count) {
            if (this.ellipsesEnabled && this.ellipses && this.ellipseRadius * 512 * 2 ** this.map.getZoom() >= .75) this.draw(false, [0,0], [1,1], true);
            this.draw(false);
        }
    }
    // CPU spatial groups retain every coincident point, unlike an ID framebuffer.
    pickAll(cssX: number, cssY: number): Uint32Array {
        if (!this.visible || !this.count) return new Uint32Array();
        const rect = this.map.getCanvas().getBoundingClientRect(), world = 512 * 2 ** this.map.getZoom();
        const [cx, cy] = mercator(this.map.getCenter().lng, this.map.getCenter().lat);
        const x = cx + (cssX - rect.width / 2) / world, y = cy + (cssY - rect.height / 2) / world;
        const radius = Math.max(6, this.pointSize) / 2 + 3, margin = radius / world;
        const selected = this.indices ? new Set(this.indices) : undefined, hits: number[] = [];
        for (const chunk of this.chunks) for (let g = 0; g < chunk.groups.length; g += 6) {
            const groups = chunk.groups;
            if (groups[g + 2] > x + margin || groups[g + 4] < x - margin || groups[g + 3] > y + margin || groups[g + 5] < y - margin) continue;
            for (let k = groups[g] - chunk.offset, end = k + groups[g + 1]; k < end; k++) {
                const index = chunk.indices[k]; if (selected && !selected.has(index) || this.mapMask && !this.mapMask[index]) continue;
                const i = (index - chunk.offset) * 4, p = chunk.positions;
                if (Math.hypot((p[i] + p[i + 2] - x) * world, (p[i + 1] + p[i + 3] - y) * world) <= radius) hits.push(index);
            }
        }
        return Uint32Array.from(hits);
    }
    pick(cssX: number, cssY: number): number | null {
        if (!this.count)
            return null;
        if (!this.visible)
            return null;
        const gl = this.gl, canvas = this.map.getCanvas(), rect = canvas.getBoundingClientRect(), side = 9;
        const before = { fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING), viewport: gl.getParameter(gl.VIEWPORT), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING), program: gl.getParameter(gl.CURRENT_PROGRAM), clear: gl.getParameter(gl.COLOR_CLEAR_VALUE), texture: gl.getParameter(gl.TEXTURE_BINDING_2D), states: [gl.BLEND, gl.DITHER, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST].map(k => [k, gl.isEnabled(k)] as const) };
        try {
            if (!this.framebuffer) {
                this.framebuffer = gl.createFramebuffer()!;
                this.texture = gl.createTexture()!;
                gl.bindTexture(gl.TEXTURE_2D, this.texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, side, side, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
                if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
                    throw new Error('Picking framebuffer incomplete');
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
            gl.viewport(0, 0, side, side);
            gl.disable(gl.SCISSOR_TEST);
            gl.disable(gl.DITHER);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this.draw(true, [cssX / rect.width * 2 - 1, 1 - cssY / rect.height * 2], [canvas.width / side, canvas.height / side]);
            const pixels = new Uint8Array(side * side * 4);
            gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            let best: number | null = null, distance = Infinity;
            for (let y = 0; y < side; y++)
                for (let x = 0; x < side; x++) {
                    const i = (y * side + x) * 4, id = (pixels[i] + pixels[i + 1] * 256 + pixels[i + 2] * 65536 + pixels[i + 3] * 16777216) - 1;
                    const d = (x - 4) ** 2 + (y - 4) ** 2;
                    if (id >= 0 && id < this.count && d < distance) {
                        best = id;
                        distance = d;
                    }
                }
            return best;
        }
        finally {
            gl.bindFramebuffer(gl.FRAMEBUFFER, before.fbo);
            gl.viewport(...before.viewport as [
                number,
                number,
                number,
                number
            ]);
            gl.bindVertexArray(before.vao);
            gl.useProgram(before.program);
            gl.clearColor(...before.clear as [
                number,
                number,
                number,
                number
            ]);
            gl.bindTexture(gl.TEXTURE_2D, before.texture);
            for (const [k, enabled] of before.states)
                enabled ? gl.enable(k) : gl.disable(k);
            this.map.triggerRepaint();
        }
    }
    onRemove() {
        const gl = this.gl;
        this.ellipses?.remove(); this.ellipses = undefined;
        gl.deleteProgram(this.program);
        gl.deleteVertexArray(this.vao);
        gl.deleteBuffer(this.positionBuffer);
        gl.deleteBuffer(this.indexBuffer);
        gl.deleteBuffer(this.spatialBuffer);
        gl.deleteBuffer(this.colorBuffer);
        gl.deleteBuffer(this.mapMaskBuffer);
        if (this.framebuffer)
            gl.deleteFramebuffer(this.framebuffer);
        if (this.texture)
            gl.deleteTexture(this.texture);
    }
    get gpuBytes() { return (this.ellipses?.gpuBytes ?? 0) + this.capacity * 20 + (this.colorCodes?.byteLength ?? 0) + (this.indices?.byteLength ?? 0) + (this.mapMask?.byteLength ?? 0); }
}
