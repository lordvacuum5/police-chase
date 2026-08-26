// Raycast vehicle simulation.
//
// The chassis is a single Rapier rigid body. Each wheel is a downward ray from
// a suspension mount; the spring/damper it finds supplies the vertical load,
// and that load feeds the tyre model in tyre.js. Nothing about the car's
// behaviour is scripted -- body roll comes from four springs at four corners,
// weight transfer comes from the resulting load changes, and understeer or
// oversteer comes from load-sensitive grip on the front or rear axle.
//
// Every car in the game, player and police alike, runs this exact code. The
// police have no grip advantage: when an officer botches a PIT manoeuvre they
// spin out for the same reasons you would.

import * as THREE from 'three';
import { RAPIER, GROUP, groups, raycast, RAY_GROUNDS } from './world.js';
import {
  tyreForces, slipRatioOf, slipAngleOf, slipIntensity, loadedMu,
  TYRE_ROAD, TYRE_GRASS, TYRE_PAVED,
} from './tyre.js';
import { clamp, clamp01, lerp, damp, sign, moveTowards, smoothstep, TAU } from '../util/math.js';

/** Indices match the surface grid built in world/citygen.js. */
const SURFACE_TYRES = [TYRE_GRASS, TYRE_ROAD, TYRE_PAVED];

// Scratch vectors. Allocating inside the substep loop would thrash the GC at
// 120 Hz across twenty cars, which shows up immediately as frame stutter.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _wl = new THREE.Vector3();
const _qs = new THREE.Quaternion();

const AXIS_F = new THREE.Vector3(0, 0, 1);
const AXIS_U = new THREE.Vector3(0, 1, 0);
const AXIS_L = new THREE.Vector3(1, 0, 0);

/** Linear interpolation over a [rpm, torque] table. */
function torqueAt(curve, rpm) {
  if (rpm <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (rpm >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [r1, t1] = curve[i];
    if (rpm <= r1) {
      const [r0, t0] = curve[i - 1];
      return lerp(t0, t1, (rpm - r0) / (r1 - r0));
    }
  }
  return last[1];
}

/**
 * Ackermann steering geometry: on a turn the inner wheel must trace a tighter
 * arc than the outer one, or it scrubs. Returns [leftAngle, rightAngle].
 * Positive `delta` is a left turn.
 */
function ackermann(delta, wheelbase, track) {
  const a = Math.abs(delta);
  if (a < 1e-4) return [delta, delta];
  const R = wheelbase / Math.tan(a);
  const inner = Math.atan(wheelbase / Math.max(0.6, R - track * 0.5));
  const outer = Math.atan(wheelbase / (R + track * 0.5));
  return delta > 0 ? [inner, outer] : [-outer, -inner];
}

export class Vehicle {
  /**
   * @param sim  { world, surfaceAt(x,z) }
   * @param spec vehicle definition from game/vehicles.js
   */
  constructor(sim, spec, { position = { x: 0, y: 1, z: 0 }, heading = 0, id = 0 } = {}) {
    this.sim = sim;
    this.world = sim.world;
    this.spec = spec;
    this.id = id;

    // ---- control inputs, 0..1 except steer which is -1..1 ----
    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0, clutchKick: false };

    // ---- drivetrain state ----
    this.gear = 1;            // -1 reverse, 0 neutral, 1..n forward
    this.rpm = spec.engine.idleRpm;
    this.clutch = 1;          // 0 disengaged .. 1 fully engaged
    this.shiftTimer = 0;
    this.shiftLock = 0;
    this.kickTimer = 0;
    this.reverseHold = 0;
    this.forwardHold = 0;
    this.steerAngle = 0;      // current road-wheel angle, radians, + = left
    this.steerLimit = spec.steering.maxAngle;

    // Rubber-band assistance, driven from outside. Police units run with this
    // while they are closing from a distance and lose it entirely once they
    // are on top of the target, so the decisive part of a chase is fought on
    // equal terms.
    //   boost     multiplies engine torque and divides drag -> higher top speed
    //   grip      multiplies tyre grip
    //   stability 0..1, how hard the car resists getting out of shape
    //   shielded  true while a unit is still on its way -- a crash en route
    //             should cost it time, not put it out of the chase entirely
    this.assist = { boost: 1, grip: 1, stability: 0, shielded: false };

    // ---- condition ----
    this.damage = 0;          // 0 pristine .. 1 wrecked
    this.disabled = false;
    this.flippedFor = 0;

    // ---- telemetry read by the camera, HUD, AI and effects ----
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.linvel = new THREE.Vector3();
    this.angvel = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.left = new THREE.Vector3(1, 0, 0);
    this.speed = 0;           // m/s, magnitude
    this.forwardSpeed = 0;    // m/s along the nose, signed
    this.lateralSpeed = 0;
    this.slipAngleBody = 0;   // chassis slip angle -- how sideways the car is
    this.yawRate = 0;
    this.grounded = 0;        // number of wheels touching
    this.airborne = false;
    this.maxSlip = 0;         // worst wheel, drives smoke and skid marks

    this._prevVel = new THREE.Vector3();

    this._buildBody(position, heading);
    this._buildWheels();

    // Populate the transform immediately. Otherwise everything reads (0,0,0)
    // until the first physics step, and an officer spawned this frame plans
    // its first route from the middle of the map.
    this._readState();
    this._prevVel.copy(this.linvel);
  }

  /**
   * Set the body velocity without it being mistaken for a collision.
   * postStep infers impacts from sudden velocity changes, so anything that
   * moves the car by fiat has to keep the reference in step.
   */
  setVelocity(v) {
    this.body.setLinvel(v, true);
    this._prevVel.set(v.x, v.y, v.z);
    this.linvel.copy(this._prevVel);
    // Spin the wheels up to match. Leaving them stopped under a car doing
    // 80 km/h is a full-lock braking event as far as the tyre model is
    // concerned, and the car sheds speed the instant it appears.
    const along = this._prevVel.dot(this.forward);
    for (const w of this.wheels) w.omega = along / w.radius;
  }

  // ------------------------------------------------------------------ setup

  _buildBody(position, heading) {
    const s = this.spec;
    const { w, h, l } = s.dims;

    const half = heading * 0.5;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) })
      .setLinearDamping(0.02)
      .setAngularDamping(0.15)
      .setCanSleep(false);

    // The body origin IS the centre of mass, so wheel offsets are measured
    // from it directly and the static axle loads come out right by construction.
    const m = s.mass;
    const inertia = {
      x: (m / 12) * (h * h + l * l) * ((s.inertiaScale && s.inertiaScale.pitch) || 1),
      y: (m / 12) * (w * w + l * l) * ((s.inertiaScale && s.inertiaScale.yaw) || 1),
      z: (m / 12) * (w * w + h * h) * ((s.inertiaScale && s.inertiaScale.roll) || 1),
    };
    desc.setAdditionalMassProperties(
      m,
      { x: 0, y: 0, z: 0 },
      inertia,
      { x: 0, y: 0, z: 0, w: 1 },
    );

    this.body = this.world.createRigidBody(desc);

    const colDesc = RAPIER.ColliderDesc
      .cuboid(w * 0.5, h * 0.5, l * 0.5)
      .setTranslation(0, s.colliderY === undefined ? 0.1 : s.colliderY, 0)
      .setDensity(0)                 // mass comes from setAdditionalMassProperties
      .setFriction(0.35)
      .setRestitution(0.12)
      .setCollisionGroups(groups(GROUP.VEHICLE, 0xFFFF));

    this.collider = this.world.createCollider(colDesc, this.body);
    this.collider.__vehicle = this;
  }

  _buildWheels() {
    const s = this.spec;
    // Distance from the centre of mass to each axle, derived from the front
    // weight distribution so the static loads match the spec.
    const a = s.wheelbase * (1 - s.frontWeight);   // CoM -> front axle
    const b = s.wheelbase * s.frontWeight;         // CoM -> rear axle
    const tf = s.trackFront * 0.5;
    const tr = s.trackRear * 0.5;
    const my = s.suspension.mountY;

    // +X is the car's left, +Z is forward.
    const layout = [
      { name: 'FL', pos: new THREE.Vector3(+tf, my, +a), front: true,  side: +1 },
      { name: 'FR', pos: new THREE.Vector3(-tf, my, +a), front: true,  side: -1 },
      { name: 'RL', pos: new THREE.Vector3(+tr, my, -b), front: false, side: +1 },
      { name: 'RR', pos: new THREE.Vector3(-tr, my, -b), front: false, side: -1 },
    ];

    this.wheels = layout.map((cfg) => Object.assign({}, cfg, {
      radius: s.wheelRadius,
      omega: 0,               // spin rate, rad/s
      spin: 0,                // accumulated angle, for rendering
      steer: 0,
      compression: s.suspension.rest * 0.25,
      prevCompression: s.suspension.rest * 0.25,
      grounded: false,
      load: 0,
      slipRatio: 0,
      slipAngle: 0,
      slip: 0,
      condition: 1,           // 1 healthy, 0 shredded (spike strips reduce this)
      surface: 1,
      arb: 0,
      absTrim: 1,             // anti-lock torque trim, integrated on slip error
      contact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      worldPos: new THREE.Vector3(),
      Fx: 0,
      Fy: 0,
    }));

    this.drivenWheels = s.drive === 'fwd' ? [0, 1] : s.drive === 'awd' ? [0, 1, 2, 3] : [2, 3];
  }

  // ------------------------------------------------------------------ input

  /**
   * The pedal that makes the car go, whichever direction it is pointing.
   * In reverse the two swap, so holding the brake reverses and tapping the
   * throttle brings you back to a stop and then to first.
   */
  get accelInput() { return this.gear === -1 ? this.controls.brake : this.controls.throttle; }
  get brakeInput() { return this.gear === -1 ? this.controls.throttle : this.controls.brake; }

  setControls(c) {
    const t = this.controls;
    t.throttle = clamp01(c.throttle || 0);
    t.brake = clamp01(c.brake || 0);
    t.steer = clamp(c.steer || 0, -1, 1);
    t.handbrake = clamp01(c.handbrake || 0);
    t.clutchKick = !!c.clutchKick;
  }

  // -------------------------------------------------------------- main step

  /** Called once per physics substep, before world.step(). */
  prepare(dt) {
    this._readState();
    this._updateSteering(dt);

    const driveTorque = this._updateDrivetrain(dt);

    this.body.resetForces(false);
    this.body.resetTorques(false);

    this._suspensionPass(dt);
    this._antiRollPass();
    this._tyrePass(dt, driveTorque);
    this._aeroPass();
  }

  /** Called once per physics substep, after world.step(). */
  postStep(dt) {
    const lv = this.body.linvel();
    _v1.set(lv.x, lv.y, lv.z);
    // A large velocity change in a single substep can only be a collision.
    const dv = _v1.distanceTo(this._prevVel);
    if (dv > 1.4) {
      // Police cars are built to be shunted; `durability` divides the damage
      // so a patrol car survives several hits that would end the player's run.
      // A shielded unit -- one still making its way to the chase -- records the
      // impact for sound and camera but takes none of the damage.
      if (!this.assist.shielded) {
        this.damage = clamp01(this.damage + ((dv - 1.4) * 0.055) / (this.spec.durability || 1));
      }
      this.lastImpact = dv;
      this.lastImpactAt = performance.now();
    }
    this._prevVel.copy(_v1);

    if (this.up.y < 0.25) this.flippedFor += dt;
    else this.flippedFor = 0;

    if (this.damage >= 0.92) this.disabled = true;
  }

  _readState() {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();

    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.linvel.set(lv.x, lv.y, lv.z);
    this.angvel.set(av.x, av.y, av.z);

    this.forward.copy(AXIS_F).applyQuaternion(this.quaternion);
    this.up.copy(AXIS_U).applyQuaternion(this.quaternion);
    this.left.copy(AXIS_L).applyQuaternion(this.quaternion);

    this.speed = this.linvel.length();
    this.forwardSpeed = this.linvel.dot(this.forward);
    this.lateralSpeed = this.linvel.dot(this.left);
    this.yawRate = this.angvel.y;

    // How sideways the whole car is travelling. Above ~0.25 rad it is drifting.
    this.slipAngleBody = this.speed > 1.5
      ? Math.atan2(this.lateralSpeed, Math.abs(this.forwardSpeed))
      : 0;
  }

  _updateSteering(dt) {
    const st = this.spec.steering;

    // Available lock is set by what the tyres could actually use at this speed:
    // the Ackermann angle for the target lateral acceleration, with a little
    // headroom so the car can still be provoked past the limit.
    // The geometric (Ackermann) angle for the target lateral acceleration, plus
    // an allowance for front tyre slip. Real steady-state cornering needs
    // delta = L/R + (alpha_front - alpha_rear); leaving that term out makes the
    // limit far too tight and the car simply will not turn into a corner.
    const v2 = Math.max(this.speed * this.speed, 1);
    const gripLimit = Math.atan((this.spec.wheelbase * st.latLimit) / v2) * st.overshoot
      + st.slipAllowance;

    // ...but never less than enough lock to point the front wheels along the
    // direction of travel. Without this floor you could not catch a slide at
    // speed, because the limiter would have taken away the opposite lock you
    // need to catch it with.
    // Deliberately not added to the floor below -- stacking the two lets a
    // degree or two of slip quietly hand back lock at motorway speed, which
    // feeds straight back into more slip.
    const counter = Math.abs(this.slipAngleBody) * 1.1;
    const limit = clamp(Math.max(gripLimit, counter, st.minAngle), st.minAngle, st.maxAngle);
    // Published so the AI can scale its commands to the lock actually on offer
    // rather than to the absolute maximum.
    this.steerLimit = limit;

    const target = this.controls.steer * limit;

    // The rack takes real time to move. Slamming to full lock inside a couple
    // of frames drives the front slip angle far past its peak and scrubs the
    // tyres, which reads as the car skating rather than turning.
    //
    // Unwinding is a different motion, though: coming back toward centre, or
    // swapping to opposite lock to catch a slide, is fast and deliberate. Rate
    // limiting that as hard as winding lock on would make slides uncatchable.
    const winding = st.rate * lerp(1, 0.6, smoothstep(0, 40, this.speed));
    const unwinding = target * this.steerAngle <= 0
      || Math.abs(target) < Math.abs(this.steerAngle);
    this.steerAngle = moveTowards(
      this.steerAngle, target, (unwinding ? st.returnRate : winding) * dt,
    );

    const pair = ackermann(this.steerAngle, this.spec.wheelbase, this.spec.trackFront);
    this.wheels[0].steer = pair[0];
    this.wheels[1].steer = pair[1];
  }

  _updateDrivetrain(dt) {
    const s = this.spec;
    const eng = s.engine;
    const c = this.controls;

    // --- clutch kick: dump the clutch to spike rear slip and start a drift ---
    if (c.clutchKick) {
      this.clutch = 0;
      this.kickTimer = 0.22;
    } else if (this.kickTimer > 0) {
      this.kickTimer -= dt;
      this.clutch = Math.min(1, this.clutch + dt * 9);
    }

    // --- gear selection ---
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      this.clutch = 0;
      if (this.shiftTimer <= 0) this.clutch = 0.15;
    } else if (this.kickTimer <= 0) {
      this.clutch = Math.min(1, this.clutch + dt * 6);
    }

    // Two pedals have to cover three jobs, so the brake doubles as reverse once
    // the car has actually stopped. The hold timers stop a car that merely
    // braked to a standstill from immediately setting off backwards.
    const topGear = s.gears.length - 1;
    if (this.gear >= 0) {
      if (c.brake > 0.5 && this.forwardSpeed < 0.6) this.reverseHold += dt;
      else this.reverseHold = 0;
      if (this.reverseHold > 0.35) { this.gear = -1; this.reverseHold = 0; }
    } else {
      if (c.throttle > 0.5 && this.forwardSpeed > -0.6) this.forwardHold += dt;
      else this.forwardHold = 0;
      if (this.forwardHold > 0.25) { this.gear = 1; this.forwardHold = 0; }
    }

    this.shiftLock -= dt;

    if (this.gear > 0 && this.shiftTimer <= 0 && this.shiftLock <= 0) {
      let wheelOmega = 0;
      for (const i of this.drivenWheels) wheelOmega += this.wheels[i].omega;
      wheelOmega = Math.abs(wheelOmega / this.drivenWheels.length);

      const shift = (to, time) => {
        this.gear = to;
        this.shiftTimer = time;
        // A dwell after every change. Without it the box hunts at the point
        // where two ratios are equally good and the clutch never re-engages.
        this.shiftLock = 0.4;
      };

      if (c.throttle > 0.55) {
        // Kickdown. Ask which ratio actually puts the most torque at the wheel
        // for the speed we are doing and take it in one step -- this is what
        // recovers the car after a crash in sixth, rather than crawling back
        // down one ratio at a time.
        //
        // Downshifts are judged against a lower rev ceiling than upshifts. The
        // gap between the two is the hysteresis: a gear is only worth dropping
        // to if it leaves real room to rev, so the box cannot oscillate across
        // the boundary where two ratios score the same.
        const wantDown = this._bestGear(wheelOmega, 0.86);
        const wantUp = this._bestGear(wheelOmega, 0.98);
        if (wantDown < this.gear) shift(wantDown, s.shiftTime * 0.55);
        else if (wantUp > this.gear) shift(Math.min(topGear, this.gear + 1), s.shiftTime);
      } else if (this.rpm > s.shiftUpRpm && this.gear < topGear && c.throttle > 0.15) {
        shift(this.gear + 1, s.shiftTime);
      } else if (this.rpm < s.shiftDownRpm && this.gear > 1) {
        shift(this.gear - 1, s.shiftTime * 0.6);
      }
    }

    // --- engine speed ---
    const ratio = this._gearRatio();
    let targetRpm;
    if (this.gear !== 0 && this.clutch > 0.08 && ratio !== 0) {
      let wheelOmega = 0;
      for (const i of this.drivenWheels) wheelOmega += this.wheels[i].omega;
      wheelOmega /= this.drivenWheels.length;
      targetRpm = Math.abs(wheelOmega * ratio) * (60 / TAU);
    } else {
      // Free revving: the engine answers the throttle directly.
      targetRpm = lerp(eng.idleRpm, eng.redline * 0.97, c.throttle);
    }
    this.rpm = damp(this.rpm, clamp(targetRpm, eng.idleRpm, eng.redline * 1.02), 22, dt);

    // --- torque ---
    if (this.gear === 0 || this.clutch <= 0.08 || ratio === 0) return 0;

    // In reverse the pedals swap roles: the brake pedal is what drives you
    // backwards, and the throttle is what stops you and selects forward again.
    const accel = this.accelInput;

    let engineTorque = torqueAt(eng.torqueCurve, this.rpm) * accel;

    // Engine braking on a closed throttle -- part of why lifting mid-corner
    // shifts load forward and can rotate the car. Suppressed near standstill,
    // where a real clutch or torque converter would be slipping: without this
    // the car reverses itself away from a stop line.
    const crawling = Math.abs(this.forwardSpeed) < 1.5;
    if (!crawling) {
      engineTorque -= (1 - accel) * eng.brakeTorque * (0.25 + 0.75 * this.rpm / eng.redline);
    } else if (accel < 0.02 && this.brakeInput < 0.02) {
      // Idle creep, as an automatic would.
      engineTorque += 9 * (this.gear === -1 ? -1 : 1);
    }

    if (this.rpm > eng.redline) engineTorque = Math.min(engineTorque, -eng.brakeTorque * 0.5);
    // A wrecked engine makes less power.
    engineTorque *= lerp(1, 0.35, smoothstep(0.35, 0.95, this.damage));
    // The clutch kick releases a torque spike as it re-engages.
    if (this.kickTimer > 0 && this.clutch > 0.3) engineTorque *= 1.55;
    if (this.rpm > eng.redline * 1.01) engineTorque = Math.min(engineTorque, 0);
    if (engineTorque > 0) engineTorque *= this._tractionFactor(c) * this.assist.boost;

    return engineTorque * ratio * this.clutch * 0.92;
  }

  /**
   * The gear that produces the most tractive force at the current wheel speed.
   *
   * Walks every ratio, works out where it would put the engine, discards
   * anything that would hit the limiter, and scores the rest by torque at the
   * wheel (engine torque x total ratio). Choosing by force rather than by an
   * rpm threshold is what keeps the car in the power band at any speed.
   */
  /**
   * Traction control: back the engine off when the driven wheels start to spin.
   *
   * First gear multiplies engine torque by about sixteen, so at low speed a
   * keyboard's all-or-nothing throttle lights up the rears instantly -- and
   * because the tyre model resolves force along the combined slip direction, a
   * spinning rear wheel has very little cornering grip left. Deliberate slides
   * are preserved: the handbrake and the clutch kick both switch this off.
   */
  _tractionFactor(c) {
    const s = this.spec;
    if (!s.tractionControl || c.handbrake > 0.1 || c.clutchKick || this.kickTimer > 0) return 1;

    let worst = 0;
    for (const i of this.drivenWheels) {
      const w = this.wheels[i];
      if (w.grounded && w.slipRatio > worst) worst = w.slipRatio;
    }
    const over = worst - s.tcSlipThreshold;
    if (over <= 0) return 1;
    return lerp(1, 1 / (1 + over * 8), s.tractionControl);
  }

  _bestGear(wheelOmega, ceiling) {
    const s = this.spec;
    const eng = s.engine;
    const top = s.gears.length - 1;
    let best = -1;
    let bestForce = -Infinity;
    for (let gi = 1; gi <= top; gi++) {
      const ratio = s.gears[gi] * s.finalDrive;
      const rpm = wheelOmega * ratio * (60 / TAU);
      if (rpm > eng.redline * ceiling) continue;
      const force = torqueAt(eng.torqueCurve, Math.max(rpm, eng.idleRpm)) * ratio;
      if (force > bestForce) { bestForce = force; best = gi; }
    }
    // Nothing qualified means we are travelling too fast for any ratio to stay
    // under the limiter, so the answer is the tallest gear -- emphatically not
    // the shortest, which would drop the car into first at motorway speed.
    return best === -1 ? top : best;
  }

  _gearRatio() {
    const s = this.spec;
    if (this.gear === -1) return -s.reverseGear * s.finalDrive;
    if (this.gear === 0) return 0;
    return s.gears[this.gear] * s.finalDrive;
  }

  // ------------------------------------------------------------- force pass

  _suspensionPass(dt) {
    const s = this.spec;
    const sus = s.suspension;
    const maxToi = sus.rest + s.wheelRadius;
    this.grounded = 0;

    for (const w of this.wheels) {
      w.prevCompression = w.compression;

      // Suspension mount, in world space.
      w.worldPos.copy(w.pos).applyQuaternion(this.quaternion).add(this.position);
      _v1.copy(this.up).multiplyScalar(-1);

      const hit = raycast(this.world, w.worldPos, _v1, maxToi, RAY_GROUNDS, this.body);

      if (hit) {
        w.grounded = true;
        this.grounded++;
        w.compression = clamp(maxToi - hit.toi, 0, sus.travel);
        w.contact.set(hit.point.x, hit.point.y, hit.point.z);
        w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        if (w.normal.y < 0) w.normal.multiplyScalar(-1);
        w.surface = this.sim.surfaceAt ? this.sim.surfaceAt(hit.point.x, hit.point.z) : 1;
      } else {
        w.grounded = false;
        w.compression = 0;
        w.normal.set(0, 1, 0);
      }
      w.arb = 0;
    }

    this.airborne = this.grounded === 0;
  }

  /**
   * Anti-roll bars tie the two wheels on an axle together, trading roll
   * stiffness for grip. The front/rear balance here is one of the strongest
   * handling knobs available: a stiff rear bar makes the car oversteer.
   *
   * Sign matters enormously. The bar must push *up* harder on the wheel that
   * is compressing and ease off the one that is extending, which resists the
   * roll and moves lateral load onto the outside of that axle. Reverse it and
   * you get a positive feedback loop that rolls the car onto its door handles.
   */
  _antiRollPass() {
    const sus = this.spec.suspension;
    const L0 = this.wheels[0], R0 = this.wheels[1];
    const L1 = this.wheels[2], R1 = this.wheels[3];
    const fF = (L0.compression - R0.compression) * sus.arbFront;
    L0.arb = +fF; R0.arb = -fF;
    const fR = (L1.compression - R1.compression) * sus.arbRear;
    L1.arb = +fR; R1.arb = -fR;
  }

  _tyrePass(dt, axleTorque) {
    const s = this.spec;
    const sus = this.spec.suspension;
    const c = this.controls;

    // --- brake torques ---
    const bMax = s.brakes.maxTorque;
    const braking = this.brakeInput;
    const frontBrake = braking * bMax * s.brakes.frontBias * 2;
    const rearBrake = braking * bMax * (1 - s.brakes.frontBias) * 2;
    const handbrake = c.handbrake * s.brakes.handbrakeTorque;

    // --- split drive torque across the driven wheels ---
    const perWheelTorque = axleTorque / this.drivenWheels.length;
    const isDriven = [false, false, false, false];
    for (const i of this.drivenWheels) isDriven[i] = true;

    const ratio = this._gearRatio();
    // Driveline inertia reflected at the wheel. This is why first gear spins
    // the wheels up instantly and sixth barely does anything.
    const reflected = s.engine.inertia * ratio * ratio;

    this.maxSlip = 0;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const drive = isDriven[i] ? perWheelTorque : 0;

      // --- anti-lock ---
      //
      // Without this, brake torque past the grip limit simply stops the wheel,
      // and a locked tyre slides at the sliding-friction fraction of peak --
      // about 84% -- so the last part of the pedal makes the stop *longer*.
      //
      // Modelled as a torque limit rather than as a cut-and-restore cycle: the
      // brake is never allowed to ask the wheel for more than the tyre can
      // currently put down. A bang-bang version that waits for lock-up and then
      // backs off was tried first and stopped nothing -- by the time last
      // step's slip ratio says the wheel is locked, it is locked, and the
      // measured result was wheels locked for most of the stop and a heavy
      // patrol car braking *worse* than the runner.
      let service = w.front ? frontBrake : rearBrake;
      const abs = s.brakes.abs || 0;
      if (abs > 0 && braking > 0.02 && w.grounded && Math.abs(this.forwardSpeed) > 2) {
        const grip = SURFACE_TYRES[w.surface] || TYRE_ROAD;
        const bias = s.gripBias ? (w.front ? s.gripBias.front : s.gripBias.rear) : 1;
        const peak = loadedMu(grip, w.load, w.condition)
          * w.load * s.gripScale * bias * this.assist.grip;

        // Closed loop on slip ratio, not a fixed cap on torque. A fixed cap
        // does not work: set at the tyre's peak it sits *above* the force a
        // locked tyre still generates, so once a wheel has stopped nothing can
        // spin it back up and it stays locked for the whole stop -- measured,
        // with the fronts pinned at slip 1.0 and the car braking worse than
        // with no ABS at all. The trim has to be able to go below the tyre's
        // current output, which means integrating the error.
        const err = grip.peakSlipRatio - Math.abs(w.slipRatio);
        w.absTrim = clamp(w.absTrim + err * 6 * dt, 0.30, 1.15);
        service = lerp(service, Math.min(service, peak * w.radius * w.absTrim), abs);
      } else if (braking <= 0.02) {
        w.absTrim = 1;
      }
      // The handbrake is deliberately outside it -- locking the rears is the
      // entire point of pulling it.
      const brakeTorque = service + (w.front ? 0 : handbrake);
      const I = Math.max(0.4, w.radius * w.radius * s.wheelMass + (isDriven[i] ? reflected : 0));

      if (!w.grounded) {
        // In the air the wheel is free: drive torque just spins it up.
        w.omega += (drive / I) * dt;
        w.omega -= sign(w.omega) * Math.min(Math.abs(w.omega), (brakeTorque / I) * dt);
        w.omega *= 1 - 0.4 * dt;
        w.load = 0; w.Fx = 0; w.Fy = 0; w.slip = 0;
        w.spin += w.omega * dt;
        continue;
      }

      // ---- suspension force ----
      const rate = (w.compression - w.prevCompression) / dt;
      const damping = rate > 0 ? sus.dampCompress : sus.dampRebound;
      let Fs = sus.stiffness * w.compression + damping * rate + w.arb;
      // Bottoming out: a hard stop once the travel is used up.
      if (w.compression >= sus.travel - 1e-4 && rate > 0) Fs += sus.bumpStop * rate;
      Fs = clamp(Fs, 0, sus.maxForce);
      // On a slope only the component along the suspension axis counts.
      Fs *= clamp(w.normal.dot(this.up), 0.25, 1);

      _v1.copy(this.up).multiplyScalar(Fs);
      this.body.addForceAtPoint(_v1, w.contact, true);

      // ---- wheel frame, projected onto the contact plane ----
      _qs.setFromAxisAngle(this.up, w.steer);
      _wf.copy(this.forward).applyQuaternion(_qs);
      _wl.copy(this.left).applyQuaternion(_qs);
      _wf.addScaledVector(w.normal, -_wf.dot(w.normal));
      _wl.addScaledVector(w.normal, -_wl.dot(w.normal));
      if (_wf.lengthSq() < 1e-6 || _wl.lengthSq() < 1e-6) continue;
      _wf.normalize();
      _wl.normalize();

      // ---- velocity of the contact patch ----
      _v2.copy(w.contact).sub(this.position);
      _v3.copy(this.angvel).cross(_v2).add(this.linvel);
      const vLong = _v3.dot(_wf);
      const vLat = _v3.dot(_wl);

      // ---- slip ----
      w.slipRatio = slipRatioOf(w.omega * w.radius, vLong);
      w.slipAngle = slipAngleOf(vLat, vLong);

      const tyre = SURFACE_TYRES[w.surface] || TYRE_ROAD;
      // Per-axle grip trim: a little extra at the rear buys traction and
      // stability without making the whole car feel glued down.
      const bias = s.gripBias ? (w.front ? s.gripBias.front : s.gripBias.rear) : 1;
      // Off-road tyres. Only applies on the loose stuff, so a car with them is
      // no better on tarmac -- it is simply less helpless the moment it leaves
      // it. Pursuit units are allowed to cut corners and take lines across open
      // ground, and being allowed to do it is not much use on a surface that
      // gives up less than half the grip of the road.
      const loose = w.surface === 0 ? (s.offRoadGrip || 1) : 1;
      const f = tyreForces(tyre, Fs, w.slipRatio, w.slipAngle, w.condition,
        s.gripScale * bias * this.assist.grip * loose);
      // Fleet braking rubber. Applied to the longitudinal force only, and only
      // while the pedal is down and the force is opposing motion, so it buys
      // stopping distance and nothing else -- a police car does not corner or
      // accelerate any better for having it. Anti-lock alone only brings the
      // heavier patrol car level with the runner, because in this tyre model a
      // locked tyre still keeps 84% of peak and locking therefore costs almost
      // nothing; this is what actually makes the fleet out-brake you.
      //
      // Modifies f.Fx, not w.Fx: the latter is the telemetry copy, and the
      // force that reaches the body is read from f a few lines below.
      const bb = s.brakes.gripBonus;
      if (bb && bb !== 1 && braking > 0.02 && f.Fx * vLong < 0) f.Fx *= bb;

      w.Fx = f.Fx;
      w.Fy = f.Fy;
      w.load = Fs;
      w.slip = slipIntensity(f.saturation);
      if (w.slip > this.maxSlip) this.maxSlip = w.slip;

      // Rolling resistance, much higher once you are off any hard surface.
      const rr = -sign(vLong) * Fs * (w.surface === 0 ? 0.045 : 0.016);

      _v4.copy(_wf).multiplyScalar(f.Fx + rr).addScaledVector(_wl, f.Fy);
      this.body.addForceAtPoint(_v4, w.contact, true);

      // ---- wheel spin dynamics ----
      //
      // Semi-implicit. The tyre's longitudinal stiffness is on the order of
      // 10^5 N per unit slip ratio, which against a ~2.5 kg m^2 wheel is far
      // too stiff to integrate explicitly at 120 Hz -- the wheel overshoots
      // the no-slip speed every step and buzzes. Linearising the tyre force
      // about the current slip and solving for the new speed damps exactly
      // that overshoot without changing where the wheel settles.
      //
      // `f.stiffness` is the slope at the *origin* of the force curve, which is
      // only the local slope while the tyre is near its linear range. Past the
      // peak the curve is flat, and out at full lock it is completely flat --
      // so using the origin slope there invents an enormous damping term that
      // holds a stopped wheel stopped however little brake torque is left on
      // it. That is why locked wheels stayed locked, and why an anti-lock
      // system that had correctly cut the torque to a third still could not
      // get a wheel turning again. Fall the estimate off with slip so it is
      // the real local slope, which leaves the low-slip behaviour it was added
      // for exactly as it was.
      const slipRel = Math.abs(w.slipRatio) / tyre.peakSlipRatio;
      const localSlope = 1 / (1 + slipRel * slipRel);
      const denom = Math.max(Math.abs(vLong), 2.0);
      const dFdOmega = (f.stiffness * localSlope * w.radius) / denom;
      const implicitGain = 1 + (dt * w.radius * dFdOmega) / I;

      let omega = w.omega + (((drive - f.Fx * w.radius) / I) * dt) / implicitGain;

      // Brakes clamp to a stop rather than reversing the wheel; going past zero
      // is what would make locked wheels judder unphysically.
      const dOmega = (brakeTorque / I) * dt;
      if (Math.abs(omega) <= dOmega) omega = 0;
      else omega -= sign(omega) * dOmega;

      w.omega = omega;
      w.spin += w.omega * dt;
    }
  }

  _aeroPass() {
    const s = this.spec;
    const v = this.speed;
    if (v > 0.5) {
      // Drag opposes the velocity vector, growing with the square of speed.
      // Boost divides it, so torque x boost and drag / boost together raise
      // top speed by the boost factor rather than by its cube root.
      const drag = (0.5 * 1.225 * s.aero.dragArea * v) / this.assist.boost;
      _v1.copy(this.linvel).multiplyScalar(-drag);
      this.body.addForce(_v1, true);
    }

    // Stability assist: only intervenes once the car is genuinely out of
    // shape, so ordinary cornering is untouched but the back never steps out.
    if (this.assist.stability > 0 && this.speed > 4) {
      const excess = Math.abs(this.slipAngleBody) - 0.09;   // beyond ~5 degrees
      if (excess > 0) {
        const yaw = sign(this.slipAngleBody) * Math.min(excess, 0.5)
          * this.assist.stability * s.mass * 7.5;
        _v1.set(0, yaw - this.angvel.y * s.mass * 0.35 * this.assist.stability, 0);
        this.body.addTorque(_v1, true);
      }
    }
    if (s.aero.downforce > 0 && v > 8) {
      const df = 0.5 * 1.225 * s.aero.downforce * v * v;
      _v1.copy(this.up).multiplyScalar(-df);
      this.body.addForce(_v1, true);
    }
    if (this.airborne) {
      // Damp the tumble slightly so a jump does not turn into a helicopter.
      _v1.copy(this.angvel).multiplyScalar(-s.mass * 0.20);
      this.body.addTorque(_v1, true);
    }
  }

  // ---------------------------------------------------------------- helpers

  get kmh() { return Math.abs(this.forwardSpeed) * 3.6; }
  get rpmFraction() { return clamp01(this.rpm / this.spec.engine.redline); }
  get isDrifting() { return Math.abs(this.slipAngleBody) > 0.22 && this.speed > 8; }

  /**
   * Peak friction actually available under the car right now, averaged over
   * the grounded wheels.
   *
   * The AI needs this. Planning a corner against the road figure while two
   * wheels are on a verge asks for grip that is not there, and the answer to
   * a car that has slid onto grass cannot be to keep demanding road-surface
   * cornering from it.
   */
  get surfaceMu() {
    let sum = 0, n = 0;
    for (const w of this.wheels) {
      if (!w.grounded) continue;
      const loose = w.surface === 0 ? (this.spec.offRoadGrip || 1) : 1;
      sum += (SURFACE_TYRES[w.surface] || TYRE_ROAD).mu * loose;
      n++;
    }
    return n ? sum / n : TYRE_ROAD.mu;
  }

  /** Wheel centre in world space, accounting for suspension travel. */
  wheelCentre(i, out) {
    const w = this.wheels[i];
    const sus = this.spec.suspension;
    const drop = sus.rest - w.compression;
    return out.copy(w.pos)
      .applyQuaternion(this.quaternion)
      .add(this.position)
      .addScaledVector(this.up, -drop);
  }

  teleport(position, heading) {
    const half = heading * 0.5;
    this.body.setTranslation(position, true);
    this.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this._prevVel.set(0, 0, 0);
    for (const w of this.wheels) { w.omega = 0; w.compression = 0; }
    this.gear = 1;
    this.rpm = this.spec.engine.idleRpm;
    this.flippedFor = 0;
  }

  repair() {
    this.damage = 0;
    this.disabled = false;
    for (const w of this.wheels) w.condition = 1;
  }

  destroy() {
    this.world.removeRigidBody(this.body);
  }
}
