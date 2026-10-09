// A helicopter you fly.
//
// Not the one in helicopter.js -- that is the AI's, an autopilot that orbits
// whatever it is told to watch. This is the one a police player gets instead
// of a car, and everything about it is built round one decision: the pilot's
// own eyes are the sensor. There is no searchlight and nothing is detected
// automatically. Seeing the car on your screen does nothing at all; you press
// a key to call it in, and that drops one fix on the ground units' maps which
// then ages exactly like any other last-known position.
//
// That is what keeps it from being a flying wallhack. Height buys you the road
// network and nothing else -- from 300 m you cannot tell which of the traffic
// is the one you want, so a fix means coming down to where the flying is hard
// and the rooftops are in the way.
//
// The flight model is the honest kind rather than the accurate kind. A real
// helicopter is a coupled mess of collective, cyclic, pedals and torque, and
// on a keyboard that is unflyable. Here: the rotor makes a thrust along the
// aircraft's own up, so leaning the aircraft is how you go anywhere, which is
// the one thing about helicopters that really is true and really is intuitive.
// Everything else -- the auto-levelling, the drag, the yaw damping -- exists
// so that the thing can be flown with four keys and a mouse.

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, angleDelta } from '../util/math.js';
import { hasLineOfSight } from '../physics/world.js';

/** Gravity, which the rotor has to beat to go up. */
const G = 9.81;

/**
 * Thrust at full collective, as a multiple of gravity. At 1.0 the aircraft
 * exactly hovers; the margin above that is climb rate and the ability to
 * carry a lean -- a 46 degree bank needs 1.44 times hover thrust just to hold
 * height, which is what sets this rather than the climb does.
 *
 * It started at 1.9 and that was an aircraft with 22 m/s of climb in it, about
 four times the real thing and completely twitchy to fly. The climb is now
 * capped by vertical drag instead, which is the right place for it: full
 * collective is a 10 m/s climb and a cut one is a 15 m/s descent, both roughly
 * what the real machine does.
 */
const THRUST = 1.55;
/** Collective at rest -- a hover, so letting go of everything holds height. */
const HOVER = 1 / THRUST;

/** How fast the collective follows the keys. Rotors have inertia. */
const SPOOL = 2.4;

/** Cyclic: how far it will lean, and how fast it gets there. */
const MAX_PITCH = 0.50;          // radians, ~29 degrees nose down
const MAX_ROLL = 0.80;           // radians, ~46 degrees of bank
const CYCLIC_RATE = 2.6;         // radians a second toward the demanded lean

/**
 * How hard it returns to level with no input. This is the training-wheels
 * number: at 0 it is a free aircraft that will happily sit inverted, and the
 * pilot is flying all four axes constantly. High and it flies itself.
 */
const LEVEL = 1.8;

/** Pedals: yaw rate at full deflection, and how fast it builds. */
const YAW_RATE = 0.85;
const YAW_EASE = 3.2;

/**
 * Air resistance, and the thing that actually sets the performance envelope.
 * Horizontal drag caps the cruise at about 250 km/h -- faster than the fastest
 * car, which it has to be, and not so much faster that the chase stops being
 * one; vertical drag caps the
 * climb at around 10 m/s, which is a far better way to limit it than giving
 * the rotor less thrust, because thrust is also what holds a banked turn up.
 */
const DRAG = 0.13;
const DRAG_UP = 0.55;

/** Translational lift: a helicopter is more efficient with airspeed. */
const LIFT_SPEED = 26;
const LIFT_GAIN = 0.10;

/** Never fly the map's roof or dig a hole. */
const CEILING = 420;

/**
 * Minutes in the air on a full tank, and how long refuelling takes once it is
 * on the ground at the garage.
 */
export const ENDURANCE = 6 * 60;
export const REFUEL_TIME = 12;

/** Ground clearance of the skids, so it lands on them rather than in them. */
const SKID = 1.05;

/**
 * The mark: how close the aircraft has to be to call a car in, how far off the
 * nose it may be, and how long before another one can be sent.
 *
 * This is the whole role, and the range is the whole balance. There is no
 * detection of any kind -- seeing the car on your screen does nothing, and
 * there is no searchlight -- so the only way the ground units learn anything
 * is a pilot deciding they have identified the car and pressing the key.
 *
 * 300 m sounds generous and is not. From a thousand feet you can see half the
 * town and cannot tell one dark hatchback from another, so a mark means
 * descending to where the flying is hard and the rooftops are in the way, and
 * the pilot who sits high and safe is a pilot who reports nothing. That is the
 * trade the role is made of, and it falls out of the range rather than being
 * enforced anywhere.
 */
const MARK_RANGE = 300;
const MARK_CONE = 0.95;          // radians off the nose, a generous windscreen
const MARK_COOLDOWN = 7;

const _v = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class FlyingHelicopter {
  constructor(game, opts = {}) {
    this.game = game;
    this.isPolice = true;
    this.isAircraft = true;
    this.specKey = 'helicopter';

    this.position = new THREE.Vector3(0, 60, 0);
    this.linvel = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    // The renderer draws between the last two steps, the same as a car does.
    this.prevPos = new THREE.Vector3(0, 60, 0);
    this.prevQuat = new THREE.Quaternion();

    /** Attitude. Yaw is heading; pitch and roll are the cyclic. */
    this.yaw = opts.heading || 0;
    this.pitch = 0;
    this.roll = 0;

    this.collective = HOVER;
    this.yawRate = 0;
    this.rotor = 0;
    this.spin = 1;               // rotors at speed, 0 when shut down

    this.fuel = ENDURANCE;
    this.refuelling = 0;
    this.onGround = true;

    /** Seconds until another mark may be sent, and how the last one went. */
    this.markCooldown = 0;
    this.markFlash = 0;
    this.markResult = '';

    /** Set while the aircraft has touched something hard. */
    this.damage = 0;
    this.disabled = false;

    // Duck-typing for the parts of the game that expect a vehicle: the HUD,
    // the camera and the net packer all read these.
    this.forward = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.left = new THREE.Vector3(1, 0, 0);
    this.speed = 0;
    this.forwardSpeed = 0;
    this.steerAngle = 0;
    this.wheels = [];
    this.angvel = new THREE.Vector3();
    // Enough of a car's spec that generic code reading dimensions off the
    // thing it is looking at does not fall over. Nothing uses it to decide
    // anything -- the aircraft has no collider and is not in `vehicles` --
    // but plenty of code reads spec.dims without asking what it is holding.
    this.spec = { dims: { l: 12.4, w: 2.5, h: 3.5 }, mass: 2800, dragArea: 2.0 };

    this._applyAttitude();
  }

  get kmh() { return this.speed * 3.6; }
  /** Metres above the ground directly below, which is what a pilot flies on. */
  get radarAlt() { return this.position.y - this.groundY; }

  get groundY() {
    const h = this.game.sim && this.game.sim.heightAt;
    return (h ? h(this.position.x, this.position.z) : 0) || 0;
  }

  /**
   * One step of flight.
   *
   * `c` is the control set: collective -1..1, pitch -1..1 (positive is nose
   * down, which is how a cyclic works -- push to go), roll -1..1, yaw -1..1.
   */
  update(dt, c) {
    this.prevPos.copy(this.position);
    this.prevQuat.copy(this.quaternion);
    const flying = this.fuel > 0 && !this.disabled;
    this.spin = damp(this.spin, flying ? 1 : 0, 0.8, dt);

    // ---- collective ----
    // Centre is a hover, so hands off holds height. Without that the aircraft
    // sinks whenever the pilot is busy looking at something, which is most of
    // the time in this job.
    const wantColl = clamp(HOVER + (c.collective || 0) * (c.collective > 0 ? 1 - HOVER : HOVER),
      0, 1) * (flying ? 1 : 0);
    this.collective = damp(this.collective, wantColl, SPOOL, dt);

    // ---- cyclic ----
    // The stick asks for a lean and the aircraft moves toward it; letting go
    // asks for level. Both go through the same rate limit, so the recovery is
    // as quick as the input and nothing snaps.
    const wantPitch = clamp(c.pitch || 0, -1, 1) * MAX_PITCH;
    const wantRoll = clamp(c.roll || 0, -1, 1) * MAX_ROLL;
    const rate = CYCLIC_RATE * dt;
    this.pitch += clamp(wantPitch - this.pitch, -rate, rate);
    this.roll += clamp(wantRoll - this.roll, -rate, rate);
    // Self-centring on top, so a released stick comes back to level by itself
    // rather than holding the last lean.
    if (!c.pitch) this.pitch = damp(this.pitch, 0, LEVEL, dt);
    if (!c.roll) this.roll = damp(this.roll, 0, LEVEL, dt);

    // ---- pedals ----
    this.yawRate = damp(this.yawRate, clamp(c.yaw || 0, -1, 1) * YAW_RATE, YAW_EASE, dt);
    this.yaw -= this.yawRate * dt;

    this._applyAttitude();

    // ---- forces ----
    // Thrust along the aircraft's own up. Leaning is therefore the only way to
    // go anywhere, which is the whole feel of flying one of these.
    let thrust = this.collective * THRUST * G;
    // Translational lift: cheaper to fly fast than to hover, as in the real
    // thing. Small, but it makes a dash across town feel different from a
    // hover over a junction.
    const flat = Math.hypot(this.linvel.x, this.linvel.z);
    thrust *= 1 + LIFT_GAIN * clamp01(flat / LIFT_SPEED);

    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.linvel.addScaledVector(_up, thrust * dt);
    this.linvel.y -= G * dt;

    // Drag, lighter on the vertical so a deliberate descent still feels like
    // falling rather than sinking through treacle.
    this.linvel.x *= 1 - DRAG * dt;
    this.linvel.z *= 1 - DRAG * dt;
    this.linvel.y *= 1 - DRAG_UP * dt;

    this.position.addScaledVector(this.linvel, dt);

    // ---- the ground, and the sky ----
    const floor = this.groundY + SKID;
    if (this.position.y <= floor) {
      this.position.y = floor;
      // Arriving hard is a heavy landing. The aircraft is not destructible --
      // being wrecked in the air is not a fun thing to happen to somebody --
      // but it bounces and it is noted.
      const hit = -this.linvel.y;
      if (hit > 6) this.damage = clamp01(this.damage + (hit - 6) / 40);
      this.linvel.y = Math.max(0, this.linvel.y);
      this.linvel.x *= 0.82;
      this.linvel.z *= 0.82;
      this.onGround = true;
      // On the ground it sits level, whatever the stick is doing.
      this.pitch = damp(this.pitch, 0, 6, dt);
      this.roll = damp(this.roll, 0, 6, dt);
      this._applyAttitude();
    } else {
      this.onGround = false;
    }
    if (this.position.y > CEILING) {
      this.position.y = CEILING;
      this.linvel.y = Math.min(0, this.linvel.y);
    }

    // ---- fuel ----
    // Burn is mostly the collective: a hover is expensive, a descent is nearly
    // free. Which gives a pilot a reason to use height as a resource.
    if (flying && !this.onGround) {
      this.fuel = Math.max(0, this.fuel - dt * (0.55 + this.collective * 0.9));
    }
    this._refuel(dt);

    // ---- published state ----
    this.speed = this.linvel.length();
    _fwd.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.forward.copy(_fwd);
    this.up.copy(_up);
    this.left.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.forwardSpeed = this.linvel.dot(_fwd);
    this.angvel.set(0, -this.yawRate, 0);
    this.rotor += dt * 34 * this.spin;

    this.markCooldown = Math.max(0, this.markCooldown - dt);
    this.markFlash = Math.max(0, this.markFlash - dt);
  }

  /**
   * Can this aircraft identify that car from here, right now?
   *
   * Three questions, all of them about the pilot rather than about the game:
   * is it close enough to tell what it is, is it in front of me, and can I
   * actually see it. Nothing here knows whether it is the right car -- that
   * is the pilot's problem, and getting it wrong is how a pilot wastes
   * everybody's time.
   */
  canIdentify(target) {
    if (!target) return false;
    const dx = target.position.x - this.position.x;
    const dz = target.position.z - this.position.z;
    const down = this.position.y - target.position.y;
    // You have to be above it. A helicopter looking up at a car is not a
    // situation that needs supporting.
    if (down < 2) return false;
    const flat = Math.hypot(dx, dz);
    if (Math.hypot(flat, down) > MARK_RANGE) return false;

    // The cone is a bearing, not a direction in space.
    //
    // Measured off the nose in three dimensions, a helicopter hovering
    // directly over the car could not see it -- straight down is ninety
    // degrees off the nose -- which is exactly backwards, since looking down
    // is the entire job. A crew looks out and down through a bubble canopy,
    // so what matters is which way the car is from here on the map, and
    // anything steeply below is in view whichever way the nose happens to
    // point.
    // Steeper than about forty degrees below the horizon is out of the chin
    // and side glass and counts whichever way the nose points; shallower than
    // that is out of the windscreen, and the pilot has to be pointing at it.
    if (flat > down * 1.2) {
      const bearing = Math.atan2(dx, dz);
      if (Math.abs(angleDelta(this.yaw, bearing)) > MARK_CONE) return false;
    }

    const world = this.game.world;
    if (!world) return true;
    _v.copy(this.position);
    return hasLineOfSight(world, _v, target.position, 0.6);
  }

  /**
   * Call it in. Returns what happened, so the HUD can say so: a fix only
   * leaves the aircraft when the pilot could actually see the car.
   */
  mark(target) {
    if (this.markCooldown > 0) return 'wait';
    this.markCooldown = MARK_COOLDOWN;
    this.markFlash = 1.4;
    const ok = this.canIdentify(target);
    this.markResult = ok ? 'sent' : 'nothing';
    return this.markResult;
  }

  /**
   * Sitting on the pad at the garage fills the tank. The same place the cars
   * get repaired, because a second map feature for one role is a second thing
   * to find, and the garage is already somewhere you have to go and be still.
   */
  _refuel(dt) {
    const g = this.game.garage && this.game.garage.marker;
    const near = g && this.onGround
      && Math.hypot(this.position.x - g.x, this.position.z - g.z) < 22;
    if (!near || this.speed > 2) { this.refuelling = 0; return; }
    this.refuelling += dt;
    this.fuel = Math.min(ENDURANCE, this.fuel + dt * (ENDURANCE / REFUEL_TIME));
    this.damage = Math.max(0, this.damage - dt * 0.2);
  }

  _applyAttitude() {
    _e.set(this.pitch, this.yaw, this.roll, 'YXZ');
    this.quaternion.setFromEuler(_e);
  }

  /**
   * The driving controls arrive here when something generic hands them over;
   * the aircraft wants the flying set instead, so this is where they are
   * kept until the next step. See Game._update.
   */
  setControls(c) { this.stick = c; }

  /** Put it somewhere, stopped and level. */
  teleport(at, heading = 0) {
    this.position.set(at.x, at.y, at.z);
    this.prevPos.copy(this.position);
    this.linvel.set(0, 0, 0);
    this.yaw = heading;
    this.pitch = 0;
    this.roll = 0;
    this.collective = HOVER;
    this._applyAttitude();
  }
}
