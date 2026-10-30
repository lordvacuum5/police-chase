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
import { GLTFLoader } from '../../vendor/addons/loaders/GLTFLoader.js';

/** How many tractors on the lanes, how fast, m/s. */
const TRACTORS = 3;
const TRACTOR_SPEED = 7;
/** Dump trucks, m/s; the combine, m/s. */
const TRUCK_SPEED = 6;
const COMBINE_SPEED = 2.5;
/** How tight each turns round at the end of its route, m: a radius, swung out to the side with room. */
const TURN_TRACTOR = 6;
const TURN_TRUCK = 10;
const TURN_COMBINE = 8;
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
  constructor(points) {
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
    s = clamp(s, 0, this.len);
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
  constructor(ctx, scene, { route, speed, lane = 0, geo, dims, colliders, offset = 0, name, turnR = 6, avoid = null, model = null, paint = null }) {
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
    this.turnTime = (Math.PI * turnR) / (speed * 0.6);
    this.cycle = 2 * (this.leg + this.turnTime);
    this._planTurns(avoid);
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
    this.body = W.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -60, 0));
    for (const c of colliders) {
      W.createCollider(
        RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz).setTranslation(c.x || 0, c.y, c.z || 0)
          .setFriction(0.5).setCollisionGroups(groups(GROUP.BUILDING, 0xFFFF)),
        this.body,
      );
    }
    this.placed = false;
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
        for (const [u, v] of [[1, 1], [0, 2], [0.7, 1.7]]) {
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
      const y = at.y !== undefined ? at.y : this.ctx.at(at.x, at.z);
      let slope = null;
      if (at.y !== undefined) {
        const ahead = r.at(s + 3), behind = r.at(s - 3);
        slope = ((ahead.y - behind.y) / 6) * dir;
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
    const y = e.y !== undefined ? e.y : this.ctx.at(x, z);
    return { x, y, z, heading: Math.atan2(dx, dz), moving: true, slope: null };
  }

  step(t, dt) {
    const a = this.pose(t);
    // Pitched to the ground under its ends.
    const fx = Math.sin(a.heading), fz = Math.cos(a.heading), half = this.spec.dims.l * 0.35;
    const pitch = a.slope !== null ? Math.atan(a.slope)
      : Math.atan2(this.ctx.at(a.x + fx * half, a.z + fz * half) - this.ctx.at(a.x - fx * half, a.z - fz * half), half * 2);
    _e.set(-pitch, a.heading, 0, 'YXZ');
    _q.setFromEuler(_e);
    const pos = { x: a.x, y: a.y, z: a.z }, rot = { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
    if (!this.placed) {
      this.body.setTranslation(pos, true);
      this.body.setRotation(rot, true);
      this.placed = true;
    } else {
      this.body.setNextKinematicTranslation(pos);
      this.body.setNextKinematicRotation(rot);
    }
    this.dist = (this.dist || 0) + this.speed0 * dt;
    if (dt > 0) this.linvel.set((a.x - this.position.x) / dt, (a.y - this.position.y) / dt, (a.z - this.position.z) / dt);
    if (this.linvel.length() > 40) this.linvel.set(0, 0, 0);
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
    for (const w of this.wheels || []) w.node.rotation.x = -this.dist / w.r;
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
      if (/^wheel_/.test(o.name)) this.wheels.push({ node: o, r: Math.max(0.3, o.position.y) });
      // A combine's reel, which turns faster than its wheels, pulling the crop in.
      if (o.name === 'reel') this.wheels.push({ node: o, r: 0.35 });
    });
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
  const avoid = (x, z) => nearBuildings(ctx, x, z) || (quarry && inQuarryRock(quarry, x, z));

  // ---- tractors on the lanes ----
  // Lanes and B-roads well away from the villages, the farms' own tracks, the
  // railway (a tractor on a crossing would be under the train) and the quarry,
  // and away from each other.
  const railEdges = new Set((rail && rail.cross ? rail.cross : []).map((c) => c.edge));
  const cands = graph.edges.filter((e) => !e.cut && !e.turningHead && !e.village && !e.farm && !e.aroad
    && (e.kind === 'track' || e.kind === 'country') && e.length > 260 && e.length < 900 && !railEdges.has(e.id)
    && !(quarry && Math.hypot(e.points[0].x - quarry.x, e.points[0].z - quarry.z) < quarry.r + 40));
  const taken = [];
  const paints = [0xb3261e, 0x2f6e2a, 0x2a5aa8];
  for (let tries = 0; tries < 200 && taken.length < TRACTORS && cands.length; tries++) {
    const e = cands[randInt(rng, 0, cands.length - 1)];
    const mid = e.points[Math.floor(e.points.length / 2)];
    if (taken.some((m) => Math.hypot(m.x - mid.x, m.z - mid.z) < 400)) continue;
    taken.push(mid);
    const pts = [e.segs[0].a, ...e.segs.map((s) => s.b)];
    // Short of the junctions at each end, to turn round in the road.
    const full = new Route(pts);
    const trimmed = [];
    for (let s = 14; s <= full.len - 14; s += 4) trimmed.push(full.at(s));
    const lane = Math.min(2.2, e.width * 0.5 - 1.3);
    movers.push(new Mover(ctx, scene, {
      route: new Route(trimmed), speed: TRACTOR_SPEED, lane, offset: rand(rng, 0, 500), name: 'tractor', turnR: TURN_TRACTOR, avoid,
      geo: tractorGeometry(paints[taken.length - 1]), dims: { l: 4.2, w: 2.3 }, model: 'tractor', paint: paints[taken.length - 1],
      colliders: [{ hx: 1.1, hy: 1.3, hz: 2.0, y: 1.35 }],
    }));
  }

  // ---- dump trucks in the quarry ----
  if (quarry && quarry.track && quarry.haulPath) {
    movers.push(new Mover(ctx, scene, {
      route: new Route(quarry.track.slice().reverse()), speed: TRUCK_SPEED, offset: rand(rng, 0, 300), name: 'dump-truck', turnR: TURN_TRUCK, avoid,
      geo: truckGeometry(), dims: { l: 9, w: 3.4 }, model: 'truck',
      colliders: [{ hx: 1.7, hy: 2.1, hz: 4.4, y: 2.1 }],
    }));
    movers.push(new Mover(ctx, scene, {
      route: new Route(quarry.haulPath), speed: TRUCK_SPEED * 0.8, offset: rand(rng, 0, 300), name: 'dump-truck', turnR: TURN_TRUCK, avoid,
      geo: truckGeometry(), dims: { l: 9, w: 3.4 }, model: 'truck',
      colliders: [{ hx: 1.7, hy: 2.1, hz: 4.4, y: 2.1 }],
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
        colliders: [{ hx: 1.75, hy: 2.1, hz: 4.85, y: 2.1, z: 0.25 }, { hx: 3.75, hy: 0.6, hz: 0.6, y: 0.9, z: 5.65 }],
      }));
    }
  }
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
      birds.update(game, clock);
    },
    setNight(on) { windows.setNight(on); },
    birds: birds.spots,
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
  addStaticBox(W, x, g + 1.4, z, 1.3, 1.4, 3.2, GROUP.BUILDING, rot);
  addStaticBox(W, x + fx * HITCH, g + 1.4, z + fz * HITCH, 1.1, 1.4, 2.0, GROUP.BUILDING, rot);
  group.userData.trailer = trailer;
  group.userData.tractor = tractor;
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
function inQuarryRock(q, x, z) {
  const d = Math.hypot(x - q.x, z - q.z);
  return d > (q.inner || q.r * 0.6) - 3 && d < q.r + 10;
}
