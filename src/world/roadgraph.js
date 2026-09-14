// The road network as a navigable graph.
//
// This is the single most important structure for the police AI. Chasing a car
// by pointing at it and flooring the throttle produces a conga line; what makes
// a pursuit feel coordinated is units routing over a graph to arrive somewhere
// the target has not reached yet. Everything needed for that lives here:
// shortest-time routing, a forward prediction of where the target can plausibly
// be in the next N seconds, and an intercept test that compares the two.

import { clamp, lerp, closestOnSegment, dist2 } from '../util/math.js';
import { planJunctions, sliceLine } from './junctions.js';

/**
 * Replace each sharp vertex with a short arc, so a routed path describes a
 * line a car could actually drive rather than a sequence of instant turns.
 */
function roundCorners(pts, radius) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    let v1x = a.x - b.x, v1z = a.z - b.z;
    const l1 = Math.hypot(v1x, v1z) || 1; v1x /= l1; v1z /= l1;
    let v2x = c.x - b.x, v2z = c.z - b.z;
    const l2 = Math.hypot(v2x, v2z) || 1; v2x /= l2; v2z /= l2;

    // How far the path turns here. Only genuine corners get filleted: applying
    // a tight fillet to the shallow kinks of a sampled motorway curve invents
    // hairpins that are not there, and the speed planner believes them.
    const dot = clamp(v1x * v2x + v1z * v2z, -1, 1);
    const turn = Math.PI - Math.acos(dot);
    if (turn < 0.42) { out.push(b); continue; }        // under ~24 degrees

    // Scale the fillet with how sharp the turn is, so a slip road sweeps and a
    // right-angle junction stays tight.
    const scaled = radius * clamp(turn / 1.4, 1, 2.2);
    const r = Math.min(scaled, l1 * 0.45, l2 * 0.45);
    const p1 = { x: b.x + v1x * r, z: b.z + v1z * r };
    const p2 = { x: b.x + v2x * r, z: b.z + v2z * r };
    for (let s = 0; s <= 4; s++) {
      const t = s / 4, u = 1 - t;
      out.push({
        x: u * u * p1.x + 2 * u * t * b.x + t * t * p2.x,
        z: u * u * p1.z + 2 * u * t * b.z + t * t * p2.z,
        speed: b.speed, edge: b.edge,
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Even out the spacing so curvature is measured over a consistent scale. */
function resample(pts, maxSeg) {
  if (pts.length < 2) return pts;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / maxSeg));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), speed: a.speed, edge: a.edge });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Where two segments cross, or null. Strictly interior to both: a shared
 * endpoint is not a crossing, it is already a junction.
 */
function segmentCross(p, q) {
  const d1x = p.b.x - p.a.x, d1z = p.b.z - p.a.z;
  const d2x = q.b.x - q.a.x, d2z = q.b.z - q.a.z;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const rx = q.a.x - p.a.x, rz = q.a.z - p.a.z;
  const t = (rx * d2z - rz * d2x) / den;
  const u = (rx * d1z - rz * d1x) / den;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return { x: p.a.x + d1x * t, z: p.a.z + d1z * t };
}

/** Which side of the road traffic drives on. -1 = right-hand, +1 = left-hand. */
export const DRIVE_SIDE = +1;   // left-hand traffic

/**
 * Turning off at the junction a car is already in (see RoadGraph._turnHere).
 * TURN_SPEED is the fastest a car may be going, in m/s, to be given a turn it
 * is not already swinging into -- about 47 km/h, which a car braking into a
 * junction can still make. TURN_BIAS is how many seconds quicker the turn has
 * to be than carrying on, so two near-equal routes do not flip back and forth
 * with every re-plan.
 */
const TURN_SPEED = 13;
const TURN_BIAS = 2;

/** Seconds to drive a path at its roads' speeds. */
function pathTime(pts) {
  let t = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    t += d / Math.max(4, pts[i].speed || 15);
  }
  return t;
}

export const ROAD_KIND = {
  street:   { width: 15, lanes: 1, speed: 15, colour: 0x24272b },
  avenue:   { width: 20, lanes: 2, speed: 19, colour: 0x26292d },
  motorway: { width: 26, lanes: 3, speed: 41, colour: 0x2a2d31 },
  // A British dual carriageway: fast, but narrower than a motorway and joined
  // by roundabouts rather than slip roads.
  dual:     { width: 20, lanes: 2, speed: 33, colour: 0x2a2d31 },
  ramp:     { width: 10, lanes: 1, speed: 19, colour: 0x2a2d31 },
  country:  { width: 9,  lanes: 1, speed: 26, colour: 0x2b2b28 },
  lane:     { width: 9,  lanes: 1, speed: 16, colour: 0x2e2c26 },
};

export class RoadGraph {
  constructor(cellSize = 48) {
    this.nodes = [];
    this.edges = [];
    this.cellSize = cellSize;
    this.cells = new Map();
    this.bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  }

  // ------------------------------------------------------------ construction

  addNode(x, z, type = 'cross') {
    const n = { id: this.nodes.length, x, z, type, edges: [], chokepoint: false };
    this.nodes.push(n);
    return n;
  }

  /**
   * Connect two nodes. `pts` is an optional intermediate polyline (excluding
   * the endpoints) for curved roads.
   */
  addEdge(a, b, kind = 'street', pts = null, opts = {}) {
    const def = ROAD_KIND[kind];
    const points = [{ x: a.x, z: a.z }];
    if (pts) for (const p of pts) points.push({ x: p.x, z: p.z });
    points.push({ x: b.x, z: b.z });

    let length = 0;
    const segs = [];
    for (let i = 0; i < points.length - 1; i++) {
      const l = dist2(points[i].x, points[i].z, points[i + 1].x, points[i + 1].z);
      segs.push({ a: points[i], b: points[i + 1], len: l, start: length });
      length += l;
    }

    const e = {
      id: this.edges.length,
      a: a.id, b: b.id,
      points, segs, length,
      kind,
      width: opts.width || def.width,
      lanes: opts.lanes || def.lanes,
      speed: opts.speed || def.speed,
      bridge: !!opts.bridge,
      y: opts.y || 0,
    };
    this.edges.push(e);
    a.edges.push(e.id);
    b.edges.push(e.id);
    return e;
  }

  /** Rebuild every node's edge list from the edge array. */
  reindexEdges() {
    this.edges = this.edges.filter((e) => !e.dead);
    this.edges.forEach((e, i) => { e.id = i; });
    for (const n of this.nodes) n.edges = [];
    for (const e of this.edges) {
      this.nodes[e.a].edges.push(e.id);
      this.nodes[e.b].edges.push(e.id);
    }
  }

  /**
   * Turn a plain junction into a roundabout: a ring of nodes with every
   * approach reconnected to whichever ring node faces it. The original centre
   * is left isolated and simply stops being routable.
   */
  convertToRoundabout(centre, radius = 26, segments = 8, kind = 'street') {
    const approaches = centre.edges.slice();
    if (approaches.length < 2) return null;

    const ring = [];
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      ring.push(this.addNode(
        centre.x + Math.cos(a) * radius, centre.z + Math.sin(a) * radius, 'roundabout',
      ));
    }
    for (let k = 0; k < segments; k++) {
      this.addEdge(ring[k], ring[(k + 1) % segments], kind, null, { width: 11, speed: 13 });
    }

    for (const eid of approaches) {
      const e = this.edges[eid];
      const otherId = e.a === centre.id ? e.b : e.a;
      const o = this.nodes[otherId];
      let best = ring[0], bd = Infinity;
      for (const rn of ring) {
        const d = (rn.x - o.x) ** 2 + (rn.z - o.z) ** 2;
        if (d < bd) { bd = d; best = rn; }
      }
      // Preserve the approach's own geometry, minus its final hop.
      const pts = (e.a === centre.id ? e.points.slice().reverse() : e.points).slice(1, -1);
      this.addEdge(o, best, e.kind, pts.length ? pts : null);
      e.dead = true;
    }

    this.reindexEdges();
    return { x: centre.x, z: centre.z, r: radius };
  }

  /**
   * Round off every dead end with a turning head.
   *
   * A road that simply stops is both odd to look at and a trap to drive into:
   * you arrive at a blunt end, and the only way out is a three-point turn.
   * Every stub gets a small circular head instead, the way an actual
   * cul-de-sac does -- something you can go round and come back out of without
   * stopping.
   *
   * Called before `finalise`, since it adds nodes and edges.
   */
  addTurningHeads(radius = 15, segments = 10, halfExtent = Infinity) {
    const stubs = [];
    for (const n of this.nodes) {
      const live = n.edges.filter((eid) => !this.edges[eid].dead);
      if (live.length !== 1) continue;
      const e = this.edges[live[0]];
      const other = this.nodes[e.a === n.id ? e.b : e.a];
      stubs.push({ n, other });
    }

    let made = 0;
    for (const { n, other } of stubs) {
      // Carry on the way the road was already going.
      let dx = n.x - other.x, dz = n.z - other.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const cx = n.x + dx * radius, cz = n.z + dz * radius;
      if (Math.abs(cx) > halfExtent - radius - 8 || Math.abs(cz) > halfExtent - radius - 8) continue;

      const ring = [];
      for (let k = 0; k < segments; k++) {
        const a = (k / segments) * Math.PI * 2 + Math.atan2(dz, dx);
        ring.push(this.addNode(cx + Math.cos(a) * radius, cz + Math.sin(a) * radius, 'cross'));
      }
      const kind = this.edges[n.edges[0]].kind === 'lane' ? 'lane' : 'street';
      // Flagged so the mesh builder leaves the kerb lines off. Drawn per edge,
      // they cross each other all round a ring this tight and the head reads as
      // a star rather than a bulb.
      for (let k = 0; k < segments; k++) {
        this.addEdge(ring[k], ring[(k + 1) % segments], kind, null,
          { width: 9, speed: 9 }).turningHead = true;
      }
      // Join the stub to the two ring nodes nearest it, so the head reads as a
      // loop off the end rather than a lollipop on a stick.
      const sorted = ring.slice().sort((p, q) => (
        ((p.x - n.x) ** 2 + (p.z - n.z) ** 2) - ((q.x - n.x) ** 2 + (q.z - n.z) ** 2)
      ));
      this.addEdge(n, sorted[0], kind, null, { width: 9, speed: 9 }).turningHead = true;
      if (sorted[1]) {
        this.addEdge(n, sorted[1], kind, null, { width: 9, speed: 9 }).turningHead = true;
      }
      made++;
    }

    if (made) this.reindexEdges();
    return made;
  }

  /** Recompute an edge's segment table after its polyline has changed. */
  setEdgePoints(e, points) {
    e.points = points;
    e.segs = [];
    let length = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const l = dist2(points[i].x, points[i].z, points[i + 1].x, points[i + 1].z);
      e.segs.push({ a: points[i], b: points[i + 1], len: l, start: length });
      length += l;
    }
    e.length = length;
    return e;
  }

  /**
   * Replace hard bends with arcs.
   *
   * A node with two roads on it is not a junction, it is a corner -- and the
   * generators leave those as sharp vertices, which is what made the town look
   * like it was drawn with a ruler and then folded. Worse, two ribbons meeting
   * at an angle mitre badly and leave slivers of grass showing through on the
   * outside of the bend, which reads as roads that do not quite join up.
   *
   * Both problems go away if the corner becomes a short arc. The node moves to
   * the middle of that arc, so it stays a real point on the road and routing is
   * unaffected; how far it moves scales with how sharp the bend was, so a road
   * that was already nearly straight does not move at all.
   */
  smoothBends(radius = 16, minTurn = 0.10) {
    let made = 0;
    for (const n of this.nodes) {
      const live = n.edges.map((id) => this.edges[id]).filter((e) => e && !e.dead);
      if (live.length !== 2) continue;
      const [e1, e2] = live;
      // Turning heads and roundabout rings are already circles; leave them.
      if (e1.turningHead || e2.turningHead) continue;
      if (n.type === 'roundabout') continue;
      if (e1 === e2) continue;

      const back = e1.a === n.id ? e1.points[1] : e1.points[e1.points.length - 2];
      const fwd = e2.a === n.id ? e2.points[1] : e2.points[e2.points.length - 2];
      if (!back || !fwd) continue;

      let v1x = back.x - n.x, v1z = back.z - n.z;
      const l1 = Math.hypot(v1x, v1z);
      let v2x = fwd.x - n.x, v2z = fwd.z - n.z;
      const l2 = Math.hypot(v2x, v2z);
      if (l1 < 2 || l2 < 2) continue;
      v1x /= l1; v1z /= l1; v2x /= l2; v2z /= l2;

      // How far off straight. Two unit vectors pointing back and forward along
      // a straight road are opposite, so their dot product is -1.
      const dot = clamp(v1x * v2x + v1z * v2z, -1, 1);
      const turn = Math.PI - Math.acos(dot);
      if (turn < minTurn || turn > 2.6) continue;

      // Sharper bends get a bigger arc, but never more than a third of either
      // road: eating a whole short link would move its far junction.
      const r = Math.min(radius * clamp(turn / 0.9, 0.5, 1.8), l1 * 0.34, l2 * 0.34);
      if (r < 1.2) continue;

      const t1 = { x: n.x + v1x * r, z: n.z + v1z * r };
      const t2 = { x: n.x + v2x * r, z: n.z + v2z * r };
      const bez = (t) => {
        const u = 1 - t;
        return {
          x: u * u * t1.x + 2 * u * t * n.x + t * t * t2.x,
          z: u * u * t1.z + 2 * u * t * n.z + t * t * t2.z,
        };
      };

      const STEPS = 4;                       // per half of the arc
      const first = [], second = [];
      for (let k = 0; k <= STEPS; k++) first.push(bez((k / STEPS) * 0.5));
      for (let k = 0; k <= STEPS; k++) second.push(bez(0.5 + (k / STEPS) * 0.5));
      const mid = first[first.length - 1];

      // e1 runs into the node, e2 out of it -- but either may be stored in
      // reverse, so build each new polyline in that edge's own direction.
      const p1 = e1.points.slice(0, -1);
      const rebuilt1 = e1.a === n.id
        ? first.slice().reverse().concat(e1.points.slice(1))
        : p1.concat(first);
      const rebuilt2 = e2.a === n.id
        ? second.concat(e2.points.slice(1))
        : e2.points.slice(0, -1).concat(second.slice().reverse());

      this.setEdgePoints(e1, rebuilt1);
      this.setEdgePoints(e2, rebuilt2);
      n.x = mid.x; n.z = mid.z;
      made++;
    }
    return made;
  }

  /**
   * Round off the kinks *inside* an edge's own polyline.
   *
   * smoothBends deals with corners that happen to fall on a node; a generator
   * that lays a curve out as a handful of straight hops leaves the same kind of
   * corner between them, and those are just as visible. roundCorners already
   * knows how to fillet a polyline, and it leaves the endpoints alone, so the
   * edge still starts and ends exactly on its nodes.
   */
  smoothEdges(radius = 9) {
    for (const e of this.edges) {
      if (e.dead || e.turningHead || e.points.length < 3) continue;
      const rounded = roundCorners(e.points, radius);
      if (rounded.length !== e.points.length) this.setEdgePoints(e, rounded);
    }
    return this;
  }

  /** Call once the network is complete. */
  /**
   * Put a junction wherever two roads cross without one.
   *
   * The generators lay roads out independently -- a grid, a ring motorway,
   * slip roads, country roads striking out across all of it -- and nothing
   * made them agree about where they met. So a country road could cross the
   * motorway with no node in common, and since routing can only ever turn
   * between edges that share a node, the police *could not see the turn*. They
   * would drive over a crossroads that, as far as they were concerned, was not
   * there. On the city map eighteen crossings were like that, six of them onto
   * the motorway.
   *
   * Each crossing splits both edges and hands them a shared node. Where the
   * crossing lands near an end of one of them, that end's existing node is
   * reused instead of making a new one two metres away from it. `bridge` edges
   * are skipped: a crossing there is a grade separation, and the whole point of
   * one is that you cannot turn.
   *
   * Runs before the smoothing passes, so the new nodes get bends rounded off
   * like any other.
   */
  stitchCrossings(snap = 7) {
    const items = [];
    for (const e of this.edges) {
      if (e.dead) continue;
      for (const s of e.segs) items.push({ e, s });
    }

    // Buckets, because this is otherwise forty thousand segments squared.
    const CELL = 60;
    const buckets = new Map();
    const keyOf = (s) => `${Math.floor(Math.min(s.a.x, s.b.x) / CELL)},`
      + `${Math.floor(Math.min(s.a.z, s.b.z) / CELL)}`;
    items.forEach((it, i) => {
      const k = keyOf(it.s);
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(i);
    });

    const cuts = new Map();
    const addCut = (e, along, node) => {
      let list = cuts.get(e);
      if (!list) { list = []; cuts.set(e, list); }
      list.push({ along, node });
    };

    const done = new Set();
    for (let i = 0; i < items.length; i++) {
      const A = items[i];
      if (A.e.bridge) continue;
      const cx = Math.floor(Math.min(A.s.a.x, A.s.b.x) / CELL);
      const cz = Math.floor(Math.min(A.s.a.z, A.s.b.z) / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const b = buckets.get(`${cx + dx},${cz + dz}`);
          if (!b) continue;
          for (const j of b) {
            if (j <= i) continue;
            const B = items[j];
            if (A.e === B.e || B.e.bridge) continue;
            if (A.e.a === B.e.a || A.e.a === B.e.b
              || A.e.b === B.e.a || A.e.b === B.e.b) continue;
            const key = A.e.id < B.e.id
              ? `${A.e.id}-${B.e.id}` : `${B.e.id}-${A.e.id}`;
            if (done.has(key)) continue;

            const hit = segmentCross(A.s, B.s);
            if (!hit) continue;
            done.add(key);

            const alongA = A.s.start + dist2(A.s.a.x, A.s.a.z, hit.x, hit.z);
            const alongB = B.s.start + dist2(B.s.a.x, B.s.a.z, hit.x, hit.z);

            // Reuse an existing end node if the crossing is near one, rather
            // than planting a second node a metre from it and leaving a stub.
            let node = null;
            if (alongA < snap) node = this.nodes[A.e.a];
            else if (A.e.length - alongA < snap) node = this.nodes[A.e.b];
            else if (alongB < snap) node = this.nodes[B.e.a];
            else if (B.e.length - alongB < snap) node = this.nodes[B.e.b];
            if (!node) node = this.addNode(hit.x, hit.z, 'cross');

            if (node !== this.nodes[A.e.a] && node !== this.nodes[A.e.b]) {
              addCut(A.e, alongA, node);
            }
            if (node !== this.nodes[B.e.a] && node !== this.nodes[B.e.b]) {
              addCut(B.e, alongB, node);
            }
          }
        }
      }
    }

    let made = 0;
    for (const [e, list] of cuts) {
      list.sort((p, q) => p.along - q.along);
      const opts = {
        width: e.width, lanes: e.lanes, speed: e.speed, bridge: e.bridge, y: e.y,
      };
      let prev = 0;
      let fromNode = this.nodes[e.a];
      const piece = (toNode, to) => {
        const pts = sliceLine(e.points, prev, to);
        const mid = pts && pts.length > 2 ? pts.slice(1, -1) : null;
        const ne = this.addEdge(fromNode, toNode, e.kind, mid, opts);
        if (e.turningHead) ne.turningHead = true;
        made++;
      };
      for (const c of list) {
        if (c.along - prev < 3 || e.length - c.along < 3) continue;
        piece(c.node, c.along);
        prev = c.along;
        fromNode = c.node;
      }
      if (prev === 0) continue;            // every cut was rejected as too short
      piece(this.nodes[e.b], e.length);
      e.dead = true;
    }

    if (made) this.reindexEdges();
    return done.size;
  }

  finalise() {
    this.stitchCrossings();
    this.smoothBends();
    this.smoothEdges();
    // Again, because the smoothing moves geometry: a node shifted onto the
    // middle of an arc, or a polyline rounded off, can put two roads across
    // each other that were not crossing before it ran.
    this.stitchCrossings();
    for (const n of this.nodes) {
      this.bounds.minX = Math.min(this.bounds.minX, n.x);
      this.bounds.maxX = Math.max(this.bounds.maxX, n.x);
      this.bounds.minZ = Math.min(this.bounds.minZ, n.z);
      this.bounds.maxZ = Math.max(this.bounds.maxZ, n.z);
    }
    this._buildIndex();
    this._markChokepoints();
    // Junction geometry is a property of the network, not of the renderer:
    // the grip grid, the mesh builder and the traffic lights all want it, and
    // they run in that order.
    this.junctionPlan = planJunctions(this);
    // Scratch arrays for routing, allocated once.
    this._gScore = new Float64Array(this.nodes.length);
    this._fScore = new Float64Array(this.nodes.length);
    this._cameFrom = new Int32Array(this.nodes.length);
    this._visitStamp = new Int32Array(this.nodes.length);
    this._stamp = 0;
    return this;
  }

  _buildIndex() {
    this.cells.clear();
    const cs = this.cellSize;
    for (const e of this.edges) {
      for (const s of e.segs) {
        const minX = Math.min(s.a.x, s.b.x), maxX = Math.max(s.a.x, s.b.x);
        const minZ = Math.min(s.a.z, s.b.z), maxZ = Math.max(s.a.z, s.b.z);
        for (let cx = Math.floor(minX / cs); cx <= Math.floor(maxX / cs); cx++) {
          for (let cz = Math.floor(minZ / cs); cz <= Math.floor(maxZ / cs); cz++) {
            const key = cx * 73856093 ^ cz * 19349663;
            let list = this.cells.get(key);
            if (!list) { list = []; this.cells.set(key, list); }
            if (list.indexOf(e.id) === -1) list.push(e.id);
          }
        }
      }
    }
  }

  /**
   * A chokepoint is somewhere a fleeing car has few ways out: a bridge or ramp,
   * or a junction whose roads are all narrow. These are where a blocking unit
   * is worth stationing.
   */
  _markChokepoints() {
    for (const n of this.nodes) {
      const es = n.edges.map((i) => this.edges[i]);
      if (es.some((e) => e.bridge || e.kind === 'ramp')) { n.chokepoint = true; continue; }
      if (es.length <= 2 && es.every((e) => e.width <= 10)) n.chokepoint = true;
    }
  }

  // ------------------------------------------------------------- spatial API

  /**
   * Every edge with any part inside `radius` of (x, z), via the spatial hash.
   * Used when placing scenery, which must not land on a road.
   */
  edgesNear(x, z, radius) {
    const cs = this.cellSize;
    const out = [];
    const seen = new Set();
    const cx0 = Math.floor((x - radius) / cs), cx1 = Math.floor((x + radius) / cs);
    const cz0 = Math.floor((z - radius) / cs), cz1 = Math.floor((z + radius) / cs);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.cells.get(cx * 73856093 ^ cz * 19349663);
        if (!list) continue;
        for (const eid of list) {
          if (seen.has(eid)) continue;
          seen.add(eid);
          out.push(this.edges[eid]);
        }
      }
    }
    return out;
  }

  /**
   * True if any road corridor overlaps the given oriented box. The box is
   * inflated by each road's half width, then road centrelines are sampled
   * against it -- so a road never ends up running through a building.
   */
  overlapsRoad(px, pz, w, d, rot = 0, margin = 0) {
    const reach = Math.hypot(w, d) * 0.5 + 18 + margin;
    const ca = Math.cos(-rot), sa = Math.sin(-rot);
    for (const e of this.edgesNear(px, pz, reach)) {
      const halfW = e.width * 0.5 + margin;
      const bx = w * 0.5 + halfW, bz = d * 0.5 + halfW;
      for (const s of e.segs) {
        const steps = Math.max(1, Math.ceil(s.len / 4));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const dx = (s.a.x + (s.b.x - s.a.x) * t) - px;
          const dz = (s.a.z + (s.b.z - s.a.z) * t) - pz;
          if (Math.abs(dx) > bx + bz || Math.abs(dz) > bx + bz) continue;
          const lx = dx * ca - dz * sa, lz = dx * sa + dz * ca;
          if (Math.abs(lx) < bx && Math.abs(lz) < bz) return true;
        }
      }
    }
    return false;
  }

  /** Nearest node by straight-line distance. Isolated nodes are never chosen. */
  nearestNode(x, z) {
    let best = null, bestD = Infinity;
    for (const n of this.nodes) {
      if (n.edges.length === 0) continue;
      const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /**
   * The closest point on the road network, with the edge it belongs to and how
   * far along that edge it sits. Used to snap cars onto the graph.
   */
  nearestEdge(x, z, maxRadius = 90) {
    const cs = this.cellSize;
    const cx0 = Math.floor((x - maxRadius) / cs), cx1 = Math.floor((x + maxRadius) / cs);
    const cz0 = Math.floor((z - maxRadius) / cs), cz1 = Math.floor((z + maxRadius) / cs);

    let best = null, bestD = Infinity;
    const seen = new Set();

    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.cells.get(cx * 73856093 ^ cz * 19349663);
        if (!list) continue;
        for (const eid of list) {
          if (seen.has(eid)) continue;
          seen.add(eid);
          const e = this.edges[eid];
          for (const s of e.segs) {
            const r = closestOnSegment(x, z, s.a.x, s.a.z, s.b.x, s.b.z);
            if (r.dist < bestD) {
              bestD = r.dist;
              best = { edge: e, x: r.x, z: r.z, dist: r.dist, along: s.start + r.t * s.len };
            }
          }
        }
      }
    }
    // Fall back to a full scan if the car has left the map entirely.
    if (!best) {
      for (const e of this.edges) {
        for (const s of e.segs) {
          const r = closestOnSegment(x, z, s.a.x, s.a.z, s.b.x, s.b.z);
          if (r.dist < bestD) {
            bestD = r.dist;
            best = { edge: e, x: r.x, z: r.z, dist: r.dist, along: s.start + r.t * s.len };
          }
        }
      }
    }
    return best;
  }

  /** Unit direction of travel along an edge at distance `along`, toward node b. */
  edgeDirection(edge, along, out = { x: 0, z: 1 }) {
    let s = edge.segs[0];
    for (const seg of edge.segs) {
      if (along >= seg.start && along <= seg.start + seg.len) { s = seg; break; }
      s = seg;
    }
    const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
    const l = Math.hypot(dx, dz) || 1;
    out.x = dx / l; out.z = dz / l;
    return out;
  }

  other(edge, nodeId) { return edge.a === nodeId ? edge.b : edge.a; }

  /** Position and unit tangent at a distance along an edge. */
  pointAt(edge, along) {
    const a = clamp(along, 0, edge.length);
    let seg = edge.segs[0];
    for (const s of edge.segs) {
      if (a >= s.start && a <= s.start + s.len) { seg = s; break; }
      seg = s;
    }
    const t = seg.len > 1e-6 ? (a - seg.start) / seg.len : 0;
    const dx = seg.b.x - seg.a.x, dz = seg.b.z - seg.a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: seg.a.x + dx * t, z: seg.a.z + dz * t, tx: dx / l, tz: dz / l };
  }

  /**
   * A drivable path from wherever a car actually is to a goal node.
   *
   * Routing alone returns a path starting at a graph *node*, which may be most
   * of an edge away -- on a long curving A-road, seventy metres away. A car
   * handed that path drives straight at its first waypoint, which means
   * straight across whatever lies between. So the route is prefixed with the
   * remainder of the edge the car is currently on.
   *
   * `speed` is how fast the car is going, in m/s. It only matters in a
   * junction: see _turnHere.
   */
  pathFromPosition(x, z, dirX, dirZ, goalId, laneOffset = 0, speedCap = Infinity, speed = 0) {
    const straight = this._pathAhead(x, z, dirX, dirZ, goalId, laneOffset, speedCap);
    const turn = this._turnHere(x, z, dirX, dirZ, goalId, laneOffset, speedCap, speed);
    if (turn && (!straight.length || pathTime(turn) < pathTime(straight) - TURN_BIAS)) return turn;
    return straight;
  }

  /**
   * A route that turns off at the junction the car is standing in, or null.
   *
   * The path above always starts at the junction *ahead*, which is right
   * everywhere except inside a junction. There, the nearest edge is as often
   * the road straight on as the road the car came in on, and "the junction
   * ahead" is then the next one along. A unit slowing into its turn got a
   * fresh route at that moment, found the new route began a block further on,
   * and went straight across -- then did the same at the next junction, and
   * the next. Measured on one 600 m trip across the city: four turns missed in
   * a row and never arrived. Police re-plan every second or so, and a car
   * braking for a corner spends a second or two inside the junction, so it
   * happened on most turns that were not made at speed.
   *
   * So when the car is inside a junction, also ask for a route that turns
   * there. Only turns the car can actually take: one it is already swinging
   * into, or any turn short of a U-turn when it is slow enough to make it.
   */
  _turnHere(x, z, dirX, dirZ, goalId, laneOffset, speedCap, speed) {
    const snap = this.nearestEdge(x, z);
    if (!snap) return null;
    const e = snap.edge;
    const dir = this.edgeDirection(e, snap.along, { x: 0, z: 1 });
    const forward = (dir.x * dirX + dir.z * dirZ) >= 0;

    // Only the junction *behind* the car on its edge. If the junction is still
    // ahead, the ordinary path already runs to it and can turn there.
    const nodeId = forward ? e.a : e.b;
    const n = this.nodes[nodeId];
    if (!n || n.edges.length < 3 || nodeId === goalId) return null;
    let widest = 0;
    for (const eid of n.edges) widest = Math.max(widest, this.edges[eid].width);
    if (Math.hypot(n.x - x, n.z - z) > widest * 0.5 + 6) return null;

    const route = this.route(nodeId, goalId, speedCap);
    if (!route || route.length < 2) return null;
    // Straight on is what the ordinary path already does.
    if (route[1] === (forward ? e.b : e.a)) return null;

    const first = this.edgeBetween(nodeId, route[1]);
    if (!first) return null;
    const probe = Math.min(12, first.length * 0.5);
    const p = this.pointAt(first, first.a === nodeId ? probe : first.length - probe);
    const node = this.nodes[nodeId];
    let lx = p.x - node.x, lz = p.z - node.z;
    const l = Math.hypot(lx, lz) || 1; lx /= l; lz /= l;
    const along = lx * dirX + lz * dirZ;

    // Already pointing down it, or slow enough to swing into anything that is
    // not back the way it came.
    if (!(along > 0.5 || (along > -0.2 && speed < TURN_SPEED))) return null;

    const pts = this.pathToPoints(route, laneOffset);
    return pts.length >= 2 ? pts : null;
  }

  /** The path from a car's position via the junction ahead. See pathFromPosition. */
  _pathAhead(x, z, dirX, dirZ, goalId, laneOffset, speedCap) {
    const snap = this.nearestEdge(x, z);
    if (!snap) return [];
    const e = snap.edge;

    const dir = this.edgeDirection(e, snap.along, { x: 0, z: 1 });
    const forward = (dir.x * dirX + dir.z * dirZ) >= 0;
    const aheadId = forward ? e.b : e.a;

    // Lead-in: follow the current carriageway to the junction ahead.
    const endAlong = forward ? e.length : 0;
    const sgn = forward ? 1 : -1;
    const off = laneOffset === 0 ? 0 : Math.min(laneOffset, e.width * 0.5 - 1.6);
    const span = Math.abs(endAlong - snap.along);
    const steps = Math.max(1, Math.ceil(span / 8));
    const lead = [];
    for (let i = 0; i <= steps; i++) {
      const s = snap.along + (endAlong - snap.along) * (i / steps);
      const p = this.pointAt(e, s);
      const tx = p.tx * sgn, tz = p.tz * sgn;
      lead.push({
        x: p.x + -tz * off * DRIVE_SIDE,
        z: p.z + tx * off * DRIVE_SIDE,
        speed: e.speed, edge: e,
      });
    }

    if (aheadId === goalId) return lead;
    const route = this.route(aheadId, goalId, speedCap);
    if (!route || route.length < 2) return lead;
    const tail = this.pathToPoints(route, laneOffset);
    // The tail's first point duplicates the lead's last.
    return lead.concat(tail.slice(1));
  }

  /**
   * The junction a car at (x, z) travelling in (dirX, dirZ) is heading toward.
   *
   * Routes must start here rather than at the nearest node, which is usually
   * the junction just *behind* the car. Starting behind makes the first
   * waypoint point backwards, and the driver responds by trying to turn round
   * in the middle of the road.
   */
  nodeAhead(x, z, dirX, dirZ) {
    const snap = this.nearestEdge(x, z);
    if (!snap) return this.nearestNode(x, z);
    const d = this.edgeDirection(snap.edge, snap.along, { x: 0, z: 1 });
    const forward = d.x * dirX + d.z * dirZ;
    const id = forward >= 0 ? snap.edge.b : snap.edge.a;
    const node = this.nodes[id];
    return node && node.edges.length ? node : this.nearestNode(x, z);
  }

  // ---------------------------------------------------------------- routing

  /**
   * Shortest-time route between two nodes. Returns an array of node ids, or
   * null. `speedCap` lets a slow unit plan realistically.
   */
  route(startId, goalId, speedCap = Infinity) {
    if (startId === goalId) return [startId];
    const N = this.nodes.length;
    const stamp = ++this._stamp;
    const g = this._gScore, f = this._fScore, from = this._cameFrom, seen = this._visitStamp;

    const goal = this.nodes[goalId];
    const h = (n) => dist2(n.x, n.z, goal.x, goal.z) / 40;

    // A binary heap keyed on fScore. Small enough that an array heap is fine.
    const heap = [startId];
    seen[startId] = stamp;
    g[startId] = 0;
    f[startId] = h(this.nodes[startId]);
    from[startId] = -1;
    const closed = new Set();

    const push = (id) => {
      heap.push(id);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (f[heap[p]] <= f[heap[i]]) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
          if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
          if (m === i) break;
          const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
          i = m;
        }
      }
      return top;
    };

    let guard = 0;
    while (heap.length && guard++ < N * 4) {
      const cur = pop();
      if (cur === goalId) {
        const path = [cur];
        let c = cur;
        while (from[c] !== -1) { c = from[c]; path.push(c); }
        return path.reverse();
      }
      if (closed.has(cur)) continue;
      closed.add(cur);

      for (const eid of this.nodes[cur].edges) {
        const e = this.edges[eid];
        const nxt = this.other(e, cur);
        if (closed.has(nxt)) continue;
        const cost = e.length / Math.min(e.speed, speedCap);
        const tentative = g[cur] + cost;
        if (seen[nxt] !== stamp || tentative < g[nxt]) {
          seen[nxt] = stamp;
          g[nxt] = tentative;
          f[nxt] = tentative + h(this.nodes[nxt]);
          from[nxt] = cur;
          push(nxt);
        }
      }
    }
    return null;
  }

  /** Estimated seconds to drive a route, at a fraction of the posted speed. */
  routeTime(path, speedFactor = 1) {
    if (!path || path.length < 2) return 0;
    let t = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const e = this.edgeBetween(path[i], path[i + 1]);
      if (e) t += e.length / (e.speed * speedFactor);
    }
    return t;
  }

  edgeBetween(aId, bId) {
    for (const eid of this.nodes[aId].edges) {
      const e = this.edges[eid];
      if (e.a === bId || e.b === bId) return e;
    }
    return null;
  }

  /**
   * Where could the target plausibly be in the next `horizon` seconds?
   *
   * A time-limited Dijkstra from the target's position, but biased: the first
   * step must continue roughly in the direction they are already travelling,
   * because a car at 130 km/h is not about to make a U-turn. Returns a Map of
   * nodeId -> { eta, viaNode } which the dispatcher turns into intercepts.
   */
  reachable(fromX, fromZ, dirX, dirZ, horizon = 22, speedFactor = 0.85) {
    const snap = this.nearestEdge(fromX, fromZ);
    const result = new Map();
    if (!snap) return result;

    const e = snap.edge;
    const dirTo = { x: 0, z: 0 };
    this.edgeDirection(e, snap.along, dirTo);
    // Which end of this edge are they heading toward?
    const forwardDot = dirTo.x * dirX + dirTo.z * dirZ;
    const aheadNode = forwardDot >= 0 ? e.b : e.a;
    const behindNode = forwardDot >= 0 ? e.a : e.b;

    const distAhead = forwardDot >= 0 ? e.length - snap.along : snap.along;
    const speed = e.speed * speedFactor;

    const open = [];
    const seed = (id, eta, via) => {
      if (eta > horizon) return;
      const prev = result.get(id);
      if (!prev || eta < prev.eta) {
        result.set(id, { eta, viaNode: via });
        open.push({ id, eta });
      }
    };

    seed(aheadNode, distAhead / speed, -1);
    // A doubling-back penalty rather than a hard ban -- handbrake turns happen.
    seed(behindNode, (e.length - distAhead) / speed + 6.5, -1);

    let guard = 0;
    while (open.length && guard++ < 4000) {
      // Small frontier; a linear scan beats heap bookkeeping here.
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].eta < open[bi].eta) bi = i;
      const cur = open.splice(bi, 1)[0];
      const rec = result.get(cur.id);
      if (!rec || cur.eta > rec.eta + 1e-6) continue;

      for (const eid of this.nodes[cur.id].edges) {
        const edge = this.edges[eid];
        const nxt = this.other(edge, cur.id);
        const eta = cur.eta + edge.length / (edge.speed * speedFactor);
        if (eta > horizon) continue;
        const prev = result.get(nxt);
        if (!prev || eta < prev.eta - 1e-6) {
          result.set(nxt, { eta, viaNode: cur.id });
          open.push({ id: nxt, eta });
        }
      }
    }
    return result;
  }

  /**
   * Unit direction a car leaves `nodeId` in along `edge`, measured over the
   * first dozen metres so a fillet's short segments do not decide it.
   * Arriving at the node along the same edge is the opposite direction.
   */
  leaveDirection(edge, nodeId) {
    if (!this._leaveCache) this._leaveCache = new Map();
    const key = edge.id * 2 + (edge.a === nodeId ? 0 : 1);
    let d = this._leaveCache.get(key);
    if (!d) {
      const n = this.nodes[nodeId];
      const span = Math.min(12, edge.length);
      const p = this.pointAt(edge, edge.a === nodeId ? span : edge.length - span);
      const dx = p.x - n.x, dz = p.z - n.z;
      const l = Math.hypot(dx, dz) || 1;
      d = { x: dx / l, z: dz / l };
      this._leaveCache.set(key, d);
    }
    return d;
  }

  /**
   * Where is this car likely to be in the next `horizon` seconds?
   *
   * `reachable` answers where it *could* be, and treats every junction as
   * equally likely and every road as driven at its limit. That is the right
   * question for putting a roadblock somewhere it cannot be avoided, and the
   * wrong one for sending a car to cut someone off: it spread the intercepts
   * over every side street, and at 200 km/h the target was through the
   * junction before the unit that was sent there had arrived.
   *
   * This follows the car's likely choices instead. Every junction splits the
   * probability between the ways on, weighted by how people drive away from
   * the police: straight on far more often than not (`straightShare`, which
   * the dispatcher learns from what this driver actually does), onto a road
   * at least as big as the one they are on in preference to a smaller one, and
   * almost never into a dead end or back the way they came. Time is the car's
   * own speed where that is faster than the road's, less what it would cost
   * to brake for a turn and get back up to speed -- which at motorway speed
   * is several seconds, and is a large part of why fast drivers go straight.
   *
   * Returns Map nodeId -> { eta, prob }: the chance the car passes through the
   * junction within the horizon, and when it would, on its most likely way
   * there.
   */
  predict(fromX, fromZ, dirX, dirZ, speed, straightShare = 0.65, horizon = 24) {
    const out = new Map();
    const snap = this.nearestEdge(fromX, fromZ);
    if (!snap) return out;
    const e = snap.edge;
    const dir = { x: 0, z: 0 };
    this.edgeDirection(e, snap.along, dir);
    const fwd = dir.x * dirX + dir.z * dirZ >= 0;
    const ahead = fwd ? e.b : e.a;
    const behind = fwd ? e.a : e.b;
    const distAhead = fwd ? e.length - snap.along : snap.along;
    const v0 = Math.max(6, speed);
    const share = clamp(straightShare, 0.3, 0.9);
    // Weight of the straight-on option, set so that at an ordinary crossroads
    // -- straight, left, right -- straight on gets `share` of the probability.
    const straightW = (2 * share) / (1 - share);

    // How fast the car covers an edge: its own speed where that is quicker
    // than the road, the road's otherwise.
    const cruise = (edge) => Math.max(edge.speed * 0.88, Math.min(v0, 70));

    // Seconds lost braking for a turn of `cos` (1 = straight on) at speed `v`
    // and getting back up: 8 m/s^2 down, about 5 back up.
    const turnCost = (cos, v) => {
      if (cos > 0.82) return 0;                       // under ~35 degrees
      const deg = Math.acos(clamp(cos, -1, 1)) * 57.3;
      const vt = clamp(27 - deg * 0.19, 8, 22);
      if (v <= vt) return 0;
      return ((v - vt) * (v - vt)) / (2 * v) * (1 / 8 + 1 / 5);
    };

    const add = (id, eta, prob) => {
      const rec = out.get(id);
      if (!rec) out.set(id, { eta, prob: Math.min(1, prob), best: prob });
      else {
        rec.prob = Math.min(1, rec.prob + prob);
        if (prob > rec.best) { rec.best = prob; rec.eta = eta; }
      }
    };

    // States: at a node, having arrived along an edge, with a probability.
    const open = [
      { node: ahead, via: e, eta: distAhead / cruise(e), prob: 0.94, v: v0 },
      // Turning round is possible -- handbrake turns happen -- but rare.
      { node: behind, via: e, eta: (e.length - distAhead) / Math.min(cruise(e), 18) + 5, prob: 0.06, v: 12 },
    ];
    let guard = 0;
    while (open.length && guard++ < 3000) {
      // Most probable first, so the cap keeps the states that matter.
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].prob > open[bi].prob) bi = i;
      const s = open.splice(bi, 1)[0];
      if (s.eta > horizon || s.prob < 0.012) continue;
      add(s.node, s.eta, s.prob);

      const node = this.nodes[s.node];
      const arriving = this.leaveDirection(s.via, s.node);   // points back where it came from
      const options = [];
      let total = 0;
      for (const eid of node.edges) {
        const edge = this.edges[eid];
        if (!edge || edge.dead || edge === s.via) continue;
        const leave = this.leaveDirection(edge, s.node);
        const cos = -(arriving.x * leave.x + arriving.z * leave.z);
        let w = cos > 0.82 ? straightW : cos > -0.5 ? 1 : 0.35;
        if (edge.speed >= s.via.speed) w *= 1.35;
        const far = this.nodes[this.other(edge, s.node)];
        if (far.edges.length <= 1) w *= 0.25;            // a dead end
        options.push({ edge, cos, w });
        total += w;
      }
      if (!options.length) continue;
      for (const o of options) {
        const prob = s.prob * (o.w / total);
        if (prob < 0.012) continue;
        const loss = turnCost(o.cos, s.v);
        const vOut = loss > 0 ? Math.min(s.v, cruise(o.edge)) : s.v;
        const eta = s.eta + loss + o.edge.length / cruise(o.edge);
        open.push({ node: this.other(o.edge, s.node), via: o.edge, eta, prob, v: vOut });
      }
    }
    for (const rec of out.values()) delete rec.best;
    return out;
  }

  /**
   * Turn a node path into a drivable polyline, offset into the correct lane.
   * `laneOffset` is in metres from the centreline, positive toward the driving
   * side; passing 0 gives the centreline, which is what a pursuing unit uses
   * when it stops caring about lane discipline.
   */
  pathToPoints(path, laneOffset = 0, smooth = true) {
    const raw = this._rawPathPoints(path, laneOffset);
    if (!smooth || raw.length < 3) return raw;
    // Junction corners must be rounded before the points are resampled, or the
    // AI reads a right-angle turn as a 50 m radius sweep, carries motorway
    // speed into it and puts the car through a shop window.
    return resample(roundCorners(raw, 9), 14);
  }

  _rawPathPoints(path, laneOffset = 0) {
    const out = [];
    if (!path || path.length < 2) return out;

    for (let i = 0; i < path.length - 1; i++) {
      const e = this.edgeBetween(path[i], path[i + 1]);
      if (!e) continue;
      const forward = e.a === path[i];
      const pts = forward ? e.points : e.points.slice().reverse();
      const off = laneOffset === 0 ? 0 : Math.min(laneOffset, e.width * 0.5 - 1.6);

      for (let j = 0; j < pts.length; j++) {
        if (i > 0 && j === 0) continue;   // avoid duplicating junction points
        const p = pts[j];
        if (off === 0) {
          out.push({ x: p.x, z: p.z, speed: e.speed, edge: e });
        } else {
          const prev = pts[Math.max(0, j - 1)];
          const next = pts[Math.min(pts.length - 1, j + 1)];
          let dx = next.x - prev.x, dz = next.z - prev.z;
          const l = Math.hypot(dx, dz) || 1;
          dx /= l; dz /= l;
          out.push({
            x: p.x + -dz * off * DRIVE_SIDE,
            z: p.z + dx * off * DRIVE_SIDE,
            speed: e.speed,
            edge: e,
          });
        }
      }
    }
    return out;
  }

  /** A random node, weighted toward a given road kind. Used to seed patrols. */
  randomNode(rng, kindFilter = null) {
    const live = this.nodes.filter((n) => n.edges.length > 0);
    const pool = kindFilter
      ? live.filter((n) => n.edges.some((i) => this.edges[i].kind === kindFilter))
      : live;
    const src = pool.length ? pool : live;
    return src[Math.floor(rng() * src.length) % src.length];
  }
}
