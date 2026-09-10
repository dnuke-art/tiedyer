// Canvas rendering of the flat cloth and the folded bundle, plus picking.

import { Vec2, Mat, mul, apply, invert, translation, scaling, BBox } from './geom';
import { Face, foldedBBox, facesAtFolded, faceAtFlat } from './fold';
import { Sim } from './sim';
import { DyeDef, BandStamp } from './plan';

export interface ViewOpts {
  fixedOnly: boolean;
  strength: number;
  showCreases: boolean;
  shadeLayers: boolean;
  flip: boolean;
  showPress: boolean;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Fill an N x M ImageData with the dyed cloth colour. */
export function paintTexture(sim: Sim, dyes: DyeDef[], opts: ViewOpts, img: ImageData): void {
  const n = sim.N * sim.M;
  const data = img.data;
  const K = sim.nDyes;
  const logc = new Float32Array(K * 3);
  for (let k = 0; k < K; k++) {
    const [r, g, b] = hexToRgb(dyes[k]?.color ?? '#000000');
    logc[k * 3] = Math.log(Math.max(r, 2) / 255);
    logc[k * 3 + 1] = Math.log(Math.max(g, 2) / 255);
    logc[k * 3 + 2] = Math.log(Math.max(b, 2) / 255);
  }
  const s = opts.strength;
  for (let i = 0; i < n; i++) {
    let lr = 0, lg = 0, lb = 0;
    for (let k = 0; k < K; k++) {
      const a = sim.h[k][i] + (opts.fixedOnly ? 0 : sim.f[k][i]);
      if (a <= 0) continue;
      lr += a * logc[k * 3];
      lg += a * logc[k * 3 + 1];
      lb += a * logc[k * 3 + 2];
    }
    const o = i * 4;
    data[o] = 255 * Math.exp(s * lr);
    data[o + 1] = 255 * Math.exp(s * lg);
    data[o + 2] = 255 * Math.exp(s * lb);
    data[o + 3] = 255;
  }
  if (opts.showPress) {
    for (let i = 0; i < n; i++) {
      const p = sim.press[i];
      if (p < 1) {
        const o = i * 4;
        const t = 1 - p;
        data[o] = data[o] * (1 - 0.5 * t) + 255 * 0.5 * t;
        data[o + 1] = data[o + 1] * (1 - 0.5 * t) + 120 * 0.5 * t;
        data[o + 2] = data[o + 2] * (1 - 0.5 * t) + 40 * 0.5 * t;
      }
    }
  }
}

/** cm -> px transform fitting a box into a canvas with padding (px). */
export function fitTransform(box: BBox, cw: number, ch: number, pad: number, flipX = false): Mat {
  const bw = Math.max(1e-6, box.maxX - box.minX);
  const bh = Math.max(1e-6, box.maxY - box.minY);
  const s = Math.min((cw - 2 * pad) / bw, (ch - 2 * pad) / bh);
  const ox = (cw - s * bw) / 2, oy = (ch - s * bh) / 2;
  // translate box.min to origin, scale, translate to centre
  let m = mul(scaling(s, s), translation(-box.minX, -box.minY));
  if (flipX) m = mul(mul(translation(s * bw, 0), scaling(-1, 1)), m);
  return mul(translation(ox, oy), m);
}

export class Renderer {
  flat: HTMLCanvasElement;
  folded: HTMLCanvasElement;
  off: HTMLCanvasElement;
  offCtx: CanvasRenderingContext2D;
  img: ImageData | null = null;
  /** image drawn into both views; the CPU path uses `off`, the GPU path swaps in its canvas */
  src: CanvasImageSource;
  flatView: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  foldedView: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  dpr = 1;

  constructor(flat: HTMLCanvasElement, folded: HTMLCanvasElement) {
    this.flat = flat;
    this.folded = folded;
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d', { willReadFrequently: true })!;
    this.src = this.off;
  }

  ensureTexture(sim: Sim): void {
    if (this.off.width !== sim.N || this.off.height !== sim.M || !this.img) {
      this.off.width = sim.N;
      this.off.height = sim.M;
      this.img = this.offCtx.createImageData(sim.N, sim.M);
    }
  }

  updateTexture(sim: Sim, dyes: DyeDef[], opts: ViewOpts): void {
    this.ensureTexture(sim);
    paintTexture(sim, dyes, opts, this.img!);
    this.offCtx.putImageData(this.img!, 0, 0);
    this.src = this.off;
  }

  /** Resize a canvas' backing store to its CSS size. */
  static fit(c: HTMLCanvasElement, dpr: number): void {
    const w = Math.max(1, Math.floor(c.clientWidth * dpr));
    const h = Math.max(1, Math.floor(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  drawFlat(sim: Sim, faces: Face[], opts: ViewOpts, markers: Vec2[], hoverFace = -1): void {
    const c = this.flat;
    Renderer.fit(c, this.dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const pad = 12 * this.dpr;
    this.flatView = fitTransform({ minX: 0, minY: 0, maxX: sim.W, maxY: sim.H }, c.width, c.height, pad);
    const V = this.flatView;
    ctx.save();
    ctx.setTransform(V.a, V.b, V.c, V.d, V.e, V.f);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.src, 0, 0, sim.N, sim.M, 0, 0, sim.W, sim.H);
    ctx.restore();
    // outline
    ctx.lineWidth = 1 * this.dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    const o = apply(V, { x: 0, y: 0 }), e = apply(V, { x: sim.W, y: sim.H });
    ctx.strokeRect(o.x, o.y, e.x - o.x, e.y - o.y);
    if (opts.showCreases) {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1 * this.dpr;
      ctx.setLineDash([4 * this.dpr, 3 * this.dpr]);
      ctx.beginPath();
      for (const f of faces) {
        for (let i = 0; i < f.flat.length; i++) {
          const a = apply(V, f.flat[i]), b = apply(V, f.flat[(i + 1) % f.flat.length]);
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (hoverFace >= 0 && faces[hoverFace]) {
      ctx.fillStyle = 'rgba(255,200,0,0.25)';
      ctx.beginPath();
      faces[hoverFace].flat.forEach((p, i) => { const q = apply(V, p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.closePath();
      ctx.fill();
    }
    this.drawMarkers(ctx, markers.map((m) => apply(V, m)));
  }

  drawFolded(sim: Sim, faces: Face[], bands: BandStamp[], opts: ViewOpts, markers: Vec2[], overlay?: (ctx: CanvasRenderingContext2D, V: Mat) => void): void {
    const c = this.folded;
    Renderer.fit(c, this.dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (faces.length === 0) return;
    const pad = 12 * this.dpr;
    const box = foldedBBox(faces);
    this.foldedView = fitTransform(box, c.width, c.height, pad, opts.flip);
    const V = this.foldedView;
    const order = [...faces].sort((a, b) => (opts.flip ? b.z - a.z : a.z - b.z));
    for (const f of order) {
      const T = mul(V, f.T);
      ctx.save();
      ctx.setTransform(T.a, T.b, T.c, T.d, T.e, T.f);
      ctx.beginPath();
      f.flat.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.src, 0, 0, sim.N, sim.M, 0, 0, sim.W, sim.H);
      ctx.restore();
      // thin edge so faces on the same layer don't show hairline gaps
      ctx.save();
      ctx.setTransform(T.a, T.b, T.c, T.d, T.e, T.f);
      ctx.beginPath();
      f.flat.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.restore();
      ctx.lineWidth = 0.6 * this.dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.stroke();
    }
    if (opts.shadeLayers) {
      for (const f of faces) {
        ctx.fillStyle = 'rgba(20,20,60,0.10)';
        ctx.beginPath();
        f.flat.forEach((p, i) => { const q = apply(mul(V, f.T), p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
        ctx.closePath();
        ctx.fill();
      }
    }
    // bindings
    const s = Math.hypot(V.a, V.b);
    for (const b of bands) {
      const q = apply(V, b.p);
      ctx.beginPath();
      ctx.arc(q.x, q.y, b.r * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(60,60,60,0.45)';
      ctx.fill();
    }
    // outline of the whole bundle
    ctx.lineWidth = 1 * this.dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    for (const f of faces) {
      ctx.beginPath();
      f.flat.forEach((p, i) => { const q = apply(mul(V, f.T), p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.closePath();
      ctx.stroke();
      break; // only outline once via clip union is hard; outline top-most later
    }
    if (overlay) overlay(ctx, V);
    this.drawMarkers(ctx, markers.map((m) => apply(V, m)));
  }

  private drawMarkers(ctx: CanvasRenderingContext2D, pts: Vec2[]): void {
    const r = 6 * this.dpr;
    pts.forEach((q, i) => {
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? 'rgba(255,60,0,0.9)' : 'rgba(255,140,0,0.75)';
      ctx.fill();
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      if (pts.length > 1) {
        ctx.fillStyle = '#000';
        ctx.font = `${10 * this.dpr}px sans-serif`;
        ctx.fillText(String(i + 1), q.x + r + 2, q.y - r);
      }
    });
  }

  /** canvas px (client coords) -> cm in that view */
  flatToCm(ev: MouseEvent): Vec2 {
    return this.toCm(this.flat, this.flatView, ev);
  }
  foldedToCm(ev: MouseEvent): Vec2 {
    return this.toCm(this.folded, this.foldedView, ev);
  }
  private toCm(c: HTMLCanvasElement, V: Mat, ev: MouseEvent): Vec2 {
    const r = c.getBoundingClientRect();
    const px = { x: (ev.clientX - r.left) * this.dpr, y: (ev.clientY - r.top) * this.dpr };
    return apply(invert(V), px);
  }

  /** px per cm in the folded view */
  foldedScale(): number {
    return Math.hypot(this.foldedView.a, this.foldedView.b);
  }
}

export { facesAtFolded, faceAtFlat };
