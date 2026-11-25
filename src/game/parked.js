// Cars parked on the drives.
//
// "Street clutter: parked cars." Wexbury's streets had nothing standing in them but lamp posts and bins.
// The town generator picks a drive beside about a third of the houses, off the road and the pavement
// (world/drives.js, Haldon's villages too); this draws them, once the car models are in. Not in the road: a
// car parked in a lane would change every chase down it.
//
// One traffic model each (hatchback, estate, SUV), its paint from the traffic's colours, sitting on its
// springs as a parked car does, with the game's own wheel. Drawn in batches -- one per part of each model, so
// a few draws for all of them -- of those in view: the model within FADE1, its stand-ins further off and for
// its shadow (game/farcars.js), and gone between PARK_FADE and PARK_FAR. They were in cells of 120 m, whole models
// and their shadows to 230 m: 126,000 to 256,000 triangles a frame on Ashfield.
//
// "It's kind of bad to have them solid ... make it so they're like any of the other cars, and then if you hit
// them, they turn on their car alarm and start flashing their hazards." Each is a body of a car's weight,
// asleep -- Rapier spends nothing on a sleeping body -- until something hits it. Then it is shoved as hard as
// it was hit, its alarm goes and its hazards flash for ALARM_FOR seconds, and its batch entries follow the
// body until it settles. Not over the network: each player shoves their own.

import * as THREE from 'three';
import { SPECS } from './vehicles.js';
import { trafficPaint } from './traffic.js';
import { RAPIER, GROUP, groups } from '../physics/world.js';
import { PARK_HY } from '../world/drives.js';
import { standing } from './carlod.js';
import { FADE1 } from './farcars.js';

const KINDS = ['hatchback', 'estate', 'civsuv'];
const PARK_FADE = 250, PARK_FAR = 320;
/** A parked car's weight, kg, and how long its alarm goes, s. */
const PARK_MASS = 1300;
const ALARM_FOR = 25;
/** How far it has to be shoved for the alarm to go, m. */
const ALARM_MOVE = 0.15;
/** The most alarms sounding at once: past that, the oldest stops. */
const MAX_ALARMS = 3;

const _m = new THREE.Matrix4();
const _at = new THREE.Matrix4();
const _c = new THREE.Color();
const _w = new THREE.Vector3();
const _ws = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);
const _ball = new THREE.Sphere(new THREE.Vector3(), 3.5);

/** The parts of a kind's model, and where its body and wheels sit, from the spec. */
function kindParts(game, kind) {
  const model = game.carModels && game.carModels[kind];
  const spec = SPECS[kind];
  if (!model || !spec) return null;
  model.scene.updateMatrixWorld(true);
  const parts = [];
  model.scene.traverse((o) => {
    if (!o.isMesh) return;
    let mat = o.material;
    const paint = mat && mat.name === 'paint';
    if (paint) { mat = mat.clone(); mat.color.setRGB(1, 1, 1); }
    parts.push({ geo: o.geometry, mat, local: o.matrixWorld.clone(), paint });
  });
  // The wheels as Vehicle._buildWheels lays them out, and the body as high as puts their tyres on the ground.
  const { wheels, bodyY } = standing(spec);
  const box = new THREE.Box3().setFromObject(model.scene);
  return { parts, wheels, bodyY, spec, box, kind };
}

/** Draw `spots` ({x, y, z, heading, i, body}) as parked cars; returns the ParkedCars, or null. */
export function addParkedCars(game, spots) {
  if (!spots || !spots.length || !game.wheelMesh || window.__noParked) return null;
  const kinds = {};
  for (const k of KINDS) { const p = kindParts(game, k); if (p) kinds[k] = p; }
  const have = Object.keys(kinds);
  if (!have.length) return null;
  return new ParkedCars(game, spots, kinds, have);
}

export class ParkedCars {
  constructor(game, spots, kinds, have) {
    this.game = game;
    this.cars = [];
    this.time = 0;
    for (const sp of spots) {
      const K = kinds[have[sp.i % have.length]];
      this.cars.push({ s: sp, K, paint: trafficPaint(`p${sp.i}`), pos: new THREE.Vector3(), quat: new THREE.Quaternion(), alarm: 0, sound: null, settled: true });
    }
    // Room in each batch for every car there is of the kind, and drawn for as many as are near and in view.
    const root = this.root = new THREE.Group();
    root.name = 'parked';
    for (const K of Object.values(kinds)) {
      const n = this.cars.filter((c) => c.K === K).length;
      K.n = 0;
      K.meshes = K.parts.map((part) => {
        const im = new THREE.InstancedMesh(part.geo, part.mat, Math.max(1, n));
        im.receiveShadow = true;
        im.castShadow = !(game.farCars && game.farCars.casts(K.kind));
        if (part.paint) im.setColorAt(0, _c.set(0xffffff));
        return im;
      });
      root.add(...K.meshes);
    }
    this.kinds = Object.values(kinds);
    this.wm = new THREE.InstancedMesh(game.wheelMesh.geometry, game.wheelMesh.material, Math.max(1, this.cars.length * 4));
    this.wm.castShadow = true;
    root.add(this.wm);
    for (const im of root.children) { im.frustumCulled = false; im.count = 0; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }
    game.scene.add(root);
    for (const car of this.cars) {
      this._makeBody(car);
      this._pose(car);
    }
  }

  /** Every frame: those near and in view of `frustum` as they are, the further ones' stand-ins, and all their shadows. */
  draw(far, camera, frustum) {
    for (const K of this.kinds) K.n = 0;
    let w = 0;
    for (const car of this.cars) {
      const { K, pos, quat } = car, dx = pos.x - camera.position.x, dz = pos.z - camera.position.z;
      if (dx * dx + dz * dz > PARK_FAR * PARK_FAR) continue;
      const d = pos.distanceTo(camera.position);
      if (far) far.cast(K.kind, pos, quat);
      if (d > PARK_FAR) continue;
      _ball.center.copy(pos);
      if (!frustum.intersectsSphere(_ball)) continue;
      if (far && far.has(K.kind)) far.add(K.kind, pos, quat, car.paint, d, d > PARK_FADE ? (PARK_FAR - d) / (PARK_FAR - PARK_FADE) : 1);
      if (d > FADE1) continue;
      _at.compose(pos, quat, ONE);
      K.parts.forEach((part, k) => {
        const im = K.meshes[k];
        im.setMatrixAt(K.n, _m.multiplyMatrices(_at, part.local));
        if (part.paint) im.setColorAt(K.n, _c.setHex(car.paint));
      });
      K.n++;
      const rs = K.spec.wheelRadius / 0.34;
      for (const [wx, wy, wz, front] of K.wheels) {
        const width = !front && K.spec.wheelWidthRear ? K.spec.wheelWidthRear : K.spec.wheelWidth;
        _m.compose(_w.set(wx, wy, wz), _qi, _ws.set(width / 0.26, rs, rs));
        this.wm.setMatrixAt(w++, _m.premultiply(_at));
      }
    }
    const send = (im, n) => {
      im.count = n;
      im.visible = n > 0;
      for (const [a, size] of [[im.instanceMatrix, 16], [im.instanceColor, 3]]) {
        if (!a || !n) continue;
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * size);
        a.needsUpdate = true;
      }
    };
    for (const K of this.kinds) for (const im of K.meshes) send(im, K.n);
    send(this.wm, w);
  }

  /** Swap the map's fixed box for a car that can be shoved, asleep where it stands. */
  _makeBody(car) {
    const { s } = car, world = this.game.world;
    if (s.body) { world.removeRigidBody(s.body); s.body = null; }
    const h = s.heading * 0.5;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(s.x, (s.y || 0) + PARK_HY, s.z)
      .setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) })
      .setLinearDamping(0.6)
      .setAngularDamping(1.2)
      .setSleeping(true));
    const vol = 1.9 * PARK_HY * 2 * 4.6;
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.95, PARK_HY, 2.3)
      .setDensity(PARK_MASS / vol)
      .setFriction(0.9)
      .setRestitution(0.05)
      .setCollisionGroups(groups(GROUP.STREET, GROUP.TERRAIN | GROUP.HILL | GROUP.VEHICLE | GROUP.BUILDING | GROUP.STREET | GROUP.PROP | GROUP.HEDGE)), body);
    car.body = body;
    car.rest = { x: s.x, z: s.z, y: Math.sin(h), w: Math.cos(h) };
  }

  /** Where its model is drawn, from where its body is. */
  _pose(car) {
    const t = car.body.translation(), r = car.body.rotation();
    car.quat.set(r.x, r.y, r.z, r.w);
    // The body's middle is PARK_HY up; the model's origin is K.bodyY up.
    car.pos.set(0, car.K.bodyY - PARK_HY, 0).applyQuaternion(car.quat);
    car.pos.x += t.x; car.pos.y += t.y; car.pos.z += t.z;
  }

  /** Every frame: woken cars follow their bodies, and their alarms go. */
  update(dt) {
    this.time += dt;
    const cam = this.game.camera;
    for (const car of this.cars) {
      const awake = !car.body.isSleeping();
      if (awake) {
        // Woken is not hit: Rapier wakes a body when anything near it changes, and every one of them woke on
        // the first step and settled a couple of centimetres, faster than a walking-pace test let through. Shoved
        // is: ALARM_MOVE metres from where it last came to rest, or turned.
        if (!car.alarm) {
          const t = car.body.translation(), r = car.body.rotation();
          if (!car.rest) car.rest = { x: t.x, z: t.z, y: r.y, w: r.w };
          const turn = Math.abs(r.y * car.rest.w - r.w * car.rest.y);   // sin of half the yaw between them
          if (Math.hypot(t.x - car.rest.x, t.z - car.rest.z) > ALARM_MOVE || turn > 0.04) this._alarm(car);
        }
        this._pose(car);
        car.settled = false;
      } else if (!car.settled) {
        this._pose(car);
        car.rest = null;
        car.settled = true;
      }
      if (car.alarm) {
        car.alarm -= dt;
        if (car.alarm <= 0) { car.alarm = 0; if (car.sound) car.sound.stop(); car.sound = null; }
        else if (car.sound && cam) {
          const t = car.body.translation();
          car.sound.level(Math.max(0, 1 - Math.hypot(t.x - cam.position.x, t.z - cam.position.z) / 140));
        }
      }
    }
  }

  _alarm(car) {
    car.alarm = ALARM_FOR;
    const sounding = this.cars.filter((c) => c.sound).sort((a, b) => a.alarm - b.alarm);
    while (sounding.length >= MAX_ALARMS) { const c = sounding.shift(); c.sound.stop(); c.sound = null; }
    car.sound = this.game.audio && this.game.audio.carAlarm ? this.game.audio.carAlarm() : null;
  }

  /** The hazards of every car whose alarm is going, into the game's hazard lights (effects.js). */
  lights(hazards) {
    for (const car of this.cars) {
      if (!car.alarm) continue;
      if (!car.corners) {
        const b = car.K.box, y = car.K.bodyY + b.min.y + (b.max.y - b.min.y) * 0.42 - PARK_HY;
        car.corners = { _hazardCorners: [
          new THREE.Vector3(b.max.x - 0.14, y, b.max.z - 0.04), new THREE.Vector3(b.min.x + 0.14, y, b.max.z - 0.04),
          new THREE.Vector3(b.max.x - 0.14, y, b.min.z + 0.04), new THREE.Vector3(b.min.x + 0.14, y, b.min.z + 0.04),
        ] };
        car.basis = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
      }
      const t = car.body.translation(), r = car.body.rotation();
      car.basis.position.set(t.x, t.y, t.z);
      car.basis.quaternion.set(r.x, r.y, r.z, r.w);
      hazards.place(car.corners, car.basis);
    }
  }

  /** A new game: every car back on its drive, asleep, quiet. */
  reset() {
    for (const car of this.cars) {
      const { s, body } = car, h = s.heading * 0.5;
      body.setTranslation({ x: s.x, y: (s.y || 0) + PARK_HY, z: s.z }, false);
      body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, false);
      body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      body.sleep();
      if (car.sound) car.sound.stop();
      car.sound = null;
      car.alarm = 0;
      car.rest = { x: s.x, z: s.z, y: Math.sin(h), w: Math.cos(h) };
      if (!car.settled) { this._pose(car); car.settled = true; }
    }
  }
}
