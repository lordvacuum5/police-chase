// Long grass and wildflowers on the verges.
//
// "Grass and flowers." Where a road met a field the grass stopped at a hard edge, flat to the ground. Now a
// band of tufts runs along the verge either side of every road: long grass, and here and there a clump of
// white, yellow or purple flowers. Each tuft is two crossed panels with a cut-out texture (four triangles),
// its shade and size its own; where they go comes from a hash of the place, not the map's random numbers.
// Only on grass (the grip grid's own answer), not at junctions, not against buildings. Drawn as one batch a
// cell of VERGE_CELL metres, each hidden past VERGE_FAR: up close they are the edge of the road, far off
// they are a few pixels and not worth drawing. Nothing collides with them.
//
// `window.__noVerges = true` before load leaves them out.

import * as THREE from 'three';
import { nearBuilding } from '../physics/world.js';

const VERGE_CELL = 100;
const VERGE_FAR = 150;
/** Metres along the road between tufts, how far out from the edge the band reaches, and the share that are flowers. */
const STEP = 1.1;
const BAND = 4.5;
const FLOWERS = 0.16;

function hash(a, b, k) {
  let h = Math.imul(Math.round(a * 13) ^ 0x51ed270b, 0x85ebca6b) ^ Math.imul(Math.round(b * 13) + k * 0x2f9be6c1, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Blades of grass on transparent, and (flowers) a few heads of colour among them. */
function tuftTexture(flowers) {
  const W = 128, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  let seed = flowers ? 9 : 3;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let k = 0; k < 46; k++) {
    const bx = 8 + r() * (W - 16), lean = (r() - 0.5) * 30, top = H * (0.15 + r() * 0.45);
    // Muted, as the fields are: a first, vivid green stood out of them like plastic.
    const g = 95 + Math.floor(r() * 60);
    x.strokeStyle = `rgb(${Math.floor(g * 0.72)},${Math.floor(g * 0.85)},${Math.floor(g * 0.48)})`;
    x.lineWidth = 2 + r() * 2;
    x.beginPath();
    x.moveTo(bx, H);
    x.quadraticCurveTo(bx + lean * 0.3, H * 0.6, bx + lean, top);
    x.stroke();
  }
  if (flowers) {
    const cols = ['#f4f2ea', '#f2d23a', '#b07ad8'];
    const col = cols[Math.floor(r() * 3) % 3];
    for (let k = 0; k < 9; k++) {
      x.fillStyle = r() < 0.75 ? col : cols[Math.floor(r() * 3) % 3];
      x.beginPath();
      x.arc(14 + r() * (W - 28), H * (0.12 + r() * 0.35), 3 + r() * 3, 0, Math.PI * 2);
      x.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Two crossed upright panels, 1 m square, standing on y = 0. */
function tuftGeometry() {
  const g = new THREE.BufferGeometry();
  const p = [], uv = [], n = [];
  for (const a of [0, Math.PI / 2]) {
    const dx = Math.cos(a) * 0.5, dz = Math.sin(a) * 0.5;
    p.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 0, -dz, dx, 1, dz, -dx, 1, -dz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    for (let i = 0; i < 6; i++) n.push(0, 1, 0);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  return g;
}

/** Plant the verges of `game`'s roads; returns the group added to the scene, or null. */
export function addVerges(game) {
  if (window.__noVerges || !game.graph || !game.sim.surfaceAt) return null;
  const surf = game.sim.surfaceAt, world = game.world;
  const spots = [];
  for (const e of game.graph.edges) {
    if (e.cut) continue;
    const pts = e.points;
    let carry = (e.id * 0.37) % STEP;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-3) continue;
      const tx = (b.x - a.x) / len, tz = (b.z - a.z) / len, nx = -tz, nz = tx;
      for (let s = carry; s < len; s += STEP) {
        const px = a.x + tx * s, pz = a.z + tz * s;
        for (const side of [-1, 1]) {
          const h1 = hash(px, pz, side + 2);
          const off = e.width * 0.5 + 0.8 + h1 * BAND;
          const x = px + nx * side * off + tx * (hash(pz, px, 7) - 0.5), z = pz + nz * side * off + tz * (hash(px, pz, 8) - 0.5);
          if (surf(x, z) !== 0) continue;
          if (hash(x, z, 4) < 0.25) continue;               // gaps
          if (nearBuilding(world, x, z, 0.8)) continue;
          spots.push({ x, z, f: hash(x, z, 5) < FLOWERS, s: 0.55 + hash(x, z, 6) * 0.6, r: hash(z, x, 9) * Math.PI, c: hash(x, z, 10) });
        }
      }
      carry = (carry - len) % STEP;
      if (carry < 0) carry += STEP;
    }
  }
  if (!spots.length) return null;
  const geo = tuftGeometry();
  const mats = [false, true].map((f) => new THREE.MeshLambertMaterial({
    map: tuftTexture(f), alphaTest: 0.5, side: THREE.DoubleSide,
  }));
  const cells = new Map();
  for (const s of spots) {
    const key = `${Math.floor(s.x / VERGE_CELL)},${Math.floor(s.z / VERGE_CELL)},${s.f ? 1 : 0}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(s);
  }
  const root = new THREE.Group();
  root.name = 'verges';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  for (const [key, list] of cells) {
    const [ci, cj, f] = key.split(',').map(Number);
    const ox = (ci + 0.5) * VERGE_CELL, oz = (cj + 0.5) * VERGE_CELL;
    const im = new THREE.InstancedMesh(geo, mats[f], list.length);
    list.forEach((s, i) => {
      q.setFromAxisAngle(Y, s.r);
      m.compose(p.set(s.x - ox, (game.groundAt ? game.groundAt(s.x, s.z) : 0) - 0.03, s.z - oz), q, sc.set(s.s * 1.3, s.s, s.s * 1.3));
      im.setMatrixAt(i, m);
      im.setColorAt(i, col.setRGB(0.7 + s.c * 0.25, 0.72 + s.c * 0.22, 0.62 + s.c * 0.2));
    });
    im.computeBoundingSphere();
    im.receiveShadow = true;
    const lod = new THREE.LOD();
    lod.position.set(ox, 0, oz);
    lod.addLevel(im, 0);
    lod.addLevel(new THREE.Object3D(), VERGE_FAR);
    root.add(lod);
  }
  game.scene.add(root);
  root.userData.count = spots.length;
  return root;
}
