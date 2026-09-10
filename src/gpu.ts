// WebGL2 solver: the same diffusion / fixing step as Sim.step, run as a fragment
// shader over the flat texture. Free dye f and fixed dye h are RGBA32F textures
// (one channel per dye, up to 4). The layer-contact graph is a static RGBA32F
// texture of (upX, upY, downX, downY) texel coordinates, and press/validity is a
// second static texture. Two FBOs ping-pong (f, h) with multiple render targets.
//
// The CPU arrays in Sim stay the source of truth for strokes and replays: upload()
// after they change, download() before a stroke is applied on top of GPU state.

import { Sim } from './sim';
import { SimParams, DyeDef } from './plan';
import { ViewOpts } from './render';

const VS = `#version 300 es
void main() {
  // full-screen triangle
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const STEP_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uF, uH, uLinks, uPress;
uniform ivec2 uSize;
uniform float uDP, uDZ, uRate, uCap, uDt;
layout(location = 0) out vec4 oF;
layout(location = 1) out vec4 oH;

vec4 nb(ivec2 ij, ivec2 d, vec4 f) {
  ivec2 q = ij + d;
  if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) return vec4(0.0);
  if (texelFetch(uPress, q, 0).g < 0.5) return vec4(0.0);
  return texelFetch(uF, q, 0) - f;
}

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 f = texelFetch(uF, ij, 0);
  vec4 h = texelFetch(uH, ij, 0);
  vec4 pr = texelFetch(uPress, ij, 0);
  if (pr.g < 0.5) { oF = vec4(0.0); oH = h; return; }
  vec4 lap = nb(ij, ivec2(-1, 0), f) + nb(ij, ivec2(1, 0), f) + nb(ij, ivec2(0, -1), f) + nb(ij, ivec2(0, 1), f);
  lap *= uDP;
  vec4 L = texelFetch(uLinks, ij, 0);
  if (L.x >= 0.0) lap += uDZ * pr.r * (texelFetch(uF, ivec2(L.xy), 0) - f);
  if (L.z >= 0.0) lap += uDZ * pr.r * (texelFetch(uF, ivec2(L.zw), 0) - f);
  vec4 fn = max(f + uDt * lap, vec4(0.0));
  float room = uCap * pr.r - dot(h, vec4(1.0));
  vec4 da = vec4(0.0);
  if (room > 0.0) {
    da = min(uRate * fn * room * uDt, fn);
    float tot = dot(da, vec4(1.0));
    if (tot > room) da *= room / tot;
  }
  oF = fn - da;
  oH = h + da;
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uF, uH, uPress;
uniform ivec2 uSize;
uniform vec4 uLogR, uLogG, uLogB;
uniform float uStrength, uFixedOnly, uShowPress;
out vec4 o;
void main() {
  ivec2 ij = ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y));
  vec4 a = texelFetch(uH, ij, 0);
  if (uFixedOnly < 0.5) a += texelFetch(uF, ij, 0);
  a = max(a, vec4(0.0));
  vec3 rgb = exp(uStrength * vec3(dot(a, uLogR), dot(a, uLogG), dot(a, uLogB)));
  if (uShowPress > 0.5) {
    float t = 1.0 - texelFetch(uPress, ij, 0).r;
    rgb = mix(rgb, vec3(1.0, 0.47, 0.16), 0.5 * t);
  }
  o = vec4(rgb, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}

function program(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  return p;
}

function hexToLog(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const f = (c: number) => Math.log(Math.max(c, 2) / 255);
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

export class GpuSolver {
  canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private stepProg: WebGLProgram;
  private dispProg: WebGLProgram;
  private texF: WebGLTexture[] = [];
  private texH: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer[] = [];
  private texLinks!: WebGLTexture;
  private texPress!: WebGLTexture;
  private cur = 0;
  private N = 0;
  private M = 0;
  private sim: Sim;
  private stepU: Record<string, WebGLUniformLocation | null> = {};
  private dispU: Record<string, WebGLUniformLocation | null> = {};
  private scratch = new Float32Array(0);

  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      return !!gl && !!gl.getExtension('EXT_color_buffer_float');
    } catch { return false; }
  }

  constructor(sim: Sim) {
    this.sim = sim;
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('no webgl2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no float render targets');
    this.gl = gl;
    this.stepProg = program(gl, STEP_FS);
    this.dispProg = program(gl, DISPLAY_FS);
    for (const n of ['uF', 'uH', 'uLinks', 'uPress', 'uSize', 'uDP', 'uDZ', 'uRate', 'uCap', 'uDt']) this.stepU[n] = gl.getUniformLocation(this.stepProg, n);
    for (const n of ['uF', 'uH', 'uPress', 'uSize', 'uLogR', 'uLogG', 'uLogB', 'uStrength', 'uFixedOnly', 'uShowPress']) this.dispU[n] = gl.getUniformLocation(this.dispProg, n);
    this.resize();
  }

  private makeTex(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.N, this.M, 0, gl.RGBA, gl.FLOAT, null);
    return t;
  }

  /** (Re)allocate textures for the sim's current size. */
  resize(): void {
    const gl = this.gl;
    this.N = this.sim.N;
    this.M = this.sim.M;
    this.canvas.width = this.N;
    this.canvas.height = this.M;
    for (const t of [...this.texF, ...this.texH]) gl.deleteTexture(t);
    for (const f of this.fbo) gl.deleteFramebuffer(f);
    if (this.texLinks) gl.deleteTexture(this.texLinks);
    if (this.texPress) gl.deleteTexture(this.texPress);
    this.texF = [this.makeTex(), this.makeTex()];
    this.texH = [this.makeTex(), this.makeTex()];
    this.texLinks = this.makeTex();
    this.texPress = this.makeTex();
    this.fbo = [0, 1].map((i) => {
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texF[i], 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.texH[i], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fbo incomplete');
      return fb;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.scratch = new Float32Array(this.N * this.M * 4);
    this.cur = 0;
    this.uploadStatic();
    this.upload();
  }

  /** Layer links + press/validity from the sim. Call after geometry or bands change. */
  uploadStatic(): void {
    const gl = this.gl, N = this.N, n = N * this.M;
    const links = new Float32Array(n * 4);
    const press = new Float32Array(n * 4);
    const sim = this.sim;
    for (let i = 0; i < n; i++) {
      const u = sim.up[i], d = sim.down[i];
      links[i * 4] = u >= 0 ? u % N : -1;
      links[i * 4 + 1] = u >= 0 ? Math.floor(u / N) : -1;
      links[i * 4 + 2] = d >= 0 ? d % N : -1;
      links[i * 4 + 3] = d >= 0 ? Math.floor(d / N) : -1;
      press[i * 4] = sim.press[i];
      press[i * 4 + 1] = sim.faceId[i] >= 0 ? 1 : 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texLinks);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, this.M, gl.RGBA, gl.FLOAT, links);
    gl.bindTexture(gl.TEXTURE_2D, this.texPress);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, this.M, gl.RGBA, gl.FLOAT, press);
  }

  /** sim.f / sim.h -> GPU */
  upload(): void {
    const gl = this.gl, n = this.N * this.M, K = Math.min(4, this.sim.nDyes);
    const buf = this.scratch;
    for (const [arrs, tex] of [[this.sim.f, this.texF[this.cur]], [this.sim.h, this.texH[this.cur]]] as const) {
      buf.fill(0);
      for (let k = 0; k < K; k++) {
        const a = arrs[k];
        for (let i = 0; i < n; i++) buf[i * 4 + k] = a[i];
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.N, this.M, gl.RGBA, gl.FLOAT, buf);
    }
  }

  /** GPU -> sim.f / sim.h */
  download(): void {
    const gl = this.gl, n = this.N * this.M, K = Math.min(4, this.sim.nDyes);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
    for (const [arrs, att] of [[this.sim.f, gl.COLOR_ATTACHMENT0], [this.sim.h, gl.COLOR_ATTACHMENT1]] as const) {
      gl.readBuffer(att);
      gl.readPixels(0, 0, this.N, this.M, gl.RGBA, gl.FLOAT, this.scratch);
      for (let k = 0; k < K; k++) {
        const a = arrs[k];
        for (let i = 0; i < n; i++) a[i] = this.scratch[i * 4 + k];
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  step(params: SimParams, n: number): void {
    const gl = this.gl;
    gl.useProgram(this.stepProg);
    gl.viewport(0, 0, this.N, this.M);
    gl.uniform2i(this.stepU.uSize, this.N, this.M);
    gl.uniform1f(this.stepU.uDP, params.dPlane);
    gl.uniform1f(this.stepU.uDZ, params.dZ);
    gl.uniform1f(this.stepU.uRate, params.adsorb);
    gl.uniform1f(this.stepU.uCap, params.capacity);
    gl.uniform1f(this.stepU.uDt, 0.5);
    this.bindTex(2, this.texLinks, this.stepU.uLinks);
    this.bindTex(3, this.texPress, this.stepU.uPress);
    for (let s = 0; s < n; s++) {
      const src = this.cur, dst = 1 - this.cur;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
      this.bindTex(0, this.texF[src], this.stepU.uF);
      this.bindTex(1, this.texH[src], this.stepU.uH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.cur = dst;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sim.t += n;
  }

  /** Colour-map the current state into this.canvas (N x M). */
  draw(dyes: DyeDef[], opts: ViewOpts): void {
    const gl = this.gl;
    const lr = [0, 0, 0, 0], lg = [0, 0, 0, 0], lb = [0, 0, 0, 0];
    for (let k = 0; k < Math.min(4, dyes.length); k++) {
      const [r, g, b] = hexToLog(dyes[k].color);
      lr[k] = r; lg[k] = g; lb[k] = b;
    }
    gl.useProgram(this.dispProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.N, this.M);
    gl.uniform2i(this.dispU.uSize, this.N, this.M);
    gl.uniform4fv(this.dispU.uLogR, lr);
    gl.uniform4fv(this.dispU.uLogG, lg);
    gl.uniform4fv(this.dispU.uLogB, lb);
    gl.uniform1f(this.dispU.uStrength, opts.strength);
    gl.uniform1f(this.dispU.uFixedOnly, opts.fixedOnly ? 1 : 0);
    gl.uniform1f(this.dispU.uShowPress, opts.showPress ? 1 : 0);
    this.bindTex(0, this.texF[this.cur], this.dispU.uF);
    this.bindTex(1, this.texH[this.cur], this.dispU.uH);
    this.bindTex(2, this.texPress, this.dispU.uPress);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
