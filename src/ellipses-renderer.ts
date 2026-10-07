import { ELLIPSE_ASPECT_BUCKETS, ellipseTemplates, validateEllipseVertices } from './ellipses.ts';
const vertex = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D u_order;
uniform int u_offset;
uniform int u_stride;
uniform int u_count;
uniform sampler2D u_positions;
uniform sampler2D u_axes;
uniform sampler2D u_samples;
uniform sampler2D u_styles;
uniform int u_width;
uniform int u_vertices;
uniform vec4 u_center;
uniform vec2 u_scale;
uniform vec2 u_viewport;
uniform float u_line_width;
uniform float u_world;
uniform vec3 u_color;
uniform bool u_styled;
uniform bool u_colored;
uniform bool u_categorical;
uniform vec3 u_palette[64];
out vec3 v_color;
const float PI=3.141592653589793;
// Stable log(1+x) preserves sub-metre offsets at high zoom.
float log1p(float x) { return abs(x)<.001 ? x*(1.0-x*(.5-x/3.0)) : log(1.0+x); }
vec2 projectSample(vec4 axes, vec4 position, int sampleIndex, int bucket) {
  vec2 unit=texelFetch(u_samples,ivec2(sampleIndex,bucket),0).xy;
  float cosLat=cos(axes.w), sinLat=sin(axes.w);
  float major=axes.x*unit.x, minor=axes.y*unit.y;
  float sn=sin(axes.z), cs=cos(axes.z);
  float east=major*sn+minor*cs, north=major*cs-minor*sn;
  // Use the tangent limit only when its conservative second-order screen error
  // is below 1/8 pixel. At high zoom or large distances use the spherical path.
  if(axes.x*axes.x*u_world/(2.0*PI*cosLat*cosLat)<.125) {
    vec2 offset=vec2(east,-north)/(2.0*PI*cosLat);
    offset.y=clamp(offset.y,-(position.y+position.w),1.0-(position.y+position.w));
    return offset*u_scale;
  }
  float distance=length(vec2(east,north));
  float sinc=distance<.0001?1.0:sin(distance)/distance;
  float cosDistance=cos(distance);
  float deltaSin=sinLat*(-2.0*pow(sin(distance*.5),2.0))+cosLat*north*sinc;
  deltaSin=clamp(deltaSin,-.9999999-sinLat,.9999999-sinLat);
  float dx=atan(east*sinc,cosLat*cosDistance-sinLat*north*sinc)/(2.0*PI);
  float dy=(log1p(-deltaSin/(1.0-sinLat))-log1p(deltaSin/(1.0+sinLat)))/(4.0*PI);
  // Mercator cannot show the poles; use the same clamp as centre points.
  dy=clamp(dy,-(position.y+position.w),1.0-(position.y+position.w));
  return vec2(dx,dy)*u_scale;
}
void main() {
  int local=gl_InstanceID*u_stride;
  // Stable jitter avoids favouring periodic categories in input row order.
  if(u_stride>1) { uint h=uint(gl_InstanceID+u_offset); h^=h>>16u; h*=0x7feb352du; h^=h>>15u; local+=int(h%uint(u_stride)); }
  int ordinal=u_offset+min(local,u_count-1);
  uint index=texelFetch(u_order,ivec2(ordinal%u_width,ordinal/u_width),0).r;
  ivec2 cell=ivec2(int(index)%u_width,int(index)/u_width);
  vec4 style=u_styled?texelFetch(u_styles,cell,0):vec4(u_color,1.0);
  gl_Position=vec4(2.0,2.0,0.0,1.0);
  if(style.a<.5) return;
  vec4 axes=texelFetch(u_axes,cell,0);
  if(axes.x<=0.0) return;
  float cosLat=cos(axes.w);
  float radius=axes.x/(2.0*PI*cosLat);
  // Subpixel outlines contribute no readable geometry. Keep their centre points.
  if(radius*u_world<.75) return;
  vec4 position=texelFetch(u_positions,cell,0);
  vec2 relative=(position.xy-u_center.xy)+(position.zw-u_center.zw);
  vec2 center=relative*u_scale;
  float bound=axes.x/(2.0*PI*cos(min(1.48442223,abs(axes.w)+axes.x)));
  if(any(greaterThan(abs(center),vec2(1.0)+bound*abs(u_scale)+u_line_width*4.0/u_viewport))) return;
  int code=int(round(style.r*255.0));
  v_color=u_colored?(u_categorical?style.rgb:(code==255?vec3(.5):u_palette[min(code,63)])):u_color;
  int bucket=int(round(clamp(log2(axes.x/axes.y),0.0,10.0)*6.3));
  // Two vertices per sample form a closed ribbon. Screen-space extrusion
  // supports widths on drivers whose native WebGL lines are fixed at 1 px.
  int sampleIndex=(gl_VertexID/2)%u_vertices;
  vec2 at=projectSample(axes,position,sampleIndex,bucket);
  vec2 before=projectSample(axes,position,(sampleIndex+u_vertices-1)%u_vertices,bucket);
  vec2 after=projectSample(axes,position,(sampleIndex+1)%u_vertices,bucket);
  vec2 incoming=(at-before)*u_viewport, outgoing=(after-at)*u_viewport;
  float incomingLength=length(incoming), outgoingLength=length(outgoing);
  if(min(incomingLength,outgoingLength)<1e-7) return;
  vec2 n0=vec2(-incoming.y,incoming.x)/incomingLength;
  vec2 n1=vec2(-outgoing.y,outgoing.x)/outgoingLength;
  vec2 bisector=n0+n1;
  float bisectorLength=length(bisector);
  vec2 miter=bisectorLength>1e-7?bisector/bisectorLength:n1;
  // Cap acute joins, especially for very narrow ellipses and low vertex counts.
  vec2 offset=miter*(u_line_width/max(abs(dot(miter,n1)),.25))/u_viewport;
  float side=gl_VertexID%2==0?-1.0:1.0;
  gl_Position=vec4(center+at+offset*side,0.0,1.0);
}`;
const fragment = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 color;
void main(){ color=vec4(v_color,1.0); }`;
export type EllipseChunk = { offset: number; positions: Float32Array; indices: Uint32Array; ellipses?: Float32Array };
// Index textures retain point spatial/filter order and let dense views select
// evenly spaced instances without rebuilding geometry. There
// are no expanded per-ellipse polygons and no row scans during pan/zoom.
export class EllipsesRenderer {
    private program: WebGLProgram;
    private vao: WebGLVertexArrayObject;
    private spatialOrder: WebGLTexture;
    private filterOrder: WebGLTexture;
    private filterBytes = 0;
    private positions: WebGLTexture;
    private axes: WebGLTexture;
    private samples: WebGLTexture;
    private styles: WebGLTexture;
    private uniforms: Record<string, WebGLUniformLocation | null> = {};
    private width: number;
    private height = 0;
    private vertices = 0;
    private styled = false;
    private colored = false;
    private categorical = false;
    private styleBytes = 4;
    constructor(private gl: WebGL2RenderingContext) {
        this.width = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
        const shaders = [vertex, fragment].map((source, i) => {
            const shader = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER)!;
            gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader) ?? 'Ellipse shader compilation failed');
            return shader;
        });
        this.program = gl.createProgram()!;
        for (const s of shaders) gl.attachShader(this.program, s);
        gl.linkProgram(this.program);
        for (const s of shaders) gl.deleteShader(s);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(this.program) ?? 'Ellipse shader link failed');
        for (const name of ['positions','axes','samples','styles','width','vertices','center','scale','viewport','line_width','world','color','styled','colored','categorical','palette','order','offset','stride','count']) this.uniforms[name] = gl.getUniformLocation(this.program, 'u_' + name);
        this.vao = gl.createVertexArray()!;
        this.spatialOrder = this.texture(); this.filterOrder = this.texture();
        this.positions = this.texture(); this.axes = this.texture(); this.samples = this.texture(); this.styles = this.texture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
    }
    private texture() {
        const gl = this.gl, texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }
    resize(capacity: number, chunks: EllipseChunk[]) {
        const gl = this.gl;
        this.height = Math.max(1, Math.ceil(capacity / this.width));
        if (this.height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw Error('Ellipse data exceeds GPU texture capacity.');
        gl.activeTexture(gl.TEXTURE0);
        for (const texture of [this.positions, this.axes]) {
            gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.width, this.height, 0, gl.RGBA, gl.FLOAT, null);
        }
        gl.bindTexture(gl.TEXTURE_2D, this.spatialOrder); gl.texImage2D(gl.TEXTURE_2D,0,gl.R32UI,this.width,this.height,0,gl.RED_INTEGER,gl.UNSIGNED_INT,null);
        for (const c of chunks) this.append(c);
        if (gl.getError() !== gl.NO_ERROR) throw Error('GPU ellipse allocation failed; lower point limit.');
    }
    private upload(texture: WebGLTexture, offset: number, data: Float32Array | Uint32Array) {
        const gl = this.gl; gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
        const integer = data instanceof Uint32Array, components = integer ? 1 : 4;
        let at = 0, count = data.length / components;
        while (count) {
            const x = offset % this.width, rows = x === 0 ? Math.floor(count / this.width) : 0;
            const width = rows ? this.width : Math.min(count, this.width - x), height = Math.max(1, rows), n = width * height;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x, Math.floor(offset / this.width), width, height, integer ? gl.RED_INTEGER : gl.RGBA, integer ? gl.UNSIGNED_INT : gl.FLOAT, data.subarray(at * components, (at + n) * components));
            at += n; offset += n; count -= n;
        }
    }
    append(chunk: EllipseChunk) {
        if (chunk.ellipses) { this.upload(this.positions, chunk.offset, chunk.positions); this.upload(this.axes, chunk.offset, chunk.ellipses); }
        this.upload(this.spatialOrder, chunk.offset, chunk.indices);
    }
    setFilter(indices: Uint32Array | null) {
        const gl = this.gl, count = indices?.length ?? 0;
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.filterOrder);
        const height = Math.max(1,Math.ceil(count/this.width));
        gl.texImage2D(gl.TEXTURE_2D,0,gl.R32UI,this.width,height,0,gl.RED_INTEGER,gl.UNSIGNED_INT,null);
        if(indices) this.upload(this.filterOrder,0,indices);
        this.filterBytes = this.width*height*4;
    }
    setStyles(count: number, codes: Uint8Array | undefined, categorical: boolean, mask: Uint8Array | undefined) {
        this.styled = !!(codes || mask); this.colored = !!codes; this.categorical = categorical;
        const gl = this.gl;
        if (!this.styled) {
            if (this.styleBytes > 4) {
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.styles);
                gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255])); this.styleBytes = 4;
            }
            return;
        }
        const height = Math.max(1, Math.ceil(count / this.width)), data = new Uint8Array(this.width * height * 4);
        for (let i = 0; i < count; i++) {
            const p = i * 4;
            if (codes && categorical) { const c=i*3; data[p]=codes[c]; data[p+1]=codes[c+1]; data[p+2]=codes[c+2]; }
            else if (codes) data[p]=codes[i];
            data[p+3] = !mask || mask[i] ? 255 : 0;
        }
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.styles);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data); this.styleBytes = data.byteLength;
    }
    prepare(vertices: number, center: number[], scale: number[], world: number, color: number[], palette: Float32Array, viewport: number[], lineWidth: number) {
        const gl = this.gl;
        if (vertices !== this.vertices) {
            validateEllipseVertices(vertices); this.vertices = vertices;
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.samples);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, vertices, ELLIPSE_ASPECT_BUCKETS, 0, gl.RG, gl.FLOAT, ellipseTemplates(vertices));
        }
        gl.useProgram(this.program); gl.bindVertexArray(this.vao);
        [this.positions,this.axes,this.samples,this.styles].forEach((texture,i) => { gl.activeTexture(gl.TEXTURE0+i); gl.bindTexture(gl.TEXTURE_2D,texture); });
        for (const [i,name] of ['positions','axes','samples','styles'].entries()) gl.uniform1i(this.uniforms[name],i);
        gl.uniform1i(this.uniforms.width,this.width); gl.uniform1i(this.uniforms.vertices,vertices); gl.uniform1i(this.uniforms.styled,this.styled?1:0);
        gl.uniform1i(this.uniforms.colored,this.colored?1:0); gl.uniform1i(this.uniforms.categorical,this.categorical?1:0); gl.uniform3fv(this.uniforms.palette,palette);
        gl.uniform2fv(this.uniforms.viewport,viewport); gl.uniform1f(this.uniforms.line_width,lineWidth);
        gl.uniform4fv(this.uniforms.center,center); gl.uniform2fv(this.uniforms.scale,scale); gl.uniform1f(this.uniforms.world,world); gl.uniform3fv(this.uniforms.color,color);
    }
    draw(filtered: boolean, count: number, offset: number, stride = 1) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D,filtered?this.filterOrder:this.spatialOrder);
        gl.uniform1i(this.uniforms.order,4); gl.uniform1i(this.uniforms.offset,offset); gl.uniform1i(this.uniforms.stride,stride); gl.uniform1i(this.uniforms.count,count);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,(this.vertices+1)*2,Math.ceil(count/stride));
    }
    remove() { const gl = this.gl; for (const t of [this.positions,this.axes,this.samples,this.styles,this.spatialOrder,this.filterOrder]) gl.deleteTexture(t); gl.deleteVertexArray(this.vao); gl.deleteProgram(this.program); }
    get gpuBytes() { return this.width*this.height*32 + this.width*this.height*4 + this.filterBytes + this.styleBytes + this.vertices*ELLIPSE_ASPECT_BUCKETS*8; }
}
