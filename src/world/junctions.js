// Junction geometry: what happens where road ribbons meet.
//
// Every road is drawn as a ribbon of its own full width, which means that at a
// crossroads four ribbons simply overlap. The tarmac comes out fine -- tarmac
// on tarmac is invisible -- but everything drawn *on* the tarmac does not:
// kerb lines run straight out across the middle of the junction, lane dashes
// carry on through it, and the corners are square where the two carriageways
// happen to cross. That is what made the town look messy.
//
// The fix is to work out, for every approach to every node, how far back from
// the node its markings have to stop in order to clear the other roads. That
// distance -- the setback -- is stored on the edge as trimA/trimB and used by
// buildRoadMeshes to shorten the kerbs and the centre lines. What is left over
// in the corners is then rounded off with a proper kerb radius, and each
// approach gets a stop line.
//
// The same pass decides which junctions are worth signalising, since it has
// already worked out the approach geometry that the traffic lights need.

import { ROAD_KIND } from './roadgraph.js';

/** Roads that carry enough traffic to be worth signalling. */
const SIGNAL_KINDS = new Set(['street', 'avenue', 'dual']);

/** Kerb radius at a junction corner, in metres. */
const CORNER_R = 7.0;

/**
 * Every approach to a node, in angle order.
 *
 * `dir` points *away* from the node, along the road. `half` is half the
 * carriageway width. `end` says which end of the edge sits on this node, so
 * callers know whether to write trimA or trimB.
 */
export function approachesAt(graph, node) {
  const out = [];
  for (const eid of node.edges) {
    const e = graph.edges[eid];
    if (e.dead) continue;
    const atA = e.a === node.id;
    // The next point along the polyline, which for a curved road is not the
    // same as the direction of the far node.
    const near = atA ? e.points[1] : e.points[e.points.length - 2];
    let dx = near.x - node.x, dz = near.z - node.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-3) continue;
    dx /= l; dz /= l;
    out.push({
      edge: e,
      end: atA ? 'a' : 'b',
      dir: { x: dx, z: dz },
      ang: Math.atan2(dz, dx),
      half: e.width * 0.5,
    });
  }
  out.sort((p, q) => p.ang - q.ang);
  return out;
}

/**
 * Work out every setback and stash it on the edges.
 *
 * For two straight roads crossing at angle theta, the corner where their kerb
 * lines cross sits `otherHalfWidth / sin(theta)` along each of them, so that
 * is the distance an approach has to hold back. Shallow crossings would send
 * that to infinity, hence the floor on sin and the overall cap.
 */
export function planJunctions(graph) {
  for (const e of graph.edges) { e.trimA = 0; e.trimB = 0; }

  const junctions = [];

  for (const node of graph.nodes) {
    const app = approachesAt(graph, node);
    if (app.length < 2) continue;

    // A node with two approaches is a bend or a kerb-radius change, not a
    // junction: nothing crosses, so nothing needs holding back.
    const isJunction = app.length >= 3;

    for (let i = 0; i < app.length; i++) {
      const a = app[i];
      let back = 0;
      if (isJunction) {
        for (let j = 0; j < app.length; j++) {
          if (j === i) continue;
          const b = app[j];
          const s = Math.max(0.32, Math.abs(Math.sin(b.ang - a.ang)));
          back = Math.max(back, b.half / s);
        }
        back += 1.2;
      }
      // Never eat more than a third of a short road, and never run away on a
      // shallow crossing.
      back = Math.min(back, a.half * 3.4 + 6, a.edge.length * 0.33);
      a.setback = back;
      if (a.end === 'a') a.edge.trimA = Math.max(a.edge.trimA, back);
      else a.edge.trimB = Math.max(a.edge.trimB, back);
    }

    if (!isJunction) continue;

    const signal = app.length >= 3
      && app.every((a) => SIGNAL_KINDS.has(a.edge.kind) && !a.edge.turningHead)
      && node.type !== 'roundabout'
      && Math.max(...app.map((a) => a.half)) >= 7;

    junctions.push({ node, app, signal });
  }

  return junctions;
}

/**
 * Round off the corners between adjacent approaches.
 *
 * Two crossing ribbons make a plus shape, not a square: the corners where they
 * meet are sharp re-entrant angles, and real junctions do not have those. This
 * fills each one in with tarmac out to a kerb radius and runs a kerb round it,
 * which is the single change that stops a crossroads reading as two rectangles
 * dropped on top of each other.
 */
export function buildJunctionCorners(junctions, road, y, kerbColour) {
  for (const { node, app } of junctions) {
    for (let i = 0; i < app.length; i++) {
      const a = app[i];
      const b = app[(i + 1) % app.length];

      // Sector angle between the two approaches, always taken the short way
      // round in the direction of increasing angle.
      let d = b.ang - a.ang;
      while (d <= 0) d += Math.PI * 2;
      // A reflex sector is the outside of a two-road bend, not a corner.
      if (d >= Math.PI - 0.12 || d < 0.35) continue;

      // Perpendiculars, taken toward increasing angle so `a` uses +perp and
      // `b` uses -perp: both point into the sector between them.
      const pa = { x: -a.dir.z, z: a.dir.x };
      const pb = { x: -b.dir.z, z: b.dir.x };

      // Where the two kerb lines cross: the square corner we want to round.
      const C = lineCross(
        node.x + a.half * pa.x, node.z + a.half * pa.z, a.dir,
        node.x - b.half * pb.x, node.z - b.half * pb.z, b.dir,
      );
      if (!C) continue;

      // Our streets are wide -- fifteen metres for a two-way -- so a real
      // six-metre kerb radius would swallow most of the corner. Scale it to
      // the road instead.
      const r = Math.min(CORNER_R, a.half * 0.55, b.half * 0.55);
      // Tangent points, out along each kerb line past the corner. The fillet
      // sits *outside* the plus shape the two ribbons make: a kerb radius cuts
      // the pavement back, it does not shave the carriageway.
      const tan = Math.min(r / Math.tan(d * 0.5), r * 2.2);
      const t1 = { x: C.x + a.dir.x * tan, z: C.z + a.dir.z * tan };
      const t2 = { x: C.x + b.dir.x * tan, z: C.z + b.dir.z * tan };

      // Fan the wedge outside the arc in pavement, then kerb the arc itself.
      const arc = [t1];
      const steps = 5;
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        // Quadratic Bezier through the corner is close enough to a fillet at
        // this scale, and costs no trigonometry.
        const u = 1 - t;
        arc.push({
          x: u * u * t1.x + 2 * u * t * C.x + t * t * t2.x,
          z: u * u * t1.z + 2 * u * t * C.z + t * t * t2.z,
        });
      }
      arc.push(t2);

      // The corner between the arc and the sharp point is tarmac, so the two
      // carriageways run into each other on a curve.
      const colour = ROAD_KIND[(a.half >= b.half ? a : b).edge.kind].colour;
      for (let k = 0; k < arc.length - 1; k++) {
        road.addQuadY(
          C.x, C.z, arc[k].x, arc[k].z, arc[k + 1].x, arc[k + 1].z, C.x, C.z,
          y + 0.002, colour,
        );
      }
      road.addRibbon(arc, 0.5, y + 0.006, kerbColour);
    }
  }
}

/**
 * Stop lines across every signalised approach.
 *
 * Traffic arriving at the node runs against `dir`. Left of a heading h is
 * (h.z, -h.x), and with h = -dir that works out as +perp -- so the nearside
 * half of the carriageway, where the stop line goes, is the +perp side.
 */
export function buildStopLines(junctions, paint, y, colour) {
  for (const j of junctions) {
    if (!j.signal) continue;
    for (const a of j.app) {
      const d = a.setback + 0.9;
      const q = alongApproach(j.node, a, d);
      const p0 = { x: q.x + q.nx * a.half * 0.04, z: q.z + q.nz * a.half * 0.04 };
      const p1 = { x: q.x + q.nx * a.half * 0.96, z: q.z + q.nz * a.half * 0.96 };
      paint.addRibbon([p0, p1], 0.55, y, colour);
      a.stopLine = { x: (p0.x + p1.x) * 0.5, z: (p0.z + p1.z) * 0.5, dist: d };
    }
  }
}

/**
 * A small disc of surface centred on a node.
 *
 * Every ribbon ends square at its node, so where two roads meet at anything
 * other than a straight line the two square ends leave a wedge of bare ground
 * showing on the outside of the bend. Both ends pass through the node, so a
 * disc of the widest half-width covers every one of those wedges exactly.
 */
export function addNodeApron(builder, x, z, radius, y, colour, sides = 10) {
  const step = (Math.PI * 2) / sides;
  for (let k = 0; k < sides; k++) {
    const a0 = k * step, a1 = (k + 1) * step;
    builder.addQuadY(
      x, z,
      x + Math.cos(a0) * radius, z + Math.sin(a0) * radius,
      x + Math.cos(a1) * radius, z + Math.sin(a1) * radius,
      x, z, y, colour,
    );
  }
}

/**
 * A point `dist` metres from the node along an approach, following the road's
 * actual polyline rather than shooting off along the tangent at the node.
 *
 * That distinction matters now that bends are smoothed: an approach curves
 * away from its node, so projecting along the straight `dir` for eight or ten
 * metres can miss the carriageway by a metre or two -- enough to put a stop
 * line half off the road, or a signal head in it.
 *
 * `n` is the left normal in the approach's own sense, so +n is the same side
 * as +perp at the node.
 */
export function alongApproach(node, app, dist) {
  const e = app.edge;
  const fromA = app.end === 'a';
  const s = fromA ? dist : e.length - dist;
  let acc = 0;
  for (const seg of e.segs) {
    if (s <= acc + seg.len || seg === e.segs[e.segs.length - 1]) {
      const t = seg.len > 1e-6 ? clamp01((s - acc) / seg.len) : 0;
      let dx = (seg.b.x - seg.a.x) / (seg.len || 1);
      let dz = (seg.b.z - seg.a.z) / (seg.len || 1);
      if (!fromA) { dx = -dx; dz = -dz; }
      return {
        x: seg.a.x + (seg.b.x - seg.a.x) * t,
        z: seg.a.z + (seg.b.z - seg.a.z) * t,
        dx, dz, nx: -dz, nz: dx,
      };
    }
    acc += seg.len;
  }
  return {
    x: node.x + app.dir.x * dist, z: node.z + app.dir.z * dist,
    dx: app.dir.x, dz: app.dir.z, nx: -app.dir.z, nz: app.dir.x,
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Intersection of two lines given as (offset from origin, direction). */
function lineCross(ox, oz, od, px, pz, pd) {
  const det = od.x * -pd.z - od.z * -pd.x;
  if (Math.abs(det) < 1e-6) return null;
  const rx = px - ox, rz = pz - oz;
  const t = (rx * -pd.z - rz * -pd.x) / det;
  if (!isFinite(t)) return null;
  return { x: ox + od.x * t, z: oz + od.z * t };
}

/** Slice a polyline between two arc lengths, keeping the shape of the curve. */
export function sliceLine(points, from, to) {
  const out = [];
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const s0 = acc, s1 = acc + len;
    acc = s1;
    if (s1 <= from || s0 >= to) continue;
    const u0 = Math.max(0, (from - s0) / len);
    const u1 = Math.min(1, (to - s0) / len);
    const pt = (u) => ({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
    if (out.length === 0) out.push(pt(u0));
    out.push(pt(u1));
  }
  return out.length >= 2 ? out : null;
}
