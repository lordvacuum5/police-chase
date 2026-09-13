// Air support.
//
// Turns up at five stars and changes the shape of the chase rather than adding
// another car to it. A helicopter does not have to route anywhere, cannot be
// shaken by cornering, and -- the whole point -- sees over buildings. Ducking
// down a side street stops working while it is overhead; what still works is
// distance, because it has a finite radius like everything else.
//
// It is deliberately not a physics body. It flies above the world, touches
// nothing, and exists to feed the dispatcher a spotter that ignores line of
// sight.

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp } from '../util/math.js';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';

/** Cruise height above the ground. */
const ALTITUDE = 62;

/**
 * The searchlight, which is what actually does the spotting.
 *
 * The beam is aimed independently of the airframe -- a real observer swings the
 * light around while the aircraft flies its own line -- so what matters is
 * whether the pool of light is on you, not how close the helicopter is. That
 * makes the light something you can watch and dodge rather than an invisible
 * radius, and it means a crew that has lost you sweeps for you.
 */
const BEAM_RADIUS = 26;          // radius of the pool on the ground
const BEAM_TRACK = 2.6;          // how fast the light follows a target it holds
const BEAM_SWEEP = 1.1;          // how fast it hunts when it has lost you
const BEAM_MAX_OFFSET = 210;     // how far from the aircraft the light reaches

/**
 * Endurance. It is a real aircraft with a fuel load, and going off to refuel
 * gives you a window that is earned rather than random -- if you can survive
 * until the tanks are low, you get a few minutes with nothing overhead.
 */
const ENDURANCE = 165;           // seconds on station
const REFUEL_TIME = 70;          // seconds away

/** Top speed, m/s. Faster than any car, but it still has to cover ground. */
const TOP_SPEED = 62;

/**
 * How far ahead of the target it tries to sit. A helicopter crew keeps the car
 * in the front quarter of the window rather than directly under the airframe,
 * where they would lose it beneath their own floor.
 */
const LEAD = 34;

/** Nominal beam length; the cone is scaled from this to reach the ground. */
const BEAM_LEN = 100;

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Helicopter {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.pos = new THREE.Vector3(0, ALTITUDE, 0);
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.roll = 0;
    this.rotor = 0;
    this.spotlight = 0;
    this.mesh = null;

    // Where the searchlight is pointed, on the ground. Moves independently of
    // the aircraft.
    this.beam = new THREE.Vector3();
    this.beamLocked = false;
    this.sweepPhase = 0;

    this.fuel = ENDURANCE;
    this.refuelTimer = 0;
  }

  /** Five stars only, and only when it has fuel in it. */
  get wanted() { return this.game.heat.tier >= 5 && this.refuelTimer <= 0; }

  // ------------------------------------------------------------------ launch

  launch(target) {
    if (this.active) return;
    this.active = true;
    if (!this.mesh) {
      this.mesh = buildHelicopterMesh();
      const lit = buildBeam();
      this.mesh.userData.beam = lit.beam;
      this.mesh.userData.pool = lit.pool;
    }
    this.game.scene.add(this.mesh);
    this.game.scene.add(this.mesh.userData.beam);
    this.game.scene.add(this.mesh.userData.pool);

    // Comes in from off to one side rather than appearing overhead.
    const a = this.game.rng() * Math.PI * 2;
    this.pos.set(
      target.position.x + Math.cos(a) * 420,
      ALTITUDE + 30,
      target.position.z + Math.sin(a) * 420,
    );
    this.vel.set(0, 0, 0);
    this.game.say('heli-up', [
      'India 99, airborne and making our way to you.',
      'Air support is up, India 99 overhead shortly.',
      'India 99, lifted, en route to the pursuit.',
    ], {}, true);
  }

  stand_down(why) {
    if (!this.active) return;
    this.active = false;
    if (this.mesh) {
      this.game.scene.remove(this.mesh);
      this.game.scene.remove(this.mesh.userData.beam);
      this.game.scene.remove(this.mesh.userData.pool);
    }
    if (why === 'refuel') {
      this.game.say('heli-refuel', [
        'India 99, breaking off to refuel.',
        'India 99, fuel state, we have to leave you.',
        'India 99, off task, heading back to refuel.',
      ]);
    } else {
      this.game.say('heli-rtb', [
        'India 99, released, returning to base.',
        'India 99, no longer required, heading home.',
        'India 99, off task, back to base.',
      ]);
    }
  }

  // ------------------------------------------------------------------ update

  update(dt, target) {
    if (this.refuelTimer > 0) {
      this.refuelTimer -= dt;
      if (this.refuelTimer <= 0) this.fuel = ENDURANCE;
    }
    if (this.wanted && !this.active) this.launch(target);
    else if (!this.wanted && this.active) this.stand_down();
    if (!this.active) return;

    // Burn fuel, and go home when it runs low. Warned on the radio first, so
    // the window is something you can hear coming and use.
    this.fuel -= dt;
    if (this.fuel < 22 && !this._warned) {
      this._warned = true;
      this.game.say('heli-lowfuel', [
        'India 99, getting low on fuel, we will have to break off soon.',
        'India 99, fuel is low, a couple of minutes left with you.',
        'India 99, low fuel, not long left overhead.',
      ]);
    }
    if (this.fuel <= 0) {
      this.refuelTimer = REFUEL_TIME;
      this._warned = false;
      this.stand_down('refuel');
      return;
    }

    // Aim for a point ahead of the target, so it is looking down at the car
    // rather than hovering on top of it.
    const lead = clamp(target.speed * 0.9, 0, LEAD);
    const wantX = target.position.x + target.forward.x * lead;
    const wantZ = target.position.z + target.forward.z * lead;

    // Steer-and-accelerate rather than lerping the position: a helicopter has
    // momentum, and letting it overshoot and swing back is most of what makes
    // it read as flying rather than sliding along a rail.
    const dx = wantX - this.pos.x, dz = wantZ - this.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const want = Math.min(TOP_SPEED, dist * 0.85);
    const ax = (dx / dist) * want - this.vel.x;
    const az = (dz / dist) * want - this.vel.z;
    const accel = 9.5;
    this.vel.x += clamp(ax, -accel, accel) * dt;
    this.vel.z += clamp(az, -accel, accel) * dt;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y = damp(this.pos.y, ALTITUDE, 1.4, dt);

    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > 1) this.heading = Math.atan2(this.vel.x, this.vel.z);
    // Bank into the turn, from how much the velocity is being bent.
    const turn = (ax * this.vel.z - az * this.vel.x) / Math.max(40, speed * speed);
    this.roll = damp(this.roll, clamp(turn * 1.6, -0.5, 0.5), 3, dt);
    this.rotor += dt * 34;

    this._updateBeam(dt, target);
    this._syncMesh();
  }

  /**
   * Swing the searchlight.
   *
   * The crew aim the light, not the aircraft, so this runs on its own: it
   * chases the target while it has it, and hunts around the last known
   * position when it does not. Because the beam lags, a hard change of
   * direction genuinely slips out of it -- which is the whole point of making
   * the light the thing that sees you rather than a radius round the aircraft.
   */
  _updateBeam(dt, target) {
    const reach = this.distanceTo(target.position);
    const k = this.game.dispatcher ? this.game.dispatcher.knowledge : null;

    // It can only point the light where the aircraft can actually shine it.
    const inRange = reach < BEAM_MAX_OFFSET;

    let aimX, aimZ, rate;
    if (inRange && (this.beamLocked || this._lit(target))) {
      // Holding you: lead slightly, as an observer would.
      aimX = target.position.x + target.linvel.x * 0.35;
      aimZ = target.position.z + target.linvel.z * 0.35;
      rate = BEAM_TRACK;
    } else {
      // Hunting: circle the last place anybody saw the car.
      const cx = k && k.position ? k.position.x : target.position.x;
      const cz = k && k.position ? k.position.z : target.position.z;
      this.sweepPhase += dt * 0.9;
      const r = 34 + Math.sin(this.sweepPhase * 0.7) * 22;
      aimX = cx + Math.cos(this.sweepPhase) * r;
      aimZ = cz + Math.sin(this.sweepPhase) * r;
      rate = BEAM_SWEEP;
    }

    // Keep the light within reach of the aircraft.
    const ox = aimX - this.pos.x, oz = aimZ - this.pos.z;
    const off = Math.hypot(ox, oz);
    if (off > BEAM_MAX_OFFSET) {
      aimX = this.pos.x + (ox / off) * BEAM_MAX_OFFSET;
      aimZ = this.pos.z + (oz / off) * BEAM_MAX_OFFSET;
    }

    this.beam.x = damp(this.beam.x, aimX, rate, dt);
    this.beam.z = damp(this.beam.z, aimZ, rate, dt);

    this.beamLocked = this._lit(target);
    this.spotlight = damp(this.spotlight, inRange ? 1 : 0, 2.5, dt);
  }

  /** Is the target actually standing in the pool of light? */
  _lit(target) {
    return Math.hypot(this.beam.x - target.position.x, this.beam.z - target.position.z)
      < BEAM_RADIUS;
  }

  distanceTo(p) {
    return Math.hypot(this.pos.x - p.x, this.pos.z - p.z);
  }

  /**
   * Can it see the target? Only if the searchlight is actually on them.
   *
   * No line-of-sight test on purpose -- looking down over the rooftops is the
   * entire reason it is up there, so hiding behind a building does not work.
   * Getting out from under the beam does, and since the light lags the car, a
   * hard change of direction can genuinely shake it.
   */
  canSee(target) {
    return this.active && this.spotlight > 0.4 && this._lit(target);
  }

  _syncMesh() {
    const m = this.mesh;
    if (!m) return;
    m.position.copy(this.pos);
    m.rotation.set(0, this.heading, 0);
    m.rotateZ(this.roll);
    // Nose down a little with speed, as one does.
    m.rotateX(clamp(Math.hypot(this.vel.x, this.vel.z) * 0.004, 0, 0.18));

    const { main, tail, beam, pool } = m.userData;
    if (main) main.rotation.z = this.rotor;
    if (tail) tail.rotation.y = this.rotor * 1.7;

    // The beam is a child of the scene, not of the airframe, because it points
    // where the crew aim it rather than where the aircraft happens to be
    // facing. Stretch a cone from the aircraft down to wherever the light is
    // actually landing.
    if (beam) {
      const on = this.spotlight > 0.05;
      beam.visible = on;
      if (on) {
        _from.copy(this.pos);
        _to.set(this.beam.x, 0.06, this.beam.z);
        const mid = _mid.addVectors(_from, _to).multiplyScalar(0.5);
        const len = _from.distanceTo(_to);
        beam.position.copy(mid);
        // The cone is built along +Y, so point it from the aircraft to the pool.
        _axis.subVectors(_to, _from).normalize();
        beam.quaternion.setFromUnitVectors(UP, _axis);
        beam.scale.set(1, len / BEAM_LEN, 1);
        beam.material.opacity = this.spotlight * 0.12;
      }
    }
    if (pool) {
      const on = this.spotlight > 0.05;
      pool.visible = on;
      if (on) {
        pool.position.set(this.beam.x, 0.07, this.beam.z);
        pool.material.opacity = this.spotlight * 0.30;
      }
    }
  }

  reset() {
    this.stand_down();
  }
}

/**
 * A recognisable police helicopter in the same faceted style as the cars:
 * cabin, tail boom, skids, and two rotor discs that spin.
 */
function buildHelicopterMesh() {
  const group = new THREE.Group();
  const b = new MeshBuilder();

  const BODY = 0x1b2432;
  const TRIM = 0xe8edf4;
  const GLASS = 0x0d1218;

  // Cabin: a tapered box with a glazed nose.
  b.addTaperedBox(2.5, 2.0, 4.6, 0, 0, 0.2, BODY, 0.78, 0.72);
  b.addTaperedBox(2.1, 1.3, 1.9, 0, 0.15, 2.5, GLASS, 0.7, 0.5);
  // A white stripe down the flank, so it reads as police from below.
  b.addBox(2.56, 0.42, 3.2, 0, -0.15, 0.4, TRIM);
  // Tail boom and fin.
  b.addTaperedBox(0.62, 0.62, 4.4, 0, 0.35, -3.6, BODY, 0.7, 0.7);
  b.addTaperedBox(0.22, 1.5, 1.1, 0, 1.0, -5.5, BODY, 0.6, 0.5);
  // Rotor mast.
  b.addBox(0.5, 0.7, 0.5, 0, 1.3, 0.1, 0x11161f);
  // Skids.
  for (const s of [-1, 1]) {
    b.addBox(0.18, 0.18, 3.6, s * 1.0, -1.5, 0.1, 0x2a3140);
    b.addBox(0.16, 0.7, 0.16, s * 1.0, -1.15, 1.4, 0x2a3140);
    b.addBox(0.16, 0.7, 0.16, s * 1.0, -1.15, -1.2, 0x2a3140);
  }
  const hull = new THREE.Mesh(b.build(), vertexColorMaterial());
  hull.castShadow = true;
  group.add(hull);

  // Rotors as thin discs -- at rotor speed that is what you see anyway.
  const rotorMat = new THREE.MeshBasicMaterial({
    color: 0x2b3242, transparent: true, opacity: 0.34, side: THREE.DoubleSide,
  });
  const main = new THREE.Mesh(new THREE.CircleGeometry(6.2, 24), rotorMat);
  main.rotation.x = -Math.PI / 2;
  main.position.set(0, 1.72, 0.1);
  group.add(main);

  const tail = new THREE.Mesh(new THREE.CircleGeometry(1.15, 16), rotorMat);
  tail.position.set(0.36, 1.0, -5.5);
  group.add(tail);

  group.userData.main = main;
  group.userData.tail = tail;
  return group;
}

/**
 * The searchlight: a cone from the aircraft plus a bright pool where it lands.
 *
 * Built separately from the airframe and added straight to the scene, because
 * the crew aim the light independently -- it has to be able to point somewhere
 * the aircraft is not.
 */
function buildBeam() {
  // Built along +Y with unit length, so it can be pointed and stretched.
  const geo = new THREE.ConeGeometry(BEAM_RADIUS, BEAM_LEN, 20, 1, true);
  geo.translate(0, -BEAM_LEN * 0.5, 0);
  // Cone apex is at +Y; we want the apex at the aircraft, so flip it.
  geo.rotateX(Math.PI);
  geo.translate(0, BEAM_LEN * 0.5, 0);
  const beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0xfff3c4, transparent: true, opacity: 0.12,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  beam.frustumCulled = false;

  const poolGeo = new THREE.CircleGeometry(BEAM_RADIUS, 26);
  poolGeo.rotateX(-Math.PI / 2);
  const pool = new THREE.Mesh(poolGeo, new THREE.MeshBasicMaterial({
    color: 0xfff6d2, transparent: true, opacity: 0.3,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  pool.frustumCulled = false;
  return { beam, pool };
}
