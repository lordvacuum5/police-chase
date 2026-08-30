// Civilian traffic.
//
// The point of traffic is not decoration. It is the thing that makes a road
// network a *road network*: something to be held up by at a red light, to
// thread past on the wrong side, to shove out of the way, and for the police
// to have to get through as well. Without it a signalised junction has nobody
// waiting at it and a two-lane street is as empty at rush hour as it is at
// three in the morning.
//
// The hard part is that there can be a lot of them and the physics budget is
// already spent on the cars that matter. So a civilian is not a Vehicle: it has
// no wheels, no tyre model, no drivetrain. It is a box on a dynamic body whose
// horizontal velocity is written each frame to follow a lane down the road
// graph. That costs almost nothing, collides properly with everything, and --
// the reason for using a dynamic body rather than a kinematic one -- when you
// hit one hard enough it stops being driven and simply becomes a car tumbling
// down the road, which is what it should do.
//
// They are streamed: only the ones near the player exist at all.

import * as THREE from 'three';
import RAPIER from 'rapier';
import { SPECS, buildCarGeometry } from './vehicles.js';
import { vertexColorMaterial } from '../util/meshbuild.js';
import { GROUP, groups } from '../physics/world.js';
import { DRIVE_SIDE } from '../world/roadgraph.js';
import { clamp, clamp01, lerp, rand } from '../util/math.js';

/** How much traffic, and how far out it exists. */
const MAX_CARS = 48;
const SPAWN_MIN = 65;         // never appear closer to the player than this
const SPAWN_MAX = 165;
const DESPAWN = 250;

/** Roads civilians use. Motorway traffic is a separate problem; skip it. */
const DRIVEN = new Set(['street', 'avenue', 'dual', 'lane', 'country']);

const CAR_L = 4.5, CAR_W = 1.85, CAR_H = 1.4;

/**
 * Where the mesh sits relative to the collider.
 *
 * buildCarGeometry puts its origin at the car's centre of mass, which is
 * wheelRadius + the suspension sag above the road -- 0.44 m. The collider is a
 * box centred on its own half height. Line those up wrong and the traffic
 * drives around buried to the sills.
 */
const MESH_LIFT = 0.44 - CAR_H * 0.5;

/** Following behaviour, in the usual units. */
const ACCEL = 4.2;            // m/s^2 -- unhurried
const BRAKE = 7.5;
const GAP = 7.0;              // metres of clear space wanted behind the car ahead
const REACT = 1.1;            // seconds of headway on top of that

/**
 * How hard a hit has to be before a civilian stops driving and becomes debris.
 * Measured as the gap between the velocity we asked for and the one the solver
 * actually produced, so a shunt from any direction counts.
 */
const CRASH_DV = 4.5;
const CRASH_FOR = 6.0;        // seconds before it tries to pull away again

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/** Ordinary cars are ordinary colours. */
const PAINT = [
  { body: 0x9aa1a8, glass: 0x121820, trim: 0x15181c, accent: 0x2b3037 },
  { body: 0x27313d, glass: 0x101620, trim: 0x14171b, accent: 0x1d2129 },
  { body: 0xb9bec4, glass: 0x131a22, trim: 0x16191d, accent: 0x2a2f36 },
  { body: 0x6d2b28, glass: 0x111721, trim: 0x14171b, accent: 0x241a19 },
  { body: 0x2c4a3a, glass: 0x101820, trim: 0x14171b, accent: 0x1b2a22 },
  { body: 0xd8d2c4, glass: 0x141a20, trim: 0x17191d, accent: 0x33342f },
  { body: 0x1c1f24, glass: 0x0e1218, trim: 0x121519, accent: 0x22262c },
];

export class Traffic {
  constructor(game) {
    this.game = game;
    this.cars = [];
    this.enabled = true;

    // One instanced mesh per colour. The civilian body is the same builder the
    // player's car uses, minus the police fit-out, so traffic is made of the
    // same kind of car as everything else on the road.
    const spec = Object.assign({}, SPECS.runner, {
      dims: { w: CAR_W, h: CAR_H, l: CAR_L },
    });
    this.meshes = PAINT.map((livery) => {
      const geo = buildCarGeometry(spec, livery, { wheels: true });
      const mesh = new THREE.InstancedMesh(geo, vertexColorMaterial(), MAX_CARS);
      mesh.name = 'traffic';
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      game.scene.add(mesh);
      return mesh;
    });

    // Every road worth driving on, so spawning does not have to scan the graph.
    this.roads = game.graph.edges.filter(
      (e) => !e.dead && !e.turningHead && DRIVEN.has(e.kind) && e.length > 26,
    );
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Fill the streets around the player before the first frame.
   *
   * Ordinary spawning keeps a hole around the player so a car never appears in
   * front of them, which means that at the start of a run the only street you
   * can actually see is the one street with nothing on it. At t = 0 nobody has
   * looked at anything yet, so this once seeds right up to the car.
   */
  prewarm(near) {
    for (let i = 0; i < MAX_CARS; i++) this._spawn(near, 14);
  }

  _spawn(near, minDist = SPAWN_MIN) {
    if (!this.roads.length) return null;
    const g = this.game;
    for (let attempt = 0; attempt < 24; attempt++) {
      const e = this.roads[(g.rng() * this.roads.length) | 0];
      const along = rand(g.rng, 4, e.length - 4);
      const p = g.graph.pointAt(e, along);
      const d = Math.hypot(p.x - near.x, p.z - near.z);
      if (d < minDist || d > SPAWN_MAX) continue;
      // Not on top of anything already there.
      if (this._occupied(p.x, p.z, 9)) continue;

      const dir = g.rng() < 0.5 ? 1 : -1;
      return this._make(e, along, dir);
    }
    return null;
  }

  _make(edge, along, dir) {
    const g = this.game;
    const lane = edge.width * 0.25 * DRIVE_SIDE;
    const p = this._lanePoint(edge, along, dir, lane);

    const body = g.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, CAR_H * 0.5 + 0.12, p.z)
        .setRotation(yawQuat(p.heading))
        .setLinearDamping(0.15)
        .setAngularDamping(1.4)
        .setCcdEnabled(true),
    );
    const col = RAPIER.ColliderDesc.cuboid(CAR_W * 0.5, CAR_H * 0.5, CAR_L * 0.5)
      .setDensity(1350 / (CAR_W * CAR_H * CAR_L))
      .setFriction(0.8)
      .setRestitution(0.05)
      .setCollisionGroups(groups(GROUP.VEHICLE, 0xFFFF));
    g.world.createCollider(col, body);

    const car = {
      body,
      edge,
      dir,
      along,
      lane,
      paint: (g.rng() * PAINT.length) | 0,
      speed: 0,
      // A little spread in how briskly people drive, so a queue forms behind
      // the slow one rather than everybody moving as a block.
      pace: rand(g.rng, 0.78, 1.06),
      crashedFor: 0,
      wantVel: new THREE.Vector3(),
      // What Driver.avoid needs to see it as an obstacle.
      position: new THREE.Vector3(p.x, CAR_H * 0.5, p.z),
      linvel: new THREE.Vector3(),
      spec: { dims: { w: CAR_W, h: CAR_H, l: CAR_L } },
      heading: p.heading,
    };
    this.cars.push(car);
    return car;
  }

  _despawn(car) {
    this.game.world.removeRigidBody(car.body);
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
  }

  reset() {
    for (const c of this.cars) this.game.world.removeRigidBody(c.body);
    this.cars.length = 0;
    if (this.game.player) this.prewarm(this.game.player.position);
  }

  // ------------------------------------------------------------------ drive

  update(dt, player) {
    if (!this.enabled || !player) return;
    const near = player.position;

    // Stream: drop anything that has fallen a long way behind, top up ahead.
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const t = c.body.translation();
      if (Math.hypot(t.x - near.x, t.z - near.z) > DESPAWN || t.y < -6) this._despawn(c);
    }
    if (this.cars.length < MAX_CARS) this._spawn(near);

    // Read every body once, up front. translation() and linvel() cross into
    // wasm, and the gap check looks at every car from every car -- reading
    // them inline is two thousand boundary crossings a frame instead of fifty,
    // which was most of what this system cost.
    for (const c of this.cars) {
      const t = c.body.translation(), lv = c.body.linvel();
      c.position.set(t.x, t.y, t.z);
      c.linvel.set(lv.x, lv.y, lv.z);
    }

    for (const c of this.cars) this._drive(c, dt);
    // Anything the drive step gave up on, swept afterwards rather than during,
    // so the loop is never removing from the array it is walking.
    for (let i = this.cars.length - 1; i >= 0; i--) {
      if (this.cars[i].dead) this._despawn(this.cars[i]);
    }
    this._sync();
  }

  _drive(car, dt) {
    const g = this.game;
    const t = car.position, lv = car.linvel;

    // Did somebody hit it? Compare what the solver produced against what was
    // asked for last frame: a shunt from any direction shows up here, and the
    // car stops steering itself and becomes something tumbling down the road.
    if (car.crashedFor <= 0) {
      _v.set(lv.x - car.wantVel.x, 0, lv.z - car.wantVel.z);
      if (_v.length() > CRASH_DV) car.crashedFor = CRASH_FOR;
    }
    if (car.crashedFor > 0) {
      car.crashedFor -= dt;
      car.speed = Math.hypot(lv.x, lv.z);
      car.wantVel.set(lv.x, 0, lv.z);
      // Once it settles, put it back on the nearest lane and carry on.
      if (car.crashedFor <= 0) this._rejoin(car);
      return;
    }

    // ---- how far along the road, and what is the lane doing here ---------
    car.along += car.speed * dt * car.dir;
    const past = car.dir > 0 ? car.along > car.edge.length : car.along < 0;
    if (past && !this._nextEdge(car)) { car.dead = true; return; }

    // Pull over for a siren. Traffic slowed the police down by a sixth when it
    // went in, while leaving the player untouched -- the police have to get
    // through it and you do not, so it quietly handed you the chase. Parting
    // for blue lights fixes that where it should be fixed: it gives the units
    // their pace back without giving you anything, because nobody moves over
    // for you.
    const pull = this._sirenPull(car, t);
    const laneOff = car.lane + pull * car.edge.width * 0.20 * DRIVE_SIDE;

    const look = clamp(4 + car.speed * 0.55, 5, 22);
    const aimAlong = car.along + look * car.dir;
    const aim = this._lanePoint(car.edge, aimAlong, car.dir, laneOff);

    // ---- how fast is it allowed to be going ------------------------------
    let want = (car.edge.speed || 14) * car.pace;
    if (pull > 0) want = lerp(want, 2.5, pull);

    // Traffic signals. Civilians always obey them -- they are the only road
    // users in the game that never have a reason not to.
    if (g.signals) {
      const node = g.graph.nodes[car.dir > 0 ? car.edge.b : car.edge.a];
      const d = g.signals.stopDistance(car.edge, node, t.x, t.z, car.speed);
      if (isFinite(d)) want = Math.min(want, Math.sqrt(2 * BRAKE * Math.max(0, d - 1.2)));
    }

    // Whatever is in front, civilian or otherwise.
    const gap = this._gapAhead(car);
    if (gap < Infinity) {
      const room = gap - GAP - car.speed * REACT;
      want = Math.min(want, room <= 0 ? 0 : Math.sqrt(2 * BRAKE * room));
    }

    // ---- follow it -------------------------------------------------------
    const rate = want > car.speed ? ACCEL : BRAKE;
    car.speed = clamp(car.speed + Math.sign(want - car.speed) * rate * dt, 0, want);

    let hx = aim.x - t.x, hz = aim.z - t.z;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    car.heading = Math.atan2(hx, hz);

    car.wantVel.set(hx * car.speed, 0, hz * car.speed);
    car.body.setLinvel({ x: car.wantVel.x, y: lv.y, z: car.wantVel.z }, true);
    // Face where it is going. Setting the rotation outright rather than
    // torquing it there keeps a civilian from ever looking drunk, and nothing
    // about a car pootling along needs the solver's help to stay upright.
    car.body.setRotation(yawQuat(car.heading), true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /**
   * How hard this car is getting out of the way, 0 to 1.
   *
   * Only for a marked unit with its lights on that is coming up behind or
   * alongside -- not for one heading the other way, and not for the car being
   * chased, which is the whole point.
   */
  _sirenPull(car, t) {
    const d = this.game.dispatcher;
    if (!d || !this.game.heat || this.game.heat.tier === 0) return 0;
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    let best = 0;
    for (const u of d.units) {
      if (u.disabled || u.vehicle.unmarked || u.role === 'patrol') continue;
      const dx = u.position.x - t.x, dz = u.position.z - t.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 55) continue;
      // Behind, or not far past. Once it is by, there is nothing to move for.
      if (dx * fx + dz * fz > 12) continue;
      best = Math.max(best, clamp01((55 - dist) / 40));
    }
    return best;
  }

  /** Distance to the nearest thing in this car's way, or Infinity. */
  _gapAhead(car) {
    const t = car.position;
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    const reach = 6 + car.speed * REACT + GAP;
    let best = Infinity;

    const test = (px, pz, halfW) => {
      const dx = px - t.x, dz = pz - t.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0.5 || ahead > reach) return;
      const side = dx * fz - dz * fx;
      if (Math.abs(side) > CAR_W * 0.5 + halfW) return;
      best = Math.min(best, ahead - CAR_L);
    };

    for (const o of this.cars) {
      if (o === car) continue;
      test(o.position.x, o.position.z, CAR_W * 0.5);
    }
    for (const v of this.game.vehicles) {
      test(v.position.x, v.position.z, v.spec.dims.w * 0.5);
    }
    return best;
  }

  /** Choose an onward road at the end of the current one. */
  _nextEdge(car) {
    const g = this.game.graph;
    const nodeId = car.dir > 0 ? car.edge.b : car.edge.a;
    const node = g.nodes[nodeId];
    if (!node) return false;

    const options = [];
    for (const eid of node.edges) {
      const e = g.edges[eid];
      if (!e || e.dead || e === car.edge || !DRIVEN.has(e.kind)) continue;
      options.push(e);
    }
    // A dead end is a dead end: turn round rather than vanishing.
    const e = options.length
      ? options[(this.game.rng() * options.length) | 0]
      : car.edge;

    const dir = e === car.edge
      ? -car.dir
      : (e.a === nodeId ? 1 : -1);
    car.edge = e;
    car.dir = dir;
    car.along = dir > 0 ? 0.5 : e.length - 0.5;
    car.lane = e.width * 0.25 * DRIVE_SIDE;
    return true;
  }

  /** After a shunt, find the nearest lane and rejoin it. */
  _rejoin(car) {
    const t = car.body.translation();
    const snap = this.game.graph.nearestEdge(t.x, t.z, 60);
    if (!snap) { car.dead = true; return; }
    const d = this.game.graph.edgeDirection(snap.edge, snap.along, { x: 0, z: 1 });
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    car.edge = snap.edge;
    car.dir = (d.x * fx + d.z * fz) >= 0 ? 1 : -1;
    car.along = snap.along;
    car.lane = snap.edge.width * 0.25 * DRIVE_SIDE;
    car.speed = 0;
  }

  /**
   * A point on this car's side of the road.
   *
   * The offset is measured from the *direction of travel*, not from the
   * polyline, which is the whole trick: left of travel already flips when a
   * car is going the other way down the same edge, so both directions end up
   * on their own side and oncoming traffic passes rather than meeting head on.
   * Left of a heading h is (h.z, -h.x).
   */
  _lanePoint(edge, along, dir, offset) {
    const p = this.game.graph.pointAt(edge, clamp(along, 0, edge.length));
    const tx = p.tx * dir, tz = p.tz * dir;
    return {
      x: p.x + tz * offset,
      z: p.z - tx * offset,
      heading: Math.atan2(tx, tz),
    };
  }

  _occupied(x, z, r) {
    const r2 = r * r;
    for (const c of this.cars) {
      const t = c.body.translation();
      if ((t.x - x) ** 2 + (t.z - z) ** 2 < r2) return true;
    }
    for (const v of this.game.vehicles) {
      if ((v.position.x - x) ** 2 + (v.position.z - z) ** 2 < r2) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- visuals

  _sync() {
    const counts = new Array(this.meshes.length).fill(0);
    for (const c of this.cars) {
      const mesh = this.meshes[c.paint];
      const t = c.body.translation();
      const r = c.body.rotation();
      _pos.set(t.x, t.y + MESH_LIFT, t.z);
      _q.set(r.x, r.y, r.z, r.w);
      _m.compose(_pos, _q, _one);
      mesh.setMatrixAt(counts[c.paint]++, _m);
    }
    for (let i = 0; i < this.meshes.length; i++) {
      this.meshes[i].count = counts[i];
      this.meshes[i].instanceMatrix.needsUpdate = true;
    }
  }
}

function yawQuat(h) {
  return { x: 0, y: Math.sin(h * 0.5), z: 0, w: Math.cos(h * 0.5) };
}

