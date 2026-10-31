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
/** The steepest a bank beside a road or a pad may be. See buildHeightGrid. */
export const BANK_GRADE = 0.45;
/** How many smoothing passes round off the lips that leaves. */
const BANK_ROUND = 3;
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
export function buildHeightGrid(base, { half = 1000, graph = null, flatten = [], crests = [], roadFade = 16, pins = [], lines = [] } = {}) {
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

  // Lines (the railway) blend among themselves like roads, on a layer of
  // their own under the roads'.
  const LW = new Float32Array(n * n), LS = new Float32Array(n * n), LN = new Float32Array(n * n);
  const claim = (x, z, level, r0, r1, road = false, line = false) => {
    const i0 = Math.max(0, Math.floor(toI(x - r1))), i1 = Math.min(n - 1, Math.ceil(toI(x + r1)));
    const j0 = Math.max(0, Math.floor(toI(z - r1))), j1 = Math.min(n - 1, Math.ceil(toI(z + r1)));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = i * H_STEP - half, pz = j * H_STEP - half;
        const d = Math.hypot(px - x, pz - z);
        if (d > r1) continue;
        const w = d <= r0 ? 1 : 1 - smoothstep(r0, r1, d);
        const k = idx(i, j);
        if (line) {
          const ww = w * w;
          LS[k] += ww * level; LN[k] += ww;
          if (w > LW[k]) LW[k] = w;
        } else if (road) {
          // Squared, so the road a cell is actually on outweighs one whose
          // fringe merely reaches it.
          const ww = w * w;
          RS[k] += ww * level; RN[k] += ww;
          if (w > RW[k]) RW[k] = w;
        } else if (w > W[k]) { W[k] = w; L[k] = level; }
      }
    }
  };

  // Each road's finished long section, for the lines that cross it.
  const roadProf = new Map();
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
        prof[k] = h;
        claim(q.x, q.z, h, e.width * 0.5 + 3, e.width * 0.5 + 3 + roadFade, true);
      }
      roadProf.set(e.id, { S, prof });
    }
  }

  // Lines that are not roads -- the railway (world/countryextras.js): a long
  // section of their own at their own grade, pinned to the road's level
  // wherever they cross one, so a level crossing is level.
  for (const ln of lines) {
    const S = [];
    let acc = 0;
    for (let k = 0; k < ln.points.length; k++) {
      if (k) acc += Math.hypot(ln.points[k].x - ln.points[k - 1].x, ln.points[k].z - ln.points[k - 1].z);
      S.push({ x: ln.points[k].x, z: ln.points[k].z, s: acc });
    }
    const raw = S.map((q) => levelAt(q.x, q.z));
    const sm = raw.map((_, k) => {
      let s = 0, c = 0;
      // Over about 50 m (points 6 m apart): smoothed over 150 m, the line
      // stood on banks and sat in cuttings -- "the train tracks need to be less
      // raised up on the ground because there's like a different level".
      for (let m = Math.max(0, k - 4); m <= Math.min(raw.length - 1, k + 4); m++) { s += raw[m]; c++; }
      return s / c;
    });
    const pinsAt = [{ s: 0, h: sm[0] }, { s: acc, h: sm[sm.length - 1] }];
    for (const c of ln.cross || []) {
      const rp = roadProf.get(c.edge);
      if (!rp) continue;
      let kk = 0;
      while (kk < rp.S.length - 1 && rp.S[kk + 1].s < c.along) kk++;
      pinsAt.push({ s: c.s, h: rp.prof[kk] });
    }
    pinsAt.sort((a, b) => a.s - b.s);
    const g = ln.grade;
    const prof = new Float32Array(S.length);
    for (let k = 0; k < S.length; k++) {
      const s = S[k].s;
      let lo = -Infinity, hi = Infinity;
      for (const p of pinsAt) {
        lo = Math.max(lo, p.h - g * Math.abs(s - p.s));
        hi = Math.min(hi, p.h + g * Math.abs(s - p.s));
      }
      if (lo <= hi) prof[k] = clamp(sm[k], lo, hi);
      else {
        // Two pins too far apart in height for the grade: straight between them.
        let a = pinsAt[0], b = pinsAt[pinsAt.length - 1];
        for (let m = 0; m < pinsAt.length - 1; m++) if (pinsAt[m].s <= s && pinsAt[m + 1].s >= s) { a = pinsAt[m]; b = pinsAt[m + 1]; }
        prof[k] = lerp(a.h, b.h, (s - a.s) / Math.max(1, b.s - a.s));
      }
    }
    ln.profile = { S, prof };
    // On a layer of its own, blended along its length like a road's, under
    // the roads': a road's own cells stay the road's, so a lane over a
    // crossing is the lane it was (blended in with the roads, the bed bent
    // them either side of every crossing). As a place instead -- the strongest
    // claim on a cell wins outright -- each sample six metres apart held its
    // own level, and the bed was a flight of steps up to 0.4 m high: "lots of
    // different levels and I keep on going through the floor". Claimed every
    // 1.5 m, between the samples too.
    for (let k = 0; k < S.length - 1; k++) {
      const len = S[k + 1].s - S[k].s, steps = Math.max(1, Math.ceil(len / 1.5));
      for (let m = 0; m < steps; m++) {
        const t = m / steps;
        claim(lerp(S[k].x, S[k + 1].x, t), lerp(S[k].z, S[k + 1].z, t), lerp(prof[k], prof[k + 1], t),
          ln.width * 0.5 + 2, ln.width * 0.5 + 2 + roadFade, false, true);
      }
    }
  }

  for (let k = 0; k < H.length; k++) {
    if (W[k] > 0) H[k] = lerp(H[k], L[k], W[k]);
    if (LW[k] > 0) H[k] = lerp(H[k], LS[k] / LN[k], LW[k]);
    if (RW[k] > 0) H[k] = lerp(H[k], RS[k] / RN[k], RW[k]);
    // Never below zero, but where a place asks for it: the quarry is dug
    // under the world's floor, which has a hole cut in it there (buildGround).
    if (H[k] < 0 && !(W[k] > 0 && L[k] < 0)) H[k] = 0;
  }

  // No bank steeper than BANK_GRADE. A road held to its grade through the
  // side of a hill cuts into it, and the fade either side was a fixed 16 m
  // however deep the cut: through Haldon Beacon that left banks of 120% --
  // fifteen metres up in twelve -- and a car that drove up one was thrown off
  // the top of it. "When I drive up a really steep bit ... I almost seem to go
  // too high." The road surfaces and the flat of the pads stay where they
  // are; everything else is held inside a cone of BANK_GRADE from its
  // neighbours, cut down where it stands too high and filled where too low,
  // by sweeping the grid forward and back.
  const pinned = new Uint8Array(n * n);
  for (let k = 0; k < H.length; k++) if (RW[k] >= 0.999 || W[k] >= 0.999 || LW[k] >= 0.999) pinned[k] = 1;
  // And whatever the map wants left exactly as it is, however steep: the
  // quarry's rim, so its face stays a cliff rather than being graded into a
  // bank. Each pin is a ring { x, z, r0, r1 }, holding the cells in it that
  // stand above `above`.
  for (const p of pins) {
    for (let j = 0; j < n; j++) {
      const pz = j * H_STEP - half;
      if (Math.abs(pz - p.z) > p.r1) continue;
      for (let i = 0; i < n; i++) {
        const px = i * H_STEP - half;
        const d = Math.hypot(px - p.x, pz - p.z);
        if (d < p.r0 || d > p.r1) continue;
        // Bar a wedge it leaves to be graded (`skip`: { dir, half }, radians):
        // the quarry's cutting, whose banks pinned as cliffs were walls a car
        // could half climb and be thrown off.
        if (p.skip) {
          const a = Math.atan2(pz - p.z, px - p.x) - p.skip.dir;
          if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < p.skip.half) continue;
        }
        const k = idx(i, j);
        if (H[k] > p.above) pinned[k] = 1;
      }
    }
  }
  let bank = BANK_GRADE;
  try { const r = sessionStorage.getItem('pc.bankGrade'); if (r !== null) bank = +r; } catch (e) { /* none */ }
  const d1 = bank * H_STEP, d2 = bank * H_STEP * Math.SQRT2;
  const NB = [[-1, 0, d1], [0, -1, d1], [-1, -1, d2], [1, -1, d2]];
  const hold = (i, j, sgn) => {
    const k = idx(i, j);
    if (pinned[k]) return;
    let h = H[k];
    for (const [di, dj, d] of NB) {
      const ii = i + di * sgn, jj = j + dj * sgn;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const o = H[idx(ii, jj)];
      if (h > o + d) h = o + d;
      else if (h < o - d) h = o - d;
    }
    H[k] = h;
  };
  if (bank < 50) {
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) hold(i, j, 1);
      for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) hold(i, j, -1);
    }
    // And round the edges the cone leaves. Held to a grade, the top of a
    // bank is a lip, and a car going over a lip leaves the ground however
    // gentle the slopes either side of it are.
    const T = new Float32Array(H.length);
    let rounds = BANK_ROUND;
    try { const r = sessionStorage.getItem('pc.bankRound'); if (r !== null) rounds = +r; } catch (e) { /* none */ }
    for (let pass = 0; pass < rounds; pass++) {
      T.set(H);
      for (let j = 1; j < n - 1; j++) {
        for (let i = 1; i < n - 1; i++) {
          const k = idx(i, j);
          if (pinned[k]) continue;
          H[k] = (T[k] * 4 + T[k - 1] + T[k + 1] + T[k - n] + T[k + n]) / 8;
        }
      }
    }
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
    // On the two triangles each cell is drawn as (buildTerrainMesh), split
    // corner (i+1, j) to (i, j+1) -- which is how the heightfield collider
    // splits them too. It was the smooth blend of the four corners, which on
    // gentle ground is the same thing, and on a steep bank is not: by the dirt
    // track out of the quarry, 59 degrees, the wheels rode a surface up to
    // 4 m from the one drawn and the one the body lands on. "If I go on the
    // edge of that ... a really steep edge, so you start having weird stuff
    // in my car."
    return tx + tz <= 1
      ? a + (b - a) * tx + (c - a) * tz
      : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  };
  let max = 0, min = 0;
  for (let k = 0; k < H.length; k++) { if (H[k] > max) max = H[k]; if (H[k] < min) min = H[k]; }
  return { n, half, step: H_STEP, H, at, max, min };
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
export function buildTerrainMesh(grid, colourAt, step = 8, dropAt = null, hole = 0, patch = null, skip = null) {
  const { at } = grid;
  // `patch`: only the square { x0, z0, size } of it, at its own step -- finer
  // ground where the coarse mesh cannot follow the shape (the quarry's cliff).
  // `skip`: leave out the cells a patch covers.
  const half = patch ? patch.size * 0.5 : grid.half;
  const ox = patch ? patch.x0 + half : 0, oz = patch ? patch.z0 + half : 0;
  const m = Math.round((half * 2) / step) + 1;
  const pos = new Float32Array(m * m * 3);
  const col = new Float32Array(m * m * 3);
  const c = new THREE.Color();
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const x = i * step - half + ox, z = j * step - half + oz;
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
  // A patch's edge meets the coarse mesh round it, whose edge runs straight
  // between every other vertex of the patch's: the ones in between are put
  // on that line, or the two leave a crack of sky.
  if (patch) {
    for (let k = 1; k < m - 1; k += 2) {
      for (const [a, b, c2] of [
        [k, k - 1, k + 1].map((i) => i),                                  // top row, j = 0
        [k, k - 1, k + 1].map((i) => (m - 1) * m + i),                    // bottom row
        [k, k - 1, k + 1].map((j) => j * m),                              // left column
        [k, k - 1, k + 1].map((j) => j * m + m - 1),                      // right column
      ]) {
        pos[a * 3 + 1] = (pos[b * 3 + 1] + pos[c2 * 3 + 1]) * 0.5;
      }
    }
  }
  const index = new Uint32Array((m - 1) * (m - 1) * 6);
  let q = 0;
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      // `hole`: leave out the middle, for a ring drawn round another mesh.
      if (hole && Math.max(Math.abs(i * step - half), Math.abs((i + 1) * step - half)) <= hole
        && Math.max(Math.abs(j * step - half), Math.abs((j + 1) * step - half)) <= hole) continue;
      if (skip && skip(i * step - half + ox, j * step - half + oz, (i + 1) * step - half + ox, (j + 1) * step - half + oz)) continue;
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
