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
import {
  hasLineOfSight, sweepBox, addStaticBox, groups, GROUP,
} from '../physics/world.js';

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
const THRUST = 1.75;
/**
 * What the collective settles to with nothing held.
 *
 * Below a hover, which needs 0.57 of it, so a hand off the throttle is a
 * descent. It used to centre exactly on a hover, which meant an aircraft
 * nobody was flying held its height for ever -- push the nose over and cross
 * the whole town without touching the throttle. "Without pressing W it should
 * just start losing power and go into the ground."
 *
 * Not zero, though. At zero there is no thrust at all, and since thrust is
 * the only thing that pushes a helicopter anywhere, releasing the throttle
 * turned it into a brick -- it fell eighty-seven metres and travelled nine.
 * Idling under a hover gives a sink the pilot can still fly, which is what
 * losing power should feel like. A hover is now something held rather than
 * something given, which is the only reason the throttle is interesting.
 */
const IDLE = 0.45;
/** What it takes to hold height, for reference: thrust exactly cancels g. */
const HOVER = 1 / THRUST;

/** How fast the collective follows the keys. Rotors have inertia. */
const SPOOL = 2.4;

/** Cyclic: how far it will lean, and how fast it gets there. */
/**
 * How far it will lean. Generous on purpose -- "I should be able to tilt the
 * helicopter almost 360 degrees" -- so the roll goes past vertical and the
 * pitch to eighty degrees. Thrust is along the aircraft's own up, so an
 * aircraft on its side makes no lift and one on its back makes it downwards,
 * and both of those are the pilot's problem rather than something the flight
 * model forbids.
 */
const MAX_PITCH = 1.40;          // radians, ~80 degrees
const MAX_ROLL = 3.00;           // radians, ~172 degrees -- past inverted
const CYCLIC_RATE = 2.2;         // radians a second toward the demanded lean

/**
 * How hard it returns to level with no input. This is the training-wheels
 * number: at 0 it is a free aircraft that will happily sit inverted, and the
 * pilot is flying all four axes constantly. High and it flies itself.
 */
const LEVEL = 1.1;

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

/**
 * How far the aircraft's origin sits above the ground when it is parked.
 *
 * Nearly nothing, because the model's origin *is* the bottom of its skids --
 * that is what the brief asked for, so that the game could stand it on the
 * ground without being told. Holding it a metre up meant it hovered over its
 * own pad looking like it had forgotten to land.
 */
export const SKID = 0.04;

/**
 * What the aircraft collides with buildings as.
 *
 * Not the rotor disc, which is the tempting answer -- a real helicopter hits
 * things with its blades long before its body, and 6.2 m is what the disc
 * measures. Tried that first and it is unflyable: a twelve-metre plate in a
 * city of towers is inside something most of the time, and a shape that
 * starts a sweep already touching reports nowhere to go in any direction, so
 * the aircraft wedged in mid-air and could not climb off or back out.
 *
 * So: a bit more than the fuselage. It stops you at the face of a building,
 * which is the thing that was wrong, and it lets you fly down a street.
 */
const HULL_R = 2.2;

/**
 * What the aircraft sweeps against: buildings and props, and deliberately not
 * the terrain.
 *
 * Props because "you can go through buildings and trees" -- RAY_SOLID is
 * terrain and buildings, which is right for a car deciding what to brake for
 * and wrong for an aircraft, since a tree is twenty metres of solid timber.
 *
 * Not the terrain, because the ground is already handled, properly, by the
 * floor below -- and sweeping it as well broke landing entirely. The swept
 * box is a metre tall, so it touches the ground half a metre before the
 * aircraft's own origin gets there; the machine then hung 47 cm up, never
 * satisfied the floor test, never counted as landed, and so never shut down,
 * refuelled or recovered from a crash.
 */
const AIR_SOLID = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP);
/**
 * Into something this fast and the rotor is gone. 14 m/s is about 50 km/h --
 * survivable in a car, and not something a helicopter walks away from.
 */
const CRASH_SPEED = 14;
/** Seconds of holding W before a shut-down rotor has lift in it. */
const START_TIME = 2.6;
/** Seconds on the ground before a wrecked aircraft is back on the pad. */
const RECOVER_TIME = 10;

/** How far short of a surface to stop, so the next sweep is not already touching. */
const CONTACT_GAP = 0.15;
const AXES = ['x', 'y', 'z'];

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
export const MARK_RANGE = 300;
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

    /** Shut down on the ground. W starts it -- see _touchDown and _startUp. */
    this.engineOff = true;
    this.starting = 0;

    /**
     * Which way each axis is up against something, as a sign. See _moveAndHit:
     * it is what tells "cannot push further into this wall" apart from
     * "cannot move along this axis at all".
     */
    this._blocked = { x: 0, y: 0, z: 0 };
    /** The static box that exists only while it is on the ground. */
    this._parked = null;

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
  /**
   * The dial's inner ring, which on a car is the rev counter. A rotor turns
   * at one speed whatever else is happening, so what is worth showing there
   * is how much of it is being asked for.
   */
  get rpmFraction() { return clamp01(this.collective); }
  /** Metres above the ground directly below, which is what a pilot flies on. */
  get radarAlt() { return this.position.y - this.groundY; }

  get groundY() {
    const h = this.game.sim && this.game.sim.heightAt;
    const ground = (h ? h(this.position.x, this.position.z) : 0) || 0;
    // The workshop roof at the garage is a landing surface, not scenery. The
    // aircraft is not a rigid body -- it lands by asking how high the ground
    // is beneath it -- so a pad is simply a disc where the answer is higher.
    const pad = this.onPad();
    return pad ? Math.max(ground, pad.y) : ground;
  }

  /** The landing pad, if the aircraft is over it. */
  onPad() {
    const g = this.game.garage;
    const pad = g && g.helipad;
    if (!pad) return null;
    const dx = this.position.x - pad.x, dz = this.position.z - pad.z;
    return dx * dx + dz * dz <= pad.r * pad.r ? pad : null;
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
    // The rotor follows the engine rather than the throttle: it winds down
    // when the aircraft shuts down on the ground, and up again on a start.
    this.spin = damp(this.spin, flying && !this.engineOff ? 1 : 0, 0.8, dt);

    // ---- collective ----
    // Centre is a hover, so hands off holds height. Without that the aircraft
    // sinks whenever the pilot is busy looking at something, which is most of
    // the time in this job.
    // The lever runs from nothing to everything with idle in the middle: W
    // takes it up from idle to full, S takes it down from idle to nothing.
    // Clamping to idle instead meant S did nothing at all and the aircraft
    // could not be made to come down in a hurry.
    const ask = clamp(c.collective || 0, -1, 1);
    this._startUp(dt, ask);
    const wantColl = ask >= 0 ? IDLE + ask * (1 - IDLE) : IDLE * (1 + ask);
    const live = flying && !this.engineOff;
    this.collective = damp(this.collective, live ? wantColl : 0, SPOOL, dt);

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
    // A swings the nose left. The model's nose is +Z and its left is +X, so
    // left is a rising yaw -- it was falling, and the pedals were handed.
    this.yaw += this.yawRate * dt;

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

    this._moveAndHit(dt);

    // ---- the ground, and the sky ----
    const floor = this.groundY + SKID;
    if (this.position.y <= floor) {
      this.position.y = floor;
      this._struck(-this.linvel.y);
      this.linvel.y = Math.max(0, this.linvel.y);

      // Skids are not wheels, and a shut-down helicopter is not going
      // anywhere at all. It stays exactly where it is until the rotor is
      // turning hard enough to pick it up; leaning the stick used to taxi it
      // across the forecourt like a hovercraft.
      const lifting = this.collective * THRUST * Math.cos(this.pitch) * Math.cos(this.roll);
      if (this.engineOff || lifting <= 1.0) {
        this.linvel.x = 0;
        this.linvel.z = 0;
        this.linvel.y = Math.min(this.linvel.y, 0);
      } else {
        this.linvel.x *= 0.82;
        this.linvel.z *= 0.82;
      }
      // The stick still works on the ground -- "you should be able to roll
      // and pitch when you're on the ground" -- so the attitude is left
      // alone. It is the height that is held, not the angle: the body cannot
      // go below the skids however far it is tipped, and the rotor is welcome
      // to swing through the ground, which is what it would really do.
      if (!this.onGround) this._touchDown();
      this.onGround = true;
    } else {
      this.onGround = false;
    }
    this._parkedCollider();
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
    this._recover(dt);

    // ---- published state ----
    this.speed = this.linvel.length();
    _fwd.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.forward.copy(_fwd);
    this.up.copy(_up);
    this.left.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.forwardSpeed = this.linvel.dot(_fwd);
    this.angvel.set(0, this.yawRate, 0);
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
   * Move, and do not go through buildings.
   *
   * "You can fly through buildings." You could: the aircraft is not a rigid
   * body, so nothing in the physics world was ever going to stop it, and the
   * only solid thing it knew about was the ground under it.
   *
   * It is not given a collider even now -- a dynamic body with a rotor is a
   * different and much worse problem -- but it does sweep its own rotor disc
   * along the step it is about to take. Hitting something stops the part of
   * the motion going into it and keeps the part going along it, so a clumsy
   * approach scrapes down a wall rather than stopping dead, and costs a
   * little damage rather than ending the sortie.
   *
   * The disc, not the fuselage: the rotor is the widest part of a helicopter
   * by a factor of five and is the thing that actually hits the building.
   */
  _moveAndHit(dt) {
    const world = this.game.world;
    if (!world) { this.position.addScaledVector(this.linvel, dt); return; }

    // One axis at a time, which is what lets a pilot get out again.
    //
    // The first version swept along the direction of travel and, on contact,
    // took the whole velocity along that direction away -- which is not a
    // slide, it is a full stop, and since the direction of travel is by
    // definition the direction of the velocity it removed all of it. Every
    // frame. An aircraft that so much as brushed a wall was pinned against it
    // for good: it could not climb off, could not back away, and did not say
    // why. Separating the axes means a wall takes away the component going
    // into it and leaves the two that are not, so the aircraft slides along
    // the face and can always fly back out the way it came.
    for (const axis of AXES) {
      const move = this.linvel[axis] * dt;
      const dist = Math.abs(move);
      if (dist < 1e-6) continue;
      const sign = move < 0 ? -1 : 1;

      // Backing off whatever stopped us is always allowed, and is the whole
      // reason the blocked direction is remembered: refuse everything while
      // touching and the aircraft is welded to the wall for the rest of the
      // game, which is worse than flying through it.
      if (this._blocked[axis] && this._blocked[axis] !== sign) {
        this.position[axis] += move;
        this._blocked[axis] = 0;
        continue;
      }

      _v.set(0, 0, 0);
      _v[axis] = sign;
      // Excluding its own parked collider, or the box that lets cars hit a
      // landed helicopter would also stop that helicopter taking off.
      const toi = sweepBox(
        world, this.position, _v, dist + CONTACT_GAP, AIR_SOLID, this._parked, HULL_R,
      );
      // Room to move, keeping the gap. Swept a little further than the step
      // so that resting against something is seen as no room rather than as
      // a clear step: at a hundredth of a metre a frame, every step fits
      // inside the gap, and an aircraft stopped dead against a wall crept
      // through it two millimetres at a time while reporting itself clear.
      const room = Math.max(0, toi - CONTACT_GAP);
      // The epsilon is not decoration. With a clear way ahead the sweep
      // returns exactly the distance it was given, so room works out as dist
      // minus a rounding error -- and an aircraft that is blocked by its own
      // floating point stops dead in open air five metres from where it set
      // off, with every axis pinned.
      if (room >= dist - 1e-6) {
        this.position[axis] += move;
        this._blocked[axis] = 0;
        continue;
      }

      this.position[axis] += sign * room;
      this._blocked[axis] = sign;
      this._struck(Math.abs(this.linvel[axis]));
      this.linvel[axis] = 0;
    }
  }

  /**
   * Down. The rotor winds off, and that is the end of the sortie until the
   * pilot starts it again.
   *
   * Landing used to be a soft thing that happened to you: the aircraft sank
   * onto its skids and stayed live, so there was no moment of having arrived
   * and no act of leaving. Shutting down on touchdown gives both -- "you
   * almost hit the ground and then your rotors just turn off, and you press
   * W to start them".
   */
  _touchDown() {
    this.engineOff = true;
    this.collective = 0;
    this.linvel.set(0, 0, 0);
  }

  /**
   * Spinning up. W starts it, and the rotor takes a few seconds to come up to
   * speed before there is lift in it, which is what makes a take-off a
   * take-off rather than a jump.
   */
  _startUp(dt, asked) {
    if (!this.engineOff) return;
    if (asked <= 0) { this.starting = 0; return; }
    this.starting = (this.starting || 0) + dt;
    if (this.starting >= START_TIME) {
      this.engineOff = false;
      this.starting = 0;
    }
  }

  /**
   * A parked helicopter is something you can run into.
   *
   * In the air it has no collider at all -- it is not a rigid body, and cars
   * are not going to meet it up there. On the ground it is a large object
   * sitting in the world, and driving through it was wrong: "police cars
   * can't hit it when it's on the ground". So while it is down, and only
   * while it is down, there is a static box where it is.
   *
   * Static rather than dynamic on purpose. A two-tonne airframe on its skids
   * does not get shunted across the forecourt by a patrol car, and a dynamic
   * body would also need the aircraft to be driven by the solver rather than
   * by its own flight model.
   */
  _parkedCollider() {
    const world = this.game.world;
    if (!world) return;
    const want = this.onGround;
    if (want === !!this._parked) {
      // Still down in the same place: nothing to do. It cannot taxi.
      return;
    }
    if (!want) {
      if (this._parked) { world.removeRigidBody(this._parked); this._parked = null; }
      return;
    }
    const d = this.spec.dims;
    this._parked = addStaticBox(
      world, this.position.x, this.position.y + d.h * 0.45, this.position.z,
      d.w * 0.5, d.h * 0.45, d.l * 0.5, GROUP.BUILDING, this.yaw,
    );
  }

  /**
   * Hitting something, and what it costs.
   *
   * Brushing a wall at walking pace is a scrape and nothing more. Flying into
   * one is not: a helicopter that puts its rotor into a building stops being
   * an aircraft, and "you just hit a building and nothing happens" was fair.
   * Past CRASH_SPEED the rotor is gone -- no thrust, no control, and the
   * ground arrives on its own.
   *
   * Which is survivable in the sense that matters: the pilot is out of the
   * chase, not out of the game. It picks itself up on the pad.
   */
  _struck(into) {
    if (into < 5) return;
    this.hitAt = performance.now();
    this.damage = clamp01(this.damage + (into - 5) / 55);
    if (into >= CRASH_SPEED || this.damage >= 1) this.wreck();
  }

  /**
   * Rotor off, controls dead, and down. Everything else keeps working -- the
   * aircraft still falls, still collides, still hits the ground -- because a
   * wreck that freezes in mid-air is worse than no wreck at all.
   */
  wreck() {
    if (this.disabled) return;
    this.disabled = true;
    this.damage = 1;
    this.wreckedAt = performance.now();
    // A dead rotor still turns, slowing, on the way down.
    this.spin = Math.max(this.spin, 0.9);
    if (this.game.hud) this.game.hud.toast('AIRCRAFT DOWN');
  }

  /**
   * Back on the pad, flyable again, after a wait. Being wrecked should cost
   * the sortie and not the evening.
   */
  _recover(dt) {
    if (!this.disabled) return;
    if (!this.onGround) return;
    this.downFor = (this.downFor || 0) + dt;
    if (this.downFor < RECOVER_TIME) return;
    this.downFor = 0;
    this.disabled = false;
    this.damage = 0;
    this.linvel.set(0, 0, 0);
    const pad = this.game.garage && this.game.garage.helipad;
    if (pad) this.teleport({ x: pad.x, y: pad.y + SKID, z: pad.z }, this.yaw);
    if (this.game.hud) this.game.hud.toast('AIR SUPPORT BACK UP');
  }

  /**
   * Sitting on the pad fills the tank. It is on the workshop roof at the
   * garage -- the same place the cars get mended, because a second map
   * feature for one role is a second thing to find, and the garage is already
   * somewhere you have to go and be still.
   */
  _refuel(dt) {
    const near = this.onGround && this.onPad();
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

  /**
   * The rest of what the game calls on whatever it is holding as "the player".
   *
   * An aircraft is not a car, but it is handed to the same code that places a
   * police player, recovers one that has fallen out of the world and patches
   * one up, and a missing method there is not a graceful degradation -- it is
   * an exception inside the frame loop, every frame. Which is exactly what it
   * was: joining a game as the pilot threw out of _netPlaceNearSuspect on the
   * pilot's own machine and nowhere else, so the helicopter flew perfectly on
   * every screen except the one flying it.
   */
  repair() {
    this.damage = 0;
    this.disabled = false;
    this.fuel = Math.max(this.fuel, ENDURANCE * 0.5);
  }

  setVelocity(v) {
    this.linvel.set(v.x || 0, v.y || 0, v.z || 0);
  }

  /** Nothing to read: this aircraft is its own state, not a rigid body's. */
  _readState() {}

  /** Put it somewhere, stopped and level. */
  teleport(at, heading = 0) {
    if (this._parked && this.game.world) {
      this.game.world.removeRigidBody(this._parked);
      this._parked = null;
    }
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
