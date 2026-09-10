// 2D geometry primitives: vectors, affine matrices (canvas convention), polygon clipping.

export interface Vec2 { x: number; y: number }

/** Affine matrix, canvas convention: x' = a*x + c*y + e ; y' = b*x + d*y + f */
export interface Mat { a: number; b: number; c: number; d: number; e: number; f: number }

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const sub = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x - q.x, y: p.y - q.y });
export const add = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x + q.x, y: p.y + q.y });
export const scale = (p: Vec2, s: number): Vec2 => ({ x: p.x * s, y: p.y * s });
export const dot = (p: Vec2, q: Vec2): number => p.x * q.x + p.y * q.y;
export const len = (p: Vec2): number => Math.hypot(p.x, p.y);
export const dist = (p: Vec2, q: Vec2): number => Math.hypot(p.x - q.x, p.y - q.y);
export function normalize(p: Vec2): Vec2 {
  const l = len(p);
  return l > 0 ? { x: p.x / l, y: p.y / l } : { x: 1, y: 0 };
}

export function apply(m: Mat, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** m ∘ n : apply n first, then m. */
export function mul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function invert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export const det = (m: Mat): number => m.a * m.d - m.b * m.c;

/** Reflection across the line through p with (any-length) direction d. */
export function reflection(p: Vec2, d: Vec2): Mat {
  const u = normalize(d);
  const n = { x: -u.y, y: u.x };
  const k = 2 * dot(n, p);
  return {
    a: 1 - 2 * n.x * n.x,
    b: -2 * n.x * n.y,
    c: -2 * n.x * n.y,
    d: 1 - 2 * n.y * n.y,
    e: k * n.x,
    f: k * n.y,
  };
}

export function translation(tx: number, ty: number): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scaling(sx: number, sy: number): Mat {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** Signed side of q relative to the directed line (p, d). Positive = left of d. */
export function side(p: Vec2, d: Vec2, q: Vec2): number {
  return d.x * (q.y - p.y) - d.y * (q.x - p.x);
}

/** Sutherland–Hodgman clip of a polygon against a half-plane; keeps points with keepSign*side >= 0. */
export function clipPolygon(poly: Vec2[], p: Vec2, d: Vec2, keepSign: 1 | -1): Vec2[] {
  const out: Vec2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const sc = keepSign * side(p, d, cur);
    const sn = keepSign * side(p, d, nxt);
    if (sc >= 0) out.push(cur);
    if ((sc >= 0) !== (sn >= 0)) {
      const t = sc / (sc - sn);
      out.push({ x: cur.x + (nxt.x - cur.x) * t, y: cur.y + (nxt.y - cur.y) * t });
    }
  }
  return out;
}

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function centroid(poly: Vec2[]): Vec2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const w = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * w;
    cy += (p.y + q.y) * w;
    a += w;
  }
  if (Math.abs(a) < 1e-12) {
    const n = poly.length;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Point-in-convex-polygon (either orientation), with tolerance in the same units. */
export function pointInConvexPolygon(poly: Vec2[], q: Vec2, eps = 1e-9): boolean {
  let pos = false, neg = false;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const s = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
    if (s > eps) pos = true;
    else if (s < -eps) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export function bbox(points: Vec2[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxContains(b: BBox, q: Vec2, eps = 1e-9): boolean {
  return q.x >= b.minX - eps && q.x <= b.maxX + eps && q.y >= b.minY - eps && q.y <= b.maxY + eps;
}
