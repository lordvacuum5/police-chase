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

/** Cruise height above the ground, and how far it can see straight down. */
const ALTITUDE = 62;
const SIGHT_RADIUS = 190;

/** Top speed, m/s. Faster than any car, but it still has to cover ground. */
const TOP_SPEED = 62;

/**
 * How far ahead of the target it tries to sit. A helicopter crew keeps the car
 * in the front quarter of the window rather than directly under the airframe,
 * where they would lose it beneath their own floor.
 */
const LEAD = 34;

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
  }

  /** Five stars only. */
  get wanted() { return this.game.heat.tier >= 5; }

  // ------------------------------------------------------------------ launch

  launch(target) {
    if (this.active) return;
    this.active = true;
    if (!this.mesh) this.mesh = buildHelicopterMesh();
    this.game.scene.add(this.mesh);

    // Comes in from off to one side rather than appearing overhead.
    const a = this.game.rng() * Math.PI * 2;
    this.pos.set(
      target.position.x + Math.cos(a) * 420,
      ALTITUDE + 30,
      target.position.z + Math.sin(a) * 420,
    );
    this.vel.set(0, 0, 0);
    this.game.radio('Air support is up — India 99 overhead', true);
  }

  stand_down() {
    if (!this.active) return;
    this.active = false;
    if (this.mesh) this.game.scene.remove(this.mesh);
    this.game.radio('India 99 returning to base');
  }

  // ------------------------------------------------------------------ update

  update(dt, target) {
    if (this.wanted && !this.active) this.launch(target);
    else if (!this.wanted && this.active) this.stand_down();
    if (!this.active) return;

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

    // The searchlight only comes on once it is actually over you.
    const over = this.distanceTo(target.position) < SIGHT_RADIUS;
    this.spotlight = damp(this.spotlight, over ? 1 : 0, 2.5, dt);

    this._syncMesh();
  }

  distanceTo(p) {
    return Math.hypot(this.pos.x - p.x, this.pos.z - p.z);
  }

  /**
   * Can it see the target? No line-of-sight test on purpose -- looking down
   * over the rooftops is the entire reason it is in the air. Range still
   * applies, so outrunning it works even though hiding does not.
   */
  canSee(target) {
    return this.active && this.distanceTo(target.position) < SIGHT_RADIUS;
  }

  _syncMesh() {
    const m = this.mesh;
    if (!m) return;
    m.position.copy(this.pos);
    m.rotation.set(0, this.heading, 0);
    m.rotateZ(this.roll);
    // Nose down a little with speed, as one does.
    m.rotateX(clamp(Math.hypot(this.vel.x, this.vel.z) * 0.004, 0, 0.18));

    const { main, tail, beam } = m.userData;
    if (main) main.rotation.z = this.rotor;
    if (tail) tail.rotation.y = this.rotor * 1.7;
    if (beam) {
      beam.visible = this.spotlight > 0.05;
      beam.material.opacity = this.spotlight * 0.13;
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

  // Searchlight cone, pointing down. Additive so it reads as light rather than
  // a solid object hanging under the aircraft.
  const beamGeo = new THREE.ConeGeometry(15, ALTITUDE, 18, 1, true);
  beamGeo.translate(0, -ALTITUDE * 0.5, 0);
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
    color: 0xfff3c4, transparent: true, opacity: 0.12,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  beam.position.set(0, -1.2, 0.6);
  group.add(beam);

  group.userData.main = main;
  group.userData.tail = tail;
  group.userData.beam = beam;
  return group;
}
