// A racing line through the open ground, not an offset from the middle of the road.
//
// "Build a racing line that plans through all the open ground (road, pavement,
// verges) like I drive." The police line (Driver._raceLine) is the road's
// centreline pushed sideways a little, inside half the carriageway; pushed
// wider it measured worse, because a smoothed offset from the middle of the
// road does not know what is beside the road. A player on the pavement is
// using all the flat, clear ground there is and taking the straightest line
// through it.
//
// So, along the next stretch of the route:
//
//   1. Stations every STEP metres, each with the ground either side of it:
//      walk out along the normal until something is in the way -- a building
//      or tree within the car's half-width plus a margin (localplan's boxes),
//      or ground this line may not use -- and keep the free interval that
//      contains the route. On the inside of a bend the walk also stops short
//      of the bend's own centre, where the normals cross.
//   2. The least-bent line through those intervals: each station moved to
//      where the summed squared second difference -- the curvature -- is least
//      given its neighbours, then clamped back into its interval, over and
//      over. That is what a racing line is: out wide, the apex, out wide
//      again, using exactly the room there is.
//   3. The first two stations are pinned to where the car is and the way it is
//      pointing, the last two to the route, so it starts where the car is and
//      rejoins the road at the end.

import { blockedAt } from './localplan.js';
import { SURF_GRASS, SURF_ROAD, SURF_PAVED } from '../world/common.js';

/** Station spacing and how far ahead the line is planned, metres. */
const STEP = 4;
const LEN = () => (typeof window !== 'undefined' && window.__freeLen) || 200;
/** How far either side of the route the ground is searched, and in what steps. */
const WIDE = 12;
const DW = 0.5;
/** Clearance from anything solid, beyond the car's half-width. */
const MARGIN = 0.8;
/** Smoothing passes. */
const ITER = () => (typeof window !== 'undefined' && window.__freeIter) || 1000;
/** Never further toward the inside of a bend than this share of its radius. */
const INSIDE = 0.6;

/**
 * Reshape `pts` (a route, as Driver.setPath takes it) from the point nearest
 * the car onward. Returns a new array, or `pts` unchanged when there is too
 * little route ahead to bother. `opts.grass` lets the line use grass as well
 * as road and pavement.
 */
export function freeLine(game, pts, car, opts = {}) {
  if (!pts || pts.length < 3 || !game || !game.sim) return pts;
  const hw = opts.halfWidth || 1;
  const grass = !!opts.grass;
  const margin = hw + (opts.margin === undefined ? MARGIN : opts.margin);
  const ok = (s) => s === SURF_ROAD || s === SURF_PAVED || (grass && s === SURF_GRASS);
  const free = (x, z) => ok(game.sim.surfaceAt(x, z)) && !blockedAt(game, x, z, margin);

  // Where the car is on the route.
  let k0 = 0, best = Infinity;
  for (let i = 0; i < Math.min(pts.length, 24); i++) {
    const d = Math.hypot(pts[i].x - car.position.x, pts[i].z - car.position.z);
    if (d < best) { best = d; k0 = i; }
  }

  // 1. Stations along the route from there, carrying the road's own speed
  // limit from the stretch each one is on.
  const st = [{ x: pts[k0].x, z: pts[k0].z, speed: pts[k0].speed }];
  let i = k0, need = STEP, along = 0;
  let cx = pts[k0].x, cz = pts[k0].z;
  while (i < pts.length - 1 && along < LEN()) {
    const b = pts[i + 1];
    const seg = Math.hypot(b.x - cx, b.z - cz);
    if (seg >= need) {
      const t = need / seg;
      cx += (b.x - cx) * t; cz += (b.z - cz) * t;
      along += need;
      need = STEP;
      st.push({ x: cx, z: cz, speed: pts[i].speed });
    } else {
      need -= seg;
      cx = b.x; cz = b.z;
      i++;
    }
  }
  const n = st.length;
  if (n < 6) return pts;
  for (let j = 0; j < n; j++) {
    const a = st[Math.max(0, j - 1)], b = st[Math.min(n - 1, j + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    st[j].nx = -tz; st[j].nz = tx;
    // Signed curvature here, for the inside-of-the-bend limit: positive turns
    // toward +n.
    if (j > 0 && j < n - 1) {
      const p = st[j - 1], q = st[j + 1];
      const ax = st[j].x - p.x, az = st[j].z - p.z, bx = q.x - st[j].x, bz = q.z - st[j].z;
      const cross = ax * bz - az * bx;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(q.x - p.x, q.z - p.z);
      const k = la && lb && lc ? (2 * cross) / (la * lb * lc) : 0;
      // n = (-tz, tx) is the left of travel; a left turn has cross > 0.
      st[j].k = k;
    } else st[j].k = 0;
  }
  for (const s of st) {
    const insideCap = (sign) => {
      // Toward the centre of the bend the normals converge at 1/|k|.
      if (s.k === 0 || Math.sign(s.k) !== sign) return WIDE;
      return Math.min(WIDE, (INSIDE / Math.abs(s.k)));
    };
    if (!free(s.x, s.z)) { s.lo = 0; s.hi = 0; continue; }
    let hi = 0;
    const capL = insideCap(1);
    while (hi + DW <= capL && free(s.x + s.nx * (hi + DW), s.z + s.nz * (hi + DW))) hi += DW;
    let lo = 0;
    const capR = insideCap(-1);
    while (-lo + DW <= capR && free(s.x - s.nx * (-lo + DW), s.z - s.nz * (-lo + DW))) lo -= DW;
    s.lo = lo; s.hi = hi;
  }

  // 3. Pins. The car where it is, and a car-length on along its nose.
  const d = new Float64Array(n);
  const off = (s, x, z) => (x - s.x) * s.nx + (z - s.z) * s.nz;
  const clampTo = (s, v) => Math.min(s.hi, Math.max(s.lo, v));
  d[0] = clampTo(st[0], off(st[0], car.position.x, car.position.z));
  const fx = car.position.x + car.forward.x * STEP, fz = car.position.z + car.forward.z * STEP;
  d[1] = clampTo(st[1], off(st[1], fx, fz));

  // 2. Bend it as little as possible. Not the midpoint of the neighbours:
  // that is a string pulled taut, the shortest line, and it bends hard
  // wherever it touches the edge of the room -- a 3-8 m kink at the apex of a
  // corner whose road fillet was 22 m. The minimiser of the summed squared
  // second difference -- curvature -- puts each point at
  // (-p[j-2] + 4 p[j-1] + 4 p[j+1] - p[j+2]) / 6, which spreads the turn over
  // the whole corner instead.
  const bx = new Float64Array(n), bz = new Float64Array(n);
  const nx = new Float64Array(n), nz = new Float64Array(n);
  const lo = new Float64Array(n), hi = new Float64Array(n);
  const px = new Float64Array(n), pz = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const q = st[j];
    bx[j] = q.x; bz[j] = q.z; nx[j] = q.nx; nz[j] = q.nz; lo[j] = q.lo; hi[j] = q.hi;
    px[j] = q.x + q.nx * d[j]; pz[j] = q.z + q.nz * d[j];
  }
  for (let it = 0, nIt = ITER(); it < nIt; it++) {
    for (let j = 2; j < n - 2; j++) {
      const mx = (-px[j - 2] + 4 * px[j - 1] + 4 * px[j + 1] - px[j + 2]) / 6;
      const mz = (-pz[j - 2] + 4 * pz[j - 1] + 4 * pz[j + 1] - pz[j + 2]) / 6;
      let o = (mx - bx[j]) * nx[j] + (mz - bz[j]) * nz[j];
      if (o < lo[j]) o = lo[j]; else if (o > hi[j]) o = hi[j];
      d[j] = o;
      px[j] = bx[j] + nx[j] * o; pz[j] = bz[j] + nz[j] * o;
    }
  }

  if (opts.debug) opts.debug.stations = st.map((q, j) => ({ lo: q.lo, hi: q.hi, d: d[j], k: q.k }));
  const line = [];
  for (let j = 0; j < n; j++) {
    const s = st[j];
    line.push({ x: s.x + s.nx * d[j], z: s.z + s.nz * d[j], speed: s.speed, free: true });
  }
  // The route beyond the planned stretch, from the first point past it.
  const endX = st[n - 1].x, endZ = st[n - 1].z;
  let rest = i + 1;
  while (rest < pts.length && Math.hypot(pts[rest].x - endX, pts[rest].z - endZ) < STEP) rest++;
  return pts.slice(0, k0).concat(line, pts.slice(rest));
}
