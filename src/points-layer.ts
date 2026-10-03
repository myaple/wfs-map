import type { CustomLayerInterface, CustomRenderMethodInput, Map as LibreMap } from 'maplibre-gl';
import { mercator } from './data.ts';
const vertex = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec4 a_position;
layout(location=1) in uvec3 a_bin;
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
  v_color=u_colored?(u_categorical?vec3(a_bin)/255.0:(a_bin.x==255u?vec3(.5):u_palette[min(a_bin.x,63u)])):u_color;
  uint id=uint(gl_VertexID)+1u;
  v_id=vec4(float(id&255u),float((id>>8u)&255u),float((id>>16u)&255u),float((id>>24u)&255u))/255.0;
}`;
const fragment = `#version 300 es
precision highp float;
uniform bool u_pick;
flat in vec3 v_color;
flat in vec4 v_id;
out vec4 color;
void main() {
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
    palette = new Float32Array(64 * 3);
    private paletteBins = 24;
    categorical = false;
    capacity = 0;
    count = 0;
    pointSize = 2;
    chunks: {
        offset: number;
        positions: Float32Array;
        indices: Uint32Array;
        groups: Float64Array;
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
        gl.bindVertexArray(null);
        this.framebuffer = undefined;
        this.texture = undefined;
    }
    allocate(capacity: number) {
        this.capacity = capacity;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * 16, gl.STATIC_DRAW);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.spatialBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, capacity * 4, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        if (gl.getError() !== gl.NO_ERROR)
            throw new Error('GPU allocation failed; lower point limit');
    }
    append(offset: number, positions: Float32Array, indices: Uint32Array, groups: Float64Array) {
        if (offset + positions.length / 4 > this.capacity)
            throw new Error('WFS exceeded allocated count');
        this.chunks.push({ offset, positions, indices, groups });
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
    setColors(codes: Uint8Array | undefined, low = '#2463d4', high = '#ee5539', bins = 24, categorical = false) {
        this.categorical = categorical;
        this.colorCodes = codes;
        this.paletteBins = bins;
        this.setPalette(low, high);
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
    setPalette(low: string, high: string) {
        const bins = this.paletteBins;
        const rgb = (s: string) => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16) / 255), a = rgb(low), b = rgb(high);
        for (let i = 0; i < 64; i++)
            for (let c = 0; c < 3; c++)
                this.palette[i * 3 + c] = a[c] + (b[c] - a[c]) * Math.min(1, i / Math.max(1, bins - 1));
        this.map?.triggerRepaint();
    }
    private draw(picking: boolean, center: [
        number,
        number
    ] = [0, 0], scale: [
        number,
        number
    ] = [1, 1]) {
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
        if (this.indices) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
            gl.drawElements(gl.POINTS, this.indices.length, gl.UNSIGNED_INT, 0);
            if (!picking)
                this.drawnLastFrame = this.indices.length;
        }
        else {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.spatialBuffer);
            const margin = picking ? Math.max(this.pointSize, 6) : this.pointSize;
            const halfX = (size.width / 2 + margin) / world, halfY = (size.height / 2 + margin) / world;
            const left = x - halfX, right = x + halfX, top = y - halfY, bottom = y + halfY;
            const area = (this.bounds[2] - this.bounds[0]) * (this.bounds[3] - this.bounds[1]);
            const overlap = Math.max(0, Math.min(right, this.bounds[2]) - Math.max(left, this.bounds[0])) * Math.max(0, Math.min(bottom, this.bounds[3]) - Math.max(top, this.bounds[1]));
            let drawn = 0;
            if (overlap >= area * .5) {
                gl.drawElements(gl.POINTS, this.count, gl.UNSIGNED_INT, 0);
                drawn = this.count;
            }
            else if (overlap > 0 || area === 0) {
                let start = -1, count = 0;
                const flush = () => {
                    if (count) {
                        gl.drawElements(gl.POINTS, count, gl.UNSIGNED_INT, start * 4);
                        drawn += count;
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
            if (!picking)
                this.drawnLastFrame = drawn;
        }
        gl.bindVertexArray(null);
        gl.enable(gl.BLEND);
    }
    render(_gl: WebGL2RenderingContext, _options: CustomRenderMethodInput) {
        if (this.count)
            this.draw(false);
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
        gl.deleteProgram(this.program);
        gl.deleteVertexArray(this.vao);
        gl.deleteBuffer(this.positionBuffer);
        gl.deleteBuffer(this.indexBuffer);
        gl.deleteBuffer(this.spatialBuffer);
        gl.deleteBuffer(this.colorBuffer);
        if (this.framebuffer)
            gl.deleteFramebuffer(this.framebuffer);
        if (this.texture)
            gl.deleteTexture(this.texture);
    }
    get gpuBytes() { return this.capacity * 20 + (this.colorCodes?.byteLength ?? 0) + (this.indices?.byteLength ?? 0); }
}

