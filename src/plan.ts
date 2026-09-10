// The Plan is the complete, serializable description of a dye job:
// cloth, fold sequence, bindings, dye application, and simulation parameters.
// Everything on screen is derived from it, so it can be saved, reloaded and
// re-derived when the folds change (dye strokes are replayed onto the new geometry).

import { Vec2 } from './geom';
import { FoldLine } from './fold';

export interface DyeDef { name: string; color: string }

export type Side = 'top' | 'bottom';

export type Stroke =
  | { kind: 'brush'; p: Vec2; r: number; dye: number; amount: number; side: Side; pen: number }
  | { kind: 'dip'; dye: number; amount: number; pen: number };

/** A disc of binding (rubber band / clamp) in folded coordinates. */
export interface BandStamp { p: Vec2; r: number }

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
}

export interface Plan {
  W: number;
  H: number;
  /** texels along W */
  N: number;
  folds: FoldLine[];
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
  dZ: 0.08,
  adsorb: 0.02,
  capacity: 1.0,
  pressRadius: 1.5,
  pressFloor: 0.0,
};

export function defaultPlan(): Plan {
  return {
    W: 60,
    H: 60,
    N: 240,
    folds: [],
    bands: [],
    strokes: [],
    dyes: DEFAULT_DYES.map((d) => ({ ...d })),
    params: { ...DEFAULT_PARAMS },
  };
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
    folds: p.folds ?? [],
    bands: p.bands ?? [],
    strokes: p.strokes ?? [],
    dyes: p.dyes ?? base.dyes,
    params: { ...base.params, ...(p.params ?? {}) },
  };
}
