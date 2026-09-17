# How dye moves: the model behind the sliders

Written 2026-09-17 after the wicking rework. This is the reference for what each
control does and why the pattern comes out the way it does. The in-app Help
screen (sidebar → Help, or `?`) says the same things in fewer words.

## The two stages

Everything that happens to dye is one of two stages, and they run in this order:

1. **Squirting** (instant). When you squirt or dip, liquid is poured onto the
   bundle and *wicks* through the layers right away. This is a flow of liquid,
   not of dye: where the liquid goes, the dye goes with it. It happens in one
   go, before any diffusion, and it decides the overall reach of a squirt.
2. **Batch** (over time, ▶ Play). Dye that is sitting in wet cloth *diffuses*
   sideways within a layer and across the contact between touching layers, and
   at the same time it *fixes* to the fibres. Fixed dye is what survives the
   rinse. This stage only smooths and settles what squirting put in place.

Real tie-dye works the same way: the squeeze bottle decides where the dye gets
to, the hours in the bag decide how soft the edges are and how much stays.

## The cloth as the solver sees it

The cloth is a grid of texels (240 × 240 by default). Folding does not move dye
between texels; it tells the solver which texels touch which. Every texel knows:

- its position in the folded bundle,
- which texels of *other* layers lie directly above and below it (its contacts,
  with weights), and
- whether it is on the top or bottom surface of the stack, or buried.

So a stack of twelve layers is not twelve images; it is one image whose texels
are wired to each other through the folds. Twist mode builds the same wiring
from a particle-cloth simulation instead of from origami.

## Squirting: wicking as a capacity flood

A squirt pours a volume of liquid on the surface texels under the brush, with a
Gaussian footprint: full volume at the centre, fading to nothing at twice the
brush radius. The volume is the **soak** setting, measured in *layer-fills*:
soak 1 is enough liquid to fill one layer under the nozzle, soak 10 fills ten.

Each texel can hold one fill of liquid (less where a band squeezes it, nothing
where it is clamped shut). Liquid poured on a texel fills it, and the overflow
is split among the neighbours that still have room: the texels touching it in
the layers above and below, by contact weight, and the four texels next to it
in the same layer, by the **sideways wick** weight. Any neighbour that fills up
passes its own overflow on, in the order the liquid arrives. So the liquid
advances as a *saturation front* through the stack: the top layer fills, then
the next, and so on, until the volume is spent. Overflow with nowhere to go
drips off.

Sideways wick is what decides depth in a thick stack: every layer's neighbours
take their share on the way down, so at the default 0.35 a squirt stalls well
short of the bottom of a tall stack however much you pour, while at 0 the same
soak goes straight through. The status line shows how many layers the last
squirt reached.

Because a texel can be filled from any neighbour with excess, not only from the
one that reached it first, fronts have no dry seams where the set of feeding
texels changes, for example under the edge of the layer above.

A **dip** is a squirt of the given soak on every surface texel, top and bottom.

## The cloth stays wet

The solver remembers how much liquid each texel holds between squirts. That
changes what a second squirt on the same spot does:

- A full texel takes no more liquid, so the new squirt's volume pushes through
  it and the front moves **deeper**. Squirting the same place again is the way
  to reach layers a single squirt could not.
- Liquid passing through a full texel swaps half of what the texel holds for
  the passing liquid, so a new colour poured onto a wet spot **mixes in**
  instead of sitting on top.
- A texel that was already full *before* the squirt began also takes on extra
  dye from the passing liquid, up to the **build-up** limit (in extra squirts'
  worth, default 2). Going over an area again and again makes it darker, to a
  limit, and never to black. A single squirt, or one held pour, spends all its
  liquid on depth and adds no build-up.

Rewind (or any change to the folds) dries the cloth and replays every stroke,
so the wetness is always exactly what the stored strokes produce.

## Dragging, dwelling and holding

- **Dragging** lays down a fresh squirt every 0.35 brush radii of travel. Each
  is a full squirt with the current soak, and each one lands on cloth that the
  previous one wetted, so a slow drag over one area builds up (to the limit)
  and pushes deeper.
- **Holding still** keeps one squirt pouring: its soak grows by **hold flow** ×
  soak every second (default: doubles each second, up to 400 layers). The
  squirt is re-applied from scratch each frame with the larger volume, so the
  front moves down in real time and nothing stacks. The status line shows the
  soak as it grows. Set hold flow to *off* for fully stamp-based painting.
- What is saved is the final squirt, with its final soak. Load, Rewind and
  fold changes replay it exactly, so nothing about the result depends on time.

## Batch: diffusion and fixing

While ▶ Play runs, each step moves free dye and fixes some of it:

```
df/dt = spread · ∇²f  +  thru · Σ w·(f_contact − f)  −  fixing
dh/dt = fixing,      fixing = rate · f · (capacity − h)
```

- **spread** is diffusion within a layer, across the texel grid. It softens
  edges.
- **thru layers** is diffusion across the contact between touching layers,
  scaled by contact weight and by how hard a band presses there. It is what
  lets dye that was wicked into layer three bleed into layers two and four.
- **fixing rate** and **capacity** control how fast free dye becomes fixed dye
  and how much a texel can hold. Fixing is Langmuir-style: fast while there is
  free dye and room, slowing as the cloth fills. Free dye keeps moving; fixed
  dye stays.
- **Rinse** shows only fixed dye, which is what the shirt will look like.

The batch pauses itself once almost no free dye is left to move, and pauses
while you are pouring so the two do not fight.

The step runs on the GPU as a fragment shader with the CPU implementation kept
as the reference; the two agree to float precision.

## Bleach

Bleach is a fifth liquid. It wicks and diffuses exactly like dye, but where it
sits it destroys a fraction of every dye, free and fixed, per step (**bleach
power**), is used up in proportion, and fades on its own (**bleach fade**). It
strips dye that was squirted normally, and it discharges a **cloth colour**,
which is a dye fixed uniformly across the cloth before the first stroke. Free
bleach is tinted pale blue in the views so you can see it on white cloth.

## Bands and clamps

A band or clamp produces a press field: fully squeezed at the band, easing off
over **band halo** centimetres, never below **band leak**. Squeezed texels hold
less liquid, take less dye, and pass less to their neighbours; a fully clamped
texel blocks the front entirely.

## Which control for which effect

| I want… | Use |
|---|---|
| A squirt to reach more layers at once | Sideways wick down first (it is the main lever: on the 72-layer kikko a soak-60 squirt reaches 42 layers at 0.35 and all 72 at 0), then soak up, or hold the button still. The status line reports how many layers the last squirt reached |
| Dye on every layer regardless | Paint the edges of the stack in 3D, or dip |
| A darker, richer area | Go over it again; raise build-up to allow more |
| To stop a colour from ever going black | Lower build-up (0 = one squirt's worth, full stop) |
| Softer edges after the fact | Spread up, longer batch |
| More bleed between layers in the batch | Thru layers up |
| More of the dye to survive rinsing | Fixing rate or capacity up |
| A resist | Band or clamp; tighten with band halo and leak |
| To lighten something | Bleach, or a lower cloth depth for the base colour |
| Stamp-based painting with no time dependence | Hold flow off |

## Constants that are not sliders

- Mixing share when liquid passes a full texel: 0.5 (`MIX` in `src/sim.ts`).
- Bleach spent per unit of dye destroyed: 0.5 (`STOICH`).
- Hold-to-pour cap: 400 layers.
- Stamp spacing while dragging: 0.35 brush radii.
