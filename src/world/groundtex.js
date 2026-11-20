// Texture on the ground.
//
// "It'd be nice to have a bit more texture on the ground." Everything flat was one colour per vertex, so a
// field or a road was a smooth wash however close you got to it. These are grain textures, drawn here
// rather than downloaded, tiled by where a point is in the world (not by the mesh's own uvs, which most of
// the ground does not have), and multiplied over the colours already there: the colours, and what each
// surface means to the tyres, are unchanged. Plain textures, so the same under any renderer.
//
//   grass  -- blades and clumps, about GRASS_TILE metres a repeat
//   tarmac -- aggregate speckle and faint patching, about TARMAC_TILE metres a repeat
//
// `window.__flatGround = true` before load leaves the ground as it was, to compare.

import * as THREE from 'three';

const GRASS_TILE = 11;
const TARMAC_TILE = 9;
const SIZE = 512;

const cache = {};

/** A seeded random number from 0 to 1, so the textures are the same every load. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

/**
 * Smooth noise that wraps at the edges, so the tile has no seam: a few octaves of a value grid. Returns
 * a Float32Array of SIZE*SIZE values from about 0 to 1.
 */
function wrapNoise(r, cells) {
  const out = new Float32Array(SIZE * SIZE);
  let amp = 1, total = 0;
  for (let c = cells; c <= SIZE / 4; c *= 2) {
    const grid = new Float32Array(c * c);
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    const step = SIZE / c;
    for (let y = 0; y < SIZE; y++) {
      const gy = y / step, y0 = Math.floor(gy), fy = gy - y0, sy = fy * fy * (3 - 2 * fy);
      const y1 = (y0 + 1) % c;
      for (let x = 0; x < SIZE; x++) {
        const gx = x / step, x0 = Math.floor(gx), fx = gx - x0, sx = fx * fx * (3 - 2 * fx);
        const x1 = (x0 + 1) % c;
        const a = grid[y0 * c + x0], b = grid[y0 * c + x1], d = grid[y1 * c + x0], e = grid[y1 * c + x1];
        out[y * SIZE + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (d + (e - d) * sx) * sy);
      }
    }
    total += amp;
    amp *= 0.55;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function toTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Grass: clumps lighter and darker, and short blade strokes over them. Mean about 0.9, so a field keeps its tone. */
function grassTexture() {
  if (cache.grass) return cache.grass;
  const r = rng(91);
  const n = wrapNoise(r, 4);
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const x = c.getContext('2d');
  const img = x.createImageData(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = 0.7 + 0.36 * n[i] + (r() - 0.5) * 0.12;
    const g = Math.round(Math.min(1, v) * 255);
    // A shade warmer in the light patches, greener in the dark: dry tips and lush clumps.
    img.data[i * 4] = Math.round(g * (0.97 + 0.05 * n[i]));
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = Math.round(g * (0.93 + 0.04 * n[i]));
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  // Blades: thin short strokes, light and dark, drawn three times over so they wrap at the edges.
  for (let k = 0; k < 5200; k++) {
    const px = r() * SIZE, py = r() * SIZE, len = 3 + r() * 6, ang = -Math.PI / 2 + (r() - 0.5) * 0.9;
    const light = r() < 0.5;
    x.strokeStyle = light ? `rgba(255,255,230,${0.06 + r() * 0.08})` : `rgba(0,20,0,${0.08 + r() * 0.1})`;
    x.lineWidth = 1;
    for (const ox of [-SIZE, 0, SIZE]) {
      for (const oy of [-SIZE, 0, SIZE]) {
        x.beginPath();
        x.moveTo(px + ox, py + oy);
        x.lineTo(px + ox + Math.cos(ang) * len, py + oy + Math.sin(ang) * len);
        x.stroke();
      }
    }
  }
  cache.grass = toTexture(c);
  return cache.grass;
}

/** Tarmac: a fine light-and-dark speckle of stone, over broad patching. Mean about 0.8: it has to be strong, and coarse, to show on a surface this dark from a car's length away. */
function tarmacTexture() {
  if (cache.tarmac) return cache.tarmac;
  const r = rng(57);
  const n = wrapNoise(r, 2);
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const x = c.getContext('2d');
  const img = x.createImageData(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    // Broad patching first: worn and newer stretches, which is what still shows from a car's length away;
    // a fine grain under it, which only shows close to.
    const v = 0.6 + 0.4 * n[i] + (r() - 0.5) * 0.1;
    const g = Math.round(Math.max(0, Math.min(1, v)) * 255);
    img.data[i * 4] = g;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = g;
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  // Stones: chips a few centimetres across, pale and dark, wrapped at the edges.
  for (let k = 0; k < 9000; k++) {
    const px = r() * SIZE, py = r() * SIZE, w = 1.5 + r() * 2.5;
    x.fillStyle = r() < 0.55 ? `rgba(255,255,255,${0.12 + r() * 0.2})` : `rgba(0,0,0,${0.12 + r() * 0.18})`;
    for (const ox of [-SIZE, 0, SIZE]) for (const oy of [-SIZE, 0, SIZE]) x.fillRect(px + ox, py + oy, w, w);
  }
  cache.tarmac = toTexture(c);
  return cache.tarmac;
}

/**
 * Give a flat mesh the grain for `kind` ('grass' or 'tarmac'): world-position uvs on its geometry, and the
 * texture as a map on its material, which keeps everything else it had. The mesh's own position is
 * counted, but not a rotation (none of the ground has one).
 */
export function groundDetail(mesh, kind) {
  if (window.__flatGround || !mesh || !mesh.geometry || !mesh.material) return mesh;
  const tile = kind === 'tarmac' ? TARMAC_TILE : GRASS_TILE;
  const pos = mesh.geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const ox = mesh.position.x, oz = mesh.position.z;
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + ox) / tile;
    uv[i * 2 + 1] = (pos.getZ(i) + oz) / tile;
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  mesh.material.map = kind === 'tarmac' ? tarmacTexture() : grassTexture();
  mesh.material.needsUpdate = true;
  return mesh;
}
