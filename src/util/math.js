// Small numeric helpers shared across the sim. Kept free of THREE imports so
// the physics layer can stay renderer-agnostic.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const sq = (v) => v * v;

/** Smoothstep between two edges. */
export function smoothstep(edge0, edge1, x) {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. `rate` is roughly "per second". */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Move `current` toward `target` at no more than `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + sign(d) * maxDelta;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed angular difference from `a` to `b`. */
export const angleDelta = (a, b) => wrapAngle(b - a);

/** Deterministic 32-bit PRNG, so the same seed always builds the same city. */
export function makeRng(seed = 1337) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return function rng() {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/** Random float in [a, b). */
export const rand = (rng, a, b) => a + rng() * (b - a);
/** Random integer in [a, b]. */
export const randInt = (rng, a, b) => Math.floor(a + rng() * (b - a + 1));
/** Pick a random element. */
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

/** 2D helpers -- the AI reasons on the ground plane, where x/z is enough. */
export const dist2 = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);
export const distSq2 = (ax, az, bx, bz) => sq(bx - ax) + sq(bz - az);

/**
 * Closest point on segment AB to point P, on the XZ plane.
 * Returns { x, z, t, dist } where t is the normalised position along the segment.
 */
export function closestOnSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = clamp01(t);
  const x = ax + dx * t, z = az + dz * t;
  return { x, z, t, dist: Math.hypot(px - x, pz - z) };
}

/**
 * Radius of the circle through three points -- used by the AI speed planner to
 * work out how fast it can take an upcoming corner. Returns Infinity if the
 * points are collinear.
 */
export function curveRadius(ax, az, bx, bz, cx, cz) {
  const a = dist2(ax, az, bx, bz);
  const b = dist2(bx, bz, cx, cz);
  const c = dist2(cx, cz, ax, az);
  const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) * 0.5;
  if (area < 1e-4) return Infinity;
  return (a * b * c) / (4 * area);
}

/** Format metres/second as km/h. */
export const toKmh = (ms) => ms * 3.6;

/**
 * Format metres/second as mph -- what the car in front of you is doing, in the
 * units the road signs it is passing are written in. The speedometer and the
 * radio both read in these; the physics is metres and seconds throughout.
 */
export const toMph = (ms) => ms * 2.2369363;
