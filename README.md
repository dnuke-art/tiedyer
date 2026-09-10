# tiedyer

A browser sandbox for planning tie-dye. Fold a cloth with a sequence of simple folds,
place rubber bands or clamps, squirt or dip dye onto the folded bundle, watch it diffuse
through the layers, and see the unfolded result. Hover either view to see where a point
lands in the other.

Static site: no backend. `npm run build` emits `dist/`.

## Run

```
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/
```

## How it works

**Folds are origami.** The cloth starts as one face. Every fold is a line in the folded
(bundle) coordinate system plus a side to move. Each face is clipped by the line; the
moving part gets `T' = Reflect(line) ∘ T` and is placed above the entire existing stack
with its internal order reversed. Because every tie-dye fold is a simple fold through all
layers, the layer order is exact and free (no NP-hard layer solving). The crease pattern
in the flat view is just the union of face edges.

**Dye lives on a flat texture.** In-plane diffusion is a 2D Laplacian on the unfolded
texture (the cloth is continuous across creases). Layer contact is a precomputed per-texel
`up` / `down` neighbour: the texel of the face directly above / below at the same bundle
position. Dye moves across those links with its own coefficient. This is the "3D diffusion
graph" of Morimoto & Ono (2010), stored as a 2D texture plus two gather maps.

```
df/dt = D∇²f + dZ·(f_up - f) + dZ·(f_down - f) + supply - adsorption
dh/dt = adsorption          (h = fixed dye, survives rinsing; f = free dye)
```

Adsorption is Langmuir-style: rate ∝ free dye × remaining capacity. "Rinse" shows only `h`.

**Bindings** are discs in bundle coordinates. Their distance field gives a press factor
in [0,1] that blocks dye supply, reduces capacity, and reduces cross-layer transfer.

**Dye strokes** are stored in bundle coordinates and replayed whenever the folds change,
so you can dye first and then experiment with the folding.

## Files

- `src/geom.ts` – vectors, affine matrices, polygon clipping
- `src/fold.ts` – faces, `applyFold`, presets (accordion, zigzag triangles, diagonal)
- `src/sim.ts` – texture + layer-contact graph, press field, strokes, explicit Euler step
- `src/render.ts` – canvas rendering of both views, picking helpers
- `src/plan.ts` – the serializable plan (cloth, folds, bands, strokes, dyes, params)
- `src/main.ts` – UI

A debug handle is exposed as `window.tiedyer` (`step(n)`, `rebuild()`, `plan`, `sim`).

## Not yet

Spirals, scrunch and crumple (need a particle cloth, not origami). Inverse design.
Wrinkles, curved folds, weave anisotropy, wicking/evaporation. WebGL for the solver.

See `BRIEF.md` for the kickoff brief and prior-art links.
