// Haldon Vale, lived in: work going on, birds, and lights at night.
//
// "I just want to add a bit more life to the map. I love this map so much."
// Of the ideas put to them they picked four:
//
//   * work vehicles -- tractors on the lanes, dump trucks in the quarry, one
//     down the track and one up the haul road;
//   * a harvest -- a combine working a wheat field, and a tractor and trailer
//     loaded with bales standing by a field of them;
//   * birds -- flocks in the woods that go up when a car or the helicopter
//     comes by, wheel round, and settle again;
//   * the evening -- at night the houses' windows are lit, and the train's.
//
// And asked how it would bear on the police and the traffic: "I don't want it
// to affect how many police cars there are." None of it does. The vehicles
// here are not cars in the game's sense -- no engine, tyres, AI or network
// traffic, nothing the police limit or the traffic count sees. Each is a
// kinematic body moved along a fixed route by the clock, as the train is: the
// cost of one is a pose a step, not a simulated car. They are solid, and the
// AI's drivers queue behind them like any slow car (`movers`, passed to
// Driver.carInWay).
//
// Their timetable is the wall clock, as the train's is, so every machine in a
// game sees the same tractor in the same place without being told.

import * as THREE from 'three';
import { GROUP, groups, RAPIER, addStaticBox } from '../physics/world.js';
import { rand, randInt, clamp, lerp, TAU } from '../util/math.js';
import { MeshBuilder, vertexColorMaterial } from './common.js';
import { HILL_SINK } from './terrain.js';
import { GLTFLoader } from '../../vendor/addons/loaders/GLTFLoader.js';

/** How many tractors on the lanes, how fast, m/s. */
const TRACTORS = 3;
const TRACTOR_SPEED = 7;
/** A tractor's loop of lanes: how long, m, and how far left of the middle it keeps. */
const LOOP_MIN = 600;
const LOOP_MAX = 4500;
const TRACTOR_LANE = 2.2;
/** Round a loop's corners: the most sideways pull, and braking or pulling away, m/s^2. */
const LOOP_LAT = 1.5;
const LOOP_ACCEL = 1;
/** Dump trucks, m/s; the combine, m/s. */
const TRUCK_SPEED = 6;
const COMBINE_SPEED = 2.5;
/** How tight each turns round at the end of its route, m: a radius, swung out to the side with room. */
const TURN_TRACTOR = 6;
const TURN_TRUCK = 10;
const TURN_COMBINE = 8;
/** A working vehicle's weight, kg: the police van's (game/vehicles.js). */
const VAN_MASS = 3400;
/** The parked trailer with its bales, kg. */
const PARKED_TRAILER_MASS = 3000;
/** The dump trucks and the combine: heavier, still not walls. */
const TRUCK_MASS = 9000;
const COMBINE_MASS = 7000;
/** How fast one knocked off its line gets back on it, m/s; how far off it is simply put back, m. */
const RECOVER = 3;
/** The most its tyres can change its speed across the ground, m/s^2: about 1 g. */
const GRIP_ACCEL = 10;
const ADRIFT = 12;
/** The most a working vehicle's wheels steer, radians. */
const STEER_MAX = 0.6;
/** The steepest a working vehicle is ever pitched, radians. */
const PITCH_MAX = 0.4;
/** How far a quarry bale is kept from anywhere a truck drives, m. */
const BALE_CLEAR = 8;
/** How far the trucks keep from the quarry floor's jumps, m. */
const JUMP_CLEAR = 5;
/** Where the parked tractor stands ahead of its trailer's middle, m: hitched. */
const HITCH = 6.85;
/** Birds: how many flocks, how many to a flock, and what puts them up, m. */
const FLOCKS = 10;
const FLOCK_SIZE = 14;
const SCARE_CAR = 40;
const SCARE_AIR = 80;
/** Seconds in the air before a flock comes down again. */
const FLOCK_UP = 14;

// =====================================================================
//  Routes and movers
// =====================================================================

/** A polyline with its distances; points may carry their own height `y`. */
class Route {
  /** `loop`: closed, its end joined back to its start, and `s` taken round it. */
  constructor(points, loop = false) {
    this.loop = loop;
    if (loop) points = points.concat([points[0]]);
    this.p = points;
    this.s = [0];
    for (let i = 1; i < points.length; i++) {
      this.s.push(this.s[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    }
    this.len = this.s[this.s.length - 1];
  }

  /** Where `s` along it is: x, z, and y if the route knows it. */
  at(s) {
    const S = this.s, P = this.p;
    s = this.loop ? ((s % this.len) + this.len) % this.len : clamp(s, 0, this.len);
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
    const a = P[lo], b = P[Math.min(lo + 1, P.length - 1)];
    const t = (s - S[lo]) / ((S[lo + 1] - S[lo]) || 1);
    return {
      x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t),
      y: a.y !== undefined ? lerp(a.y, b.y, t) : undefined,
    };
  }

  /** Which way it runs at `s`, smoothed over a few metres either side so a corner is a turn, not a snap. */
  heading(s) {
    const a = this.at(s - 3), b = this.at(s + 3);
    return Math.atan2(b.x - a.x, b.z - a.z);
  }
}

/**
 * Something that drives a route, there and back, for ever: a kinematic body
 * in GROUP.BUILDING (the AI's sweeps see it, and brake), drawn as `geo`. To
 * the AI's queueing it looks like a car: position, linvel, speed, forward,
 * spec.dims.
 */
class Mover {
  constructor(ctx, scene, { route, speed, lane = 0, geo, dims, colliders, offset = 0, name, turnR = 6, avoid = null, model = null, paint = null, turnY = null, mass = VAN_MASS }) {
    this.model = model;
    this.paint = paint;
    this.ctx = ctx;
    this.route = route;
    this.speed0 = speed;
    this.lane = lane;
    this.offset = offset;
    this.leg = route.len / speed;
    // Turning round at each end: half a circle of turnR, at a little over half speed.
    this.turnR = turnR;
    this.turnY = turnY;
    this.turnTime = (Math.PI * turnR) / (speed * 0.6);
    this.cycle = 2 * (this.leg + this.turnTime);
    // Round a loop there is no turning: once round is the whole cycle.
    if (route.loop) { this._timeLoop(); this.turnTime = 0; } else this._planTurns(avoid);
    this.position = new THREE.Vector3(0, -60, 0);
    this.linvel = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.speed = 0;
    this.spec = { dims: dims };
    this.mesh = new THREE.Mesh(geo, vertexColorMaterial());
    this.mesh.castShadow = true;
    this.mesh.name = name;
    scene.add(this.mesh);
    const W = ctx.sim.world;
    // Heavy, not immovable. "It's more like a the resistance and how it acts
    // when you hit it is more like a police van." It was a kinematic body --
    // infinite mass, so a car met it like a wall and stopped dead. Now it has
    // a weight, the police van's for a tractor, and is steered along its
    // route by its velocity (see step): hit, it gives, and gets back on line
    // at no more than RECOVER. It meets only what moves -- cars and loose
    // things -- so the ground and the quarry's rock it drives on cannot push it
    // about, and nothing else changes: it is still GROUP.BUILDING to the AI's
    // eyes and sweeps.
    this.body = W.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -60, 0)
      .setGravityScale(0).lockRotations().setCanSleep(false).setLinearDamping(0));
    for (const c of colliders) {
      W.createCollider(
        RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz).setTranslation(c.x || 0, c.y, c.z || 0)
          .setMass(mass / colliders.length)
          // Slippery enough to get out from: "the combine harvester ... was
          // pushing me and I couldn't actually get free of it."
          .setFriction(0.25).setCollisionGroups(groups(GROUP.BUILDING, GROUP.VEHICLE | GROUP.DEBRIS)),
        this.body,
      );
    }
    this.placed = false;
  }

  /**
   * A loop's timetable: slower round the corners, as a driver takes them --
   * no more than LOOP_LAT of sideways pull, braking and pulling away at
   * LOOP_ACCEL -- so a junction the loop turns sharply at is taken at a
   * crawl, not swung round at full speed. `_ts`/`_tt`: distance and time.
   */
  _timeLoop() {
    const r = this.route, step = 2, n = Math.ceil(r.len / step);
    const v = [];
    for (let i = 0; i < n; i++) {
      const s = i * step;
      let dh = r.heading(s + 4) - r.heading(s - 4);
      dh = Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh)));
      const radius = dh > 1e-3 ? 8 / dh : Infinity;
      v.push(Math.max(1.2, Math.min(this.speed0, Math.sqrt(LOOP_LAT * radius))));
    }
    // Braking into a corner and pulling away after it, round the loop twice so
    // the join is right too.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * LOOP_ACCEL * step)); }
      for (let i = n - 1; i >= 0; i--) { const j = (i - 1 + n) % n; v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * LOOP_ACCEL * step)); }
    }
    this._ts = [0]; this._tt = [0];
    for (let i = 0; i < n; i++) {
      this._ts.push(Math.min(r.len, (i + 1) * step));
      this._tt.push(this._tt[i] + step / ((v[i] + v[(i + 1) % n]) / 2));
    }
    this.cycle = this.leg = this._tt[n];
  }

  /** Where it is at time t: { x, y, z, heading }. */
  /**
   * How it turns round at each end: which way it swings (+1 right, -1 left),
   * and where it starts the turn. It swings to whichever side has the room --
   * not into the quarry's rock, not off a ledge, not into the drop -- and on a
   * lane, other things equal, to the right, as a driver does.
   */
  _planTurns(avoid) {
    const r = this.route, R = this.turnR;
    this.ends = [r.len, 0].map((s, k) => {
      const dir = k === 0 ? 1 : -1;
      const S = this._laneAt(s, dir, this.lane);
      const f = this._fwd(s, dir), rt = { x: f.z, z: -f.x };
      const yEnd = r.at(s).y !== undefined ? r.at(s).y : this.ctx.at(S.x, S.z);
      let best = 1, bestScore = Infinity;
      for (const side of [1, -1]) {
        let score = side > 0 ? 0 : 0.5;
        // The half circle, and the way back after it while still swung out
        // and easing in: the quarry's truck turned clear of the haul road
        // and then drove back up through the foot of it.
        for (const [u, v] of [[1, 1], [0, 2], [0.7, 1.7], [-1, 1.9], [-2, 1.6], [-3, 1.2]]) {
          const x = S.x + f.x * R * u + rt.x * side * R * v, z = S.z + f.z * R * u + rt.z * side * R * v;
          if (avoid && avoid(x, z)) score += 100;
          score += Math.abs(this.ctx.at(x, z) - yEnd);
        }
        if (score < bestScore) { bestScore = score; best = side; }
      }
      return { s, dir, side: best, y: r.at(s).y };
    });
  }

  /** The route's forward at `s`, the way `dir` goes. */
  _fwd(s, dir) {
    const h = this.route.heading(s);
    return { x: Math.sin(h) * dir, z: Math.cos(h) * dir };
  }

  /** `off` metres to the left of the route at `s`, going `dir`. */
  _laneAt(s, dir, off) {
    const at = this.route.at(s), f = this._fwd(s, dir);
    return { x: at.x - f.z * off, z: at.z + f.x * off, y: at.y };
  }

  pose(t) {
    // Easing back from the swing over a stretch long for how far it swung:
    // over a fixed 14 m a truck swung twenty metres wide came back nearly
    // sideways, turning at 177 degrees a second.
    const r = this.route, R = this.turnR, B = Math.max(14, 2.5 * (2 * R + 2 * this.lane));
    const p = (((t + this.offset) % this.cycle) + this.cycle) % this.cycle;
    if (r.loop) {
      const T = this._tt, S = this._ts;
      let lo = 0, hi = T.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= p) lo = m; else hi = m; }
      const s = lerp(S[lo], S[hi], (p - T[lo]) / ((T[hi] - T[lo]) || 1)), at = r.at(s);
      return { x: at.x, y: this.ctx.at(at.x, at.z), z: at.z, heading: r.heading(s), moving: true, slope: null };
    }
    const legs = [
      { from: 0, end: this.ends[1] },               // out, after turning at the start
      { from: this.leg + this.turnTime, end: this.ends[0] },
    ];
    let leg = -1, turn = -1, tau = 0;
    if (p < this.leg) { leg = 0; tau = p; }
    else if (p < this.leg + this.turnTime) { turn = 0; tau = (p - this.leg) / this.turnTime; }
    else if (p < 2 * this.leg + this.turnTime) { leg = 1; tau = p - this.leg - this.turnTime; }
    else { turn = 1; tau = (p - 2 * this.leg - this.turnTime) / this.turnTime; }
    if (leg >= 0) {
      const dir = leg === 0 ? 1 : -1;
      const travelled = tau * this.speed0;
      const s = leg === 0 ? travelled : r.len - travelled;
      // Coming out of the last turn swung wide, and easing back to its own
      // side of the road over the first B metres.
      const prev = legs[leg].end;
      const swung = prev.side * 2 * R - this.lane;
      const u = smooth(clamp(travelled / B, 0, 1));
      const off = lerp(swung, this.lane, u);
      const at = this._laneAt(s, dir, off);
      let h = r.heading(s) + (dir < 0 ? Math.PI : 0);
      // Turned a little toward where it is easing to.
      if (u < 1) h -= Math.atan(((this.lane - swung) * 6 * (travelled / B) * (1 - travelled / B)) / B);
      let y = at.y !== undefined ? at.y : this.ctx.at(at.x, at.z);
      let slope = null;
      if (at.y !== undefined) {
        const ahead = r.at(s + 3), behind = r.at(s - 3);
        slope = ((ahead.y - behind.y) / 6) * dir;
      }
      // Swung out over ground the route's own heights know nothing about.
      if (this.turnY && u < 1) {
        const gy = this.turnY(at.x, at.z, y);
        if (gy !== y) { y = gy; slope = null; }
      }
      return { x: at.x, y, z: at.z, heading: h, moving: true, slope };
    }
    // Turning round: half a circle of radius R, swung out to the side with
    // room, from its own side of the road to facing back the way it came.
    const e = this.ends[turn];
    const S = this._laneAt(e.s, e.dir, this.lane);
    const f = this._fwd(e.s, e.dir), rt = { x: f.z, z: -f.x };
    const phi = Math.PI * tau;
    const cx = S.x + rt.x * e.side * R, cz = S.z + rt.z * e.side * R;
    const x = cx - rt.x * e.side * R * Math.cos(phi) + f.x * R * Math.sin(phi);
    const z = cz - rt.z * e.side * R * Math.cos(phi) + f.z * R * Math.sin(phi);
    const dx = rt.x * e.side * Math.sin(phi) + f.x * Math.cos(phi), dz = rt.z * e.side * Math.sin(phi) + f.z * Math.cos(phi);
    // On a route that knows its heights (the haul road), level at the height
    // of its end: at the top that is the rim, over rock the height grid has
    // as the floor far below.
    // Or, where it says, the ground under it: the haul truck's turn out on the
    // field, which slopes.
    const y = this.turnY ? this.turnY(x, z, e.y) : e.y !== undefined ? e.y : this.ctx.at(x, z);
    return { x, y, z, heading: Math.atan2(dx, dz), moving: true, slope: null };
  }

  step(t, dt) {
    const a = this.pose(t);
    // Pitched to the ground under its ends.
    const fx = Math.sin(a.heading), fz = Math.cos(a.heading), half = this.spec.dims.l * 0.35;
    // The ground under its ends is whatever it drives on (turnY) where that is
    // given, and never steeper than a vehicle could stand on. "When it turns
    // around ... and then it comes off the grass onto the actual start of the
    // quarry track, it tilts like 90 degrees forward and then uprights
    // itself": by the rim the height grid under its nose is the quarry floor,
    // thirty metres down.
    const gy = (x, z) => (this.turnY ? this.turnY(x, z, this.ctx.at(x, z)) : this.ctx.at(x, z));
    const pitch = clamp(a.slope !== null ? Math.atan(a.slope)
      : Math.atan2(gy(a.x + fx * half, a.z + fz * half) - gy(a.x - fx * half, a.z - fz * half), half * 2), -PITCH_MAX, PITCH_MAX);
    _e.set(-pitch, a.heading, 0, 'YXZ');
    _q.setFromEuler(_e);
    const pos = { x: a.x, y: a.y, z: a.z }, rot = { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
    this.dist = (this.dist || 0) + this.speed0 * dt;
    if (dt > 0) this.linvel.set((a.x - this.position.x) / dt, (a.y - this.position.y) / dt, (a.z - this.position.z) / dt);
    if (this.linvel.length() > 40) this.linvel.set(0, 0, 0);
    const cur = this.body.translation();
    if (!this.placed || !(dt > 0) || Math.hypot(cur.x - pos.x, cur.y - pos.y, cur.z - pos.z) > ADRIFT) {
      // Placed, or put back if knocked hopelessly far off its line.
      this.body.setTranslation(pos, true);
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.placed = true;
    } else {
      // What it wants: its route's own speed, and whatever closes the gap to
      // where it should be by the end of this step, the closing held to
      // RECOVER. What it gets, across the ground: no more change than its
      // tyres could make, GRIP_ACCEL. Setting the velocity outright put it
      // back on line in the very next step, so a car hitting it still met a
      // wall -- shoved 3 cm by 50 km/h.
      let cx = (pos.x - cur.x) / dt - this.linvel.x, cz = (pos.z - cur.z) / dt - this.linvel.z;
      const c = Math.hypot(cx, cz);
      if (c > RECOVER) { cx *= RECOVER / c; cz *= RECOVER / c; }
      const now = this.body.linvel();
      let dx = this.linvel.x + cx - now.x, dz = this.linvel.z + cz - now.z;
      const d = Math.hypot(dx, dz), most = GRIP_ACCEL * dt;
      if (d > most) { dx *= most / d; dz *= most / d; }
      // Up and down it follows the route, at no more than RECOVER too: pushed
      // down by a car on top of it and put back up in one step, it launched
      // the car.
      const vy = this.linvel.y + clamp((pos.y - cur.y) / dt - this.linvel.y, -RECOVER, RECOVER);
      this.body.setLinvel({ x: now.x + dx, y: vy, z: now.z + dz }, true);
    }
    this.body.setRotation(rot, true);
    // How hard it is turning, for the steered wheels (draw): the angle a
    // wheelbase needs to turn at this rate at this speed, eased in.
    if (dt > 0 && this._heading !== undefined) {
      let dh = a.heading - this._heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const v = Math.hypot(this.linvel.x, this.linvel.z);
      const want = v > 0.3 ? clamp(Math.atan((this.wheelbase || 3) * (dh / dt) / v), -STEER_MAX, STEER_MAX) : this.steer || 0;
      this.steer = lerp(this.steer || 0, want, 1 - Math.exp(-8 * dt));
    }
    this._heading = a.heading;
    this.position.set(a.x, a.y, a.z);
    this.forward.set(fx, 0, fz);
    this.speed = a.moving ? this.speed0 : 0;
  }

  draw() {
    const t = this.body.translation(), r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    // Wheels turning with the distance driven: modelled nose to -Z, so
    // rolling forward is a negative turn about x.
    // Steered ones turned as well: "the wheels don't actually turn, so it
    // turns really weird." The fronts, or a combine's rears, the other way.
    for (const w of this.wheels || []) {
      w.node.rotation.x = -this.dist / w.r;
      if (w.steer) w.node.rotation.y = w.steer * (this.steer || 0);
    }
  }

  /**
   * The player's own model in place of the boxes: hung under the body, turned
   * (modelled nose to -Z; bodies run nose to +Z), its paint the colour this
   * one was given, its wheels found by name to turn.
   */
  useModel(scene, paint) {
    const model = dressModel(scene, paint);
    this.mesh.geometry = new THREE.BufferGeometry();
    this.mesh.add(model);
    this.wheels = [];
    model.traverse((o) => {
      if (/^wheel_/.test(o.name)) {
        // Steered about the upright outside the roll: YXZ.
        const rear = this.model === 'combine';
        const steer = /front/.test(o.name) ? (rear ? 0 : 1) : (rear ? -1 : 0);
        if (steer) o.rotation.order = 'YXZ';
        this.wheels.push({ node: o, r: Math.max(0.3, o.position.y), steer, z: o.position.z });
      }
      // A combine's reel, which turns faster than its wheels, pulling the crop in.
      if (o.name === 'reel') this.wheels.push({ node: o, r: 0.35 });
    });
    const zs = this.wheels.filter((w) => w.z !== undefined).map((w) => w.z);
    if (zs.length) this.wheelbase = Math.max(1.5, Math.max(...zs) - Math.min(...zs));
  }
}

/** A clone of a loaded model, turned nose to +Z, shadows on, `paint` recoloured if given. */
function dressModel(scene, paint) {
  const model = scene.clone(true);
  model.rotation.y = Math.PI;
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    if (paint === undefined || paint === null) return;
    const swap = (m) => {
      if (!m || m.name !== 'paint') return m;
      const c = m.clone();
      c.color = new THREE.Color(paint);
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
  return model;
}

/**
 * The player's models (resources/models): "I'm gonna make the tractor now
 * with the trailer", then "the dump truck is in", then the combine. { tractor, trailer, truck, combine }
 * scenes, any of them null if missing -- the boxes stay for that one.
 */
async function loadLifeModels() {
  const loader = new GLTFLoader();
  const one = (n) => loader.loadAsync(`resources/models/${n}.glb`).then((g) => g.scene, () => null);
  const [tractor, trailer, truck, combine] = await Promise.all(['farm-tractor', 'farm-trailer', 'quarry-dump-truck', 'combine-harvester'].map(one));
  return { tractor, trailer, truck, combine };
}

const smooth = (t) => t * t * (3 - 2 * t);
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

// =====================================================================
//  The machines, drawn: local space, nose to +z, wheels on y = 0
// =====================================================================

function wheel(b, r, w, x, y, z, colour = 0x161616, hub = 0x8a8a8a) {
  const g = new THREE.CylinderGeometry(r, r, w, 14);
  b.addGeometry(g, new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x, y, z), colour);
  g.dispose();
  const h = new THREE.CylinderGeometry(r * 0.45, r * 0.45, w + 0.04, 10);
  b.addGeometry(h, new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x, y, z), hub);
  h.dispose();
}

/** A farm tractor, about 4 m long. */
function tractorGeometry(paint = 0xb3261e) {
  const b = new MeshBuilder();
  b.addBox(1.2, 0.6, 3.4, 0, 0.95, 0.1, 0x2b2b2b);
  b.addBox(1.1, 0.9, 1.9, 0, 1.5, 0.95, paint);
  b.addBox(1.0, 0.25, 0.1, 0, 1.3, 1.92, 0x222222);
  for (const x of [-0.35, 0.35]) b.addBox(0.22, 0.14, 0.06, x, 1.62, 1.93, 0xfff6d8);
  b.addBox(1.9, 1.35, 1.7, 0, 2.2, -0.75, 0x1b2530);
  b.addBox(2.0, 0.14, 1.85, 0, 2.94, -0.75, paint);
  for (const x of [-0.93, 0.93]) for (const z of [-1.55, 0.05]) b.addBox(0.1, 1.4, 0.1, x, 2.2, z, paint);
  b.addBox(0.09, 0.9, 0.09, 0.35, 2.3, 1.45, 0x333333);
  b.addBox(2.1, 0.12, 0.6, 0, 1.75, -0.75, paint);
  wheel(b, 0.85, 0.5, -0.98, 0.85, -0.85, 0x161616, 0xd6b229);
  wheel(b, 0.85, 0.5, 0.98, 0.85, -0.85, 0x161616, 0xd6b229);
  wheel(b, 0.5, 0.34, -0.85, 0.5, 1.25, 0x161616, 0xd6b229);
  wheel(b, 0.5, 0.34, 0.85, 0.5, 1.25, 0x161616, 0xd6b229);
  return b.build();
}

/** A quarry dump truck, yellow, about 9 m long, with a load of the quarry's own stone. */
function truckGeometry() {
  const b = new MeshBuilder();
  const yel = 0xe0a800;
  b.addBox(2.6, 0.7, 8.4, 0, 1.4, 0, 0x2a2a2a);
  b.addBox(2.5, 1.9, 2.2, 0, 2.7, 3.15, yel);
  b.addBox(2.52, 0.75, 2.0, 0, 3.05, 3.2, 0x1b2530);
  b.addBox(2.3, 0.5, 0.15, 0, 1.7, 4.26, 0x333333);
  for (const x of [-0.85, 0.85]) b.addBox(0.3, 0.18, 0.08, x, 2.0, 4.28, 0xfff6d8);
  b.addTaperedBox(3.3, 2.0, 5.6, 0, 3.0, -1.3, yel, 1.08, 1.05);
  b.addTaperedBox(3.0, 0.7, 5.0, 0, 4.2, -1.3, 0x9c8a7c, 0.75, 0.8);
  b.addBox(0.12, 1.4, 0.12, 0.9, 4.2, 2.1, 0x333333);
  for (const z of [3.0, -1.1, -3.1]) {
    wheel(b, 1.0, 0.8, -1.4, 1.0, z);
    wheel(b, 1.0, 0.8, 1.4, 1.0, z);
  }
  return b.build();
}

/** A combine harvester, green, the cutting table out in front. */
function combineGeometry() {
  const b = new MeshBuilder();
  const green = 0x3a7d2a, yel = 0xd8b420;
  b.addBox(3.0, 2.6, 6.6, 0, 2.3, -0.6, green);
  b.addBox(2.7, 1.3, 3.2, 0, 4.25, -1.1, green);
  b.addBox(2.2, 1.6, 2.0, 0, 4.2, 2.2, 0x1b2530);
  b.addBox(2.4, 0.15, 2.2, 0, 5.05, 2.2, green);
  b.addBox(0.35, 0.35, 5.0, 1.9, 4.9, -0.6, green);
  b.addBox(1.4, 1.0, 2.2, 0, 1.0, 3.2, green);
  b.addBox(7.6, 0.8, 1.6, 0, 0.75, 4.6, yel);
  b.addBox(7.6, 0.1, 1.8, 0, 0.32, 4.7, 0x666666);
  const reel = new THREE.CylinderGeometry(0.55, 0.55, 7.2, 10);
  b.addGeometry(reel, new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, 1.7, 4.9), 0xb8352a);
  reel.dispose();
  for (const x of [-0.6, 0.6]) b.addBox(0.24, 0.16, 0.06, x, 3.6, 3.22, 0xfff6d8);
  wheel(b, 1.0, 0.75, -1.65, 1.0, 1.6);
  wheel(b, 1.0, 0.75, 1.65, 1.0, 1.6);
  wheel(b, 0.6, 0.45, -1.4, 0.6, -3.4);
  wheel(b, 0.6, 0.45, 1.4, 0.6, -3.4);
  return b.build();
}

// =====================================================================
//  Building it all
// =====================================================================

/**
 * Everything, on the finished map. `ctx.lrng` is its own random stream, so
 * nothing else on the map moves for it. Returns { meshes, movers, step,
 * update, setNight }.
 */
export function buildLife(ctx, scene, { fields, quarry, rail, combineField, baleField }) {
  const rng = ctx.lrng;
  const { graph } = ctx;
  const meshes = [];
  const movers = [];
  // Nowhere a vehicle may swing out to turn round, or a combine work: the
  // farmyards and villages (their buildings), and the quarry's rock.
  const avoid = (x, z) => nearBuildings(ctx, x, z)
    || (quarry && (inQuarryRock(quarry, x, z) || onHaulRoad(quarry, x, z) || onJump(quarry, x, z)));

  // ---- tractors on the lanes ----
  // Round loops of lanes, the way anything that drives goes about: "they
  // turn really weirdly. They need to turn more like proper vehicles." Each
  // drove one lane back and forth and spun a half circle at each end, out
  // through the hedges. Now a loop: a lane, and the quickest way round by
  // road from its far end back to its near one, kept on the left, its
  // junctions rounded as the traffic's are (RoadGraph.pathToPoints). Away from
  // the villages, the railway (a tractor on a crossing would be under the
  // train) and the quarry, and away from each other.
  const railEdges = new Set((rail && rail.cross ? rail.cross : []).map((c) => c.edge));
  const cands = graph.edges.filter((e) => !e.cut && !e.turningHead && !e.village && !e.farm && !e.aroad
    && (e.kind === 'track' || e.kind === 'country') && e.length > 120 && e.length < 900 && !railEdges.has(e.id)
    && !(quarry && Math.hypot(e.points[0].x - quarry.x, e.points[0].z - quarry.z) < quarry.r + 40));
  const taken = [];
  const paints = [0xb3261e, 0x2f6e2a, 0x2a5aa8];
  for (let tries = 0; tries < 200 && taken.length < TRACTORS && cands.length; tries++) {
    const e = cands[randInt(rng, 0, cands.length - 1)];
    const mid = e.points[Math.floor(e.points.length / 2)];
    if (taken.some((m) => Math.hypot(m.x - mid.x, m.z - mid.z) < 400)) continue;
    const pts = tractorLoop(graph, e, railEdges, quarry);
    if (!pts) continue;
    taken.push(mid);
    movers.push(new Mover(ctx, scene, {
      route: new Route(pts, true), speed: TRACTOR_SPEED, offset: rand(rng, 0, 500), name: 'tractor', turnR: TURN_TRACTOR, avoid,
      geo: tractorGeometry(paints[taken.length - 1]), dims: { l: 4.2, w: 2.3 }, model: 'tractor', paint: paints[taken.length - 1],
      colliders: [{ hx: 1.1, hy: 1.3, hz: 2.0, y: 1.35 }],
    }));
  }

  // ---- dump trucks in the quarry ----
  if (quarry && quarry.track && quarry.haulPath) {
    movers.push(new Mover(ctx, scene, {
      route: new Route(acrossFloor(quarry)), speed: TRUCK_SPEED, offset: rand(rng, 0, 300), name: 'dump-truck', turnR: TURN_TRUCK, avoid,
      geo: truckGeometry(), dims: { l: 9, w: 3.4 }, model: 'truck',
      colliders: [{ hx: 1.7, hy: 2.1, hz: 4.4, y: 2.1 }], mass: TRUCK_MASS,
    }));
    movers.push(new Mover(ctx, scene, {
      route: new Route(haulRun(ctx, quarry)), speed: TRUCK_SPEED * 0.8, offset: rand(rng, 0, 300), name: 'dump-truck', turnR: TURN_TRUCK, avoid,
      // Past the rock, the field; on the top of it, the rim; below, the road's own.
      turnY: (x, z, y) => {
        const d = Math.hypot(x - quarry.x, z - quarry.z);
        if (d > quarry.rimOut) return ctx.at(x, z);
        return d > quarry.rimIn ? quarry.rimAt(Math.atan2(z - quarry.z, x - quarry.x)) : y;
      },
      geo: truckGeometry(), dims: { l: 9, w: 3.4 }, model: 'truck',
      colliders: [{ hx: 1.7, hy: 2.1, hz: 4.4, y: 2.1 }], mass: TRUCK_MASS,
    }));
  }

  // ---- the harvest ----
  if (combineField) {
    const route = combineRoute(ctx, fields, combineField, rng);
    if (route) {
      movers.push(new Mover(ctx, scene, {
        route, speed: COMBINE_SPEED, offset: rand(rng, 0, 300), name: 'combine', turnR: TURN_COMBINE, avoid,
        geo: combineGeometry(), dims: { l: 11.5, w: 7.5 }, model: 'combine',
        // Shaped to the player's model: the body, and the header out in front.
        colliders: [{ hx: 1.75, hy: 2.1, hz: 4.85, y: 2.1, z: 0.25 }, { hx: 3.75, hy: 0.6, hz: 0.6, y: 0.9, z: 5.65 }], mass: COMBINE_MASS,
      }));
    }
  }
  if (quarry) clearQuarryBales(ctx, quarry, movers);
  const parked = baleField ? baleTrailer(ctx, baleField, fields) : null;
  if (parked) meshes.push(parked);
  // The player's models, when they load, in place of the boxes.
  loadLifeModels().then((m) => {
    for (const v of movers) if (v.model && m[v.model]) v.useModel(m[v.model], v.paint);
    if (parked) {
      const { trailer, tractor } = parked.userData;
      if (m.trailer) { trailer.geometry = new THREE.BufferGeometry(); trailer.add(dressModel(m.trailer)); }
      if (m.tractor) { tractor.geometry = new THREE.BufferGeometry(); tractor.add(dressModel(m.tractor, 0x2f6e2a)); }
    }
  });

  // ---- birds ----
  const birds = buildBirds(ctx, scene, fields, rng);
  meshes.push(birds.mesh);

  // ---- windows ----
  const windows = buildWindows(ctx);
  meshes.push(windows.mesh);

  for (const m of meshes) scene.add(m);

  let clock = (Date.now() / 1000) % 100000;
  return {
    movers,
    step(dt) {
      clock += dt;
      for (const m of movers) m.step(clock, dt);
    },
    update(game) {
      for (const m of movers) m.draw();
      if (parked) parked.userData.update();
      birds.update(game, clock);
    },
    setNight(on) { windows.setNight(on); },
    birds: birds.spots,
    parked,
  };
}

/**
 * Up and down a wheat field in rows nine metres apart, inside the field and
 * clear of its hedges and of the roads: a lawnmower's path, turned at the end
 * of each row into the next.
 */
function combineRoute(ctx, fields, seed, rng) {
  const a = rng() * Math.PI;
  const ux = Math.cos(a), uz = Math.sin(a), nx = -uz, nz = ux;
  const ok = (x, z) => {
    const n = fields.nearest(x, z);
    if (n.s !== seed || n.edge < 7) return false;
    if (nearBuildings(ctx, x, z)) return false;
    if (ctx.clearAt && ctx.clearAt(x, z)) return false;
    const r = ctx.graph.nearestEdge(x, z, 20);
    return !r || r.dist > r.edge.width * 0.5 + 8;
  };
  const pts = [];
  let flip = false;
  for (let o = -54; o <= 54; o += 9) {
    let best = null, run = [];
    for (let t = -90; t <= 90; t += 3) {
      const x = seed.x + ux * t + nx * o, z = seed.z + uz * t + nz * o;
      if (ok(x, z)) run.push({ x, z });
      else { if (!best || run.length > best.length) best = run; run = []; }
    }
    if (!best || run.length > best.length) best = run;
    if (best.length < 9) continue;
    if (flip) best.reverse();
    flip = !flip;
    // Round from the end of one row into the next on a half circle, ahead of
    // the row's end, as a combine turns on the headland -- joined straight,
    // it snapped round at 229 degrees a second.
    if (pts.length) {
      const e = pts[pts.length - 1], s = best[0];
      const mx = (e.x + s.x) / 2, mz = (e.z + s.z) / 2, half = Math.hypot(s.x - e.x, s.z - e.z) / 2;
      const p0 = pts[Math.max(0, pts.length - 2)];
      const fl = Math.hypot(e.x - p0.x, e.z - p0.z) || 1;
      const fx = (e.x - p0.x) / fl, fz = (e.z - p0.z) / fl;
      for (let k = 1; k < 8; k++) {
        const th = (Math.PI * k) / 8;
        pts.push({ x: mx + (e.x - mx) * Math.cos(th) + fx * half * Math.sin(th), z: mz + (e.z - mz) * Math.cos(th) + fz * half * Math.sin(th) });
      }
    }
    pts.push(...best);
  }
  return pts.length > 10 ? new Route(pts) : null;
}

/** A tractor and a flatbed trailer stacked with round bales, standing by a field of them. */
function baleTrailer(ctx, seed, fields) {
  const b = new MeshBuilder();
  const W = ctx.sim.world;
  // Off to one side of the bale rows, inside the field.
  let x = seed.x, z = seed.z, rot = 0;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * TAU;
    const px = seed.x + Math.cos(a) * 20, pz = seed.z + Math.sin(a) * 20;
    const n = fields.nearest(px, pz);
    if (n.s === seed && n.edge > 8 && !nearBuildings(ctx, px, pz) && !ctx.graph.overlapsRoad(px, pz, 4, 12, a, 4)) { x = px; z = pz; rot = a + Math.PI / 2; break; }
  }
  const fx = Math.sin(rot), fz = Math.cos(rot);
  const g = ctx.at(x, z);
  // The trailer, in its own frame (nose to +z), then turned and placed.
  b.addBox(2.4, 0.3, 6.4, 0, 1.05, 0, 0x6e5a42);
  b.addBox(0.15, 0.15, 1.6, 0, 0.95, 3.6, 0x333333);
  for (const sx of [-1.25, 1.25]) for (const sz of [-1.0, 1.0]) wheel(b, 0.45, 0.3, sx, 0.45, sz);
  // The bales, apart from the trailer, so the trailer can be swapped for the
  // player's model and they stay on it.
  const bb = new MeshBuilder();
  const bale = new THREE.CylinderGeometry(0.8, 0.8, 1.5, 14);
  for (let i = 0; i < 3; i++) {
    for (const s of [-0.75, 0.75]) {
      bb.addGeometry(bale, new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(s, 2.0, (i - 1) * 1.8), 0xb79a52);
    }
  }
  bale.dispose();
  const group = new THREE.Group();
  const trailer = new THREE.Mesh(b.build(), vertexColorMaterial());
  const bales = new THREE.Mesh(bb.build(), vertexColorMaterial());
  const tractor = new THREE.Mesh(tractorGeometry(0x2f6e2a), vertexColorMaterial());
  // Hitched: its tow bar at the trailer's drawbar eye, 4.8 m ahead of the deck's middle.
  tractor.position.z = HITCH;
  for (const m of [trailer, bales, tractor]) { m.castShadow = true; group.add(m); }
  group.position.set(x, g, z);
  group.rotation.y = rot;
  group.name = 'bale-trailer';
  // One loose body, tractor and trailer together, on its brakes: a car shoves
  // it rather than stopping dead against it. "The tractor ... is more like a
  // police van" was said of the ones driving about; this one was two static
  // boxes and still a wall. The weight of the van for the tractor and as much
  // again for the loaded trailer, turning about the upright only (it does not
  // tip), asleep until hit. It rests on the hills' collider, sunk HILL_SINK
  // under the drawn ground, so it is drawn lifted by that (see update).
  const lift = (px, pz) => { const h = ctx.at(px, pz); return h < 0 ? HILL_SINK : h - Math.max(0, h - HILL_SINK); };
  const body = W.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, g - lift(x, z) + 1.45, z)
    .setRotation({ x: 0, y: Math.sin(rot / 2), z: 0, w: Math.cos(rot / 2) })
    .enabledRotations(false, true, false)
    .setLinearDamping(0.5).setAngularDamping(1.5));
  const parts = [
    { hx: 1.3, hy: 1.4, hz: 3.2, z: 0, mass: PARKED_TRAILER_MASS },
    { hx: 1.1, hy: 1.4, hz: 2.0, z: HITCH, mass: VAN_MASS },
  ];
  for (const c of parts) {
    W.createCollider(
      RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz).setTranslation(0, 0, c.z).setMass(c.mass)
        // Its brakes on: hard to push, and it stops when you stop.
        .setFriction(0.9).setRestitution(0.05)
        .setCollisionGroups(groups(GROUP.BUILDING, GROUP.TERRAIN | GROUP.HILL | GROUP.STREET | GROUP.VEHICLE | GROUP.DEBRIS)),
      body,
    );
  }
  body.sleep();
  group.userData.trailer = trailer;
  group.userData.tractor = tractor;
  const q = new THREE.Quaternion();
  group.userData.update = () => {
    if (body.isSleeping()) return;
    const t = body.translation(), r = body.rotation();
    group.position.set(t.x, t.y - 1.45 + lift(t.x, t.z), t.z);
    group.quaternion.copy(q.set(r.x, r.y, r.z, r.w));
  };
  group.userData.body = body;
  return group;
}

// =====================================================================
//  Birds
// =====================================================================

/**
 * Flocks in the woods. Unseen while they sit; when a car comes within
 * SCARE_CAR, or the helicopter within SCARE_AIR, they go up out of the trees
 * together, wheel round over the wood flapping, and after FLOCK_UP seconds
 * with nothing more to frighten them, come down and vanish into the trees.
 * One instanced mesh for every bird on the map.
 */
function buildBirds(ctx, scene, fields, rng) {
  const spots = [];
  for (const w of fields.woods) {
    for (let k = 0; k < 2 && spots.length < FLOCKS; k++) {
      const a = rng() * TAU, r = rand(rng, 20, 90);
      const x = w.x + Math.cos(a) * r, z = w.z + Math.sin(a) * r;
      spots.push({ x, z, y: ctx.at(x, z) + 12, upAt: -1e9, last: -1e9, phase: rng() * TAU, dir: rng() < 0.5 ? 1 : -1 });
    }
  }
  // A bird: two wings in a shallow V, 0.7 m across.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0.12, -0.35, 0.06, -0.08, 0, 0, -0.12,
    0, 0, 0.12, 0, 0, -0.12, 0.35, 0.06, -0.08,
  ], 3));
  geo.computeVertexNormals();
  const n = spots.length * FLOCK_SIZE;
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0x15171a, side: THREE.DoubleSide }), Math.max(1, n));
  mesh.count = n;
  mesh.frustumCulled = false;
  mesh.name = 'birds';
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < n; i++) mesh.setMatrixAt(i, zero);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), e = new THREE.Euler();
  const update = (game, t) => {
    if (!game) return;
    let dirty = false;
    for (let f = 0; f < spots.length; f++) {
      const sp = spots[f];
      // Frightened?
      let scare = false;
      for (const v of game.vehicles) {
        if (v.speed > 2 && Math.hypot(v.position.x - sp.x, v.position.z - sp.z) < SCARE_CAR) { scare = true; break; }
      }
      const air = game.aircraft || (game.helicopter && game.helicopter.active ? game.helicopter.pos : null);
      const ap = air && (air.position || air);
      if (!scare && ap && Math.hypot(ap.x - sp.x, ap.z - sp.z) < SCARE_AIR) scare = true;
      if (scare) {
        if (t - sp.last > FLOCK_UP + 4) sp.upAt = t;
        sp.last = t;
      }
      const up = t - sp.upAt;
      const flying = t - sp.last < FLOCK_UP && up >= 0;
      // Coming down at the end: the last four seconds.
      const settle = clamp((t - sp.last - (FLOCK_UP - 4)) / 4, 0, 1);
      if (!flying && !sp.shown) continue;
      dirty = true;
      sp.shown = flying;
      for (let i = 0; i < FLOCK_SIZE; i++) {
        const k = f * FLOCK_SIZE + i;
        if (!flying) { mesh.setMatrixAt(k, zero); continue; }
        const ph = sp.phase + i * 0.45;
        const climb = clamp(up / 2.5, 0, 1) * (1 - settle);
        const r = (14 + (i % 5) * 3) * climb + 2;
        const a = ph + sp.dir * up * 0.7;
        p.set(sp.x + Math.cos(a) * r, sp.y + climb * (10 + Math.sin(up * 0.9 + i) * 3) - 4 * (1 - climb), sp.z + Math.sin(a) * r);
        e.set(0, -a + (sp.dir > 0 ? 0 : Math.PI), Math.sin(up * 2 + i) * 0.3);
        q.setFromEuler(e);
        const flap = 0.35 + 0.65 * Math.abs(Math.sin(up * 11 + i * 1.7));
        s.set(1.6 * flap, 1.6, 1.6);
        m.compose(p, q, s);
        mesh.setMatrixAt(k, m);
      }
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
  };
  return { mesh, update, spots };
}

// =====================================================================
//  Windows
// =====================================================================

/**
 * A window or two on the front and back of every house, dark glass by day.
 * At night most of them are lit: "the village windows light up". One mesh;
 * night swaps its material for an unlit one and its colours to warm light,
 * leaving about a third dark.
 */
function buildWindows(ctx) {
  const b = new MeshBuilder();
  const lit = [];
  const rng = ctx.lrng;
  for (const h of ctx.houses || []) {
    const n = Math.max(1, Math.floor(h.w / 2.6));
    const floors = h.h > 5.5 ? [1.5, h.h - 1.7] : [1.6];
    const cs = Math.cos(h.rot), sn = Math.sin(h.rot), fx = Math.sin(h.rot), fz = Math.cos(h.rot);
    for (const side of [-1, 1]) {
      for (const y of floors) {
        for (let i = 0; i < n; i++) {
          const lx = (i - (n - 1) / 2) * (h.w / n);
          const lz = side * (h.d * 0.5 + 0.03);
          const x = h.x + cs * lx + fx * lz, z = h.z - sn * lx + fz * lz;
          const v0 = b.vertexCount;
          b.addBox(0.9, 1.1, 0.06, x, h.at + y, z, 0x1a2129, h.rot);
          lit.push([v0, b.vertexCount, rng() < 0.68]);
        }
      }
    }
  }
  const geo = b.build();
  const day = vertexColorMaterial();
  const night = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  const mesh = new THREE.Mesh(geo, day);
  mesh.name = 'windows';
  const col = geo.attributes.color;
  const warm = new THREE.Color(0xffc56b), glass = new THREE.Color(0x1a2129), dark = new THREE.Color(0x0c0f13);
  const setNight = (on) => {
    for (const [s, e, isLit] of lit) {
      const c = on ? (isLit ? warm : dark) : glass;
      for (let k = s; k < e; k++) col.setXYZ(k, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    mesh.material = on ? night : day;
  };
  return { mesh, setNight };
}

/**
 * Near a farmyard's or a village's buildings. Something drove through a farm
 * building: "I noticed it going through a building, like a farm building, at
 * one point". Nothing that moves here may come near one.
 */
function nearBuildings(ctx, x, z) {
  if (ctx.farms.some((f) => Math.hypot(f.x - x, f.z - z) < 48)) return true;
  return ctx.villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.r + 15);
}

/** In the quarry's rock: between the floor and the outside of the face. */
/**
 * A loop of road through `e`: along it, then the quickest way back from its
 * far end to its near one by any other road (the edge itself taken out of the
 * search for the moment). Kept on the left, junctions rounded. Null when
 * there is none of a tractor's length (LOOP_MIN-LOOP_MAX m), or it would use
 * a level crossing or the quarry's roads. Villages and A-roads are allowed,
 * as for any tractor: barred, 22 of the 29 lanes had no way round and only
 * two of the three tractors found a loop.
 * Started and ended half way along `e`, so the join is on a straight.
 */
function tractorLoop(graph, e, railEdges, quarry) {
  const wasCut = e.cut;
  e.cut = true;
  let back = null;
  try { back = graph.route(e.b, e.a); } finally { e.cut = wasCut; }
  if (!back || back.length < 3) return null;
  const nodes = [e.a, ...back];
  let len = e.length;
  for (let i = 1; i < back.length; i++) {
    const be = graph.edgeBetween(back[i - 1], back[i]);
    if (!be || be.quarry || be.cut || railEdges.has(be.id)) return null;
    len += be.length;
  }
  if (len < LOOP_MIN || len > LOOP_MAX) return null;
  // Round once and on along `e` again, so the corner at its start is rounded
  // too; then cut from half way along `e` to half way along it the next time.
  const raw = graph.pathToPoints([...nodes, e.b], TRACTOR_LANE, true, 14);
  const full = new Route(raw);
  const out = [];
  for (let s = e.length * 0.5; s < full.len - e.length * 0.5; s += 4) out.push(full.at(s));
  if (quarry && out.some((p) => Math.hypot(p.x - quarry.x, p.z - quarry.z) < quarry.r + 20)) return null;
  return out.length > 20 ? out : null;
}

/**
 * The bales on the quarry floor, moved off the trucks' way: "it goes straight
 * through the bales of hay, so just move the bales of hay somewhere else where
 * it won't go through them." Each one within BALE_CLEAR of anywhere a truck
 * goes -- its turns and swings included -- is moved to the nearest spot on
 * the floor that is clear of them all and of the other bales. They are the
 * last of `ctx.bales` (planQuarryEdge's, appended in countrygen.js).
 */
function clearQuarryBales(ctx, q, movers) {
  const extra = ctx.extraBales, bales = ctx.bales;
  if (!extra || !extra.length || !bales) return;
  const path = [];
  for (const m of movers) {
    for (let i = 0; i < 1200; i++) {
      const a = m.pose((i / 1200) * m.cycle);
      if (Math.hypot(a.x - q.x, a.z - q.z) < q.r) path.push(a);
    }
  }
  const clearOf = (x, z, others) => path.every((a) => (a.x - x) ** 2 + (a.z - z) ** 2 > BALE_CLEAR * BALE_CLEAR)
    && others.every((o) => (o.x - x) ** 2 + (o.z - z) ** 2 > 3.5 * 3.5)
    && Math.hypot(x - q.x, z - q.z) < (q.inner || q.r * 0.6) - 8;
  const bodies = bales.bodies.slice(bales.bodies.length - extra.length);
  const placed = bodies.map((b) => { const t = b.translation(); return { x: t.x, z: t.z }; });
  bodies.forEach((body, k) => {
    const t = body.translation(), others = placed.filter((_, j) => j !== k);
    if (clearOf(t.x, t.z, others)) return;
    for (let r = 3; r <= 40; r += 3) {
      for (let j = 0; j < 16; j++) {
        const a = (j / 16) * TAU, x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
        if (!clearOf(x, z, others)) continue;
        body.setTranslation({ x, y: t.y, z }, false);
        placed[k] = { x, z };
        return;
      }
    }
  });
  bales.update();
}

/**
 * On the haul road's ramps, above the floor: no place to swing out and turn
 * round on the flat. The track's truck turned at the floor into the foot of the
 * first rise and sat four metres inside it.
 */
function onHaulRoad(q, x, z) {
  if (!q.haulPath) return false;
  for (const p of q.haulPath) {
    if (p.y > q.floor + 0.5 && Math.hypot(p.x - x, p.z - z) < 6) return true;
  }
  return false;
}

/**
 * The haul road with somewhere flat at each end for its truck to turn round
 * and straighten up: in from the middle of the floor, and out past the rim
 * onto the field. "The quarry vehicles seem to drive up an invisible ramp
 * inside the quarry." The road started climbing the moment it began, so a
 * truck turned round at the bottom was still swung twenty metres out across
 * the floor when its height followed the road up -- 4.5 m into thin air -- and
 * at the top it turned out over the drop.
 */
function haulRun(ctx, q) {
  const H = q.haulPath, S = H[0], E = H[H.length - 1];
  const dirAt = (a, b) => { const l = Math.hypot(b.x - a.x, b.z - a.z) || 1; return { x: (b.x - a.x) / l, z: (b.z - a.z) / l }; };
  const bez = (A, K, B, n, y) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const u = i / n, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
      const x = a * A.x + b * K.x + c * B.x, z = a * A.z + b * K.z + c * B.z;
      out.push({ x, z, y: y(x, z) });
    }
    return out;
  };
  // In: from out on the floor, arriving along the first rise -- from the side
  // of the floor the first rise is on, off the line the other truck takes
  // across the middle (acrossFloor), so the two never meet.
  const t0 = dirAt(S, H[Math.min(H.length - 1, 8)]);
  const T = q.track[0], ux = q.x - T.x, uz = q.z - T.z, ul = Math.hypot(ux, uz) || 1;
  let nx = -uz / ul, nz = ux / ul;
  if (nx * (S.x - q.x) + nz * (S.z - q.z) < 0) { nx = -nx; nz = -nz; }
  // Further out than the other truck's turn in the middle swings (20 m).
  const C = { x: q.x + nx * 34, z: q.z + nz * 34 };
  const lead = bez(C, { x: S.x - t0.x * 15, z: S.z - t0.z * 15 }, S, 24, () => q.floor);
  // Out: turning off the last landing before its end -- past it, at the same
  // distance out, is the ledge below -- and away from the edge onto the field,
  // at the height of the rock's top (the top ledge is flush with it) until
  // past the rock, then the ground's.
  let k = H.length - 1;
  while (k > 0 && Math.hypot(H[k].x - E.x, H[k].z - E.z) < 12) k--;
  const E0 = H[k];
  const ex = E.x - q.x, ez = E.z - q.z, ed = Math.hypot(ex, ez) || 1;
  const F = { x: q.x + (ex / ed) * (q.r + 30), z: q.z + (ez / ed) * (q.r + 30) };
  const top = (x, z) => (Math.hypot(x - q.x, z - q.z) < q.rimOut
    ? q.rimAt(Math.atan2(z - q.z, x - q.x)) : ctx.at(x, z));
  const tail = bez(E0, E, F, 20, top);
  tail.push({ x: F.x, z: F.z, y: top(F.x, F.z) });
  return [...lead, ...H.slice(0, k), ...tail];
}

/**
 * The track into the quarry, on across the floor past the middle: it ended
 * halfway in, so the truck turned round with the cutting's walls either side
 * and drove back out still swung wide, through the foot of the haul road.
 */
function acrossFloor(q) {
  const pts = q.track.slice().reverse();
  // To the middle and no further: on past it, to 28 m beyond, it drove
  // through the table. "It goes through the ramp now, so it needs to go round
  // the ramp." Its turn there swings to whichever side misses the kicker
  // (onJump, in `avoid`).
  pts.push({ x: q.x, z: q.z });
  return pts;
}

/** Over one of the quarry floor's jumps (buildQuarry's q.jumps), or near it. */
function onJump(q, x, z) {
  return (q.jumps || []).some((j) => {
    const dx = x - j.x, dz = z - j.z;
    return Math.abs(dx * j.ax + dz * j.az) < j.along + JUMP_CLEAR && Math.abs(dx * j.az - dz * j.ax) < j.across + JUMP_CLEAR;
  });
}

function inQuarryRock(q, x, z) {
  const d = Math.hypot(x - q.x, z - q.z);
  return d > (q.inner || q.r * 0.6) - 3 && d < q.r + 10;
}
