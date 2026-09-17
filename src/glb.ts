// Minimal glTF 2.0 binary (.glb) writer: one textured, double-sided mesh.
//
// The bundle is Z-up in centimetres; glTF is Y-up in metres, so the mesh hangs
// under a node that rotates -90° about X and scales by 0.01. UVs are passed
// through unchanged: the flat dye image has its first row at the top, which is
// what glTF's (0,0) = top-left convention expects.

import type { Mesh3 } from './foldmesh';

export function encodeGlb(mesh: Mesh3, png: Uint8Array, name: string): Uint8Array {
  const pad4 = (n: number): number => (n + 3) & ~3;
  const idxBytes = mesh.idx.byteLength, posBytes = mesh.pos.byteLength, uvBytes = mesh.uv.byteLength;
  const oIdx = 0, oPos = pad4(oIdx + idxBytes), oUv = pad4(oPos + posBytes), oImg = pad4(oUv + uvBytes);
  const binLen = pad4(oImg + png.byteLength);
  const bin = new Uint8Array(binLen);
  bin.set(new Uint8Array(mesh.idx.buffer, mesh.idx.byteOffset, idxBytes), oIdx);
  bin.set(new Uint8Array(mesh.pos.buffer, mesh.pos.byteOffset, posBytes), oPos);
  bin.set(new Uint8Array(mesh.uv.buffer, mesh.uv.byteOffset, uvBytes), oUv);
  bin.set(png, oImg);

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.pos.length; i += 3) for (let c = 0; c < 3; c++) {
    const v = mesh.pos[i + c];
    if (v < mn[c]) mn[c] = v;
    if (v > mx[c]) mx[c] = v;
  }
  const json = {
    asset: { version: '2.0', generator: 'tiedyer' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0, rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [0.01, 0.01, 0.01] }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 1, TEXCOORD_0: 2 }, indices: 0, material: 0 }] }],
    materials: [{
      name: 'dye', doubleSided: true,
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 },
    }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: 3, mimeType: 'image/png', name: 'dye' }],
    accessors: [
      { bufferView: 0, componentType: 5125, count: mesh.idx.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: mesh.pos.length / 3, type: 'VEC3', min: mn, max: mx },
      { bufferView: 2, componentType: 5126, count: mesh.uv.length / 2, type: 'VEC2' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: oIdx, byteLength: idxBytes, target: 34963 },
      { buffer: 0, byteOffset: oPos, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: oUv, byteLength: uvBytes, target: 34962 },
      { buffer: 0, byteOffset: oImg, byteLength: png.byteLength },
    ],
    buffers: [{ byteLength: binLen }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  for (let i = 20 + jsonBytes.length; i < 20 + jsonLen; i++) out[i] = 0x20;
  const oBin = 20 + jsonLen;
  dv.setUint32(oBin, binLen, true); dv.setUint32(oBin + 4, 0x004e4942, true);
  out.set(bin, oBin + 8);
  return out;
}
