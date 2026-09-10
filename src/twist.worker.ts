// Runs the particle cloth twist off the main thread. Posts progress snapshots
// (positions only) and the finished bundle as transferable arrays.
import { runTwist } from './cloth';
import { TwistParams } from './cloth';
import { GridDims } from './bundle';

export interface TwistRequest { id: number; W: number; H: number; N: number; tp: TwistParams; dims: GridDims }

const ctx = self as unknown as { postMessage(msg: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<TwistRequest>) => void) | null };

ctx.onmessage = async (e: MessageEvent<TwistRequest>) => {
  const { id, W, H, N, tp, dims } = e.data;
  let lastPost = 0;
  const b = await runTwist(W, H, N, tp, (phase, frac, cloth) => {
    const now = performance.now();
    if (now - lastPost < 60 && frac < 1) return;
    lastPost = now;
    ctx.postMessage({ type: 'progress', id, phase, frac, view: { N: cloth.N, M: cloth.M, n: cloth.n, h: cloth.h, x: cloth.x.slice(), y: cloth.y.slice(), z: cloth.z.slice() } });
  }, dims);
  const { cloth, contacts, weights, surfaceTop, surfaceBot, exposed, valid, px, py, pz, n, N: bn, M, cell } = b;
  const msg = { type: 'done', id, view: cloth, bundle: { n, N: bn, M, cell, valid, px, py, pz, contacts, weights, surfaceTop, surfaceBot, exposed } };
  ctx.postMessage(msg, [cloth.x.buffer, cloth.y.buffer, cloth.z.buffer, valid.buffer, px.buffer, py.buffer, pz.buffer, contacts.buffer, weights.buffer, surfaceTop.buffer, surfaceBot.buffer, exposed.buffer]);
};
