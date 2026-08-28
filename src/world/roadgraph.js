// The road network as a navigable graph.
//
// This is the single most important structure for the police AI. Chasing a car
// by pointing at it and flooring the throttle produces a conga line; what makes
// a pursuit feel coordinated is units routing over a graph to arrive somewhere
// the target has not reached yet. Everything needed for that lives here:
// shortest-time routing, a forward prediction of where the target can plausibly
// be in the next N seconds, and an intercept test that compares the two.

import { clamp, lerp, closestOnSegment, dist2 } from '../util/math.js';

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

/** Which side of the road traffic drives on. -1 = right-hand, +1 = left-hand. */
export const DRIVE_SIDE = +1;   // left-hand traffic

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

  /** Call once the network is complete. */
  finalise() {
    for (const n of this.nodes) {
      this.bounds.minX = Math.min(this.bounds.minX, n.x);
      this.bounds.maxX = Math.max(this.bounds.maxX, n.x);
      this.bounds.minZ = Math.min(this.bounds.minZ, n.z);
      this.bounds.maxZ = Math.max(this.bounds.maxZ, n.z);
    }
    this._buildIndex();
    this._markChokepoints();
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
   */
  pathFromPosition(x, z, dirX, dirZ, goalId, laneOffset = 0, speedCap = Infinity) {
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
