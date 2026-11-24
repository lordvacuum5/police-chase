// Off the edge of the raised motorway, as a way to get somewhere.
//
// "Say I'm down below and say a police car's really far away, it could get onto the motorway because it knows that's
// faster, go really fast, and then jump off the edge if an edge is near me." Each stretch with no barrier (citygen.js,
// JUMPS) is a one-way edge of the road graph each way along the motorway: from the junction before it, along the road,
// out over the edge, down, and on across the ground to a junction there. Only for a police car in a hurry
// (RoadGraph.route, opts.jumps): no patrol, traffic or challenge is ever sent over one.
import { sweepBox, RAY_GROUNDS } from '../physics/world.js';

/** Taken at about this, m/s: what it flies and lands by. */
export const JUMP_SPEED = 34;
/** It starts across from its lane this far before the middle of the gap, m: in 34 m, at speed, it had not the lock to get there. */
const LEAVE = 84;
/** Over the edge this far past the middle of the gap, m: at the middle, the line to it cut across the end of the barrier. */
const PAST = 12;
/** On past where it lands, straight, before turning for a road, m. */
const RUN_OUT = 22;
/** As far off as this the junction it makes for may be, m. */
const REACH = 260;
/** On top of the time it takes, s: a landing costs some. */
export const JUMP_COST = 3;

const _o = { x: 0, y: 0, z: 0 }, _d = { x: 0, y: 0, z: 0 };

/** The ground open from `a` to `b` for a car: nothing solid, no water. */
function open(game, a, b) {
  const map = game.world.__map || {}, at = game.sim.terrainAt, len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 1) return true;
  const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
  let py = at(a.x, a.z);
  for (let s = 0; s < len; s += 12) {
    const e = Math.min(12, len - s), y = at(a.x + ux * (s + e), a.z + uz * (s + e));
    if (map.clearAt && map.clearAt(a.x + ux * (s + e), a.z + uz * (s + e))) return false;
    if (Math.abs(y - py) > e * 0.35) return false;
    const l = Math.hypot(e, y - py);
    _o.x = a.x + ux * s; _o.y = py + 1.1; _o.z = a.z + uz * s;
    _d.x = ux * e / l; _d.y = (y - py) / l; _d.z = uz * e / l;
    if (sweepBox(game.world, _o, _d, l, RAY_GROUNDS, null, 1.4) < l - 0.05) return false;
    py = y;
  }
  return true;
}

/** The road's line up to `s` along `e`, going `dir`, from a junction at least `far` m back: { node, pts, s }. */
function back(G, e, s, dir, far) {
  const parts = [];
  let cur = e, node = dir > 0 ? e.a : e.b, len = dir > 0 ? s : e.length - s;
  const cut = (o, from, to) => {
    const out = [];
    const st = Math.sign(to - from) * 8;
    for (let d = from; st > 0 ? d < to : d > to; d += st) { const p = G.pointAt(o, d); out.push({ x: p.x, z: p.z }); }
    const p = G.pointAt(o, to);
    out.push({ x: p.x, z: p.z });
    return out;
  };
  parts.push(dir > 0 ? cut(e, 0, s) : cut(e, e.length, s));
  for (let k = 0; k < 12 && len < far; k++) {
    const id = G.nodes[node].edges.find((q) => G.edges[q] !== cur && !G.edges[q].cut && G.edges[q].kind === e.kind && G.edges[q].elevated);
    if (id === undefined) return null;
    const o = G.edges[id];
    parts.unshift(o.b === node ? cut(o, 0, o.length) : cut(o, o.length, 0));
    node = o.b === node ? o.a : o.b;
    len += o.length;
    cur = o;
  }
  const pts = [];
  for (const p of parts) for (const q of p) { const l = pts[pts.length - 1]; if (!l || Math.hypot(q.x - l.x, q.z - l.z) > 0.5) pts.push(q); }
  const S = [0];
  for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { node: G.nodes[node], pts, s: S };
}

/** Adds the edges; returns how many. `jumps` is the map's: { edge, s, side, x, z, y, nx, nz, tx, tz }. */
export function addJumps(game, jumps) {
  const G = game.graph, at = game.sim.terrainAt;
  let made = 0;
  for (const j of jumps) {
    const e = j.edge, half = e.width * 0.5;
    j.ways = [];
    for (const dir of [1, -1]) {
      // Back along the road from the gap to a junction far enough off, and the road's line from there.
      const line = back(G, e, j.s + dir * PAST, dir, LEAVE + 12);
      if (!line) continue;
      const A = line.node, total = line.s[line.s.length - 1];
      const along = (d) => {
        let i = 0;
        while (i < line.s.length - 2 && line.s[i + 1] < d) i++;
        const u = (d - line.s[i]) / Math.max(1e-6, line.s[i + 1] - line.s[i]), p = line.pts[i], q = line.pts[i + 1], l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        return { x: p.x + (q.x - p.x) * u, z: p.z + (q.z - p.z) * u, tx: (q.x - p.x) / l, tz: (q.z - p.z) / l };
      };
      // Across to the edge, gently at first, and out over it at the gap's middle.
      const way = [];
      for (let d = total - LEAVE; d < total - 1; d += 7) {
        const u = (d - total + LEAVE) / LEAVE, p = along(d), lat = (half + 0.6) * u * u, sg = p.tx * j.nz - p.tz * j.nx > 0 ? 1 : -1;
        way.push({ x: p.x - p.tz * sg * lat, z: p.z + p.tx * sg * lat });
      }
      const lip = along(total), px = lip.x + j.nx * (half + 0.6), pz = lip.z + j.nz * (half + 0.6);
      const q0 = way[way.length - 2], l = Math.hypot(px - q0.x, pz - q0.z) || 1, ux = (px - q0.x) / l, uz = (pz - q0.z) / l;
      const fly = JUMP_SPEED * Math.sqrt(2 * Math.max(1, j.y - at(px + ux * 40, pz + uz * 40)) / 9.81);
      const land = { x: px + ux * (fly + RUN_OUT), z: pz + uz * (fly + RUN_OUT) };
      let best = null, bd = REACH;
      for (const n of G.nodes) {
        if (n.elevated || !n.edges.length || G.roadDegree(n) < 2 || n.edges.some((id) => G.edges[id].elevated)) continue;
        const dx = n.x - land.x, dz = n.z - land.z, d = Math.hypot(dx, dz);
        // Not under the motorway to the other side of it, among its legs.
        if ((n.x - px) * j.nx + (n.z - pz) * j.nz < 12) continue;
        // Not back the way it came: a turn it can make on grass.
        if (d >= bd || dx * ux + dz * uz < -0.2 * d) continue;
        if (!open(game, land, n)) continue;
        bd = d; best = n;
      }
      if (!best) continue;
      const pts = [];
      for (let i = 1; i < line.pts.length; i++) if (line.s[i] < total - LEAVE - 4) pts.push({ x: line.pts[i].x, z: line.pts[i].z });
      pts.push(...way, { x: px, z: pz }, land);
      const edge = G.addCutThrough(A.id, best.id, pts, 6);
      if (!edge) continue;
      edge.jump = true;
      // Only from the top: nothing at the bottom need know of it.
      best.edges.splice(best.edges.indexOf(edge.id), 1);
      edge.speed = JUMP_SPEED;
      // Where on the edge it goes over, and where it is down: what the driver goes by.
      edge.lip = { x: px, z: pz, y: j.y };
      j.ways.push(edge);
      made++;
    }
  }
  return made;
}
