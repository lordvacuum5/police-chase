// Hills.
//
// Every other map is flat: ground height is the kerb and nothing else (see
// common.js makeHeightAt). This one is not, and the height has to be the same
// everywhere it is asked for -- by the wheels, which ride on `sim.heightAt`
// over the flat collision plate exactly as they ride over a kerb (see
// GROUND_RELIEF in physics/vehicle.js); by the bodywork, which needs something
// to land on when a car leaves the ground or rolls, so there is a heightfield
// collider of the same shape in its own group (GROUP.HILL) that cars collide
// with and that no suspension ray or AI sweep ever sees; and by everything
// drawn, which is built flat by the map and then lifted vertex by vertex.
//
// The height is a grid, not a formula, so all three can agree: the base hills
// are a sum of broad waves, and then the grid is pulled level wherever the map
// says so -- each road's cross-section flat and its long section smoothed, so a
// lane rides over a hill rather than leaning across it; every village and
// farmyard flat; and the odd crest put back on purpose, short and sharp, for
// the player to leave the ground over.

import * as THREE from 'three';
import { RAPIER, GROUP, groups } from '../physics/world.js';
import { vertexColorMaterial } from '../util/meshbuild.js';
import { rand, TAU, clamp, lerp, smoothstep } from '../util/math.js';

/** Metres per height sample. The wheels interpolate between them. */
export const H_STEP = 4;
/** How far the bodywork's heightfield sits under the wheels' ground. See addHeightfield. */
export const HILL_SINK = 0.35;
/** The steepest a road may climb or fall, as a fraction. See buildHeightGrid. */
export const MAX_GRADE = 0.08;

/**
 * The base relief: broad overlapping waves at random bearings, shaped so the
 * valleys flatten out and the tops stay rounded, plus a few named hills. Never
 * below zero -- the collision plate is at zero and nothing may be under it.
 */
export function baseRelief(rng, opts = {}) {
  const { half = 1000, scale = 1 } = opts;
  const waves = [];
  for (let k = 0; k < 7; k++) {
    const a = rng() * TAU;
    const L = rand(rng, 140, 520);
    waves.push({ dx: Math.cos(a) / L * TAU, dz: Math.sin(a) / L * TAU, p: rng() * TAU, amp: rand(rng, 1.6, 4.2) * (L / 300) });
  }
  const hills = opts.hills || [];
  return (x, z) => {
    let h = 0;
    for (const w of waves) h += Math.sin(x * w.dx + z * w.dz + w.p) * w.amp;
    // Rolling, not corrugated: lift the whole field and soften the troughs.
    h = Math.max(0, h + 5);
    h = h * h / (h + 6);
    for (const hl of hills) {
      const d2 = ((x - hl.x) ** 2 + (z - hl.z) ** 2) / (hl.r * hl.r);
      h += hl.h * Math.exp(-d2 * 2.2);
    }
    // Down to nothing at the edge of the map, so the world edge is level.
    const edge = Math.max(Math.abs(x), Math.abs(z));
    h *= 1 - smoothstep(half - 160, half - 40, edge);
    return Math.max(0, h * scale);
  };
}

/**
 * The grid itself. `flatten` entries pull the ground toward a level: each is
 * { x, z, r, fade, h } -- level `h` (or the base height there) within `r`,
 * blending back to the hills over `fade`. `roads` is the graph: every edge's
 * centreline gets its own smoothed long section, and the ground either side of
 * it is pulled to that. `crests` are added to the road long sections after the
 * smoothing, so they survive it.
 */
export function buildHeightGrid(base, { half = 1000, graph = null, flatten = [], crests = [], roadFade = 16 } = {}) {
  const n = Math.round((half * 2) / H_STEP) + 1;
  const H = new Float32Array(n * n);
  const W = new Float32Array(n * n);      // how strongly a place has claimed the cell
  const L = new Float32Array(n * n);      // the level it was claimed at
  // Roads claim on a layer of their own, over the places. A farmyard's flat
  // pad, claimed first, used to refuse the road that met the Ridgeway beside
  // it, and the lane fell seven metres in ten into the junction. A road's
  // long section already starts and ends at the level of whatever village or
  // yard it serves, so letting it win costs those places nothing.
  // Blended where roads overlap rather than first-come: two roads leaving a
  // junction share a strip for the first stretch, and a cell that took the
  // first road's height stood as a step up into the second.
  const RW = new Float32Array(n * n);     // the strongest claim on the cell
  const RS = new Float32Array(n * n);     // sum of weight x level
  const RN = new Float32Array(n * n);     // sum of weight
  const idx = (i, j) => j * n + i;
  const toI = (x) => (x + half) / H_STEP;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      H[idx(i, j)] = base(i * H_STEP - half, j * H_STEP - half);
    }
  }

  const claim = (x, z, level, r0, r1, road = false) => {
    const i0 = Math.max(0, Math.floor(toI(x - r1))), i1 = Math.min(n - 1, Math.ceil(toI(x + r1)));
    const j0 = Math.max(0, Math.floor(toI(z - r1))), j1 = Math.min(n - 1, Math.ceil(toI(z + r1)));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = i * H_STEP - half, pz = j * H_STEP - half;
        const d = Math.hypot(px - x, pz - z);
        if (d > r1) continue;
        const w = d <= r0 ? 1 : 1 - smoothstep(r0, r1, d);
        const k = idx(i, j);
        if (road) {
          // Squared, so the road a cell is actually on outweighs one whose
          // fringe merely reaches it.
          const ww = w * w;
          RS[k] += ww * level; RN[k] += ww;
          if (w > RW[k]) RW[k] = w;
        } else if (w > W[k]) { W[k] = w; L[k] = level; }
      }
    }
  };

  // Places first, so a road through a village rides at the village's level.
  for (const f of flatten) claim(f.x, f.z, f.h !== undefined ? f.h : base(f.x, f.z), f.r, f.r + (f.fade || 30));

  if (graph) {
    // Each node a level of its own, the mean of the ground round it, so every
    // road arriving at a junction arrives at the same height.
    const nodeH = graph.nodes.map((nd) => {
      let s = 0, c = 0;
      for (let a = 0; a < 8; a++) {
        s += levelAt(nd.x + Math.cos(a) * 12, nd.z + Math.sin(a) * 12); c++;
      }
      return s / c;
    });
    for (const e of graph.edges) {
      if (e.cut) continue;
      // Samples every 3 m along the edge.
      const S = [];
      for (const sg of e.segs) {
        const steps = Math.max(1, Math.ceil(sg.len / 3));
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          S.push({ x: lerp(sg.a.x, sg.b.x, t), z: lerp(sg.a.z, sg.b.z, t), s: sg.start + sg.len * t });
        }
      }
      const last = e.segs[e.segs.length - 1];
      S.push({ x: last.b.x, z: last.b.z, s: e.length });
      // The long section: the ground under the road, averaged over 30 m
      // either side, so the lane follows the hill and not every ripple in it,
      // then pinned to the two nodes' levels at its ends.
      const raw = S.map((q) => levelAt(q.x, q.z));
      const sm = raw.map((_, k) => {
        let s = 0, c = 0;
        for (let m = Math.max(0, k - 10); m <= Math.min(raw.length - 1, k + 10); m++) { s += raw[m]; c++; }
        return s / c;
      });
      const ha = nodeH[e.a], hb = nodeH[e.b];
      const prof = new Float32Array(S.length);
      for (let k = 0; k < S.length; k++) {
        const q = S[k];
        const toEnd = Math.min(q.s, e.length - q.s);
        const pin = 1 - smoothstep(0, 40, toEnd);
        const lin = lerp(ha, hb, q.s / Math.max(1, e.length));
        prof[k] = lerp(lerp(sm[k], q.s < e.length * 0.5 ? ha : hb, pin), lin, pin * 0.3);
      }
      // No steeper than MAX_GRADE: forward and back, each sample held within
      // a grade of its neighbour, and the ends held to their nodes. Where the
      // hills are steeper the road cuts into them or rides out on a bank --
      // the ground either side is pulled to the road below. Without this the
      // Ridgeway dropped 16% off the shoulder of a hill and a car at speed
      // flew off the top of it for three seconds.
      // The ends stay at their junctions' levels: each sample is held inside
      // the cone a grade of MAX_GRADE draws from both of them, then the
      // middle is evened out without touching the ends. (Smoothing both ways
      // and letting the ends move put a lane seven metres above the junction
      // it was meant to meet.) If the two ends are too far apart in height
      // for any road at that grade, it is a straight ramp between them.
      const lastK = S.length - 1, Lr = S[lastK].s;
      prof[0] = ha; prof[lastK] = hb;
      if (Math.abs(hb - ha) > MAX_GRADE * Lr) {
        for (let k = 1; k < lastK; k++) prof[k] = lerp(ha, hb, S[k].s / Lr);
      } else {
        for (let k = 1; k < lastK; k++) {
          const sk = S[k].s;
          const lo = Math.max(ha - MAX_GRADE * sk, hb - MAX_GRADE * (Lr - sk));
          const hi = Math.min(ha + MAX_GRADE * sk, hb + MAX_GRADE * (Lr - sk));
          prof[k] = clamp(prof[k], lo, hi);
        }
        for (let pass = 0; pass < 2; pass++) {
          for (let k = 1; k < lastK; k++) {
            const lim = (S[k].s - S[k - 1].s) * MAX_GRADE;
            prof[k] = clamp(prof[k], prof[k - 1] - lim, prof[k - 1] + lim);
          }
          for (let k = lastK - 1; k >= 1; k--) {
            const lim = (S[k + 1].s - S[k].s) * MAX_GRADE;
            prof[k] = clamp(prof[k], prof[k + 1] - lim, prof[k + 1] + lim);
          }
        }
      }
      for (let k = 0; k < S.length; k++) {
        const q = S[k];
        let h = prof[k];
        for (const c of crests) {
          if (c.edge !== e.id) continue;
          const u = (q.s - c.s) / c.len;
          if (Math.abs(u) < 1) h += c.h * 0.5 * (1 + Math.cos(u * Math.PI));
        }
        claim(q.x, q.z, h, e.width * 0.5 + 3, e.width * 0.5 + 3 + roadFade, true);
      }
    }
  }

  for (let k = 0; k < H.length; k++) {
    if (W[k] > 0) H[k] = lerp(H[k], L[k], W[k]);
    if (RW[k] > 0) H[k] = lerp(H[k], RS[k] / RN[k], RW[k]);
    if (H[k] < 0) H[k] = 0;
  }

  // The level something claimed a point at, before the claims are applied:
  // what the roads read their long sections from. Places already claimed
  // (villages) win, so a road into a village meets it at its level.
  function levelAt(x, z) {
    const fi = clamp(toI(x), 0, n - 1.001), fj = clamp(toI(z), 0, n - 1.001);
    const i = Math.floor(fi), j = Math.floor(fj);
    const k = idx(i, j);
    const b = H[k];
    return W[k] > 0 ? lerp(b, L[k], W[k]) : b;
  }

  const at = (x, z) => {
    const fi = toI(x), fj = toI(z);
    if (fi < 0 || fj < 0 || fi >= n - 1 || fj >= n - 1) return 0;
    const i = Math.floor(fi), j = Math.floor(fj);
    const tx = fi - i, tz = fj - j;
    const a = H[idx(i, j)], b = H[idx(i + 1, j)];
    const c = H[idx(i, j + 1)], d = H[idx(i + 1, j + 1)];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
  let max = 0;
  for (let k = 0; k < H.length; k++) if (H[k] > max) max = H[k];
  return { n, half, step: H_STEP, H, at, max };
}

/**
 * A heightfield collider of the grid, for the bodywork to land on. Its own
 * group: vehicles collide with everything, so they meet it; the suspension
 * rays and the AI's sweeps are masked to the older groups and never see it --
 * the wheels already ride the same surface through `heightAt`, and a sweep
 * that saw a hillside rising ahead would call it a wall.
 */
export function addHeightfield(world, grid, sink = HILL_SINK) {
  const { n, half, H } = grid;
  // Rapier wants (rows + 1) x (cols + 1) heights, column-major, the grid
  // spanning `scale` in x and z centred on the collider. Rows run along x.
  const rows = n - 1, cols = n - 1;
  const heights = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {          // column = x index
    for (let j = 0; j < n; j++) {        // row = z index
      heights[i * n + j] = H[j * n + i];
    }
  }
  // Sunk below the surface the wheels ride. A car's body hangs a few
  // centimetres off the ground on its springs, and on the flat plate of the
  // other maps nothing is ever up there to meet it; here, on any slope, a
  // corner of the body met the hillside, propped the car up on it and left
  // two wheels in the air -- full throttle, going nowhere, on a 2 degree
  // slope. The collider is a net for a car that has left its wheels, not a
  // second road surface.
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -sink, 0));
  const desc = RAPIER.ColliderDesc.heightfield(rows, cols, heights, { x: half * 2, y: 1, z: half * 2 })
    .setFriction(0.9)
    .setRestitution(0.02)
    .setCollisionGroups(groups(GROUP.HILL, 0xFFFF));
  world.createCollider(desc, body);
  return body;
}

/**
 * The visible ground: a grid mesh `step` metres apart, coloured by `colourAt`
 * (which gets the height too, so slopes and tops can be shaded).
 */
export function buildTerrainMesh(grid, colourAt, step = 8, dropAt = null, hole = 0) {
  const { half, at } = grid;
  const m = Math.round((half * 2) / step) + 1;
  const pos = new Float32Array(m * m * 3);
  const col = new Float32Array(m * m * 3);
  const c = new THREE.Color();
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const x = i * step - half, z = j * step - half;
      const y = at(x, z);
      const k = (j * m + i) * 3;
      // `dropAt` lowers the drawn ground where something lies on it: the
      // mesh is coarser than the roads, and a triangle spanning a road's
      // edge and the bank beside it stood up through the tarmac in teeth.
      pos[k] = x; pos[k + 1] = y - 0.04 - (dropAt ? dropAt(x, z) : 0); pos[k + 2] = z;
      colourAt(x, z, y, c);
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
    }
  }
  const index = new Uint32Array((m - 1) * (m - 1) * 6);
  let q = 0;
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      // `hole`: leave out the middle, for a ring drawn round another mesh.
      if (hole && Math.max(Math.abs(i * step - half), Math.abs((i + 1) * step - half)) <= hole
        && Math.max(Math.abs(j * step - half), Math.abs((j + 1) * step - half)) <= hole) continue;
      const a = j * m + i, b = a + 1, d = a + m, e = d + 1;
      index[q++] = a; index[q++] = d; index[q++] = b;
      index[q++] = b; index[q++] = d; index[q++] = e;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(q < index.length ? index.slice(0, q) : index, 1));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, vertexColorMaterial());
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/** Lift every vertex of a mesh built flat by the height under it. */
export function liftMesh(mesh, at, extra = 0) {
  const g = mesh.geometry;
  const p = g.attributes.position;
  for (let k = 0; k < p.count; k++) {
    p.setY(k, p.getY(k) + at(p.getX(k), p.getZ(k)) + extra);
  }
  p.needsUpdate = true;
  g.computeBoundingSphere();
  g.computeBoundingBox();
}

/**
 * Lift each piece of a mesh by the height at the piece's own middle, rather
 * than vertex by vertex, so a building stays square on a slope instead of
 * shearing with it. `groups` is a list of vertex ranges, one per piece.
 */
export function liftPieces(mesh, at, ranges) {
  const p = mesh.geometry.attributes.position;
  for (const [s, e, x, z] of ranges) {
    const h = at(x, z);
    for (let k = s; k < e; k++) p.setY(k, p.getY(k) + h);
  }
  p.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
}
