// A police car on the motorway sees the road, not the straight line in front of its nose.
//
// "They're kind of sometimes slow on like on the motorway when it's a bit of straight. They should just be able to
// absolutely send it like absolutely full speed, because even if they hit the edge on the motorway ... it should be okay
// for them". Every limit in Driver.safeSpeed asks how far a straight sweep goes before it meets something, and on a
// road that bends, however gently, that is the crash barrier a hundred metres on: behind a car held at 200 km/h round
// the ring they averaged 172 and dropped to 102 (tests/motorpace.js). Here the road ahead is walked along its own
// line, the same sweep is run down the lane the car is in, and the bends set their own limit.
import { clamp, lerp } from '../util/math.js';
import { cornerSpeedLimit } from '../physics/tyre.js';
import { sweepBox, RAY_GROUNDS } from '../physics/world.js';

/** How far ahead the road is walked, m, and in what steps. */
const AHEAD = 520;
const STEP = 10;
/** Walked again when the car has used up this much of it, m. */
const USED = 60;
/** How far off the road's own line the car may be going, radians: more, and the ordinary limits have it. */
const YAW = 0.3;
/** Kept off the edge of the road, m, for a lane to aim down. */
const EDGE = 2.2;
/** A bend's radius is measured between points this many steps apart. */
const SPAN = 4;

const _from = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };

const fast = (e) => e.kind === 'motorway' || (e.elevated && e.kind === 'dual');

export class Motorway {
  constructor(vehicle, graph) {
    this.v = vehicle;
    this.G = graph;
    this.pts = null;
    this.on = false;
    this.tick = 0;
    /** Where the car is: metres along `pts`, metres left of its line, and the angle it is going to it. */
    this.s = 0;
    this.lat = 0;
    this.yaw = 0;
  }

  /** Call once a frame. True while the car is on the motorway and going along it. */
  update() {
    const v = this.v;
    if (--this.tick > 0) return this.on;
    this.tick = 3;
    if (v.speed < 8) { this.pts = null; this.on = false; return false; }
    if (this.pts && !this._place()) this.pts = null;
    if (!this.pts || this.s > USED) {
      this._walk();
      if (!this.pts || !this._place()) { this.pts = null; this.on = false; return false; }
    }
    this.on = Math.abs(this.yaw) < YAW;
    return this.on;
  }

  /** Where the car is on the walked line; false when it has left it. */
  _place() {
    const v = this.v, at = this.find(v.position);
    if (!at || Math.abs(at.lat) > at.half + 0.6) return false;
    this.s = at.s;
    this.lat = at.lat;
    this.left = this.pts[this.pts.length - 1].s - at.s;
    this.yaw = Math.atan2(v.linvel.x * at.nx + v.linvel.z * at.nz, v.linvel.x * at.tx + v.linvel.z * at.tz);
    return true;
  }

  /** The nearest place on the walked line to `p`: { s, lat, half, tx, tz, nx, nz }, or null when it is nowhere near it. */
  find(p) {
    const P = this.pts;
    if (!P) return null;
    let best = null, bd = 900;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
      const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / l2, 0, 1);
      const ex = p.x - a.x - dx * t, ez = p.z - a.z - dz * t, d = ex * ex + ez * ez;
      if (d >= bd) continue;
      if (p.y !== undefined && Math.abs(p.y - lerp(a.y, b.y, t)) > 4) continue;
      const l = Math.sqrt(l2), tx = dx / l, tz = dz / l;
      bd = d;
      best = { s: a.s + l * t, lat: ex * tz - ez * tx, half: a.half, tx, tz, nx: tz, nz: -tx };
    }
    return best;
  }

  _walk() {
    const G = this.G, v = this.v;
    this.pts = null;
    const on = G.nearestEdgeTo(v.position, 18);
    if (!on || !fast(on.edge) || on.dist > on.edge.width * 0.5 + 0.6) return;
    let e = on.edge;
    if (e.deck && Math.abs(G.levelOn(e, on.x, on.z) - v.position.y) > 4) return;
    const p0 = G.pointAt(e, on.along);
    let fwd = v.linvel.x * p0.tx + v.linvel.z * p0.tz >= 0;
    const pts = [];
    let total = 0, along = on.along, last = null;
    const push = (d) => {
      const q = G.pointAt(e, d), step = last ? Math.hypot(q.x - last.x, q.z - last.z) : 0;
      if (last && step < 1) return;
      total += step;
      last = { x: q.x, z: q.z, y: e.deck ? G.levelOn(e, q.x, q.z) : G.levelGround(q.x, q.z), s: total, half: e.width * 0.5 };
      pts.push(last);
    };
    // From a little behind the car, so there is a line under it.
    along = fwd ? Math.max(0, along - 8) : Math.min(e.length, along + 8);
    push(along);
    for (let guard = 0; guard < 80 && total < AHEAD; guard++) {
      for (let d = along + (fwd ? STEP : -STEP); (fwd ? d < e.length : d > 0) && total < AHEAD; d += fwd ? STEP : -STEP) push(d);
      if (total >= AHEAD) break;
      push(fwd ? e.length : 0);
      // On: the straightest of the same sort.
      const node = G.nodes[fwd ? e.b : e.a], was = G.pointAt(e, fwd ? e.length : 0), k0 = fwd ? 1 : -1;
      let next = null, bc = 0.8;
      for (const id of node.edges) {
        const o = G.edges[id];
        if (!o || o === e || o.dead || !fast(o)) continue;
        const q = G.pointAt(o, o.a === node.id ? 0 : o.length), k = o.a === node.id ? 1 : -1;
        const c = (q.tx * was.tx + q.tz * was.tz) * k * k0;
        if (c > bc) { bc = c; next = o; }
      }
      if (!next) break;
      fwd = next.a === node.id;
      e = next;
      along = fwd ? 0 : e.length;
    }
    if (pts.length > 2) this.pts = pts;
  }

  /** The point `s` m along the line, `lat` m left of it. */
  at(s, lat, out) {
    const P = this.pts;
    let i = 0;
    while (i < P.length - 2 && P[i + 1].s < s) i++;
    const a = P[i], b = P[i + 1], l = Math.max(1e-6, b.s - a.s), t = clamp((s - a.s) / l, 0, 1);
    const tx = (b.x - a.x) / l, tz = (b.z - a.z) / l;
    out.x = lerp(a.x, b.x, t) + tz * lat;
    out.z = lerp(a.z, b.z, t) - tx * lat;
    out.y = lerp(a.y, b.y, t);
    return out;
  }

  /** `lat`, kept off the edge of the road. */
  lane(lat) {
    const h = this.pts[0].half - EDGE;
    return clamp(lat, -h, h);
  }

  /** How far down the car's own lane to something solid, m; Infinity when nothing within `need`. */
  clear(need, halfWidth) {
    const lat = this.lane(this.lat), A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
    const far = Math.min(need, this.left);
    let s = this.s + this.v.spec.dims.l * 0.45, acc = 0;
    this.at(s, lat, A);
    while (acc < far) {
      const span = Math.min(20, far - acc);
      this.at(s + span, lat, B);
      const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z, len = Math.hypot(dx, dy, dz) || 1;
      _from.x = A.x; _from.y = A.y + 0.9; _from.z = A.z;
      _dir.x = dx / len; _dir.y = dy / len; _dir.z = dz / len;
      const toi = sweepBox(this.v.world, _from, _dir, len, RAY_GROUNDS, this.v.body, halfWidth);
      if (toi < len - 0.05) return acc + toi;
      acc += span;
      s += span;
      A.x = B.x; A.y = B.y; A.z = B.z;
    }
    return Infinity;
  }

  /** The fastest for the bends ahead, m/s, at friction `mu`, braking at `a`. */
  bends(mu, a) {
    const P = this.pts;
    let limit = Infinity;
    for (let i = 0; i + 2 * SPAN < P.length; i += 2) {
      const p = P[i], q = P[i + SPAN], r = P[i + 2 * SPAN];
      if (r.s < this.s) continue;
      const h1 = Math.atan2(q.x - p.x, q.z - p.z), h2 = Math.atan2(r.x - q.x, r.z - q.z);
      const turn = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
      if (turn < 0.01) continue;
      const vc = cornerSpeedLimit((r.s - p.s) * 0.5 / turn, mu);
      const d = Math.max(0, q.s - this.s - STEP * SPAN * 0.5);
      limit = Math.min(limit, Math.sqrt(vc * vc + 2 * a * d));
    }
    return limit;
  }

  /** The point on this road, if it is and not behind the car: as find(). */
  ahead(p) {
    const f = this.find(p);
    return f && Math.abs(f.lat) < f.half + 2 && f.s > this.s - 2 ? f : null;
  }
}
