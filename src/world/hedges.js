// How a hedge is drawn.
//
// "Hedges, they now look terribly out of date ... they look horrible. Just make them look nice now. Ideally
// with like a bit more leaves, then obviously they get more detailed as [you get closer]." A hedge was a
// tapered box in one flat green: next to the new trees, grass and sky it looked like a green brick.
//
// Near, each piece is now a loft along its length: a cross-section of seven points (a narrower foot, a
// bulging middle, rounded shoulders, a crown) every HEDGE_SLICE metres, every point pushed in or out, up or
// down by a smooth noise of where it is in the world -- so the top is uneven, the sides billow, and two pieces
// that overlap at a bend agree where they meet. Darker at the foot, lighter on top, and the trees' leaf
// texture over all of it. Far, the old box, with the same texture: chunked into cells (trees.js chunkTrees),
// so the detail is only paid for near the camera. Nothing here touches the map's random numbers, nor the
// colliders: a hedge stops and slows exactly what it did.

import * as THREE from 'three';

/** Metres between cross-sections along a hedge. */
const HEDGE_SLICE = 1.7;

function hash(i, j, k) {
  let h = Math.imul(i ^ 0x2c1b3c6d, 0x85ebca6b) ^ Math.imul(j + k * 0x5bd1e995, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x297a2d39); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise 0..1, `size` m across, channel `k`. */
function noise(x, z, size, k) {
  const fx = x / size, fz = z / size, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hash(i, j, k), b = hash(i + 1, j, k), c = hash(i, j + 1, k), d = hash(i + 1, j + 1, k);
  const top = a + (b - a) * sx, bot = c + (d - c) * sx;
  return top + (bot - top) * sz;
}

const _c = new THREE.Color();

/**
 * One piece of hedge from (x0, z0) to (x1, z1), `h` tall, colour `c`, lengthened by `lap` to overlap its
 * neighbours: the lumpy body into `near`, the plain box into `far` (both MeshBuilders). Heights from y = 0;
 * the caller lifts them onto the ground. `tops`, if given, gets where leafy sprigs could stand.
 */
export function addHedge(near, far, x0, z0, x1, z1, h, c, lap, tops = null) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ux = (x1 - x0) / len, uz = (z1 - z0) / len, nx = -uz, nz = ux;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const L = len + lap;
  far.addTaperedBox(L, h + 0.8, 1.5, mx, h * 0.5 - 0.4, mz, c, 1, 0.75, Math.atan2(-uz, ux));

  const n = Math.max(2, Math.ceil(L / HEDGE_SLICE));
  // The cross-section: [across, up] for each point, as fractions; the foot is sunk 0.4 m as the box was.
  const ring = [];
  for (let k = 0; k <= n; k++) {
    const s = -L / 2 + (L * k) / n;
    const px = mx + ux * s, pz = mz + uz * s;
    const top = h + (noise(px, pz, 3.1, 1) - 0.5) * 0.7 + (noise(px, pz, 1.2, 2) - 0.5) * 0.25;
    const bulge = 0.78 + noise(px, pz, 2.3, 3) * 0.32;
    const lean = (noise(px, pz, 4.0, 4) - 0.5) * 0.25;
    const sh = 0.5 + noise(px, pz, 1.9, 5) * 0.2;
    const pts = [
      [-0.62, -0.4], [-bulge + lean, top * 0.42], [-sh + lean, top * 0.86], [lean * 0.5, top + 0.1],
      [sh + lean, top * 0.86], [bulge + lean, top * 0.42], [0.62, -0.4],
    ];
    // Shade: the foot in its own shadow, the top in the light, and a little patchiness along it.
    const vary = 0.9 + noise(px, pz, 2.7, 6) * 0.2;
    const shade = [0.55, 0.85, 1.05, 1.18, 1.05, 0.85, 0.55];
    ring.push(pts.map(([a, y], i) => ({ x: px + nx * a, y, z: pz + nz * a, s: shade[i] * vary })));
    // Where the leafy sprigs go (game/verges.js): on the crown, and out of each side.
    if (tops && k > 0) {
      tops.push({ x: px + nx * lean * 0.5, z: pz + nz * lean * 0.5, y: top - 0.3 });
      for (const sd of [-1, 1]) tops.push({ x: px + nx * (sd * bulge * 0.8 + lean), z: pz + nz * (sd * bulge * 0.8 + lean), y: top * 0.45 - 0.2 });
    }
  }
  const push = (p, q, r) => {
    // Flat-shaded, as the rest of the world is: one normal a triangle.
    const ax = q.x - p.x, ay = q.y - p.y, az = q.z - p.z, bx = r.x - p.x, by = r.y - p.y, bz = r.z - p.z;
    let cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const l = Math.hypot(cx, cy, cz) || 1;
    cx /= l; cy /= l; cz /= l;
    for (const v of [p, q, r]) {
      near.pos.push(v.x, v.y, v.z);
      near.norm.push(cx, cy, cz);
      _c.set(c).multiplyScalar(v.s);
      near.col.push(_c.r, _c.g, _c.b);
    }
  };
  for (let k = 0; k < n; k++) {
    const A = ring[k], B = ring[k + 1];
    for (let i = 0; i < A.length - 1; i++) {
      push(A[i], A[i + 1], B[i + 1]);
      push(A[i], B[i + 1], B[i]);
    }
  }
  // The two ends, a fan from the middle of each section.
  for (const [R, flip] of [[ring[0], true], [ring[n], false]]) {
    const m = { x: 0, y: 0, z: 0, s: 0.8 };
    for (const p of R) { m.x += p.x / R.length; m.y += p.y / R.length; m.z += p.z / R.length; }
    for (let i = 0; i < R.length - 1; i++) {
      if (flip) push(m, R[i + 1], R[i]); else push(m, R[i], R[i + 1]);
    }
  }
}

/**
 * Texture coordinates for a hedge mesh, each triangle flat-projected on the plane it most faces: the top from
 * above, a side along its own run. The trees' slanted projection (trees.js treeDetail) streaked the long flat
 * sides of a hedge into stripes. `tile`: metres a repeat.
 */
export function hedgeUV(mesh, tile = 1.4) {
  const g = mesh.geometry, p = g.attributes.position, nrm = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let t = 0; t < p.count; t += 3) {
    const nx = nrm.getX(t), ny = nrm.getY(t), nz = nrm.getZ(t);
    const up = Math.abs(ny) > 0.75;
    // Along the face, level: at right angles to its normal's horizontal part.
    const hl = Math.hypot(nx, nz) || 1, ax = -nz / hl, az = nx / hl;
    for (let k = t; k < t + 3; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      uv[k * 2] = (up ? x : x * ax + z * az) / tile;
      uv[k * 2 + 1] = (up ? z : y) / tile;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
