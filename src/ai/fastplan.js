// The long-range planner: a line across open country at speed.
//
// ai/localplan.js is for a car in a tight spot and hands over at 50 km/h. Above
// that a unit off the road aimed straight at its target with nothing but reflexes
// between it and the trees, and the tree log said what that comes to: the hard
// hits were at 100-190 km/h with the trunk first seen 14-18 m off, under half a
// second, which no margin answers. "Is there any way you can just make the police
// better? ... And going fast."
//
// So the question is asked much further out. A grid over the ground between the
// car and where it is going, FP_CELL metres a cell, with every tree and building
// on it (the local planner's own list), searched with the car's heading as part of
// the state so a line it cannot turn onto at this speed costs what it should; the
// corners pulled tight and rounded. The Driver follows that like a road, and its
// planSpeed then brakes for the bends in it ahead of time, as it does for a road's.
//
// One plan every few frames across the whole force (Officer._fastLine).
import { boxesNear, obstacleIndex } from './localplan.js';

const FP_CELL = 4;
const FP_HALF = 124;
const FP_N = Math.round((FP_HALF * 2) / FP_CELL);
/** Clearance from a trunk or wall for the car's middle: half its width and some room. Nearer than FP_SOFT costs extra. */
const FP_MARGIN = 3;
const FP_SOFT = 7;
const FP_SOFT_COST = 5;
/** How far ahead it plans, m. */
const FP_LOOK = 170;
/** What a change of heading costs, in metres, per 45 degrees: at rest, and more per m/s. */
const FP_TURN = 3;
const FP_TURN_SPEED = 0.35;
const FP_EXPAND = 1500;
/** How much the search prefers heading for the goal over the very shortest way: a good line now, not the best one in 5 ms. */
const FP_GREED = 1.6;
/** The most of a straight either side of a corner its curve takes, m. */
const FP_ROUND = 22;
/** How far from anything solid the middle of a line must stay, m, and the buckets that is looked up in. */
const FP_CLEAR = 2.6;
const FP_BUCKET = 8;
/** Where the car will be before it can do anything about a new line: this many seconds on, between these distances, m. */
const FP_STUB_T = 0.35;
const FP_STUB_MIN = 3;
const FP_STUB_MAX = 16;

const DIRS = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
const STEP = DIRS.map(([a, b]) => Math.hypot(a, b) * FP_CELL);

const _hard = new Uint8Array(FP_N * FP_N);
const _soft = new Uint8Array(FP_N * FP_N);
let _extra = null;
let _index = null;
const _best = new Float32Array(FP_N * FP_N * 8);
const _from = new Int32Array(FP_N * FP_N * 8);
const _seen = new Int32Array(FP_N * FP_N * 8);
const _heap = new Int32Array(FP_EXPAND * 8 + 16);
const _heapF = new Float32Array(FP_EXPAND * 8 + 16);
let _stamp = 0;

function drawBox(b, ox, oz) {
  const r = b.rad + FP_SOFT;
  const x0 = Math.max(0, Math.floor((b.x - r - ox) / FP_CELL));
  const x1 = Math.min(FP_N - 1, Math.floor((b.x + r - ox) / FP_CELL));
  const z0 = Math.max(0, Math.floor((b.z - r - oz) / FP_CELL));
  const z1 = Math.min(FP_N - 1, Math.floor((b.z + r - oz) / FP_CELL));
  for (let i = x0; i <= x1; i++) {
    for (let j = z0; j <= z1; j++) {
      const dx = ox + (i + 0.5) * FP_CELL - b.x, dz = oz + (j + 0.5) * FP_CELL - b.z;
      // Into the box's frame, and how far outside it.
      const lx = Math.abs(dx * b.c - dz * b.s) - b.hx, lz = Math.abs(dx * b.s + dz * b.c) - b.hz;
      const out = Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
      const k = i * FP_N + j;
      if (out < FP_MARGIN) _hard[k] = 1;
      if (out < FP_SOFT) _soft[k] = 1;
    }
  }
}

/**
 * The grid's cells are 4 m, so "clear of the hard grid" is the middle of a cell 3 m off, and a
 * line crossing the cell can pass the trunk at 0.2 m. A line is checked against the boxes
 * themselves, every metre. Every box in each bucket its clearance reaches, built once a world:
 * drawing them on a 1 m grid each plan took 7 ms against 1.3.
 */
function clearIndex(game) {
  const all = obstacleIndex(game);
  if (all.clear) return all.clear;
  const out = new Map(), seen = new Set();
  for (const list of all.buckets.values()) {
    for (const b of list) {
      if (seen.has(b)) continue;
      seen.add(b);
      const r = b.rad + FP_CLEAR;
      for (let i = Math.floor((b.x - r) / FP_BUCKET); i <= Math.floor((b.x + r) / FP_BUCKET); i++) {
        for (let j = Math.floor((b.z - r) / FP_BUCKET); j <= Math.floor((b.z + r) / FP_BUCKET); j++) {
          const k = i * 100003 + j;
          const l = out.get(k);
          if (l) l.push(b); else out.set(k, [b]);
        }
      }
    }
  }
  all.clear = out;
  return out;
}

function boxClear(b, x, z) {
  const dx = x - b.x, dz = z - b.z;
  const lx = Math.abs(dx * b.c - dz * b.s) - b.hx, lz = Math.abs(dx * b.s + dz * b.c) - b.hz;
  if (lx >= FP_CLEAR || lz >= FP_CLEAR) return true;
  const ax = lx > 0 ? lx : 0, az = lz > 0 ? lz : 0;
  return ax * ax + az * az >= FP_CLEAR * FP_CLEAR;
}

/** Is this point far enough from anything solid? */
function fineClear(x, z) {
  const list = _index.get(Math.floor(x / FP_BUCKET) * 100003 + Math.floor(z / FP_BUCKET));
  if (list) for (let i = 0; i < list.length; i++) if (!boxClear(list[i], x, z)) return false;
  if (_extra) for (let i = 0; i < _extra.length; i++) if (!boxClear(_extra[i], x, z)) return false;
  return true;
}

/** Every metre of the line between two points clear of what is solid? */
function lineClear(ax, az, bx, bz) {
  const d = Math.hypot(bx - ax, bz - az);
  const m = Math.ceil(d);
  for (let t = 1; t <= m; t++) {
    if (!fineClear(ax + ((bx - ax) * t) / m, az + ((bz - az) * t) / m)) return false;
  }
  return true;
}

/** The rounding of corner q, checked point by point. */
function curveClear(q, ix, iz, jx, jz, dIn, dOut) {
  const ax = q.x - ix * dIn, az = q.z - iz * dIn, bx = q.x + jx * dOut, bz = q.z + jz * dOut;
  for (let t = 0.1; t < 1; t += 0.1) {
    const u = 1 - t;
    if (!fineClear(u * u * ax + 2 * u * t * q.x + t * t * bx, u * u * az + 2 * u * t * q.z + t * t * bz)) return false;
  }
  return true;
}

function heapPush(n, item, f) {
  let i = n;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (_heapF[p] <= f) break;
    _heap[i] = _heap[p]; _heapF[i] = _heapF[p];
    i = p;
  }
  _heap[i] = item; _heapF[i] = f;
}

function heapPop(n) {
  const item = _heap[0];
  const last = n - 1;
  const f = _heapF[last], it = _heap[last];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= last) break;
    if (c + 1 < last && _heapF[c + 1] < _heapF[c]) c++;
    if (_heapF[c] >= f) break;
    _heap[i] = _heap[c]; _heapF[i] = _heapF[c];
    i = c;
  }
  _heap[i] = it; _heapF[i] = f;
  return item;
}

/**
 * A line from the car to the goal, or `{ clear: true }` if the straight one is
 * free, or null if there is none. `from` is the car: position, forward, speed.
 * `extra` is more boxes, for what the static list does not hold.
 */
export function planFast(game, from, goal, extra = null) {
  const fx = from.position.x, fz = from.position.z;
  let gx = goal.x, gz = goal.z;
  const dist = Math.hypot(gx - fx, gz - fz);
  if (dist > FP_LOOK) { gx = fx + ((gx - fx) * FP_LOOK) / dist; gz = fz + ((gz - fz) * FP_LOOK) / dist; }
  const cx = (fx + gx) * 0.5, cz = (fz + gz) * 0.5;
  const ox = cx - FP_HALF, oz = cz - FP_HALF;
  _hard.fill(0);
  _soft.fill(0);
  _index = clearIndex(game);
  _extra = extra;
  for (const b of boxesNear(game, cx, cz, FP_HALF * 1.3)) drawBox(b, ox, oz);
  if (extra) for (const b of extra) drawBox(b, ox, oz);
  if (lineClear(fx, fz, gx, gz)) return { clear: true };

  // The line starts where the car will be by the time it can turn, the way it is
  // already going: from where it is now, the first bend of every new line is one it
  // has no room for and planSpeed has no way to see.
  let sx = fx, sz = fz;
  const vel = from.linvel, vs = vel ? Math.hypot(vel.x, vel.z) : 0;
  if (vs > 3) {
    const stub = Math.min(FP_STUB_MAX, Math.max(FP_STUB_MIN, vs * FP_STUB_T));
    const ex = fx + (vel.x / vs) * stub, ez = fz + (vel.z / vs) * stub;
    if (lineClear(fx, fz, ex, ez)) { sx = ex; sz = ez; }
  }
  const si = Math.floor((sx - ox) / FP_CELL), sj = Math.floor((sz - oz) / FP_CELL);
  const gi = Math.floor((gx - ox) / FP_CELL), gj = Math.floor((gz - oz) / FP_CELL);
  if (si < 0 || sj < 0 || si >= FP_N || sj >= FP_N) return null;
  const heading = Math.atan2(from.forward.x, from.forward.z);
  const d0 = ((Math.round(heading / (Math.PI / 4)) % 8) + 8) % 8;
  const turn = FP_TURN + from.speed * FP_TURN_SPEED;

  _stamp++;
  const h = (i, j) => {
    const a = Math.abs(i - gi), b = Math.abs(j - gj);
    return (Math.max(a, b) + 0.4142 * Math.min(a, b)) * FP_CELL;
  };
  const start = (si * FP_N + sj) * 8 + d0;
  _seen[start] = _stamp; _best[start] = 0; _from[start] = -1;
  let n = 0;
  heapPush(n++, start, h(si, sj) * FP_GREED);
  let end = -1, nearest = start, nearestH = h(si, sj), expanded = 0;
  while (n > 0 && expanded < FP_EXPAND) {
    const s = heapPop(n); n--;
    expanded++;
    const dir = s & 7, cell = s >> 3;
    const i = Math.floor(cell / FP_N), j = cell % FP_N;
    const hh = h(i, j);
    if (hh < nearestH) { nearestH = hh; nearest = s; }
    if (hh < FP_CELL * 1.5) { end = s; break; }
    const g = _best[s];
    for (let k = 0; k < 8; k++) {
      let dd = Math.abs(k - dir); if (dd > 4) dd = 8 - dd;
      // Not a hairpin at any speed: that is the driver's turn-round to find.
      if (dd > 2) continue;
      const a = i + DIRS[k][0], b = j + DIRS[k][1];
      if (a < 0 || b < 0 || a >= FP_N || b >= FP_N) continue;
      const c2 = a * FP_N + b;
      // A car next to a trunk can still leave it.
      if (_hard[c2] && Math.hypot(a - si, b - sj) > 2.5) continue;
      const cost = g + STEP[k] + dd * dd * turn + (_soft[c2] ? FP_SOFT_COST : 0);
      const s2 = c2 * 8 + k;
      if (_seen[s2] === _stamp && _best[s2] <= cost) continue;
      if (n >= _heap.length - 1) continue;
      _seen[s2] = _stamp; _best[s2] = cost; _from[s2] = s;
      heapPush(n++, s2, cost + h(a, b) * FP_GREED);
    }
  }
  if (end < 0) {
    // Ran out of search: as far as it got, if that is real progress.
    if (nearestH > h(si, sj) - 30) return null;
    end = nearest;
  }

  // Back along it, then the corners pulled tight.
  const raw = [];
  for (let s = end; s >= 0; s = _from[s]) {
    const cell = s >> 3;
    raw.push({ x: ox + (Math.floor(cell / FP_N) + 0.5) * FP_CELL, z: oz + ((cell % FP_N) + 0.5) * FP_CELL });
  }
  raw.reverse();
  raw[0] = { x: sx, z: sz };
  if (end !== nearest || nearestH < FP_CELL * 1.5) raw.push({ x: gx, z: gz });
  const tight = sx === fx && sz === fz ? [raw[0]] : [{ x: fx, z: fz }, raw[0]];
  for (let i = 0; i < raw.length - 1;) {
    let j = raw.length - 1;
    while (j > i + 1 && !lineClear(raw[i].x, raw[i].z, raw[j].x, raw[j].z)) j--;
    tight.push(raw[j]);
    i = j;
  }

  // Each corner a curve, and points close enough for the driver to read it by.
  const line = [{ x: fx, z: fz, speed: 70 }];
  const push = (x, z) => line.push({ x, z, speed: 70 });
  for (let i = 1; i < tight.length; i++) {
    const p = tight[i - 1], q = tight[i], r = tight[i + 1];
    const seg = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    let dIn = r ? Math.min(FP_ROUND, seg * 0.45) : 0;
    const out = r ? Math.hypot(r.x - q.x, r.z - q.z) || 1 : 1;
    let dOut = r ? Math.min(FP_ROUND, out * 0.45) : 0;
    // A curve cuts the corner, and the corner is what the line went wide to miss.
    // Tighter until it is clear; the corner itself was checked.
    if (r) {
      for (let tries = 0; tries < 3 && !curveClear(q, (q.x - p.x) / seg, (q.z - p.z) / seg, (r.x - q.x) / out, (r.z - q.z) / out, dIn, dOut); tries++) {
        dIn *= 0.5; dOut *= 0.5;
      }
    }
    const steps = Math.floor((seg - dIn) / 8);
    for (let k = 1; k <= steps; k++) {
      const t = (k * 8) / seg;
      push(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t);
    }
    if (!r) { push(q.x, q.z); break; }
    const ax = q.x - ((q.x - p.x) / seg) * dIn, az = q.z - ((q.z - p.z) / seg) * dIn;
    const bx = q.x + ((r.x - q.x) / out) * dOut, bz = q.z + ((r.z - q.z) / out) * dOut;
    for (let t = 0; t <= 1.001; t += 0.2) {
      const u = 1 - t;
      push(u * u * ax + 2 * u * t * q.x + t * t * bx, u * u * az + 2 * u * t * q.z + t * t * bz);
    }
    tight[i] = { x: bx, z: bz };
  }
  return { line };
}
