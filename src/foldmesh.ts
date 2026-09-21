// Exact 3D mesh of a flat-fold bundle, built from the face polygons rather than
// from the texel grid.
//
// The dye solver's bundle places texel i at height depthBot[i] * thickness, where
// depthBot is the number of faces below it at that point of the bundle. So a face
// is not a flat plate: it is a terrain that steps up wherever a face beneath it
// ends. This builder reproduces that exactly. Each face polygon (in bundle space)
// is split by the edge lines of every face below it into convex cells, each cell
// sits at its own height, a skirt of one layer thickness hangs under every cell
// edge whose neighbour across the edge is lower or missing (raw cloth edges, step
// cliffs, creases), and the bottom layer gets a floor. Folds are cuts: the two faces
// that meet at a crease in the flat cloth are two plates at two heights that end on
// the same line, with nothing drawn between them. Each layer's skirt carries that
// layer's own edge texels, so a squirt on the side of a stack enters every layer.
//
// UVs are flat cloth coordinates over (W, H), the same mapping as the texel grid,
// so the dye image is the texture and a fragment's texel id is floor(uv * N).

import { Vec2, apply, clipPolygon, polygonArea, pointInConvexPolygon, bboxContains, sub, normalize } from './geom';
import { Face, indexFaces } from './fold';

export interface Mesh3 {
  /** xyz per vertex, bundle cm */
  pos: Float32Array;
  /** uv per vertex, 0..1 over the flat cloth */
  uv: Float32Array;
  idx: Uint32Array;
  /** the top cells (bundle xy polygon at height z), for overlays that follow the plates */
  cells?: { poly: Vec2[]; z: number }[];
}

const AREA_EPS = 1e-6;
/** offset used to sample "just across" an edge, cm */
const NUDGE = 1e-3;

/** does the line through p along unit d pass through the polygon's interior (vertices on
 *  both sides)? If not, clipping would leave the polygon whole and a zero-area sliver */
function crosses(poly: Vec2[], p: Vec2, d: Vec2): boolean {
  let pos = false, neg = false;
  for (const q of poly) {
    const s = d.x * (q.y - p.y) - d.y * (q.x - p.x);
    if (s > 1e-9) pos = true; else if (s < -1e-9) neg = true;
    if (pos && neg) return true;
  }
  return false;
}

export function foldMesh(faces: Face[], W: number, H: number, thickness: number): Mesh3 {
  const index = indexFaces(faces);
  const P = index.folded;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const cellsOut: { poly: Vec2[]; z: number }[] = [];
  const t = thickness;

  const addVert = (p: Vec2, z: number, flat: Vec2): number => {
    pos.push(p.x, p.y, z);
    uv.push(flat.x / W, flat.y / H);
    return pos.length / 3 - 1;
  };
  const quad = (a: number, b: number, c: number, d: number): void => { idx.push(a, b, c, a, c, d); };

  /** faces strictly below face f whose bundle box overlaps f's */
  const lowerOf = (f: number): number[] => {
    const out: number[] = [];
    const bf = index.foldedBox[f];
    for (let g = 0; g < faces.length; g++) {
      if (faces[g].z >= faces[f].z) continue;
      const bg = index.foldedBox[g];
      if (bg.maxX < bf.minX || bg.minX > bf.maxX || bg.maxY < bf.minY || bg.minY > bf.maxY) continue;
      out.push(g);
    }
    return out;
  };
  // Layers of a folded stack mostly share their outlines (index.outlineOf), so a depth
  // query tests each distinct outline once and adds up how many faces below share it.
  const { outlineOf, outlineRep: outlines } = index;
  /** the faces below f, as distinct outlines with how many faces share each */
  type Lower = { faces: number[]; reps: number[]; counts: number[] };
  const groupLower = (fs: number[]): Lower => {
    const count = new Map<number, number>();
    for (const g of fs) count.set(outlineOf[g], (count.get(outlineOf[g]) || 0) + 1);
    return { faces: fs, reps: [...count.keys()].map((o) => outlines[o]), counts: [...count.values()] };
  };
  /** number of faces in `lower` covering bundle point q */
  const depthAt = (lower: Lower, q: Vec2): number => {
    let n = 0;
    const { reps, counts } = lower;
    for (let i = 0; i < reps.length; i++) {
      const g = reps[i];
      if (bboxContains(index.foldedBox[g], q, 1e-9) && pointInConvexPolygon(P[g], q, 1e-9)) n += counts[i];
    }
    return n;
  };
  const lowerCache = new Map<number, Lower>();
  const lower = (f: number): Lower => {
    let l = lowerCache.get(f);
    if (!l) { l = groupLower(lowerOf(f)); lowerCache.set(f, l); }
    return l;
  };

  for (let f = 0; f < faces.length; f++) {
    const poly = P[f];
    if (poly.length < 3) continue;
    const Tinv = index.Tinv[f];
    const low = lower(f);
    // split the face by every lower face's edge lines. In a folded stack most faces
    // coincide, so their edges fall on a few distinct lines: split once per line, and
    // clip only the cells a line actually crosses.
    let cells: Vec2[][] = [poly];
    const seenLines = new Set<string>();
    for (const g of low.reps) {
      const pg = P[g];
      for (let e = 0; e < pg.length; e++) {
        const a = pg[e], b = pg[(e + 1) % pg.length];
        const d = normalize(sub(b, a));
        if (!isFinite(d.x)) continue;
        // the line, whichever way the edge runs: unit direction with a fixed sign, and offset
        const sg = d.x > 1e-12 || (Math.abs(d.x) <= 1e-12 && d.y > 0) ? 1 : -1;
        const ux = d.x * sg, uy = d.y * sg, off = ux * a.y - uy * a.x;
        const key = `${ux.toFixed(6)},${uy.toFixed(6)},${off.toFixed(5)}`;
        if (seenLines.has(key)) continue;
        seenLines.add(key);
        const next: Vec2[][] = [];
        for (const c of cells) {
          if (!crosses(c, a, d)) { next.push(c); continue; }
          const k = clipPolygon(c, a, d, 1), m = clipPolygon(c, a, d, -1);
          if (k.length >= 3 && Math.abs(polygonArea(k)) > AREA_EPS) next.push(k);
          if (m.length >= 3 && Math.abs(polygonArea(m)) > AREA_EPS) next.push(m);
        }
        cells = next;
      }
    }
    for (const cell of cells) {
      const orient = polygonArea(cell) >= 0 ? 1 : -1;
      const n = cell.length;
      // height of this cell: sample at the centroid
      let cx = 0, cy = 0;
      for (const p of cell) { cx += p.x; cy += p.y; }
      const c = { x: cx / n, y: cy / n };
      const h = depthAt(low, c);
      const z = h * t;
      cellsOut.push({ poly: cell, z });
      // top
      const top: number[] = cell.map((p) => addVert(p, z, apply(Tinv, p)));
      for (let i = 1; i + 1 < n; i++) idx.push(top[0], top[i], top[i + 1]);
      // floor under the bottom layer
      if (h === 0) {
        const bot: number[] = cell.map((p) => addVert(p, -t, apply(Tinv, p)));
        for (let i = 1; i + 1 < n; i++) idx.push(bot[0], bot[i + 1], bot[i]);
      }
      // sides
      for (let e = 0; e < n; e++) {
        const a = cell[e], b = cell[(e + 1) % n];
        const d = sub(b, a);
        const L = Math.hypot(d.x, d.y);
        if (L < 1e-9) continue;
        // outward normal (for a ccw polygon the outward normal of a->b is (dy, -dx))
        const nx = (d.y / L) * orient, ny = (-d.x / L) * orient;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const out = { x: mid.x + nx * NUDGE, y: mid.y + ny * NUDGE };
        const fa = apply(Tinv, a), fb = apply(Tinv, b);
        let across = -1; // height of the same face across this edge, -1 if none
        if (pointInConvexPolygon(poly, out, 1e-9)) across = depthAt(low, out);
        if (across >= h) continue;
        // skirt: this layer's own thickness
        {
          const a0 = addVert(a, z, fa), b0 = addVert(b, z, fb);
          const a1 = addVert(a, z - t, fa), b1 = addVert(b, z - t, fb);
          quad(a0, a1, b1, b0);
        }
      }
    }
  }
  return { pos: Float32Array.from(pos), uv: Float32Array.from(uv), idx: Uint32Array.from(idx), cells: cellsOut };
}
