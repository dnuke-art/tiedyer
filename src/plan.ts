// The Plan is the complete, serializable description of a dye job:
// cloth, fold sequence, bindings, dye application, and simulation parameters.
// Everything on screen is derived from it, so it can be saved, reloaded and
// re-derived when the folds change (dye strokes are replayed onto the new geometry).

import { Vec2 } from './geom';
import { FoldLine, initialFaces, applyFold, accordionFolds, zigzagFolds, foldedBBox } from './fold';
import { TwistParams, DEFAULT_TWIST } from './cloth';

export interface DyeDef { name: string; color: string }

export type Side = 'top' | 'bottom';

export type Stroke =
  /** amount = dye concentration in the liquid; pen = liquid volume in layer-fills (soak) */
  | { kind: 'brush'; p: Vec2; r: number; dye: number; amount: number; side: Side; pen: number }
  /** 3D squirt: hit point p, spray direction d (unit), replayed via a visibility render */
  | { kind: 'brush3'; p: [number, number, number]; d: [number, number, number]; r: number; dye: number; amount: number; pen: number }
  | { kind: 'dip'; dye: number; amount: number; pen: number };

/** A binding: a disc through all layers in bundle xy (2D views), or a slab in 3D
 *  (a rubber band around the bundle: everything within w/2 of the plane through p
 *  with normal n is squeezed). */
export type BandStamp =
  | { kind?: 'disc'; p: Vec2; r: number }
  | { kind: 'slab'; p: [number, number, number]; n: [number, number, number]; w: number };

export interface SimParams {
  /** in-plane diffusion coefficient (per step, cell units) */
  dPlane: number;
  /** through-layer diffusion coefficient */
  dZ: number;
  /** adsorption (fixing) rate */
  adsorb: number;
  /** max adsorbed dye per cell (fully open cloth) */
  capacity: number;
  /** distance (cm) over which a binding's pressure fades */
  pressRadius: number;
  /** minimum press factor under a binding (0 = perfect resist) */
  pressFloor: number;
  /** in-plane share of wicking flow relative to layer contacts (0 = none) */
  lateral: number;
}

export type Mode = 'fold' | 'twist';

export interface Plan {
  W: number;
  H: number;
  /** texels along W (particles along W in twist mode) */
  N: number;
  mode: Mode;
  folds: FoldLine[];
  twist: TwistParams;
  bands: BandStamp[];
  strokes: Stroke[];
  dyes: DyeDef[];
  params: SimParams;
}

export const DEFAULT_DYES: DyeDef[] = [
  { name: 'fuchsia', color: '#e0007f' },
  { name: 'turquoise', color: '#00a0c8' },
  { name: 'lemon', color: '#f5e000' },
  { name: 'black', color: '#202028' },
];

export const DEFAULT_PARAMS: SimParams = {
  dPlane: 0.12,
  dZ: 0.3,
  adsorb: 0.02,
  capacity: 1.0,
  pressRadius: 1.5,
  pressFloor: 0.0,
  lateral: 0.35,
};

export function defaultPlan(): Plan {
  return {
    W: 60,
    H: 60,
    N: 240,
    mode: 'fold',
    folds: [],
    twist: { ...DEFAULT_TWIST, c: { x: 30, y: 30 } },
    bands: [],
    strokes: [],
    dyes: DEFAULT_DYES.map((d) => ({ ...d })),
    params: { ...DEFAULT_PARAMS },
  };
}

/**
 * Demo: kikko itajime. Accordion into a strip, zigzag into equilateral triangles,
 * then dye each corner of the triangular bundle a different colour so that every
 * layer picks up dye at the corners (a corner dip, in effect).
 */
export function demoPlan(): Plan {
  const plan = defaultPlan();
  let faces = initialFaces(plan.W, plan.H);
  for (const line of accordionFolds(faces, 'x', 6)) { plan.folds.push(line); faces = applyFold(faces, line); }
  for (const line of zigzagFolds(faces, 'y', 'equilateral')) { plan.folds.push(line); faces = applyFold(faces, line); }
  const b = foldedBBox(faces);
  const midY = (b.minY + b.maxY) / 2;
  const corners: Vec2[] = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: midY },
    { x: b.minX, y: b.maxY },
  ];
  corners.forEach((p, k) => {
    plan.strokes.push({ kind: 'brush', p, r: 3.5, dye: k, amount: 0.9, side: 'top', pen: 60 });
  });
  return plan;
}

/**
 * Demo: classic spiral. Pinch the centre, three turns, then six wedges of dye on
 * the top and the same on the underside, two of each colour, with gaps between.
 */
export function spiralDemoPlan(): Plan {
  const plan = defaultPlan();
  plan.mode = 'twist';
  plan.N = 101;
  plan.twist = { c: { x: 30, y: 30 }, turns: 3, pinch: 1.5, friction: 0.03, flatten: 2.5 };
  const c = plan.twist.c;
  for (const side of ['top', 'bottom'] as const) {
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3 + Math.PI / 6;
      for (let r = 1.5; r <= 14; r += 2.5) {
        plan.strokes.push({ kind: 'brush', p: { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }, r: 1.6 + r * 0.06, dye: k % 3, amount: 0.9, side, pen: 12 });
      }
    }
  }
  return plan;
}

export function serializePlan(plan: Plan): string {
  return JSON.stringify(plan);
}

export function parsePlan(json: string): Plan {
  const p = JSON.parse(json) as Partial<Plan>;
  const base = defaultPlan();
  return {
    W: p.W ?? base.W,
    H: p.H ?? base.H,
    N: p.N ?? base.N,
    mode: p.mode ?? 'fold',
    folds: p.folds ?? [],
    twist: { ...base.twist, ...(p.twist ?? {}) },
    bands: p.bands ?? [],
    strokes: p.strokes ?? [],
    dyes: p.dyes ?? base.dyes,
    params: { ...base.params, ...(p.params ?? {}) },
  };
}
