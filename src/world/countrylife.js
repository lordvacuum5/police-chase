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

/** How many tractors on the lanes, how fast, m/s. */
const TRACTORS = 3;
const TRACTOR_SPEED = 7;
/** Dump trucks, m/s; the combine, m/s. */
const TRUCK_SPEED = 6;
const COMBINE_SPEED = 2.5;
/** Seconds to turn round at the end of a route. */
const TURN_TIME = 4;
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
  constructor(ctx, scene, { route, speed, lane = 0, geo, dims, colliders, offset = 0, name }) {
    this.ctx = ctx;
    this.route = route;
    this.speed0 = speed;
    this.lane = lane;
    this.offset = offset;
    this.leg = route.len / speed;
    this.cycle = 2 * (this.leg + TURN_TIME);
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
  pose(t) {
    const r = this.route;
    const p = (((t + this.offset) % this.cycle) + this.cycle) % this.cycle;
    let s, dir, turn = 0;
    if (p < this.leg) { s = p * this.speed0; dir = 1; }
    else if (p < this.leg + TURN_TIME) { s = r.len; dir = 1; turn = (p - this.leg) / TURN_TIME; }
    else if (p < 2 * this.leg + TURN_TIME) { s = r.len - (p - this.leg - TURN_TIME) * this.speed0; dir = -1; }
    else { s = 0; dir = -1; turn = (p - 2 * this.leg - TURN_TIME) / TURN_TIME; }
    const at = r.at(s);
    let h = r.heading(s);
    if (dir < 0) h += Math.PI;
    // Turning round: through half a circle, and across to the other side.
    if (turn > 0) h += Math.PI * smooth(turn);
    const side = turn > 0 ? lerp(dir, -dir, smooth(turn)) : dir;
    // On its own side of the road: to the left of where it is going.
    const lx = Math.cos(r.heading(s)), lz = -Math.sin(r.heading(s));
    const x = at.x - lx * this.lane * side, z = at.z - lz * this.lane * side;
    const y = at.y !== undefined ? at.y : this.ctx.at(x, z);
    // How steep it is underfoot, the way it is going, where the route knows
    // its own heights (the haul road, up rock the height grid knows nothing of).
    let slope = null;
    if (at.y !== undefined) {
      const ahead = r.at(s + 3), behind = r.at(s - 3);
      slope = ((ahead.y - behind.y) / 6) * (turn > 0 ? 0 : dir);
    }
    return { x, y, z, heading: h, moving: turn === 0, slope };
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
  }
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
      route: new Route(trimmed), speed: TRACTOR_SPEED, lane, offset: rand(rng, 0, 500), name: 'tractor',
      geo: tractorGeometry(paints[taken.length - 1]), dims: { l: 4.2, w: 2.3 },
      colliders: [{ hx: 1.1, hy: 1.3, hz: 2.0, y: 1.35 }],
    }));
  }

  // ---- dump trucks in the quarry ----
  if (quarry && quarry.track && quarry.haulPath) {
    movers.push(new Mover(ctx, scene, {
      route: new Route(quarry.track.slice().reverse()), speed: TRUCK_SPEED, offset: rand(rng, 0, 300), name: 'dump-truck',
      geo: truckGeometry(), dims: { l: 9, w: 3.4 },
      colliders: [{ hx: 1.7, hy: 2.1, hz: 4.4, y: 2.1 }],
    }));
    movers.push(new Mover(ctx, scene, {
      route: new Route(quarry.haulPath), speed: TRUCK_SPEED * 0.8, offset: rand(rng, 0, 300), name: 'dump-truck',
      geo: truckGeometry(), dims: { l: 9, w: 3.4 },
      colliders: [{ hx: 1.7, hy: 2.1, hz: 4.4, y: 2.1 }],
    }));
  }

  // ---- the harvest ----
  if (combineField) {
    const route = combineRoute(ctx, fields, combineField, rng);
    if (route) {
      movers.push(new Mover(ctx, scene, {
        route, speed: COMBINE_SPEED, offset: rand(rng, 0, 300), name: 'combine',
        geo: combineGeometry(), dims: { l: 10, w: 7.6 },
        colliders: [{ hx: 1.5, hy: 2.2, hz: 3.4, y: 2.3, z: -0.6 }, { hx: 3.8, hy: 0.6, hz: 0.8, y: 0.9, z: 4.6 }],
      }));
    }
  }
  if (baleField) meshes.push(baleTrailer(ctx, baleField, fields));

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
    if (n.s === seed && n.edge > 8 && !ctx.graph.overlapsRoad(px, pz, 4, 12, a, 4)) { x = px; z = pz; rot = a + Math.PI / 2; break; }
  }
  const fx = Math.sin(rot), fz = Math.cos(rot);
  const g = ctx.at(x, z);
  // The trailer, in its own frame (nose to +z), then turned and placed.
  b.addBox(2.4, 0.3, 6.4, 0, 1.05, 0, 0x6e5a42);
  b.addBox(0.15, 0.15, 1.6, 0, 0.95, 3.6, 0x333333);
  for (const sx of [-1.25, 1.25]) for (const sz of [-1.0, 1.0]) wheel(b, 0.45, 0.3, sx, 0.45, sz);
  const bale = new THREE.CylinderGeometry(0.8, 0.8, 1.5, 14);
  for (let i = 0; i < 3; i++) {
    for (const s of [-0.75, 0.75]) {
      b.addGeometry(bale, new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(s, 2.0, (i - 1) * 1.8), 0xb79a52);
    }
  }
  bale.dispose();
  const group = new THREE.Group();
  const trailer = new THREE.Mesh(b.build(), vertexColorMaterial());
  const tractor = new THREE.Mesh(tractorGeometry(0x2f6e2a), vertexColorMaterial());
  tractor.position.z = 5.4;
  for (const m of [trailer, tractor]) { m.castShadow = true; group.add(m); }
  group.position.set(x, g, z);
  group.rotation.y = rot;
  group.name = 'bale-trailer';
  addStaticBox(W, x, g + 1.4, z, 1.3, 1.4, 3.2, GROUP.BUILDING, rot);
  addStaticBox(W, x + fx * 5.4, g + 1.4, z + fz * 5.4, 1.1, 1.4, 2.0, GROUP.BUILDING, rot);
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
