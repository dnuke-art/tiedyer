// A Bundle is what the dye solver runs on: every cloth texel has a position in
// bundle space, a set of weighted contacts with texels of OTHER layers that touch
// it, and flags saying whether it is exposed on the top or bottom surface.
// In-plane neighbours are implicit (the texel grid) and are not listed here.
//
// Producers: flatFoldBundle (origami simple folds) and, later, a particle cloth
// for twists and scrunches. The solver, strokes and bindings only see this.

import { Vec2, BBox, apply } from './geom';
import { Face, indexFaces, FaceIndex, faceAtFlat, facesAtFolded, foldedBBox } from './fold';

/** max contacts per texel */
export const K = 8;

export interface Bundle {
  n: number;
  N: number;
  M: number;
  cell: number;
  valid: Uint8Array;
  /** bundle-space position per texel (cm); z increases toward the viewer's "top" */
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  /** n*K texel indices, -1 = none */
  contacts: Int32Array;
  /** n*K weights; each side of a flat stack sums to 1 */
  weights: Float32Array;
  surfaceTop: Uint8Array;
  surfaceBot: Uint8Array;
  /** exposed to the air in any direction (edges of a stack count) */
  exposed: Uint8Array;
  /** texels under a bundle-space point, top first */
  column(p: Vec2): number[];
  bbox(): BBox;
}

export interface GridDims { N: number; M: number; cell: number }

function alloc(d: GridDims): Omit<Bundle, 'column' | 'bbox'> {
  const n = d.N * d.M;
  return {
    n, N: d.N, M: d.M, cell: d.cell,
    valid: new Uint8Array(n),
    px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n),
    contacts: new Int32Array(n * K).fill(-1),
    weights: new Float32Array(n * K),
    surfaceTop: new Uint8Array(n),
    surfaceBot: new Uint8Array(n),
    exposed: new Uint8Array(n),
  };
}

/**
 * Exposure by voxel flood fill. The sheet is rasterized densely (each grid quad
 * sampled SUB x SUB) so air cannot leak through it; then air is flooded from the
 * corner of the bounding box; a texel is exposed where an adjacent voxel is exterior
 * air, and surfaceTop / surfaceBot where the voxel directly above / below is.
 * Voxel size v should be at least the texel spacing in the plane.
 */
export function voxelExposure(b: Omit<Bundle, 'column' | 'bbox'>, v: number, sub = 4): void {
  const { n, N, M, px, py, pz, valid } = b;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    minX = Math.min(minX, px[i]); maxX = Math.max(maxX, px[i]);
    minY = Math.min(minY, py[i]); maxY = Math.max(maxY, py[i]);
    minZ = Math.min(minZ, pz[i]); maxZ = Math.max(maxZ, pz[i]);
  }
  if (!isFinite(minX)) return;
  const ox = minX - 2 * v, oy = minY - 2 * v, oz = minZ - 2 * v;
  const gx = Math.ceil((maxX - ox) / v) + 3, gy = Math.ceil((maxY - oy) / v) + 3, gz = Math.ceil((maxZ - oz) / v) + 3;
  const occ = new Uint8Array(gx * gy * gz); // 0 unknown air, 1 cloth, 2 exterior air
  const vi = (cx: number, cy: number, cz: number) => (cz * gy + cy) * gx + cx;
  const mark = (x: number, y: number, z: number) => {
    const cx = Math.floor((x - ox) / v), cy = Math.floor((y - oy) / v), cz = Math.floor((z - oz) / v);
    if (cx >= 0 && cy >= 0 && cz >= 0 && cx < gx && cy < gy && cz < gz) occ[vi(cx, cy, cz)] = 1;
  };
  for (let j = 0; j < M - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, bq = a + 1, c = a + N, d = c + 1;
    if (!valid[a] || !valid[bq] || !valid[c] || !valid[d]) continue;
    // skip quads that straddle a fold: their corners are far apart in the bundle
    const span = Math.max(Math.abs(px[a] - px[d]), Math.abs(py[a] - py[d]), Math.abs(px[bq] - px[c]), Math.abs(py[bq] - py[c]));
    if (span > 4 * b.cell) continue;
    for (let u = 0; u <= sub; u++) for (let t = 0; t <= sub; t++) {
      const fu = u / sub, ft = t / sub;
      const w00 = (1 - fu) * (1 - ft), w10 = fu * (1 - ft), w01 = (1 - fu) * ft, w11 = fu * ft;
      mark(
        px[a] * w00 + px[bq] * w10 + px[c] * w01 + px[d] * w11,
        py[a] * w00 + py[bq] * w10 + py[c] * w01 + py[d] * w11,
        pz[a] * w00 + pz[bq] * w10 + pz[c] * w01 + pz[d] * w11,
      );
    }
  }
  for (let i = 0; i < n; i++) if (valid[i]) mark(px[i], py[i], pz[i]);
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
  const airAt = (cx: number, cy: number, cz: number) =>
    cx < 0 || cy < 0 || cz < 0 || cx >= gx || cy >= gy || cz >= gz || occ[vi(cx, cy, cz)] === 2;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const cx = Math.floor((px[i] - ox) / v), cy = Math.floor((py[i] - oy) / v), cz = Math.floor((pz[i] - oz) / v);
    const top = airAt(cx, cy, cz + 1), bot = airAt(cx, cy, cz - 1);
    b.surfaceTop[i] = top ? 1 : 0;
    b.surfaceBot[i] = bot ? 1 : 0;
    b.exposed[i] = top || bot || airAt(cx - 1, cy, cz) || airAt(cx + 1, cy, cz) || airAt(cx, cy - 1, cz) || airAt(cx, cy + 1, cz) ? 1 : 0;
  }
}

/**
 * Add up to 4 bilinear contacts from texel i to the texels around continuous
 * flat position uv (cm) in the layer that lies at that position, starting at
 * slot `slot`. Returns the next free slot.
 */
function addBilinear(b: Omit<Bundle, 'column' | 'bbox'>, i: number, uv: Vec2, slot: number): number {
  const u = uv.x / b.cell - 0.5, v = uv.y / b.cell - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  const cand: [number, number, number][] = [
    [x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)],
    [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy],
  ];
  let wsum = 0;
  const kept: [number, number][] = [];
  for (const [x, y, w] of cand) {
    if (w <= 1e-4 || x < 0 || y < 0 || x >= b.N || y >= b.M) continue;
    const j = y * b.N + x;
    if (j === i) continue;
    kept.push([j, w]);
    wsum += w;
  }
  for (const [j, w] of kept) {
    if (slot >= K) break;
    b.contacts[i * K + slot] = j;
    b.weights[i * K + slot] = w / wsum;
    slot++;
  }
  return slot;
}

export interface FlatFoldBundle extends Bundle {
  faces: Face[];
  index: FaceIndex;
  faceId: Int32Array;
  depthTop: Int32Array;
  depthBot: Int32Array;
  maxLayers: number;
}

/** Bundle from an origami face set. Layer thickness sets pz spacing (cm). */
export function flatFoldBundle(d: GridDims, faces: Face[], thickness = 0.1): FlatFoldBundle {
  const b = alloc(d);
  const index = indexFaces(faces);
  const faceId = new Int32Array(b.n).fill(-1);
  const depthTop = new Int32Array(b.n);
  const depthBot = new Int32Array(b.n);
  const eps = d.cell * 1e-3;
  let maxLayers = 0;
  for (let i = 0; i < b.n; i++) {
    const uv = { x: ((i % d.N) + 0.5) * d.cell, y: (Math.floor(i / d.N) + 0.5) * d.cell };
    const fi = faceAtFlat(index, uv, eps);
    faceId[i] = fi;
    if (fi < 0) { b.px[i] = uv.x; b.py[i] = uv.y; continue; }
    b.valid[i] = 1;
    const p = apply(faces[fi].T, uv);
    b.px[i] = p.x; b.py[i] = p.y;
    const column = facesAtFolded(index, p, eps); // top first
    let pos = column.indexOf(fi);
    if (pos < 0) { column.push(fi); pos = column.length - 1; }
    depthTop[i] = pos;
    depthBot[i] = column.length - 1 - pos;
    b.pz[i] = depthBot[i] * thickness;
    if (column.length > maxLayers) maxLayers = column.length;
    b.surfaceTop[i] = pos === 0 ? 1 : 0;
    b.surfaceBot[i] = pos === column.length - 1 ? 1 : 0;
    let slot = 0;
    if (pos > 0) slot = addBilinear(b, i, apply(index.Tinv[column[pos - 1]], p), slot);
    if (pos < column.length - 1) addBilinear(b, i, apply(index.Tinv[column[pos + 1]], p), slot);
  }
  // all-direction exposure (stack edges) from voxels; top/bottom flags stay analytic
  const top = b.surfaceTop.slice(), bot = b.surfaceBot.slice();
  voxelExposure(b, Math.max(d.cell, thickness), 3);
  b.surfaceTop.set(top);
  b.surfaceBot.set(bot);
  for (let i = 0; i < b.n; i++) if (top[i] || bot[i]) b.exposed[i] = 1;
  return {
    ...b,
    faces, index, faceId, depthTop, depthBot, maxLayers,
    column(p: Vec2): number[] {
      const col = facesAtFolded(index, p, eps);
      const out: number[] = [];
      for (const fi of col) {
        const uv = apply(index.Tinv[fi], p);
        const x = Math.min(d.N - 1, Math.max(0, Math.floor(uv.x / d.cell)));
        const y = Math.min(d.M - 1, Math.max(0, Math.floor(uv.y / d.cell)));
        out.push(y * d.N + x);
      }
      return out;
    },
    bbox(): BBox { return foldedBBox(faces); },
  };
}
