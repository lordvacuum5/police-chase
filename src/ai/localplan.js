// A local planner: every way out of where the car is, weighed against each other.
//
// "Do they have a proper routing system where they find different routes and
// then pick the best one?" On the roads, yes -- RoadGraph.route. Off them, in the
// last hundred metres among the houses, no: a unit was switched between half a
// dozen behaviours (aim at a gap, fall back to the road, regain the road, reverse
// out of a stall, turn round) by rules and timers, and every stuck-car report was
// two of those disagreeing about which way to go. This replaces the switching
// with one answer.
//
// Three steps, each on a 0.5 m grid round the car:
//
//   1. Occupancy. Every building and tree on the map is a box (see
//      physics/world.js addStaticBox); the ones near the car are drawn onto the
//      grid, and a distance transform says how much room each cell has.
//
//   2. Cost to go -- the weighing. A Dijkstra flood outward from every way of
//      finishing, in seconds: the target itself, if it is in the window; every
//      stretch of road in the window, priced at the off-road time to reach it
//      plus the road network's own time from there to the target; and the edge
//      of the window, priced pessimistically. Every cell then holds the time of
//      the best way out through it, so "through that gap", "out onto the road
//      behind and round" and "straight across the grass" are compared as numbers
//      rather than chosen between by rule.
//
//   3. Hybrid A*. A search over moves the car can actually make -- forward and
//      reverse arcs at its real turning circle -- guided by the field from step
//      2, with the car's footprint checked against the room from step 1. A
//      three-point turn is not a special case here; it is what the cheapest
//      sequence of moves looks like when the yard is small.
//
// The result is a short path (forward and reverse legs) that makes real progress
// toward the best way out; Driver.followLocal drives it and the officer replans
// every second or so.

import { GROUP } from '../physics/world.js';

/** Grid cell, metres. Half a car's clearance either side of a 3 m gap is 0.5 m. */
const CELL = 0.5;
/** Window half-size, metres. 96 m square round the car. */
const HALF = 48;
const N = Math.round((HALF * 2) / CELL);
const INF = 1e9;

/** Speeds the time costs are reckoned at, m/s. */
const OFF_SPEED = 6;             // threading among houses and trees
const ROAD_SPEED_CAP = 20;       // road time from the graph, a unit in a hurry
const ROAD_SHARE = 0.85;         // of the posted speed, allowing for corners
/** The edge of the window, where nothing beyond is known: priced warily. */
const EDGE_FACTOR = 1.6;

/** Hybrid A*: lattice and moves. */
const H_CELL = 1.0;              // position resolution of the closed set, m
const H_N = Math.round((HALF * 2) / H_CELL);
const HEADINGS = 36;             // 10 degrees
const STEP = 1.6;                // metres per move
const SUB = 0.4;                 // collision check every this far along a move
const STEERS = [-1, -0.5, 0, 0.5, 1];
const REV_COST = 1.7;            // reversing is slower and nobody likes it
const SWITCH_COST = 1.2;         // seconds, per change of direction
const STEER_COST = 0.03;         // seconds per unit of lock held, keeps lines smooth
const MAX_EXPAND = 6000;
/** Milliseconds the search may take before it settles for what it has. */
const SEARCH_MS = 5;
/** Metres of a plan over which it may be as tight as where the car starts. */
const ESCAPE = 4;
/** Good enough: this much nearer the best way out, in seconds. */
const PROGRESS = 30 / OFF_SPEED;

/**
 * The cost-to-go field is on a coarser grid than the room it is computed over.
 * At 0.5 m an eight-way flood over the window took 90-220 ms; at 1 m it is a
 * quarter of the cells, and the field only has to say which way is cheaper --
 * the search checks the car's real footprint against the 0.5 m room.
 */
const FC = 1.0;
const FN = Math.round((HALF * 2) / FC);

const _occ = new Uint8Array(N * N);
const _clr = new Float32Array(N * N);
const _cost = new Float32Array(FN * FN);
const _room = new Float32Array(FN * FN);
const _road = new Uint8Array(FN * FN);
const _done = new Uint8Array(FN * FN);
const _heap = new Int32Array(FN * FN * 9);
const _best = new Float32Array(H_N * H_N * HEADINGS);
const _seen = new Int32Array(H_N * H_N * HEADINGS);
let _stamp = 0;

/**
 * Every static building and prop box, bucketed, built once per world. A tree
 * knocked flat stays in here as an obstacle, which is the safe way to be wrong;
 * the drive itself still sweeps for real.
 */
function obstacleIndex(game) {
  if (game._obstacleIndex) return game._obstacleIndex;
  const B = 24;
  const buckets = new Map();
  const heightAt = game.sim && game.sim.heightAt;
  game.world.forEachCollider((c) => {
    const member = c.collisionGroups ? (c.collisionGroups() >>> 16) : 0;
    if (!(member & (GROUP.BUILDING | GROUP.PROP))) return;
    const body = c.parent ? c.parent() : null;
    if (body && body.isFixed && !body.isFixed()) return;
    const h = c.halfExtents ? c.halfExtents() : null;
    if (!h) return;
    const t = c.translation();
    // Only what stands in a car's way: not decks overhead, not slabs underfoot.
    const ground = (heightAt ? heightAt(t.x, t.z) : 0) || 0;
    if (t.y - h.y > ground + 1.8 || t.y + h.y < ground + 0.15) return;
    const r = c.rotation();
    const yaw = 2 * Math.atan2(r.y, r.w);
    const box = {
      x: t.x, z: t.z, hx: h.x, hz: h.z,
      c: Math.cos(yaw), s: Math.sin(yaw), rad: Math.hypot(h.x, h.z),
    };
    const x0 = Math.floor((t.x - box.rad) / B), x1 = Math.floor((t.x + box.rad) / B);
    const z0 = Math.floor((t.z - box.rad) / B), z1 = Math.floor((t.z + box.rad) / B);
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        const key = bx * 100003 + bz;
        let list = buckets.get(key);
        if (!list) buckets.set(key, list = []);
        list.push(box);
      }
    }
  });
  game._obstacleIndex = { B, buckets };
  return game._obstacleIndex;
}

/**
 * Build the obstacle list up front, and run one throwaway plan, while the map
 * is loading -- see Game's map load. The first plan of a session cost 57 ms
 * against 9-22 for the rest, all of it the engine compiling this file, and it
 * landed on whichever frame first had a unit in a tight spot.
 */
export function warmLocalPlanner(game) {
  if (!game || !game.world) return;
  obstacleIndex(game);
  const n = game.graph && game.graph.nodes.find((x) => x.edges.length);
  if (!n) return;
  try {
    planLocal(game, {
      position: { x: n.x, y: 0, z: n.z }, forward: { x: 0, z: 1 }, forwardSpeed: 0,
      spec: { dims: { w: 1.9, l: 4.6 }, wheelbase: 2.85, steering: { maxAngle: 0.55 } },
    }, { x: n.x + 60, z: n.z + 60 }, { budgetMs: 20 });
  } catch (e) { /* a warm-up that fails costs nothing but the warm-up */ }
  game._roadTimesCache = null;
}

/** Draw the boxes near (ox, oz) onto the occupancy grid. */
function rasterise(index, ox, oz) {
  _occ.fill(0);
  const { B, buckets } = index;
  const done = new Set();
  const x0 = Math.floor(ox / B), x1 = Math.floor((ox + HALF * 2) / B);
  const z0 = Math.floor(oz / B), z1 = Math.floor((oz + HALF * 2) / B);
  for (let bx = x0; bx <= x1; bx++) {
    for (let bz = z0; bz <= z1; bz++) {
      const list = buckets.get(bx * 100003 + bz);
      if (!list) continue;
      for (const b of list) {
        if (done.has(b)) continue;
        done.add(b);
        const i0 = Math.max(0, Math.floor((b.x - b.rad - ox) / CELL));
        const i1 = Math.min(N - 1, Math.floor((b.x + b.rad - ox) / CELL));
        const j0 = Math.max(0, Math.floor((b.z - b.rad - oz) / CELL));
        const j1 = Math.min(N - 1, Math.floor((b.z + b.rad - oz) / CELL));
        for (let i = i0; i <= i1; i++) {
          const dx = ox + (i + 0.5) * CELL - b.x;
          for (let j = j0; j <= j1; j++) {
            const dz = oz + (j + 0.5) * CELL - b.z;
            // Into the box's own frame (it is turned about +y by its yaw).
            const lx = dx * b.c - dz * b.s;
            const lz = dx * b.s + dz * b.c;
            // Half a cell of slack, so a trunk thinner than a cell still lands.
            if (Math.abs(lx) <= b.hx + CELL * 0.5 && Math.abs(lz) <= b.hz + CELL * 0.5) {
              _occ[i * N + j] = 1;
            }
          }
        }
      }
    }
  }
}

/** Room round each cell, metres, by a two-pass chamfer distance transform. */
function clearance() {
  const D1 = CELL, D2 = CELL * Math.SQRT2;
  for (let k = 0; k < N * N; k++) _clr[k] = _occ[k] ? 0 : INF;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const k = i * N + j;
      let d = _clr[k];
      if (d === 0) continue;
      if (i > 0) {
        d = Math.min(d, _clr[k - N] + D1);
        if (j > 0) d = Math.min(d, _clr[k - N - 1] + D2);
        if (j < N - 1) d = Math.min(d, _clr[k - N + 1] + D2);
      }
      if (j > 0) d = Math.min(d, _clr[k - 1] + D1);
      _clr[k] = d;
    }
  }
  for (let i = N - 1; i >= 0; i--) {
    for (let j = N - 1; j >= 0; j--) {
      const k = i * N + j;
      let d = _clr[k];
      if (d === 0) continue;
      if (i < N - 1) {
        d = Math.min(d, _clr[k + N] + D1);
        if (j > 0) d = Math.min(d, _clr[k + N - 1] + D2);
        if (j < N - 1) d = Math.min(d, _clr[k + N + 1] + D2);
      }
      if (j < N - 1) d = Math.min(d, _clr[k + 1] + D1);
      _clr[k] = d;
    }
  }
}

/**
 * Seconds from each road node to the target by road, by a Dijkstra from the
 * ends of the stretch of road nearest the target.
 */
function roadTimes(graph, tx, tz, cuts) {
  const nodes = graph.nodes, edges = graph.edges;
  const t = new Float64Array(nodes.length).fill(INF);
  const snap = graph.nearestEdge(tx, tz, 400);
  if (!snap) return t;
  const e0 = snap.edge;
  const v0 = Math.min(e0.speed * ROAD_SHARE, ROAD_SPEED_CAP);
  // Off the road at the end, at off-road pace.
  const last = (snap.dist || 0) / OFF_SPEED;
  t[e0.a] = snap.along / v0 + last;
  t[e0.b] = (e0.length - snap.along) / v0 + last;
  const open = [e0.a, e0.b];
  const done = new Uint8Array(nodes.length);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (t[open[i]] < t[open[bi]]) bi = i;
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    for (const eid of nodes[cur].edges) {
      const e = edges[eid];
      if (e.cut && !cuts) continue;
      const nxt = e.a === cur ? e.b : e.a;
      const nt = t[cur] + e.length / Math.min(e.speed * ROAD_SHARE, ROAD_SPEED_CAP);
      if (nt < t[nxt]) { t[nxt] = nt; open.push(nxt); }
    }
  }
  t.snapEdge = e0; t.snapAlong = snap.along; t.last = last;
  return t;
}

/** Binary heap of cell indices keyed on _cost, for the flood. */
function floodCost(hw) {
  let n = 0;
  const push = (k) => {
    _heap[n] = k;
    let i = n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (_cost[_heap[p]] <= _cost[_heap[i]]) break;
      const tmp = _heap[p]; _heap[p] = _heap[i]; _heap[i] = tmp;
      i = p;
    }
  };
  const pop = () => {
    const top = _heap[0];
    _heap[0] = _heap[--n];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < n && _cost[_heap[l]] < _cost[_heap[m]]) m = l;
      if (r < n && _cost[_heap[r]] < _cost[_heap[m]]) m = r;
      if (m === i) break;
      const tmp = _heap[m]; _heap[m] = _heap[i]; _heap[i] = tmp;
      i = m;
    }
    return top;
  };
  _done.fill(0);
  for (let k = 0; k < FN * FN; k++) if (_cost[k] < INF) push(k);
  const free = hw + 0.15;
  const D1 = FC / OFF_SPEED, D2 = (FC * Math.SQRT2) / OFF_SPEED;
  while (n > 0) {
    const k = pop();
    if (_done[k]) continue;
    _done[k] = 1;
    const i = (k / FN) | 0, j = k - i * FN;
    const ck = _cost[k];
    for (let di = -1; di <= 1; di++) {
      const ni = i + di;
      if (ni < 0 || ni >= FN) continue;
      for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const nj = j + dj;
        if (nj < 0 || nj >= FN) continue;
        const nk = ni * FN + nj;
        if (_done[nk]) continue;
        const room = _room[nk];
        if (room < free) continue;
        // A little dearer hard up against things, so the field runs down the
        // middle of a gap rather than along its wall.
        const tight = room < free + 0.8 ? 1.4 : 1;
        const c = ck + (di && dj ? D2 : D1) * tight;
        if (c < _cost[nk] && n < _heap.length) { _cost[nk] = c; push(nk); }
      }
    }
  }
}

/**
 * Plan for `vehicle` toward `goal`. Returns null if there is nothing it can
 * usefully do from here, else
 *   { pts: [{x, z, dir}], toRoad, reached, made: performance time }
 * where `dir` is +1 forward and -1 reverse.
 */
export function planLocal(game, vehicle, goal, opts = {}) {
  const prof = _debug.prof;
  let tp = performance.now();
  const lap = (k) => { const n = performance.now(); prof[k] = (prof[k] || 0) + n - tp; tp = n; };
  const v = vehicle;
  const spec = v.spec;
  const hw = spec.dims.w * 0.5;
  const index = obstacleIndex(game);
  lap('index');
  const ox = v.position.x - HALF, oz = v.position.z - HALF;
  rasterise(index, ox, oz);
  lap('raster');
  clearance();
  lap('clear');

  // ---- cost to go: every way of finishing, seeded ----
  _cost.fill(INF);
  _road.fill(0);
  // The fine grid (room, footprint checks) and the coarse one (the field).
  const cell = (x, z) => {
    const i = Math.floor((x - ox) / CELL), j = Math.floor((z - oz) / CELL);
    return i < 0 || j < 0 || i >= N || j >= N ? -1 : i * N + j;
  };
  const fcell = (x, z) => {
    const i = Math.floor((x - ox) / FC), j = Math.floor((z - oz) / FC);
    return i < 0 || j < 0 || i >= FN || j >= FN ? -1 : i * FN + j;
  };
  // Room at each coarse cell: the best of the fine cells inside it, so a gap
  // narrower than a coarse cell is not closed by the coarsening -- the search
  // still checks the real footprint.
  const sub = Math.round(FC / CELL);
  for (let I = 0; I < FN; I++) {
    for (let J = 0; J < FN; J++) {
      let best = 0;
      for (let a = 0; a < sub; a++) {
        for (let b = 0; b < sub; b++) {
          const c = _clr[(I * sub + a) * N + (J * sub + b)];
          if (c > best) best = c;
        }
      }
      _room[I * FN + J] = best;
    }
  }
  const free = hw + 0.15;
  const seed = (k, c) => { if (k >= 0 && _room[k] >= free && c < _cost[k]) _cost[k] = c; };

  // The target itself, if it is here: anywhere within a few metres of it.
  const gi = Math.floor((goal.x - ox) / FC), gj = Math.floor((goal.z - oz) / FC);
  if (gi >= 0 && gj >= 0 && gi < FN && gj < FN) {
    const R = Math.round(4 / FC);
    for (let di = -R; di <= R; di++) {
      for (let dj = -R; dj <= R; dj++) {
        const ii = gi + di, jj = gj + dj;
        if (ii < 0 || jj < 0 || ii >= FN || jj >= FN) continue;
        seed(ii * FN + jj, (Math.hypot(di, dj) * FC) / OFF_SPEED);
      }
    }
  }

  // Every stretch of road in the window, at its road time to the target.
  const graph = game.graph;
  if (graph && !opts.noRoads) {
    // The road times only depend on where the target is, to within a few
    // metres, so every unit chasing the same car shares one answer for a while.
    const rk = `${Math.round(goal.x / 6)},${Math.round(goal.z / 6)},${!!opts.cuts}`;
    let rc = game._roadTimesCache;
    if (!rc || rc.key !== rk || Math.abs((game.clock || 0) - rc.at) > 2) {
      rc = game._roadTimesCache = {
        key: rk, at: game.clock || 0, times: roadTimes(graph, goal.x, goal.z, !!opts.cuts),
      };
    }
    const times = rc.times;
    const near = graph.edgesNear(v.position.x, v.position.z, HALF * 1.45);
    for (const e of near) {
      if (e.cut && !opts.cuts) continue;
      const sp = Math.min(e.speed * ROAD_SHARE, ROAD_SPEED_CAP);
      const ta = times[e.a], tb = times[e.b];
      for (let s = 0; s <= e.length; s += FC) {
        const p = graph.pointAt(e, s);
        const k = fcell(p.x, p.z);
        if (k < 0) continue;
        let c = Math.min(ta + s / sp, tb + (e.length - s) / sp);
        // The target's own road: straight along it, too.
        if (times.snapEdge === e) {
          c = Math.min(c, Math.abs(s - times.snapAlong) / sp + times.last);
        }
        if (c >= INF) continue;
        // The carriageway, not just its centreline: mark the width as road.
        const half = Math.max(1, (e.width || 6) * 0.5 - 0.5);
        const R = Math.round(half / FC);
        const pi = Math.floor((p.x - ox) / FC), pj = Math.floor((p.z - oz) / FC);
        for (let di = -R; di <= R; di++) {
          for (let dj = -R; dj <= R; dj++) {
            if (di * di + dj * dj > R * R) continue;
            const ii = pi + di, jj = pj + dj;
            if (ii < 0 || jj < 0 || ii >= FN || jj >= FN) continue;
            _road[ii * FN + jj] = 1;
          }
        }
        seed(k, c);
      }
    }
  }

  // The edge of the window: something is out there, and nothing is known of it.
  for (let i = 0; i < FN; i++) {
    for (const j of [0, FN - 1]) {
      for (const [a, b] of [[i, j], [j, i]]) {
        const x = ox + (a + 0.5) * FC, z = oz + (b + 0.5) * FC;
        seed(a * FN + b, (Math.hypot(goal.x - x, goal.z - z) / OFF_SPEED) * EDGE_FACTOR);
      }
    }
  }

  lap('seed');
  floodCost(hw);
  lap('flood');

  // ---- hybrid A* over moves the car can make ----
  const wheelbase = spec.wheelbase || 2.8;
  const lock = (spec.steering && spec.steering.maxAngle) || 0.55;
  const curv = Math.tan(lock * 0.92) / wheelbase;      // 1 / turning radius
  const r = hw + 0.15;
  const nDisc = 4;
  const span = Math.max(0, spec.dims.l * 0.5 - r);
  const offs = [];
  for (let k = 0; k < nDisc; k++) offs.push(-span + (2 * span * k) / (nDisc - 1));
  // Room each disc needs, measured to the nearest occupied cell centre. It was
  // r plus half a cell, which with the half-cell slack the boxes are drawn with
  // asked for about 1.3 m spare across a 1.9 m car: gaps a driver would take
  // were closed, and a car that had drifted near a wall was already "inside"
  // one. A tenth of a metre over the disc is enough on top of that slack.
  const need = r + 0.1;

  // The least room any disc has at a pose.
  const roomAt = (x, z, h) => {
    const sh = Math.sin(h), ch = Math.cos(h);
    let least = INF;
    for (const o of offs) {
      const k = cell(x + sh * o, z + ch * o);
      if (k < 0) return -1;
      if (_clr[k] < least) least = _clr[k];
    }
    return least;
  };
  const fits = (x, z, h) => roomAt(x, z, h) >= need;
  // The field at a point, or -- where the point itself is too tight to be in
  // the field, which is where a car pinned against a wall is standing -- the
  // best of its neighbours plus the drive there.
  const costAt = (x, z) => {
    const k = fcell(x, z);
    if (k < 0) return INF;
    if (_cost[k] < INF) return _cost[k];
    const i = (k / FN) | 0, j = k - i * FN;
    let best = INF;
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= FN || jj >= FN) continue;
        const c = _cost[ii * FN + jj];
        if (c < INF) best = Math.min(best, c + (Math.hypot(di, dj) * FC) / OFF_SPEED);
      }
    }
    return best;
  };

  const h0 = Math.atan2(v.forward.x, v.forward.z);
  const start = { x: v.position.x, z: v.position.z, h: h0 };
  const c0 = costAt(start.x, start.z);
  // Where the car is already tighter than `need` -- pinned against a wall, nose
  // in a hedge -- every move from it used to fail the room test, including the
  // obvious one of driving straight on out of the gap, and with no plan it fell
  // back to the reflexes that had put it there: "it can literally just turn its
  // wheels, and go forwards ... it just doesn't seem able to see it." For the
  // first ESCAPE metres a move is allowed if it is no tighter than the start.
  const startRoom = roomAt(start.x, start.z, start.h);
  const escapeNeed = Math.min(need, Math.max(0, startRoom - 0.05));
  _debug.last = { c0, startClr: _clr[cell(start.x, start.z)], startRoom };
  if (c0 >= INF) return null;
  const target = Math.max(0.3, c0 - PROGRESS);

  // Node pool.
  const nodes = [];
  const add = (x, z, h, g, dir, steer, parent, len = 0) => {
    const f = g + costAt(x, z);
    nodes.push({ x, z, h, g, f, dir, steer, parent, len });
    return nodes.length - 1;
  };
  _stamp++;
  const key = (x, z, h) => {
    const i = Math.floor((x - ox) / H_CELL), j = Math.floor((z - oz) / H_CELL);
    if (i < 0 || j < 0 || i >= H_N || j >= H_N) return -1;
    let a = Math.round((((h % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI / HEADINGS));
    if (a >= HEADINGS) a = 0;
    return (i * H_N + j) * HEADINGS + a;
  };
  // An open list as a heap of node indices on f.
  const open = [];
  const opush = (id) => {
    open.push(id);
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (nodes[open[p]].f <= nodes[open[i]].f) break;
      const t = open[p]; open[p] = open[i]; open[i] = t;
      i = p;
    }
  };
  const opop = () => {
    const top = open[0];
    const last = open.pop();
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, rr = l + 1;
        let m = i;
        if (l < open.length && nodes[open[l]].f < nodes[open[m]].f) m = l;
        if (rr < open.length && nodes[open[rr]].f < nodes[open[m]].f) m = rr;
        if (m === i) break;
        const t = open[m]; open[m] = open[i]; open[i] = t;
        i = m;
      }
    }
    return top;
  };

  // The car's current direction of travel counts as "already going that way",
  // so a plan does not charge for a switch it is not making.
  const curDir = v.forwardSpeed < -0.5 ? -1 : 1;
  const root = add(start.x, start.z, start.h, 0, curDir, 0, -1);
  opush(root);
  let goalNode = -1, bestNode = root, bestCost = c0;
  let expanded = 0;
  // A frame budget as well as a node budget: this runs inside the game loop,
  // and an 80 ms search is a visible stutter. Out of time, it takes the best
  // progress it has found, which is still a move in the right direction.
  const tSearch = performance.now();
  const budget = opts.budgetMs || SEARCH_MS;
  while (open.length && expanded < MAX_EXPAND) {
    if ((expanded & 127) === 127 && performance.now() - tSearch > budget) break;
    const id = opop();
    const n = nodes[id];
    const k = key(n.x, n.z, n.h);
    if (k >= 0) {
      if (_seen[k] === _stamp && _best[k] <= n.g) continue;
      _seen[k] = _stamp; _best[k] = n.g;
    }
    expanded++;
    const here = costAt(n.x, n.z);
    if (here < bestCost) { bestCost = here; bestNode = id; }
    // Progress, and only progress. Stopping as soon as a plan reached any road
    // and handing over to the road router was tried first: the router plans from
    // the car's heading and its own idea of the best road, which is not always
    // the one the field chose, so a car reversed onto a road, was sent the other
    // way, and the next plan reversed it back -- 38 plans in 35 s and nowhere.
    // The field already prices the road, so the plan simply carries on along it.
    if (here <= target) {
      goalNode = id;
      break;
    }
    for (const dir of [1, -1]) {
      for (const st of STEERS) {
        const k2 = st * curv * dir;
        let x = n.x, z = n.z, h = n.h, ok = true;
        for (let s = SUB; s <= STEP + 1e-6; s += SUB) {
          const nh = h + k2 * SUB;
          const mid = (h + nh) * 0.5;
          x += Math.sin(mid) * SUB * dir;
          z += Math.cos(mid) * SUB * dir;
          h = nh;
          const lim = n.len + s < ESCAPE ? escapeNeed : need;
          if (roomAt(x, z, h) < lim) { ok = false; break; }
        }
        if (!ok) continue;
        let g = n.g + (STEP / OFF_SPEED) * (dir < 0 ? REV_COST : 1)
          + Math.abs(st) * STEER_COST;
        if (dir !== n.dir) g += SWITCH_COST;
        const kk = key(x, z, h);
        if (kk >= 0 && _seen[kk] === _stamp && _best[kk] <= g) continue;
        opush(add(x, z, h, g, dir, st, id, n.len + STEP));
      }
    }
  }

  lap('search');
  _debug.last = { c0, bestCost, expanded, startRoom, fitsStart: fits(start.x, start.z, start.h) };
  // Nothing reached the goal set: take the best progress found, if it is real.
  let endId = goalNode;
  if (endId < 0) {
    if (bestCost > c0 - 1) return null;
    endId = bestNode;
  }

  // Unwind, then lay the moves out as points every SUB metres.
  const chain = [];
  for (let id = endId; id !== -1; id = nodes[id].parent) chain.push(nodes[id]);
  chain.reverse();
  const pts = [];
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i];
    const k2 = b.steer * curv * b.dir;
    let x = a.x, z = a.z, h = a.h;
    for (let s = SUB; s <= STEP + 1e-6; s += SUB) {
      const nh = h + k2 * SUB;
      const mid = (h + nh) * 0.5;
      x += Math.sin(mid) * SUB * b.dir;
      z += Math.cos(mid) * SUB * b.dir;
      h = nh;
      pts.push({ x, z, dir: b.dir });
    }
  }
  if (pts.length < 2) return null;
  const end = chain[chain.length - 1];
  return {
    pts,
    toRoad: !!_road[fcell(end.x, end.z)],
    reached: costAt(end.x, end.z) < 1,
    goalX: goal.x, goalZ: goal.z,
    expanded,
    complete: goalNode >= 0,
  };
}

/** For the rigs: the last field, as cost at a world point. */
export const _debug = { cell: CELL, half: HALF, N, cost: _cost, clr: _clr, occ: _occ, prof: {} };
