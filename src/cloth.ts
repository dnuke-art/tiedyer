// Particle cloth for bundles that are not flat folds: twists, scrunches.
//
// Position-based dynamics on a grid of particles lying on a table (z >= 0).
// Distance constraints for structure, shear and bending; particle-particle
// self-collision through a spatial hash; table friction. Operations drive a
// subset of particles kinematically (a pinch that rotates) or add constraints
// (a ceiling that flattens the bundle).
//
// After the operation, the cloth becomes a Bundle: particle positions, weighted
// contacts with particles of other layers within reach, and surface flags from a
// voxel flood-fill of the air around the bundle.

import { Vec2, BBox } from './geom';
import { Bundle, K, GridDims } from './bundle';

export interface TwistParams {
  /** pinch centre in cloth coordinates (cm) */
  c: Vec2;
  turns: number;
  /** pinch radius (cm) */
  pinch: number;
  /** table friction per substep, 0..1 */
  friction: number;
  /** final bundle thickness after patting down (cm), 0 = don't flatten */
  flatten: number;
}

export const DEFAULT_TWIST: TwistParams = { c: { x: 30, y: 30 }, turns: 3, pinch: 1.5, friction: 0.03, flatten: 2.5 };

const GRAVITY = 300; // cm/s^2, scaled: the sim is quasi-static
const SUBSTEPS = 6;
const ITER = 2;
const DT = 1 / 60;

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The part of a cloth needed to draw and pick it. */
export interface ClothView {
  N: number;
  M: number;
  n: number;
  h: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
}

export class Cloth implements ClothView {
  N: number;
  M: number;
  n: number;
  h: number;
  /** collision distance between non-neighbouring particles (cloth thickness) */
  dc: number;
  x: Float32Array; y: Float32Array; z: Float32Array;
  px: Float32Array; py: Float32Array; pz: Float32Array;
  w: Float32Array;
  private cA: Int32Array; private cB: Int32Array; private cRest: Float32Array; private cStiff: Float32Array;
  /** optional ceiling plane */
  ceiling = Infinity;
  /** hash for collisions and contact queries: bucket heads + per-particle next links */
  private cellSize: number;
  private static readonly HASH_SIZE = 1 << 18;
  private head = new Int32Array(Cloth.HASH_SIZE).fill(-1);
  private next: Int32Array;

  constructor(W: number, H: number, N: number, seed = 1) {
    const rnd = mulberry32(seed);
    this.N = N;
    this.h = W / N;
    this.M = Math.max(2, Math.round(H / this.h));
    this.n = N * this.M;
    this.dc = 0.3 * this.h;
    this.cellSize = this.dc;
    const n = this.n;
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
    this.w = new Float32Array(n).fill(1);
    for (let j = 0; j < this.M; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      this.x[k] = (i + 0.5) * this.h;
      this.y[k] = (j + 0.5) * this.h;
      this.z[k] = 0.02 * this.h * (rnd() - 0.5) + 0.02 * this.h;
    }
    this.px = this.x.slice(); this.py = this.y.slice(); this.pz = this.z.slice();
    this.next = new Int32Array(n).fill(-1);
    // constraints
    const A: number[] = [], B: number[] = [], R: number[] = [], S: number[] = [];
    const add = (a: number, b: number, rest: number, s: number) => { A.push(a); B.push(b); R.push(rest); S.push(s); };
    const h = this.h;
    for (let j = 0; j < this.M; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (i + 1 < N) add(k, k + 1, h, 1);
      if (j + 1 < this.M) add(k, k + N, h, 1);
      if (i + 1 < N && j + 1 < this.M) { add(k, k + N + 1, h * Math.SQRT2, 0.8); add(k + 1, k + N, h * Math.SQRT2, 0.8); }
      if (i + 2 < N) add(k, k + 2, 2 * h, 0.15);
      if (j + 2 < this.M) add(k, k + 2 * N, 2 * h, 0.15);
    }
    this.cA = Int32Array.from(A); this.cB = Int32Array.from(B);
    this.cRest = Float32Array.from(R); this.cStiff = Float32Array.from(S);
  }

  private key(cx: number, cy: number, cz: number): number {
    return (((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) >>> 0) & (Cloth.HASH_SIZE - 1);
  }

  private buildHash(): void {
    this.head.fill(-1);
    const s = this.cellSize;
    for (let i = 0; i < this.n; i++) {
      const k = this.key(Math.floor(this.x[i] / s), Math.floor(this.y[i] / s), Math.floor(this.z[i] / s));
      this.next[i] = this.head[k];
      this.head[k] = i;
    }
  }

  /** particle indices within radius r of (x,y,z), using the last built hash */
  private near(x: number, y: number, z: number, r: number, out: number[]): void {
    out.length = 0;
    const s = this.cellSize;
    const cx0 = Math.floor((x - r) / s), cx1 = Math.floor((x + r) / s);
    const cy0 = Math.floor((y - r) / s), cy1 = Math.floor((y + r) / s);
    const cz0 = Math.floor((z - r) / s), cz1 = Math.floor((z + r) / s);
    const r2 = r * r;
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) for (let cz = cz0; cz <= cz1; cz++) {
      for (let j = this.head[this.key(cx, cy, cz)]; j >= 0; j = this.next[j]) {
        const dx = this.x[j] - x, dy = this.y[j] - y, dz = this.z[j] - z;
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(j);
      }
    }
  }

  /** grid (Chebyshev) distance between two particles */
  gridDist(i: number, j: number): number {
    return Math.max(Math.abs((i % this.N) - (j % this.N)), Math.abs(Math.floor(i / this.N) - Math.floor(j / this.N)));
  }

  /** One frame: SUBSTEPS of Verlet + constraint projection. `drive` sets kinematic particles. */
  step(friction: number, drive?: (t: number) => void, tFrame = 0): void {
    const dt = DT / SUBSTEPS;
    const n = this.n;
    const tmp: number[] = [];
    for (let s = 0; s < SUBSTEPS; s++) {
      // integrate
      for (let i = 0; i < n; i++) {
        if (this.w[i] === 0) continue;
        const vx = (this.x[i] - this.px[i]) * 0.985, vy = (this.y[i] - this.py[i]) * 0.985, vz = (this.z[i] - this.pz[i]) * 0.985;
        this.px[i] = this.x[i]; this.py[i] = this.y[i]; this.pz[i] = this.z[i];
        this.x[i] += vx; this.y[i] += vy; this.z[i] += vz - GRAVITY * dt * dt;
      }
      if (drive) drive(tFrame + (s + 1) / SUBSTEPS);
      // constraints
      for (let it = 0; it < ITER; it++) {
        this.projectDistances();
        this.buildHash();
        this.projectCollisions(tmp);
        this.projectBounds();
      }
      this.applyFriction(friction);
    }
  }

  /** free particles within r of any particle in `set` (uses the last built hash) */
  neighboursOf(set: number[], r: number): number[] {
    const found = new Set<number>();
    const tmp: number[] = [];
    for (const i of set) {
      this.near(this.x[i], this.y[i], this.z[i], r, tmp);
      for (const j of tmp) if (this.w[j] > 0) found.add(j);
    }
    return [...found];
  }

  private projectDistances(): void {
    const { cA, cB, cRest, cStiff, x, y, z, w } = this;
    for (let c = 0; c < cA.length; c++) {
      const a = cA[c], b = cB[c];
      const wa = w[a], wb = w[b], ws = wa + wb;
      if (ws === 0) continue;
      const dx = x[b] - x[a], dy = y[b] - y[a], dz = z[b] - z[a];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-9) continue;
      const corr = cStiff[c] * (d - cRest[c]) / d / ws;
      x[a] += dx * corr * wa; y[a] += dy * corr * wa; z[a] += dz * corr * wa;
      x[b] -= dx * corr * wb; y[b] -= dy * corr * wb; z[b] -= dz * corr * wb;
    }
  }

  private projectCollisions(tmp: number[]): void {
    const { x, y, z, w, dc } = this;
    for (let i = 0; i < this.n; i++) {
      this.near(x[i], y[i], z[i], dc, tmp);
      for (const j of tmp) {
        if (j <= i) continue;
        if (this.gridDist(i, j) <= 1) continue;
        const wa = w[i], wb = w[j], ws = wa + wb;
        if (ws === 0) continue;
        let dx = x[j] - x[i], dy = y[j] - y[i], dz = z[j] - z[i];
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) { dz = 1e-3; d = 1e-3; }
        const corr = (d - dc) / d / ws;
        x[i] += dx * corr * wa; y[i] += dy * corr * wa; z[i] += dz * corr * wa;
        x[j] -= dx * corr * wb; y[j] -= dy * corr * wb; z[j] -= dz * corr * wb;
      }
    }
  }

  private projectBounds(): void {
    const { z, w } = this;
    for (let i = 0; i < this.n; i++) {
      if (w[i] === 0) continue;
      if (z[i] < 0) z[i] = 0;
      if (z[i] > this.ceiling) z[i] = this.ceiling;
    }
  }

  /** table friction: bleed off sliding of particles resting on the table */
  private applyFriction(friction: number): void {
    const { x, y, z, px, py, w } = this;
    const eps = 0.5 * this.dc;
    for (let i = 0; i < this.n; i++) {
      if (w[i] === 0 || z[i] >= eps) continue;
      x[i] = px[i] + (x[i] - px[i]) * (1 - friction);
      y[i] = py[i] + (y[i] - py[i]) * (1 - friction);
    }
  }

  /** Bundle extraction: contacts with other layers and exposure via voxel flood fill. */
  toBundle(d: GridDims): ClothBundle {
    const n = this.n;
    const b: Omit<Bundle, 'column' | 'bbox'> = {
      n, N: d.N, M: d.M, cell: d.cell,
      valid: new Uint8Array(n).fill(1),
      px: this.x.slice(), py: this.y.slice(), pz: this.z.slice(),
      contacts: new Int32Array(n * K).fill(-1),
      weights: new Float32Array(n * K),
      surfaceTop: new Uint8Array(n),
      surfaceBot: new Uint8Array(n),
    };
    // contacts: particles of other layers within reach
    const reach = 1.8 * this.dc;
    this.cellSize = reach;
    this.buildHash();
    const tmp: number[] = [];
    const cand: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      this.near(this.x[i], this.y[i], this.z[i], reach, tmp);
      cand.length = 0;
      for (const j of tmp) {
        if (j === i || this.gridDist(i, j) <= 2) continue;
        const dd = Math.hypot(this.x[j] - this.x[i], this.y[j] - this.y[i], this.z[j] - this.z[i]);
        cand.push([j, Math.max(0, 1 - dd / reach)]);
      }
      cand.sort((a, c) => c[1] - a[1]);
      let wsum = 0;
      for (let k = 0; k < Math.min(K, cand.length); k++) wsum += cand[k][1];
      const scale = wsum > 2 ? 2 / wsum : 1;
      for (let k = 0; k < Math.min(K, cand.length); k++) {
        b.contacts[i * K + k] = cand[k][0];
        b.weights[i * K + k] = cand[k][1] * scale;
      }
    }
    this.cellSize = this.dc;
    // exposure: voxelize the sheet (sampling each quad densely so air cannot leak
    // through it), flood exterior air, then look above / below each particle
    const v = 0.5 * this.h;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.x[i]); maxX = Math.max(maxX, this.x[i]);
      minY = Math.min(minY, this.y[i]); maxY = Math.max(maxY, this.y[i]);
      minZ = Math.min(minZ, this.z[i]); maxZ = Math.max(maxZ, this.z[i]);
    }
    const ox = minX - 2 * v, oy = minY - 2 * v, oz = minZ - 2 * v;
    const gx = Math.ceil((maxX - ox) / v) + 3, gy = Math.ceil((maxY - oy) / v) + 3, gz = Math.ceil((maxZ - oz) / v) + 3;
    const occ = new Uint8Array(gx * gy * gz); // 0 unknown air, 1 cloth, 2 exterior air
    const vi = (cx: number, cy: number, cz: number) => (cz * gy + cy) * gx + cx;
    const cellOf = (i: number): [number, number, number] => [Math.floor((this.x[i] - ox) / v), Math.floor((this.y[i] - oy) / v), Math.floor((this.z[i] - oz) / v)];
    const mark = (x: number, y: number, z: number) => {
      const cx = Math.floor((x - ox) / v), cy = Math.floor((y - oy) / v), cz = Math.floor((z - oz) / v);
      if (cx >= 0 && cy >= 0 && cz >= 0 && cx < gx && cy < gy && cz < gz) occ[vi(cx, cy, cz)] = 1;
    };
    const SUB = 4;
    for (let j = 0; j < this.M - 1; j++) for (let i = 0; i < this.N - 1; i++) {
      const a = j * this.N + i, bq = a + 1, c = a + this.N, dq = c + 1;
      for (let u = 0; u <= SUB; u++) for (let t = 0; t <= SUB; t++) {
        const fu = u / SUB, ft = t / SUB;
        const w00 = (1 - fu) * (1 - ft), w10 = fu * (1 - ft), w01 = (1 - fu) * ft, w11 = fu * ft;
        mark(
          this.x[a] * w00 + this.x[bq] * w10 + this.x[c] * w01 + this.x[dq] * w11,
          this.y[a] * w00 + this.y[bq] * w10 + this.y[c] * w01 + this.y[dq] * w11,
          this.z[a] * w00 + this.z[bq] * w10 + this.z[c] * w01 + this.z[dq] * w11,
        );
      }
    }
    // flood from the corner
    const stack: number[] = [vi(0, 0, 0)];
    occ[stack[0]] = 2;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % gx, cy = Math.floor(c / gx) % gy, cz = Math.floor(c / (gx * gy));
      const nb = [[cx - 1, cy, cz], [cx + 1, cy, cz], [cx, cy - 1, cz], [cx, cy + 1, cz], [cx, cy, cz - 1], [cx, cy, cz + 1]];
      for (const [ax, ay, az] of nb) {
        if (ax < 0 || ay < 0 || az < 0 || ax >= gx || ay >= gy || az >= gz) continue;
        const k = vi(ax, ay, az);
        if (occ[k] === 0) { occ[k] = 2; stack.push(k); }
      }
    }
    const airAt = (cx: number, cy: number, cz: number) => cz < 0 || cz >= gz || occ[vi(cx, cy, cz)] === 2;
    for (let i = 0; i < n; i++) {
      const [cx, cy, cz] = cellOf(i);
      b.surfaceTop[i] = airAt(cx, cy, cz + 1) ? 1 : 0;
      b.surfaceBot[i] = airAt(cx, cy, cz - 1) ? 1 : 0;
    }
    return makeClothBundle({ N: this.N, M: this.M, n, h: this.h, x: this.x.slice(), y: this.y.slice(), z: this.z.slice() }, b);
  }
}

export interface ClothBundle extends Bundle {
  cloth: ClothView;
}

/** Assemble a ClothBundle from plain arrays (also used on the worker boundary). */
export function makeClothBundle(view: ClothView, b: Omit<Bundle, 'column' | 'bbox'>): ClothBundle {
  const n = view.n, hx = view.h;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, view.x[i]); maxX = Math.max(maxX, view.x[i]);
    minY = Math.min(minY, view.y[i]); maxY = Math.max(maxY, view.y[i]);
  }
  return {
    ...b,
    cloth: view,
    column(p: Vec2): number[] {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        if (Math.hypot(view.x[i] - p.x, view.y[i] - p.y) <= 0.55 * hx) out.push(i);
      }
      out.sort((a, c) => view.z[c] - view.z[a]);
      return out;
    },
    bbox(): BBox { return { minX, minY, maxX, maxY }; },
  };
}

export type Progress = (phase: string, frac: number, cloth: ClothView) => void;

/** Pinch the centre, lift it, twist for `turns`, release, pat flat. Async so the UI can draw progress. */
export async function runTwist(W: number, H: number, N: number, tp: TwistParams, onProgress: Progress, dims: GridDims): Promise<ClothBundle> {
  const cloth = new Cloth(W, H, N, 7);
  const n = cloth.n;
  // The core: what the twisting hand holds. Starts as the pinched disc; any fabric
  // that wraps onto it sticks and turns with it, so the core grows as it winds.
  // Each core particle keeps its offset in the core's rotating frame.
  const pinched: number[] = [];
  const off: [number, number, number][] = [];
  const liftFrames = 30, framesPerTurn = 90, settleFrames = 40, flattenFrames = 90;
  const twistFrames = Math.round(tp.turns * framesPerTurn);
  const lift = 2.5 * cloth.dc + 1.0;
  const total = liftFrames + twistFrames + settleFrames + (tp.flatten > 0 ? flattenFrames : 0) + settleFrames;
  let frame = 0;
  let ang = 0;
  for (let i = 0; i < n; i++) {
    const dx = cloth.x[i] - tp.c.x, dy = cloth.y[i] - tp.c.y;
    const r = Math.hypot(dx, dy);
    if (r <= tp.pinch) {
      pinched.push(i);
      off.push([dx, dy, lift * (1 - r / (tp.pinch + 1e-6)) + 0.5 * cloth.dc]);
      cloth.w[i] = 0;
    }
  }
  const attach = (i: number) => {
    // offset in the core frame at the current angle
    const dx = cloth.x[i] - tp.c.x, dy = cloth.y[i] - tp.c.y;
    const ca = Math.cos(-ang), sa = Math.sin(-ang);
    pinched.push(i);
    off.push([dx * ca - dy * sa, dx * sa + dy * ca, Math.max(cloth.z[i], 0.5 * cloth.dc)]);
    cloth.w[i] = 0;
  };
  const drive = (t: number) => {
    const l = Math.min(1, t / liftFrames);
    ang = Math.max(0, t - liftFrames) / framesPerTurn * 2 * Math.PI;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let k = 0; k < pinched.length; k++) {
      const i = pinched[k];
      const [dx, dy, dz] = off[k];
      cloth.x[i] = tp.c.x + dx * ca - dy * sa;
      cloth.y[i] = tp.c.y + dx * sa + dy * ca;
      cloth.z[i] = k < initialCore ? dz * l : dz;
      cloth.px[i] = cloth.x[i]; cloth.py[i] = cloth.y[i]; cloth.pz[i] = cloth.z[i];
    }
  };
  const initialCore = pinched.length;
  // yield to the event loop without setTimeout (throttled in background tabs)
  const channel = new MessageChannel();
  const yieldUI = () => new Promise<void>((r) => { channel.port1.onmessage = () => r(); channel.port2.postMessage(0); });
  // lift + twist
  for (; frame < liftFrames + twistFrames; frame++) {
    cloth.step(tp.friction, drive, frame);
    if (frame >= liftFrames) {
      // fabric that touches the core wraps onto it
      for (const j of cloth.neighboursOf(pinched, 1.3 * cloth.dc)) attach(j);
    }
    if (frame % 4 === 0) { onProgress(frame < liftFrames ? 'pinch' : 'twist', frame / total, cloth); await yieldUI(); }
  }
  // release the pinch, settle
  for (const i of pinched) cloth.w[i] = 1;
  for (let k = 0; k < settleFrames; k++, frame++) {
    cloth.step(tp.friction, undefined, frame);
    if (frame % 4 === 0) { onProgress('settle', frame / total, cloth); await yieldUI(); }
  }
  // pat flat: lower a ceiling to the requested thickness
  if (tp.flatten > 0) {
    let zmax = 0;
    for (let i = 0; i < n; i++) zmax = Math.max(zmax, cloth.z[i]);
    const target = Math.max(tp.flatten, 2 * cloth.dc);
    for (let k = 0; k < flattenFrames; k++, frame++) {
      cloth.ceiling = zmax + (target - zmax) * Math.min(1, k / (flattenFrames * 0.7));
      cloth.step(tp.friction, undefined, frame);
      if (frame % 4 === 0) { onProgress('flatten', frame / total, cloth); await yieldUI(); }
    }
    for (let k = 0; k < settleFrames; k++, frame++) {
      cloth.step(tp.friction, undefined, frame);
      if (frame % 4 === 0) { onProgress('settle', frame / total, cloth); await yieldUI(); }
    }
  }
  onProgress('contacts', 1, cloth);
  await yieldUI();
  return cloth.toBundle(dims);
}
