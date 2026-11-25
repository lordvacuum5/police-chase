// Long grass and wildflowers on the verges.
//
// "Grass and flowers." Where a road met a field the grass stopped at a hard edge, flat to the ground. Now a
// band of tufts runs along the verge either side of every road: long grass, and here and there a clump of
// white, yellow or purple flowers. Each tuft is two crossed panels with a cut-out texture (four triangles),
// its shade and size its own; where they go comes from a hash of the place, not the map's random numbers.
// Only on grass (the grip grid's own answer), not at junctions, not against buildings. Drawn as one batch a
// cell of VERGE_CELL metres, each hidden past VERGE_FAR; all of them close by and fewer further off (DENSE,
// GROW_FROM): up close they are the edge of the road, far off a few pixels and not worth drawing. Nothing collides with them.
//
// And out across the grass in patches, not only by the road; and kept off the pavements, the drives and
// out of the houses (see `green` below).
//
// `window.__noVerges = true` before load leaves them out.

import * as THREE from 'three';
import { nearBuilding } from '../physics/world.js';
import { onDrive } from '../world/drives.js';
import { block } from './still.js';

const VERGE_CELL = 100;
/**
 * "The round foliage keeps on appearing in front of you." A cell switched on whole as you came within 150 m,
 * so a patch of grass sprang up out of nothing ahead of the car. Then each tuft grew in between 250 and 190 m
 * -- "it's extremely laggy". Now as the player put it: "the closer you get, the more detailed it becomes".
 * Every tuft has a rank (a hash of where it is); within DENSE metres all of them are drawn, and further off
 * only the higher ranks, fewer and fewer out to GROW_FROM, where none are. Each grows out of the ground over
 * its last GROW_EASE metres rather than popping. A cell is hidden (VERGE_FAR) once all of it is past GROW_FROM.
 */
const DENSE = 55;
const GROW_FROM = 240;
const GROW_EASE = 25;
const VERGE_FAR = GROW_FROM + VERGE_CELL * 0.72;
/** Metres along the road between tufts, how far out from the edge the band reaches, and the share that are flowers. */
const STEP = 1.1;
const BAND = 4.5;
const FLOWERS = 0.16;
/** Out in the fields: a tuft tried every FIELD_STEP metres, kept where the patchiness (a noise FIELD_PATCH m across) is high enough. */
const FIELD_STEP = 3.2;
const FIELD_PATCH = 34;

function hash(a, b, k) {
  let h = Math.imul(Math.round(a * 13) ^ 0x51ed270b, 0x85ebca6b) ^ Math.imul(Math.round(b * 13) + k * 0x2f9be6c1, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Smooth noise 0..1, `size` m across: where the patches are. */
function patchNoise(x, z, size) {
  const fx = x / size, fz = z / size, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const v = (a, b) => hash(a * 7.31, b * 7.31, 11);
  const top = v(i, j) + (v(i + 1, j) - v(i, j)) * sx, bot = v(i, j + 1) + (v(i + 1, j + 1) - v(i, j + 1)) * sx;
  return top + (bot - top) * sz;
}

/** A spray of hedge leaves on transparent: a rounded clump, denser low down, ragged at the edges. */
function leafSprigTexture() {
  const W = 128, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  let seed = 17;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let k = 0; k < 220; k++) {
    // Within a dome: wider at the foot, a rounded top.
    const a = r() * Math.PI, d = Math.sqrt(r());
    const px = W / 2 + Math.cos(a) * d * W * 0.46, py = H - Math.sin(a) * d * H * 0.92;
    const g = 70 + Math.floor(r() * 70);
    x.fillStyle = `rgb(${Math.floor(g * 0.55)},${Math.floor(g * 0.85)},${Math.floor(g * 0.4)})`;
    x.beginPath();
    x.ellipse(px, py, 3 + r() * 3, 2 + r() * 2, r() * Math.PI, 0, Math.PI * 2);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
export function addVerges(game, blocks = null) {
  if (window.__noVerges || !game.graph || !game.sim.surfaceAt) return null;
  const surf = game.sim.surfaceAt, graph = game.graph, map = game.world.__map || {};
  // The building footprints as the map noted them (main.js keeps them for this): the world's own list is
  // dropped once the map is built, and with it gone nearBuilding said no to everything -- "it shouldn't
  // then be inside houses".
  const world = { __blocks: blocks };
  const strips = map.driveStrips;
  /**
   * Only on the green: "it shouldn't be on the pavement... it should only be in the green". The grip grid
   * calls a footway grass where it has no kerb (Wexbury's lanes, and the edge of every pavement drawn wider
   * than its 1 m cells), so the roads say themselves how far their footway runs out (edge.pave).
   */
  // Not in Haldon's quarry: dug rock and gravel, whose walls are not on the building list.
  const quarry = map.quarry, qr = quarry ? quarry.r + 10 : 0;
  const green = (x, z) => {
    if (surf(x, z) !== 0) return false;
    // Nor on the railway's sleepers or the dirt tracks, which the grip grid calls grass.
    if (map.clearAt && map.clearAt(x, z)) return false;
    if (quarry && (x - quarry.x) * (x - quarry.x) + (z - quarry.z) * (z - quarry.z) < qr * qr) return false;
    for (const e of graph.edgesNear(x, z, 24)) {
      const keep = e.width * 0.5 + (e.pave || 0) + 0.7;
      for (const sg of e.segs) {
        const dx = sg.b.x - sg.a.x, dz = sg.b.z - sg.a.z, l2 = dx * dx + dz * dz;
        let t = l2 > 1e-9 ? ((x - sg.a.x) * dx + (z - sg.a.z) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = sg.a.x + dx * t - x, pz = sg.a.z + dz * t - z;
        if (px * px + pz * pz < keep * keep) return false;
      }
    }
    if (onDrive(strips, x, z, 0.6)) return false;
    // Nor on the garage's forecourt, which is laid after the map (game/garage.js).
    if (game.garage && game.garage.covers(x, z, 1)) return false;
    return !nearBuilding(world, x, z, 0.9);
  };
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
          const off = e.width * 0.5 + (e.pave || 0) + 0.8 + h1 * BAND;
          const x = px + nx * side * off + tx * (hash(pz, px, 7) - 0.5), z = pz + nz * side * off + tz * (hash(px, pz, 8) - 0.5);
          if (hash(x, z, 4) < 0.25) continue;               // gaps
          if (!green(x, z)) continue;
          spots.push({ x, z, f: hash(x, z, 5) < FLOWERS, s: 0.55 + hash(x, z, 6) * 0.6, r: hash(z, x, 9) * Math.PI, c: hash(x, z, 10) });
        }
      }
      carry = (carry - len) % STEP;
      if (carry < 0) carry += STEP;
    }
  }
  // And out across the grass, in patches: "I almost wish there was slightly more of it ... it looks a bit
  // odd that it's at the side of the road and not other places." Thicker where the noise is high, none
  // where it is low, so it reads as rough patches in the fields rather than an even fur.
  const half = (map.bounds || 1000) - 4;
  for (let gx = -half; gx < half; gx += FIELD_STEP) {
    for (let gz = -half; gz < half; gz += FIELD_STEP) {
      const n = patchNoise(gx, gz, FIELD_PATCH);
      const keep = (n - 0.42) * 2.2;
      if (keep <= 0 || hash(gx, gz, 12) > keep) continue;
      const x = gx + (hash(gx, gz, 13) - 0.5) * FIELD_STEP, z = gz + (hash(gz, gx, 14) - 0.5) * FIELD_STEP;
      if (!green(x, z)) continue;
      spots.push({ x, z, f: hash(x, z, 15) < FLOWERS * 0.6, s: 0.5 + hash(x, z, 16) * 0.55, r: hash(z, x, 17) * Math.PI, c: hash(x, z, 18) });
    }
  }
  // And leafy sprigs on Haldon's hedges, so up close a hedge has a ragged, leafy edge rather than a smooth
  // one: "ideally with like a bit more leaves" (world/hedges.js says where).
  for (const t of map.hedgeTops || []) {
    spots.push({ x: t.x, z: t.z, y: t.y, f: 2, s: 0.75 + hash(t.x, t.z, 19) * 0.45, r: hash(t.z, t.x, 20) * Math.PI, c: hash(t.x, t.z, 22) });
  }
  if (!spots.length) return null;
  const geo = tuftGeometry();
  const mats = [0, 1, 2].map((f) => {
    const mat = new THREE.MeshLambertMaterial({ map: f === 2 ? leafSprigTexture() : tuftTexture(f === 1), alphaTest: 0.5, side: THREE.DoubleSide });
    // Each tuft scaled by how far its foot is from the camera, along the ground: grown in, not popped in.
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float vgRank;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 vgFoot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float vgFar = ${DENSE.toFixed(1)} + ${(GROW_FROM - DENSE).toFixed(1)} * vgRank * vgRank * vgRank;
        transformed *= 1.0 - smoothstep(vgFar - ${GROW_EASE.toFixed(1)}, vgFar, distance(vgFoot.xz, cameraPosition.xz));`);
    };
    mat.customProgramCacheKey = () => 'verge-grow';
    return mat;
  });
  const cells = new Map();
  for (const s of spots) {
    const key = `${Math.floor(s.x / VERGE_CELL)},${Math.floor(s.z / VERGE_CELL)},${s.f === 2 ? 2 : s.f ? 1 : 0}`;
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
      m.compose(p.set(s.x - ox, (game.groundAt ? game.groundAt(s.x, s.z) : 0) - 0.03 + (s.y || 0), s.z - oz), q, sc.set(s.s * 1.3, s.s, s.s * 1.3));
      im.setMatrixAt(i, m);
      im.setColorAt(i, col.setRGB(0.7 + s.c * 0.25, 0.72 + s.c * 0.22, 0.62 + s.c * 0.2));
    });
    im.computeBoundingSphere();
    // Shadowed or not measured the same here (GPU minimum 5.7 ms either way at Haldon's wood), so shadowed.
    im.receiveShadow = true;
    const rank = new Float32Array(list.length);
    list.forEach((s, i) => { rank[i] = hash(s.z, s.x, 21); });
    // Its own geometry for its own ranks, sharing the tuft's vertices (uploaded once).
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'uv', 'normal']) g.setAttribute(k, geo.attributes[k]);
    g.setAttribute('vgRank', new THREE.InstancedBufferAttribute(rank, 1));
    im.geometry = g;
    const lod = new THREE.LOD();
    lod.position.set(ox, 0, oz);
    lod.addLevel(im, 0);
    lod.addLevel(new THREE.Object3D(), VERGE_FAR);
    root.add(lod);
  }
  block(root, VERGE_FAR);
  game.scene.add(root);
  root.userData.count = spots.length;
  return root;
}
