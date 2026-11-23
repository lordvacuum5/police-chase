// What a tree looks like.
//
// "Trees next." Every tree on every map was a box of a trunk under one squashed pyramid. Now two kinds:
//   broadleaf -- a tapering trunk and two or three lumpy clumps of leaves (low icosahedra, flat-shaded), each
//                its own shade, the top one lightest where the sun catches it
//   conifer   -- a thin trunk and three stacked cones, darker and bluer
// The kind, the lean of the clumps and the shades come from where the tree stands (a hash of x and z), not
// from the map's own random numbers: a draw more or less here would move everything generated after it, and
// every map, and every daily route, would come out different. The trunk collider and the canopy box are the
// callers', unchanged, and the crown stays inside the canopy box they make (about 0.39 h wide, 0.3-1.02 h up).
//
// About 50 triangles a broadleaf and 40 a conifer, against 24 for the old one: see the README for the cost.

import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';

const ico = new THREE.IcosahedronGeometry(1, 0);
// Open-ended: the underside of a bough is never seen.
const cone = new THREE.ConeGeometry(1, 1, 6, 1, true);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

const BARK = 0x463726;
const OLD = (() => { try { return sessionStorage.getItem('pc.oldtrees') === '1'; } catch (e) { return false; } })();

function hash(x, z, k) {
  let h = Math.imul(Math.round(x * 10) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(z * 10) + k * 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function blob(b, x, y, z, rx, ry, rz, turn, colour) {
  _e.set(0, turn, 0);
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, y, z), _q, _s.set(rx, ry, rz));
  b.addGeometry(ico, _m, colour);
}

function coneAt(b, x, y, z, r, h, turn, colour) {
  _e.set(0, turn, 0);
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, y, z), _q, _s.set(r, h, r));
  b.addGeometry(cone, _m, colour);
}

/**
 * Draw one tree of height `h` standing at (x, 0, z) into MeshBuilder `b`. `crown` is the colour the caller
 * chose for its leaves (kept as the base), `turn` its own random turn. `conifers`: the share that are.
 */
function oldTree(b, x, z, h, crown, turn) {
  const t = 0.55 + h * 0.035;
  b.addBox(t, h * 0.5, t, x, h * 0.25, z, BARK);
  b.addTaperedBox(h * 0.78, h * 0.72, h * 0.78, x, h * 0.66, z, crown, 0.22, 0.22, turn);
}

function farTree(b, x, z, h, base, turn, conifer) {
  if (conifer) {
    const dark = base.clone().offsetHSL(0.03, -0.05, -0.04);
    const trunk = 0.35 + h * 0.025;
    b.addBox(trunk, h * 0.5, trunk, x, h * 0.25, z, BARK, turn);
    coneAt(b, x, h * 0.66, z, h * 0.34, h * 0.72, turn, dark);
    return;
  }
  const trunk = 0.55 + h * 0.035;
  b.addBox(trunk * 0.8, h * 0.55, trunk * 0.8, x, h * 0.275, z, BARK, turn);
  const r = h * 0.34;
  blob(b, x, h * 0.68, z, r * 1.08, r * 0.95, r * 1.08, turn, _c.copy(base).offsetHSL(0, 0, 0.015));
}

export function drawTree(b, x, z, h, crown, turn, conifers = 0.25) {
  // The old tree, to compare: sessionStorage 'pc.oldtrees' = 1 and reload.
  if (OLD) { oldTree(b, x, z, h, crown, turn); return; }
  const base = new THREE.Color(crown);
  const conifer = hash(x, z, 1) < conifers;
  // And a far-off version of the same tree into `b.low` (chunkTrees): the same kind, shape and colour in
  // one piece, 18-32 triangles. It was the old pyramid at first, and the change as you came closer was
  // "very obvious".
  if (!b.low) { b.low = new MeshBuilder(); b.lowPieces = []; }
  const ls = b.low.vertexCount;
  farTree(b.low, x, z, h, base, turn, conifer);
  b.lowPieces.push([ls, b.low.vertexCount, x, z]);
  if (conifer) {
    // Darker, a touch bluer.
    const dark = base.clone().offsetHSL(0.03, -0.05, -0.04);
    const trunk = 0.35 + h * 0.025;
    b.addTaperedBox(trunk, h * 0.5, trunk, x, h * 0.25, z, BARK, 0.6, 0.6, turn);
    // The lowest boughs no lower than the old crown's (0.3 h): lower, a car seemed to drive through leaves.
    coneAt(b, x, h * 0.56, z, h * 0.36, h * 0.52, turn, dark);
    coneAt(b, x, h * 0.72, z, h * 0.27, h * 0.42, turn + 0.5, _c.copy(dark).offsetHSL(0, 0, 0.015));
    coneAt(b, x, h * 0.9, z, h * 0.16, h * 0.32, turn + 1, _c.copy(dark).offsetHSL(0, 0, 0.03));
    return;
  }
  const trunk = 0.55 + h * 0.035;
  b.addTaperedBox(trunk, h * 0.55, trunk, x, h * 0.275, z, BARK, 0.55, 0.55, turn);
  // The main clump, and one or two more leaning off it, each its own shade.
  const r = h * 0.34;
  const lean = hash(x, z, 2) * Math.PI * 2;
  const lx = Math.sin(lean), lz = Math.cos(lean);
  blob(b, x, h * 0.62, z, r, r * 0.82, r, turn, base);
  blob(b, x + lx * r * 0.45, h * 0.7, z + lz * r * 0.45, r * 0.72, r * 0.62, r * 0.72, turn + 1.3,
    _c.copy(base).offsetHSL((hash(x, z, 3) - 0.5) * 0.03, 0, 0.02));
  if (h > 11) {
    blob(b, x - lx * r * 0.3, h * 0.8, z - lz * r * 0.3, r * 0.55, r * 0.48, r * 0.55, turn + 2.1,
      _c.copy(base).offsetHSL(0, 0.02, 0.045));
  }
}

// ---------------------------------------------------------------- texture

let leafTex = null;

/** Leaves: a clumpy light-and-dark grain, multiplied over the crowns' colours. Mean about 0.86. */
function leafTexture() {
  if (leafTex) return leafTex;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = 'rgb(225,225,225)';
  x.fillRect(0, 0, S, S);
  let seed = 41;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // Clusters of leaves: small blobs, dark gaps between them and light tips on top.
  for (let k = 0; k < 2600; k++) {
    const px = r() * S, py = r() * S, rad = 2 + r() * 5;
    const v = r();
    x.fillStyle = v < 0.45 ? `rgba(0,10,0,${0.18 + r() * 0.2})` : `rgba(255,255,230,${0.1 + r() * 0.16})`;
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        x.beginPath();
        x.arc(px + ox, py + oy, rad, 0, Math.PI * 2);
        x.fill();
      }
    }
  }
  leafTex = new THREE.CanvasTexture(c);
  leafTex.wrapS = leafTex.wrapT = THREE.RepeatWrapping;
  leafTex.colorSpace = THREE.SRGBColorSpace;
  leafTex.anisotropy = 4;
  return leafTex;
}

/**
 * Give a tree mesh its leaf texture: uvs from a slanted projection of where each point is (so every face
 * of a clump, top or side, gets some of it), and the map on its material. Trunks get it too; on bark brown
 * it reads as bark.
 */
export function treeDetail(mesh, tile = 2.5) {
  if (window.__plainTrees || !mesh || !mesh.geometry) return mesh;
  const pos = mesh.geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    uv[i * 2] = (x * 0.8 + z * 0.6) / tile;
    uv[i * 2 + 1] = (y * 0.9 + x * 0.3 - z * 0.4) / tile;
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  mesh.material.map = leafTexture();
  mesh.material.needsUpdate = true;
  return mesh;
}

/** The far-off trees `drawTree` put in `builder.low`, as a mesh like the near one; null if there are none. */
export function lowTrees(builder) {
  if (!builder.low || !builder.low.vertexCount) return null;
  return treeDetail(new THREE.Mesh(builder.low.build(), vertexColorMaterial()));
}

/** Split a non-indexed geometry's triangles into cells of `cell` metres by where each one's middle is. */
function bucket(geo, cell) {
  const pos = geo.attributes.position;
  const out = new Map();
  for (let t = 0; t < pos.count / 3; t++) {
    const cx = (pos.getX(t * 3) + pos.getX(t * 3 + 1) + pos.getX(t * 3 + 2)) / 3;
    const cz = (pos.getZ(t * 3) + pos.getZ(t * 3 + 1) + pos.getZ(t * 3 + 2)) / 3;
    const key = `${Math.floor(cx / cell)},${Math.floor(cz / cell)}`;
    let list = out.get(key);
    if (!list) out.set(key, (list = []));
    list.push(t);
  }
  return out;
}

/** Those triangles of `geo` as a geometry of their own, moved so (ox, oz) is its origin. */
function pick(geo, list, ox, oz) {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name], n = a.itemSize;
    const out = new Float32Array(list.length * 3 * n);
    let o = 0;
    for (const t of list) for (let k = 0; k < 3 * n; k++) out[o++] = a.array[t * 3 * n + k];
    if (name === 'position') for (let i = 0; i < out.length; i += 3) { out[i] -= ox; out[i + 2] -= oz; }
    g.setAttribute(name, new THREE.BufferAttribute(out, n));
  }
  g.computeBoundingSphere();
  return g;
}

/** Metres a side of a cell of trees, and how far off the camera a cell is drawn with the old, cheaper trees. */
const TREE_CELL = 120;
const TREE_FAR = 260;

/**
 * A map's trees as a grid of cells instead of one mesh, each its own level of detail: the new trees near,
 * the old 24-triangle ones (`low`, from lowTrees) past TREE_FAR. As one mesh, every tree on the map was
 * drawn twice a frame, for the picture and for the shadows, wherever you looked; and the new trees, all
 * of them, cost a third more frame time than the old in a view over a wood. Returns a group under the
 * same name.
 */
export function chunkTrees(mesh, low = null, cell = TREE_CELL) {
  if (window.__oneTreeMesh || !mesh || !mesh.geometry || mesh.geometry.index) return mesh;
  const TREE_CELL = cell;
  const near = bucket(mesh.geometry, TREE_CELL);
  const far = low ? bucket(low.geometry, TREE_CELL) : new Map();
  const group = new THREE.Group();
  group.name = mesh.name;
  for (const [key, list] of near) {
    const [i, j] = key.split(',').map(Number);
    const ox = (i + 0.5) * TREE_CELL, oz = (j + 0.5) * TREE_CELL;
    const lod = new THREE.LOD();
    lod.position.set(ox, 0, oz);
    const a = new THREE.Mesh(pick(mesh.geometry, list, ox, oz), mesh.material);
    a.castShadow = mesh.castShadow;
    a.receiveShadow = mesh.receiveShadow;
    lod.addLevel(a, 0);
    if (far.has(key)) {
      const b = new THREE.Mesh(pick(low.geometry, far.get(key), ox, oz), low.material);
      b.castShadow = mesh.castShadow;
      b.receiveShadow = mesh.receiveShadow;
      lod.addLevel(b, TREE_FAR);
    }
    group.add(lod);
  }
  mesh.geometry.dispose();
  if (low) low.geometry.dispose();
  return group;
}
