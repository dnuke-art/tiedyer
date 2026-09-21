import './style.css';
import { Vec2, Mat, apply, mul, side, normalize, dist, clipPolygon } from './geom';
import { Face, FoldLine, buildFaces, accordionFolds, zigzagFolds, diagonalFold, facesAtFolded, faceAtFlat, foldPreview, Axis } from './fold';
import { flatFoldBundle, FlatFoldBundle } from './bundle';
import { foldMesh } from './foldmesh';
import { encodeGlb } from './glb';
import { ClothView, ClothBundle, makeClothBundle } from './cloth';
import { View3D, Vec3, sub as sub3, len3 } from './view3d';
import { Plan, Stroke, BandStamp, Mode, BLEACH, defaultPlan, demoPlan, spiralDemoPlan, bleachDemoPlan, serializePlan, parsePlan } from './plan';
import { Sim } from './sim';
import { isNative, deliverFile, tap, toBase64 } from './native';
import { Renderer, ViewOpts } from './render';
import { GpuSolver } from './gpu';

// ---------------------------------------------------------------------------
// State

const AUTOSAVE_KEY = 'tiedyer.plan.v1';

function loadAutosave(): Plan | null {
  try {
    const s = localStorage.getItem(AUTOSAVE_KEY);
    return s ? parsePlan(s) : null;
  } catch { return null; }
}

const saved = loadAutosave();
let plan: Plan = saved ?? demoPlan();
const DEMO_STEPS = 150;
let faces: Face[] = [];
let bundle: FlatFoldBundle | ClothBundle | null = null;
/** cloth being manipulated while a twist run is in progress */
let liveCloth: ClothView | null = null;
let twistRun = 0;
let twistStatus = '';
/** batch steps to run once the geometry is ready (demos) */
let pendingSteps = 0;
const twistWorker = new Worker(new URL('./twist.worker.ts', import.meta.url), { type: 'module' });
const sim = new Sim(plan);

function isFold(b: FlatFoldBundle | ClothBundle | null): b is FlatFoldBundle { return !!b && 'faces' in b; }
function isCloth(b: FlatFoldBundle | ClothBundle | null): b is ClothBundle { return !!b && 'cloth' in b; }

if (isNative()) document.body.classList.add('native');
const flatCanvas = document.getElementById('flat') as HTMLCanvasElement;
const foldedCanvas = document.getElementById('folded') as HTMLCanvasElement;
const folded3dCanvas = document.getElementById('folded3d') as HTMLCanvasElement;
const stackEl = document.getElementById('stack')!;
const renderer = new Renderer(flatCanvas, foldedCanvas);
renderer.dpr = window.devicePixelRatio || 1;

let view3d: View3D | null = null;
try { view3d = new View3D(folded3dCanvas); } catch (e) { console.warn('3D view unavailable', e); }
let gridKey = '';
/** push the current bundle (or live cloth) positions into the 3D view */
function sync3d(px: Float32Array, py: Float32Array, pz: Float32Array, reframe: boolean): void {
  if (!view3d) return;
  const key = `${sim.N}x${sim.M}x${plan.W}x${plan.H}`;
  if (key !== gridKey) { view3d.setGrid(sim.N, sim.M, plan.W, plan.H); gridKey = key; reframe = true; }
  view3d.setPositions(px, py, pz);
  // flat folds get the exact polygon mesh; the particle cloth is drawn from its grid
  view3d.setMesh(isFold(bundle) ? foldMesh(bundle.faces, plan.W, plan.H, plan.thickness) : null);
  geomVersion++;
  if (reframe) view3d.frame();
}
function is3d(): boolean { return view.three && !!view3d; }

let gpu: GpuSolver | null = null;
/** why the GPU solver is not in use, shown in the readout ('' when it is) */
let gpuWhy = '';
try {
  if (GpuSolver.supported()) gpu = new GpuSolver(sim);
  else gpuWhy = 'no WebGL2 float render targets';
} catch (e) {
  console.warn('GPU solver unavailable, using CPU', e);
  gpuWhy = (e as Error).message || String(e);
  gpu = null;
}

const view: ViewOpts & { three: boolean } = { fixedOnly: false, strength: 1.2, showCreases: true, shadeLayers: false, flip: false, showPress: false, showBleach: true, three: false };
try { view.three = localStorage.getItem('tiedyer.view3d') === '1'; } catch { /* ignore */ }
const v2dBtn = document.getElementById('v2d') as HTMLButtonElement;
const v3dBtn = document.getElementById('v3d') as HTMLButtonElement;
function setThree(on: boolean): void {
  view.three = on && !!view3d;
  v2dBtn.classList.toggle('on', !view.three);
  v3dBtn.classList.toggle('on', view.three);
  try { localStorage.setItem('tiedyer.view3d', view.three ? '1' : '0'); } catch { /* ignore */ }
  if (view.three && view3d && bundle) { sync3d(bundle.px, bundle.py, bundle.pz, false); }
  // the look mode is orbit in 3D and inspect in 2D; dye and band carry over
  if (view.three && tool === 'inspect') setTool('orbit');
  else if (!view.three && tool === 'orbit') setTool('inspect');
  else setTool(tool); // refresh the labels and hint for the new view
  dirty = true;
  lastFlatKey = '';
  last3dKey = '';
}
v2dBtn.addEventListener('click', () => setThree(false));
// tapping 3D while already in 3D fits the bundle back in view
v3dBtn.addEventListener('click', () => { if (view.three) { view3d?.frame(); dirty = true; } else setThree(true); });
// Mode switch on the bundle view: Dye (a drag squirts), Band (taps tie a band, a drag
// orbits in 3D) or the look mode, which orbits in 3D and inspects the layers in 2D.
// Right/middle drag, modifiers and the wheel always orbit/pan/zoom; two fingers pan and pinch-zoom.
const modeBtns = {
  dye: document.getElementById('modeDye') as HTMLButtonElement,
  band: document.getElementById('modeBand') as HTMLButtonElement,
  look: document.getElementById('modeLook') as HTMLButtonElement,
};
modeBtns.dye.addEventListener('click', () => setTool('dye'));
modeBtns.band.addEventListener('click', () => setTool('band'));
modeBtns.look.addEventListener('click', () => setTool(is3d() ? 'orbit' : 'inspect'));

type Tool = 'inspect' | 'dye' | 'band' | 'fold' | 'centre' | 'orbit';
let tool: Tool = 'dye';
/** r: squirt radius, cm; bandW: width of a rubber band, cm */
const brush = { r: 3, amount: 0.8, pen: 10, dye: 0, flow: 1, bandW: 1 };

/** A squirt still being poured: while the button stays down on the spot, its soak grows
 *  by `flow` × the soak setting per second and the squirt is re-applied from the snapshot
 *  taken before it, so the liquid front keeps moving down through the layers. */
let hold: { stroke: Stroke; pen0: number; snap: Float32Array[]; wet: Float32Array; load: Float32Array; t0: number } | null = null;
const HOLD_MAX_PEN = 400;
let playing = false;
const budgetMs = 8;
let stepsPerFrame = 20;
/** set whenever something on screen changed; the frame loop only redraws then */
let dirty = true;
/** set when the dye image must be regenerated (steps, strokes, colour options) */
let dirtyDye = true;
let texVersion = 0;
let uploadedTex = -1;
let geomVersion = 0;
let last3dKey = '';
let lastHoverKey = '';
let lastFlatKey = '';

let foldDraft: Vec2[] = [];

/** The fold line being drawn: first click fixes a point, the pointer sets the angle
 *  (second click fixes it), then the pointer picks the side that moves. */
function foldDraftLine(): { p: Vec2; d: Vec2; moveSign?: 1 | -1 } | null {
  if (tool !== 'fold' || plan.mode !== 'fold' || !foldDraft.length) return null;
  const a = foldDraft[0];
  const b = foldDraft.length > 1 ? foldDraft[1] : hoverFolded;
  if (!b || dist(a, b) < 1e-6) return null;
  const d = normalize({ x: b.x - a.x, y: b.y - a.y });
  let moveSign: 1 | -1 | undefined;
  if (foldDraft.length > 1 && hoverFolded) {
    const s = side(a, d, hoverFolded);
    if (Math.abs(s) > 1e-6) moveSign = s > 0 ? 1 : -1;
  }
  return { p: a, d, moveSign };
}
/** One click of the fold tool at bundle point p: first two fix the line, the third picks the side. */
function foldClick(p: Vec2, under: boolean): void {
  if (foldDraft.length < 2) {
    foldDraft.push(p);
  } else {
    const a = foldDraft[0], d = normalize({ x: foldDraft[1].x - a.x, y: foldDraft[1].y - a.y });
    const s = side(a, d, p);
    if (Math.abs(s) > 1e-6 && dist(foldDraft[0], foldDraft[1]) > 1e-6) {
      addFolds([{ p: a, d, moveSign: s > 0 ? 1 : -1, under, label: undefined }]);
    }
    foldDraft = [];
  }
  dirty = true;
}
/** The band being tied, the same way a fold line is drawn: the first tap fixes a point,
 *  the pointer sets the angle, the second tap ties it. A band is a straight strip right
 *  around the bundle (a slab standing on the table), squeezing every layer it crosses. */
let bandDraft: Vec2[] = [];
function bandDraftLine(): { p: Vec2; d: Vec2 } | null {
  if (tool !== 'band' || !bandDraft.length) return null;
  const a = bandDraft[0], b = hoverFolded;
  if (!b || dist(a, b) < 1e-6) return null;
  return { p: a, d: normalize({ x: b.x - a.x, y: b.y - a.y }) };
}
function bandClick(p: Vec2): void {
  dirty = true;
  if (!bandDraft.length) { bandDraft = [p]; return; }
  const a = bandDraft[0];
  bandDraft = [];
  if (dist(a, p) < 0.2) return; // the same spot twice gives no angle
  const d = normalize({ x: p.x - a.x, y: p.y - a.y });
  tap();
  plan.bands.push({ kind: 'slab', p: [a.x, a.y, 0], n: [-d.y, d.x, 0], w: brush.bandW });
  pressChanged();
}
/** a slab standing on the table, i.e. a band tied straight across the bundle (seen from above, a strip) */
type SlabBand = Extract<BandStamp, { kind: 'slab' }>;
const isUpright = (b: BandStamp): b is SlabBand => b.kind === 'slab' && Math.abs(b.n[2]) < 1e-3;
/** the bundle's bounding box in bundle cm, cached per geometry */
let boxCache: { v: number; x0: number; x1: number; y0: number; y1: number; z1: number } | null = null;
function bundleBox(): { x0: number; x1: number; y0: number; y1: number; z1: number } | null {
  if (!bundle) return null;
  if (boxCache && boxCache.v === geomVersion) return boxCache;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z1 = 0;
  const { px, py, pz, valid } = bundle;
  for (let i = 0; i < px.length; i++) {
    if (!valid[i]) continue;
    if (px[i] < x0) x0 = px[i]; if (px[i] > x1) x1 = px[i];
    if (py[i] < y0) y0 = py[i]; if (py[i] > y1) y1 = py[i];
    if (pz[i] > z1) z1 = pz[i];
  }
  if (!isFinite(x0)) return null;
  boxCache = { v: geomVersion, x0, x1, y0, y1, z1 };
  return boxCache;
}
/** the stretch of the line through p along d that crosses the bundle, plus a margin, as its two ends */
function lineAcross(p: Vec2, d: Vec2, margin = 1): [Vec2, Vec2] | null {
  const b = bundleBox();
  if (!b) return null;
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
    const t = (x - p.x) * d.x + (y - p.y) * d.y;
    lo = Math.min(lo, t); hi = Math.max(hi, t);
  }
  lo -= margin; hi += margin;
  return [{ x: p.x + d.x * lo, y: p.y + d.y * lo }, { x: p.x + d.x * hi, y: p.y + d.y * hi }];
}
/** scratch layer for bands on the 2D bundle, clipped to the cloth */
const bandLayer = document.createElement('canvas');
/** the bands last handed to the 3D view */
let last3dBands = '';

let hoverFolded: Vec2 | null = null;
let hoverFlat: Vec2 | null = null;
let dragging = false;
/** strokes on the plan when the current one-finger drag began (a second finger takes back what it laid down) */
let dragStrokes0 = 0;
let lastStamp: Vec2 | null = null;

let saveTimer: number | undefined;
function touched(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, serializePlan(plan)); } catch { /* ignore */ }
  }, 400);
}

function replay(): void {
  sim.setBase(plan);
  sim.resetDye();
  const fp = footprintOracle();
  for (const s of plan.strokes) sim.applyStroke(s, plan.params, fp);
  gpu?.upload();
  dirty = true;
  dirtyDye = true;
}

function pressChanged(): void {
  sim.rebuildPress(plan.bands, plan.params);
  gpu?.uploadStatic();
  replay();
  touched();
}

function doSteps(n: number): void {
  if (gpu) gpu.step(plan.params, n);
  else for (let i = 0; i < n; i++) sim.step(plan.params);
  dirty = true;
  dirtyDye = true;
}

function rebuildGeometry(): void {
  if (plan.mode === 'twist') { rebuildTwist(); return; }
  twistRun++; liveCloth = null; twistStatus = '';
  faces = buildFaces(plan.W, plan.H, plan.folds);
  bundle = flatFoldBundle(sim.dims(), faces, plan.thickness);
  finishGeometry();
  refreshFoldList();
}

function finishGeometry(): void {
  sim.setBundle(bundle!);
  sync3d(bundle!.px, bundle!.py, bundle!.pz, true);
  sim.rebuildPress(plan.bands, plan.params);
  gpu?.uploadStatic();
  replay();
  touched();
}

/** visibility oracle for 3D strokes */
function footprintOracle(): ((p: Vec3, d: Vec3, r: number) => { ids: Int32Array; dist: Float32Array }) | undefined {
  return view3d ? (p, d, r) => view3d!.footprint(p, d, r) : undefined;
}

function rebuildTwist(): void {
  const run = ++twistRun;
  faces = [];
  bundle = null;
  twistStatus = 'starting';
  dirty = true;
  twistWorker.postMessage({ id: run, W: plan.W, H: plan.H, N: plan.N, tp: plan.twist, dims: sim.dims() });
}

twistWorker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.id !== twistRun) return; // superseded run
  if (m.type === 'progress') {
    const first = !liveCloth;
    liveCloth = m.view;
    sync3d(m.view.x, m.view.y, m.view.z, first);
    twistStatus = `${m.phase} ${(m.frac * 100).toFixed(0)}%`;
    dirty = true;
  } else if (m.type === 'done') {
    liveCloth = null;
    twistStatus = '';
    bundle = makeClothBundle(m.view, m.bundle);
    finishGeometry();
    if (pendingSteps > 0) { doSteps(pendingSteps); pendingSteps = 0; }
    dirty = true;
  }
};

function setMode(m: Mode): void {
  if (plan.mode === m) return;
  plan.mode = m;
  if (m === 'twist' && plan.N > 161) plan.N = 101;
  if (m === 'fold' && plan.N < 120) plan.N = 240;
  refreshModeUI();
  reconfigure();
}

function reconfigure(): void {
  sim.configure(plan);
  gpu?.resize();
  rebuildGeometry();
}

function addFolds(lines: FoldLine[]): void {
  plan.folds.push(...lines);
  rebuildGeometry();
}

function addFoldsSequential(gen: (faces: Face[]) => FoldLine[]): void {
  // presets compute lines from the current folded bbox; apply them one at a time
  const lines = gen(faces);
  addFolds(lines);
}

// ---------------------------------------------------------------------------
// UI helpers

type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof val === 'function') e.addEventListener(k.slice(2), val as EventListener);
    else if (k === 'class') e.className = String(val);
    else if (typeof val === 'boolean') { if (val) e.setAttribute(k, ''); }
    else e.setAttribute(k, String(val));
  }
  for (const c of children) e.append(c);
  return e;
}
const row = (...children: (Node | string)[]) => el('div', { class: 'row' }, ...children);
/** label, slider and value on one line, in fixed columns so every slider lines up */
const sliderRow = (label: string, input: HTMLElement, val: HTMLElement) => el('div', { class: 'row slide' }, el('label', { title: label }, label), input, val);
const btn = (label: string, onclick: () => void, cls = '') => el('button', { class: cls, onclick }, label);

/** controls re-read their value from the plan when it is replaced (demos, Load, New) */
const syncers: (() => void)[] = [];
function syncControls(): void { for (const s of syncers) s(); }

function slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt = (v: number) => v.toFixed(2)): HTMLElement {
  const val = el('span', { class: 'val' }, fmt(get()));
  const input = el('input', { type: 'range', min, max, step, value: get() }) as HTMLInputElement;
  input.addEventListener('input', () => { set(parseFloat(input.value)); val.textContent = fmt(parseFloat(input.value)); });
  syncers.push(() => { input.value = String(get()); val.textContent = fmt(get()); });
  return sliderRow(label, input, val);
}

/** Slider whose position is logarithmic in the value. */
function logSlider(label: string, min: number, max: number, get: () => number, set: (v: number) => void, fmt = (v: number) => v.toFixed(1), onChange?: () => void): HTMLElement {
  const lo = Math.log(min), hi = Math.log(max);
  const toPos = (v: number) => (Math.log(v) - lo) / (hi - lo);
  const val = el('span', { class: 'val' }, fmt(get()));
  const input = el('input', { type: 'range', min: 0, max: 1, step: 0.001, value: toPos(get()) }) as HTMLInputElement;
  input.addEventListener('input', () => { const v = Math.exp(lo + parseFloat(input.value) * (hi - lo)); set(v); val.textContent = fmt(v); });
  if (onChange) input.addEventListener('change', onChange);
  syncers.push(() => { input.value = String(toPos(get())); val.textContent = fmt(get()); });
  return sliderRow(label, input, val);
}

function numberInput(get: () => number, set: (v: number) => void, attrs: Attrs = {}): HTMLInputElement {
  const input = el('input', { type: 'number', value: get(), ...attrs }) as HTMLInputElement;
  input.addEventListener('change', () => set(parseFloat(input.value)));
  return input;
}

function checkbox(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = get();
  input.addEventListener('change', () => set(input.checked));
  syncers.push(() => { input.checked = get(); });
  return el('label', { class: 'row' }, input, label);
}

// ---------------------------------------------------------------------------
// Sidebar

const sideEl = document.getElementById('side')!;
const toolButtons: Record<Tool, HTMLButtonElement> = {} as never;
/** the GitHub link, kept from the page and moved into the panel title */
const ghLink = sideEl.querySelector('a.gh');
const HINTS: Record<Tool, string> = {
  inspect: 'hover to see every layer under the cursor · in 3D, drag to orbit',
  dye: 'drag to squirt dye (or bleach) · hold still to keep pouring, it soaks deeper',
  band: 'tap a point, move to set the angle, tap again to tie a band around the bundle · esc cancels',
  fold: 'click two points for the crease, then click the side that folds over (shift = fold under) · in 3D, click the bundle or the table; drag to orbit',
  centre: 'click the flat cloth where you pinch',
  orbit: 'drag to orbit · wheel or pinch to zoom · shift-drag to pan · choose Dye or Band to work on it',
};
let foldControls: HTMLElement;
let twistControls: HTMLElement;
let modeButtons: Record<Mode, HTMLButtonElement>;
let resRow: HTMLElement;
let thickRow: HTMLElement;
/**
 * Layer height while the slider moves: rescale the bundle heights, the 3D strokes and
 * bands, and re-mesh, without the voxel exposure and the stroke replay (those run on
 * release, in the full rebuild).
 */
function setThickness(v: number): void {
  const k = v / plan.thickness;
  if (!isFinite(k) || k === 1) return;
  plan.thickness = v;
  for (const s of plan.strokes) if (s.kind === 'brush3') s.p[2] *= k;
  for (const b of plan.bands) if (b.kind === 'slab') b.p[2] *= k;
  if (isFold(bundle)) {
    const pz = bundle.pz;
    for (let i = 0; i < pz.length; i++) pz[i] *= k;
    sync3d(bundle.px, bundle.py, pz, false);
  }
  dirty = true;
}
function refreshModeUI(): void {
  foldControls.hidden = plan.mode !== 'fold';
  twistControls.hidden = plan.mode !== 'twist';
  resRow.hidden = plan.mode !== 'fold';
  thickRow.hidden = plan.mode !== 'fold';
  for (const [k, b] of Object.entries(modeButtons)) b.classList.toggle('on', k === plan.mode);
}

const CURSOR: Record<Tool, string> = { inspect: 'help', dye: 'crosshair', band: 'crosshair', fold: 'crosshair', centre: 'crosshair', orbit: 'grab' };

function setTool(t: Tool): void {
  tool = t;
  foldDraft = [];
  bandDraft = [];
  dirty = true;
  modeBtns.look.textContent = is3d() ? 'Orbit' : 'Inspect';
  const cur = t === 'dye' || t === 'band' ? t : t === 'orbit' || t === 'inspect' ? 'look' : null;
  for (const [k, b] of Object.entries(modeBtns)) {
    b.classList.toggle('on', k === cur);
    b.setAttribute('aria-checked', String(k === cur));
    b.title = k === cur ? HINTS[t] + (is3d() && t === 'dye' ? ' · right-drag to orbit · two fingers pan and pinch-zoom' : '') : '';
  }
  foldedCanvas.style.cursor = CURSOR[t];
  for (const [k, b] of Object.entries(toolButtons)) b.classList.toggle('on', k === t);
}

const foldList = el('ol', { class: 'folds' });
/** the fold list, folded away until wanted; its heading carries the count */
const foldListSummary = el('summary', {}, 'Folds');
const foldListBox = el('details', { class: 'sub' }, foldListSummary, foldList);
function refreshFoldList(): void {
  foldListSummary.textContent = `Folds (${plan.folds.length})`;
  foldList.replaceChildren(
    ...plan.folds.map((f) => el('li', {}, f.label ?? `line (${f.p.x.toFixed(1)}, ${f.p.y.toFixed(1)}) ∠${((Math.atan2(f.d.y, f.d.x) * 180) / Math.PI).toFixed(0)}°${f.under ? ' under' : ''}`)),
  );
}

const swatchWrap = el('div', { class: 'swatches' });
const baseWrap = el('div', { class: 'swatches' });
const baseDepth = slider('base dye', 0.1, 1, 0.05, () => plan.baseAmount, (v) => { plan.baseAmount = v; replay(); touched(); });
/** the current dye in the bundle view's corner: its colour, or the bleach stripes; a tap
 *  on it opens the colour picker for that dye (the input takes the tap, as on the panel) */
const curSwatch = document.getElementById('curSwatch')!;
const curColor = document.getElementById('curColor') as HTMLInputElement;
curColor.addEventListener('input', () => {
  const d = plan.dyes[brush.dye];
  if (!d) return;
  d.color = curColor.value;
  curSwatch.style.background = d.color;
  dirty = true; dirtyDye = true; touched();
});
curColor.addEventListener('change', () => refreshSwatches());
function refreshCurSwatch(): void {
  const d = brush.dye === BLEACH ? null : plan.dyes[brush.dye];
  curSwatch.classList.toggle('bleach', !d);
  curSwatch.classList.toggle('on', !!d); // 'on' lets the colour input take the tap
  curSwatch.style.background = d ? d.color : '';
  curSwatch.title = d ? `${d.name} · tap to change its colour` : 'Bleach';
  if (d) curColor.value = d.color;
}

function refreshSwatches(): void {
  syncControls();
  refreshCurSwatch();
  const bleach = el('div', { class: 'swatch bleach' + (brush.dye === BLEACH ? ' on' : ''), title: 'bleach: removes dye instead of adding it' }, 'BL');
  bleach.addEventListener('click', () => { brush.dye = BLEACH; refreshSwatches(); });
  swatchWrap.replaceChildren(
    ...plan.dyes.map((d, k) => {
      // first click selects the dye; a click on the selected swatch opens the colour picker
      const color = el('input', { type: 'color', value: d.color, tabindex: -1, 'aria-label': `${d.name} colour` }) as HTMLInputElement;
      const sw = el('div', { class: 'swatch' + (k === brush.dye ? ' on' : ''), title: `${d.name} · click again to change the colour`, style: `background:${d.color}` }, color);
      color.addEventListener('input', () => { d.color = color.value; sw.style.background = d.color; dirty = true; dirtyDye = true; touched(); });
      color.addEventListener('change', () => refreshSwatches()); // picker closed: cloth swatches pick up the new colour
      sw.addEventListener('click', (ev) => {
        if (brush.dye !== k) { brush.dye = k; refreshSwatches(); return; }
        if (ev.target === color) return; // a tap on the input itself: the browser opens the picker
        if (typeof color.showPicker === 'function') { try { color.showPicker(); return; } catch { /* fall through */ } }
        color.click();
      });
      return sw;
    }),
    bleach,
  );
  // cloth colour: white, or one of the dyes fixed uniformly before folding
  const pick = (k: number) => { plan.base = k; replay(); touched(); refreshSwatches(); };
  const white = el('div', { class: 'swatch base white' + (plan.base < 0 ? ' on' : ''), title: 'undyed (white) cloth' });
  white.addEventListener('click', () => pick(-1));
  baseWrap.replaceChildren(
    white,
    ...plan.dyes.map((d, k) => {
      const sw = el('div', { class: 'swatch base' + (plan.base === k ? ' on' : ''), title: `cloth pre-dyed ${d.name}`, style: `background:${d.color}` });
      sw.addEventListener('click', () => pick(k));
      return sw;
    }),
  );
  baseDepth.hidden = plan.base < 0;
}

const playBtn = btn('▶ Play', () => setPlaying(!playing));

function buildSidebar(): void {
  const pleats = numberInput(() => 6, () => {}, { min: 2, max: 40, step: 1, title: 'number of pleats' }) as HTMLInputElement;
  pleats.value = '6';
  const zigAxis = el('select', { title: 'which way the strip runs' }, el('option', { value: 'y' }, 'along y'), el('option', { value: 'x' }, 'along x')) as HTMLSelectElement;
  const zigStyle = el('select', { title: 'triangle shape: equilateral 60°, right-angled 45°, or squares' },
    el('option', { value: 'equilateral' }, '60°'),
    el('option', { value: 'right' }, '45°'),
    el('option', { value: 'square' }, 'square'),
  ) as HTMLSelectElement;
  const resSel = el('select', {}, ...[120, 180, 240, 320, 400, 480, 640, 800].map((n) => el('option', { value: n }, `${n} texels`))) as HTMLSelectElement;
  resSel.value = String(plan.N);
  const partSel = el('select', {}, ...[61, 81, 101, 121, 161].map((n) => el('option', { value: n }, `${n}² particles`))) as HTMLSelectElement;
  partSel.value = String([61, 81, 101, 121, 161].includes(plan.N) ? plan.N : 101);
  partSel.addEventListener('change', () => { plan.N = parseInt(partSel.value); reconfigure(); });
  toolButtons.fold = btn('Draw fold line', () => setTool('fold'));
  const cx = numberInput(() => plan.twist.c.x, (v) => { plan.twist.c.x = v; touched(); }, { min: 0, max: 300, step: 0.5 });
  const cy = numberInput(() => plan.twist.c.y, (v) => { plan.twist.c.y = v; touched(); }, { min: 0, max: 300, step: 0.5 });
  const refreshCentre = () => { cx.value = String(plan.twist.c.x); cy.value = String(plan.twist.c.y); };
  toolButtons.centre = btn('Pick', () => setTool('centre'));
  const styleSel = el('select', {}, el('option', { value: 'mesh' }, 'mesh'), el('option', { value: 'splat' }, 'splats')) as HTMLSelectElement;
  styleSel.addEventListener('change', () => { if (view3d) view3d.style = styleSel.value as 'mesh' | 'splat'; dirty = true; });
  modeButtons = { fold: btn('Fold', () => setMode('fold')), twist: btn('Twist', () => setMode('twist')) };
  resRow = row(el('label', {}, 'resolution'), resSel);
  // the ready-made fold patterns, folded away under their own heading; your own fold
  // lines, undo and the fold list stay in view
  foldControls = el('div', {},
      el('details', { class: 'sub' }, el('summary', {}, 'Regular folds'),
        row(el('label', {}, 'accordion'), pleats,
          btn('X', () => addFoldsSequential((f) => accordionFolds(f, 'x', parseInt(pleats.value)))),
          btn('Y', () => addFoldsSequential((f) => accordionFolds(f, 'y', parseInt(pleats.value))))),
        row(btn('Zigzag', () => addFoldsSequential((f) => zigzagFolds(f, zigAxis.value as Axis, zigStyle.value as 'equilateral' | 'right' | 'square'))),
          zigAxis, zigStyle),
        row(el('label', {}, 'diagonal'),
          btn('╲', () => addFoldsSequential((f) => [diagonalFold(f, 'main')])),
          btn('╱', () => addFoldsSequential((f) => [diagonalFold(f, 'anti')])))),
      row(toolButtons.fold),
      row(btn('Undo fold', () => { plan.folds.pop(); rebuildGeometry(); }),
        btn('Clear folds', () => { plan.folds = []; rebuildGeometry(); })),
      foldListBox);
  twistControls = el('div', {},
      row(el('label', {}, 'particles'), partSel),
      row(el('label', {}, 'pinch at'), cx, '×', cy, toolButtons.centre),
      slider('turns', 0.5, 6, 0.25, () => plan.twist.turns, (v) => { plan.twist.turns = v; touched(); }),
      slider('pinch cm', 0.5, 5, 0.25, () => plan.twist.pinch, (v) => { plan.twist.pinch = v; touched(); }),
      slider('friction', 0, 0.2, 0.005, () => plan.twist.friction, (v) => { plan.twist.friction = v; touched(); }, (v) => v.toFixed(3)),
      slider('pat flat cm', 0, 6, 0.25, () => plan.twist.flatten, (v) => { plan.twist.flatten = v; touched(); }),
      row(btn('Run twist', () => rebuildTwist())));
  (window as unknown as { refreshCentre: () => void }).refreshCentre = refreshCentre;

  const stepCounter = el('span', { class: 'val' }, '0');
  setInterval(() => { stepCounter.textContent = String(sim.t); }, 250);

  /** Presets dropdown: picking one loads that demo, then the menu shows its title again. */
  const presetSelect = (): HTMLSelectElement => {
    const presets: Record<string, () => void> = {
      kikko: () => { plan = demoPlan(); refreshModeUI(); reconfigure(); refreshSwatches(); doSteps(DEMO_STEPS); },
      spiral: () => { plan = spiralDemoPlan(); pendingSteps = DEMO_STEPS; refreshModeUI(); reconfigure(); refreshSwatches(); },
      bleach: () => { plan = bleachDemoPlan(); refreshModeUI(); reconfigure(); refreshSwatches(); doSteps(DEMO_STEPS); },
    };
    const sel = el('select', { title: 'Load a ready-made fold and dye' },
      el('option', { value: '', disabled: true, selected: true, hidden: true }, 'Presets'),
      el('option', { value: 'kikko' }, 'Kikko'),
      el('option', { value: 'spiral' }, 'Spiral'),
      el('option', { value: 'bleach' }, 'Bleach')) as HTMLSelectElement;
    sel.addEventListener('change', () => { presets[sel.value]?.(); sel.value = ''; });
    return sel;
  };
  sideEl.replaceChildren(
    // title row, level with ☰: the app name, then the GitHub link and Help at the right edge
    el('h1', {}, 'tiedyer',
      ...(ghLink ? [ghLink] : []),
      el('button', { class: 'help-btn', onclick: openHelp, title: 'How Tie Dyer works (?)' }, 'Help')),
    row(
      btn('New', () => { plan = defaultPlan(); refreshModeUI(); reconfigure(); refreshSwatches(); }),
      presetSelect(),
      btn('Save', savePlan),
      btn('Load', loadPlanFile),
    ),
    el('details', { open: true },
      el('summary', {}, 'Cloth'),
      row(el('label', {}, 'size cm'),
        numberInput(() => plan.W, (v) => { plan.W = v; reconfigure(); }, { min: 5, max: 300, step: 1 }),
        '×',
        numberInput(() => plan.H, (v) => { plan.H = v; reconfigure(); }, { min: 5, max: 300, step: 1 })),
      resRow,
      row(el('label', {}, 'colour'), baseWrap),
      baseDepth,
    ),
    el('details', { open: true },
      el('summary', {}, 'Shape'),
      el('div', { class: 'row tools' }, modeButtons.fold, modeButtons.twist),
      foldControls,
      twistControls,
    ),
    el('details', { open: true },
      el('summary', {}, 'Dye & bindings'),
      swatchWrap,
      slider('brush cm', 0.5, 20, 0.5, () => brush.r, (v) => { brush.r = v; dirty = true; }, (v) => v.toFixed(1)),
      slider('amount', 0.05, 2, 0.05, () => brush.amount, (v) => { brush.amount = v; }),
      logSlider('soak layers', 0.5, 150, () => brush.pen, (v) => { brush.pen = v; }, (v) => v < 10 ? v.toFixed(1) : v.toFixed(0)),
      slider('hold flow', 0, 3, 0.1, () => brush.flow, (v) => { brush.flow = v; }, (v) => v > 0 ? `${v.toFixed(1)}×/s` : 'off'),
      slider('build-up', 0, 5, 0.25, () => plan.params.buildup, (v) => { plan.params.buildup = v; touched(); }, (v) => v > 0 ? `+${v.toFixed(2)}` : 'off'),
      row(btn('Dip whole bundle', () => { addStroke({ kind: 'dip', dye: brush.dye, amount: brush.amount, pen: brush.pen }); }),
        btn('Undo stroke', () => { plan.strokes.pop(); replay(); touched(); })),
      row(btn('Clear dye', () => { plan.strokes = []; replay(); touched(); }),
        btn('Clear bands', () => { plan.bands = []; pressChanged(); })),
      slider('band width cm', 0.3, 5, 0.1, () => brush.bandW, (v) => { brush.bandW = v; dirty = true; }, (v) => v.toFixed(1)),
      row(btn('Undo band', () => { if (plan.bands.length) { plan.bands.pop(); pressChanged(); } })),
    ),
    el('details', { open: true },
      el('summary', {}, 'Batch (diffusion)'),
      row(playBtn, btn('Step ×20', () => doSteps(20)),
        btn('Rewind', () => { replay(); }), el('label', {}, 't'), stepCounter),
      slider('speed', 1, 200, 1, () => stepsPerFrame, (v) => { stepsPerFrame = v; }, (v) => `${v}/f`),
      slider('spread', 0, 0.2, 0.005, () => plan.params.dPlane, (v) => { plan.params.dPlane = v; touched(); }, (v) => v.toFixed(3)),
      slider('thru layers', 0, 0.55, 0.005, () => plan.params.dZ, (v) => { plan.params.dZ = v; touched(); }, (v) => v.toFixed(3)),
      slider('fixing rate', 0, 0.2, 0.002, () => plan.params.adsorb, (v) => { plan.params.adsorb = v; touched(); }, (v) => v.toFixed(3)),
      slider('capacity', 0.1, 3, 0.05, () => plan.params.capacity, (v) => { plan.params.capacity = v; touched(); }),
      slider('band halo cm', 0.1, 8, 0.1, () => plan.params.pressRadius, (v) => { plan.params.pressRadius = v; pressChanged(); }, (v) => v.toFixed(1)),
      slider('band leak', 0, 1, 0.02, () => plan.params.pressFloor, (v) => { plan.params.pressFloor = v; pressChanged(); }),
      slider('sideways wick', 0, 1, 0.05, () => plan.params.lateral, (v) => { plan.params.lateral = v; replay(); touched(); }),
      slider('bleach power', 0, 0.3, 0.005, () => plan.params.bleach, (v) => { plan.params.bleach = v; touched(); }, (v) => v.toFixed(3)),
      slider('bleach fade', 0, 0.05, 0.001, () => plan.params.bleachDecay, (v) => { plan.params.bleachDecay = v; touched(); }, (v) => v.toFixed(3)),
    ),
    el('details', { open: true },
      el('summary', {}, 'View'),
      row(el('label', {}, '3D style'), styleSel),
      (thickRow = logSlider('layer height cm', 0.01, 1, () => plan.thickness, setThickness, (v) => v.toFixed(2), () => { rebuildGeometry(); touched(); })),
      checkbox('Rinse (show fixed dye only)', () => view.fixedOnly, (v) => { view.fixedOnly = v; dirty = true; dirtyDye = true; }),
      checkbox('View & paint underside (2D)', () => view.flip, (v) => { view.flip = v; dirty = true; }),
      checkbox('Show creases on flat cloth', () => view.showCreases, (v) => { view.showCreases = v; dirty = true; }),
      checkbox('Shade by layer count', () => view.shadeLayers, (v) => { view.shadeLayers = v; dirty = true; }),
      checkbox('Show binding pressure on flat', () => view.showPress, (v) => { view.showPress = v; dirty = true; dirtyDye = true; }),
      checkbox('Tint free bleach', () => view.showBleach, (v) => { view.showBleach = v; dirty = true; dirtyDye = true; }),
      slider('colour depth', 0.2, 4, 0.1, () => view.strength, (v) => { view.strength = v; dirty = true; dirtyDye = true; }, (v) => v.toFixed(1)),
    ),
    el('details', { open: true },
      el('summary', {}, 'Export'),
      (() => {
        const sel = el('select', { title: 'Pixel size of the long side of the PNG the Image button saves. Detail comes from the resolution setting under Cloth.' },
          ...[1024, 2048, 4096].map((n) => el('option', { value: n }, `${n} px`))) as HTMLSelectElement;
        sel.value = String(exportPx);
        sel.addEventListener('change', () => { exportPx = parseInt(sel.value); try { localStorage.setItem('tiedyer.exportPx', sel.value); } catch { /* ignore */ } });
        return row(el('label', {}, 'image size'), sel);
      })(),
      row(el('button', { onclick: saveImage, title: 'Save the unfolded cloth as a PNG at the image size above' }, 'Image (PNG)'),
        el('button', { onclick: saveGlb, title: 'Export the folded bundle as a 3D model (glTF binary) with the dye as its texture' }, '3D model (GLB)')),
    ),
  );
  resSel.addEventListener('change', () => { plan.N = parseInt(resSel.value); reconfigure(); });
  refreshSwatches();
  refreshModeUI();
  setTool('dye');
}

const helpDialog = document.getElementById('help') as HTMLDialogElement;
function openHelp(): void { if (!helpDialog.open) helpDialog.showModal(); }
document.getElementById('help-close')!.addEventListener('click', () => helpDialog.close());
// click on the backdrop closes it (the dialog element itself is the click target there)
helpDialog.addEventListener('click', (ev) => { if (ev.target === helpDialog) helpDialog.close(); });

function savePlan(): void {
  deliverFile('tiedye-plan.json', toBase64(serializePlan(plan)), 'application/json', 'Tie-dye plan');
}

/** pixel size of the long side of an exported image */
let exportPx = 2048;
try { exportPx = parseInt(localStorage.getItem('tiedyer.exportPx') ?? '') || 2048; } catch { /* ignore */ }

/** Export the unfolded pattern as a PNG, `exportPx` on the long side. */
async function saveImage(): Promise<void> {
  renderOnce();
  const c = renderer.exportFlat(sim, faces, view, exportPx);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) return;
  deliverFile(`tiedye-${c.width}x${c.height}.png`, new Uint8Array(await blob.arrayBuffer()), 'image/png', 'Tie-dye pattern');
}

/** The bundle as a .glb: the 3D view's mesh with the dye image as its texture. */
async function buildGlb(): Promise<Uint8Array | null> {
  if (!view3d) return null;
  renderOnce();
  const mesh = view3d.exportMesh();
  if (!mesh) return null;
  // copy the dye image (which may live on a WebGL canvas) through a 2D canvas to get a PNG
  const c = document.createElement('canvas');
  c.width = renderer.src.width; c.height = renderer.src.height;
  c.getContext('2d')!.drawImage(renderer.src, 0, 0);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) return null;
  const png = new Uint8Array(await blob.arrayBuffer());
  return encodeGlb(mesh, png, plan.mode === 'twist' ? 'twist' : 'bundle');
}

async function saveGlb(): Promise<void> {
  const glb = await buildGlb();
  if (glb) deliverFile('tiedye-bundle.glb', glb, 'model/gltf-binary', 'Tie-dye bundle');
}

function loadPlanFile(): void {
  const input = el('input', { type: 'file', accept: 'application/json,.json' }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      plan = parsePlan(await f.text());
      refreshModeUI();
      reconfigure();
      refreshSwatches();
    } catch (e) { console.error('load failed', e); }
  });
  input.click();
}

// ---------------------------------------------------------------------------
// Strokes and bindings

/** how many layers the last squirt reached, for the readout */
let lastReach = '';
function noteReach(): void {
  if (!isFold(bundle)) { lastReach = ''; return; }
  const seen = new Set<number>(), t = sim.touched, d = bundle.depthTop;
  for (let i = 0; i < t.length; i++) if (t[i]) seen.add(d[i]);
  lastReach = seen.size ? `last squirt reached ${seen.size} of ${bundle.maxLayers} layers` : '';
}

function addStroke(s: Stroke, holdable = false): void {
  tap();
  plan.strokes.push(s);
  gpu?.download();
  hold = null;
  if (holdable && s.kind !== 'dip') {
    hold = { stroke: s, pen0: s.pen, snap: [...sim.f, sim.bl].map((a) => a.slice()), wet: sim.wet.slice(), load: sim.load.slice(), t0: performance.now() };
  }
  sim.applyStroke(s, plan.params, footprintOracle());
  noteReach();
  gpu?.upload();
  dirty = true;
  dirtyDye = true;
  touched();
}

function paintSide(): 'top' | 'bottom' {
  return view.flip ? 'bottom' : 'top';
}

function stampAt(p: Vec2): void {
  if (tool === 'dye') {
    addStroke({ kind: 'brush', p, r: brush.r, dye: brush.dye, amount: brush.amount, side: paintSide(), pen: brush.pen }, true);
  }
}

/** 3D hit under a pointer event on the folded overlay: texel index and position (cached per pointer position + camera) */
type Hit = { id: number; p: Vec3; d: Vec3; x: number; y: number } | null;
let hitCache: { key: string; hit: Hit } | null = null;
function hit3d(ev: PointerEvent | MouseEvent): Hit {
  if (!view3d) return null;
  const r = foldedCanvas.getBoundingClientRect();
  const k = folded3dCanvas.width / Math.max(1, r.width);
  const x = (ev.clientX - r.left) * k, y = (ev.clientY - r.top) * k;
  const c = view3d.cam;
  const key = `${x | 0},${y | 0},${c.az},${c.el},${c.dist},${c.target.join(',')},${geomVersion},${folded3dCanvas.width}`;
  if (hitCache && hitCache.key === key) return hitCache.hit;
  const pk = view3d.pickPoint(x, y);
  const hit: Hit = !pk ? null : { id: pk.id, p: pk.p, d: view3d.rayDir(x, y), x, y };
  hitCache = { key, hit };
  return hit;
}

/** Fold lines live on the xy plane: the point under the cursor is the picked surface
 *  point dropped onto that plane, or, off the bundle, where the ray meets the table. */
function foldPoint3d(ev: PointerEvent | MouseEvent): Vec2 | null {
  if (!view3d) return null;
  const h = hit3d(ev);
  if (h) return { x: h.p[0], y: h.p[1] };
  const r = foldedCanvas.getBoundingClientRect();
  const k = folded3dCanvas.width / Math.max(1, r.width);
  const d = view3d.rayDir((ev.clientX - r.left) * k, (ev.clientY - r.top) * k);
  const e = view3d.eyePos();
  if (Math.abs(d[2]) < 1e-6) return null;
  const t = -e[2] / d[2];
  if (t <= 0) return null;
  return { x: e[0] + d[0] * t, y: e[1] + d[1] * t };
}
/** a press with the fold tool in 3D: a tap places a point, a drag orbits */
let foldPress: { x: number; y: number; p: Vec2 | null; under: boolean } | null = null;

function stampAt3d(ev: PointerEvent): void {
  const h = hit3d(ev);
  if (!h) return;
  if (tool === 'dye') {
    addStroke({ kind: 'brush3', p: h.p, d: h.d, r: brush.r, dye: brush.dye, amount: brush.amount, pen: brush.pen }, true);
  }
}

/** camera gesture state */
let gesture: { kind: 'orbit' | 'pan'; x: number; y: number } | null = null;
const touches = new Map<number, { x: number; y: number }>();
let pinchDist = 0;

// ---------------------------------------------------------------------------
// Mouse

foldedCanvas.addEventListener('pointermove', (ev) => {
  if (touches.has(ev.pointerId)) touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (touches.size >= 2 && view3d) {
    // two-finger orbit + pinch zoom
    const [a, b] = [...touches.values()];
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, d = Math.hypot(a.x - b.x, a.y - b.y);
    // two fingers: drag pans, pinch zooms (one finger orbits when the paint toggle is off)
    if (gesture) { const k = folded3dCanvas.width / foldedCanvas.clientWidth; view3d.pan((cx - gesture.x) * k, (cy - gesture.y) * k); gesture.x = cx; gesture.y = cy; }
    if (pinchDist > 0) view3d.zoom(pinchDist / d);
    pinchDist = d;
    dirty = true;
    return;
  }
  if (gesture && view3d) {
    if (gesture.kind === 'orbit') view3d.orbit(ev.clientX - gesture.x, ev.clientY - gesture.y);
    else view3d.pan((ev.clientX - gesture.x) * folded3dCanvas.width / foldedCanvas.clientWidth, (ev.clientY - gesture.y) * folded3dCanvas.width / foldedCanvas.clientWidth);
    gesture.x = ev.clientX; gesture.y = ev.clientY;
    dirty = true;
    return;
  }
  hoverFolded = renderer.foldedToCm(ev);
  if (is3d()) {
    hover3d = ev;
    if (tool === 'fold' || tool === 'band') { hoverFolded = foldPoint3d(ev); dirty = true; }
    if (dragging && tool === 'dye') {
      const h = hit3d(ev);
      if (h && (!lastStamp3 || len3(sub3(lastStamp3, h.p)) >= brush.r * 0.35)) { stampAt3d(ev); lastStamp3 = h.p; }
    }
    return;
  }
  if (dragging && tool === 'dye') {
    if (!lastStamp || dist(lastStamp, hoverFolded) >= brush.r * 0.35) {
      stampAt(hoverFolded);
      lastStamp = hoverFolded;
    }
  }
});
let hover3d: PointerEvent | null = null;
let lastStamp3: Vec3 | null = null;
foldedCanvas.addEventListener('pointerleave', () => { hoverFolded = null; hover3d = null; });
foldedCanvas.addEventListener('wheel', (ev) => {
  if (!is3d() || !view3d) return;
  ev.preventDefault();
  view3d.zoom(Math.exp(ev.deltaY * 0.0015));
  dirty = true;
}, { passive: false });
for (const c of [flatCanvas, foldedCanvas]) {
  c.draggable = false;
  c.addEventListener('dragstart', (ev) => ev.preventDefault());
  c.addEventListener('contextmenu', (ev) => ev.preventDefault());
}
foldedCanvas.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  foldedCanvas.setPointerCapture(ev.pointerId);
  if (ev.pointerType === 'touch') {
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 2 && view3d && is3d()) {
      const [a, b] = [...touches.values()];
      gesture = { kind: 'pan', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      hover3d = null;
      // the first finger already squirted before the second arrived: take that back, this is a camera gesture
      if (dragging && plan.strokes.length > dragStrokes0) { plan.strokes.length = dragStrokes0; hold = null; replay(); touched(); }
      dragging = false; lastStamp = null; lastStamp3 = null;
      return;
    }
  }
  if (is3d() && view3d && (ev.button === 2 || ev.button === 1 || tool === 'orbit' || tool === 'inspect' || tool === 'fold' || tool === 'band' || ev.altKey || ev.ctrlKey || ev.shiftKey)) {
    gesture = { kind: ev.shiftKey || ev.button === 1 ? 'pan' : 'orbit', x: ev.clientX, y: ev.clientY };
    foldPress = ((tool === 'fold' && plan.mode === 'fold') || tool === 'band') && ev.button === 0 && !ev.altKey && !ev.ctrlKey
      ? { x: ev.clientX, y: ev.clientY, p: foldPoint3d(ev), under: ev.shiftKey } : null;
    if (!foldPress) hover3d = null;
    return;
  }
  if (ev.button !== 0) return;
  hoverFolded = renderer.foldedToCm(ev);
  const p = renderer.foldedToCm(ev);
  if (is3d()) {
    dragStrokes0 = plan.strokes.length;
    if (tool === 'dye') { dragging = true; const h = hit3d(ev); lastStamp3 = h ? h.p : null; stampAt3d(ev); }
    return;
  }
  if (tool === 'dye') {
    dragging = true;
    lastStamp = p;
    stampAt(p);
  } else if (tool === 'band') {
    bandClick(p);
  } else if (tool === 'fold' && plan.mode === 'fold') {
    foldClick(p, ev.shiftKey);
  }
});
const release = (ev: PointerEvent) => {
  touches.delete(ev.pointerId);
  if (touches.size < 2) pinchDist = 0;
  if (gesture) {
    gesture = null;
    // a tap (no drag) with the fold or band tool in 3D places a point
    if (foldPress) {
      const moved = Math.hypot(ev.clientX - foldPress.x, ev.clientY - foldPress.y);
      if (moved < 6 && foldPress.p) { if (tool === 'band') bandClick(foldPress.p); else foldClick(foldPress.p, foldPress.under); }
      foldPress = null;
    }
    return;
  }
  if (dragging) {
    dragging = false;
    lastStamp = null;
    lastStamp3 = null;
    if (hold) { hold = null; dirty = true; }
  }
};
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
flatCanvas.addEventListener('pointermove', (ev) => { hoverFlat = renderer.flatToCm(ev); });
flatCanvas.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  hoverFlat = renderer.flatToCm(ev);
  if (tool === 'centre' && plan.mode === 'twist') {
    plan.twist.c = { x: Math.round(hoverFlat.x * 2) / 2, y: Math.round(hoverFlat.y * 2) / 2 };
    (window as unknown as { refreshCentre: () => void }).refreshCentre();
    touched();
    dirty = true;
  }
});
flatCanvas.addEventListener('pointerleave', () => { hoverFlat = null; });

// Controls panel: a drawer over the views at every size; ☰ slides it in and out.
const appEl = document.getElementById('app')!;
document.getElementById('menu-btn')!.addEventListener('click', () => appEl.classList.toggle('menu-open'));
document.getElementById('backdrop')!.addEventListener('click', () => appEl.classList.remove('menu-open'));

// Split between the flat and folded views. The views sit side by side when their area
// is wider than tall and stack otherwise, decided from the area itself rather than the
// screen width, so rotating the device or hiding the panel keeps the same fraction.
const viewsEl = document.getElementById('views')!;
const flatViewEl = document.getElementById('flat-view')!;
const foldedViewEl = document.getElementById('folded-view')!;
const dividerEl = document.getElementById('divider')!;
const SPLIT_MIN = 0.15, SPLIT_MAX = 0.85;
/** fraction of the views area given to the flat cloth */
let split = 0.5;
try { const v = parseFloat(localStorage.getItem('tiedyer.split') ?? ''); if (v >= SPLIT_MIN && v <= SPLIT_MAX) split = v; } catch { /* ignore */ }
function setSplit(v: number): void {
  split = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v));
  flatViewEl.style.flexGrow = String(split);
  foldedViewEl.style.flexGrow = String(1 - split);
  try { localStorage.setItem('tiedyer.split', split.toFixed(3)); } catch { /* ignore */ }
  dirty = true;
}
setSplit(split);
new ResizeObserver(() => {
  const cols = viewsEl.clientWidth < viewsEl.clientHeight;
  viewsEl.classList.toggle('cols', cols);
  dividerEl.setAttribute('aria-orientation', cols ? 'horizontal' : 'vertical');
}).observe(viewsEl);
let splitDrag: { start: number; total: number; x?: number; y?: number } | null = null;
/** when the divider was last tapped without dragging, for the double tap that evens the split */
let lastDividerTap = 0;
dividerEl.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  const cols = viewsEl.classList.contains('cols');
  const a = flatViewEl.getBoundingClientRect(), b = foldedViewEl.getBoundingClientRect();
  splitDrag = cols ? { start: a.top, total: a.height + b.height } : { start: a.left, total: a.width + b.width };
  splitDrag.x = ev.clientX; splitDrag.y = ev.clientY;
  dividerEl.setPointerCapture(ev.pointerId);
  dividerEl.classList.add('drag');
});
dividerEl.addEventListener('pointermove', (ev) => {
  if (!splitDrag) return;
  const pos = viewsEl.classList.contains('cols') ? ev.clientY : ev.clientX;
  // the pointer sits mid-divider, 4px (half the 8px divider) past the flat view
  // a tap that barely moves is not a drag (it may be half of a double tap)
  if (Math.hypot(ev.clientX - (splitDrag.x ?? 0), ev.clientY - (splitDrag.y ?? 0)) < 6) return;
  setSplit((pos - splitDrag.start - 4) / splitDrag.total);
});
// a double tap (or double click) on the divider evens the split out again
const endSplitDrag = (ev: PointerEvent): void => {
  const tapped = splitDrag && ev.type === 'pointerup' && Math.hypot(ev.clientX - (splitDrag.x ?? 0), ev.clientY - (splitDrag.y ?? 0)) < 6;
  splitDrag = null;
  dividerEl.classList.remove('drag');
  if (!tapped) { lastDividerTap = 0; return; }
  const now = performance.now();
  if (now - lastDividerTap < 400) { setSplit(0.5); lastDividerTap = 0; } else lastDividerTap = now;
};
dividerEl.addEventListener('pointerup', endSplitDrag);
dividerEl.addEventListener('pointercancel', endSplitDrag);

window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).tagName === 'INPUT' || (ev.target as HTMLElement).tagName === 'SELECT') return;
  if (helpDialog.open) return; // the dialog handles esc itself
  if (ev.key === '?') { openHelp(); return; }
  if (ev.key === 'Escape') { foldDraft = []; bandDraft = []; dirty = true; }
  if (ev.key === ' ') { ev.preventDefault(); playBtn.click(); }
  if (ev.key === 'z') { plan.strokes.pop(); replay(); touched(); }
});

// ---------------------------------------------------------------------------
// Frame loop

const statusEl = document.getElementById('status')!;
document.getElementById('build-id')!.textContent = __BUILD__;

let frameCount = 0;
/** keep pouring the held squirt: grow its soak with time and re-apply it from the snapshot */
function pourHeld(): void {
  if (!hold || !dragging || brush.flow <= 0) return;
  const pen = Math.min(HOLD_MAX_PEN, hold.pen0 * (1 + brush.flow * (performance.now() - hold.t0) / 1000));
  if (pen < hold.stroke.pen * 1.02) return; // nothing worth re-wicking yet
  const s = hold.stroke;
  [...sim.f, sim.bl].forEach((a, k) => a.set(hold!.snap[k]));
  sim.wet.set(hold.wet);
  sim.load.set(hold.load);
  s.pen = pen;
  sim.applyStroke(s, plan.params, footprintOracle());
  noteReach();
  gpu?.upload();
  dirty = true;
  dirtyDye = true;
  touched();
}

function frame(): void {
  frameCount++;
  pourHeld();
  if (playing && !hold) {
    if (gpu) gpu.step(plan.params, stepsPerFrame);
    else {
      const t0 = performance.now();
      let n = 0;
      while (performance.now() - t0 < budgetMs && n < stepsPerFrame) { sim.step(plan.params); n++; }
    }
    dirty = true;
    dirtyDye = true;
    // auto-pause once the batch is done: almost no free dye left to move
    if (frameCount % 45 === 0 && batchDone()) setPlaying(false);
  }
  const hoverKey = `${hoverFlat?.x},${hoverFlat?.y},${hoverFolded?.x},${hoverFolded?.y},${foldDraft.length},${bandDraft.length},${hover3d?.clientX},${hover3d?.clientY}`;
  if (hoverKey !== lastHoverKey) { lastHoverKey = hoverKey; dirty = true; }
  const c1 = flatCanvas, c2 = foldedCanvas;
  if (c1.width !== Math.floor(c1.clientWidth * renderer.dpr) || c2.width !== Math.floor(c2.clientWidth * renderer.dpr)
    || c1.height !== Math.floor(c1.clientHeight * renderer.dpr) || c2.height !== Math.floor(c2.clientHeight * renderer.dpr)) dirty = true;
  if (dirty) {
    dirty = false;
    try { renderOnce(); } catch (e) {
      console.error('render failed', e);
      statusEl.textContent = `render error: ${(e as Error).message}`;
    }
  }
  requestAnimationFrame(frame);
}

/** scratch layer for the moving-side tint on the folded view */
const foldTint = document.createElement('canvas');

/** Live preview of the fold being drawn, on the unfolded cloth: every crease the line
 *  would make (one segment per face it crosses) and, once the side is known, the cloth
 *  that would move. */
function drawFoldPreviewFlat(draft: { p: Vec2; d: Vec2; moveSign?: 1 | -1 }): void {
  const ctx = flatCanvas.getContext('2d')!;
  const V = renderer.flatView, dpr = renderer.dpr;
  const { creases, moving } = foldPreview(faces, draft.p, draft.d, draft.moveSign);
  ctx.save();
  ctx.fillStyle = 'rgba(255,122,26,0.22)';
  ctx.beginPath();
  for (const poly of moving) {
    poly.forEach((q, i) => { const s = apply(V, q); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    ctx.closePath();
  }
  ctx.fill();
  ctx.strokeStyle = '#ff7a1a';
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.beginPath();
  for (const [a, b] of creases) { const s = apply(V, a), e = apply(V, b); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); }
  ctx.stroke();
  ctx.restore();
}

/** markers, brush cursor and band drag on the transparent canvas above the 3D view */
/** Bands on the 2D bundle: each straight band as the strip it squeezes, clipped to the
 *  cloth (on a scratch layer, so overlapping layers do not darken it), and the band
 *  being tied as an outline with its fixed point. */
function drawBands2d(ctx: CanvasRenderingContext2D, V: Mat): void {
  const dpr = renderer.dpr;
  const draft = tool === 'band' ? bandDraftLine() : null;
  const strips: { p: Vec2; d: Vec2; w: number }[] = [];
  for (const b of plan.bands) if (isUpright(b)) strips.push({ p: { x: b.p[0], y: b.p[1] }, d: { x: b.n[1], y: -b.n[0] }, w: b.w });
  const quad = (p: Vec2, d: Vec2, w: number): Vec2[] | null => {
    const ends = lineAcross(p, d, 3);
    if (!ends) return null;
    const n = { x: -d.y * w / 2, y: d.x * w / 2 };
    return [{ x: ends[0].x + n.x, y: ends[0].y + n.y }, { x: ends[1].x + n.x, y: ends[1].y + n.y }, { x: ends[1].x - n.x, y: ends[1].y - n.y }, { x: ends[0].x - n.x, y: ends[0].y - n.y }].map((q) => apply(V, q));
  };
  if (strips.length) {
    const c = ctx.canvas;
    if (bandLayer.width !== c.width || bandLayer.height !== c.height) { bandLayer.width = c.width; bandLayer.height = c.height; }
    const t = bandLayer.getContext('2d')!;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, c.width, c.height);
    const clothFaces = isFold(bundle) ? faces : [];
    if (clothFaces.length) {
      // the cloth's footprint, then the strips kept only where it is
      t.fillStyle = '#000';
      for (const f of clothFaces) {
        t.beginPath();
        f.flat.forEach((q, i) => { const s = apply(mul(V, f.T), q); i ? t.lineTo(s.x, s.y) : t.moveTo(s.x, s.y); });
        t.closePath();
        t.fill();
      }
      t.globalCompositeOperation = 'source-in';
    }
    t.fillStyle = '#141418';
    for (const s of strips) {
      const q = quad(s.p, s.d, s.w);
      if (!q) continue;
      t.beginPath();
      q.forEach((v, i) => (i ? t.lineTo(v.x, v.y) : t.moveTo(v.x, v.y)));
      t.closePath();
      t.fill();
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.55;
    ctx.drawImage(bandLayer, 0, 0);
    ctx.restore();
  }
  if (tool !== 'band') return;
  if (draft) {
    const q = quad(draft.p, draft.d, brush.bandW);
    if (q) {
      ctx.beginPath();
      q.forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(215,213,207,0.25)'; ctx.fill();
      ctx.strokeStyle = '#d7d5cf'; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  for (const m of [...bandDraft, ...(hoverFolded ? [hoverFolded] : [])]) {
    const q = apply(V, m);
    ctx.beginPath(); ctx.arc(q.x, q.y, 4 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#d7d5cf'; ctx.fill();
  }
}

function draw3dOverlay(hit: ReturnType<typeof hit3d>): void {
  const c = foldedCanvas;
  Renderer.fit(c, renderer.dpr);
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  if (!view3d || !bundle) return;
  const dpr = renderer.dpr;
  // the 3D canvas may have a lower backing resolution than the overlay
  const k = c.width / Math.max(1, folded3dCanvas.width);
  const proj = (p: Vec3) => { const q = view3d!.project(p); return q ? { x: q.x * k, y: q.y * k, depth: q.depth } : null; };
  const ppc = (depth: number) => view3d!.pixelsPerCm(depth) * k;
  // flat hover -> where it sits in the bundle
  if (hoverFlat && hoverFlat.x >= 0 && hoverFlat.y >= 0 && hoverFlat.x < sim.W && hoverFlat.y < sim.H) {
    const i = sim.texelAt(hoverFlat);
    const q = proj([bundle.px[i], bundle.py[i], bundle.pz[i]]);
    if (q) {
      ctx.beginPath(); ctx.arc(q.x, q.y, 6 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,60,0,0.9)'; ctx.fill();
      ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
  }
  if (hit && (tool === 'dye' || tool === 'inspect')) {
    const q = proj(hit.p);
    if (q) {
      const rpx = brush.r * ppc(q.depth);
      ctx.beginPath(); ctx.arc(q.x, q.y, tool === 'inspect' ? 5 * dpr : rpx, 0, Math.PI * 2);
      ctx.strokeStyle = tool === 'dye' ? plan.dyes[brush.dye]?.color ?? '#fff' : '#ff7a1a';
      ctx.lineWidth = 2 * dpr; ctx.stroke();
    }
  }
  const draft = foldDraftLine();
  if (tool === 'fold' && (foldDraft.length || hoverFolded)) {
    const zTop = (isFold(bundle) ? bundle.maxLayers * plan.thickness : 0) + 0.2, zBot = -plan.thickness - 0.2;
    const poly = (pts: Vec3[], fill: string | null, stroke: string | null, dash = false): void => {
      const q = pts.map(proj);
      if (q.some((v) => !v)) return;
      ctx.beginPath();
      q.forEach((v, i) => (i ? ctx.lineTo(v!.x, v!.y) : ctx.moveTo(v!.x, v!.y)));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash(dash ? [6 * dpr, 4 * dpr] : []); ctx.stroke(); ctx.setLineDash([]); }
    };
    if (draft) {
      // the cutting plane: the line, clipped to the bundle's extent plus a margin, from the table to above the stack
      let lo = Infinity, hi = -Infinity;
      for (const f of faces) for (const q of f.flat) { const b = apply(f.T, q); const t = (b.x - draft.p.x) * draft.d.x + (b.y - draft.p.y) * draft.d.y; lo = Math.min(lo, t); hi = Math.max(hi, t); }
      if (isFinite(lo)) {
        lo -= 3; hi += 3;
        const A = { x: draft.p.x + draft.d.x * lo, y: draft.p.y + draft.d.y * lo }, B = { x: draft.p.x + draft.d.x * hi, y: draft.p.y + draft.d.y * hi };
        poly([[A.x, A.y, zBot], [B.x, B.y, zBot], [B.x, B.y, zTop], [A.x, A.y, zTop]], 'rgba(255,122,26,0.18)', 'rgba(255,122,26,0.9)', true);
      }
      if (draft.moveSign) {
        // the moving part of every plate of the exact mesh, at the plate's own height, on a
        // scratch layer so overlapping layers blend once
        const c = ctx.canvas;
        if (foldTint.width !== c.width || foldTint.height !== c.height) { foldTint.width = c.width; foldTint.height = c.height; }
        const t = foldTint.getContext('2d')!;
        t.setTransform(1, 0, 0, 1, 0, 0);
        t.clearRect(0, 0, c.width, c.height);
        t.fillStyle = '#ff7a1a';
        const cells = view3d.exportMesh()?.cells ?? faces.map((f) => ({ poly: f.flat.map((q) => apply(f.T, q)), z: zTop }));
        for (const cell of cells) {
          const mp = clipPolygon(cell.poly, draft.p, draft.d, draft.moveSign);
          if (mp.length < 3) continue;
          const q = mp.map((v) => proj([v.x, v.y, cell.z + 0.03]));
          if (q.some((v) => !v)) continue;
          t.beginPath();
          q.forEach((v, i) => (i ? t.lineTo(v!.x, v!.y) : t.moveTo(v!.x, v!.y)));
          t.closePath();
          t.fill();
        }
        ctx.save(); ctx.globalAlpha = 0.3; ctx.drawImage(foldTint, 0, 0); ctx.restore();
      }
    }
    // the fixed point(s) and the cursor on the table plane
    const marks = foldDraft.length ? foldDraft : (hoverFolded ? [hoverFolded] : []);
    for (const m of marks) {
      const q = proj([m.x, m.y, zTop]);
      if (!q) continue;
      ctx.beginPath(); ctx.arc(q.x, q.y, 4 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#ff7a1a'; ctx.fill();
    }
  }
  // bands are shaded on the model by the 3D view; here only the points of the one being tied
  const box = bundleBox();
  if (box) {
    const zTop = box.z1 + 0.2;
    if (tool === 'band') {
      const marks = [...bandDraft, ...(hoverFolded ? [hoverFolded] : [])];
      for (const m of marks) {
        const q = proj([m.x, m.y, zTop]);
        if (!q) continue;
        ctx.beginPath(); ctx.arc(q.x, q.y, 4 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#d7d5cf'; ctx.fill();
      }
    }
  }
}

function batchDone(): boolean {
  gpu?.download();
  let free = 0, total = 0;
  for (let k = 0; k < sim.nDyes; k++) {
    const f = sim.f[k], h = sim.h[k];
    for (let i = 0; i < f.length; i++) { free += f[i]; total += f[i] + h[i]; }
  }
  const bl = sim.bl;
  for (let i = 0; i < bl.length; i++) { free += bl[i]; total += bl[i]; }
  // done when almost nothing mobile is left, relative to the dye on the cloth or in absolute terms
  return free < 0.002 * total || free < 1e-4 * bl.length;
}

function setPlaying(on: boolean): void {
  playing = on;
  playBtn.textContent = playing ? '❚❚ Pause' : '▶ Play';
  playBtn.classList.toggle('on', playing);
}

function renderOnce(): void {
  if (dirtyDye) {
    if (gpu) {
      gpu.draw(plan.dyes, view);
      renderer.src = gpu.canvas;
    } else {
      renderer.updateTexture(sim, plan.dyes, view);
    }
    dirtyDye = false;
    texVersion++;
  }

  // picking
  const flatMarkers: Vec2[] = [];
  const foldedMarkers: Vec2[] = [];
  let hoverFace = -1;
  let hoverInfo = '';
  if (hoverFlat && isFold(bundle)) {
    const fi = faceAtFlat(bundle.index, hoverFlat);
    if (fi >= 0) {
      hoverFace = fi;
      const p = apply(faces[fi].T, hoverFlat);
      foldedMarkers.push(p);
      const col = facesAtFolded(bundle.index, p);
      const pos = col.indexOf(fi);
      hoverInfo = `flat (${hoverFlat.x.toFixed(1)}, ${hoverFlat.y.toFixed(1)}) → bundle (${p.x.toFixed(1)}, ${p.y.toFixed(1)}), layer ${pos + 1} of ${col.length} from top`;
    }
  } else if (hoverFlat && isCloth(bundle)) {
    if (hoverFlat.x >= 0 && hoverFlat.y >= 0 && hoverFlat.x < sim.W && hoverFlat.y < sim.H) {
      const i = sim.texelAt(hoverFlat);
      const p = { x: bundle.px[i], y: bundle.py[i] };
      foldedMarkers.push(p);
      const col = bundle.column(p);
      const pos = col.indexOf(i);
      hoverInfo = `flat (${hoverFlat.x.toFixed(1)}, ${hoverFlat.y.toFixed(1)}) → bundle (${p.x.toFixed(1)}, ${p.y.toFixed(1)}), height ${bundle.pz[i].toFixed(2)} cm, layer ${pos + 1} of ${col.length} from top`;
    }
  }
  if (hoverFolded && tool === 'fold' && foldDraft.length) {
    // drawing a fold: the crease preview replaces the per-layer markers
  } else if (hoverFolded && isFold(bundle)) {
    let col = facesAtFolded(bundle.index, hoverFolded);
    if (view.flip) col = col.reverse();
    for (const fi of col) flatMarkers.push(apply(bundle.index.Tinv[fi], hoverFolded));
    if (col.length) hoverInfo = `bundle (${hoverFolded.x.toFixed(1)}, ${hoverFolded.y.toFixed(1)}): ${col.length} layer${col.length > 1 ? 's' : ''} under cursor, numbered from the ${view.flip ? 'underside' : 'top'}`;
  } else if (hoverFolded && isCloth(bundle)) {
    let col = bundle.column(hoverFolded);
    if (view.flip) col = col.reverse();
    for (const i of col) flatMarkers.push(sim.texelCenter(i));
    if (col.length) hoverInfo = `bundle (${hoverFolded.x.toFixed(1)}, ${hoverFolded.y.toFixed(1)}): ${col.length} layer${col.length > 1 ? 's' : ''} under cursor, numbered from the ${view.flip ? 'underside' : 'top'}`;
  }
  let hit: ReturnType<typeof hit3d> = null;
  if (is3d() && bundle) {
    flatMarkers.length = 0;
    if (hover3d) {
      hit = hit3d(hover3d);
      if (hit) {
        flatMarkers.push(sim.texelCenter(hit.id));
        hoverInfo = `bundle (${hit.p[0].toFixed(1)}, ${hit.p[1].toFixed(1)}, ${hit.p[2].toFixed(1)}) → flat (${sim.texelCenter(hit.id).x.toFixed(1)}, ${sim.texelCenter(hit.id).y.toFixed(1)})${bundle.exposed[hit.id] ? '' : ' (interior)'}`;
      }
    }
    if (hoverFlat && hoverFlat.x >= 0 && hoverFlat.y >= 0 && hoverFlat.x < sim.W && hoverFlat.y < sim.H) {
      const i = sim.texelAt(hoverFlat);
      if (bundle.valid[i]) hoverInfo = `flat (${hoverFlat.x.toFixed(1)}, ${hoverFlat.y.toFixed(1)}) → bundle (${bundle.px[i].toFixed(1)}, ${bundle.py[i].toFixed(1)}, ${bundle.pz[i].toFixed(1)})${bundle.exposed[i] ? ', exposed' : ', buried'}`;
    }
  }

  const draft = foldDraftLine();
  const draftKey = draft ? `|fd${draft.p.x.toFixed(2)},${draft.p.y.toFixed(2)},${draft.d.x.toFixed(4)},${draft.d.y.toFixed(4)},${draft.moveSign ?? 0}` : '';
  const flatKey = `${texVersion}|${hoverFace}|${flatMarkers.map((m) => `${m.x.toFixed(2)},${m.y.toFixed(2)}`).join(';')}|${view.showCreases}|${flatCanvas.clientWidth}x${flatCanvas.clientHeight}|${geomVersion}|${plan.mode}${tool === 'centre' ? '|c' : ''}${draftKey}`;
  if (flatKey !== lastFlatKey) {
    lastFlatKey = flatKey;
    renderer.drawFlat(sim, faces, view, flatMarkers, hoverFace);
    if (draft) drawFoldPreviewFlat(draft);
  }
  if (plan.mode === 'twist' && tool === 'centre' && flatKey === lastFlatKey) {
    const ctx = flatCanvas.getContext('2d')!;
    const q = apply(renderer.flatView, plan.twist.c);
    ctx.strokeStyle = '#ff7a1a'; ctx.lineWidth = 2 * renderer.dpr;
    ctx.beginPath(); ctx.arc(q.x, q.y, plan.twist.pinch * Math.hypot(renderer.flatView.a, renderer.flatView.b), 0, Math.PI * 2); ctx.stroke();
  }
  const overlay = (ctx: CanvasRenderingContext2D, V: Mat) => {
    const s = renderer.foldedScale();
    drawBands2d(ctx, V);
    if (tool === 'dye' && hoverFolded) {
      const q = apply(V, hoverFolded);
      ctx.beginPath();
      ctx.arc(q.x, q.y, brush.r * s, 0, Math.PI * 2);
      ctx.strokeStyle = plan.dyes[brush.dye]?.color ?? '#fff';
      ctx.lineWidth = 2 * renderer.dpr;
      ctx.stroke();
    }
    if (tool === 'fold' && foldDraft.length) {
      if (draft?.moveSign) {
        // the moving parts of all layers overlap in the folded view (and mirrored faces
        // wind the other way), so paint them opaque on a scratch layer and blend that once
        const c = ctx.canvas;
        if (foldTint.width !== c.width || foldTint.height !== c.height) { foldTint.width = c.width; foldTint.height = c.height; }
        const t = foldTint.getContext('2d')!;
        t.setTransform(1, 0, 0, 1, 0, 0);
        t.clearRect(0, 0, c.width, c.height);
        t.fillStyle = '#ff7a1a';
        for (const f of faces) {
          const poly = clipPolygon(f.flat.map((q) => apply(f.T, q)), draft.p, draft.d, draft.moveSign);
          if (poly.length < 3) continue;
          t.beginPath();
          poly.forEach((q, i) => { const s = apply(V, q); i ? t.lineTo(s.x, s.y) : t.moveTo(s.x, s.y); });
          t.closePath();
          t.fill();
        }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 0.28;
        ctx.drawImage(foldTint, 0, 0);
        ctx.restore();
      }
      const a = apply(V, foldDraft[0]);
      const b = foldDraft.length > 1 ? apply(V, foldDraft[1]) : (hoverFolded ? apply(V, hoverFolded) : null);
      ctx.fillStyle = '#ff7a1a';
      ctx.beginPath(); ctx.arc(a.x, a.y, 4 * renderer.dpr, 0, Math.PI * 2); ctx.fill();
      if (b) {
        const d = normalize({ x: b.x - a.x, y: b.y - a.y });
        const L = 5000;
        ctx.strokeStyle = '#ff7a1a';
        ctx.lineWidth = 1.5 * renderer.dpr;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x - d.x * L, a.y - d.y * L);
        ctx.lineTo(a.x + d.x * L, a.y + d.y * L);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  };
  stackEl.classList.toggle('three', is3d());
  folded3dCanvas.hidden = !is3d();
  if (is3d() && view3d) {
    Renderer.fit(folded3dCanvas, Math.min(renderer.dpr, 1.5));
    if (uploadedTex !== texVersion) { view3d.setTexture(renderer.src); uploadedTex = texVersion; }
    const cam = view3d.cam;
    // bands, and the one being tied, shaded where they cross the model
    const draftBand = tool === 'band' ? bandDraftLine() : null;
    const bands3: { p: Vec3; n: Vec3; w: number; draft?: boolean }[] = plan.bands.filter((b): b is SlabBand => b.kind === 'slab').map((b) => ({ p: b.p, n: b.n, w: b.w }));
    if (draftBand) bands3.push({ p: [draftBand.p.x, draftBand.p.y, 0], n: [-draftBand.d.y, draftBand.d.x, 0], w: brush.bandW, draft: true });
    const bandsKey = bands3.map((b) => `${b.p.join(',')};${b.n.join(',')};${b.w}`).join('|');
    if (bandsKey !== last3dBands) { last3dBands = bandsKey; view3d.setBands(bands3); }
    const key3d = `${texVersion}|${geomVersion}|${cam.az},${cam.el},${cam.dist},${cam.target.join(',')}|${view3d.style}|${folded3dCanvas.width}x${folded3dCanvas.height}|${bandsKey}`;
    if (key3d !== last3dKey) { last3dKey = key3d; view3d.draw(); }
    draw3dOverlay(hit);
  } else if (plan.mode === 'twist') {
    const cloth = liveCloth ?? (isCloth(bundle) ? bundle.cloth : null);
    if (cloth) renderer.drawCloth(cloth, liveCloth ? null : renderer.textureColors(sim.N, sim.M), plan.bands, view, foldedMarkers, overlay);
  } else {
    renderer.drawFolded(sim, faces, plan.bands, view, foldedMarkers, overlay);
  }

  // the readout in the bottom corner of the bundle view: the lines that come and go
  // (hover, pouring, squirt depth) on top, the steady metrics at the bottom edge so they stay put
  const shape = plan.mode === 'twist'
    ? (twistStatus ? [`twisting: ${twistStatus}`] : [`twist ${plan.twist.turns} turns`, `${sim.N}×${sim.M} particles`])
    : [`${faces.length} faces · ${isFold(bundle) ? bundle.maxLayers : 0} layers`, `${sim.N}×${sim.M} texels`];
  const pouring = hold && dragging ? `pouring: soak ${hold.stroke.pen < 10 ? hold.stroke.pen.toFixed(1) : hold.stroke.pen.toFixed(0)} layers` : '';
  statusEl.textContent = [hoverInfo, pouring, lastReach, ...shape, `${gpu ? (gpu.split ? 'GPU (2-pass)' : 'GPU') : 'CPU'} · t=${sim.t}`, gpuWhy && `GPU off: ${gpuWhy}`].filter(Boolean).join('\n');
}

// Debug / scripting handle (also handy for automated tests).
(window as unknown as { tiedyer: unknown }).tiedyer = {
  get plan() { return plan; },
  sim,
  view,
  step: (n: number) => { doSteps(n); renderOnce(); },
  get gpu() { return gpu; },
  download: () => gpu?.download(),
  render: () => { dirty = true; renderOnce(); },
  get bundle() { return bundle; },
  get view3d() { return view3d; },
  hit3d,
  pressChanged,
  rebuild: rebuildGeometry,
  addFolds,
  addStroke,
  setTool,
  buildGlb,
  exportFlat: (px: number) => { renderOnce(); return renderer.exportFlat(sim, faces, view, px); },
};

buildSidebar();
setThree(view.three);
rebuildGeometry();
if (!saved) doSteps(DEMO_STEPS);
requestAnimationFrame(frame);
