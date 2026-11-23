// Texture on the buildings.
//
// "Building textures." After the ground (world/groundtex.js: "Amazing job with the textures"), the houses
// were the flattest thing left: every wall one colour from corner to corner. The same idea as the ground:
// textures drawn here, not downloaded, mapped by where a point is in the world, multiplied over the colours
// already there, so a pink house is still pink, now pink brick.
//
// Every face of a building mesh is sorted by which way it faces: walls (near vertical) get brick -- or, in
// Ashfield City, concrete panels -- and anything sloped or flat on top gets roof tiles (or, in the city, a
// gravel roof). The mesh keeps one geometry with two material groups, walls then roofs: one more draw call
// per building mesh, which is a handful in all. Doors and windows are faces like any other, dark enough that
// the pattern barely shows on them.
//
// `window.__flatBuildings = true` before load leaves them as they were, to compare.

import * as THREE from 'three';

const SIZE = 512;
const cache = {};

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function toTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A canvas filled with a grey, and its context. */
function canvas(grey) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const x = c.getContext('2d');
  x.fillStyle = `rgb(${grey},${grey},${grey})`;
  x.fillRect(0, 0, SIZE, SIZE);
  return { c, x };
}

/** Fine speckle over everything, so no surface is perfectly flat. */
function speckle(x, r, n, amt) {
  for (let k = 0; k < n; k++) {
    const light = r() < 0.5;
    x.fillStyle = light ? `rgba(255,255,255,${amt * r()})` : `rgba(0,0,0,${amt * r()})`;
    x.fillRect(r() * SIZE, r() * SIZE, 1 + r() * 2, 1 + r() * 2);
  }
}

/**
 * Brick, stretcher bond: 24 courses and 8 bricks a course over BRICK_TILE metres (about 20 by 6.7 cm a
 * brick), each brick its own shade, mortar lighter between. Mean about 0.78: fainter than this did not show past a few metres.
 */
const BRICK_TILE = 1.6;
function brickTexture() {
  if (cache.brick) return cache.brick;
  const r = rng(11);
  const { c, x } = canvas(250);
  const rows = 24, per = 8, bh = SIZE / rows, bw = SIZE / per, m = 4;
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let k = -1; k < per; k++) {
      const v = Math.round(255 * (0.6 + r() * 0.22));
      x.fillStyle = `rgb(${v},${Math.round(v * 0.97)},${Math.round(v * 0.95)})`;
      x.fillRect(off + k * bw + m / 2, row * bh + m / 2, bw - m, bh - m);
    }
  }
  speckle(x, r, 14000, 0.12);
  cache.brick = toTexture(c);
  return cache.brick;
}

/** Concrete panels for the city: 3 by 1.5 m slabs (half that read as bathroom tiles on a tower) with dark joints, streaked by weather. Mean about 0.88. */
const PANEL_TILE = 6;
function panelTexture() {
  if (cache.panel) return cache.panel;
  const r = rng(23);
  const { c, x } = canvas(232);
  const cols = 2, rows = 4, pw = SIZE / cols, ph = SIZE / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const v = Math.round(255 * (0.84 + r() * 0.1));
      x.fillStyle = `rgb(${v},${v},${v})`;
      x.fillRect(i * pw + 2, j * ph + 2, pw - 4, ph - 4);
    }
  }
  // Rain streaks down from the joints.
  for (let k = 0; k < 90; k++) {
    const sx = r() * SIZE, sy = Math.floor(r() * rows) * ph, len = ph * (0.3 + r() * 0.7);
    const gr = x.createLinearGradient(0, sy, 0, sy + len);
    gr.addColorStop(0, `rgba(0,0,0,${0.08 + r() * 0.08})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr;
    x.fillRect(sx, sy, 2 + r() * 5, len);
  }
  speckle(x, r, 12000, 0.1);
  cache.panel = toTexture(c);
  return cache.panel;
}

/** Roof tiles: courses of overlapping tiles, each course shadowed along its lower edge. Mean about 0.82. */
const TILE_TILE = 1.2;
function roofTexture() {
  if (cache.roof) return cache.roof;
  const r = rng(37);
  const { c, x } = canvas(230);
  const rows = 6, per = 4, th = SIZE / rows, tw = SIZE / per;
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? tw / 2 : 0;
    for (let k = -1; k < per; k++) {
      const v = Math.round(255 * (0.68 + r() * 0.2));
      const gr = x.createLinearGradient(0, row * th, 0, (row + 1) * th);
      gr.addColorStop(0, `rgb(${v},${v},${v})`);
      gr.addColorStop(0.85, `rgb(${Math.round(v * 0.9)},${Math.round(v * 0.9)},${Math.round(v * 0.9)})`);
      gr.addColorStop(1, `rgb(${Math.round(v * 0.4)},${Math.round(v * 0.4)},${Math.round(v * 0.4)})`);
      x.fillStyle = gr;
      x.fillRect(off + k * tw + 2, row * th, tw - 4, th);
    }
  }
  speckle(x, r, 10000, 0.14);
  cache.roof = toTexture(c);
  return cache.roof;
}

/** A flat roof of gravel and tar, for the city's tops. Mean about 0.85. */
function gravelTexture() {
  if (cache.gravel) return cache.gravel;
  const r = rng(53);
  const { c, x } = canvas(216);
  speckle(x, r, 60000, 0.35);
  cache.gravel = toTexture(c);
  return cache.gravel;
}

/**
 * Give a building mesh its textures. `style` 'brick' (towns, villages, farms) or 'panel' (the city). The
 * geometry is non-indexed with a flat normal per face (util/meshbuild.js), so each triangle is sorted on
 * its own: walls first, roofs after, as two groups.
 */
export function buildingDetail(mesh, style = 'brick') {
  if (window.__flatBuildings || !mesh || !mesh.geometry || mesh.geometry.index) return mesh;
  const geo = mesh.geometry;
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const tris = pos.count / 3;
  const wallTile = style === 'panel' ? PANEL_TILE : BRICK_TILE;
  const roofTile = style === 'panel' ? 3 : TILE_TILE;
  const walls = [], roofs = [];
  for (let t = 0; t < tris; t++) (Math.abs(nor.getY(t * 3)) < 0.35 ? walls : roofs).push(t);
  const order = walls.concat(roofs);
  const out = {};
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name];
    out[name] = new Float32Array(a.count * a.itemSize);
  }
  const uv = new Float32Array(pos.count * 2);
  let w = 0;
  for (const t of order) {
    const nx = nor.getX(t * 3), ny = nor.getY(t * 3), nz = nor.getZ(t * 3);
    const wall = Math.abs(ny) < 0.35;
    // Along the face, level: the horizontal at right angles to the way it faces.
    let hx = nz, hz = -nx;
    const hl = Math.hypot(hx, hz);
    if (hl > 1e-3) { hx /= hl; hz /= hl; } else { hx = 1; hz = 0; }
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k, o = w * 3 + k;
      for (const name of Object.keys(geo.attributes)) {
        const a = geo.attributes[name];
        for (let c = 0; c < a.itemSize; c++) out[name][o * a.itemSize + c] = a.array[i * a.itemSize + c];
      }
      const x = pos.getX(i) + mesh.position.x, y = pos.getY(i) + mesh.position.y, z = pos.getZ(i) + mesh.position.z;
      if (wall) {
        uv[o * 2] = (x * hx + z * hz) / wallTile;
        uv[o * 2 + 1] = y / wallTile;
      } else if (hl > 0.05) {
        // A slope: courses run along it, level; the other way is distance down the slope (the
        // horizontal the face looks along, stretched by how steep it is).
        const dx = -hz, dz = hx;
        uv[o * 2] = (x * hx + z * hz) / roofTile;
        uv[o * 2 + 1] = -(x * dx + z * dz) / Math.max(0.2, Math.abs(ny)) / roofTile;
      } else {
        uv[o * 2] = x / roofTile;
        uv[o * 2 + 1] = z / roofTile;
      }
    }
    w++;
  }
  for (const name of Object.keys(out)) geo.setAttribute(name, new THREE.BufferAttribute(out[name], geo.attributes[name].itemSize));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.clearGroups();
  geo.addGroup(0, walls.length * 3, 0);
  geo.addGroup(walls.length * 3, roofs.length * 3, 1);
  const base = mesh.material;
  const wm = base.clone();
  wm.map = style === 'panel' ? panelTexture() : brickTexture();
  const rm = base.clone();
  rm.map = style === 'panel' ? gravelTexture() : roofTexture();
  mesh.material = [wm, rm];
  return mesh;
}
