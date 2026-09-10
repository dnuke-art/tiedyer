# tiedyer — product brief

**One line:** a browser sandbox where you fold, bind, and dye a virtual bundle exactly the
way you would a real one, and read the finished pattern off the unfolded cloth before you
touch any dye.

## Problem

Tie-dye is planned blind. You fold, bind, and dye a bundle, then wait hours to find out
what the cloth looks like. Tutorials teach a handful of named folds by rote, so most people
reproduce the same six patterns and never learn the rule that connects a fold to its
result. Getting a *new* pattern means burning shirts, and even a known pattern goes wrong
when the dye soaks deeper or shallower than expected.

The missing tool is one that lets you go back and forth: change the fold and see the
pattern, or look at a pattern and see which layer of the bundle each part came from.

## Who it's for

- **Primary:** me, planning my own dye sessions and hunting for folds nobody has shown me.
- **Secondary:** anyone who dyes and lands on the static site. No account, nothing to
  install, a plan is a JSON file you can send to a friend.

## Core idea

**The bundle is the interface.** Every action you would take on real cloth has a direct
counterpart on the virtual bundle:

| Real                             | tiedyer                                        |
| -------------------------------- | ---------------------------------------------- |
| fold along a line                | click two points, click the side that moves    |
| accordion, fan, triangle folds   | one-click presets                              |
| rubber band, clamp board         | paint a binding on the bundle                  |
| squirt bottle, dip in a bucket   | brush on the bundle, or dip the whole thing    |
| batch overnight                  | press play, watch dye migrate through layers   |
| rinse                            | toggle to show only fixed dye                  |
| unfold                           | the flat view, always live                     |

The flat cloth is the readout, not a second editor. Hover either view and the other shows
where that point lives: a spot on the cloth lights up its face and its depth in the stack;
a spot on the bundle numbers every layer under the cursor on the cloth.

## What makes it honest

- **Folds are exact.** Each fold is a rigid reflection and the layer order is tracked as
  integers. The crease pattern on the flat cloth is what you would see if you unfolded a
  real bundle. Nothing is approximated at this stage.
- **Dye is physics, not paint.** Diffusion in the plane, diffusion between touching layers,
  and fixing into a finite capacity, following Morimoto & Ono's dyeing model. Bindings are
  a pressure field that starves dye, not a hard mask. The parameters are physical enough
  to be tuned against a real shirt.
- **The plan is the source of truth.** Cloth, folds, bindings, strokes, dyes, and
  parameters are one JSON document. Everything on screen is derived from it, so a fold
  change re-derives the dye, and a saved plan reproduces the session exactly.

## Scope

**v1 (built):** rectangular cloth, simple folds through all layers, presets for accordion,
zigzag triangles (equilateral and right), diagonal, and hand-drawn creases; disc bindings;
brush and dip dye with depth attenuation; diffusion with fixing and rinse, on a WebGL2
solver with a CPU fallback, up to 800 texels; bidirectional hover picking; autosave, JSON
export and import; static build with Pages workflow.

**v2:** side-by-side comparison
against photos of real dyed cloth to calibrate spread, soak, and fixing; folds through a
subset of layers; straight-line rubber bands as first-class bindings; per-dye parameters
(reactive vs. acid, viscosity for ice dye).

**Later:** twist and scrunch via a particle cloth, which is what a spiral needs; curved
folds; stitched shibori; garment shapes instead of rectangles; sharing a plan by URL.

**Not doing:** inverse design that proposes folds from a target picture, cloth mechanics
(wrinkles, stretch), weave-level anisotropy, anything that needs a server.

## Success looks like

1. A kikko itajime and a fan-fold chevron planned in tiedyer come out of the wash looking
   like the screen, close enough that the discrepancy is a parameter, not a model error.
2. I plan a session in tiedyer instead of from memory, and change the fold at least once
   because of what the flat view showed me.
3. A fold I have never seen in a tutorial produces a pattern I want to make, and I make it.
4. Someone else opens the static site, loads a plan, and understands a fold from the
   two views without reading instructions.

## Risks and open questions

- **Origami covers most folds but not the most popular one.** Spirals are twists, and
  twists are not simple folds. v1 says so up front; v2 does not fix it. If most of my real
  sessions are spirals, the particle-cloth work moves up the list.
- **Physics that looks right may still predict wrong.** The diffusion model has never been
  calibrated here. Until the photo comparison exists, treat the batch step as qualitative.
- **Geometry rebuild cost.** The solver is fast now, but re-deriving the layer graph is a
  brute-force point-in-polygon pass: about 1 s at 800 texels with 72 faces. A spatial
  bucket would fix it if it starts to hurt.
- **Does a flat stack model a fat bundle?** Real bundles are thick and layers separate in
  the bath. The press field and depth attenuation stand in for that; whether they stand in
  well enough is an empirical question.

## Principles

- Static, offline, no accounts. Open the page and fold.
- Exact where it can be exact, physical where it must be approximate, and clear which is
  which.
- Every control names a real-world action or a real-world quantity.
- The plan file is the API. Anything the UI can do, a script can do to the plan.
