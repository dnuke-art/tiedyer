// Dye simulation on a Bundle.
//
// The cloth is a flat texture of N x M texels. In-plane diffusion is a plain 2D
// Laplacian on that texture (the cloth is continuous across creases). Contact with
// other layers comes from the bundle's weighted contact graph. This is Morimoto &
// Ono's 3D diffusion graph, stored as a 2D texture plus gather maps.
//
//   df/dt = div(D grad f) + supply - adsorption
//   dh/dt = adsorption          (h = fixed dye, survives rinsing)
//
// Bindings (bands/clamps) produce a press field P in [0,1]: 0 under a clamp, rising
// to 1 at pressRadius away. Press blocks dye supply, reduces capacity, and reduces
// cross-layer transfer (no liquid in a squeezed gap).

import { Bundle, K } from './bundle';
import { BandStamp, Stroke, SimParams, Plan } from './plan';

export class Sim {
  N = 0;
  M = 0;
  cell = 1;
  W = 0;
  H = 0;
  nDyes = 0;

  bundle!: Bundle;
  press = new Float32Array(0);

  /** free (mobile) dye per dye species */
  f: Float32Array[] = [];
  /** adsorbed (fixed) dye per species */
  h: Float32Array[] = [];
  private tmp = new Float32Array(0);
  private hsum = new Float32Array(0);
  private vol = new Float32Array(0);
  private depth = new Int32Array(0);
  private order = new Int32Array(0);

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
    this.press = new Float32Array(n).fill(1);
    this.tmp = new Float32Array(n);
    this.hsum = new Float32Array(n);
    this.vol = new Float32Array(n);
    this.depth = new Int32Array(n);
    this.order = new Int32Array(n);
    this.f = [];
    this.h = [];
    for (let k = 0; k < this.nDyes; k++) {
      this.f.push(new Float32Array(n));
      this.h.push(new Float32Array(n));
    }
    this.t = 0;
  }

  texelCenter(i: number): { x: number; y: number } {
    return { x: ((i % this.N) + 0.5) * this.cell, y: (Math.floor(i / this.N) + 0.5) * this.cell };
  }

  texelAt(uv: { x: number; y: number }): number {
    const x = Math.min(this.N - 1, Math.max(0, Math.floor(uv.x / this.cell)));
    const y = Math.min(this.M - 1, Math.max(0, Math.floor(uv.y / this.cell)));
    return y * this.N + x;
  }

  dims(): { N: number; M: number; cell: number } {
    return { N: this.N, M: this.M, cell: this.cell };
  }

  setBundle(b: Bundle): void {
    this.bundle = b;
  }

  /** Press field from binding stamps (bundle xy coords, all layers under the stamp). */
  rebuildPress(bands: BandStamp[], params: SimParams): void {
    const n = this.N * this.M;
    if (bands.length === 0) { this.press.fill(1); return; }
    const c = Math.max(1e-6, params.pressRadius);
    const floor = params.pressFloor;
    const { px, py } = this.bundle;
    for (let i = 0; i < n; i++) {
      let dmin = Infinity;
      for (const b of bands) {
        const d = Math.hypot(px[i] - b.p.x, py[i] - b.p.y) - b.r;
        if (d < dmin) dmin = d;
      }
      const P = Math.min(1, Math.max(0, dmin) / c);
      this.press[i] = floor + (1 - floor) * P;
    }
  }

  resetDye(): void {
    for (let k = 0; k < this.nDyes; k++) { this.f[k].fill(0); this.h[k].fill(0); }
    this.t = 0;
  }

  /**
   * Wicking. Liquid poured onto exposed texels fills their pores and the excess
   * passes along the contact graph to the next layer, a saturation front. Each
   * texel absorbs `press` worth of liquid (a squeezed layer holds less, a fully
   * pressed one blocks). Excess is split among contacts one hop further from the
   * surface, by contact weight. Liquid arriving at an already-wet texel mixes in.
   * `volumeAt(i)` gives the liquid volume (in layer-fills) poured on entry texel i.
   */
  private wickPass(fromTop: boolean, conc: number, f: Float32Array, volumeAt: (i: number) => number): void {
    const b = this.bundle, n = b.n;
    const surface = fromTop ? b.surfaceTop : b.surfaceBot;
    const vol = this.vol, depth = this.depth, order = this.order;
    vol.fill(0);
    depth.fill(-1);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      if (!b.valid[i] || !surface[i]) continue;
      const v = volumeAt(i);
      if (v <= 0) continue;
      vol[i] = v;
      depth[i] = 0;
      order[tail++] = i;
    }
    // BFS assigns each reachable texel its hop distance from the poured surface
    while (head < tail) {
      const i = order[head++];
      const d = depth[i] + 1;
      for (let k = 0; k < K; k++) {
        const j = b.contacts[i * K + k];
        if (j < 0) break;
        if (depth[j] < 0) { depth[j] = d; order[tail++] = j; }
      }
    }
    // flow in BFS order: absorb, pass the excess one hop deeper
    for (let q = 0; q < tail; q++) {
      const i = order[q];
      const v = vol[i];
      if (v <= 0) continue;
      const pi = this.press[i];
      if (pi <= 0.05) continue; // squeezed shut: absorbs nothing, passes nothing
      const a = Math.min(v, pi);
      f[i] += a * conc;
      const excess = v - a;
      if (excess <= 0) continue;
      let wsum = 0;
      const d = depth[i] + 1;
      for (let k = 0; k < K; k++) {
        const j = b.contacts[i * K + k];
        if (j < 0) break;
        if (depth[j] === d) wsum += b.weights[i * K + k];
      }
      if (wsum <= 0) continue;
      for (let k = 0; k < K; k++) {
        const j = b.contacts[i * K + k];
        if (j < 0) break;
        if (depth[j] === d) vol[j] += excess * b.weights[i * K + k] / wsum;
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
    // Gaussian footprint: full volume at the nozzle, 1/e^2 at the brush radius, and a
    // tail out to 2r standing in for lateral wicking. Deep layers only get the core,
    // shallow layers the tail, so every layer's edge is a gradient, not a step.
    const r2 = s.r * s.r, cut = 4 * r2;
    const { px, py } = this.bundle;
    const volumeAt = (i: number): number => {
      const dx = px[i] - s.p.x, dy = py[i] - s.p.y;
      const d2 = dx * dx + dy * dy;
      return d2 > cut ? 0 : volume * Math.exp(-2 * d2 / r2);
    };
    this.wickPass(s.side === 'top', s.amount, f, volumeAt);
  }

  /** One explicit Euler step (CPU reference; the GPU path does the same). */
  step(params: SimParams): void {
    const N = this.N, M = this.M, n = N * M;
    const dP = params.dPlane, dZ = params.dZ;
    const dt = stableDt(params);
    const b = this.bundle;
    const press = this.press, valid = b.valid, contacts = b.contacts, weights = b.weights;
    const hsum = this.hsum;
    hsum.fill(0);
    for (let k = 0; k < this.nDyes; k++) {
      const h = this.h[k];
      for (let i = 0; i < n; i++) hsum[i] += h[i];
    }
    for (let k = 0; k < this.nDyes; k++) {
      const f = this.f[k], h = this.h[k], tmp = this.tmp;
      for (let y = 0; y < M; y++) {
        for (let x = 0; x < N; x++) {
          const i = y * N + x;
          if (!valid[i]) { tmp[i] = 0; continue; }
          const fi = f[i];
          let lap = 0;
          if (x > 0 && valid[i - 1]) lap += f[i - 1] - fi;
          if (x < N - 1 && valid[i + 1]) lap += f[i + 1] - fi;
          if (y > 0 && valid[i - N]) lap += f[i - N] - fi;
          if (y < M - 1 && valid[i + N]) lap += f[i + N] - fi;
          lap *= dP;
          const pz = dZ * press[i];
          for (let c = 0; c < K; c++) {
            const j = contacts[i * K + c];
            if (j < 0) break;
            lap += pz * weights[i * K + c] * (f[j] - fi);
          }
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
}

/** Explicit-Euler stability: dt * (4 dPlane + 2 dZ) must stay below 1 (contact weights sum to ≤ 2). */
export function stableDt(params: SimParams): number {
  return Math.min(0.5, 0.95 / (4 * params.dPlane + 2 * params.dZ + 1e-6));
}
