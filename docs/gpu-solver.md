# The GPU solver and the iOS simulator: render-target width

Written 2026-09-21, after the iOS simulator was seen running the batch
(diffusion) on the CPU. This covers how the GPU solver lays out its state, why
the simulator refused it, what changed (`src/gpu.ts`, commit `bf56607`), and
what is still unverified.

## Symptom

In the iPhone 17 Pro Max simulator (iOS 26.5, Xcode 26.6) the readout in the
corner of the bundle view said `CPU · t=…`. The same build in desktop Chrome
said `GPU`. Nothing else was visibly wrong, because `main.ts` quietly falls
back to the CPU solver (`Sim.step`) when `new GpuSolver()` throws. The only
trace was a `console.warn`, and the simulator's web view console cannot be
seen without attaching Safari's Web Inspector.

## How the GPU solver holds its state

`GpuSolver` runs the same step as `Sim.step` (in-plane spread, through-layer
contact exchange, fixing, bleach) as one fragment shader over the flat cloth's
texel grid (`N × M`, 240 × 240 by default). Its state lives in float textures:

| Texture | Format | Contents |
|---|---|---|
| `texF[2]` | RGBA32F | free dye, one channel per dye (up to 4) |
| `texH[2]` | RGBA32F | fixed dye, one channel per dye |
| `texB[2]` | RGBA32F | free bleach, red channel only |
| `texLinkA/B`, `texWeightA/B` | RGBA32F | layer-contact graph (static) |
| `texPress` | RGBA32F | band pressure and validity (static) |

Each step reads `F, H, B` from the current buffer and writes the next state
into the other one (ping-pong). The fragment shader `STEP_FS` has three
outputs:

```glsl
layout(location = 0) out vec4 oF;
layout(location = 1) out vec4 oH;
layout(location = 2) out vec4 oB;
```

so each of the two framebuffers had three colour attachments. That is
3 × 16 bytes = **48 bytes of render target per pixel** in a single draw.

## Diagnosis

1. **Extensions.** A test page opened in the simulator's Safari (same WebKit as
   the app's `WKWebView`) reported `renderer: Apple GPU`,
   `EXT_color_buffer_float: true`, `EXT_color_buffer_half_float: true`,
   `OES_texture_float_linear: false`. So WebGL2 float render targets are
   available and `GpuSolver.supported()` passes. (No float linear filtering
   doesn't matter here: every solver texture uses `NEAREST`.)
2. **The actual error.** The readout now shows why the GPU is off
   (`gpuWhy` in `main.ts`). In the simulator it read
   **`GPU off: fbo incomplete`**. That is the
   `checkFramebufferStatus(...) !== FRAMEBUFFER_COMPLETE` check in
   `GpuSolver.resize()`, for the framebuffer with all three RGBA32F targets
   attached.
3. **What completes.** The same framebuffer with only `F` and `H` attached
   (32 bytes a pixel) is complete, and so is a framebuffer with `B` alone.

### Likely cause (inferred, not measured)

WebKit's WebGL runs on Metal (through ANGLE), and Metal caps the **total size
of all colour attachments per pixel**. As we understand Apple's Metal
feature-set tables, older GPU families allow 32 bytes a pixel and A11 and
later allow 64. The simulator's Metal device evidently applies the lower
limit, or something like it: 32 bytes completes, 48 does not. Current iPhones
(A-series from A11) should accept 48 bytes, so real devices probably ran the
single-pass solver all along. Pre-A11 devices would have hit the same
fallback. **Confirmed on one device:** an iPhone 16 (A18) running TestFlight
0.1.5, which had only the single-pass solver, showed `GPU` in the readout, so it
accepts all three RGBA32F targets. Pre-A11 hardware is still unchecked; the
readout makes that a glance (see "Checking a device" below).

## The fix: split the step when the wide target is refused

`GpuSolver.resize()` still tries the single three-target framebuffer first. If
it is incomplete, the solver switches to **split mode** (`gpu.split = true`):

- `fbo[i]`: `F` and `H` only (`COLOR_ATTACHMENT0/1`, 32 bytes a pixel),
  `drawBuffers([C0, C1])`.
- `fboB[i]`: `B` only, attached at `COLOR_ATTACHMENT2` so it lines up with the
  shader's `location = 2` output, `drawBuffers([NONE, NONE, C2])`.

`step()` then draws the same full-screen triangle twice per step, once into
each framebuffer. Both draws sample the *same* source textures, so they
compute identical values and each keeps only the outputs its framebuffer has
attached. Outputs with no draw buffer are discarded, which WebGL2 allows. The
shader is unchanged and there is no extra sync between the two draws.
`download()` reads bleach from `fboB` in split mode.

**Cost.** In split mode every step runs the whole step shader twice, so
roughly twice the fragment work per step. At 240² texels that is still far
cheaper than the CPU solver. The single-pass path is unchanged on GPUs that
accept it.

**Correctness.** Checked in desktop Chrome by patching
`checkFramebufferStatus` to reject any framebuffer with attachments 0 and 2
both bound (that forces split mode), then running the same plan in both
modes:

| Run | Result, split vs single pass |
|---|---|
| Bleach preset, 300 steps (fixed dye and bleach) | identical sums of `h` per dye and of `bl` |
| Dip plus squirt, 25 steps (free and fixed dye in motion) | identical sums of `f` and `h` per dye |

The largest relative difference was 0, as you'd expect: the same shader, the
same inputs, and each output written exactly once. After the change the
simulator's readout reads `GPU (2-pass)`.

## Checking a device

The readout's solver line says which path is running:

| Readout | Meaning |
|---|---|
| `GPU` | single pass, three render targets |
| `GPU (2-pass)` | split mode: the device refused 48 bytes a pixel |
| `CPU` plus a line `GPU off: <reason>` | no GPU solver at all, and why (`no WebGL2 float render targets`, a shader compile error, `fbo incomplete` even when split, …) |

## Open items

- **Confirm on older hardware.** An iPhone 16 shows `GPU` (single pass). If a
  pre-A11 device (iPhone 7 / 8 class) is to hand, read its solver line; the
  expectation is `GPU (2-pass)`.
- **If split mode needs to be faster** there are two cheaper options than two
  full draws. Bleach is one channel, so it could ride in a spare channel of
  another target when fewer than four dyes are in use. Or free and fixed dye
  could be stored as RGBA16F where the precision allows it: half floats give
  about 3 decimal digits, marginal for the small per-step fixing increments,
  so this would need testing against the CPU solver first.
- The CPU solver (`Sim.step`) remains the reference implementation and the
  fallback. Strokes and replays always run on the CPU arrays and are
  uploaded (`upload()` / `download()`), so a device's solver path never
  changes what gets saved.
