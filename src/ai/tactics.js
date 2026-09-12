// Pursuit tactics: the PIT manoeuvre and the rolling box.
//
// Neither of these is animated or faked. A PIT is a real car being steered
// into the rear quarter of another real car, and whether the target spins
// depends entirely on the tyre model deciding the rear axle has run out of
// lateral grip. That means a PIT attempted too slowly does nothing, one
// attempted too fast puts both cars into the scenery, and a driver who has
// loaded their outside front tyre can sometimes just drive out of it.

import * as THREE from 'three';
import { clamp, clamp01, lerp, sign } from '../util/math.js';

const _rel = new THREE.Vector3();
const _slot = new THREE.Vector3();

/**
 * Where a chasing unit sits relative to its target, in the target's own frame.
 *   long: +forward of the target, -behind
 *   lat:  +to the target's left
 */
export function relativeTo(target, unit) {
  _rel.copy(unit.position).sub(target.position);
  return {
    long: _rel.dot(target.forward),
    lat: _rel.dot(target.left),
    dist: Math.hypot(_rel.x, _rel.z),
    closing: unit.linvel.dot(target.forward) - target.forwardSpeed,
  };
}

// ---------------------------------------------------------------------- PIT

export const PIT = {
  /** Speeds outside this window either do nothing or kill everyone involved. */
  MIN_SPEED: 7,
  MAX_SPEED: 44,
  /** How far behind the target the striking car must be to have any leverage. */
  STRIKE_LONG_MIN: -4.4,
  STRIKE_LONG_MAX: -1.3,
  STRIKE_LAT_MIN: 1.0,
  STRIKE_LAT_MAX: 2.9,
};

/**
 * Is a PIT worth attempting at all? Checked by the dispatcher before it
 * authorises one, so only a unit that is genuinely in position commits.
 */
export function pitViable(unit, target) {
  if (unit.disabled || target.disabled) return false;
  if (unit.grounded < 3 || target.grounded < 3) return false;
  const sp = Math.abs(target.forwardSpeed);
  if (sp < PIT.MIN_SPEED || sp > PIT.MAX_SPEED) return false;

  // Authorisation happens well before the car is in position -- the setup
  // phase is what closes the gap. Requiring it to already be on the target's
  // rear quarter means a PIT is never ordered at all, because nothing else
  // would ever put it there.
  const r = relativeTo(target, unit);
  if (r.long > 1.0 || r.long < -32) return false;      // behind, and in touch
  if (Math.abs(r.lat) > 9.0) return false;
  // Needs to be able to close: a unit already falling back cannot PIT.
  if (unit.speed < sp - 4.5) return false;
  return true;
}

/**
 * Drives one attempt. Returns { aim, speed, side, phase, done, contact }.
 * The officer feeds `aim` and `speed` straight into its Driver, so the
 * manoeuvre is executed with the same steering and grip limits as any other
 * piece of driving.
 */
export function pitUpdate(state, unit, target, dt) {
  const r = relativeTo(target, unit);
  const targetSpeed = Math.abs(target.forwardSpeed);

  // Choose a side once and stick to it -- swapping mid-attempt is what makes
  // AI look indecisive.
  if (!state.side) {
    state.side = Math.abs(r.lat) > 0.7 ? sign(r.lat) : (unit.id % 2 === 0 ? 1 : -1);
    state.phase = 'setup';
    state.timer = 0;
    state.strikeTime = 0;
  }
  state.timer += dt;

  const side = state.side;
  const aim = new THREE.Vector3();

  // Detect that it worked: the target is rotating far faster than its steering
  // could account for, or it has gone properly sideways.
  const spun = Math.abs(target.yawRate) > 1.7 || Math.abs(target.slipAngleBody) > 0.75;

  if (state.phase === 'setup') {
    // Sit off the target's rear quarter. The aim point is placed a fixed
    // distance ahead of where we currently are rather than directly on the
    // slot: pure pursuit onto a point three metres away produces violent
    // steering, and the unit puts itself into the barrier instead.
    const step = Math.max(9, unit.speed * 0.55);
    const longAim = Math.min(-2.2, r.long + step);
    aim.copy(target.position)
      .addScaledVector(target.left, side * 1.9)
      .addScaledVector(target.forward, longAim);

    const inWindow = r.long > PIT.STRIKE_LONG_MIN - 1.2 && r.long < PIT.STRIKE_LONG_MAX + 0.8
      && Math.abs(r.lat) > PIT.STRIKE_LAT_MIN - 0.4 && Math.abs(r.lat) < PIT.STRIKE_LAT_MAX + 0.6
      && sign(r.lat) === side
      // Must be closing, but not so much faster that the hit is a shunt.
      && (unit.speed - targetSpeed) > -1.5 && (unit.speed - targetSpeed) < 7.5;

    if (inWindow) { state.phase = 'strike'; state.strikeTime = 0; }
    if (state.timer > 12) return { done: true, reason: 'setup-timeout' };

    // Closing speed tapers as the gap shuts, so we arrive alongside rather
    // than punting them from straight behind -- but the approach has to be
    // decisive, or the unit converges asymptotically and never gets there.
    //
    // It was decisive only over the last few metres: a flat 2 m/s of overspeed
    // plus a taper that had not started yet meant a car authorised from thirty
    // metres back spent most of its twelve-second window barely gaining, and
    // the attempt timed out before it ever reached the strike window. The
    // closing rate is now proportional to the gap, the way an ordinary pursuit
    // has always done it -- flat out from a long way back, a nudge from close.
    const gap = Math.max(0, -r.long - 2.2);
    const closeIn = clamp(gap * 0.55, 2.0, 15);
    return {
      aim, speed: targetSpeed + closeIn, side, phase: 'setup', done: false,
      allowHandbrake: false,
    };
  }

  if (state.phase === 'strike') {
    state.strikeTime += dt;
    // Aim through the target's rear axle, on the far side of it. Steering at a
    // point beyond the car is what turns a nudge into a rotation.
    aim.copy(target.position)
      .addScaledVector(target.forward, -1.4)
      .addScaledVector(target.left, -side * 1.6);

    if (spun) return { done: true, reason: 'spun', contact: true };
    if (state.strikeTime > 1.9) { state.phase = 'recover'; state.timer = 0; }

    return {
      aim, speed: targetSpeed + 7.0, side, phase: 'strike', done: false,
      allowHandbrake: false, commit: true,
    };
  }

  // recover: peel away and let the pursuit reform.
  aim.copy(target.position)
    .addScaledVector(target.left, side * 6.5)
    .addScaledVector(target.forward, -8.0);
  if (state.timer > 1.4) return { done: true, reason: 'recovered' };
  return { aim, speed: targetSpeed * 0.9, side, phase: 'recover', done: false };
}

// ----------------------------------------------------------------- box-in

/**
 * Slot layout for a rolling box, in the target's frame.
 * The lead car does the actual work: once the flanks are in place it eases
 * off, and the target either stops or has to push through it.
 */
export const BOX_SLOTS = [
  { name: 'lead',  x: 0.0,  z: +6.6, priority: 0 },
  { name: 'left',  x: +2.9, z: +0.6, priority: 1 },
  { name: 'right', x: -2.9, z: +0.6, priority: 1 },
  { name: 'trail', x: 0.0,  z: -6.2, priority: 2 },
];

/**
 * Assign units to slots, nearest-first, so nobody crosses the target's nose to
 * reach a slot on the far side.
 */
export function assignBoxSlots(target, units) {
  const free = BOX_SLOTS.slice();
  const assignment = new Map();
  const scored = [];

  for (const u of units) {
    const r = relativeTo(target, u.vehicle);
    for (const slot of free) {
      // Cost is distance to the slot plus a penalty for having to swap sides.
      const dx = r.lat - slot.x, dz = r.long - slot.z;
      let cost = Math.hypot(dx, dz);
      if (slot.x !== 0 && sign(slot.x) !== sign(r.lat) && Math.abs(r.lat) > 1.5) cost += 14;
      scored.push({ unit: u, slot, cost });
    }
  }
  scored.sort((a, b) => a.cost - b.cost);

  const usedUnits = new Set();
  const usedSlots = new Set();
  for (const s of scored) {
    if (usedUnits.has(s.unit) || usedSlots.has(s.slot.name)) continue;
    usedUnits.add(s.unit);
    usedSlots.add(s.slot.name);
    assignment.set(s.unit, s.slot);
  }
  return assignment;
}

/**
 * Where a boxing unit should be right now. `tightness` runs 0 -> 1 as the box
 * closes; the flanks come in and the lead slows down.
 */
export function boxAim(target, slot, tightness, out = new THREE.Vector3()) {
  const squeeze = lerp(1.0, 0.72, tightness);
  const lead = slot.name === 'lead' ? lerp(1.0, 0.80, tightness) : 1.0;
  return out.copy(target.position)
    .addScaledVector(target.left, slot.x * squeeze)
    .addScaledVector(target.forward, slot.z * lead);
}

/**
 * Speed a boxing unit should hold: match the target, biased by its slot --
 * plus whatever it takes to actually *get* to the slot.
 *
 * Matching the target's speed is right once you are in position and useless
 * before that. A box is called on units up to forty metres out, and a car
 * asked for the target's speed plus 0.8 m/s closes forty metres in fifty
 * seconds, by which time the box has been dropped for falling apart. So the
 * gap to the slot is worth real closing speed, and it fades to nothing as the
 * car arrives -- which is also what stops the formation pumping back and
 * forth once it is closed.
 */
export function boxSpeed(target, slot, tightness, unit = null) {
  const base = Math.abs(target.forwardSpeed);
  let want = slot.name === 'lead' ? Math.max(0, base * lerp(1.0, 0.80, tightness) - 0.5)
    : slot.name === 'trail' ? base + 1.5
      : base + 0.8;

  if (!unit) return want;

  // The error that speed can actually fix: how much further up the road the
  // slot is than we are. Measured along the *target's* heading, because that
  // is the direction the whole formation is travelling; the sideways part of
  // the gap is the steering's job, not the throttle's.
  //
  // Using the plain distance to the slot instead drives a car that has
  // *overshot* -- the lead car past a target that has stopped -- faster and
  // faster away from it, since going forward makes the distance bigger and
  // the distance was all it was reading. Using the unit's own heading to tell
  // which way the slot lies is no better: a car knocked sideways in the scrum
  // then reads a slot right in front of it as behind, and sits there.
  boxAim(target, slot, tightness, _slot);
  const dx = _slot.x - unit.position.x, dz = _slot.z - unit.position.z;
  const along = dx * target.forward.x + dz * target.forward.z;

  if (along > 1.2) {
    // An approach profile, not a dash: proportional to the error, and capped
    // by the speed the car could still lose over what is left of it. Without
    // the cap a unit six metres short of its slot behind a target that has
    // stopped is told to do nine metres a second, sails past, gives up, comes
    // back and does it again -- three cars circling a stationary player.
    const closing = Math.min(clamp((along - 1.2) * 0.9, 0, 16),
      Math.sqrt(2 * 3.2 * (along - 1.2)));
    want += closing;
    // A target that has stopped is not going anywhere, so the last few metres
    // are taken at a walk. Closing hard on a stationary car means arriving in
    // its wing, being steered away by collision avoidance, and going round for
    // another go: three police cars circling a parked player.
    if (base < 2.0 && along < 12) want = Math.min(want, 3.0);
  } else if (along < -1.2) {
    // Past it. Ease off and let the target come back to us, which is what a
    // real crew does rather than driving round the block.
    want = Math.max(0, Math.min(want, base - clamp(-along * 0.5, 0.5, 6)));
  }
  return want;
}

/** True once the box is closed enough that the target is genuinely trapped. */
export function boxClosed(target, assignment) {
  if (assignment.size < 3) return false;
  let inPlace = 0;
  for (const [unit, slot] of assignment) {
    const r = relativeTo(target, unit.vehicle);
    const dx = r.lat - slot.x, dz = r.long - slot.z;
    if (Math.hypot(dx, dz) < 2.6) inPlace++;
  }
  return inPlace >= 3 && Math.abs(target.forwardSpeed) < 9;
}

export { clamp, clamp01 };
