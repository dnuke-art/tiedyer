# Roadmap

Notes, not commitments. The near-term list is tie-dye. The second half is about what
the engine underneath actually is, and where that could go.

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
