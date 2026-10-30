// Haldon Vale's set pieces: the quarry, the field shortcuts and the railway.
//
// "I'd like to do some cool on the new map ... Make it more interesting." Of
// the ideas put to them they picked three: a railway with a level crossing --
// "the barriers come down and a train goes through, and if you get across in
// time the police are stuck behind it" -- farm shortcuts with gates to smash,
// and a quarry: "just a big drop off somewhere where you can like have a
// massive fall down quarry. There don't have to be loads and loads of jumps
// there, but yeah, add some jumps." And the train: "we want a modern train".
//
// Planned in two halves round the height grid: where things go (plan*), which
// the grid needs to know about -- the quarry's floor and cliff, the railway's
// long section -- and then what is built on the finished ground (build*).
//
// `ctx.clearAt(x, z)` says whether a place belongs to one of them, so the
// hedges, trees, bales and turbines keep off it.

import * as THREE from 'three';
import { GROUP, groups, addStaticBox, RAPIER, raycast } from '../physics/world.js';
import { rand, randInt, clamp, lerp, TAU } from '../util/math.js';
import { WORLD_HALF, GRID_N, CELL, MeshBuilder, vertexColorMaterial } from './common.js';
import { HILL_SINK } from './terrain.js';
import { spline, segX, pointOn, roadDistance, inVillage } from './countrygen.js';

/** Bits in the clear mask. */
const CLEAR = { RAIL: 1, SHORTCUT: 2, QUARRY: 4 };

/** The quarry floor's radius, m -- the biggest of these that fits -- and the least cliff worth the name. */
const QUARRY_SIZES = [110, 100, 90, 80, 75];
const QUARRY_MIN_CLIFF = 14;
/** How far the floor is dug below the lowest ground round it, m: the way in is a ramp down. */
const QUARRY_DIG = 16;
const RAMP_LEN = 100;
/** The rock face, from inside the floor's edge to beyond it, m: thick enough to hide the grid's own slope, which on a 4 m lattice reaches up to a diagonal (5.7 m) either side of the edge. */
const FACE_IN = 6, FACE_OUT = 7;
/** The terraces: how tall each face is meant to be, m, and how wide each ledge. See buildQuarry. */
const BENCH_RISE = 8;
/** The narrowest the floor may be left by the terraces, m: room for the jumps. */
const FLOOR_MIN = 45;
/** The haul road up the terraces: how wide, its least grade, and the level stretch at the top of each rise, rad. */
const HAUL_WIDE = 7;
const HAUL_GRADE = 0.15;
const HAUL_LANDING = 0.3;
/** How far a jump's side runs out for every metre it stands up. */
const SIDE_RUN = 1.6;
const BENCH_WIDE = 10;

/** How many shortcuts across the fields, and how much shorter than the road they must be. */
const SHORTCUTS = 8;
const SHORTCUT_GAIN = 1.8;
/** Gates: how fast one must be going to break, m/s; how long each of its four pieces is, m; how many pieces at most. */
const GATE_BREAK = 1.5;
/** Level-crossing arms: pieces one breaks into, seconds they lie there, seconds until a new arm. */
const BARRIER_BITS = 4;
const BARRIER_BITS_LAST = 25;
const BARRIER_BACK = 20;
const GATE_PART = 1.05;
const GATE_PIECES = 160;
/** A gatepost, kg: heavier than the gate, light enough to go over. */
const POST_MASS = 60;

/** The railway: its bed's width, its steepest grade, where it ends (just inside the world's edge). */
const RAIL_BED = 6;
const RAIL_GRADE = 0.07;
/** How many lines that pass to choose the best of. */
const RAIL_CHOICES = 6;
const RAIL_END = 1185;
const GAUGE = 1.435;
/** How high the rails stand off the bed, m, and how far the drawn bed reaches either side of the line. */
const RAIL_TOP = 0.14;
const BED_HALF = 9;
/** The train: how fast, how many cars, how long each, how long between runs, s. */
const TRAIN_SPEED = 33;
const CARS = 5;
const CAR_LEN = 23;
const CAR_GAP = 1;
const TRAIN_WAIT = 30;
/** Lights flash this long before the train is on the crossing, s, and the barriers are down for the last DOWN_AT. */
const LIGHTS_AT = 14;
const DOWN_AT = 10;

// =====================================================================
//  The mask
// =====================================================================

export function makeClearMask(ctx) {
  const mask = new Uint8Array(GRID_N * GRID_N);
  ctx.clearMask = mask;
  ctx.clearAt = (x, z, bits = 0xFF) => {
    const cx = ((x + WORLD_HALF) / CELL) | 0, cz = ((z + WORLD_HALF) / CELL) | 0;
    if (cx < 0 || cz < 0 || cx >= GRID_N || cz >= GRID_N) return false;
    return (mask[cz * GRID_N + cx] & bits) !== 0;
  };
}

function markDisc(ctx, x, z, r, bit) {
  const m = ctx.clearMask;
  const cx = (x + WORLD_HALF) / CELL, cz = (z + WORLD_HALF) / CELL, cr = r / CELL;
  const x0 = Math.max(0, Math.floor(cx - cr)), x1 = Math.min(GRID_N - 1, Math.ceil(cx + cr));
  const z0 = Math.max(0, Math.floor(cz - cr)), z1 = Math.min(GRID_N - 1, Math.ceil(cz + cr));
  for (let j = z0; j <= z1; j++) {
    for (let i = x0; i <= x1; i++) {
      if ((i + 0.5 - cx) ** 2 + (j + 0.5 - cz) ** 2 <= cr * cr) m[j * GRID_N + i] |= bit;
    }
  }
}

function markLine(ctx, pts, r, bit) {
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (r * 0.5)));
    for (let t = 0; t <= n; t++) markDisc(ctx, lerp(a.x, b.x, t / n), lerp(a.z, b.z, t / n), r, bit);
  }
}

/**
 * The nearest road within `r`, or null. RoadGraph.nearestEdge falls back to
 * scanning every road when its cells are empty, which across open country is
 * most of the time and far too slow to ask a few hundred thousand times.
 */
function roadNear(graph, x, z, r) {
  const cs = graph.cellSize;
  let best = null, bd = r;
  for (let cx = Math.floor((x - r) / cs); cx <= Math.floor((x + r) / cs); cx++) {
    for (let cz = Math.floor((z - r) / cs); cz <= Math.floor((z + r) / cs); cz++) {
      const list = graph.cells.get(cx * 73856093 ^ cz * 19349663);
      if (!list) continue;
      for (const id of list) {
        const e = graph.edges[id];
        // Most roads in a cell run nowhere near the point: their bounds say so
        // without walking every few-metre segment of them.
        const bb = e._bb || (e._bb = edgeBounds(e));
        if (x < bb.x0 - bd || x > bb.x1 + bd || z < bb.z0 - bd || z > bb.z1 + bd) continue;
        for (const s of e.segs) {
          const sx = s.b.x - s.a.x, sz = s.b.z - s.a.z;
          const t = clamp(((x - s.a.x) * sx + (z - s.a.z) * sz) / ((sx * sx + sz * sz) || 1), 0, 1);
          const d = Math.hypot(x - s.a.x - sx * t, z - s.a.z - sz * t);
          if (d < bd) { bd = d; best = { edge: e, dist: d, along: s.start + t * s.len }; }
        }
      }
    }
  }
  return best;
}

function edgeBounds(e) {
  const bb = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const s of e.segs) {
    for (const p of [s.a, s.b]) {
      bb.x0 = Math.min(bb.x0, p.x); bb.x1 = Math.max(bb.x1, p.x);
      bb.z0 = Math.min(bb.z0, p.z); bb.z1 = Math.max(bb.z1, p.z);
    }
  }
  return bb;
}

// =====================================================================
//  The quarry
// =====================================================================

/**
 * Where: cut into the flank of one of the named hills, away from every road,
 * village and farm, where the hill stands highest over the low side -- the
 * floor is at the level of the lowest point round it, so it opens onto the
 * fields there and is a cliff on the uphill side.
 */
export function planQuarry(ctx, base, hills) {
  let best = null;
  for (const R of QUARRY_SIZES) {
    if (best) break;
    for (const h of hills) quarrySites(ctx, base, h, R, (q) => { if (!best || q.score > best.score) best = q; });
  }
  if (!best) return null;
  markDisc(ctx, best.x, best.z, best.r + 12, CLEAR.QUARRY);
  // And the way in: "can you make maybe a dirt track go into the quarry?" From
  // the floor, up the ramp, and on in a straight line to the nearest road --
  // kept clear of hedges and trees, and drawn as ruts (buildQuarry).
  const ox = Math.cos(best.open), oz = Math.sin(best.open);
  const end = { x: best.x + ox * (best.r + RAMP_LEN), z: best.z + oz * (best.r + RAMP_LEN) };
  best.track = [
    { x: best.x + ox * best.r * 0.45, z: best.z + oz * best.r * 0.45 },
    end,
  ];
  // On to the nearest junction, not the nearest bit of road: the track is a
  // road to the police (addQuarryRoads), and a road has to meet another at a
  // junction. Within reach, and not in a village.
  let node = null, nd = 450;
  for (const n of ctx.graph.nodes) {
    if (!n.edges.length || ctx.villages.some((v) => Math.hypot(v.x - n.x, v.z - n.z) < v.r)) continue;
    // Not a farmyard, nor across one: the track ran straight to the nearest
    // junction, which could be a yard, and the dump truck on it drove through a
    // barn -- "I noticed it going through a building, like a farm building".
    if (n.edges.every((id) => ctx.graph.edges[id].farm)) continue;
    let nearFarm = false;
    for (let t = 0; t <= 1; t += 0.05) {
      const px = lerp(end.x, n.x, t), pz = lerp(end.z, n.z, t);
      if (ctx.farms.some((fm) => Math.hypot(fm.x - px, fm.z - pz) < 50)) { nearFarm = true; break; }
    }
    if (nearFarm) continue;
    const d = Math.hypot(n.x - end.x, n.z - end.z);
    if (d < nd) { nd = d; node = n; }
  }
  if (node) {
    best.track.push({ x: node.x, z: node.z });
    best.trackNode = node.id;
  }
  markLine(ctx, [{ x: best.x + ox * best.r, z: best.z + oz * best.r }, ...best.track.slice(1)], 10, CLEAR.QUARRY);
  return best;
}

function quarrySites(ctx, base, h, R, take) {
  const { graph } = ctx;
  {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      for (const f of [0.3, 0.45, 0.6, 0.75, 0.9]) {
        const x = h.x + Math.cos(a) * h.r * f, z = h.z + Math.sin(a) * h.r * f;
        if (Math.abs(x) > WORLD_HALF - 220 || Math.abs(z) > WORLD_HALF - 220) continue;
        // Room round it: the rock goes out FACE_OUT past the floor, and the rim
        // beyond that is ground a car can reach the edge over.
        if (roadNear(graph, x, z, R + FACE_OUT + 18)) continue;
        if (ctx.villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.r + R + 35)) continue;
        if (ctx.farms.some((fm) => Math.hypot(fm.x - x, fm.z - z) < R + 50)) continue;
        let lo = Infinity, hi = -Infinity, loA = 0, hiA = 0;
        for (let m = 0; m < 48; m++) {
          const b = (m / 48) * TAU;
          const y = base(x + Math.cos(b) * (R + 6), z + Math.sin(b) * (R + 6));
          if (y < lo) { lo = y; loA = b; }
          if (y > hi) { hi = y; hiA = b; }
        }
        // Dug QUARRY_DIG below the lowest point round it: "make sure the
        // quarry really drops down. A massive cliff." Opened up at its own
        // level the deepest face was 25 m; held above the world's floor, 35.
        // Then: "you can make the quarry go beneath the normal floor of the
        // map ... make it lower, because that's how it would look better."
        // So it goes under zero, through a hole in the floor (buildGround).
        const floor = lo - QUARRY_DIG;
        const cliff = hi - floor;
        if (cliff < QUARRY_MIN_CLIFF) continue;
        // The ramp in has to reach the fields without crossing a road.
        const ox = Math.cos(loA), oz = Math.sin(loA);
        let blocked = false;
        for (let d = R; d < R + RAMP_LEN - 20 && !blocked; d += 10) {
          if (roadNear(graph, x + ox * d, z + oz * d, 14)) blocked = true;
        }
        if (blocked) continue;
        // As deep as it can be, short of the cliff being all there is.
        const score = -Math.abs(cliff - 50);
        take({ x, z, r: R, floor, lo, open: loA, high: hiA, cliff, score });
      }
    }
  }
}

/**
 * What the height grid needs: the floor held level, the rim held exactly as it
 * is wherever it stands over the low side, and on the open side a ramp down
 * to the floor -- QUARRY_DIG over RAMP_LEN, gentle enough to drive out of.
 */
export function quarryGround(q, base) {
  const flatten = [{ x: q.x, z: q.z, r: q.r, fade: 0.01, h: q.floor }];
  const ox = Math.cos(q.open), oz = Math.sin(q.open);
  const ex = q.x + ox * (q.r + RAMP_LEN), ez = q.z + oz * (q.r + RAMP_LEN);
  const top = base(ex, ez);
  for (let d = q.r - 6; d <= q.r + RAMP_LEN; d += 4) {
    const t = clamp((d - (q.r - 6)) / (RAMP_LEN + 6), 0, 1);
    flatten.push({ x: q.x + ox * d, z: q.z + oz * d, r: 8, fade: 10, h: lerp(q.floor, top, t) });
  }
  return { flatten, pin: { x: q.x, z: q.z, r0: q.r + 0.01, r1: q.r + 9, above: q.floor + 2.5 } };
}

/**
 * The hole in the world's floor plate the quarry needs, since its floor and
 * the bottom of its ramp are under zero: the quarry and the ramp, with room
 * round them, and the depth of the plate under it. See buildGround.
 */
export function quarryHole(q) {
  const ox = Math.cos(q.open), oz = Math.sin(q.open);
  const ex = q.x + ox * (q.r + RAMP_LEN), ez = q.z + oz * (q.r + RAMP_LEN);
  const pad = q.r + FACE_OUT + 20;
  return {
    x0: Math.min(q.x - pad, ex - 30), x1: Math.max(q.x + pad, ex + 30),
    z0: Math.min(q.z - pad, ez - 30), z1: Math.max(q.z + pad, ez + 30),
    deep: q.floor - 4,
  };
}

/** Eight corners -> a closed prism, flat-shaded, into `b`. Corners: bottom 0-3, top 4-7, same order. */
function addPrism(b, c, colour) {
  const tri = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const pos = [];
  for (const t of tri) for (const k of t) pos.push(c[k][0], c[k][1], c[k][2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  b.addGeometry(g, new THREE.Matrix4(), colour);
  g.dispose();
}

/** The same eight corners as a fixed convex collider. */
function addHull(world, c, group = GROUP.BUILDING) {
  const pts = new Float32Array(c.length * 3);
  c.forEach((p, k) => { pts[k * 3] = p[0]; pts[k * 3 + 1] = p[1]; pts[k * 3 + 2] = p[2]; });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const desc = RAPIER.ColliderDesc.convexHull(pts);
  if (!desc) return null;
  world.createCollider(desc.setFriction(0.9).setCollisionGroups(groups(group, 0xFFFF)), body);
  return body;
}

/**
 * A jump: a kicker curving up from the ground to `height` over `len`, `width`
 * wide, its lip at (x, z) and its run-up behind it along -heading. Built of
 * convex slices so the face is curved -- flat at the foot, so a car rolls onto
 * it rather than into it, and steep at the lip. Each slice stands on the
 * ground under it, so it works on a slope.
 */
function addKicker(ctx, b, x, z, heading, len, width, height, colour) {
  const at = ctx.at;
  const fx = Math.sin(heading), fz = Math.cos(heading);      // toward the lip
  const sx = fz, sz = -fx;                                     // across
  const N = 6;
  const P = (s, side, out = 0) => ({ x: x - fx * (len - s) + sx * side * (width * 0.5 + out), z: z - fz * (len - s) + sz * side * (width * 0.5 + out) });
  const y = (s) => height * Math.pow(s / len, 1.7);
  for (let k = 0; k < N; k++) {
    const s0 = (k / N) * len, s1 = ((k + 1) / N) * len;
    const c = [];
    // Sloped sides, and at the lip a sloped back: a car that comes at it
    // from the side or from behind rides up it. With straight sides, one
    // driven into the side was shoved down through the floor.
    const corners = [P(s0, -1), P(s1, -1), P(s1, 1), P(s0, 1)];
    const ss = [s0, s1, s1, s0];
    for (let m = 0; m < 4; m++) {
      const sl = (y(ss[m]) + 0.6) * SIDE_RUN;
      let q = P(ss[m], m === 0 || m === 1 ? -1 : 1, sl);
      if (k === N - 1 && (m === 1 || m === 2)) q = { x: q.x + fx * (height + 0.6) * SIDE_RUN, z: q.z + fz * (height + 0.6) * SIDE_RUN };
      c.push([q.x, at(q.x, q.z) - 0.6, q.z]);
    }
    for (let m = 0; m < 4; m++) c.push([corners[m].x, at(corners[m].x, corners[m].z) + y(ss[m]) - (k === 0 && m % 3 === 0 ? 0.05 : 0), corners[m].z]);
    addHull(ctx.sim.world, c, GROUP.HILL | GROUP.RAMP);
    addPrism(b, c, colour);
  }
}

/** A table: up, a flat top, down. One convex piece. */
function addTable(ctx, b, x, z, heading, up, top, down, width, height, colour) {
  const at = ctx.at;
  const fx = Math.sin(heading), fz = Math.cos(heading), sx = fz, sz = -fx;
  const ground = at(x, z);
  const along = [-(top * 0.5 + up), -top * 0.5, top * 0.5, top * 0.5 + down];
  const hts = [0, height, height, 0];
  // Two hulls -- the up ramp and flat top, then the down ramp -- each convex.
  for (const [i0, i1, i2] of [[0, 1, 2], [1, 2, 3]]) {
    const c = [];
    const bottom = [], tops = [];
    for (const side of [-1, 1]) {
      for (const i of [i0, i1, i2]) {
        const px = x + fx * along[i] + sx * side * width * 0.5, pz = z + fz * along[i] + sz * side * width * 0.5;
        // Sloped sides, as on the kicker.
        const out = (hts[i] + 0.6) * SIDE_RUN;
        bottom.push([px + sx * side * out, ground - 0.6, pz + sz * side * out]);
        tops.push([px, ground + hts[i] - (hts[i] === 0 ? 0.05 : 0), pz]);
      }
    }
    for (const p of bottom) c.push(p);
    for (const p of tops) c.push(p);
    addHull(ctx.sim.world, c, GROUP.HILL | GROUP.RAMP);
    // Drawn as two prisms per hull: the slope and the flat.
    for (const [a, bb] of [[0, 1], [1, 2]]) {
      addPrism(b, [bottom[a], bottom[bb], bottom[bb + 3], bottom[a + 3], tops[a], tops[bb], tops[bb + 3], tops[a + 3]], colour);
    }
  }
}

/**
 * The quarry, on the finished ground: the rock face round the uphill side of
 * the floor -- solid, the grid's own cliff hidden behind it -- the jumps, and
 * the bales to aim at. Returns the meshes.
 */
const STEPS = 64;

/** The rim's height all the way round, STEPS + 1 of them: level with the ground behind the face, so a car comes onto it without a step. */
function quarryRims(ctx, q) {
  const rims = [];
  for (let m = 0; m <= STEPS; m++) {
    const a = (m / STEPS) * TAU;
    rims.push(ctx.at(q.x + Math.cos(a) * (q.r + FACE_OUT + 0.3), q.z + Math.sin(a) * (q.r + FACE_OUT + 0.3)));
  }
  return rims;
}

/**
 * On the finished ground, before the hedges and trees: the way off the top,
 * kept clear of them, and the bales on the floor. `q.edge` is where.
 *
 * Where the drop is deep and the ground up to the edge is smooth. At the
 * deepest point the way up came over the top of the hill, and a car doing
 * 100 km/h left the ground on the crest and was on its roof before it reached
 * the edge. A kicker at the edge was tried too: the ground climbs to the rim,
 * and a car on the grass at 40-60 km/h stalled on the kicker and rolled back
 * down it. Driving off the edge is the jump.
 */
export function planQuarryEdge(ctx, q) {
  const rims = quarryRims(ctx, q);
  const lipR = q.r + FACE_OUT + 0.5;
  let pick = q.high, pickScore = -Infinity, drop = 0;
  for (let m = 0; m < STEPS; m++) {
    const a = (m / STEPS) * TAU;
    const d = rims[m] - q.floor;
    if (d < 12) continue;
    let rough = 0, rise = 0, prev = rims[m];
    for (let r = lipR + 4; r <= lipR + 80; r += 4) {
      const h = ctx.at(q.x + Math.cos(a) * r, q.z + Math.sin(a) * r);
      rough = Math.max(rough, Math.abs(h - prev) / 4);
      rise = Math.max(rise, h - rims[m]);
      prev = h;
    }
    const score = d - 60 * Math.max(0, rough - 0.1) - 2 * Math.max(0, rise - 2);
    if (score > pickScore) { pickScore = score; pick = a; drop = d; }
  }
  const hx = Math.cos(pick), hz = Math.sin(pick);
  markLine(ctx, [{ x: q.x + hx * lipR, z: q.z + hz * lipR }, { x: q.x + hx * (lipR + 90), z: q.z + hz * (lipR + 90) }], 12, CLEAR.QUARRY);
  q.edge = { x: q.x + hx * lipR, z: q.z + hz * lipR, heading: Math.atan2(-hx, -hz), drop };
  // Bales lined up past the floor kicker's landing, to be scattered.
  const ox = Math.cos(q.open), oz = Math.sin(q.open), tx = -oz, tz = ox;
  const bales = [];
  for (let k = 0; k < 6; k++) {
    const a = 22 + (k % 3) * 2.2, c = 30 + Math.floor(k / 3) * 2.2;
    bales.push({ x: q.x + ox * a + tx * c, z: q.z + oz * a + tz * c, rot: 0 });
  }
  return bales;
}

export function buildQuarry(ctx, q) {
  const rng = ctx.xrng;
  const W = ctx.sim.world;
  const b = new MeshBuilder();
  const rims = quarryRims(ctx, q);
  // Terraced. "The quarry needs terracing ... have a look at a proper quarry
  // photo." The one looked at, Stoneycombe in Devon, is five or six benches of
  // near-sheer pink-grey limestone, each face six to ten metres, the ledges
  // grassed over and pale scree at the foot. One wall from floor to rim, ours
  // read as a concrete dam. So: two to five faces of about BENCH_RISE each, every
  // one set back BENCH_WIDE from the one below, the top one where the single
  // face was (so the way off the top is the same drop, onto a ledge if you go
  // over it slowly), the ledges green. The benches go into the floor, which is
  // why it is as wide as it is.
  let tallest = 0;
  for (const h of rims) tallest = Math.max(tallest, h - q.floor);
  const tiers = clamp(Math.round(tallest / BENCH_RISE), 2, 5);
  q.tiers = tiers;
  // Ledges a car can be on: "the terracing on the quarry, you can't actually
  // go on individual ones ... I seem to just kind of slide off". They were 5 m
  // and wandered 30% either way: 3 m in places, under a car's length. Now
  // BENCH_WIDE where the quarry has room for it, keeping a floor of FLOOR_MIN
  // for the jumps, and wandering a tenth.
  const bench = Math.min(BENCH_WIDE, (q.r - FACE_IN - FLOOR_MIN) / Math.max(1, tiers - 1));
  q.bench = bench;
  q.inner = q.r - FACE_IN - (tiers - 1) * bench;
  const P = (a, r) => [q.x + Math.cos(a) * r, q.z + Math.sin(a) * r];
  // Not a stadium: each ledge wanders in and out, and each face is a little
  // taller or shorter, smoothly round the circle so neighbouring slices meet.
  const rAt = (a, j) => q.r - FACE_IN - (tiers - 1 - j) * bench
    + (j < tiers - 1 ? Math.sin(a * 5 + j * 2.1) * bench * 0.1 : 0);
  const tAt = (a, h, j) => q.floor + (h - q.floor) * Math.min(1, (j + 1) / tiers
    + (j < tiers - 1 ? Math.sin(a * 3 + j * 1.3) * 0.04 : 0));
  const rimAt = (a) => {
    const f = ((((a % TAU) + TAU) % TAU) / TAU) * STEPS, m = Math.min(STEPS - 1, Math.floor(f));
    return lerp(rims[m], rims[m + 1], f - m);
  };
  // The top of the rock at an angle, for the haul truck's way out (countrylife.js).
  q.rimAt = rimAt;
  q.rimOut = q.r + FACE_OUT;
  q.rimIn = q.r - FACE_IN;
  const ledge = (s) => new THREE.Color().setHSL(rand(rng, 0.22, 0.27), rand(rng, 0.25, 0.4), rand(rng, 0.22, 0.3) + s);
  // Half the angle of the cutting the ramp comes in through.
  const gap = 13 / q.inner;
  // The face, in slices round the circle. Each slice's tops run from one
  // angle's height to the next, so a ledge is one surface you can drive along
  // rather than a row of steps.
  for (let m = 0; m < STEPS; m++) {
    const a0 = (m / STEPS) * TAU, a1 = ((m + 1) / STEPS) * TAU;
    const h0 = rims[m], h1 = rims[m + 1];
    // All the way round but for the cutting the ramp comes in through. Dug
    // below the low side, the quarry is a drop there too; walled only where
    // the ground stood high, as when it was not, the low side was left as raw
    // graded banks -- "it almost looks like there's a few bits left over".
    const mid = (a0 + a1) / 2;
    if (Math.abs(Math.atan2(Math.sin(mid - q.open), Math.cos(mid - q.open))) < gap) continue;
    if (Math.max(h0, h1) - q.floor < 2.5) continue;
    const lo = q.floor - 1.5, r1 = q.r + FACE_OUT;
    for (let i = 0; i < tiers; i++) {
      const ra = rAt(a0, i), rb = rAt(a1, i);
      const t0 = tAt(a0, h0, i), t1 = tAt(a1, h1, i);
      const [ax, az] = P(a0, ra), [bx, bz] = P(a1, rb), [cx, cz] = P(a1, r1), [dx, dz] = P(a0, r1);
      // The top one's outer edge let down under the hills' collider, which is
      // sunk HILL_SINK under the drawn ground: level with the drawn ground, it
      // stood up out of the collider a car's body rests on as a kerb all the
      // way round, 0.3-0.7 m. "When I kept on coming to the edge of the
      // quarry, I kept on hitting an invisible barrier. At least the police
      // cars did."
      const lip = i === tiers - 1 ? HILL_SINK + 0.15 : 0;
      const c = [
        [ax, lo, az], [bx, lo, bz], [cx, lo, cz], [dx, lo, dz],
        [ax, t0, az], [bx, t1, bz], [cx, t1 - lip, cz], [dx, t0 - lip, dz],
      ];
      addHull(W, c);
      // Pink-grey limestone, a little different face by face.
      addPrism(b, c, new THREE.Color().setHSL(rand(rng, 0.02, 0.07), rand(rng, 0.14, 0.32), rand(rng, 0.46, 0.62)));
      // A band of darker bedding across the face, a little proud of it.
      const b0 = q.floor + (Math.min(h0, h1) - q.floor) * (i + 0.45) / tiers;
      const [ex, ez] = P(a0, ra - 0.08), [fx2, fz2] = P(a1, rb - 0.08);
      b.addWall([{ x: ex, z: ez }, { x: fx2, z: fz2 }], b0, b0 + 0.6, new THREE.Color().setHSL(0.05, 0.12, 0.4));
      // The ledge on top, grassed, up to the foot of the face above, with
      // scrub growing on it.
      if (i < tiers - 1) {
        const na = rAt(a0, i + 1), nb = rAt(a1, i + 1);
        const [gx, gz] = P(a1, nb), [hx2, hz2] = P(a0, na);
        addPrism(b, [
          [ax, t0 - 0.05, az], [bx, t1 - 0.05, bz], [gx, t1 - 0.05, gz], [hx2, t0 - 0.05, hz2],
          [ax, t0 + 0.06, az], [bx, t1 + 0.06, bz], [gx, t1 + 0.06, gz], [hx2, t0 + 0.06, hz2],
        ], ledge(rand(rng, -0.04, 0.06)));
        if (rng() < 0.55) {
          const u = rng(), am = lerp(a0, a1, u), rm = lerp(lerp(ra, rb, u), lerp(na, nb, u), rand(rng, 0.3, 0.7));
          const [bx2, bz2] = P(am, rm), s = rand(rng, 0.8, 1.8);
          b.addTaperedBox(s * 1.6, s, s * 1.6, bx2, lerp(t0, t1, u) + s * 0.5, bz2, ledge(-0.05), 0.4, 0.4, rng() * TAU);
        }
      }
    }
  }
  // The haul road, as in any working quarry: a ramp up the foot of each face
  // in turn, from the floor to the first ledge, ledge to ledge, and from the
  // last to the rim, each starting where the one below came out, round the
  // quarry from just past the cutting. Without it a ledge could only be
  // reached by falling onto it. Each rise runs along the foot of the face it
  // climbs, HAUL_WIDE across, then levels off for a landing flush with the
  // ledge above, long enough to ease out onto it -- a short one ended with the
  // ledge below straight ahead, and the test car went off the end of it and
  // down a level. As steep as it has to be to go round once in the room
  // there is, and no less steep than HAUL_GRADE.
  const ledgeAt = (a, k) => (k < 0 ? q.floor : tAt(a, rimAt(a), k));
  const room = TAU - 2 * gap - 0.4;
  // The angle all the rises would take at a grade of one, against the angle
  // left once the landings are taken out.
  let need = 0;
  for (let k = 0; k < tiers; k++) {
    const a = q.open + gap + 0.2 + (k * room) / tiers;
    need += (ledgeAt(a, k) - ledgeAt(a, k - 1)) / (rAt(a, k) - HAUL_WIDE * 0.5);
  }
  const grade = Math.max(HAUL_GRADE, need / (room - tiers * HAUL_LANDING));
  const haul = [], haulPath = [], haulBreaks = [];
  let a = q.open + gap + 0.2;
  for (let k = 0; k < tiers; k++) {
    const rise = ledgeAt(a, k) - ledgeAt(a, k - 1);
    const span = rise / grade / (rAt(a, k) - HAUL_WIDE * 0.5);
    const N = Math.max(2, Math.ceil((span + HAUL_LANDING) / 0.04));
    const total = span + HAUL_LANDING;
    for (let s = 0; s < N; s++) {
      const s0 = a + (total * s) / N, s1 = a + (total * (s + 1)) / N;
      // Up the slope, then level at the ledge above.
      const y = (aa) => lerp(ledgeAt(aa, k - 1), ledgeAt(aa, k), Math.min(1, (aa - a) / span));
      const out0 = rAt(s0, k), out1 = rAt(s1, k);
      const in0 = out0 - HAUL_WIDE, in1 = out1 - HAUL_WIDE;
      const base0 = ledgeAt(s0, k - 1) - 0.6, base1 = ledgeAt(s1, k - 1) - 0.6;
      const [ax, az] = P(s0, in0), [bx, bz] = P(s1, in1), [cx, cz] = P(s1, out1 + 0.3), [dx, dz] = P(s0, out0 + 0.3);
      const c = [
        [ax, base0, az], [bx, base1, bz], [cx, base1, cz], [dx, base0, dz],
        [ax, y(s0), az], [bx, y(s1), bz], [cx, y(s1), cz], [dx, y(s0), dz],
      ];
      addHull(W, c);
      addPrism(b, c, new THREE.Color().setHSL(0.08, 0.12, 0.5 + (s % 2) * 0.015));
    }
    haul.push({ from: a, to: a + total, tier: k });
    // The middle of the road, with its height, for the dump truck that works
    // it (countrylife.js): up the rise, then easing out across the landing
    // to the middle of the next rise's lane.
    for (let aa = a; aa <= a + total + 1e-6; aa += 0.02) {
      const u = clamp((aa - a - span) / HAUL_LANDING, 0, 1);
      const out = k < tiers - 1 ? rAt(aa, k + 1) - HAUL_WIDE * 0.5 : rAt(aa, k) - HAUL_WIDE * 0.5;
      const [px, pz] = P(aa, lerp(rAt(aa, k) - HAUL_WIDE * 0.5, out, u));
      haulPath.push({ x: px, z: pz, y: lerp(ledgeAt(aa, k - 1), ledgeAt(aa, k), Math.min(1, (aa - a) / span)) });
    }
    // Where this rise comes out onto its ledge: a junction, to the police.
    haulBreaks.push(haulPath.length - 1);
    a += total;
  }
  q.haul = haul;
  q.haulPath = haulPath;
  q.haulBreaks = haulBreaks;
  q.haulGrade = grade;
  // Scree heaps at the foot of the deepest faces, pale, to drive up -- not on
  // the haul road's first rise, which runs along the foot of the first face.
  const onRoad = (aa) => {
    const h0 = haul[0];
    const d = Math.atan2(Math.sin(aa - h0.from), Math.cos(aa - h0.from));
    return d >= -0.15 && d <= h0.to - h0.from + 0.15;
  };
  for (let k = 0; k < 4; k++) {
    const a = q.high + (k - 1.5) * 0.45;
    if (onRoad(a)) continue;
    const r = q.inner - 5;
    const [sx, sz] = P(a, r);
    const g = ctx.at(sx, sz);
    const w = rand(rng, 5, 7), top = rand(rng, 1.2, 2), h = rand(rng, 2, 3.2);
    const fx = Math.cos(a), fz = Math.sin(a), px = -fz, pz = fx;
    const c = [];
    for (const [half, y] of [[w, g - 0.5], [top, g + h]]) {
      for (const [u, v] of [[-1, -1], [-1, 1], [1, 1], [1, -1]]) c.push([sx + fx * u * half + px * v * half, y, sz + fz * u * half + pz * v * half]);
    }
    addHull(W, c, GROUP.HILL | GROUP.RAMP);
    addPrism(b, c, new THREE.Color().setHSL(0.07, 0.06, rand(rng, 0.66, 0.74)));
  }

  // The jumps. "There don't have to be loads and loads of jumps."
  const ox = Math.cos(q.open), oz = Math.sin(q.open);          // toward the open side
  const tx = -oz, tz = ox;                                      // across the floor
  const ramp = 0x8c8070;
  // On the floor: a kicker across it, and a table to clear.
  const kx = q.x + ox * 22 - tx * 12, kz = q.z + oz * 22 - tz * 12;
  addKicker(ctx, b, kx, kz, Math.atan2(tx, tz), 10, 5, 2.2, ramp);
  addTable(ctx, b, q.x - ox * 22, q.z - oz * 22, Math.atan2(-tx, -tz), 9, 7, 9, 6, 1.8, ramp);

  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'quarry';
  // The dirt track in: ruts from the floor up the ramp and on to the road.
  const t = new MeshBuilder();
  const pts = [];
  for (let k = 0; k < q.track.length - 1; k++) {
    const a = q.track[k], c = q.track[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.z - a.z) / 3));
    for (let m = 0; m < n; m++) pts.push({ x: lerp(a.x, c.x, m / n), z: lerp(a.z, c.z, m / n) });
  }
  pts.push(q.track[q.track.length - 1]);
  t.addRibbon(pts, 5, 0, 0x6b5640);
  t.addRibbon(pts, 0.6, 0.01, 0x4a3a2a, 1.0);
  t.addRibbon(pts, 0.6, 0.01, 0x4a3a2a, -1.0);
  const ruts = new THREE.Mesh(t.build(), vertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  const drawn = ctx.drawnAt || ctx.at;
  const p = ruts.geometry.attributes.position;
  for (let k = 0; k < p.count; k++) p.setY(k, p.getY(k) + drawn(p.getX(k), p.getZ(k)) + 0.06);
  p.needsUpdate = true;
  ruts.geometry.computeBoundingSphere();
  ruts.receiveShadow = true;
  ruts.name = 'quarry-track';
  return [mesh, ruts];
}

/**
 * The quarry's ways in and up, as roads the police can plan along. "The
 * routing system by the quarry is messed up in the quarry. So make sure it has
 * a routing system in there." With no road in it, a car down in the quarry was
 * nowhere to the planner: the nearest junction was up on the lanes, and the
 * police tried to get to the car from there, into the rock. Now: the dirt
 * track from its junction to the ramp's top and down onto the floor, across
 * the floor to the foot of the haul road, and up the haul road with a junction
 * where each rise comes out on its ledge, so a car on a ledge is near a
 * junction on that ledge. Dirt tracks to a dead end; laid on the graph after
 * everything else (RoadGraph.reindex), so they are not drawn as tarmac or
 * levelled into the ground. Their nodes are kept out of RoadGraph.randomNode,
 * so traffic and patrols are not sent down them at random.
 */
export function addQuarryRoads(graph, q) {
  if (!q || !q.track || q.trackNode === undefined || !q.haulPath) return;
  const node = (p) => { const n = graph.addNode(p.x, p.z, 'lane'); n.quarry = true; if (p.y !== undefined) n.y = p.y; return n; };
  const road = (a, b, pts, name) => {
    const e = graph.addEdge(a, b, 'track', pts, { width: HAUL_WIDE, speed: 12 });
    e.quarry = true;
    e.name = name;
    return e;
  };
  const top = graph.nodes[q.trackNode];
  const rampTop = node(q.track[1]);
  const floor = node({ ...q.track[0], y: q.floor });
  road(top, rampTop, null, 'the quarry track');
  road(rampTop, floor, null, 'the quarry track');
  const H = q.haulPath;
  let prev = node(H[0]);
  road(floor, prev, null, 'the quarry floor');
  let from = 0;
  for (const k of q.haulBreaks) {
    const next = node(H[k]);
    road(prev, next, H.slice(from + 1, k), 'the haul road');
    prev = next;
    from = k;
  }
  graph.reindex();
}

/**
 * The top of the quarry's rock at (x, z) -- a ledge, the haul road, a jump --
 * or null outside the quarry or where there is none. For what lands by asking
 * how high the ground is (the flyable helicopter): the height grid under the
 * rock is the floor.
 */
export function quarryTopAt(world, q, x, z) {
  if (!q || Math.hypot(x - q.x, z - q.z) > q.r + FACE_OUT + 1) return null;
  const hit = raycast(world, { x, y: q.floor + 120, z }, { x: 0, y: -1, z: 0 }, 160, QUARRY_ROCK);
  return hit ? hit.point.y : null;
}
const QUARRY_ROCK = groups(0xFFFF, GROUP.BUILDING | GROUP.RAMP);

/** The quarry floor's colour, or null outside it. */
export function quarryColour(q, x, z, y, c) {
  if (!q) return false;
  const d = Math.hypot(x - q.x, z - q.z);
  if (d > q.r + FACE_OUT + 2) return false;
  if (d <= q.r) {
    c.setHSL(0.09, 0.12, 0.52);
    const n = Math.sin(x * 0.7 + z * 0.3) * Math.cos(z * 0.5 - x * 0.2);
    c.offsetHSL(0, 0, n * 0.03);
    return true;
  }
  // (Rock-coloured ground round the rim, under the face, showed as a pink
  // strip along the top beyond it. The face covers its own ground.)
  return false;
}

// =====================================================================
//  Shortcuts across the fields
// =====================================================================

/**
 * Tracks across the fields between two roads that are a long way apart by
 * road: a gate at each end to smash, the hedges open along it, and a muddy
 * pair of ruts to show the way. Not roads -- no police unit plans along one --
 * so taking one is a choice the police have to make after you.
 */
export function planShortcuts(ctx, fields, q) {
  const { graph } = ctx;
  const rng = ctx.xrng;
  const ok = graph.edges.filter((e) => !e.cut && !e.turningHead && !e.village && !e.farm && e.length > 90);
  const out = [];
  for (let t = 0; t < 8000 && out.length < SHORTCUTS; t++) {
    const e1 = ok[randInt(rng, 0, ok.length - 1)], e2 = ok[randInt(rng, 0, ok.length - 1)];
    if (e1 === e2) continue;
    const s1 = rand(rng, 30, e1.length - 30), s2 = rand(rng, 30, e2.length - 30);
    const a = pointOn(e1, s1), b = pointOn(e2, s2);
    if (!a || !b) continue;
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 100 || L > 380) continue;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    // Leaving each road squarely, through a gate in the hedge.
    if (Math.abs(ux * a.tx + uz * a.tz) > 0.7 || Math.abs(ux * b.tx + uz * b.tz) > 0.7) continue;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    if (out.some((o) => Math.hypot(o.mx - mx, o.mz - mz) < 170)) continue;
    let bad = false;
    let prev = ctx.at(a.x, a.z);
    for (let s = 4; s < L && !bad; s += 4) {
      const x = a.x + ux * s, z = a.z + uz * s;
      const y = ctx.at(x, z);
      if (Math.abs(y - prev) > 4 * 0.4) bad = true;
      prev = y;
      if (s < 10 || s > L - 10) continue;
      const n = roadNear(graph, x, z, 12);
      if (n && n.dist < n.edge.width * 0.5 + 5) bad = true;
      const f = fields.nearest(x, z).s;
      if (f && f.wood) bad = true;
      if (inVillage(ctx, x, z, 30) || ctx.farms.some((fm) => Math.hypot(fm.x - x, fm.z - z) < 55)) bad = true;
      if (ctx.clearAt(x, z, CLEAR.RAIL | CLEAR.QUARRY)) bad = true;
      if (q && Math.hypot(q.x - x, q.z - z) < q.r + 30) bad = true;
    }
    if (bad) continue;
    // Worth it only where the road round is a long way round.
    let route = Infinity;
    for (const [na, da] of [[e1.a, s1], [e1.b, e1.length - s1]]) {
      for (const [nb, db] of [[e2.a, s2], [e2.b, e2.length - s2]]) {
        const r = roadDistance(graph, graph.nodes[na], graph.nodes[nb], L * 6);
        route = Math.min(route, da + r + db);
      }
    }
    if (route < L * SHORTCUT_GAIN) continue;
    out.push({ a, b, e1, e2, L, ux, uz, mx, mz, route });
  }
  for (const o of out) markLine(ctx, [o.a, o.b], 3.5, CLEAR.SHORTCUT);
  return out;
}

/** A five-bar gate in local space: 4.2 m long along x, 1.2 m tall, centred. Or a quarter of one, `part` 0-1, for when it breaks. */
function gateGeometry(part = -1) {
  const b = new MeshBuilder();
  const wood = 0x9a8466;
  const len = part < 0 ? 4.2 : GATE_PART;
  for (let k = 0; k < 5; k++) b.addBox(len, 0.1, 0.07, 0, -0.5 + k * 0.25, 0, wood);
  if (part < 0) {
    for (const x of [-2.05, 0, 2.05]) b.addBox(0.12, 1.2, 0.09, x, 0, 0, wood);
    // The brace.
    const g = new THREE.BoxGeometry(2.3, 0.09, 0.07);
    b.addGeometry(g, new THREE.Matrix4().makeRotationZ(Math.atan2(1.0, 2.0)).setPosition(-1.0, 0, 0), wood);
    g.dispose();
  } else {
    // Each piece keeps an upright, splintered off at one end or the other.
    b.addBox(0.12, 1.2, 0.09, (part ? 1 : -1) * (GATE_PART * 0.5 - 0.06), 0, 0, wood);
  }
  return b.build();
}

/**
 * The shortcuts, on the finished ground: the ruts. Their gates go in with the
 * rest (buildGates), returned as `gateSpots`.
 */
export function buildShortcuts(ctx, list) {
  const b = new MeshBuilder();
  const spots = [];
  const drawn = ctx.drawnAt || ctx.at;
  for (const o of list) {
    const ends = [[o.a, o.e1, 1], [o.b, o.e2, -1]];
    // The track, from hedge to hedge.
    const off0 = o.e1.width * 0.5 + 0.5, off1 = o.L - (o.e2.width * 0.5 + 0.5);
    const pts = [];
    for (let s = off0; s <= off1; s += 3) pts.push({ x: o.a.x + o.ux * s, z: o.a.z + o.uz * s });
    pts.push({ x: o.a.x + o.ux * off1, z: o.a.z + o.uz * off1 });
    b.addRibbon(pts, 3.4, 0, 0x5b4632);
    b.addRibbon(pts, 0.55, 0.01, 0x3e2f21, 0.85);
    b.addRibbon(pts, 0.55, 0.01, 0x3e2f21, -0.85);
    for (const [p, e, dir] of ends) {
      const off = e.width * 0.5 + 1.8;
      spots.push({ x: p.x + o.ux * dir * off, z: p.z + o.uz * dir * off, rot: Math.atan2(o.ux, o.uz) });
    }
  }
  const ruts = new THREE.Mesh(b.build(), vertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  // On the ground as drawn, not the ground the wheels feel: the drawn mesh is
  // coarser, and ruts lifted by the fine grid float over its hollows.
  const p = ruts.geometry.attributes.position;
  for (let k = 0; k < p.count; k++) p.setY(k, p.getY(k) + drawn(p.getX(k), p.getZ(k)) + 0.06);
  p.needsUpdate = true;
  ruts.geometry.computeBoundingSphere();
  ruts.receiveShadow = true;
  ruts.name = 'shortcuts';
  return { meshes: [ruts], gateSpots: spots };
}

/**
 * Field gates, in the gaps in the roadside hedges and at the ends of the
 * shortcuts: two posts, a short run of fence from each post into the hedge,
 * and the gate between them. Each spot is { x, z, rot }, `rot` the heading
 * through the gateway.
 *
 * The posts go over when hit, and take their bit of fence with them (see
 * below). The gate is a loose body like a bale (GROUP.DEBRIS, asleep until
 * hit), and hit hard enough it breaks: "I want the gates to smash into four
 * different sections when you hit them." The gate goes, and four pieces, each
 * a quarter of it, carry on with its speed and a kick of their own. Pieces
 * are pooled, GATE_PIECES at most; past that the oldest go.
 */
export function buildGates(ctx, spots) {
  const W = ctx.sim.world;
  const wood = 0x6e5a42, rail = 0x8a7558;
  // The posts go over too: "the two edge posts, they're solid. Make sure that
  // you knock them over. And then when you knock them over ... the two bits
  // connecting the hedge to the fence posts, you can just make them vanish."
  // Each post a loose body, heavier than the gate (GROUP.DEBRIS, so still
  // nothing the AI steers round), and the bit of fence from it into the hedge
  // -- two rails and a short post -- one piece that goes when its post does.
  const postGeo = new MeshBuilder().addBox(0.22, 1.6, 0.22, 0, 0, 0, wood).build();
  // The fence piece in the post's frame: +x away from the gate, from the post
  // on into the hedge; y from the ground.
  const fenceGeo = new MeshBuilder()
    .addBox(1.2, 0.09, 0.06, 0.6, 0.45, 0, rail)
    .addBox(1.2, 0.09, 0.06, 0.6, 0.95, 0, rail)
    .addBox(0.14, 1.2, 0.14, 1.15, 0.6, 0, wood)
    .build();
  const n = spots.length * 2;
  const postMesh = new THREE.InstancedMesh(postGeo, vertexColorMaterial(), Math.max(1, n));
  const fenceMesh = new THREE.InstancedMesh(fenceGeo, vertexColorMaterial(), Math.max(1, n));
  for (const im of [postMesh, fenceMesh]) { im.count = n; im.castShadow = true; im.frustumCulled = false; }
  postMesh.name = 'gateposts';
  fenceMesh.name = 'gate-fences';
  const posts = [];
  const fm = new THREE.Matrix4(), fq = new THREE.Quaternion(), fp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (const { x, z, rot } of spots) {
    const ax = Math.cos(rot), az = -Math.sin(rot);      // along the hedge
    for (const side of [-1, 1]) {
      const px = x + ax * side * 2.35, pz = z + az * side * 2.35;
      const g = ctx.at(px, pz);
      const body = W.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(px, g + 0.82, pz)
          .setRotation({ x: 0, y: Math.sin(rot / 2), z: 0, w: Math.cos(rot / 2) })
          .setLinearDamping(0.3)
          .setAngularDamping(0.5),
      );
      W.createCollider(
        RAPIER.ColliderDesc.cuboid(0.11, 0.8, 0.11)
          .setMass(POST_MASS)
          .setFriction(0.7)
          .setRestitution(0.1)
          .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.TERRAIN | GROUP.HILL | GROUP.VEHICLE | GROUP.DEBRIS)),
        body,
      );
      body.sleep();
      const k = posts.length;
      fq.setFromAxisAngle(up, rot + (side < 0 ? Math.PI : 0));
      fm.compose(fp.set(px, g, pz), fq, new THREE.Vector3(1, 1, 1));
      fenceMesh.setMatrixAt(k, fm);
      posts.push({ body, home: { x: px, y: g + 0.82, z: pz }, drawn: false, down: false });
    }
  }

  const mat = vertexColorMaterial();
  const mesh = new THREE.InstancedMesh(gateGeometry(), mat, Math.max(1, spots.length));
  mesh.count = spots.length;
  mesh.castShadow = true;
  mesh.name = 'gates';
  mesh.frustumCulled = false;
  // Two shapes of piece, alternating: the upright at its left end, or its right.
  const pieceMesh = [0, 1].map((k) => {
    const pm = new THREE.InstancedMesh(gateGeometry(k), mat, GATE_PIECES / 2);
    pm.count = 0;
    pm.castShadow = true;
    pm.frustumCulled = false;
    pm.name = 'gate-pieces';
    return pm;
  });
  const gates = spots.map(({ x, z, rot }) => {
    const body = W.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        // Clear of the ground along its whole length: on a slope the low end
        // of a gate stood in the hill, was pushed out, and broke on its own.
        .setTranslation(x, Math.max(ctx.at(x, z), ctx.at(x + Math.cos(rot) * 2.1, z - Math.sin(rot) * 2.1), ctx.at(x - Math.cos(rot) * 2.1, z + Math.sin(rot) * 2.1)) + 0.65, z)
        .setRotation({ x: 0, y: Math.sin(rot / 2), z: 0, w: Math.cos(rot / 2) })
        .setLinearDamping(0.3)
        .setAngularDamping(0.6)
        .setCcdEnabled(true),
    );
    W.createCollider(
      RAPIER.ColliderDesc.cuboid(2.1, 0.6, 0.06)
        .setMass(45)
        .setFriction(0.7)
        .setRestitution(0.15)
        .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.TERRAIN | GROUP.HILL | GROUP.VEHICLE | GROUP.DEBRIS)),
      body,
    );
    body.sleep();
    return { body, drawn: false, hit: false };
  });
  const pieces = [];        // { body, which, slot, drawn }
  const slots = [0, 0];
  const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), pv = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const draw = (target, i, body) => {
    const t = body.translation(), r = body.rotation();
    const h = ctx.at(t.x, t.z);
    // The bodies rest on the heightfield, sunk HILL_SINK under the drawn
    // ground; a gate still standing has not been near it.
    pv.set(t.x, t.y + (h < 0 ? HILL_SINK : h - Math.max(0, h - HILL_SINK)) * (body.isSleeping() && t.y > h ? 0 : 1), t.z);
    qq.set(r.x, r.y, r.z, r.w);
    m.compose(pv, qq, one);
    target.setMatrixAt(i, m);
  };
  const smash = (g, i) => {
    const t = g.body.translation(), r = g.body.rotation(), lv = g.body.linvel();
    qq.set(r.x, r.y, r.z, r.w);
    W.removeRigidBody(g.body);
    g.body = null;
    mesh.setMatrixAt(i, zero);
    for (let k = 0; k < 4; k++) {
      pv.set((k - 1.5) * GATE_PART, 0, 0).applyQuaternion(qq);
      const body = W.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(t.x + pv.x, t.y + pv.y, t.z + pv.z)
          .setRotation(r)
          .setLinvel(lv.x + rand(Math.random, -2, 2), lv.y + rand(Math.random, 1, 3), lv.z + rand(Math.random, -2, 2))
          .setAngvel({ x: rand(Math.random, -5, 5), y: rand(Math.random, -5, 5), z: rand(Math.random, -5, 5) })
          .setLinearDamping(0.3)
          .setAngularDamping(0.4),
      );
      W.createCollider(
        RAPIER.ColliderDesc.cuboid(GATE_PART * 0.5, 0.6, 0.05)
          .setMass(11)
          .setFriction(0.7)
          .setRestitution(0.2)
          .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.TERRAIN | GROUP.HILL | GROUP.VEHICLE | GROUP.DEBRIS)),
        body,
      );
      const which = k % 2;
      let slot;
      if (slots[which] < GATE_PIECES / 2) {
        slot = slots[which]++;
        pieceMesh[which].count = slots[which];
      } else {
        // The pool is full: the oldest piece of this shape goes.
        const old = pieces.findIndex((pc) => pc.which === which);
        slot = pieces[old].slot;
        W.removeRigidBody(pieces[old].body);
        pieces.splice(old, 1);
      }
      pieces.push({ body, which, slot, drawn: false });
    }
  };
  const update = () => {
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i];
      if (!g.body) continue;
      // Only what moves needs drawing again.
      if (g.drawn && g.body.isSleeping()) continue;
      const lv = g.body.linvel();
      // Broken by a car, and nothing else: hit hard enough, by something that
      // drives, it goes to pieces.
      if (!g.hit) W.contactPairsWith(g.body.collider(0), (o) => { if (o.__vehicle) g.hit = true; });
      // (Or flying faster than any gate only settling would: a car past in the
      // frame between contact and this look.)
      const v = Math.hypot(lv.x, lv.y, lv.z);
      if ((g.hit && v > GATE_BREAK) || v > 6) { smash(g, i); continue; }
      draw(mesh, i, g.body);
      g.drawn = true;
    }
    for (const pc of pieces) {
      if (pc.drawn && pc.body.isSleeping()) continue;
      draw(pieceMesh[pc.which], pc.slot, pc.body);
      pc.drawn = true;
    }
    // The posts, and the fence that goes with each once it has been moved.
    for (let k = 0; k < posts.length; k++) {
      const pt = posts[k];
      if (pt.drawn && pt.body.isSleeping()) continue;
      draw(postMesh, k, pt.body);
      pt.drawn = true;
      if (!pt.down) {
        const t = pt.body.translation();
        if (Math.hypot(t.x - pt.home.x, t.y - pt.home.y, t.z - pt.home.z) > 0.25) {
          pt.down = true;
          fenceMesh.setMatrixAt(k, zero);
          fenceMesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    postMesh.instanceMatrix.needsUpdate = true;
    for (const pm of pieceMesh) pm.instanceMatrix.needsUpdate = true;
  };
  update();
  return { meshes: [postMesh, fenceMesh, mesh, ...pieceMesh], update, count: spots.length, gates, pieces, posts };
}

// =====================================================================
//  The railway
// =====================================================================

/**
 * The line: right across the map from one edge to the other, a long gentle
 * curve, through the low ground as far as it can, over a few roads at level
 * crossings -- never at a junction, never too slantwise, never running along
 * beside a road -- and well clear of the villages, farms and the quarry.
 */
export function planRailway(ctx, base, q) {
  const rng = ctx.xrng;
  let best = null, found = 0;
  // The best of the first RAIL_CHOICES lines that pass, out of up to 1500:
  // judging every candidate took three seconds of the map's build.
  for (let t = 0; t < 1500 && found < RAIL_CHOICES; t++) {
    const a = rng() * Math.PI, ux = Math.cos(a), uz = Math.sin(a), nx = -uz, nz = ux;
    const off = rand(rng, -520, 520);
    const ctrl = [];
    for (let k = 0; k <= 6; k++) {
      const s = -1800 + (3600 * k) / 6;
      const w = k === 0 || k === 6 ? 0 : rand(rng, -110, 110);
      ctrl.push({ x: ux * s + nx * (off + w), z: uz * s + nz * (off + w) });
    }
    const all = spline(ctrl, 6);
    const inside = (p) => Math.abs(p.x) < RAIL_END && Math.abs(p.z) < RAIL_END;
    const i0 = all.findIndex(inside);
    if (i0 < 0) continue;
    let i1 = i0;
    while (i1 + 1 < all.length && inside(all[i1 + 1])) i1++;
    if (all.slice(i1 + 1).some(inside)) continue;
    const pts = all.slice(Math.max(0, i0 - 1), Math.min(all.length, i1 + 2));
    const r = judgeRail(ctx, base, q, pts);
    if (r) found++;
    if (r && (!best || r.score < best.score)) best = { ...r, points: pts };
  }
  if (!best) return null;
  markLine(ctx, best.points, RAIL_BED * 0.5 + 5, CLEAR.RAIL);
  return best;
}

function judgeRail(ctx, base, q, pts) {
  const { graph } = ctx;
  const sAt = [0];
  for (let i = 1; i < pts.length; i++) sAt.push(sAt[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  let sum = 0, n = 0;
  const near = new Map();       // edge id -> rail point indices near it
  const close = [];
  // The cheap refusals for the whole line before the dear road lookups.
  for (const p of pts) {
    if (Math.abs(p.x) > WORLD_HALF || Math.abs(p.z) > WORLD_HALF) continue;
    if (ctx.villages.some((v) => Math.hypot(v.x - p.x, v.z - p.z) < v.r + 45)) return null;
    if (ctx.farms.some((f) => Math.hypot(f.x - p.x, f.z - p.z) < 75)) return null;
    if (q && Math.hypot(q.x - p.x, q.z - p.z) < q.r + 60) return null;
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (Math.abs(p.x) > WORLD_HALF || Math.abs(p.z) > WORLD_HALF) continue;
    sum += base(p.x, p.z); n++;
    const r = roadNear(graph, p.x, p.z, 22);
    if (!r) continue;
    if (!near.has(r.edge.id)) near.set(r.edge.id, []);
    near.get(r.edge.id).push(i);
    if (r.dist < r.edge.width * 0.5 + 10) close.push({ i, edge: r.edge.id });
  }
  const cross = [];
  for (const [id, idxs] of near) {
    const e = graph.edges[id];
    const i0 = Math.max(0, Math.min(...idxs) - 2), i1 = Math.min(pts.length - 2, Math.max(...idxs) + 2);
    for (let i = i0; i <= i1; i++) {
      const p = pts[i], pq = pts[i + 1];
      for (const sg of e.segs) {
        if (!segX(p, pq, sg.a, sg.b)) continue;
        // Where, along both.
        const rx = pq.x - p.x, rz = pq.z - p.z, sx = sg.b.x - sg.a.x, sz = sg.b.z - sg.a.z;
        const den = rx * sz - rz * sx;
        const tt = ((sg.a.x - p.x) * sz - (sg.a.z - p.z) * sx) / den;
        const uu = ((sg.a.x - p.x) * rz - (sg.a.z - p.z) * rx) / den;
        const x = p.x + rx * tt, z = p.z + rz * tt;
        if (e.village || e.farm || e.turningHead) return null;
        const rl = Math.hypot(rx, rz), sl = Math.hypot(sx, sz);
        const cos = (rx * sx + rz * sz) / (rl * sl);
        if (Math.abs(cos) > 0.77) return null;
        const na = graph.nodes[e.a], nb = graph.nodes[e.b];
        if (Math.hypot(na.x - x, na.z - z) < 40 || Math.hypot(nb.x - x, nb.z - z) < 40) return null;
        cross.push({
          s: sAt[i] + rl * tt, edge: e.id, along: sg.start + uu * sg.len, x, z,
          rdx: sx / sl, rdz: sz / sl, qx: rx / rl, qz: rz / rl, width: e.width, sin: Math.sqrt(1 - cos * cos),
        });
      }
    }
  }
  // Near a road only where it crosses it.
  for (const c of close) {
    if (!cross.some((x) => x.edge === c.edge && Math.abs(x.s - sAt[c.i]) < 30)) return null;
  }
  if (cross.length < 2 || cross.length > 8 || !n) return null;
  cross.sort((a, b) => a.s - b.s);
  for (let k = 1; k < cross.length; k++) if (cross[k].s - cross[k - 1].s < 60) return null;
  return { score: sum / n + Math.abs(cross.length - 5) * 6, cross, sAt };
}

/** What the height grid needs: the line, its bed and its crossings. */
export function railGround(rail) {
  return { points: rail.points, width: RAIL_BED, grade: RAIL_GRADE, cross: rail.cross };
}

/** The track, drawn: ballast, sleepers and rails, and at the crossings the rails let into the road. */
export function buildRailTrack(ctx, rail) {
  const b = new MeshBuilder();
  const cross = rail.cross;
  // Every 3 m along the line, with its distance from the start.
  const L = rail.sAt[rail.sAt.length - 1];
  const at = (s) => railPoint(rail, s);
  const zone = (s) => cross.find((c) => Math.abs(s - c.s) < (c.width * 0.5) / c.sin + 1.5);
  const verge = new THREE.Color().setHSL(0.25, 0.38, 0.27);
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      // The bed, ballast in the middle and verge either side, over the ground
      // drawn under the line, which is let down below it (see nearRoad in
      // countrygen.js) like a road's. In two-metre strips, each lifted onto
      // the ground where it lies: one sheet sixteen metres wide is flat
      // between its edges, and on a slope it cut into the ground on one side
      // and stood over it on the other -- "lots of different levels and I
      // keep on going through the floor".
      for (let o = -BED_HALF + 1; o < BED_HALF; o += 2) {
        b.addRibbon(run, 2.02, 0, Math.abs(o) < 2.5 ? 0x6f685e : verge, o);
      }
      // Rails and sleepers barely proud of it, where the wheels are: the
      // ballast stood 0.3 m up on walls, a step the cars drove through.
      for (const side of [-1, 1]) {
        b.addRibbon(run, 0.09, RAIL_TOP, 0xa4a6a8, side * GAUGE * 0.5);
        b.addWall(run, 0.02, RAIL_TOP, 0x5c5450, side * GAUGE * 0.5 + 0.045);
      }
    }
    run = [];
  };
  for (let s = 0; s <= L; s += 3) {
    const p = at(s);
    const c = zone(s);
    if (c) {
      flush();
      continue;
    }
    run.push(p);
    // A concrete sleeper every metre and a half.
    for (let k = 0; k < 2; k++) {
      const q = at(s + k * 1.5);
      if (zone(s + k * 1.5)) continue;
      b.addBox(2.5, 0.08, 0.26, q.x, 0.04, q.z, 0x8d8a84, Math.atan2(q.dx, q.dz));
    }
  }
  flush();
  // The crossings: the rails flush with the road, in a rubber panel.
  for (const c of cross) {
    const half = (c.width * 0.5) / c.sin + 1.5;
    const pts = [];
    for (let s = c.s - half; s <= c.s + half + 0.01; s += 1) pts.push(at(s));
    b.addRibbon(pts, 3.0, 0.08, 0x2b2b2b);
    for (const side of [-1, 1]) b.addRibbon(pts, 0.09, 0.1, 0xa4a6a8, side * GAUGE * 0.5);
  }
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
  const p = mesh.geometry.attributes.position;
  for (let k = 0; k < p.count; k++) p.setY(k, p.getY(k) + ctx.at(p.getX(k), p.getZ(k)) + 0.04);
  p.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
  mesh.receiveShadow = true;
  mesh.name = 'railway';
  return mesh;
}

/** A point `s` along the line with its heading -- carried on straight past either end. */
function railPoint(rail, s) {
  const P = rail.points, S = rail.sAt;
  let i;
  if (s <= 0) i = 0;
  else if (s >= S[S.length - 1]) i = P.length - 2;
  else {
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
    i = lo;
  }
  const a = P[i], b = P[i + 1];
  const len = S[i + 1] - S[i] || 1;
  const t = (s - S[i]) / len;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len };
}

/** One carriage, in local space: centred, nose (if any) toward +z, 2.8 x 3.7 x CAR_LEN. */
function carriageGeometry(cab) {
  const b = new MeshBuilder();
  const white = 0xe9ecef, band = 0x1d2733, stripe = 0x1f5aa6, roof = 0xb9bfc5, under = 0x2a2c2f, yellow = 0xf2c200;
  const L = CAR_LEN, nose = cab ? 4.2 : 0;
  const bodyL = L - nose, zc = -nose * 0.5;
  b.addBox(2.8, 3.0, bodyL, 0, 0.35, zc, white);
  b.addBox(2.84, 0.72, bodyL - 1.2, 0, 0.85, zc, band);
  b.addBox(2.84, 0.3, bodyL, 0, -0.55, zc, stripe);
  b.addTaperedBox(2.8, 0.3, bodyL, 0, 2.0, zc, roof, 0.8, 1);
  // Doors: a darker panel each end of each side.
  for (const dz of [-bodyL * 0.5 + 2.2, bodyL * 0.5 - 2.2]) b.addBox(2.86, 2.1, 1.3, 0, 0.05, zc + dz, 0xc9ced3);
  // Underframe and bogies.
  b.addBox(2.4, 0.5, L - 3, 0, -1.4, 0, under);
  for (const bz of [-L * 0.5 + 4, L * 0.5 - 4]) b.addBox(2.5, 0.75, 3.2, 0, -1.5, bz, 0x1a1a1a);
  if (cab) {
    // The nose: raked back over the cab, yellow below, a wide dark screen.
    const nz = L * 0.5 - nose * 0.5;
    b.addTaperedBox(2.8, 3.0, nose, 0, 0.35, nz, white, 0.92, 0.3, 0, -1.3);
    b.addTaperedBox(2.82, 1.5, nose, 0, -0.45, nz, yellow, 1, 0.8, 0, -0.3);
    b.addTaperedBox(2.5, 1.0, nose * 0.6, 0, 1.15, nz - 0.6, 0x10161d, 0.9, 0.4, 0, -0.5);
    for (const x of [-0.9, 0.9]) b.addBox(0.4, 0.18, 0.1, x, -0.65, L * 0.5 - 0.02, 0xfff8e0);
  }
  return b.build();
}

/**
 * The train and the crossings, run every physics step.
 *
 * A train of CARS carriages, each a kinematic box (GROUP.BUILDING: the AI's
 * sweeps see it as a wall, so a police car brakes for it, and anything in its
 * way is shoved aside), runs the line one way, waits off the end of the map,
 * and comes back. Its timetable is a clock that starts from the wall clock, so
 * every machine in a game sees the same train without being told.
 *
 * At each crossing the lights flash LIGHTS_AT seconds before the train is
 * there and the barriers are down for the last DOWN_AT. The barriers are only
 * drawn -- a car can go straight through them -- but everything the AI drives
 * stops for the lights like a red signal (stopDistanceAt).
 */
export class Railway {
  constructor(ctx, rail, scene) {
    this.rail = rail;
    this.world = ctx.sim.world;
    this.len = rail.sAt[rail.sAt.length - 1];
    this.trainLen = CARS * (CAR_LEN + CAR_GAP);
    this.runTime = (this.len + this.trainLen + 120) / TRAIN_SPEED;
    this.period = 2 * (this.runTime + TRAIN_WAIT);
    this.clock = (Date.now() / 1000) % this.period;
    this.at = ctx.at;
    this.scene = scene;
    this.bits = [];          // pieces of broken barrier arms: { body, mesh, until }
    this.cars = [];
    const mat = vertexColorMaterial();
    const cabGeo = carriageGeometry(true), midGeo = carriageGeometry(false);
    for (let i = 0; i < CARS; i++) {
      const cab = i === 0 || i === CARS - 1;
      const mesh = new THREE.Mesh(cab ? cabGeo : midGeo, mat);
      mesh.castShadow = true;
      mesh.name = 'train';
      mesh.visible = false;
      scene.add(mesh);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -60, 0));
      // A cab's box stops short of its nose, which is a wedge: a car on the
      // line is thrown off to one side. Square-fronted, the train picked a
      // car up off a crossing and carried it along the line at 120 km/h.
      const nose = cab ? 3 : 0;
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(1.4, 1.85, (CAR_LEN - nose) * 0.5).setTranslation(0, 0, -nose * 0.5)
          .setFriction(0.1).setCollisionGroups(groups(GROUP.BUILDING, 0xFFFF)),
        body,
      );
      if (cab) {
        const z0 = CAR_LEN * 0.5 - nose, z1 = CAR_LEN * 0.5 + 0.6;
        const pts = new Float32Array([
          -1.4, -1.85, z0, 1.4, -1.85, z0, -1.4, 1.85, z0, 1.4, 1.85, z0,
          0, -1.85, z1, 0, 1.0, z1,
        ]);
        this.world.createCollider(
          RAPIER.ColliderDesc.convexHull(pts).setFriction(0.05).setCollisionGroups(groups(GROUP.BUILDING, 0xFFFF)),
          body,
        );
      }
      // The last car runs backwards, so its cab faces the other way.
      this.cars.push({ mesh, body, flip: i === CARS - 1, away: true });
    }
    this.crossings = rail.cross.map((c) => this._buildCrossing(c, scene));
    this.meshes = [];
  }

  /**
   * At night the carriages are lit inside: a band of warm light along the
   * windows of each, lit whatever the light round it ("the train has lit
   * carriages"), and the front cab's lamps.
   */
  setNight(on) {
    if (!on || this._lit) return;
    this._lit = true;
    const warm = new THREE.MeshBasicMaterial({ color: 0xffe2a8, fog: true });
    const lamp = new THREE.MeshBasicMaterial({ color: 0xfff6dc, fog: true });
    this.cars.forEach((car, i) => {
      const cab = i === 0 || i === CARS - 1, nose = cab ? 4.2 : 0;
      const bodyL = CAR_LEN - nose;
      const band = new THREE.Mesh(new THREE.BoxGeometry(2.86, 0.6, bodyL - 1.6), warm);
      band.position.set(0, 0.85, -nose * 0.5);
      car.mesh.add(band);
      if (cab) {
        for (const x of [-0.9, 0.9]) {
          const l = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.1), lamp);
          l.position.set(x, -0.65, CAR_LEN * 0.5 + 0.02);
          car.mesh.add(l);
        }
      }
    });
  }

  /** Where the line is `s` along it: { x, y, z }. For the police following it (Officer._railFollow). */
  pointAt(s) {
    return this._pose(clamp(s, 0, this.len));
  }

  /**
   * The nearest point of the line to (x, z): { s, d }. Searched near `hint`
   * (an earlier answer) when given, which is all a car following it needs.
   */
  nearestOnLine(x, z, hint = null) {
    if (!this._line) {
      this._line = [];
      for (let s = 0; s <= this.len; s += 4) { const p = railPoint(this.rail, s); this._line.push({ s, x: p.x, z: p.z }); }
    }
    const L = this._line;
    let lo = 0, hi = L.length - 1;
    if (hint !== null) { const k = Math.round(hint / 4); lo = Math.max(0, k - 12); hi = Math.min(L.length - 1, k + 12); }
    let best = lo, bd = Infinity;
    for (let i = lo; i <= hi; i++) {
      const d = (L[i].x - x) ** 2 + (L[i].z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    // Between the sample and its better neighbour.
    const a = L[best], nb = L[best + 1] && (!L[best - 1] || (L[best + 1].x - x) ** 2 + (L[best + 1].z - z) ** 2 < (L[best - 1].x - x) ** 2 + (L[best - 1].z - z) ** 2) ? L[best + 1] : L[best - 1] || a;
    const ex = nb.x - a.x, ez = nb.z - a.z, el = ex * ex + ez * ez || 1;
    const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / el, 0, 1);
    const px = a.x + ex * t, pz = a.z + ez * t;
    return { s: a.s + (nb.s - a.s) * t, d: Math.hypot(x - px, z - pz) };
  }

  /** The front of the train at time t: { s, dir }, or null while it waits off the map. */
  frontAt(t) {
    const P = this.period, p = ((t % P) + P) % P, half = this.runTime + TRAIN_WAIT;
    const dir = p < half ? 1 : -1;
    const q = p < half ? p : p - half;
    if (q > this.runTime) return null;
    const d = q * TRAIN_SPEED - 60;
    return dir > 0 ? { s: d, dir } : { s: this.len - d, dir };
  }

  /** Is any of the train within `pad` of `s` at time t? */
  _occupies(t, s, pad) {
    const f = this.frontAt(t);
    if (!f) return false;
    const tail = f.s - f.dir * this.trainLen;
    const lo = Math.min(f.s, tail) - pad, hi = Math.max(f.s, tail) + pad;
    return s >= lo && s <= hi;
  }

  _pose(s) {
    const p = railPoint(this.rail, s);
    const y = (Math.abs(p.x) <= WORLD_HALF && Math.abs(p.z) <= WORLD_HALF ? this.at(p.x, p.z) : 0) + 0.04 + RAIL_TOP;
    return { x: p.x, z: p.z, y };
  }

  step(dt) {
    this.clock += dt;
    const f = this.frontAt(this.clock);
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (!f) {
        if (!car.away) { car.body.setTranslation({ x: 0, y: -60, z: 0 }, false); car.away = true; }
        continue;
      }
      const sc = f.s - f.dir * (i * (CAR_LEN + CAR_GAP) + CAR_LEN * 0.5);
      const a = this._pose(sc + f.dir * 8), b = this._pose(sc - f.dir * 8);
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const yaw = Math.atan2(dx, dz) + (car.flip ? Math.PI : 0);
      const pitch = Math.atan2(dy, Math.hypot(dx, dz)) * (car.flip ? -1 : 1);
      _e.set(-pitch, yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      const pos = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 + 1.88, z: (a.z + b.z) * 0.5 };
      const rot = { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
      if (car.away) {
        car.body.setTranslation(pos, true);
        car.body.setRotation(rot, true);
        car.away = false;
      } else {
        car.body.setNextKinematicTranslation(pos);
        car.body.setNextKinematicRotation(rot);
      }
    }
  }

  /** Drawn: the train where its bodies are, and the crossings. */
  update(game) {
    for (const car of this.cars) {
      car.mesh.visible = !car.away;
      if (car.away) continue;
      const t = car.body.translation(), r = car.body.rotation();
      car.mesh.position.set(t.x, t.y, t.z);
      car.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
    const flash = Math.floor(this.clock * 3) % 2;
    for (const c of this.crossings) {
      let lit = false, down = false;
      for (let k = 0; k <= LIGHTS_AT && !lit; k += 0.5) {
        if (this._occupies(this.clock + k, c.s, 8)) { lit = true; down = k <= DOWN_AT; }
      }
      c.lit = lit;
      c.down = down;
      // Arms swing over three seconds, up or down.
      const target = down ? 0 : Math.PI * 0.5;
      const dt = Math.max(0, this.clock - (c.last || this.clock));
      c.last = this.clock;
      const stepA = dt * (Math.PI * 0.5) / 3;
      c.arm = c.arm === undefined ? target : c.arm + clamp(target - c.arm, -stepA, stepA);
      for (const side of c.sides) {
        side.pivot.rotation.z = c.arm;
        side.lampA.visible = lit && flash === 0;
        side.lampB.visible = lit && flash === 1;
        // A new arm once the crossing is clear and nobody is watching it go up.
        if (side.broken && !lit && this.clock - side.broken > BARRIER_BACK) {
          side.broken = 0;
          side.pivot.visible = true;
        }
        if (!side.broken && c.arm < 0.6 && game) this._hitArm(c, side, game);
      }
    }
    this._drawBits();
  }

  /**
   * Barrier arms break. "Make the level crossing barriers clippable and make
   * them break into multiple pieces when you hit them." An arm was only drawn,
   * and cars went through it; now a car that meets one lowered, at more than a
   * walk, snaps it into BARRIER_BITS pieces that fly on with the car's speed,
   * like the gates. Nothing stops the car -- an arm is a strip of aluminium --
   * and a new one is up BARRIER_BACK seconds after the crossing clears.
   */
  _hitArm(c, side, game) {
    const g = side.group, ry = g.rotation.y;
    const ax = Math.cos(ry), az = -Math.sin(ry);   // local +x, across the road
    const len = c.width * 0.5 + 0.4;
    const x0 = g.position.x + ax * 0.2, z0 = g.position.z + az * 0.2;
    const y = g.position.y + 1.05;
    for (const v of game.vehicles) {
      if (v.removed || v.dormant || v.isAircraft) continue;
      const dx = v.position.x - x0, dz = v.position.z - z0;
      if (dx * dx + dz * dz > (len + 4) * (len + 4)) continue;
      if (Math.abs(v.position.y + 0.6 - y) > 1.6 || v.speed < 1.5) continue;
      const u = clamp(dx * ax + dz * az, 0, len);
      const ox = dx - ax * u, oz = dz - az * u;
      // About the car's half width, plus however far it went in one frame.
      if (Math.hypot(ox, oz) > 1.1 + v.speed * 0.03) continue;
      this._breakArm(c, side, v, { ax, az, x0, z0, y, len });
      return;
    }
  }

  _breakArm(c, side, v, { ax, az, x0, z0, y, len }) {
    side.broken = this.clock || 1e-6;
    side.pivot.visible = false;
    const part = len / BARRIER_BITS;
    if (!this._bitGeo || this._bitLen !== part) {
      this._bitLen = part;
      this._bitGeo = new MeshBuilder().addBox(part, 0.14, 0.1, 0, 0, 0, 0xf4f4f4)
        .addBox(Math.min(0.5, part * 0.45), 0.15, 0.11, 0, 0, 0, 0xc8202a).build();
    }
    const lv = v.linvel;
    for (let k = 0; k < BARRIER_BITS; k++) {
      const s = (k + 0.5) * part + 0.2;
      const half = Math.sin(-Math.atan2(az, ax) / 2), full = Math.cos(-Math.atan2(az, ax) / 2);
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x0 + ax * (s - 0.2), y, z0 + az * (s - 0.2))
          .setRotation({ x: 0, y: half, z: 0, w: full })
          .setLinvel(lv.x * rand(Math.random, 0.6, 0.95) + rand(Math.random, -2, 2), rand(Math.random, 1.5, 4),
            lv.z * rand(Math.random, 0.6, 0.95) + rand(Math.random, -2, 2))
          .setAngvel({ x: rand(Math.random, -8, 8), y: rand(Math.random, -8, 8), z: rand(Math.random, -8, 8) })
          .setLinearDamping(0.4)
          .setAngularDamping(0.4),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(part * 0.5, 0.07, 0.05)
          .setMass(2)
          .setFriction(0.7)
          .setRestitution(0.25)
          // Two kilos: a car kicks one along, it does not feel it.
          .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.TERRAIN | GROUP.HILL | GROUP.STREET | GROUP.VEHICLE | GROUP.DEBRIS)),
        body,
      );
      const mesh = new THREE.Mesh(this._bitGeo, this._crossMat);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.bits.push({ body, mesh, until: this.clock + BARRIER_BITS_LAST });
    }
  }

  _drawBits() {
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const b = this.bits[i];
      if (this.clock > b.until || this.clock < b.until - BARRIER_BITS_LAST - 1) {
        this.world.removeRigidBody(b.body);
        this.scene.remove(b.mesh);
        this.bits.splice(i, 1);
        continue;
      }
      if (b.body.isSleeping()) continue;
      const t = b.body.translation(), r = b.body.rotation();
      // Resting on the heightfield, sunk HILL_SINK under the drawn ground.
      const h = this.at(t.x, t.z);
      b.mesh.position.set(t.x, t.y + (h < 0 ? HILL_SINK : h - Math.max(0, h - HILL_SINK)), t.z);
      b.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  _buildCrossing(c, scene) {
    const at = this.at;
    const halfRail = 3 / Math.max(0.4, c.sin);
    const out = { s: c.s, x: c.x, z: c.z, rdx: c.rdx, rdz: c.rdz, width: c.width, halfRail, sides: [] };
    // Four meshes a barrier -- the post and its board, the arm, two lamps --
    // each built in one piece: drawn part by part, the six crossings were a
    // hundred draw calls.
    const mat = this._crossMat || (this._crossMat = vertexColorMaterial());
    const lampOn = this._lampMat || (this._lampMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    const lampGeo = this._lampGeo || (this._lampGeo = new THREE.SphereGeometry(0.13, 10, 8));
    const postGeo = this._postGeo || (this._postGeo = new MeshBuilder()
      .addBox(0.25, 2.6, 0.25, 0, 1.3, 0, 0xdddddd)
      .addBox(1.1, 0.5, 0.06, 0, 2.25, -0.16, 0x111111)
      .build());
    for (const sg of [1, -1]) {
      // Traffic coming at the line from this side travels -sg along the road,
      // and the barrier stands on its left, across its own half of the road.
      const hx = -sg * c.rdx, hz = -sg * c.rdz;
      const lx = -hz, lz = hx;
      const bx = c.x + sg * c.rdx * (halfRail + 2.5) + lx * (c.width * 0.5 + 0.8);
      const bz = c.z + sg * c.rdz * (halfRail + 2.5) + lz * (c.width * 0.5 + 0.8);
      const g = new THREE.Group();
      g.position.set(bx, at(bx, bz), bz);
      // Local +x across the road toward its middle, local +z along the travel.
      g.rotation.y = Math.atan2(lz, -lx);
      // The board faces the traffic coming, which is behind: local -z.
      g.add(new THREE.Mesh(postGeo, mat));
      const armLen = c.width * 0.5 + 0.4;
      const ab = new MeshBuilder().addBox(armLen, 0.14, 0.1, armLen * 0.5 + 0.2, 0, 0, 0xf4f4f4);
      for (let k = 0; k < 3; k++) ab.addBox(0.5, 0.15, 0.11, 0.8 + k * (armLen / 3), 0, 0, 0xc8202a);
      const pivot = new THREE.Mesh(ab.build(), mat);
      pivot.position.y = 1.05;
      g.add(pivot);
      const lampA = new THREE.Mesh(lampGeo, lampOn);
      const lampB = new THREE.Mesh(lampGeo, lampOn);
      lampA.position.set(-0.32, 2.25, -0.22);
      lampB.position.set(0.32, 2.25, -0.22);
      lampA.visible = lampB.visible = false;
      g.add(lampA, lampB);
      scene.add(g);
      out.sides.push({ group: g, pivot, lampA, lampB, hx, hz });
    }
    return out;
  }

  /**
   * How far a car at (x, z) heading (dx, dz) must stop short of a crossing
   * whose lights are flashing, or Infinity. Matched to the road by heading:
   * the car is going along the road, toward the line, and not already on it.
   */
  stopDistanceAt(x, z, dx, dz, speed) {
    let best = Infinity;
    for (const c of this.crossings) {
      if (!c.lit) continue;
      const vx = c.x - x, vz = c.z - z;
      const along = vx * dx + vz * dz;
      if (along < 0 || along > 160) continue;
      if (Math.abs(vx * dz - vz * dx) > 10) continue;
      if (Math.abs(dx * c.rdx + dz * c.rdz) < 0.6) continue;
      const d = along - c.halfRail - 3.5;
      if (d < -1) continue;                                     // on it already: clear it
      if (!c.down && d < speed * speed / 9) continue;           // too late to stop kindly: go
      best = Math.min(best, Math.max(0, d));
    }
    return best;
  }
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
