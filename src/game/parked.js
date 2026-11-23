// Cars parked on the drives.
//
// "Street clutter: parked cars." Wexbury's streets had nothing standing in them but lamp posts and bins.
// The town generator picks a drive beside about a third of the houses, off the road and the pavement
// (world/drives.js, Haldon's villages too); this draws them, once the car models are in. Not in the road: a
// car parked in a lane would change every chase down it.
//
// One traffic model each (hatchback, estate, SUV), its paint from the traffic's colours, sitting on its
// springs as a parked car does, with the game's own wheel. Drawn in batches -- one per part of each model, so
// a few draws for all of them -- in cells of PARK_CELL metres, each hidden past PARK_FAR: a model is about
// 5,500 triangles, and 170 of them drawn twice a frame would cost more than the whole town.
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

const KINDS = ['hatchback', 'estate', 'civsuv'];
const PARK_CELL = 120;
const PARK_FAR = 230;
/** A parked car's weight, kg, and how long its alarm goes, s. */
const PARK_MASS = 1300;
const ALARM_FOR = 25;
/** How far it has to be shoved for the alarm to go, m. */
const ALARM_MOVE = 0.15;
/** The most alarms sounding at once: past that, the oldest stops. */
const MAX_ALARMS = 3;

const _m = new THREE.Matrix4();
const _at = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _w = new THREE.Vector3();
const _ws = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);

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
  // The wheels as Vehicle._buildWheels lays them out, settled as far into the springs as a remote car's
  // (Game: compression 0.6 of rest), and the body as high as puts their tyres on the ground.
  const sus = spec.suspension;
  const a = spec.wheelbase * (1 - spec.frontWeight), b = spec.wheelbase * spec.frontWeight;
  const drop = sus.rest - sus.rest * 0.6;
  const wy = sus.mountY - drop;
  const wheels = [
    [spec.trackFront / 2, wy, a, true], [-spec.trackFront / 2, wy, a, true],
    [spec.trackRear / 2, wy, -b, false], [-spec.trackRear / 2, wy, -b, false],
  ];
  const box = new THREE.Box3().setFromObject(model.scene);
  return { parts, wheels, bodyY: spec.wheelRadius - wy, spec, box };
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
    const cells = new Map();
    for (const s of spots) {
      const key = `${Math.floor(s.x / PARK_CELL)},${Math.floor(s.z / PARK_CELL)}`;
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(s);
    }
    const root = new THREE.Group();
    root.name = 'parked';
    for (const [key, list] of cells) {
      const [ci, cj] = key.split(',').map(Number);
      const ox = (ci + 0.5) * PARK_CELL, oz = (cj + 0.5) * PARK_CELL;
      const cell = new THREE.Group();
      const byKind = {};
      for (const s of list) (byKind[have[s.i % have.length]] || (byKind[have[s.i % have.length]] = [])).push(s);
      let wheels = 0;
      for (const k of Object.keys(byKind)) wheels += byKind[k].length * 4;
      const wm = new THREE.InstancedMesh(game.wheelMesh.geometry, game.wheelMesh.material, wheels);
      wm.castShadow = true;
      let wi = 0;
      for (const [k, list2] of Object.entries(byKind)) {
        const K = kinds[k];
        const cars = list2.map((s) => {
          const car = { s, K, ox, oz, parts: [], wm, w0: wi, cell, lod: null, alarm: 0, sound: null, settled: true };
          wi += 4;
          this.cars.push(car);
          return car;
        });
        for (const part of K.parts) {
          const im = new THREE.InstancedMesh(part.geo, part.mat, cars.length);
          im.castShadow = true;
          im.receiveShadow = true;
          cars.forEach((car, n) => {
            car.parts.push({ im, n, local: part.local });
            if (part.paint) im.setColorAt(n, _c.setHex(trafficPaint(`p${car.s.i}`)));
          });
          cell.add(im);
        }
      }
      cell.add(wm);
      const lod = new THREE.LOD();
      lod.position.set(ox, 0, oz);
      lod.addLevel(cell, 0);
      lod.addLevel(new THREE.Object3D(), PARK_FAR);
      root.add(lod);
    }
    this.root = root;
    game.scene.add(root);
    for (const car of this.cars) {
      this._makeBody(car);
      this._pose(car);
    }
    for (const lod of root.children) for (const o of lod.levels[0].object.children) o.computeBoundingSphere();
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

  /** Its batch entries where its body is. */
  _pose(car) {
    const { K, body } = car;
    const t = body.translation(), r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    // The body's middle is PARK_HY up; the model's origin is K.bodyY up.
    _p.set(0, K.bodyY - PARK_HY, 0).applyQuaternion(_q).add(_s.set(t.x - car.ox, t.y, t.z - car.oz));
    _at.compose(_p, _q, ONE);
    for (const part of car.parts) {
      part.im.setMatrixAt(part.n, _m.multiplyMatrices(_at, part.local));
      part.im.instanceMatrix.needsUpdate = true;
    }
    const rs = K.spec.wheelRadius / 0.34;
    let k = car.w0;
    for (const [wx, wy, wz, front] of K.wheels) {
      const width = !front && K.spec.wheelWidthRear ? K.spec.wheelWidthRear : K.spec.wheelWidth;
      _m.compose(_w.set(wx, wy, wz), _qi, _ws.set(width / 0.26, rs, rs));
      car.wm.setMatrixAt(k++, _m.premultiply(_at));
    }
    car.wm.instanceMatrix.needsUpdate = true;
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
        for (const o of car.cell.children) o.computeBoundingSphere();
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
    for (const lod of this.root.children) for (const o of lod.levels[0].object.children) o.computeBoundingSphere();
  }
}
