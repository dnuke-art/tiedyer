// Dye simulation on the folded cloth.
//
// The cloth is a flat texture of N x M texels. In-plane diffusion is a plain 2D
// Laplacian on that texture (the cloth is continuous across creases). Layer contact
// is a precomputed per-texel "up"/"down" neighbour: the texel of the face directly
// above / below this one in the folded stack at the same folded position. Dye moves
// across those links with coefficient dZ. This is Morimoto & Ono's 3D diffusion graph,
// stored as a 2D texture plus two gather maps.
//
//   df/dt = div(D grad f) + supply - adsorption
//   dh/dt = adsorption          (h = fixed dye, survives rinsing)
//
// Bindings (bands/clamps) produce a press field P in [0,1]: 0 under a clamp, rising
// to 1 at pressRadius away. Press blocks dye supply, reduces capacity, and reduces
// cross-layer transfer (no liquid in a squeezed gap).

import { Vec2, apply, dist } from './geom';
import { Face, indexFaces, FaceIndex, faceAtFlat, facesAtFolded } from './fold';
import { BandStamp, Stroke, SimParams, Plan } from './plan';

export class Sim {
  N = 0;
  M = 0;
  cell = 1;
  W = 0;
  H = 0;
  nDyes = 0;

  faces: Face[] = [];
  index!: FaceIndex;

  /** per texel */
  faceId = new Int32Array(0);
  fx = new Float32Array(0);
  fy = new Float32Array(0);
  up = new Int32Array(0);
  down = new Int32Array(0);
  depthTop = new Int32Array(0);
  depthBot = new Int32Array(0);
  press = new Float32Array(0);
  maxLayers = 0;

  /** free (mobile) dye per dye species */
  f: Float32Array[] = [];
  /** adsorbed (fixed) dye per species */
  h: Float32Array[] = [];
  /** liquid fill fraction per texel, 0 = dry, up to press (a squeezed layer holds less) */
  wet = new Float32Array(0);
  private tmp = new Float32Array(0);
  private hsum = new Float32Array(0);

  /** simulation steps taken since last reset */
  t = 0;

  constructor(plan: Plan) {
    this.configure(plan);
  }

  configure(plan: Plan): void {
    this.W = plan.W;
    this.H = plan.H;
    this.N = plan.N;
    this.cell = plan.W / plan.N;
    this.M = Math.max(1, Math.round(plan.H / this.cell));
    this.nDyes = plan.dyes.length;
    const n = this.N * this.M;
    this.faceId = new Int32Array(n);
    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);
    this.up = new Int32Array(n);
    this.down = new Int32Array(n);
    this.depthTop = new Int32Array(n);
    this.depthBot = new Int32Array(n);
    this.press = new Float32Array(n).fill(1);
    this.tmp = new Float32Array(n);
    this.hsum = new Float32Array(n);
    this.wet = new Float32Array(n);
    this.f = [];
    this.h = [];
    for (let k = 0; k < this.nDyes; k++) {
      this.f.push(new Float32Array(n));
      this.h.push(new Float32Array(n));
    }
    this.t = 0;
  }

  texelCenter(i: number): Vec2 {
    const x = i % this.N, y = Math.floor(i / this.N);
    return { x: (x + 0.5) * this.cell, y: (y + 0.5) * this.cell };
  }

  texelAt(uv: Vec2): number {
    const x = Math.min(this.N - 1, Math.max(0, Math.floor(uv.x / this.cell)));
    const y = Math.min(this.M - 1, Math.max(0, Math.floor(uv.y / this.cell)));
    return y * this.N + x;
  }

  /** Rebuild folded positions and the layer-contact graph from a face set. */
  rebuildGeometry(faces: Face[]): void {
    this.faces = faces;
    this.index = indexFaces(faces);
    const idx = this.index;
    const n = this.N * this.M;
    let maxLayers = 0;
    for (let i = 0; i < n; i++) {
      const uv = this.texelCenter(i);
      const fi = faceAtFlat(idx, uv, this.cell * 1e-3);
      this.faceId[i] = fi;
      if (fi < 0) {
        this.fx[i] = uv.x; this.fy[i] = uv.y;
        this.up[i] = -1; this.down[i] = -1;
        this.depthTop[i] = 0; this.depthBot[i] = 0;
        continue;
      }
      const p = apply(faces[fi].T, uv);
      this.fx[i] = p.x; this.fy[i] = p.y;
      const column = facesAtFolded(idx, p, this.cell * 1e-3); // top first
      let pos = column.indexOf(fi);
      if (pos < 0) { column.push(fi); pos = column.length - 1; }
      this.depthTop[i] = pos;
      this.depthBot[i] = column.length - 1 - pos;
      if (column.length > maxLayers) maxLayers = column.length;
      this.up[i] = pos > 0 ? this.texelAt(apply(idx.Tinv[column[pos - 1]], p)) : -1;
      this.down[i] = pos < column.length - 1 ? this.texelAt(apply(idx.Tinv[column[pos + 1]], p)) : -1;
    }
    this.maxLayers = maxLayers;
  }

  /** Press field from binding stamps (folded coords). */
  rebuildPress(bands: BandStamp[], params: SimParams): void {
    const n = this.N * this.M;
    if (bands.length === 0) { this.press.fill(1); return; }
    const c = Math.max(1e-6, params.pressRadius);
    const floor = params.pressFloor;
    for (let i = 0; i < n; i++) {
      const px = this.fx[i], py = this.fy[i];
      let dmin = Infinity;
      for (const b of bands) {
        const d = Math.hypot(px - b.p.x, py - b.p.y) - b.r;
        if (d < dmin) dmin = d;
      }
      const d = Math.max(0, dmin);
      const P = Math.min(1, d / c);
      this.press[i] = floor + (1 - floor) * P;
    }
  }

  resetDye(): void {
    for (let k = 0; k < this.nDyes; k++) { this.f[k].fill(0); this.h[k].fill(0); }
    this.wet.fill(0);
    this.t = 0;
  }

  /**
   * Wicking. Liquid squirted on one surface fills the outermost layer's pores and the
   * excess passes to the next layer, a saturation front. Each layer can hold `press`
   * worth of liquid (a squeezed layer holds less; a fully pressed one stops the front).
   *
   * Every texel decides for itself how much liquid reaches it: the volume applied at
   * its folded position minus what the layers between it and the surface can absorb,
   * using their capacity BEFORE this stroke. Reading pre-stroke capacity (a smooth
   * field) rather than the layers' post-stroke fill keeps the front smooth even though
   * the texel grids of mirrored layers are offset by up to half a texel.
   * `volumeAt(i)` returns the liquid volume (in layer-fills) applied above texel i.
   */
  private wickPass(fromTop: boolean, conc: number, f: Float32Array, volumeAt: (i: number) => number): void {
    const n = this.N * this.M;
    const eps = this.cell * 1e-3;
    const before = this.wet.slice();
    for (let i = 0; i < n; i++) {
      if (this.faceId[i] < 0) continue;
      const vol = volumeAt(i);
      if (vol <= 0) continue;
      const pi = this.press[i];
      if (pi <= 0.05) continue;
      const p = { x: this.fx[i], y: this.fy[i] };
      const col = facesAtFolded(this.index, p, eps); // top first
      const pos = col.indexOf(this.faceId[i]);
      if (pos < 0) continue;
      let rem = vol, blocked = false;
      const from = fromTop ? 0 : pos + 1;
      const to = fromTop ? pos : col.length;
      for (let c = from; c < to && rem > 0; c++) {
        const t = this.texelAt(apply(this.index.Tinv[col[c]], p));
        const pt = this.press[t];
        if (pt <= 0.05) { blocked = true; break; }
        rem -= Math.max(0, pt - before[t]);
      }
      if (blocked || rem <= 0) continue;
      const take = Math.min(rem, Math.max(0, pi - before[i]));
      if (take > 0) {
        this.wet[i] = before[i] + take;
        f[i] += take * conc;
      }
    }
  }

  applyStroke(s: Stroke, _params: SimParams): void {
    if (s.dye < 0 || s.dye >= this.nDyes) return;
    const f = this.f[s.dye];
    const volume = Math.max(0, s.pen);
    if (s.kind === 'dip') {
      this.wickPass(true, s.amount, f, () => volume);
      this.wickPass(false, s.amount, f, () => volume);
      return;
    }
    const r2 = s.r * s.r;
    const volumeAt = (i: number): number => {
      const dx = this.fx[i] - s.p.x, dy = this.fy[i] - s.p.y;
      const d2 = dx * dx + dy * dy;
      return d2 > r2 ? 0 : volume * (1 - d2 / r2);
    };
    this.wickPass(s.side === 'top', s.amount, f, volumeAt);
  }

  /** One explicit Euler step. */
  step(params: SimParams): void {
    const N = this.N, M = this.M, n = N * M;
    const dP = params.dPlane, dZ = params.dZ;
    const dt = stableDt(params);
    const up = this.up, down = this.down, press = this.press, faceId = this.faceId;
    const hsum = this.hsum;
    hsum.fill(0);
    for (let k = 0; k < this.nDyes; k++) {
      const h = this.h[k];
      for (let i = 0; i < n; i++) hsum[i] += h[i];
    }
    for (let k = 0; k < this.nDyes; k++) {
      const f = this.f[k], h = this.h[k], tmp = this.tmp;
      // diffusion
      for (let y = 0; y < M; y++) {
        for (let x = 0; x < N; x++) {
          const i = y * N + x;
          if (faceId[i] < 0) { tmp[i] = 0; continue; }
          const fi = f[i];
          let lap = 0;
          if (x > 0) lap += f[i - 1] - fi;
          if (x < N - 1) lap += f[i + 1] - fi;
          if (y > 0) lap += f[i - N] - fi;
          if (y < M - 1) lap += f[i + N] - fi;
          lap *= dP;
          const u = up[i], d = down[i];
          if (u >= 0) lap += dZ * press[i] * (f[u] - fi);
          if (d >= 0) lap += dZ * press[i] * (f[d] - fi);
          tmp[i] = fi + dt * lap;
        }
      }
      // adsorption (Langmuir-style: rate ∝ free dye × remaining capacity)
      const cap = params.capacity, rate = params.adsorb;
      for (let i = 0; i < n; i++) {
        let fi = tmp[i];
        if (fi <= 0) { f[i] = 0; continue; }
        const room = cap * press[i] - hsum[i];
        if (room > 0) {
          let da = rate * fi * room * dt;
          if (da > fi) da = fi;
          if (da > room) da = room;
          fi -= da;
          h[i] += da;
          hsum[i] += da;
        }
        f[i] = fi;
      }
    }
    this.t++;
  }

  /** Total dye (free + fixed) per texel for one species, used for display. */
  totalAt(k: number, i: number, fixedOnly: boolean): number {
    return this.h[k][i] + (fixedOnly ? 0 : this.f[k][i]);
  }

  /** Distance helper for UI hit tests in folded space. */
  static near(a: Vec2, b: Vec2, r: number): boolean {
    return dist(a, b) <= r;
  }
}

/** Explicit-Euler stability: dt * (4 dPlane + 2 dZ) must stay below 1. */
export function stableDt(params: SimParams): number {
  return Math.min(0.5, 0.95 / (4 * params.dPlane + 2 * params.dZ + 1e-6));
}
