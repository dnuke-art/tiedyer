# Roadmap

Notes, not commitments. The near-term list is tie-dye. The second half is about what
the engine underneath actually is, and where that could go.

## Parked until the App Store submission is approved

Started 2026-09-21, with build 0.1.8 in TestFlight and the resubmission being prepared.
Until Apple approves it, the app only gets what App Review asks for. Everything else
waits here.

**Bugs**

- The ☰ button disappeared on the iPhone and stayed gone until the phone was rotated to
  landscape; after that the layout recovered. Not reproduced yet and the cause is
  unknown. Next time: note what was on screen, the orientation, whether the panel had
  just been opened or closed, and the build (Help shows it at the bottom).

**Loose ends from the layout rework**

- Relaunching after working on a twist re-runs the cloth simulation for a few seconds,
  because the autosave keeps the twist's settings, not the twisted cloth. Save the
  finished cloth with the plan so it reopens instantly.
- Tool hints only exist as tooltips on the Dye / Band / Fold / Orbit switch, so on a phone,
  which has no hover, they never show.
- In the Batch section the step counter (`t 150`) wraps onto its own line on a phone.
- A stroke that starts at the very bottom of the screen can be taken by iOS as the
  home swipe, now that the views run to the edge. If that bites, defer the system
  gesture there (`preferredScreenEdgesDeferringSystemGestures` in the iOS shell).

**Control panel and modes**

- A time slider on the bundle view in place of Play: scrub along the diffusion
  timeline instead of running it. Needs a decision on how: store snapshots as the
  batch runs (memory: 240² texels × free, fixed and bleach per step kept), or re-run
  from the last stroke up to the slider's time (the solver is deterministic, and on
  the GPU a few hundred steps take a fraction of a second, so this may be enough).
  Strokes added partway along the timeline need a rule too: the usual choice is that
  they cut off the future and the batch continues from there.

**Bands**

- Old round bands (from 2D plans before 2026-09-21) are not drawn in 3D, and old
  tilted 3D bands are not drawn in 2D. They still resist dye.
- The 3D view shades at most 32 bands; more still work but do not show in 3D.
- While tying a band in 3D, the two point markers float at the top of the stack
  rather than sitting on the surface where you tapped.

**GPU**

- Split (two-pass) mode does twice the fragment work; cheaper options are in
  `docs/gpu-solver.md`. Check a pre-A11 phone's readout if one turns up.

**Store listing**

- iPad 13" screenshots still show the old layout (the iPhone ones are being redone for
  the resubmission).

## Near term (tie-dye)

- Calibrate against real cloth: dye a kikko and a spiral, photograph, tune spread, soak,
  fixing and the cloth parameters until the discrepancy is a slider, not a model error.
- Scrunch and crumple in the particle cloth: a container squeezing inward instead of a
  rotating pinch. Ice dye on top of that (dye arriving over time, unevenly).
- Bands and clamps as constraints inside the cloth solver, so a rubber band on a spiral
  actually squeezes the disc rather than just painting a press field.
- Folds inside the cloth solver (freeze, rotate, activate), so fold-then-twist and
  twist-then-fold plans are possible.
- Pole wrap (arashi): wrap the cloth around a cylinder, compress along the axis.
- Straight-line bands and shaped clamps as first-class bindings.
- Per-dye chemistry: reactive versus acid, viscosity, ice-dye splitting into components.
- Faster cloth: fewer substeps, GPU constraint projection, or a coarser solve with a
  finer texel grid interpolated from it.
- Garment shapes instead of rectangles; render the result on a shirt.
- Share a plan by URL.

## True 3D bundle view (built 2026-09-10)

Goal: orbit the bundle, put bands anywhere, and dye from any side or direction, not just
straight down or straight up. Built as sized below in one session; the sim barely
changed. Left for later: a splat mode with sorted blending, clamps as paired slabs,
pen pressure, and a 3D view of the twist while it runs at full frame rate.

**Why it is cheap on the sim side.** The solver already sees only a Bundle: positions,
weighted contacts, surface flags. Wicking is a layered flow from an *entry set* of texels
with volumes; "top" and "bottom" are just two ways of choosing that set. A 3D squirt
chooses it differently: the texels visible from the camera within the brush footprint
around the hit point. Diffusion, fixing, press and rinse are untouched.

**Rendering.** WebGL2, orbit camera, two styles over the same data:

- *Mesh.* The particle grid is a connected sheet, so two triangles per grid quad,
  textured with the dye canvas at UV = flat coordinates (the GPU canvas is already a
  texture; zero copy), double-sided, lit. 20k triangles at 101² particles. Crisp,
  correct occlusion, and free of gaps at oblique angles. This is the default.
- *Surfel splats.* Each particle as an oriented Gaussian disc: normal from the grid
  neighbours, radius about 0.7 h, alpha falling off as a Gaussian, drawn as instanced
  quads. This is Gaussian splatting without the fitting step, since the geometry is
  known, not reconstructed. Depth-tested with an alpha cutoff needs no sorting; sorted
  blending gives the soft look. Same cost as the mesh. Worth having as a style, and it
  keeps working when a scrunch makes the mesh ugly.

**Picking.** Render an ID buffer (texel index as colour) from the current camera. A
pointer position gives the hit texel, its position and normal. Squirt entry set: texels
in the ID buffer within the footprint on screen, or within 3D distance of the hit point
and facing the camera. Pressure sensitivity later.

**Bands in 3D.** A rubber band is a slab: a plane through the bundle with a width. Drag
a line across the bundle in the view; the slab contains that line and the view
direction. Everything inside is pressed, with the usual halo outside. Today's disc
stamps are the special case of a slab along z. Clamps are two parallel slabs or a pad.

**Plan format.** Strokes gain a 3D hit point and direction; bands gain a plane. Replay
after a re-twist snaps the hit point to the nearest surface texel.

**Fold mode gets it too.** Give flat-fold bundles a real 3D position (layer index times
thickness) and the same voxel exposure the cloth uses, and the edges of a folded stack
become dyeable. That is edge dipping, which is how itajime is actually done and which
the 2D view cannot express.

**Estimate.**

| Piece | Size |
| --- | --- |
| WebGL2 mesh + splat renderer, lighting, orbit and touch camera | 500 to 700 lines, 1.5 to 2 days |
| ID-buffer picking, 3D strokes, entry-set wicking, slab bands, press | 200 to 300 lines, half a day |
| Flat-fold 3D positions and voxel exposure, fold-mode mesh | about 200 lines, half a day to a day |
| UI: 2D/3D toggle, camera controls, mobile gestures | half a day |

## Beyond tie-dye: a higher-dimensional painting app

What the app really is: a **realtime, invertible mapping between a flat canvas and a
folded configuration of it**, with paint applied in one space and read in the other,
and a physical medium that moves paint along the contacts the configuration creates.
Tie-dye is one instance. The parts generalize separately.

**The mapping.** Today's producers are origami simple folds (exact) and a particle
cloth (simulated). Anything that can say where each texel went and which texels touch
is a valid producer:

- Origami beyond simple folds: twist folds, tessellations, curved creases, layer-limited
  folds. Every crease pattern in a FOLD file is a canvas transform.
- Draping and wrapping: cloth over an object, around a pole, into a mould. Painting the
  outside of the shape and unfolding it is the inverse of texture mapping.
- Non-physical maps: conformal maps, Möbius strips, iterated function systems, folding a
  sheet through itself in a way no cloth could. The renderer does not care.
- Mappings as a composable graph: fold, twist, scrunch, wrap, warp, stack, each a node
  with parameters, evaluated live. Animating a parameter animates the pattern.
- One dimension up: fold a voxel volume in 4D and paint its 3D surface, or treat time as
  the extra dimension and paint during folding, so strokes land on intermediate states.

**The medium.** Wicking plus diffusion plus fixing on a contact graph is one PDE. The
same graph can carry any transport: reaction-diffusion, heat, wave, erosion, growth.
Paint that migrates, reacts, or resists (batik wax as a stroke type; a resist is dye
with a negative capacity). Media stack: paper for orizomegami, spray through a folded
stencil, ink through a stack, screen printing on a pleated surface.

**Painting both ways.** Painting on the bundle and reading the cloth is what dyers do.
The inverse is a design tool: paint the target on the flat cloth and solve for where to
squirt on the bundle. For a fixed mapping that is a linear problem through the contact
graph (a deconvolution), tractable with least squares, and it answers the question every
dyer asks: "how do I get that?" The same solve turns any of the above mappings into a
painting instrument where the canvas is folded space.

**Realtime.** The bundle to cloth relation is a gather map, so a fully GPU-resident
version can paint at frame rate with a pen tablet, pressure as soak volume, tilt as
spread. A performance instrument: fold live, paint live, unfold live.

**Outputs.** The unfolded image is one output. Others: the mapping itself exported as a
UV transform for shaders and other tools; a projection-mapped guide onto real cloth
showing where to squirt; an AR overlay; printed patterns; the pattern rendered on a
garment or object.

**What to keep as the design principle** if this grows: the mapping is exact where it
can be and simulated where it must be, the medium is physical, the plan is a file, and
every control names a real action. That is what makes it an instrument and not a filter.
