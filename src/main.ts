import './style.css';
import { Vec2, Mat, apply, side, normalize, dist } from './geom';
import { Face, FoldLine, buildFaces, accordionFolds, zigzagFolds, diagonalFold, facesAtFolded, faceAtFlat, Axis } from './fold';
import { flatFoldBundle, FlatFoldBundle } from './bundle';
import { ClothView, ClothBundle, makeClothBundle } from './cloth';
import { View3D, Vec3, norm as norm3, cross as cross3, sub as sub3, len3 } from './view3d';
import { Plan, Stroke, Mode, defaultPlan, demoPlan, spiralDemoPlan, serializePlan, parsePlan } from './plan';
import { Sim } from './sim';
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
  geomVersion++;
  if (reframe) view3d.frame();
}
function is3d(): boolean { return view.three && !!view3d; }

let gpu: GpuSolver | null = null;
try {
  if (GpuSolver.supported()) gpu = new GpuSolver(sim);
} catch (e) {
  console.warn('GPU solver unavailable, using CPU', e);
  gpu = null;
}

const view: ViewOpts & { three: boolean } = { fixedOnly: false, strength: 1.2, showCreases: true, shadeLayers: false, flip: false, showPress: false, three: false };
try { view.three = localStorage.getItem('tiedyer.view3d') === '1'; } catch { /* ignore */ }
const v2dBtn = document.getElementById('v2d') as HTMLButtonElement;
const v3dBtn = document.getElementById('v3d') as HTMLButtonElement;
const cam3dEl = document.getElementById('cam3d')!;
function setThree(on: boolean): void {
  view.three = on && !!view3d;
  v2dBtn.classList.toggle('on', !view.three);
  v3dBtn.classList.toggle('on', view.three);
  cam3dEl.hidden = !view.three;
  try { localStorage.setItem('tiedyer.view3d', view.three ? '1' : '0'); } catch { /* ignore */ }
  if (view.three && view3d && bundle) { sync3d(bundle.px, bundle.py, bundle.pz, false); }
  if (view.three && (tool === 'dye' || tool === 'band')) setTool('orbit');
  if (!view.three && tool === 'orbit') setTool('dye');
  dirty = true;
  lastFlatKey = '';
}
v2dBtn.addEventListener('click', () => setThree(false));
v3dBtn.addEventListener('click', () => setThree(true));
document.getElementById('orbitBtn')!.addEventListener('click', () => setTool(tool === 'orbit' ? 'inspect' : 'orbit'));
document.getElementById('zoomIn')!.addEventListener('click', () => { view3d?.zoom(0.8); dirty = true; });
document.getElementById('zoomOut')!.addEventListener('click', () => { view3d?.zoom(1.25); dirty = true; });
document.getElementById('fitView')!.addEventListener('click', () => { view3d?.frame(); dirty = true; });

type Tool = 'inspect' | 'dye' | 'band' | 'fold' | 'centre' | 'orbit';
let tool: Tool = 'dye';
const brush = { r: 3, amount: 0.8, pen: 10, dye: 0 };
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
let lastHoverKey = '';
let lastFlatKey = '';

let foldDraft: Vec2[] = [];
let hoverFolded: Vec2 | null = null;
let hoverFlat: Vec2 | null = null;
let dragging = false;
let lastStamp: Vec2 | null = null;
let bandsDirty = false;

let saveTimer: number | undefined;
function touched(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, serializePlan(plan)); } catch { /* ignore */ }
  }, 400);
}

function replay(): void {
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
  bundle = flatFoldBundle(sim.dims(), faces);
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
const btn = (label: string, onclick: () => void, cls = '') => el('button', { class: cls, onclick }, label);

function slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt = (v: number) => v.toFixed(2)): HTMLElement {
  const val = el('span', { class: 'val' }, fmt(get()));
  const input = el('input', { type: 'range', min, max, step, value: get() }) as HTMLInputElement;
  input.addEventListener('input', () => { set(parseFloat(input.value)); val.textContent = fmt(parseFloat(input.value)); });
  return row(el('label', {}, label), input, val);
}

/** Slider whose position is logarithmic in the value. */
function logSlider(label: string, min: number, max: number, get: () => number, set: (v: number) => void, fmt = (v: number) => v.toFixed(1)): HTMLElement {
  const lo = Math.log(min), hi = Math.log(max);
  const toPos = (v: number) => (Math.log(v) - lo) / (hi - lo);
  const val = el('span', { class: 'val' }, fmt(get()));
  const input = el('input', { type: 'range', min: 0, max: 1, step: 0.001, value: toPos(get()) }) as HTMLInputElement;
  input.addEventListener('input', () => { const v = Math.exp(lo + parseFloat(input.value) * (hi - lo)); set(v); val.textContent = fmt(v); });
  return row(el('label', {}, label), input, val);
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
  return el('label', { class: 'row' }, input, label);
}

// ---------------------------------------------------------------------------
// Sidebar

const sideEl = document.getElementById('side')!;
const toolButtons: Record<Tool, HTMLButtonElement> = {} as never;
const toolHint = document.getElementById('tool-hint')!;
const HINTS: Record<Tool, string> = {
  inspect: 'hover to see every layer under the cursor · in 3D, drag to orbit',
  dye: 'drag to squirt dye on the side you are viewing',
  band: 'drag to place rubber band / clamp (resist)',
  fold: 'click two points for the crease, then click the side that folds over (shift = fold under)',
  centre: 'click the flat cloth where you pinch',
  orbit: 'drag to orbit · wheel or +/− to zoom · shift-drag to pan · with Dye/Band, drag the background to orbit',
};
let foldControls: HTMLElement;
let twistControls: HTMLElement;
let modeButtons: Record<Mode, HTMLButtonElement>;
let resRow: HTMLElement;
function refreshModeUI(): void {
  foldControls.hidden = plan.mode !== 'fold';
  twistControls.hidden = plan.mode !== 'twist';
  resRow.hidden = plan.mode !== 'fold';
  for (const [k, b] of Object.entries(modeButtons)) b.classList.toggle('on', k === plan.mode);
}

function setTool(t: Tool): void {
  tool = t;
  foldDraft = [];
  dirty = true;
  document.getElementById('orbitBtn')?.classList.toggle('on', t === 'orbit');
  for (const [k, b] of Object.entries(toolButtons)) b.classList.toggle('on', k === t);
  toolHint.textContent = HINTS[t];
}

const foldList = el('ol', { class: 'folds' });
function refreshFoldList(): void {
  foldList.replaceChildren(
    ...plan.folds.map((f) => el('li', {}, f.label ?? `line (${f.p.x.toFixed(1)}, ${f.p.y.toFixed(1)}) ∠${((Math.atan2(f.d.y, f.d.x) * 180) / Math.PI).toFixed(0)}°${f.under ? ' under' : ''}`)),
  );
}

const swatchWrap = el('div', { class: 'swatches' });
function refreshSwatches(): void {
  swatchWrap.replaceChildren(
    ...plan.dyes.map((d, k) => {
      const color = el('input', { type: 'color', value: d.color, title: d.name }) as HTMLInputElement;
      color.addEventListener('input', () => { d.color = color.value; dirty = true; dirtyDye = true; touched(); });
      const sw = el('div', { class: 'swatch' + (k === brush.dye ? ' on' : ''), title: d.name }, color);
      sw.addEventListener('click', () => { brush.dye = k; refreshSwatches(); });
      return sw;
    }),
  );
}

const playBtn = btn('▶ Play', () => setPlaying(!playing));

function buildSidebar(): void {
  const pleats = numberInput(() => 6, () => {}, { min: 2, max: 40, step: 1 }) as HTMLInputElement;
  pleats.value = '6';
  const zigAxis = el('select', {}, el('option', { value: 'y' }, 'strip along y'), el('option', { value: 'x' }, 'strip along x')) as HTMLSelectElement;
  const zigStyle = el('select', {},
    el('option', { value: 'equilateral' }, 'equilateral 60°'),
    el('option', { value: 'right' }, 'right 45°'),
    el('option', { value: 'square' }, 'squares'),
  ) as HTMLSelectElement;
  const resSel = el('select', {}, ...[120, 180, 240, 320, 400, 480, 640, 800].map((n) => el('option', { value: n }, `${n} texels`))) as HTMLSelectElement;
  resSel.value = String(plan.N);
  const partSel = el('select', {}, ...[61, 81, 101, 121, 161].map((n) => el('option', { value: n }, `${n}² particles`))) as HTMLSelectElement;
  partSel.value = String([61, 81, 101, 121, 161].includes(plan.N) ? plan.N : 101);
  partSel.addEventListener('change', () => { plan.N = parseInt(partSel.value); reconfigure(); });
  toolButtons.inspect = btn('Inspect', () => setTool('inspect'));
  toolButtons.dye = btn('Dye', () => setTool('dye'));
  toolButtons.band = btn('Band', () => setTool('band'));
  toolButtons.fold = btn('Draw fold line', () => setTool('fold'));
  const cx = numberInput(() => plan.twist.c.x, (v) => { plan.twist.c.x = v; touched(); }, { min: 0, max: 300, step: 0.5 });
  const cy = numberInput(() => plan.twist.c.y, (v) => { plan.twist.c.y = v; touched(); }, { min: 0, max: 300, step: 0.5 });
  const refreshCentre = () => { cx.value = String(plan.twist.c.x); cy.value = String(plan.twist.c.y); };
  toolButtons.centre = btn('Pick', () => setTool('centre'));
  toolButtons.orbit = document.getElementById('orbitBtn') as HTMLButtonElement;
  const styleSel = el('select', {}, el('option', { value: 'mesh' }, 'mesh'), el('option', { value: 'splat' }, 'splats')) as HTMLSelectElement;
  styleSel.addEventListener('change', () => { if (view3d) view3d.style = styleSel.value as 'mesh' | 'splat'; dirty = true; });
  modeButtons = { fold: btn('Fold', () => setMode('fold')), twist: btn('Twist', () => setMode('twist')) };
  resRow = row(el('label', {}, 'resolution'), resSel);
  foldControls = el('div', {},
      row(btn('Accordion X', () => addFoldsSequential((f) => accordionFolds(f, 'x', parseInt(pleats.value)))),
        btn('Accordion Y', () => addFoldsSequential((f) => accordionFolds(f, 'y', parseInt(pleats.value)))),
        el('label', {}, 'pleats'), pleats),
      row(el('label', {}, 'zigzag'), zigAxis, zigStyle,
        btn('Fold', () => addFoldsSequential((f) => zigzagFolds(f, zigAxis.value as Axis, zigStyle.value as 'equilateral' | 'right' | 'square')))),
      row(btn('Diagonal ╲', () => addFoldsSequential((f) => [diagonalFold(f, 'main')])),
        btn('Diagonal ╱', () => addFoldsSequential((f) => [diagonalFold(f, 'anti')])),
        toolButtons.fold),
      row(btn('Undo fold', () => { plan.folds.pop(); rebuildGeometry(); }),
        btn('Clear folds', () => { plan.folds = []; rebuildGeometry(); })),
      foldList);
  twistControls = el('div', {},
      row(el('label', {}, 'particles'), partSel),
      row(el('label', {}, 'pinch at'), cx, '×', cy, toolButtons.centre),
      slider('turns', 0.5, 6, 0.25, () => plan.twist.turns, (v) => { plan.twist.turns = v; touched(); }),
      slider('pinch cm', 0.5, 5, 0.25, () => plan.twist.pinch, (v) => { plan.twist.pinch = v; touched(); }),
      slider('friction', 0, 0.2, 0.005, () => plan.twist.friction, (v) => { plan.twist.friction = v; touched(); }, (v) => v.toFixed(3)),
      slider('pat flat cm', 0, 6, 0.25, () => plan.twist.flatten, (v) => { plan.twist.flatten = v; touched(); }),
      row(btn('Run twist', () => rebuildTwist())),
      el('div', { class: 'note' }, 'Pinch the centre, twist, release, pat flat. A particle cloth on a table with self-collision; the core grows as fabric wraps onto it. Runs a few seconds.'));
  (window as unknown as { refreshCentre: () => void }).refreshCentre = refreshCentre;

  const stepCounter = el('span', { class: 'val' }, '0');
  setInterval(() => { stepCounter.textContent = String(sim.t); }, 250);

  sideEl.replaceChildren(
    el('h1', {}, 'tiedyer', el('small', {}, 'fold · bind · dye · unfold')),
    row(
      btn('New', () => { plan = defaultPlan(); refreshModeUI(); reconfigure(); refreshSwatches(); }),
      btn('Kikko', () => { plan = demoPlan(); refreshModeUI(); reconfigure(); refreshSwatches(); doSteps(DEMO_STEPS); }),
      btn('Spiral', () => { plan = spiralDemoPlan(); pendingSteps = DEMO_STEPS; refreshModeUI(); reconfigure(); refreshSwatches(); }),
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
      el('div', { class: 'note' }, 'Changing the size keeps the fold list but the lines may no longer land where you meant.'),
    ),
    el('details', { open: true },
      el('summary', {}, 'Shape'),
      el('div', { class: 'row tools' }, modeButtons.fold, modeButtons.twist),
      foldControls,
      twistControls,
    ),
    el('details', { open: true },
      el('summary', {}, 'Dye & bindings'),
      el('div', { class: 'row tools' }, toolButtons.inspect, toolButtons.dye, toolButtons.band),
      swatchWrap,
      slider('brush cm', 0.5, 20, 0.5, () => brush.r, (v) => { brush.r = v; dirty = true; }, (v) => v.toFixed(1)),
      slider('amount', 0.05, 2, 0.05, () => brush.amount, (v) => { brush.amount = v; }),
      logSlider('soak layers', 0.5, 150, () => brush.pen, (v) => { brush.pen = v; }, (v) => v < 10 ? v.toFixed(1) : v.toFixed(0)),
      row(btn('Dip whole bundle', () => { addStroke({ kind: 'dip', dye: brush.dye, amount: brush.amount, pen: brush.pen }); }),
        btn('Undo stroke', () => { plan.strokes.pop(); replay(); touched(); })),
      row(btn('Clear dye', () => { plan.strokes = []; replay(); touched(); }),
        btn('Clear bands', () => { plan.bands = []; pressChanged(); })),
      el('div', { class: 'note' }, 'Soak = how much liquid you squirt, in layers: it fills the top layer and the excess wicks into the next. Amount = dye strength in that liquid. Bands and clamps squeeze layers so they hold less and stop the front.'),
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
      el('div', { class: 'note' }, 'Fixing turns free dye into fixed dye up to the cloth capacity. Free dye keeps spreading; fixed dye stays. "Rinse" shows only fixed dye. Sideways wick = how much of a squirt spreads within a layer versus into the next.'),
    ),
    el('details', { open: true },
      el('summary', {}, 'View'),
      row(el('label', {}, '3D style'), styleSel),
      checkbox('Rinse (show fixed dye only)', () => view.fixedOnly, (v) => { view.fixedOnly = v; dirty = true; dirtyDye = true; }),
      checkbox('View & paint underside (2D)', () => view.flip, (v) => { view.flip = v; dirty = true; }),
      checkbox('Show creases on flat cloth', () => view.showCreases, (v) => { view.showCreases = v; dirty = true; }),
      checkbox('Shade by layer count', () => view.shadeLayers, (v) => { view.shadeLayers = v; dirty = true; }),
      checkbox('Show binding pressure on flat', () => view.showPress, (v) => { view.showPress = v; dirty = true; dirtyDye = true; }),
      slider('colour depth', 0.2, 4, 0.1, () => view.strength, (v) => { view.strength = v; dirty = true; dirtyDye = true; }, (v) => v.toFixed(1)),
    ),
    el('div', { class: 'note' }, 'Keys: ', el('kbd', {}, 'space'), ' play/pause · ', el('kbd', {}, 'esc'), ' cancel fold line · ', el('kbd', {}, 'z'), ' undo stroke'),
  );
  resSel.addEventListener('change', () => { plan.N = parseInt(resSel.value); reconfigure(); });
  refreshSwatches();
  refreshModeUI();
  setTool('dye');
}

function savePlan(): void {
  const blob = new Blob([serializePlan(plan)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tiedye-plan.json';
  a.click();
  URL.revokeObjectURL(a.href);
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

function addStroke(s: Stroke): void {
  plan.strokes.push(s);
  gpu?.download();
  sim.applyStroke(s, plan.params, footprintOracle());
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
    addStroke({ kind: 'brush', p, r: brush.r, dye: brush.dye, amount: brush.amount, side: paintSide(), pen: brush.pen });
  } else if (tool === 'band') {
    plan.bands.push({ p, r: brush.r });
    bandsDirty = true;
    dirty = true;
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
  const id = view3d.pick(x, y);
  const hit: Hit = id < 0 ? null : { id, p: view3d.position(id), d: view3d.rayDir(x, y), x, y };
  hitCache = { key, hit };
  return hit;
}

function stampAt3d(ev: PointerEvent): void {
  const h = hit3d(ev);
  if (!h) return;
  if (tool === 'dye') {
    addStroke({ kind: 'brush3', p: h.p, d: h.d, r: brush.r, dye: brush.dye, amount: brush.amount, pen: brush.pen });
  }
}

let bandStart: { p: Vec3; d: Vec3 } | null = null;
let bandEnd: Vec3 | null = null;
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
    if (gesture) { view3d.orbit(cx - gesture.x, cy - gesture.y); gesture.x = cx; gesture.y = cy; }
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
    if (dragging && tool === 'dye') {
      const h = hit3d(ev);
      if (h && (!lastStamp3 || len3(sub3(lastStamp3, h.p)) >= brush.r * 0.35)) { stampAt3d(ev); lastStamp3 = h.p; }
    } else if (dragging && tool === 'band') {
      const h = hit3d(ev);
      if (h) bandEnd = h.p;
      dirty = true;
    }
    return;
  }
  if (dragging && (tool === 'dye' || tool === 'band')) {
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
      gesture = { kind: 'orbit', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      hover3d = null;
      dragging = false; lastStamp = null; lastStamp3 = null; bandStart = null; bandEnd = null;
      return;
    }
  }
  const onBackground = is3d() && view3d && ev.button === 0 && (tool === 'dye' || tool === 'band') && !hit3d(ev);
  if (is3d() && view3d && (ev.button === 2 || ev.button === 1 || tool === 'orbit' || tool === 'inspect' || onBackground || ev.altKey || ev.ctrlKey || ev.shiftKey)) {
    gesture = { kind: ev.shiftKey || ev.button === 1 ? 'pan' : 'orbit', x: ev.clientX, y: ev.clientY };
    hover3d = null;
    return;
  }
  if (ev.button !== 0) return;
  hoverFolded = renderer.foldedToCm(ev);
  const p = renderer.foldedToCm(ev);
  if (is3d()) {
    if (tool === 'dye') { dragging = true; const h = hit3d(ev); lastStamp3 = h ? h.p : null; stampAt3d(ev); }
    else if (tool === 'band') { dragging = true; const h = hit3d(ev); bandStart = h ? { p: h.p, d: h.d } : null; bandEnd = null; }
    return;
  }
  if (tool === 'dye' || tool === 'band') {
    dragging = true;
    lastStamp = p;
    stampAt(p);
  } else if (tool === 'fold' && plan.mode === 'fold' && !is3d()) {
    if (foldDraft.length < 2) {
      foldDraft.push(p);
    } else {
      const a = foldDraft[0], d = normalize({ x: foldDraft[1].x - a.x, y: foldDraft[1].y - a.y });
      const s = side(a, d, p);
      if (Math.abs(s) > 1e-6 && dist(foldDraft[0], foldDraft[1]) > 1e-6) {
        addFolds([{ p: a, d, moveSign: s > 0 ? 1 : -1, under: ev.shiftKey, label: undefined }]);
      }
      foldDraft = [];
    }
  }
});
const release = (ev: PointerEvent) => {
  touches.delete(ev.pointerId);
  if (touches.size < 2) pinchDist = 0;
  if (gesture) { gesture = null; return; }
  if (dragging) {
    dragging = false;
    lastStamp = null;
    lastStamp3 = null;
    if (bandStart && bandEnd) {
      // rubber band: a slab through the two hit points, containing the view direction
      const along = sub3(bandEnd, bandStart.p);
      if (len3(along) > 0.3) {
        const n = norm3(cross3(along, bandStart.d));
        const mid: Vec3 = [(bandStart.p[0] + bandEnd[0]) / 2, (bandStart.p[1] + bandEnd[1]) / 2, (bandStart.p[2] + bandEnd[2]) / 2];
        plan.bands.push({ kind: 'slab', p: mid, n, w: brush.r });
        bandsDirty = true;
      }
    }
    bandStart = null; bandEnd = null;
    if (bandsDirty) {
      bandsDirty = false;
      pressChanged();
    }
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

// mobile controls drawer
const appEl = document.getElementById('app')!;
document.getElementById('menu-btn')!.addEventListener('click', () => appEl.classList.toggle('menu-open'));
document.getElementById('backdrop')!.addEventListener('click', () => appEl.classList.remove('menu-open'));

window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).tagName === 'INPUT' || (ev.target as HTMLElement).tagName === 'SELECT') return;
  if (ev.key === 'Escape') { foldDraft = []; dirty = true; }
  if (ev.key === ' ') { ev.preventDefault(); playBtn.click(); }
  if (ev.key === 'z') { plan.strokes.pop(); replay(); touched(); }
});

// ---------------------------------------------------------------------------
// Frame loop

const statusEl = document.getElementById('status')!;

let frameCount = 0;
function frame(): void {
  frameCount++;
  if (playing) {
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
  const hoverKey = `${hoverFlat?.x},${hoverFlat?.y},${hoverFolded?.x},${hoverFolded?.y},${foldDraft.length},${hover3d?.clientX},${hover3d?.clientY}`;
  if (hoverKey !== lastHoverKey) { lastHoverKey = hoverKey; dirty = true; }
  const c1 = flatCanvas, c2 = foldedCanvas;
  if (c1.width !== Math.floor(c1.clientWidth * renderer.dpr) || c2.width !== Math.floor(c2.clientWidth * renderer.dpr)
    || c1.height !== Math.floor(c1.clientHeight * renderer.dpr) || c2.height !== Math.floor(c2.clientHeight * renderer.dpr)) dirty = true;
  if (dirty) { dirty = false; renderOnce(); }
  requestAnimationFrame(frame);
}

/** markers, brush cursor and band drag on the transparent canvas above the 3D view */
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
  if (hit && (tool === 'dye' || tool === 'band' || tool === 'inspect')) {
    const q = proj(hit.p);
    if (q) {
      const rpx = brush.r * ppc(q.depth);
      ctx.beginPath(); ctx.arc(q.x, q.y, tool === 'inspect' ? 5 * dpr : rpx, 0, Math.PI * 2);
      ctx.strokeStyle = tool === 'dye' ? plan.dyes[brush.dye]?.color ?? '#fff' : tool === 'band' ? '#222' : '#ff7a1a';
      ctx.lineWidth = 2 * dpr; ctx.stroke();
    }
  }
  if (bandStart && bandEnd) {
    const a = proj(bandStart.p), b = proj(bandEnd);
    if (a && b) {
      ctx.strokeStyle = 'rgba(30,30,30,0.85)';
      ctx.lineWidth = Math.max(2, brush.r * ppc(a.depth));
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
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
  return total > 0 && free < 0.002 * total;
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
  if (hoverFolded && isFold(bundle)) {
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

  const flatKey = `${texVersion}|${hoverFace}|${flatMarkers.map((m) => `${m.x.toFixed(2)},${m.y.toFixed(2)}`).join(';')}|${view.showCreases}|${flatCanvas.clientWidth}x${flatCanvas.clientHeight}|${geomVersion}|${plan.mode}${tool === 'centre' ? '|c' : ''}`;
  if (flatKey !== lastFlatKey) {
    lastFlatKey = flatKey;
    renderer.drawFlat(sim, faces, view, flatMarkers, hoverFace);
  }
  if (plan.mode === 'twist' && tool === 'centre' && flatKey === lastFlatKey) {
    const ctx = flatCanvas.getContext('2d')!;
    const q = apply(renderer.flatView, plan.twist.c);
    ctx.strokeStyle = '#ff7a1a'; ctx.lineWidth = 2 * renderer.dpr;
    ctx.beginPath(); ctx.arc(q.x, q.y, plan.twist.pinch * Math.hypot(renderer.flatView.a, renderer.flatView.b), 0, Math.PI * 2); ctx.stroke();
  }
  const overlay = (ctx: CanvasRenderingContext2D, V: Mat) => {
    const s = renderer.foldedScale();
    if ((tool === 'dye' || tool === 'band') && hoverFolded) {
      const q = apply(V, hoverFolded);
      ctx.beginPath();
      ctx.arc(q.x, q.y, brush.r * s, 0, Math.PI * 2);
      ctx.strokeStyle = tool === 'dye' ? plan.dyes[brush.dye]?.color ?? '#fff' : '#222';
      ctx.lineWidth = 2 * renderer.dpr;
      ctx.stroke();
    }
    if (tool === 'fold' && foldDraft.length) {
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
    view3d.draw();
    draw3dOverlay(hit);
  } else if (plan.mode === 'twist') {
    const cloth = liveCloth ?? (isCloth(bundle) ? bundle.cloth : null);
    if (cloth) renderer.drawCloth(cloth, liveCloth ? null : renderer.textureColors(sim.N, sim.M), plan.bands, view, foldedMarkers, overlay);
  } else {
    renderer.drawFolded(sim, faces, plan.bands, view, foldedMarkers, overlay);
  }

  const shape = plan.mode === 'twist'
    ? (twistStatus ? `twisting: ${twistStatus}` : `twist ${plan.twist.turns} turns · ${sim.N}×${sim.M} particles`)
    : `${faces.length} faces · up to ${isFold(bundle) ? bundle.maxLayers : 0} layers · ${sim.N}×${sim.M} texels`;
  statusEl.textContent = `${shape} · ${gpu ? 'GPU' : 'CPU'} solver · t=${sim.t} · build ${__BUILD__}` + '\n' + hoverInfo;
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
};

buildSidebar();
setThree(view.three);
rebuildGeometry();
if (!saved) doSteps(DEMO_STEPS);
requestAnimationFrame(frame);
