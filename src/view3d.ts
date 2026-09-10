// True 3D view of a bundle: the texel grid as a lit, textured mesh (two triangles per
// grid quad, UV = flat cloth coordinates) or as oriented Gaussian surfel splats, an
// orbit camera, and ID-buffer picking. The same class also answers the
// camera-independent question strokes need: "which texels are visible looking along
// direction d at point p, within radius R?" by rendering IDs from a small
// orthographic camera. That makes 3D strokes replayable after the geometry changes.

export type Vec3 = [number, number, number];
export type Style = 'mesh' | 'splat';

// ---------------------------------------------------------------------------
// tiny mat4 helpers (column-major, as WebGL expects)

type Mat4 = Float32Array;

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
  return m;
}
function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n); m[15] = 1;
  return m;
}
function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2]; m[12] = -dot(x, eye);
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2]; m[13] = -dot(y, eye);
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2]; m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}
function mul4(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function transform(m: Mat4, p: Vec3): [number, number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
  ];
}
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function norm(a: Vec3): Vec3 { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
/** any unit vector perpendicular to n */
export function perp(n: Vec3): Vec3 {
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return norm(cross(n, a));
}

// ---------------------------------------------------------------------------
// shaders

const MESH_VS = `#version 300 es
in vec3 aPos; in vec2 aUv; in float aId;
uniform mat4 uMVP;
out vec2 vUv; out vec3 vPos; flat out float vId;
void main() { vUv = aUv; vPos = aPos; vId = aId; gl_Position = uMVP * vec4(aPos, 1.0); }`;

const MESH_FS = `#version 300 es
precision highp float;
in vec2 vUv; in vec3 vPos; flat in float vId;
uniform sampler2D uTex; uniform vec3 uLight; uniform vec3 uEye; uniform int uIdMode; uniform float uCloth;
out vec4 o;
vec4 encode(float id) { float v = id + 1.0; return vec4(mod(v, 256.0) / 255.0, mod(floor(v / 256.0), 256.0) / 255.0, floor(v / 65536.0) / 255.0, 1.0); }
void main() {
  if (uIdMode == 1) { o = encode(vId); return; }
  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
  vec3 v = normalize(uEye - vPos);
  if (dot(n, v) < 0.0) n = -n;
  vec3 c = uCloth > 0.5 ? texture(uTex, vUv).rgb : vec3(0.93);
  float diff = max(dot(n, uLight), 0.0);
  float spec = pow(max(dot(normalize(uLight + v), n), 0.0), 24.0) * 0.12;
  o = vec4(c * (0.42 + 0.6 * diff) + spec, 1.0);
}`;

const SPLAT_VS = `#version 300 es
in vec2 aCorner;
in vec3 aPos; in vec3 aNormal; in vec2 aUv; in float aId;
uniform mat4 uMVP; uniform float uSize;
out vec2 vCorner; out vec2 vUv; out vec3 vN; flat out float vId;
void main() {
  vec3 n = normalize(aNormal);
  vec3 a = abs(n.x) < 0.9 ? vec3(1,0,0) : vec3(0,1,0);
  vec3 t = normalize(cross(n, a)); vec3 b = cross(n, t);
  vec3 p = aPos + (t * aCorner.x + b * aCorner.y) * uSize;
  vCorner = aCorner; vUv = aUv; vN = n; vId = aId;
  gl_Position = uMVP * vec4(p, 1.0);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
in vec2 vCorner; in vec2 vUv; in vec3 vN; flat in float vId;
uniform sampler2D uTex; uniform vec3 uLight; uniform vec3 uEye; uniform int uIdMode; uniform float uCloth;
out vec4 o;
vec4 encode(float id) { float v = id + 1.0; return vec4(mod(v, 256.0) / 255.0, mod(floor(v / 256.0), 256.0) / 255.0, floor(v / 65536.0) / 255.0, 1.0); }
void main() {
  float r2 = dot(vCorner, vCorner);
  float a = exp(-2.5 * r2);
  if (a < 0.45) discard;
  if (uIdMode == 1) { o = encode(vId); return; }
  vec3 n = vN;
  vec3 c = uCloth > 0.5 ? texture(uTex, vUv).rgb : vec3(0.93);
  float diff = abs(dot(n, uLight));
  o = vec4(c * (0.42 + 0.6 * diff), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  return p;
}

export interface Camera {
  target: Vec3;
  dist: number;
  /** azimuth around z, radians */
  az: number;
  /** elevation above the xy plane, radians */
  el: number;
  fov: number;
}

export interface Footprint {
  ids: Int32Array;
  /** 3D distance of each id's texel from the hit point */
  dist: Float32Array;
}

export class View3D {
  canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private meshProg: WebGLProgram;
  private splatProg: WebGLProgram;
  private vaoMesh: WebGLVertexArrayObject;
  private vaoSplat: WebGLVertexArrayObject;
  private bufPos: WebGLBuffer;
  private bufNrm: WebGLBuffer;
  private bufUv: WebGLBuffer;
  private bufId: WebGLBuffer;
  private bufIdx: WebGLBuffer;
  private bufCorner: WebGLBuffer;
  private tex: WebGLTexture;
  private idFbo: WebGLFramebuffer;
  private idTex: WebGLTexture;
  private idDepth: WebGLRenderbuffer;
  private idW = 0;
  private idH = 0;
  private fpFbo: WebGLFramebuffer;
  private fpTex: WebGLTexture;
  private fpDepth: WebGLRenderbuffer;
  private readonly FP = 96;
  private N = 0;
  private M = 0;
  private n = 0;
  private nIdx = 0;
  private pos = new Float32Array(0);
  private nrm = new Float32Array(0);
  private idx = new Uint32Array(0);
  private h = 1;
  private hasCloth = false;
  private idDirty = true;
  style: Style = 'mesh';
  cam: Camera = { target: [30, 30, 0], dist: 90, az: -Math.PI / 2, el: 0.9, fov: 0.7 };
  light: Vec3 = norm([0.4, 0.3, 1]);
  private viewProj: Float32Array = new Float32Array(16);
  private eye: Vec3 = [0, 0, 1];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true })!;
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    this.meshProg = program(gl, MESH_VS, MESH_FS);
    this.splatProg = program(gl, SPLAT_VS, SPLAT_FS);
    this.bufPos = gl.createBuffer()!; this.bufNrm = gl.createBuffer()!; this.bufUv = gl.createBuffer()!;
    this.bufId = gl.createBuffer()!; this.bufIdx = gl.createBuffer()!; this.bufCorner = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufCorner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    this.vaoMesh = gl.createVertexArray()!;
    this.vaoSplat = gl.createVertexArray()!;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([240, 240, 240, 255]));
    this.idFbo = gl.createFramebuffer()!; this.idTex = gl.createTexture()!; this.idDepth = gl.createRenderbuffer()!;
    this.fpFbo = gl.createFramebuffer()!; this.fpTex = gl.createTexture()!; this.fpDepth = gl.createRenderbuffer()!;
    this.setupFbo(this.fpFbo, this.fpTex, this.fpDepth, this.FP, this.FP);
  }

  private setupFbo(fbo: WebGLFramebuffer, tex: WebGLTexture, depth: WebGLRenderbuffer, w: number, h: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Grid topology: N x M texels, UVs from flat cloth coords. */
  setGrid(N: number, M: number, W: number, _H: number): void {
    const gl = this.gl;
    this.N = N; this.M = M; this.n = N * M;
    const uv = new Float32Array(this.n * 2), id = new Float32Array(this.n);
    for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      uv[k * 2] = (i + 0.5) / N;
      uv[k * 2 + 1] = (j + 0.5) / M;
      id[k] = k;
    }
    this.idx = new Uint32Array((N - 1) * (M - 1) * 6);
    this.nIdx = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufUv); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufId); gl.bufferData(gl.ARRAY_BUFFER, id, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx, gl.DYNAMIC_DRAW);
    this.pos = new Float32Array(this.n * 3);
    this.nrm = new Float32Array(this.n * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos); gl.bufferData(gl.ARRAY_BUFFER, this.pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufNrm); gl.bufferData(gl.ARRAY_BUFFER, this.nrm, gl.DYNAMIC_DRAW);
    // VAOs
    const bind = (vao: WebGLVertexArrayObject, prog: WebGLProgram, splat: boolean) => {
      gl.bindVertexArray(vao);
      const attr = (name: string, buf: WebGLBuffer, size: number, divisor: number) => {
        const loc = gl.getAttribLocation(prog, name);
        if (loc < 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(loc, divisor);
      };
      const d = splat ? 1 : 0;
      attr('aPos', this.bufPos, 3, d);
      attr('aUv', this.bufUv, 2, d);
      attr('aId', this.bufId, 1, d);
      if (splat) { attr('aNormal', this.bufNrm, 3, 1); attr('aCorner', this.bufCorner, 2, 0); }
      else gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx);
      gl.bindVertexArray(null);
    };
    bind(this.vaoMesh, this.meshProg, false);
    bind(this.vaoSplat, this.splatProg, true);
    this.h = W / N;
  }

  /** Texel positions (cm). Recomputes normals for splats. */
  setPositions(px: Float32Array, py: Float32Array, pz: Float32Array): void {
    const { N, M, n, pos, nrm } = this;
    for (let i = 0; i < n; i++) { pos[i * 3] = px[i]; pos[i * 3 + 1] = py[i]; pos[i * 3 + 2] = pz[i]; }
    const P = (i: number): Vec3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const dx = sub(P(j * N + Math.min(N - 1, i + 1)), P(j * N + Math.max(0, i - 1)));
      const dy = sub(P(Math.min(M - 1, j + 1) * N + i), P(Math.max(0, j - 1) * N + i));
      const nn = norm(cross(dx, dy));
      nrm[k * 3] = nn[0]; nrm[k * 3 + 1] = nn[1]; nrm[k * 3 + 2] = nn[2];
    }
    // triangles: skip quads whose corners are far apart in the bundle (they straddle a
    // fold and would draw a fake wall between layers that catches squirts)
    const limit = 4 * this.h;
    let q = 0;
    for (let j = 0; j < M - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      const span = Math.max(len3(sub(P(a), P(d))), len3(sub(P(b), P(c))));
      if (span > limit) continue;
      this.idx[q++] = a; this.idx[q++] = b; this.idx[q++] = d; this.idx[q++] = a; this.idx[q++] = d; this.idx[q++] = c;
    }
    this.nIdx = q;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufNrm); gl.bufferSubData(gl.ARRAY_BUFFER, 0, nrm);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx); gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.idx, 0, q);
    this.hasCloth = true;
    this.idDirty = true;
  }

  position(i: number): Vec3 { return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]; }
  normal(i: number): Vec3 { return [this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]]; }

  /** Fit the camera to the current positions. */
  frame(): void {
    let mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.n; i++) for (let c = 0; c < 3; c++) {
      const v = this.pos[i * 3 + c];
      if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v;
    }
    if (!isFinite(mn[0])) return;
    this.cam.target = scale3(add(mn, mx), 0.5);
    const r = 0.5 * len3(sub(mx, mn));
    this.cam.dist = Math.max(1, r / Math.sin(this.cam.fov / 2) * 1.05);
  }

  setTexture(src: HTMLCanvasElement): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  private cameraMatrices(w: number, h: number): void {
    const c = this.cam;
    const ce = Math.cos(c.el);
    const eye: Vec3 = [
      c.target[0] + c.dist * ce * Math.cos(c.az),
      c.target[1] + c.dist * ce * Math.sin(c.az),
      c.target[2] + c.dist * Math.sin(c.el),
    ];
    this.eye = eye;
    const view = lookAt(eye, c.target, [0, 0, 1]);
    const proj = perspective(c.fov, w / h, c.dist * 0.02, c.dist * 10);
    this.viewProj = mul4(proj, view);
  }

  /** view direction (unit) from the eye toward the target */
  forward(): Vec3 { return norm(sub(this.cam.target, this.eye)); }
  eyePos(): Vec3 { return this.eye; }

  private render(vp: Float32Array, eye: Vec3, idMode: boolean, w: number, h: number): void {
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    if (idMode) gl.clearColor(0, 0, 0, 0); else gl.clearColor(0.184, 0.184, 0.212, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.hasCloth) return;
    const splat = this.style === 'splat';
    const prog = splat ? this.splatProg : this.meshProg;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, vp);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uLight'), this.light);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uEye'), eye);
    gl.uniform1i(gl.getUniformLocation(prog, 'uIdMode'), idMode ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloth'), 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    if (splat) {
      gl.uniform1f(gl.getUniformLocation(prog, 'uSize'), 0.75 * this.h);
      gl.bindVertexArray(this.vaoSplat);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.n);
    } else {
      gl.bindVertexArray(this.vaoMesh);
      gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }

  /** Draw the view into the canvas (backing store sized by the caller). */
  draw(): void {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    this.cameraMatrices(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.render(this.viewProj, this.eye, false, w, h);
    this.idDirty = true;
  }

  private ensureIdBuffer(): void {
    const w = this.canvas.width, h = this.canvas.height;
    if (this.idW !== w || this.idH !== h) {
      this.setupFbo(this.idFbo, this.idTex, this.idDepth, w, h);
      this.idW = w; this.idH = h;
      this.idDirty = true;
    }
    if (this.idDirty) {
      const gl = this.gl;
      this.cameraMatrices(w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.idFbo);
      this.render(this.viewProj, this.eye, true, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.idDirty = false;
    }
  }

  private static decode(px: Uint8Array, o: number): number {
    return px[o] + px[o + 1] * 256 + px[o + 2] * 65536 - 1;
  }

  /** texel under a canvas pixel (backing-store coords), or -1 */
  pick(x: number, y: number): number {
    this.ensureIdBuffer();
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.idFbo);
    gl.readPixels(Math.floor(x), Math.floor(this.idH - 1 - y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return View3D.decode(px, 0);
  }

  /** world -> canvas pixel */
  project(p: Vec3): { x: number; y: number; depth: number } | null {
    const w = this.canvas.width, h = this.canvas.height;
    this.cameraMatrices(w, h);
    const c = transform(this.viewProj, p);
    if (c[3] <= 0) return null;
    return { x: (c[0] / c[3] * 0.5 + 0.5) * w, y: (1 - (c[1] / c[3] * 0.5 + 0.5)) * h, depth: c[3] };
  }

  /** pixels per cm at a given view depth (for cursor circles) */
  pixelsPerCm(depth: number): number {
    return this.canvas.height / (2 * depth * Math.tan(this.cam.fov / 2));
  }

  /**
   * Camera-independent visibility: texels visible looking along `d` at `p`, within
   * `radius` of p (3D). Renders IDs from a small orthographic camera, so a stroke
   * stored as (p, d, r) can be replayed on new geometry.
   */
  footprint(p: Vec3, d: Vec3, radius: number): Footprint {
    const gl = this.gl;
    const dir = norm(d);
    const eye = sub(p, scale3(dir, radius * 4));
    const up = perp(dir);
    const view = lookAt(eye, p, up);
    const proj = ortho(-radius, radius, -radius, radius, radius * 0.5, radius * 8);
    const vp = mul4(proj, view);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fpFbo);
    this.render(vp, eye, true, this.FP, this.FP);
    const px = new Uint8Array(this.FP * this.FP * 4);
    gl.readPixels(0, 0, this.FP, this.FP, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const seen = new Set<number>();
    for (let o = 0; o < px.length; o += 4) {
      const id = View3D.decode(px, o);
      if (id >= 0) seen.add(id);
    }
    const ids = Int32Array.from(seen);
    const dist = new Float32Array(ids.length);
    for (let k = 0; k < ids.length; k++) dist[k] = len3(sub(this.position(ids[k]), p));
    return { ids, dist };
  }

  /** ray direction through a canvas pixel (unit, world space) */
  rayDir(x: number, y: number): Vec3 {
    const w = this.canvas.width, h = this.canvas.height;
    this.cameraMatrices(w, h);
    const fwd = this.forward();
    const right = norm(cross(fwd, [0, 0, 1]));
    const up = cross(right, fwd);
    const t = Math.tan(this.cam.fov / 2);
    const nx = (x / w * 2 - 1) * t * (w / h), ny = (1 - y / h * 2) * t;
    return norm(add(add(fwd, scale3(right, nx)), scale3(up, ny)));
  }

  orbit(dx: number, dy: number): void {
    this.cam.az -= dx * 0.008;
    this.cam.el = Math.max(-1.5, Math.min(1.5, this.cam.el + dy * 0.008));
  }
  zoom(factor: number): void { this.cam.dist = Math.max(2, Math.min(2000, this.cam.dist * factor)); }
  pan(dx: number, dy: number): void {
    const fwd = this.forward();
    const right = norm(cross(fwd, [0, 0, 1]));
    const up = cross(right, fwd);
    const s = this.cam.dist * 2 * Math.tan(this.cam.fov / 2) / this.canvas.height;
    this.cam.target = add(this.cam.target, add(scale3(right, -dx * s), scale3(up, dy * s)));
  }
}
