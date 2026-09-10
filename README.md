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

**Squirting is wicking, not diffusion.** A brush stroke pours a liquid volume (the "soak"
value, in layer-fills) onto the surface. Each layer holds one fill's worth of liquid,
less where it is squeezed by a binding, and the excess passes to the next layer: a
saturation front. Every texel works out its own reach from the pre-stroke capacity of
the layers between it and the surface at its own bundle position, so mirrored layers
whose texel grids are offset by half a texel still get a smooth front. A fully pressed
layer stops the front. Diffusion then only smooths what wicking put in place, which is
also the order things happen in a real bundle.

**Solver.** The step runs as a WebGL2 fragment shader (`src/gpu.ts`): `f` and `h` are
RGBA32F textures (one channel per dye), the layer links and press field are two static
textures, and two framebuffers ping-pong with multiple render targets. Colour mapping is a
second shader whose output canvas is drawn into both views. The CPU implementation in
`src/sim.ts` is the reference and the fallback when float render targets are missing; the
two agree to float precision. Strokes are applied on the CPU arrays (download, apply,
upload) so there is one implementation of the stroke logic.

Measured on a laptop GPU, 200 steps: 240² texels 24 ms, 800² texels 270 ms, versus 560 ms
on the CPU at 240².

**Bindings** are discs in bundle coordinates. Their distance field gives a press factor
in [0,1] that blocks dye supply, reduces capacity, and reduces cross-layer transfer.

**Dye strokes** are stored in bundle coordinates and replayed whenever the folds change,
so you can dye first and then experiment with the folding.

**Twists are a particle cloth.** In twist mode the cloth is a grid of particles on a
table, solved with position-based dynamics (structure, shear and bend constraints,
particle self-collision through a spatial hash, table friction). A pinched disc at the
centre is driven kinematically: lifted, then rotated. Any fabric that touches the core
sticks to it and turns with it, so the core grows as it winds, which is what makes the
rest of the cloth gather into spiralling pleats. After the turns the pinch is released
and a ceiling pats the bundle flat. Particle positions, contacts with other layers within
reach, and exposure (voxel flood fill of the rasterized sheet) become a Bundle for the same
dye solver. The run happens in a Web Worker with live progress.

## Files

- `src/geom.ts` – vectors, affine matrices, polygon clipping
- `src/fold.ts` – faces, `applyFold`, presets (accordion, zigzag triangles, diagonal)
- `src/sim.ts` – texture + layer-contact graph, press field, strokes, explicit Euler step (CPU reference)
- `src/gpu.ts` – WebGL2 solver and colour mapping (same step as a fragment shader)
- `src/render.ts` – canvas rendering of both views, picking helpers
- `src/bundle.ts` – the Bundle contract (positions, weighted contacts, surface flags); flat-fold producer
- `src/cloth.ts` – particle cloth, twist operation, bundle extraction
- `src/twist.worker.ts` – runs the twist off the main thread
- `src/plan.ts` – the serializable plan (cloth, mode, folds, twist, bands, strokes, dyes, params)
- `src/main.ts` – UI

A debug handle is exposed as `window.tiedyer` (`step(n)`, `rebuild()`, `plan`, `sim`).

## Not yet

Scrunch and crumple (the particle cloth can do them; the operations are not written).
Bands and clamps as constraints inside the cloth sim. Inverse design. Curved folds,
weave anisotropy, evaporation. The twist takes about 15 s at 101² particles.

See `BRIEF.md` for the kickoff brief and prior-art links.

## Headless testing

`tools/shot.mjs` drives the dev server in Playwright's cached Chromium (SwiftShader, so
the WebGL2 solver runs) and takes a screenshot. It evaluates an optional script file in
the page with the `window.tiedyer` handle available:

```
npm run dev &
node tools/shot.mjs tools/examples-twist.js out.png
```
