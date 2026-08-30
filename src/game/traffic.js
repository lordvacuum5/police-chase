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
 * buildCarGeometry puts its origin at the car's centre of mass. The player's
 * car settles with that 0.47 m above the tarmac -- measured, not derived, since
 * it depends on how far the springs sag -- while the collider here is a plain
 * box centred on its own half height. Line the two up wrong and the traffic
 * either floats or drives around buried to the sills.
 */
const MESH_LIFT = 0.47 - CAR_H * 0.5;

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

/**
 * What limits how fast a car can change direction, and it is two things at
 * once -- which is the bit the first attempt at this got wrong.
 *
 * At speed it is grip: yaw rate times speed is lateral acceleration, so the
 * ceiling is a_lat / v. But at *low* speed that formula goes to infinity, and
 * clamping it to some large number is what left civilians spinning on the spot
 * at junctions. What actually stops a slow car turning quickly is the steering
 * lock: yaw rate is v / R, and R can never be smaller than the car's turning
 * circle. So the real limit is the lower of the two, and at a standstill it is
 * zero -- a stopped car cannot rotate at all, which is the whole point.
 */
const YAW_ACCEL = 5.5;        // m/s^2 of cornering grip
const MIN_RADIUS = 5.6;       // m, kerb to kerb -- an ordinary saloon

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
    //
    // Taken from where the car actually is, not dead-reckoned from its speed.
    // The two are the same only while it is going straight: the moment the
    // heading lags the lane -- which is every corner, now that the heading is
    // rate limited -- walking `along` forward by speed*dt drifts ahead of the
    // body, and the car ends up steering at a point it has already passed.
    // That drift is what put civilians on the pavement.
    this._reanchor(car);
    const past = car.dir > 0
      ? car.along > car.edge.length - 0.35
      : car.along < 0.35;
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
    const aim = this._aimAhead(car, look, laneOff);

    // ---- how fast is it allowed to be going ------------------------------
    let want = (car.edge.speed || 14) * car.pace;
    if (pull > 0) want = lerp(want, 2.5, pull);

    // Slow for the corner. Now that the heading is rate limited, a car that
    // arrives at a junction at road speed cannot physically turn into the new
    // road and simply runs wide onto the pavement -- which is what real cars
    // slowing down for corners is *for*. Turning through `err` over the
    // lookahead needs a yaw rate of err*v/look, and yaw rate times speed is
    // lateral acceleration, so the limit falls straight out as
    // v <= sqrt(a_lat * look / err).
    let err = Math.atan2(aim.x - t.x, aim.z - t.z) - car.heading;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    // Floored, because the yaw limit now scales with speed: let the corner cap
    // take a car to walking pace and it can no longer turn at all, and it sits
    // in the junction unable to get round.
    const corner = Math.sqrt(YAW_ACCEL * look / Math.max(Math.abs(err), 0.06));
    want = Math.min(want, Math.max(3.4, corner));

    // Traffic signals. Civilians always obey them -- they are the only road
    // users in the game that never have a reason not to.
    if (g.signals) {
      const node = g.graph.nodes[car.dir > 0 ? car.edge.b : car.edge.a];
      const d = g.signals.stopDistance(car.edge, node, t.x, t.z, car.speed);
      car.atRed = isFinite(d);
      if (car.atRed) want = Math.min(want, Math.sqrt(2 * BRAKE * Math.max(0, d - 1.2)));
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

    // Safety valve. Every jam here should clear on its own, but "should" is
    // not a guarantee across a whole town, and a deadlock that never breaks
    // would sit in the road for the rest of the run. A car that has not moved
    // for twenty seconds with a green light in front of it has found one, so
    // it leaves and the streaming puts another somewhere useful.
    car.stuckFor = car.speed < 0.4 && !car.atRed ? (car.stuckFor || 0) + dt : 0;
    if (car.stuckFor > 20) { car.dead = true; return; }

    // ---- point it, at a rate a car could actually turn -------------------
    //
    // Snapping the heading straight at the aim point is what made traffic look
    // like it teleported round corners: at a junction the aim jumps onto the
    // next road and the car rotates the whole way in one frame. A real car is
    // limited by grip, so the yaw rate it can hold is a_lat / speed -- fast
    // when it is crawling, slow when it is not. Floor and ceiling only stop
    // that going to infinity at a standstill.
    const maxYaw = Math.min(
      car.speed / MIN_RADIUS,                        // steering lock
      YAW_ACCEL / Math.max(car.speed, 0.5),          // grip
    );
    car.heading += clamp(err, -maxYaw * dt, maxYaw * dt);

    // Travel along the nose, not at the aim point, so it never crabs.
    const hx = Math.sin(car.heading), hz = Math.cos(car.heading);
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
      // Only follow somebody going roughly the same way.
      //
      // Without this, a car crossing a junction is briefly inside the box in
      // front of everyone waiting to cross the other way, so they all stop for
      // each other and the junction locks solid -- and then the queues behind
      // them lock, which is where the town-sized jams came from. Right of way
      // at a junction is the traffic lights' job, not the follow distance's.
      if (Math.cos(o.heading - car.heading) < 0.45) continue;
      test(o.position.x, o.position.z, CAR_W * 0.5);
    }
    // The player and the police are followed whichever way they are pointing:
    // one of them stopped across the road really is in the way.
    for (const v of this.game.vehicles) {
      test(v.position.x, v.position.z, v.spec.dims.w * 0.5);
    }
    return best;
  }

  /** Arc length of the point on this car's road nearest to where it is. */
  _reanchor(car) {
    const e = car.edge;
    const px = car.position.x, pz = car.position.z;
    let best = car.along, bd = Infinity, acc = 0;
    for (const s of e.segs) {
      const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
      const l2 = dx * dx + dz * dz || 1;
      let u = ((px - s.a.x) * dx + (pz - s.a.z) * dz) / l2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = s.a.x + dx * u - px, qz = s.a.z + dz * u - pz;
      const d = qx * qx + qz * qz;
      if (d < bd) { bd = d; best = acc + u * s.len; }
      acc += s.len;
    }
    car.along = best;
  }

  /**
   * The point to steer at, running onto the next road if the lookahead
   * overshoots the end of this one.
   *
   * Without this the aim point stays pinned to the end of the current edge
   * right up until the car arrives, and then jumps onto the new one -- so the
   * car drives straight at a junction and turns only once it is in it. Looking
   * *through* the junction is what makes it take a line into the corner.
   */
  _aimAhead(car, dist, laneOff) {
    let e = car.edge, dir = car.dir, s = car.along + dist * dir;
    const over = dir > 0 ? s - e.length : -s;
    if (over > 0) {
      const nxt = this._peekNext(car);
      if (nxt) {
        e = nxt.edge; dir = nxt.dir;
        s = dir > 0 ? Math.min(over, e.length) : Math.max(0, e.length - over);
        laneOff = e.width * 0.25 * DRIVE_SIDE;
      }
    }
    return this._lanePoint(e, s, dir, laneOff);
  }

  /**
   * Which way this car will go at the end of its road, decided once and
   * remembered -- so the road it aims into is the road it actually takes.
   */
  _peekNext(car) {
    if (car.nextEdge && !car.nextEdge.dead) {
      return { edge: car.nextEdge, dir: car.nextDir };
    }
    const g = this.game.graph;
    const nodeId = car.dir > 0 ? car.edge.b : car.edge.a;
    const node = g.nodes[nodeId];
    if (!node) return null;

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
    car.nextEdge = e;
    car.nextDir = e === car.edge ? -car.dir : (e.a === nodeId ? 1 : -1);
    return { edge: e, dir: car.nextDir };
  }

  /** Take the road already chosen by _peekNext. */
  _nextEdge(car) {
    const nxt = this._peekNext(car);
    if (!nxt) return false;
    const over = car.dir > 0 ? car.along - car.edge.length : -car.along;
    car.edge = nxt.edge;
    car.dir = nxt.dir;
    // Carry the overshoot through, rather than restarting at the kerb: a car
    // doing 15 m/s covers a quarter of a metre a frame, and dropping that each
    // time it changes road is a stutter at every junction.
    car.along = nxt.dir > 0
      ? clamp(over, 0, nxt.edge.length)
      : clamp(nxt.edge.length - over, 0, nxt.edge.length);
    car.lane = nxt.edge.width * 0.25 * DRIVE_SIDE;
    car.nextEdge = null;
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

  /**
   * Copy the bodies onto the instanced meshes.
   *
   * Called from the render pass, not from update: update runs before the
   * physics step, so syncing there draws the traffic a frame behind the
   * player and the police, which reads as the whole lot juddering.
   */
  syncVisuals() {
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

