// Simple-fold origami engine.
//
// The cloth is a set of convex faces. Each face stores its polygon in FLAT (unfolded)
// cloth coordinates, a rigid transform T that maps flat -> folded coordinates, and a
// layer index z (higher = closer to the viewer / top of the stack).
//
// A simple fold is a line in FOLDED coordinates plus which side moves. Every face is
// clipped by the line; the moving part gets T' = Reflect(line) ∘ T and is placed above
// (or below) the whole existing stack with its internal order reversed. Because every
// tie-dye fold is a simple fold through all layers, the layer order is exact and free.

import {
  Vec2, Mat, IDENTITY, apply, mul, invert, reflection, clipPolygon, polygonArea,
  pointInConvexPolygon, bbox, BBox, bboxContains, det, normalize,
} from './geom';

export interface Face {
  /** polygon in flat cloth coordinates (cm) */
  flat: Vec2[];
  /** flat -> folded */
  T: Mat;
  /** layer index, 0 = bottom */
  z: number;
}

export interface FoldLine {
  /** a point on the fold line, folded coords */
  p: Vec2;
  /** direction of the fold line */
  d: Vec2;
  /** which side moves: sign of side(p, d, q) for moving points */
  moveSign: 1 | -1;
  /** fold the moving part underneath the stack instead of on top */
  under?: boolean;
  /** human label (preset name) */
  label?: string;
}

const AREA_EPS = 1e-6;

export function initialFaces(W: number, H: number): Face[] {
  return [{
    flat: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }],
    T: { ...IDENTITY },
    z: 0,
  }];
}

export function foldedPolygon(face: Face): Vec2[] {
  return face.flat.map((q) => apply(face.T, q));
}

/** true if the back of the cloth faces the viewer for this face */
export function isBack(face: Face): boolean {
  return det(face.T) < 0;
}

export function applyFold(faces: Face[], fold: FoldLine): Face[] {
  if (faces.length === 0) return faces;
  let zmin = Infinity, zmax = -Infinity;
  for (const f of faces) { zmin = Math.min(zmin, f.z); zmax = Math.max(zmax, f.z); }
  const R = reflection(fold.p, fold.d);
  const out: Face[] = [];
  for (const face of faces) {
    const fp = foldedPolygon(face);
    const keep = clipPolygon(fp, fold.p, fold.d, (-fold.moveSign) as 1 | -1);
    const move = clipPolygon(fp, fold.p, fold.d, fold.moveSign);
    const Tinv = invert(face.T);
    if (keep.length >= 3 && Math.abs(polygonArea(keep)) > AREA_EPS) {
      out.push({ flat: keep.map((q) => apply(Tinv, q)), T: face.T, z: face.z });
    }
    if (move.length >= 3 && Math.abs(polygonArea(move)) > AREA_EPS) {
      out.push({
        flat: move.map((q) => apply(Tinv, q)),
        T: mul(R, face.T),
        z: fold.under ? 2 * zmin - 1 - face.z : 2 * zmax + 1 - face.z,
      });
    }
  }
  return renormalizeZ(out);
}

/** Compress z values to consecutive integers 0..k-1 preserving order. */
export function renormalizeZ(faces: Face[]): Face[] {
  const zs = Array.from(new Set(faces.map((f) => f.z))).sort((a, b) => a - b);
  const rank = new Map<number, number>();
  zs.forEach((z, i) => rank.set(z, i));
  for (const f of faces) f.z = rank.get(f.z)!;
  return faces;
}

export function buildFaces(W: number, H: number, folds: FoldLine[]): Face[] {
  let faces = initialFaces(W, H);
  for (const fold of folds) faces = applyFold(faces, fold);
  return faces;
}

export function foldedBBox(faces: Face[]): BBox {
  const pts: Vec2[] = [];
  for (const f of faces) pts.push(...foldedPolygon(f));
  return bbox(pts);
}

/** Cached per-face data for fast point queries. */
export interface FaceIndex {
  faces: Face[];
  folded: Vec2[][];
  foldedBox: BBox[];
  flatBox: BBox[];
  Tinv: Mat[];
  /** faces sorted top-first */
  byZDesc: number[];
}

export function indexFaces(faces: Face[]): FaceIndex {
  const folded = faces.map(foldedPolygon);
  return {
    faces,
    folded,
    foldedBox: folded.map(bbox),
    flatBox: faces.map((f) => bbox(f.flat)),
    Tinv: faces.map((f) => invert(f.T)),
    byZDesc: faces.map((_, i) => i).sort((a, b) => faces[b].z - faces[a].z),
  };
}

/** Face containing a flat point, or -1. */
export function faceAtFlat(idx: FaceIndex, uv: Vec2, eps = 1e-7): number {
  for (let i = 0; i < idx.faces.length; i++) {
    if (bboxContains(idx.flatBox[i], uv, eps) && pointInConvexPolygon(idx.faces[i].flat, uv, eps)) return i;
  }
  return -1;
}

/** All faces covering a folded point, top first. */
export function facesAtFolded(idx: FaceIndex, q: Vec2, eps = 1e-7): number[] {
  const out: number[] = [];
  for (const i of idx.byZDesc) {
    if (bboxContains(idx.foldedBox[i], q, eps) && pointInConvexPolygon(idx.folded[i], q, eps)) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presets. Each preset takes the current faces and returns the fold lines to
// append; the caller applies them one by one (each line is expressed in the
// folded coordinates that exist when it is applied, which for these presets are
// the same as the current ones because the moving part always lands on the
// not-yet-folded side).

export type Axis = 'x' | 'y';

/** Line direction for a crease perpendicular to `axis`. */
function creaseDir(axis: Axis): Vec2 {
  return axis === 'x' ? { x: 0, y: 1 } : { x: 1, y: 0 };
}

/** Sign so that the side with SMALLER `axis` coordinate moves. */
function behindSign(p: Vec2, d: Vec2, axis: Axis): 1 | -1 {
  const behind = axis === 'x' ? { x: p.x - 1, y: p.y } : { x: p.x, y: p.y - 1 };
  const s = d.x * (behind.y - p.y) - d.y * (behind.x - p.x);
  return s >= 0 ? 1 : -1;
}

/** Accordion (fan) fold: n pleats across the current folded extent along `axis`. */
export function accordionFolds(faces: Face[], axis: Axis, n: number, alternate = false): FoldLine[] {
  const b = foldedBBox(faces);
  const lo = axis === 'x' ? b.minX : b.minY;
  const hi = axis === 'x' ? b.maxX : b.maxY;
  const other = axis === 'x' ? (b.minY + b.maxY) / 2 : (b.minX + b.maxX) / 2;
  const w = (hi - lo) / n;
  const d = creaseDir(axis);
  const out: FoldLine[] = [];
  for (let k = 1; k < n; k++) {
    const c = lo + k * w;
    const p = axis === 'x' ? { x: c, y: other } : { x: other, y: c };
    out.push({ p, d, moveSign: behindSign(p, d, axis), under: alternate && k % 2 === 0, label: `accordion ${axis} ${k}/${n - 1}` });
  }
  return out;
}

/**
 * Zigzag triangle fold of a strip whose long direction is `axis`.
 * dy is the advance per crease along the axis. Equilateral triangles: dy = w/√3.
 * Right isosceles triangles (hypotenuse on the strip edge): dy = w.
 */
export function zigzagFolds(faces: Face[], axis: Axis, style: 'equilateral' | 'right' | 'square'): FoldLine[] {
  const b = foldedBBox(faces);
  // strip runs along `axis`; width is the other extent
  const lo = axis === 'y' ? b.minY : b.minX;
  const hi = axis === 'y' ? b.maxY : b.maxX;
  const wlo = axis === 'y' ? b.minX : b.minY;
  const whi = axis === 'y' ? b.maxX : b.maxY;
  const w = whi - wlo;
  const out: FoldLine[] = [];
  if (style === 'square') {
    const n = Math.max(1, Math.round((hi - lo) / w));
    return accordionFolds(faces, axis, n);
  }
  if (style === 'right') {
    // Right isosceles triangles with legs = w (classic itajime squares folded in half):
    // alternate a diagonal crease across the current square with a straight crease
    // at the square's far edge. Everything stacks into one right triangle.
    const pt = (across: number, along: number): Vec2 =>
      axis === 'y' ? { x: across, y: along } : { x: along, y: across };
    for (let k = 0; ; k++) {
      const j = Math.floor(k / 2);
      const base = lo + j * w;
      if (base >= hi - 1e-9 || k > 1000) break;
      let p0: Vec2, p1: Vec2;
      if (k % 2 === 0) {
        p0 = j % 2 === 0 ? pt(wlo, base) : pt(wlo, base + w);
        p1 = j % 2 === 0 ? pt(whi, base + w) : pt(whi, base);
      } else {
        p0 = pt(wlo, base + w);
        p1 = pt(whi, base + w);
        if (base + w >= hi - 1e-9) break;
      }
      const d = normalize({ x: p1.x - p0.x, y: p1.y - p0.y });
      out.push({ p: p0, d, moveSign: behindSign(p0, d, axis), label: `zigzag right ${k + 1}` });
    }
    return out;
  }
  // equilateral: creases alternate between the two strip edges, advancing w/√3 each
  const dy = w / Math.sqrt(3);
  const mk = (k: number): Vec2 => {
    const a = lo + k * dy;
    const c = k % 2 === 0 ? wlo : whi;
    return axis === 'y' ? { x: c, y: a } : { x: a, y: c };
  };
  for (let k = 0; ; k++) {
    const p0 = mk(k), p1 = mk(k + 1);
    const along0 = axis === 'y' ? p0.y : p0.x;
    if (along0 >= hi - 1e-9 || k > 1000) break;
    const d = normalize({ x: p1.x - p0.x, y: p1.y - p0.y });
    out.push({ p: p0, d, moveSign: behindSign(p0, d, axis), label: `zigzag equilateral ${k + 1}` });
  }
  return out;
}

/** Single diagonal fold corner-to-corner of the current bbox. */
export function diagonalFold(faces: Face[], which: 'main' | 'anti'): FoldLine {
  const b = foldedBBox(faces);
  const p = which === 'main' ? { x: b.minX, y: b.minY } : { x: b.maxX, y: b.minY };
  const q = which === 'main' ? { x: b.maxX, y: b.maxY } : { x: b.minX, y: b.maxY };
  const d = normalize({ x: q.x - p.x, y: q.y - p.y });
  // move the side containing the remaining corner with larger x (arbitrary but deterministic)
  const corner = which === 'main' ? { x: b.maxX, y: b.minY } : { x: b.maxX, y: b.maxY };
  const s = d.x * (corner.y - p.y) - d.y * (corner.x - p.x);
  return { p, d, moveSign: s >= 0 ? 1 : -1, label: `diagonal ${which}` };
}

export function totalFlatArea(faces: Face[]): number {
  return faces.reduce((s, f) => s + Math.abs(polygonArea(f.flat)), 0);
}
