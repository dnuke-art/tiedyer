// Dye simulation on a Bundle.
//
// The cloth is a flat texture of N x M texels. In-plane diffusion is a plain 2D
// Laplacian on that texture (the cloth is continuous across creases). Contact with
// other layers comes from the bundle's weighted contact graph. This is Morimoto &
// Ono's 3D diffusion graph, stored as a 2D texture plus gather maps.
//
//   df/dt = div(D grad f) + supply - adsorption - bleaching
//   dh/dt = adsorption - bleaching          (h = fixed dye, survives rinsing)
//   db/dt = div(D grad b) - consumption - decay   (b = free bleach)
//
// Bleach is a fifth liquid: it wicks and diffuses like dye, and where it meets
// dye (free or fixed) it destroys a fraction rate*b per step of every species,
// spending itself in proportion (STOICH) and going off on its own (decay). A
// cloth colour (plan.base) is a dye fixed uniformly before the first stroke.
//
// Bindings (bands/clamps) produce a press field P in [0,1]: 0 under a clamp, rising
// to 1 at pressRadius away. Press blocks dye supply, reduces capacity, and reduces
// cross-layer transfer (no liquid in a squeezed gap).

import { Bundle, K } from './bundle';
import { BandStamp, Stroke, SimParams, Plan, BLEACH } from './plan';

/** bleach spent per unit of dye destroyed */
export const STOICH = 0.5;
/** when liquid flows through a texel that is already full, this fraction of the
 *  smaller of (held, passing) volume is exchanged with what the texel holds */
export const MIX = 0.5;

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
  /** free bleach */
  bl = new Float32Array(0);
  /** liquid held per texel, in layer-fills (0 .. press); the cloth stays wet between
   *  strokes, so a second squirt on the same spot pushes through instead of piling up */
  wet = new Float32Array(0);
  /** extra dye taken up by a wet texel from later squirts, in layer-fills (0 .. buildup) */
  load = new Float32Array(0);
  /** per-stroke: 0 untouched, 1 touched while not yet full, 2 was already full before this stroke.
   *  After applyStroke, every texel the liquid reached is non-zero (used for the reach readout). */
  touched = new Uint8Array(0);
  /** cloth colour: dye index (-1 = none) and fixed amount per texel */
  base = -1;
  baseFixed = 0;
  private tmpK: Float32Array[] = [];
  private tmpB = new Float32Array(0);
  private hsum = new Float32Array(0);
  private pending = new Float32Array(0);
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
    this.hsum = new Float32Array(n);
    this.wet = new Float32Array(n);
    this.load = new Float32Array(n);
    this.touched = new Uint8Array(n);
    this.pending = new Float32Array(n);
    this.depth = new Int32Array(n);
    this.order = new Int32Array(n);
    this.f = [];
    this.h = [];
    this.tmpK = [];
    for (let k = 0; k < this.nDyes; k++) {
      this.f.push(new Float32Array(n));
      this.h.push(new Float32Array(n));
      this.tmpK.push(new Float32Array(n));
    }
    this.bl = new Float32Array(n);
    this.tmpB = new Float32Array(n);
    this.setBase(plan);
    this.t = 0;
  }

  /** Cloth colour from the plan (applied by resetDye). */
  setBase(plan: Plan): void {
    this.base = plan.base >= 0 && plan.base < this.nDyes ? plan.base : -1;
    this.baseFixed = Math.max(0, Math.min(1, plan.baseAmount)) * plan.params.capacity;
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
    const { px, py, pz } = this.bundle;
    for (let i = 0; i < n; i++) {
      let dmin = Infinity;
      for (const b of bands) {
        let d: number;
        if (b.kind === 'slab') {
          d = Math.abs((px[i] - b.p[0]) * b.n[0] + (py[i] - b.p[1]) * b.n[1] + (pz[i] - b.p[2]) * b.n[2]) - b.w / 2;
        } else {
          d = Math.hypot(px[i] - b.p.x, py[i] - b.p.y) - b.r;
        }
        if (d < dmin) dmin = d;
      }
      const P = Math.min(1, Math.max(0, dmin) / c);
      this.press[i] = floor + (1 - floor) * P;
    }
  }

  /** Back to the undyed (or uniformly pre-dyed) cloth. */
  resetDye(): void {
    for (let k = 0; k < this.nDyes; k++) { this.f[k].fill(0); this.h[k].fill(0); }
    this.bl.fill(0);
    this.wet.fill(0);
    this.load.fill(0);
    if (this.base >= 0 && this.baseFixed > 0) {
      const h = this.h[this.base], valid = this.bundle?.valid;
      for (let i = 0; i < h.length; i++) if (!valid || valid[i]) h[i] = this.baseFixed;
    }
    this.t = 0;
  }

  /**
   * Wicking. Liquid poured onto exposed texels fills their pores and the excess
   * passes along the contact graph to the next layer, a saturation front (see
   * wickFrom for the flood rule). Each texel absorbs `press` worth of liquid (a
   * squeezed layer holds less, a fully pressed one blocks). Liquid arriving at an
   * already-wet texel mixes in. `volumeAt(i)` gives the liquid volume (in
   * layer-fills) poured on entry texel i.
   */
  private wickPass(fromTop: boolean, conc: number, f: Float32Array, volumeAt: (i: number) => number, params: SimParams): void {
    const b = this.bundle, n = b.n;
    const surface = fromTop ? b.surfaceTop : b.surfaceBot;
    const ids: number[] = [], vols: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!b.valid[i] || !surface[i]) continue;
      const v = volumeAt(i);
      if (v > 0) { ids.push(i); vols.push(v); }
    }
    this.wickFrom(ids, vols, conc, f, params);
  }

  /**
   * Layered flow from an explicit entry set: a capacity flood. Every texel holds
   * `press` worth of liquid (a squeezed layer less, a fully pressed one nothing).
   * Liquid poured on a texel fills it; the overflow is split among its neighbours
   * that still have room, by weight, and any of those that fill up pass their own
   * overflow on, in arrival order. Neighbours are the bundle's layer contacts
   * (weight as given) and the four in-plane texel neighbours (weight
   * params.lateral), so liquid poured on an edge wicks inward as well as across.
   * Overflow with nowhere to go drips off. Because liquid can enter a texel from
   * any neighbour with excess, not only from the one that happened to reach it
   * first, the front has no dry seams where the parent set changes (e.g. under the
   * edge of a layer above).
   *
   * The cloth stays wet between strokes (`wet`): a texel that is already full takes
   * no more liquid, so squirting the same spot again pushes the front deeper rather
   * than stacking dye without limit. Liquid passing through a full texel exchanges
   * a share (MIX) with what it holds, so a new colour poured on a wet spot mixes in.
   * A texel that was already full before the stroke began also takes up extra dye
   * from the passing liquid, up to params.buildup layer-fills in total (`load`): going
   * over a spot again and again makes it darker, to a limit, while a single squirt,
   * or one held pour, spends all its liquid on reaching deeper.
   */
  wickFrom(ids: ArrayLike<number>, vols: ArrayLike<number>, conc: number, f: Float32Array, params: SimParams): void {
    const b = this.bundle, N = this.N, M = this.M;
    const wet = this.wet, load = this.load, touched = this.touched, pending = this.pending, queued = this.depth, queue = this.order;
    const lat = params.lateral, buildup = Math.max(0, params.buildup);
    const press = this.press;
    const species = [...this.f, this.bl];
    pending.fill(0);
    queued.fill(0);
    let head = 0, tail = 0;
    // neighbour iteration: layer contacts then grid neighbours
    const nb = new Int32Array(K + 4), nw = new Float32Array(K + 4);
    const neighbours = (i: number): number => {
      let c = 0;
      for (let k = 0; k < K; k++) {
        const j = b.contacts[i * K + k];
        if (j < 0) break;
        nb[c] = j; nw[c] = b.weights[i * K + k]; c++;
      }
      if (lat > 0) {
        const x = i % N, y = (i - x) / N;
        if (x > 0 && b.valid[i - 1]) { nb[c] = i - 1; nw[c] = lat; c++; }
        if (x < N - 1 && b.valid[i + 1]) { nb[c] = i + 1; nw[c] = lat; c++; }
        if (y > 0 && b.valid[i - N]) { nb[c] = i - N; nw[c] = lat; c++; }
        if (y < M - 1 && b.valid[i + N]) { nb[c] = i + N; nw[c] = lat; c++; }
      }
      return c;
    };
    /** pour v onto texel i: absorb what fits, exchange with held liquid, queue the rest as overflow */
    const pour = (i: number, v: number): void => {
      const cap = press[i] <= 0.05 ? 0 : press[i]; // squeezed shut: holds nothing, passes nothing
      if (!touched[i]) touched[i] = cap > 0 && wet[i] >= cap - 1e-6 ? 2 : 1;
      const room = cap - wet[i];
      const a = room > 0 ? Math.min(v, room) : 0;
      if (a > 0) { wet[i] += a; f[i] += a * conc; }
      let excess = v - a;
      if (excess <= 1e-9 || cap <= 0) return;
      // flow-through: part of the held liquid is swapped for the passing liquid
      const w = wet[i];
      if (w > 0 && MIX > 0) {
        const x = Math.min(w, excess) * MIX;
        const keep = 1 - x / w;
        for (const sp of species) sp[i] *= keep;
        f[i] += x * conc;
      }
      // build-up: a spot that was wet before this squirt takes on extra dye, to a limit
      if (touched[i] === 2 && buildup > 0) {
        const extra = Math.min(excess, buildup * cap - load[i]);
        if (extra > 0) { load[i] += extra; f[i] += extra * conc; excess -= extra; }
        if (excess <= 1e-9) return;
      }
      pending[i] += excess;
      if (!queued[i]) { queued[i] = 1; queue[tail++] = i; }
    };
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k];
      if (b.valid[i] && vols[k] > 0) pour(i, vols[k]);
    }
    // a texel is queued only once it is full, so each texel is processed at most once
    while (head < tail) {
      const i = queue[head++];
      const e = pending[i];
      pending[i] = 0;
      if (e <= 0) continue;
      const c = neighbours(i);
      let wsum = 0;
      for (let k = 0; k < c; k++) {
        const j = nb[k];
        if (press[j] > 0.05 && wet[j] < press[j] - 1e-6) wsum += nw[k];
      }
      if (wsum <= 0) continue; // nowhere to go: drips off
      for (let k = 0; k < c; k++) {
        const j = nb[k];
        if (press[j] > 0.05 && wet[j] < press[j] - 1e-6) pour(j, e * nw[k] / wsum);
      }
    }
  }

  /**
   * Apply a stroke. 3D strokes need a visibility oracle (`footprint`) that returns the
   * texels visible looking along s.d at s.p within 2r, with their distances.
   */
  applyStroke(s: Stroke, params: SimParams, footprint?: (p: [number, number, number], d: [number, number, number], radius: number) => { ids: Int32Array; dist: Float32Array }): void {
    if (s.dye >= this.nDyes || (s.dye < 0 && s.dye !== BLEACH)) return;
    this.touched.fill(0); // one stroke = one reach, even when a dip pours from both sides
    const f = s.dye === BLEACH ? this.bl : this.f[s.dye];
    const volume = Math.max(0, s.pen);
    if (s.kind === 'dip') {
      this.wickPass(true, s.amount, f, () => volume, params);
      this.wickPass(false, s.amount, f, () => volume, params);
      return;
    }
    if (s.kind === 'brush3') {
      if (!footprint) return;
      const fp = footprint(s.p, s.d, 2 * s.r);
      const vols = new Float32Array(fp.ids.length);
      const r2 = s.r * s.r;
      for (let k = 0; k < fp.ids.length; k++) vols[k] = volume * Math.exp(-2 * fp.dist[k] * fp.dist[k] / r2);
      this.wickFrom(fp.ids, vols, s.amount, f, params);
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
    this.wickPass(s.side === 'top', s.amount, f, volumeAt, params);
  }

  /** One explicit Euler step (CPU reference; the GPU path does the same). */
  step(params: SimParams): void {
    const N = this.N, M = this.M, n = N * M;
    const dP = params.dPlane, dZ = params.dZ;
    const dt = stableDt(params);
    const b = this.bundle;
    const press = this.press, valid = b.valid, contacts = b.contacts, weights = b.weights;
    const hsum = this.hsum;
    // 1. diffuse every mobile species from the old values (bleach = index nDyes)
    for (let k = 0; k <= this.nDyes; k++) {
      const f = k < this.nDyes ? this.f[k] : this.bl, tmp = k < this.nDyes ? this.tmpK[k] : this.tmpB;
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
          tmp[i] = Math.max(0, fi + dt * lap);
        }
      }
    }
    // 2. bleaching: destroy a fraction of every species where there is free bleach,
    //    spend bleach in proportion, let the rest go off; then tally fixed dye
    const bl = this.bl, tmpB = this.tmpB, bRate = params.bleach, bDecay = params.bleachDecay;
    hsum.fill(0);
    for (let i = 0; i < n; i++) {
      let b = tmpB[i];
      if (b > 0) {
        const e = Math.min(1, bRate * b * dt);
        if (e > 0) {
          let tot = 0;
          for (let k = 0; k < this.nDyes; k++) {
            const tk = this.tmpK[k], hk = this.h[k];
            tot += tk[i] + hk[i];
            tk[i] *= 1 - e;
            hk[i] *= 1 - e;
          }
          b -= STOICH * e * tot;
        }
        b -= bDecay * b * dt;
        if (b < 0) b = 0;
      }
      bl[i] = b;
      for (let k = 0; k < this.nDyes; k++) hsum[i] += this.h[k][i];
    }
    // 3. adsorption (Langmuir-style: rate ∝ free dye × remaining capacity)
    const cap = params.capacity, rate = params.adsorb;
    for (let k = 0; k < this.nDyes; k++) {
      const f = this.f[k], h = this.h[k], tmp = this.tmpK[k];
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
