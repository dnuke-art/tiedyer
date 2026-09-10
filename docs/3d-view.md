# How the 3D bundle view was built

The 3D view lets you orbit a bundle, squirt dye from any direction, and wrap bands
around it. It was estimated at three to four days and landed in one session, and the
reason is worth stating up front: the dye solver never knew about folds. It sees a
*bundle*, which is a position per texel, a weighted list of which texels touch which,
and which texels are exposed to the air. Flat folds produce one, the particle cloth
produces another, and a 3D renderer only has to draw what is already there. This
document walks through each piece, what it cost, and what went wrong on the way.

## 1. The contract that made it cheap

```ts
interface Bundle {
  px, py, pz: Float32Array;      // bundle-space position per texel (cm)
  contacts: Int32Array;          // n × 8 texel indices of touching layers, -1 = none
  weights: Float32Array;         // n × 8 contact weights, each side of a stack sums to 1
  surfaceTop, surfaceBot: Uint8Array;
  exposed: Uint8Array;           // touches air in any direction
  column(p): number[];           // texels under a bundle xy, top first (2D picking)
}
```

Everything the renderer needs is `px, py, pz` plus the grid topology, which is implicit:
texel `i` sits at grid cell `(i % N, i / N)` and its in-plane neighbours are the adjacent
cells. Everything a 3D stroke needs is a way to turn "spray here, in this direction" into
a set of entry texels with liquid volumes; the wicking flow was already a layered flow
from an entry set. Everything a 3D band needs is a distance from a plane. So the sim
gained one generalisation and one new distance formula, and the rest is rendering and
input.

## 2. Rendering

The renderer is `src/view3d.ts`, plain WebGL2 with hand-rolled 4×4 matrices and no
dependencies. Two styles draw the same buffers.

**Mesh.** The texel grid is a connected sheet, so it is two triangles per grid quad.
Vertex attributes are position, UV, and texel id. UV is the flat cloth coordinate
`((i + 0.5) / N, (j + 0.5) / M)`, which means the dye image *is* the texture: the colour
mapping shader already renders the dyed cloth into a canvas, and that canvas is uploaded
with `texImage2D` whenever the dye changes. No copy, no per-vertex colour.

Lighting is flat shading from screen-space derivatives, which needs no normal buffer:

```glsl
vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
vec3 v = normalize(uEye - vPos);
if (dot(n, v) < 0.0) n = -n;            // double sided: cloth has no inside
float diff = max(dot(n, uLight), 0.0);
```

One rule matters for correctness, not looks: **quads that straddle a fold are dropped.**
On a folded stack, two texels that are grid neighbours across a crease can be at the
bottom and the top of the stack, and the quad between them would be a 7 cm tall wall.
The first build drew those walls. They looked like a rounded fold edge, which was
pleasant, but the wall's triangles carry the ids of crease-edge texels from every layer,
so a squirt that grazed a wall painted dye lines along every crease of the flat cloth.
Now any quad whose diagonal spans more than four texel spacings in bundle space is
skipped when the index buffer is rebuilt, which happens on every geometry change.

**Surfel splats.** Each texel is drawn as an instanced quad oriented by its normal, with
a Gaussian falloff in the fragment shader and a discard below a threshold. This is
Gaussian splatting without the fitting step: the geometry is known, so the normal is
just the cross product of the grid's central differences, and the radius is 0.75 of the
texel spacing. Depth testing with an alpha cutoff needs no sorting. It reads softer than
the mesh and keeps working when a scrunch would make the mesh ugly. It is a style toggle
in the View section.

**Camera.** Orbit parameters: target, distance, azimuth, elevation, field of view.
`frame()` fits the bounding box of the current positions so a new bundle is always in
view. Near and far planes scale with distance so zooming never clips.

## 3. Picking: the ID buffer

Both shaders have an ID mode that writes the texel index instead of colour, encoded as
`id + 1` across the red, green and blue bytes, so zero means background:

```glsl
vec4 encode(float id) {
  float v = id + 1.0;
  return vec4(mod(v, 256.0) / 255.0, mod(floor(v / 256.0), 256.0) / 255.0, floor(v / 65536.0) / 255.0, 1.0);
}
```

The id is a `flat` varying, so each triangle reports its provoking vertex. That is at
most one texel off from the true hit, which is fine for a brush. The ID pass renders
into a framebuffer the size of the canvas with a depth renderbuffer, and a pick reads one
pixel. It is lazy: the pass re-runs only when the camera key (azimuth, elevation,
distance, target, style) or the geometry version changed. Hovering across a still model
costs one `readPixels` and nothing else.

A hit gives the texel id, its bundle position, and the ray direction through that pixel.
Those three numbers are all a stroke needs.

## 4. Strokes from any direction

A 3D stroke is stored as a hit point, a spray direction, a radius, and the usual dye,
amount and soak:

```ts
{ kind: 'brush3', p: [x, y, z], d: [dx, dy, dz], r, dye, amount, pen }
```

The interesting question is which texels the liquid lands on. The obvious answer, "the
ones visible in the main view within the brush circle", is wrong for two reasons: it
depends on the camera, so the stroke could not be replayed after a re-twist, and it
depends on the canvas resolution. Instead the renderer answers a camera-independent
question:

```ts
footprint(p, d, radius): { ids, dist }
```

It sets up a small orthographic camera looking along `d` at `p`, covering `radius` on a
side, renders the ID pass into a 96×96 framebuffer, reads it back, and returns the set of
visible texel ids with their 3D distance from `p`. A texel hidden behind another layer
from that direction is simply not in the set. The stroke then turns distances into
volumes with the same Gaussian used in 2D and hands the entry set to the wicking flow.
Because `p` and `d` are stored in the plan, replay after a geometry change re-renders the
footprint against the new geometry and lands where the same spray would land.

**Wicking had to learn sideways.** The 2D version flowed from the poured surface along
layer contacts only, and lateral spread came from the Gaussian footprint. A squirt on the
*edge* of a stack has no layers below it to flow into; the liquid has to wick inward
within each layer. So the flow's neighbour set is now the eight layer contacts with
their weights plus the four in-plane grid neighbours with a "sideways wick" weight
(default 0.35). The algorithm is unchanged: breadth-first hop distance from the entry
set, then in that order each texel absorbs up to its press value, passes the excess to
neighbours one hop deeper split by weight, and a fully pressed texel blocks. Edge dipping,
which is how itajime is really dyed, works on folded stacks for the first time.

## 5. Bands as slabs

A rubber band around a bundle squeezes a whole cross-section. In 3D that is a slab:
everything within half a width of a plane. You drag a line across the bundle; the two
endpoints are picked as 3D hits `a` and `b`, the view direction is `d`, and the slab's
normal is `normalize(cross(b − a, d))`, so the plane contains the line you drew and
runs through the bundle the way you are looking. Press distance is
`|n · (x − p)| − w/2`, and the existing halo and leak parameters apply unchanged. The 2D
disc stamps are the special case of a slab along z. There is no separate band mesh: turn
on "Show binding pressure" and the press tint is already in the texture the mesh samples.

## 6. Flat folds in 3D

The origami bundle used to be flat with an integer layer index. It now has real height,
`pz = layer × thickness` with a 1 mm thickness, so a 72-layer kikko is a 7 cm prism. Its
top and bottom flags are still analytic (exact from the face stack), but "exposed in any
direction" comes from the same voxel flood fill the cloth uses:

1. Rasterise every grid quad into a voxel grid, sampling it in a 4×4 pattern so air
   cannot leak between samples; skip quads that straddle a fold.
2. Flood exterior air from the corner of the bounding box with 6-connectivity.
3. A texel is exposed if any of its six neighbouring voxels is exterior air.

Layers 1 mm apart in 2.5 mm voxels merge, which is what you want: no air between
touching layers, air at the edges.

## 7. Input

The WebGL canvas sits under the existing 2D canvas, which becomes a transparent overlay
in 3D. Markers, the brush cursor, and the band drag line are drawn on the overlay in 2D
with the 3D projection, so the input handling stayed where it was. The rules:

- Entering 3D selects the orbit tool. A plain drag orbits. Dye or Band paint only when
  the drag starts on the cloth; a drag from the background orbits with any tool.
- Right or middle button, alt, ctrl and shift also orbit or pan; the wheel and the +/−
  buttons zoom; "fit" reframes.
- Two fingers orbit and pinch-zoom; a second finger cancels any stroke in progress.
- Pointer capture keeps a drag alive off the canvas, and `pointercancel` is treated as a
  release because some mobile browsers send it instead of a normal up.

Hover mapping goes both ways, which is the part that makes the app what it is. Hovering
the model marks the texel on the flat cloth and reports its bundle position and whether
it is exposed or buried. Hovering the flat cloth projects that texel's position and drops
a marker on the model.

## 8. Making it cheap on a phone

The first 3D build ran hot. Every pointer move redrew both views, re-ran the colour
shader, re-uploaded the texture, rendered the mesh twice (colour and ID), and blocked on
a GPU readback. The fixes were all about doing less:

- Two dirty flags. `dirtyDye` means the dye image must be regenerated; `dirty` means
  something must be redrawn. The colour shader, texture upload and flat view redraw only
  on the first.
- Version keys. The 3D scene re-renders only when a key built from the texture version,
  geometry version, camera and style changes. The flat view has a similar key including
  its markers. Hovering the model redraws only the overlay.
- Lazy ID buffer, keyed the same way, and a one-entry hit cache keyed by pixel, camera
  and geometry, so the pick during a stroke and the pick for the cursor are one pick.
- No picking during camera gestures.
- The 3D canvas is capped at 1.5× device pixel ratio. At 3× with multisampling it was
  nine times the pixels of the 2D view.
- The frame loop wraps rendering in a try/catch and shows errors in the status bar.

## 9. What went wrong

- **Walls across creases** painted dye lines along every fold (section 2).
- **Capped pixel ratio broke picking.** The overlay ran at full ratio and the 3D canvas
  at 1.5×, and the pick used the overlay's scale. Fixed by scaling by the actual ratio
  of the 3D canvas's backing width to its layout width, and projecting overlay markers
  back the same way.
- **"Orbit doesn't work."** The default tool was Dye, so a drag painted. The orbit tool
  is now selected on entering 3D and background drags orbit regardless.
- **The freeze.** The twist worker returned the bundle without its `exposed` array. The
  first hover over a spiral in 3D indexed it, threw inside `requestAnimationFrame`, and
  the loop died silently while buttons kept responding. The kikko never hit it because
  fold bundles are built on the main thread. Found by a headless soak test that watched
  for page errors; fixed by transferring the array and guarding the loop.
- A build hash now shows in the status line, because "is this the new version?" came up
  more than once with a cached page.

## 10. Sizes and numbers

| | |
| --- | --- |
| Renderer | about 450 lines, no dependencies |
| Mesh at 240² fold resolution | 57 600 texels, up to 114 000 triangles |
| Spiral at 101² particles | 10 201 texels, 20 000 triangles |
| Footprint framebuffer | 96 × 96 |
| Kikko squirt from a 52° camera, r = 2 cm | 1 384 entry texels |
| Hover cost on the software renderer | about 12 ms; sub-millisecond on a real GPU |
| Slab band 2 cm wide across the spiral | 6 688 of 10 201 particles pressed |

## 11. Not done

Splats with sorted alpha blending for the truly soft look; clamps as paired slabs; pen
pressure as soak volume; drawing the twist in 3D while it runs at full frame rate; and
a real phone test of the two-finger gesture, which was only exercised with synthetic
events.
