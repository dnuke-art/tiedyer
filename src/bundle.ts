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
  };
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

/** Bundle from an origami face set. Layer thickness only affects pz. */
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
