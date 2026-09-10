import './style.css';
import { Vec2, Mat, apply, side, normalize, dist } from './geom';
import { Face, FoldLine, buildFaces, accordionFolds, zigzagFolds, diagonalFold, facesAtFolded, faceAtFlat, Axis } from './fold';
import { flatFoldBundle, FlatFoldBundle } from './bundle';
import { runTwist, Cloth, ClothBundle } from './cloth';
import { Plan, Stroke, Mode, defaultPlan, demoPlan, serializePlan, parsePlan } from './plan';
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
let liveCloth: Cloth | null = null;
let twistRun = 0;
let twistStatus = '';
const sim = new Sim(plan);

function isFold(b: FlatFoldBundle | ClothBundle | null): b is FlatFoldBundle { return !!b && 'faces' in b; }
function isCloth(b: FlatFoldBundle | ClothBundle | null): b is ClothBundle { return !!b && 'cloth' in b; }

const flatCanvas = document.getElementById('flat') as HTMLCanvasElement;
const foldedCanvas = document.getElementById('folded') as HTMLCanvasElement;
const renderer = new Renderer(flatCanvas, foldedCanvas);
renderer.dpr = window.devicePixelRatio || 1;

let gpu: GpuSolver | null = null;
try {
  if (GpuSolver.supported()) gpu = new GpuSolver(sim);
} catch (e) {
  console.warn('GPU solver unavailable, using CPU', e);
  gpu = null;
}

const view: ViewOpts = { fixedOnly: false, strength: 1.2, showCreases: true, shadeLayers: false, flip: false, showPress: false };

type Tool = 'inspect' | 'dye' | 'band' | 'fold' | 'centre';
let tool: Tool = 'dye';
const brush = { r: 3, amount: 0.8, pen: 10, dye: 0 };
let playing = false;
const budgetMs = 8;
let stepsPerFrame = 20;
/** set whenever something on screen changed; the frame loop only redraws then */
let dirty = true;
let lastHoverKey = '';

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
  for (const s of plan.strokes) sim.applyStroke(s, plan.params);
  gpu?.upload();
  dirty = true;
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
}

function rebuildGeometry(): void {
  if (plan.mode === 'twist') { void rebuildTwist(); return; }
  twistRun++; liveCloth = null; twistStatus = '';
  faces = buildFaces(plan.W, plan.H, plan.folds);
  bundle = flatFoldBundle(sim.dims(), faces);
  finishGeometry();
  refreshFoldList();
}

function finishGeometry(): void {
  sim.setBundle(bundle!);
  sim.rebuildPress(plan.bands, plan.params);
  gpu?.uploadStatic();
  replay();
  touched();
}

async function rebuildTwist(): Promise<void> {
  const run = ++twistRun;
  faces = [];
  bundle = null;
  const d = sim.dims();
  const result = await runTwist(plan.W, plan.H, plan.N, plan.twist, (phase, frac, cloth) => {
    if (run !== twistRun) return;
    liveCloth = cloth;
    twistStatus = `${phase} ${(frac * 100).toFixed(0)}%`;
    dirty = true;
  }, d);
  if (run !== twistRun) return; // superseded
  liveCloth = null;
  twistStatus = '';
  bundle = result;
  finishGeometry();
  dirty = true;
}

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
  inspect: 'hover to see every layer under the cursor',
  dye: 'drag to squirt dye on the side you are viewing',
  band: 'drag to place rubber band / clamp (resist)',
  fold: 'click two points for the crease, then click the side that folds over (shift = fold under)',
  centre: 'click the flat cloth where you pinch',
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
      color.addEventListener('input', () => { d.color = color.value; dirty = true; touched(); });
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
  const cx = numberInput(() => plan.twist.c.x, (v) => { plan.twist.c.x = v; touched(); }, { min: 0, max: 300, step: 0.5 });
  const cy = numberInput(() => plan.twist.c.y, (v) => { plan.twist.c.y = v; touched(); }, { min: 0, max: 300, step: 0.5 });
  const refreshCentre = () => { cx.value = String(plan.twist.c.x); cy.value = String(plan.twist.c.y); };
  toolButtons.centre = btn('Pick', () => setTool('centre'));
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
      row(btn('Run twist', () => { void rebuildTwist(); })),
      el('div', { class: 'note' }, 'Pinch the centre, twist, release, pat flat. A particle cloth on a table with self-collision; the core grows as fabric wraps onto it. Runs a few seconds.'));
  (window as unknown as { refreshCentre: () => void }).refreshCentre = refreshCentre;

  toolButtons.inspect = btn('Inspect', () => setTool('inspect'));
  toolButtons.dye = btn('Dye', () => setTool('dye'));
  toolButtons.band = btn('Band', () => setTool('band'));
  toolButtons.fold = btn('Draw fold line', () => setTool('fold'));

  const stepCounter = el('span', { class: 'val' }, '0');
  setInterval(() => { stepCounter.textContent = String(sim.t); }, 250);

  sideEl.replaceChildren(
    el('h1', {}, 'tiedyer', el('small', {}, 'fold · bind · dye · unfold')),
    row(
      btn('New', () => { plan = defaultPlan(); reconfigure(); refreshSwatches(); }),
      btn('Demo', () => { plan = demoPlan(); reconfigure(); refreshSwatches(); doSteps(DEMO_STEPS); }),
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
      el('div', { class: 'note' }, 'Fixing turns free dye into fixed dye up to the cloth capacity. Free dye keeps spreading; fixed dye stays. "Rinse" shows only fixed dye.'),
    ),
    el('details', { open: true },
      el('summary', {}, 'View'),
      checkbox('Rinse (show fixed dye only)', () => view.fixedOnly, (v) => { view.fixedOnly = v; dirty = true; }),
      checkbox('View & paint underside', () => view.flip, (v) => { view.flip = v; dirty = true; }),
      checkbox('Show creases on flat cloth', () => view.showCreases, (v) => { view.showCreases = v; dirty = true; }),
      checkbox('Shade by layer count', () => view.shadeLayers, (v) => { view.shadeLayers = v; dirty = true; }),
      checkbox('Show binding pressure on flat', () => view.showPress, (v) => { view.showPress = v; dirty = true; }),
      slider('colour depth', 0.2, 4, 0.1, () => view.strength, (v) => { view.strength = v; dirty = true; }, (v) => v.toFixed(1)),
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
  sim.applyStroke(s, plan.params);
  gpu?.upload();
  dirty = true;
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

// ---------------------------------------------------------------------------
// Mouse

foldedCanvas.addEventListener('pointermove', (ev) => {
  hoverFolded = renderer.foldedToCm(ev);
  if (dragging && (tool === 'dye' || tool === 'band')) {
    if (!lastStamp || dist(lastStamp, hoverFolded) >= brush.r * 0.35) {
      stampAt(hoverFolded);
      lastStamp = hoverFolded;
    }
  }
});
foldedCanvas.addEventListener('pointerleave', () => { hoverFolded = null; });
for (const c of [flatCanvas, foldedCanvas]) {
  c.draggable = false;
  c.addEventListener('dragstart', (ev) => ev.preventDefault());
  c.addEventListener('contextmenu', (ev) => ev.preventDefault());
}
foldedCanvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  foldedCanvas.setPointerCapture(ev.pointerId);
  hoverFolded = renderer.foldedToCm(ev);
  const p = renderer.foldedToCm(ev);
  if (tool === 'dye' || tool === 'band') {
    dragging = true;
    lastStamp = p;
    stampAt(p);
  } else if (tool === 'fold' && plan.mode === 'fold') {
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
window.addEventListener('pointerup', () => {
  if (dragging) {
    dragging = false;
    lastStamp = null;
    if (bandsDirty) {
      bandsDirty = false;
      pressChanged();
    }
  }
});
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
    // auto-pause once the batch is done: almost no free dye left to move
    if (frameCount % 45 === 0 && batchDone()) setPlaying(false);
  }
  const hoverKey = `${hoverFlat?.x},${hoverFlat?.y},${hoverFolded?.x},${hoverFolded?.y},${foldDraft.length}`;
  if (hoverKey !== lastHoverKey) { lastHoverKey = hoverKey; dirty = true; }
  const c1 = flatCanvas, c2 = foldedCanvas;
  if (c1.width !== Math.floor(c1.clientWidth * renderer.dpr) || c2.width !== Math.floor(c2.clientWidth * renderer.dpr)
    || c1.height !== Math.floor(c1.clientHeight * renderer.dpr) || c2.height !== Math.floor(c2.clientHeight * renderer.dpr)) dirty = true;
  if (dirty) { dirty = false; renderOnce(); }
  requestAnimationFrame(frame);
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
  if (gpu) {
    gpu.draw(plan.dyes, view);
    renderer.src = gpu.canvas;
  } else {
    renderer.updateTexture(sim, plan.dyes, view);
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

  renderer.drawFlat(sim, faces, view, flatMarkers, hoverFace);
  if (plan.mode === 'twist' && tool === 'centre') {
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
  if (plan.mode === 'twist') {
    const cloth = liveCloth ?? (isCloth(bundle) ? bundle.cloth : null);
    if (cloth) renderer.drawCloth(cloth, liveCloth ? null : renderer.textureColors(sim.N, sim.M), plan.bands, view, foldedMarkers, overlay);
  } else {
    renderer.drawFolded(sim, faces, plan.bands, view, foldedMarkers, overlay);
  }

  const shape = plan.mode === 'twist'
    ? (twistStatus ? `twisting: ${twistStatus}` : `twist ${plan.twist.turns} turns · ${sim.N}×${sim.M} particles`)
    : `${faces.length} faces · up to ${isFold(bundle) ? bundle.maxLayers : 0} layers · ${sim.N}×${sim.M} texels`;
  statusEl.textContent = `${shape} · ${gpu ? 'GPU' : 'CPU'} solver · t=${sim.t}` + '\n' + hoverInfo;
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
  rebuild: rebuildGeometry,
  addFolds,
  addStroke,
  setTool,
};

buildSidebar();
rebuildGeometry();
if (!saved) doSteps(DEMO_STEPS);
requestAnimationFrame(frame);
