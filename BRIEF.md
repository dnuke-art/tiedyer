# tiedyer — kickoff brief

- **Problem:** Predicting a tie-dye pattern from a fold-and-bind plan is guesswork; want a
  sandbox to go back and forth between fold plan and finished cloth, eventually with real
  dye diffusion physics.
- **Done looks like:** Fold a cloth with a sequence of simple folds (accordion, fan,
  triangle), place bands or clamps, apply dye to the folded stack, watch it diffuse
  through layers, unfold, and click either view to see where a point lands in the other.
  Itajime and a fan-fold V shirt look plausible next to photos.
- **Not now:** Twist/spiral, crumple, scrunch (need the particle-cloth approach, not
  origami). Inverse design from a target pattern. Wrinkles, stretch, curved folds,
  weave-level anisotropy.
- **First slice:** Fold engine only, no dye physics: fold sequence -> per-face rigid
  transform + layer order -> folded stack view and flat view with bidirectional picking.
  Then paint on the stack with depth attenuation and unfold. Diffusion (Morimoto's
  equation on the layer graph) is slice two.
- **Open question:** Whether the simple-fold origami model covers enough of the folds
  actually used, given spirals are the most popular tie-dye pattern and are out.
- **Platform:** Browser app, statically hostable (Vite + TypeScript, no backend).

## Prior art

- Morimoto & Ono 2010, "Computer-Generated Tie-Dyeing using a 3D Diffusion Graph" (ISVC).
  Fold lines -> ORIPA folded geometry -> 3D graph across contacting layers -> PDE:
  df/dt = div(D grad f) + s(x,f) - a(x,f) with Langmuir adsorption, press function from
  distance field of clamped region, dye supply map from distance to exterior surface.
  https://www.design.kyushu-u.ac.jp/~morimoto/pdf_video/10ISVC_3Dgraph.pdf
- Evans 2019 (Trinity honors thesis), Fick's law on a grid + relationship matrix for folds,
  multi-color. https://digitalcommons.trinity.edu/compsci_honors/50/
- npj Heritage Science 2025: particle cloth with fold/twist/bundle/clamp ops, confinement
  count as dyeability proxy (no diffusion). Path to spirals later.
  https://www.nature.com/articles/s40494-025-02223-7
- Origami tooling: FOLD format (faceOrders), Rabbit Ear, Flat-Folder (Ku), ORIPA.
