// Tyre force model.
//
// Everything the car does -- understeer, oversteer, power-on drifts, locking a
// wheel under braking, a handbrake turn -- comes out of this file rather than
// being scripted.
//
// The model is a combined-slip Pacejka. Longitudinal and lateral slip are each
// normalised by the slip at which that direction peaks, combined into a single
// slip vector, and a single magic-formula curve gives the force magnitude. The
// force then acts *against the direction of the slip vector*.
//
// That last point matters more than it sounds. Computing the two directions
// independently and only clipping their sum to a friction circle lets a fully
// locked wheel keep most of its cornering force, because neither component on
// its own exceeds the limit -- and the handbrake stops working. Resolving along
// the combined slip direction means a wheel sliding hard longitudinally has
// almost nothing left to give sideways, which is exactly what a locked tyre
// does in reality.
//
// The second ingredient is load sensitivity: a tyre carrying 6 kN gives less
// than twice the grip of one carrying 3 kN. That single non-linearity is what
// makes weight transfer cost the car net grip, and why lift-off oversteer and
// mid-corner understeer emerge rather than being special-cased.

import { clamp, clamp01, sq } from '../util/math.js';

/**
 * Pacejka curve, normalised to peak at 1.0.
 *   B - stiffness   (how sharply grip builds)
 *   C - shape       (how far past the peak the curve falls away)
 *   E - curvature   (asymmetry around the peak)
 */
export function magicFormula(slip, B, C, E) {
  const Bs = B * slip;
  return Math.sin(C * Math.atan(Bs - E * (Bs - Math.atan(Bs))));
}

const CURVE_E = 0.3;

/**
 * Derive curve coefficients so that the combined curve peaks at exactly
 * normalised slip 1.0, and decays to `slidingFriction` of peak once the tyre
 * is sliding freely. Solved once per tyre and cached.
 */
function combinedCoefficients(slidingFriction) {
  // sin(C * pi/2) = slidingFriction, taking the second-quadrant solution.
  const C = 2 - (2 / Math.PI) * Math.asin(clamp(slidingFriction, 0.05, 0.995));
  const target = Math.tan(Math.PI / (2 * C));
  // Solve (1-E)B + E*atan(B) = target for B by Newton iteration.
  let B = 2;
  for (let i = 0; i < 40; i++) {
    const f = (1 - CURVE_E) * B + CURVE_E * Math.atan(B) - target;
    const df = (1 - CURVE_E) + CURVE_E / (1 + B * B);
    const next = B - f / df;
    if (!isFinite(next) || next <= 0) break;
    B = next;
    if (Math.abs(f) < 1e-10) break;
  }
  return { B, C, E: CURVE_E };
}

export const TYRE_ROAD = {
  name: 'road',
  // Slip at which each direction reaches peak force.
  peakSlipRatio: 0.12,        // dimensionless
  peakSlipAngle: 0.15,        // radians, about 8.6 degrees
  // Peak friction coefficient at the reference load.
  mu: 1.42,
  // Reference vertical load per wheel, N (roughly a quarter of kerb weight).
  Fz0: 4000,
  // How much mu falls off as load rises. 0 = linear tyre, 0.3 = very peaky.
  loadSensitivity: 0.16,
  // Fraction of peak grip still available once fully sliding. Higher makes a
  // slide progressive and catchable; too high and the handbrake stops working.
  slidingFriction: 0.72,
};

export const TYRE_GRASS = {
  ...TYRE_ROAD, name: 'grass', mu: 0.62,
  peakSlipRatio: 0.18, peakSlipAngle: 0.22, slidingFriction: 0.85,
};

/**
 * Pavements, plazas and forecourts. Not as good as the carriageway, so keeping
 * to the road is still worth doing, but nowhere near the cliff that dropping
 * onto grass would be -- clipping a kerb should cost you a little time, not the
 * back of the car.
 */
export const TYRE_PAVED = {
  ...TYRE_ROAD, name: 'paved', mu: 1.12,
  peakSlipRatio: 0.13, peakSlipAngle: 0.16, slidingFriction: 0.78,
};

/**
 * Effective friction coefficient at a given vertical load.
 * Falls off above the reference load, rises slightly below it.
 */
export function loadedMu(tyre, Fz, condition = 1) {
  const ratio = Fz / tyre.Fz0;
  const mu = tyre.mu * (1 - tyre.loadSensitivity * (ratio - 1));
  return Math.max(0.05, mu) * condition;
}

const ZERO = { Fx: 0, Fy: 0, load: 0, saturation: 0, stiffness: 0 };

/**
 * Solve the combined-slip tyre forces for one wheel.
 *
 * @param tyre      one of the TYRE_* constants
 * @param Fz        vertical load in newtons (from the suspension)
 * @param slipRatio longitudinal slip, (omega*r - v) / |v|
 * @param slipAngle lateral slip in radians, atan2(v_lat, |v_long|)
 * @param condition 0..1 multiplier for tyre health
 * @param gripScale global multiplier, used to trim individual cars and axles
 * @param latStiffness multiplier on lateral stiffness: 2 means the tyre
 *          reaches its peak cornering force at half the slip angle, so a car
 *          at the limit sits half as far sideways. Grip is unchanged by it.
 * @returns { Fx, Fy, load, saturation, stiffness }. Fx is positive forwards,
 *          Fy positive to the wheel's left. `saturation` is normalised slip:
 *          1.0 is exactly at the limit.
 */
export function tyreForces(tyre, Fz, slipRatio, slipAngle, condition = 1, gripScale = 1,
  latStiffness = 1) {
  if (Fz <= 1) return ZERO;

  if (!tyre._cc) tyre._cc = combinedCoefficients(tyre.slidingFriction);
  const cc = tyre._cc;

  const mu = loadedMu(tyre, Fz, condition) * gripScale;
  const peak = mu * Fz;

  // Normalised slip in each direction, then combined into one vector.
  const sx = slipRatio / tyre.peakSlipRatio;
  const sy = (Math.tan(slipAngle) * latStiffness) / tyre.peakSlipAngle;
  const s = Math.hypot(sx, sy);

  if (s < 1e-5) {
    return {
      Fx: 0, Fy: 0, load: Fz, saturation: 0,
      stiffness: (peak * cc.B * cc.C) / tyre.peakSlipRatio,
    };
  }

  // One curve for the magnitude; the direction opposes the slip vector.
  const F = peak * magicFormula(s, cc.B, cc.C, cc.E);

  return {
    Fx: F * (sx / s),
    Fy: -F * (sy / s),
    load: Fz,
    saturation: s,
    // Slope of the longitudinal curve at zero slip, in newtons per unit slip
    // ratio. The wheel integrator needs it: this stiffness is enormous next to
    // the inertia of a wheel, and integrating it explicitly makes a free
    // rolling wheel oscillate instead of settling.
    stiffness: (peak * cc.B * cc.C) / tyre.peakSlipRatio,
  };
}

/**
 * Slip ratio with low-speed regularisation.
 *
 * The textbook definition divides by wheel speed, which explodes near
 * standstill. We blend in a floor so a stationary car behaves sanely.
 */
export function slipRatioOf(wheelSurfaceSpeed, groundSpeed) {
  const denom = Math.max(Math.abs(groundSpeed), 2.0);
  return clamp((wheelSurfaceSpeed - groundSpeed) / denom, -4, 4);
}

/** Slip angle with the same low-speed guard. */
export function slipAngleOf(vLat, vLong) {
  const denom = Math.max(Math.abs(vLong), 1.6);
  return Math.atan2(vLat, denom);
}

/**
 * How close this wheel is to letting go, 0..1, from normalised slip.
 * Deliberately reaches 1 only past the limit, so skid marks and smoke appear
 * when the tyre is actually sliding rather than merely working hard.
 */
export function slipIntensity(saturation) {
  return clamp01((saturation - 0.6) / 0.6);
}

/** Convenience for AI: the highest cornering speed a given radius allows. */
export function cornerSpeedLimit(radius, mu = TYRE_ROAD.mu, g = 9.81) {
  if (!isFinite(radius)) return Infinity;
  return Math.sqrt(Math.max(0, mu * g * radius));
}

export { sq };
