// The gaps between the buildings, as a thing the police can plan over.
//
// "They don't seem to know that they can fit through tiny gaps... I can chase my
// friend better than they can chase me. Why? They're computers."
//
// Because the entire map the AI could plan over was the road network. Streets,
// avenues, lanes, motorways -- and nothing else. The gap between two houses was
// not an edge in that graph, so it did not exist: when a player cut through an
// estate the pursuit stopped navigating and started groping, sweeping a fan of
// headings and picking the clearest arc three seconds at a time, which is what
// `Driver.pickGap` is for and is no substitute for knowing where a gap comes out.
// It is also why heading them off failed. `RoadGraph.predict` walks roads, so the
// junctions units were sent to were on roads the car was not using: measured over
// eight routes, the car went past 11% of them.
//
// A human chasing a friend through the same estate does not follow their line at
// all. They know the alley comes out on the next street, so they take the street
// and meet them. That is not a reflex, it is a map -- and this builds the part of
// the map that was missing.
//
// Two stages. First a clearance field: how far the nearest solid thing is from
// every two-metre cell of the world, which comes out of the physics colliders
// rather than the map generator, so it works for any map and knows about whatever
// actually got built. Then a search for cut-throughs: pairs of road nodes with a
// drivable way between them that the road network does not provide, found by A*
// across the field and kept only when they genuinely save time.
//
// The result is ordinary graph edges, so everything that already routes gets them
// for nothing -- `route`, `pathFromPosition`, `routeTime`, and `predict`.

import { dist2 } from '../util/math.js';
import { GROUP, raycast, sweepBox, RAY_WALL, RAY_SOLID } from '../physics/world.js';

/** Metres per cell of the clearance field. */
const CELL = 2;

/**
 * Narrowest gap worth recording, as the half-width a car needs. A police car is
 * about 1.94 m across, so 1.15 m of half-width plus the quantisation of a
 * two-metre grid is the tightest thing one can be sent through.
 */
const MIN_HALF = 1.15;

/** How much further round by road a cut has to be before it is worth having. */
const WORTH_IT = 1.5;

/** Limits, so this cannot run away on a big map. */
const MAX_SPAN = 240;        // longest cut worth looking for, metres
const MIN_SPAN = 34;         // shorter than this and the roads already join them
const MAX_CELLS = 2600;      // A* expansion budget per pair
const NEAR_PER_NODE = 8;     // candidate partners each node considers

/**
 * What counts as a gap between buildings rather than open ground: the true width
 * at the tightest point, and how much of it the way through actually gets to use.
 * A police car is 1.94 m across.
 */
const MIN_GAP = 3;
const MAX_GAP = 16;
const USABLE_MIN = 2.4;

/**
 * Half-width a cut is verified at. A police car is 0.97, so this leaves about
 * forty centimetres either side for the path smoothing to wander into.
 */
const VERIFY_HALF = 1.4;

const _at = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };
const MAX_CUTS = 500;

/**
 * How far the nearest solid thing is from every cell, in metres.
 *
 * Built from the colliders, not from the generator: the generator knows where it
 * meant to put buildings, and this needs to know what is actually there. Boxes
 * only -- that is what buildings and walls are -- and tall enough and wide enough
 * to be worth going round, so street furniture and kerbs do not close a gap.
 *
 * The footprint is rasterised with its rotation, because a town is full of
 * buildings at an angle and taking their bounding boxes instead closes most of
 * the gaps between them.
 */
export function buildClearance(world, half = 1000) {
  const n = Math.ceil((half * 2) / CELL);
  const blocked = new Uint8Array(n * n);
  let boxes = 0;

  const toCell = (w) => Math.floor((w + half) / CELL);

  world.forEachCollider((c) => {
    // Buildings, by collision group rather than by size. Guessing from the
    // dimensions marks the ground plane as a building -- it is a box a kilometre
    // across -- and then every cell in the world reads as solid, which is exactly
    // what the first version of this did. Props are deliberately not included: a
    // tree is something to steer round, as RAY_SOLID and _avoidScenery both
    // already say, not something to plan a route around.
    const member = c.collisionGroups ? (c.collisionGroups() >>> 16) : 0;
    if (!(member & GROUP.BUILDING)) return;
    const h = c.halfExtents ? c.halfExtents() : null;
    if (!h || Math.max(h.x, h.z) < 1) return;
    boxes++;
    const t = c.translation();
    const q = c.rotation ? c.rotation() : null;
    // Yaw out of the quaternion. These are all upright boxes turned about Y.
    const yaw = q ? Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)) : 0;
    const ca = Math.cos(yaw), sa = Math.sin(yaw);

    const reach = Math.hypot(h.x, h.z);
    const x0 = toCell(t.x - reach), x1 = toCell(t.x + reach);
    const z0 = toCell(t.z - reach), z1 = toCell(t.z + reach);
    for (let cx = Math.max(0, x0); cx <= Math.min(n - 1, x1); cx++) {
      const wx = cx * CELL - half + CELL * 0.5 - t.x;
      for (let cz = Math.max(0, z0); cz <= Math.min(n - 1, z1); cz++) {
        const wz = cz * CELL - half + CELL * 0.5 - t.z;
        // Into the box's own frame, where the test is a rectangle again.
        const lx = wx * ca + wz * sa;
        const lz = -wx * sa + wz * ca;
        if (Math.abs(lx) <= h.x && Math.abs(lz) <= h.z) blocked[cz * n + cx] = 1;
      }
    }
  });

  // Chamfer distance transform, two passes. Distances in cells; the diagonal
  // step of 1.414 is what keeps it from reading as a city-block metric, which
  // would call a diagonal gap wider than it is.
  const D1 = 1, D2 = Math.SQRT2;
  const far = n * 4;
  const d = new Float32Array(n * n);
  for (let i = 0; i < d.length; i++) d[i] = blocked[i] ? 0 : far;

  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + D1);
      if (z > 0) v = Math.min(v, d[i - n] + D1);
      if (x > 0 && z > 0) v = Math.min(v, d[i - n - 1] + D2);
      if (x < n - 1 && z > 0) v = Math.min(v, d[i - n + 1] + D2);
      d[i] = v;
    }
  }
  for (let z = n - 1; z >= 0; z--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = z * n + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < n - 1) v = Math.min(v, d[i + 1] + D1);
      if (z < n - 1) v = Math.min(v, d[i + n] + D1);
      if (x < n - 1 && z < n - 1) v = Math.min(v, d[i + n + 1] + D2);
      if (x > 0 && z < n - 1) v = Math.min(v, d[i + n - 1] + D2);
      d[i] = v;
    }
  }
  // Into metres, and clamped: beyond a few car widths the exact figure is not
  // interesting and a smaller range keeps the numbers readable.
  for (let i = 0; i < d.length; i++) d[i] = Math.min(d[i] * CELL, 40);

  let blockedCells = 0;
  for (let i = 0; i < blocked.length; i++) if (blocked[i]) blockedCells++;

  return {
    cell: CELL,
    n,
    half,
    boxes,
    blockedCells,
    clear: d,
    /** Clearance in metres at a world point; 0 outside the map. */
    at(x, z) {
      const cx = Math.floor((x + half) / CELL);
      const cz = Math.floor((z + half) / CELL);
      if (cx < 0 || cz < 0 || cx >= n || cz >= n) return 0;
      return d[cz * n + cx];
    },
  };
}

/**
 * Ways through that the road network does not provide.
 *
 * Pairs of road nodes with a drivable line between them across the clearance
 * field, kept only where going round by road is at least half again as far. That
 * last test is what stops this filling the graph with edges that run alongside a
 * street and help nobody.
 *
 * A* across the field rather than a straight line, because there is no straight
 * line across a built-up area -- the rig in tests/weave.js established that the
 * hard way, searching four thousand of them and finding none that missed every
 * building. The way through a terrace of houses bends.
 */
export function findCuts(graph, field, world, opts = {}) {
  const minHalf = opts.minHalf || MIN_HALF;
  const maxCuts = opts.maxCuts || MAX_CUTS;
  const n = field.n, cell = field.cell, half = field.half, clear = field.clear;
  const total = n * n;

  // Scratch, allocated once for the whole search and dropped when it returns.
  const g = new Float32Array(total);
  const came = new Int32Array(total);
  const stamp = new Int32Array(total);
  let mark = 0;

  // A binary heap of cell indices, keyed on f.
  const heapIdx = new Int32Array(MAX_CELLS * 8);
  const heapF = new Float32Array(MAX_CELLS * 8);
  let heapN = 0;
  const push = (i, f) => {
    if (heapN >= heapIdx.length) return;
    let k = heapN++;
    heapIdx[k] = i; heapF[k] = f;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapF[p] <= heapF[k]) break;
      const ti = heapIdx[p], tf = heapF[p];
      heapIdx[p] = heapIdx[k]; heapF[p] = heapF[k];
      heapIdx[k] = ti; heapF[k] = tf;
      k = p;
    }
  };
  const pop = () => {
    const top = heapIdx[0];
    heapN--;
    if (heapN > 0) {
      heapIdx[0] = heapIdx[heapN]; heapF[0] = heapF[heapN];
      let k = 0;
      for (;;) {
        const l = k * 2 + 1, r = l + 1;
        let m = k;
        if (l < heapN && heapF[l] < heapF[m]) m = l;
        if (r < heapN && heapF[r] < heapF[m]) m = r;
        if (m === k) break;
        const ti = heapIdx[m], tf = heapF[m];
        heapIdx[m] = heapIdx[k]; heapF[m] = heapF[k];
        heapIdx[k] = ti; heapF[k] = tf;
        k = m;
      }
    }
    return top;
  };

  const cx = (wx) => Math.floor((wx + half) / cell);
  const cellAt = (wx, wz) => cx(wz) * 0 + cx(wx) + cx(wz) * n;
  const wxOf = (i) => (i % n) * cell - half + cell * 0.5;
  const wzOf = (i) => Math.floor(i / n) * cell - half + cell * 0.5;

  // Eight-way steps, with their costs.
  const NB = [-1, 1, -n, n, -n - 1, -n + 1, n - 1, n + 1];
  const NBC = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

  /** A* between two cells. Returns the path as cell indices, nearest first. */
  const search = (from, to) => {
    mark++;
    heapN = 0;
    g[from] = 0; came[from] = -1; stamp[from] = mark;
    const tx = to % n, tz = Math.floor(to / n);
    push(from, 0);
    let expanded = 0;
    while (heapN > 0 && expanded < MAX_CELLS) {
      const cur = pop();
      if (cur === to) break;
      expanded++;
      const ux = cur % n, uz = Math.floor(cur / n);
      for (let k = 0; k < 8; k++) {
        const nx = cur + NB[k];
        if (nx < 0 || nx >= total) continue;
        // Wrapping round the row edge is not a step.
        const ax = nx % n;
        if (Math.abs(ax - ux) > 1) continue;
        if (clear[nx] < minHalf) continue;
        const step = NBC[k] * cell;
        const ng = g[cur] + step;
        if (stamp[nx] === mark && ng >= g[nx]) continue;
        stamp[nx] = mark; g[nx] = ng; came[nx] = cur;
        const hx = (ax - tx) * cell, hz = (Math.floor(nx / n) - tz) * cell;
        push(nx, ng + Math.hypot(hx, hz));
      }
    }
    if (stamp[to] !== mark) return null;
    const out = [];
    for (let i = to; i !== -1; i = came[i]) out.push(i);
    return out;
  };

  // How far it is round by road, so a cut is only kept when it saves something.
  const roadLength = (a, b) => {
    const path = graph.route(a, b);
    if (!path || path.length < 2) return Infinity;
    let len = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const e = graph.edgeBetween(path[i], path[i + 1]);
      if (!e) return Infinity;
      len += e.length;
    }
    return len;
  };

  // Candidate pairs, bounded. Every node against every other is 43,000 pairs on
  // a town this size and most of them are absurd; a cut-through joins two
  // junctions that are near each other, so each node only looks at its nearest
  // few within range. That is what keeps this to a couple of hundred milliseconds
  // instead of most of a second.
  const nodes = graph.nodes;
  const live = nodes.filter((x) => x && x.edges.length);
  const pairs = [];
  for (const a of live) {
    const near = [];
    for (const b of live) {
      if (b.id <= a.id) continue;
      const span = dist2(a.x, a.z, b.x, b.z);
      if (span < MIN_SPAN || span > MAX_SPAN) continue;
      if (graph.edgeBetween(a.id, b.id)) continue;
      near.push({ b, span });
    }
    near.sort((p1, p2) => p1.span - p2.span);
    for (const k of near.slice(0, NEAR_PER_NODE)) pairs.push({ a, b: k.b, span: k.span });
  }

  const found = [];
  for (const { a, b, span } of pairs) {
    // Worth looking at? Only if the roads make a meal of it.
    const byRoad = roadLength(a.id, b.id);
    if (byRoad < span * WORTH_IT) continue;

    const path = search(cellAt(a.x, a.z), cellAt(b.x, b.z));
    if (!path) continue;
    path.reverse();

    let len = 0, tight = Infinity, tightAt = 0;
    for (let k = 0; k < path.length; k++) {
      if (k > 0) {
        len += dist2(wxOf(path[k - 1]), wzOf(path[k - 1]), wxOf(path[k]), wzOf(path[k]));
      }
      const c = clear[path[k]];
      if (c < tight) { tight = c; tightAt = k; }
    }
    // And the way through has to be shorter than the road, not merely exist.
    if (len > byRoad * 0.85) continue;

    found.push({
      a: a.id,
      b: b.id,
      byRoad,
      len,
      saved: byRoad - len,
      tight,
      points: simplify(path, wxOf, wzOf),
      narrowest: { x: wxOf(path[tightAt]), z: wzOf(path[tightAt]) },
      heading: tightAt > 0
        ? Math.atan2(wxOf(path[tightAt]) - wxOf(path[tightAt - 1]),
          wzOf(path[tightAt]) - wzOf(path[tightAt - 1]))
        : 0,
    });
  }

  // Measured, then kept only where the way through is actually a gap.
  //
  // Scoped deliberately. Uncapped, four fifths of what this finds is open
  // ground -- a dash across a park or a car park where the road detour is
  // enormous -- and those are real shortcuts too, worth hundreds of metres. They
  // are also riskier: the clearance field knows about buildings and nothing else,
  // so an open-ground cut will cheerfully cross a dual carriageway or a river.
  // The complaint this is for is specifically about gaps between buildings, so
  // that is what goes in, and the open-ground case is left for later.
  measureCuts(world, found);
  const gaps = found.filter((c) => c.width >= MIN_GAP && c.width <= MAX_GAP
    && c.usable >= USABLE_MIN);
  // Ranked on the ground they save, because that is what a shortcut is for.
  gaps.sort((p1, p2) => p2.saved - p1.saved);
  return gaps.slice(0, maxCuts);
}

/**
 * The cell path as a handful of points rather than forty.
 *
 * Douglas-Peucker: keep the ends, keep whichever point is furthest from the line
 * between them if that is more than the tolerance, and recurse. A cell path is a
 * staircase and an edge wants a line.
 */
function simplify(cells, wxOf, wzOf, tol = 1.4) {
  const pts = cells.map((i) => ({ x: wxOf(i), z: wzOf(i) }));
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    const ax = pts[lo].x, az = pts[lo].z;
    const bx = pts[hi].x, bz = pts[hi].z;
    const dx = bx - ax, dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    let worst = -1, at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs((pts[i].x - ax) * dz - (pts[i].z - az) * dx) / l;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol && at > 0) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Keep only the cuts a car can actually be swept along, end to end.
 *
 * The A* works in two-metre cells and its path starts at the cell containing the
 * road node, not at the node itself, so the first and last hops -- from the
 * junction into the mouth of the gap -- were never checked against anything. At a
 * building corner that matters: one cut came out with its very first segment
 * blocked 2.6 m in, and once the driver started trusting its route as clear (see
 * Driver._pathClear) that became a unit driving into a wall at speed rather than a
 * unit being needlessly cautious.
 *
 * Swept with room to spare, because the path the driver actually gets has been
 * through pathToPoints, and rounding the corners of a corridor moves them: a
 * seven-metre gap that was clear raw had its smoothed form touching a wall.
 */
export function verifyCuts(world, graph, cuts, hw = VERIFY_HALF) {
  const keep = [];
  for (const c of cuts) {
    const a = graph.nodes[c.a], b = graph.nodes[c.b];
    if (!a || !b) continue;
    const line = [{ x: a.x, z: a.z }].concat(c.points, [{ x: b.x, z: b.z }]);
    let clear = true;
    for (let i = 0; i < line.length - 1 && clear; i++) {
      const dx = line[i + 1].x - line[i].x, dz = line[i + 1].z - line[i].z;
      const len = Math.hypot(dx, dz);
      if (len < 0.3) continue;
      _at.x = line[i].x; _at.y = 1.0; _at.z = line[i].z;
      _dir.x = dx / len; _dir.y = 0; _dir.z = dz / len;
      if (sweepBox(world, _at, _dir, len, RAY_SOLID, null, hw) < len - 0.25) clear = false;
    }
    if (clear) keep.push(c);
  }
  return keep;
}

/**
 * How wide each cut actually is at its tightest, by looking.
 *
 * The clearance field is quantised to its two-metre cells, which is enough to
 * find a gap and not enough to say whether a van fits through it. So at the
 * narrowest point of each cut, cast across the way through and measure. A pair of
 * rays costs nothing and the answer is exact.
 */
export function measureCuts(world, cuts) {
  for (const c of cuts) {
    const nx = Math.cos(c.heading), nz = -Math.sin(c.heading);
    const o = { x: c.narrowest.x, y: 1.0, z: c.narrowest.z };
    const left = raycast(world, o, { x: -nx, y: 0, z: -nz }, 30, RAY_WALL);
    const right = raycast(world, o, { x: nx, y: 0, z: nz }, 30, RAY_WALL);
    const l = left ? left.toi : 30;
    const r = right ? right.toi : 30;
    c.width = Math.min(l + r, 60);
    // How far off the middle of the gap the path runs, which is how much of the
    // width a car actually gets to use.
    c.usable = Math.min(l, r) * 2;
  }
  return cuts;
}

/**
 * On -- but it was off for a while, and why is the useful part.
 *
 * The map gets built and on its own it is worth nothing. Measured over eight
 * routes behind a target deliberately using the shortcuts, three of four sessions
 * came back *worse* with the gaps than without them, and the reason showed up in
 * one number: a unit routed through a gap spent about a third of its time in there
 * under 4 m/s. The shortcut was shorter and it was not quicker. The router costs
 * edges by time, so it kept choosing one, and a unit crawling down an alley is
 * further from the car than one going round at speed.
 *
 * Three things were making them crawl, all found with tests/gap.js, which drives a
 * single car through a single gap and reads which of Driver.caps was the binding
 * limit while it was in there.
 *
 *   mean through a gap   the binding limit        what it was
 *   28 km/h              its own asked speed 58%  the edge's posted 8 m/s, set to
 *                                                 discourage the router and
 *                                                 obeyed by the driver as well
 *   38 km/h              the aim probe 58%        "be able to stop in what you can
 *                                                 see", aimed at the wall at the
 *                                                 far end of the corridor
 *   37 km/h              the route itself 44%     the route was not verified at
 *                                                 its ends, so the first hop out
 *                                                 of the junction clipped a corner
 *   55 km/h              its own asked speed 85%  nothing left in the way
 *
 * So: cutSpeed gives a gap a posted speed from its width and CUT_PENALTY carries
 * the router's reluctance on its own; Driver._pathClear measures clearance along
 * the route rather than down a straight line; verifyCuts keeps only cuts a car can
 * be swept along end to end. With those, 13 of 14 gaps are driven through at a
 * mean of 55 km/h, never dropping below a walking crawl, with one contact in
 * fourteen.
 *
 * And then the gaps are worth having. Same rig, both orders, eight routes each:
 *
 *            near   nearest unit   someone in front   the cars that started
 *   with     71/74%     77/67 m        75/76%              65/64%
 *   without  64/60%     84/86 m        70/68%              50/55%
 *
 * Which is the answer to the question that started this: they did not lack the
 * map, and the map alone did nothing. Knowing the way through a gap and being able
 * to drive it are two different pieces of work, and it needed both.
 *
 * Nothing is found on the grid city, and that is correct rather than a failure: a
 * regular grid has no shortcuts worth taking because the roads already go
 * everywhere directly. This is for towns that grew.
 */
export const CUTS_ON = true;

/**
 * The whole job: find the ways through and put them in the graph.
 *
 * Returns what it added, for the rigs and for anyone curious. Costs about a
 * third of a second on a two-kilometre map, on the loading screen, once.
 */
export function buildCutGraph(graph, world, half = 1000, opts = {}) {
  const field = buildClearance(world, half);
  const cuts = verifyCuts(world, graph, findCuts(graph, field, world, opts));
  for (const c of cuts) {
    // The middle of the polyline only: the ends are the nodes themselves, which
    // addCutThrough puts back.
    const mid = c.points.slice(1, -1);
    const e = graph.addCutThrough(c.a, c.b, mid, c.width);
    if (e) {
      c.edge = e.id;
      // Carried on the edge so anything holding a cut edge can find its tightest
      // point without the search that produced it -- tests/gap.js wants it.
      e.narrowest = c.narrowest;
    }
  }
  // The field is big -- a megabyte of floats for a two-kilometre map -- and
  // nothing needs it once the cuts are found, so it is not kept.
  return { cuts, count: cuts.length, boxes: field.boxes, blockedCells: field.blockedCells };
}
