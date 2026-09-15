// Entry point: builds the world, owns the loop, wires everything together.

import * as THREE from 'three';
import { initPhysics, createWorld, hasLineOfSight } from './physics/world.js';
import { Vehicle } from './physics/vehicle.js';
import {
  SPECS, LIVERIES, buildCarGeometry, buildWheelGeometry, LAMP_OFFSETS,
  carMaterials,
} from './game/vehicles.js';
import { WORLD_HALF } from './world/common.js';
import { MAPS, mapById } from './world/maps.js';
import { showMenu, hideMenu, chosenCar } from './core/menu.js';
import { DRIVE_SIDE } from './world/roadgraph.js';
import { Dispatcher } from './ai/dispatcher.js';
import { Officer, ROLE } from './ai/officer.js';
import { Driver, SKILL } from './ai/driver.js';
import { Heat } from './game/heat.js';
import { RoadblockManager } from './game/roadblock.js';
import { Helicopter } from './game/helicopter.js';
import { TrafficLights, SIGNAL } from './game/trafficlights.js';
import { StreetProps } from './game/streetprops.js';
import { Garage } from './game/garage.js';
import { Score } from './game/score.js';
import { ChaseCamera } from './game/camera.js';
import { Hud } from './game/hud.js';
import { Input } from './core/input.js';
import { TouchControls } from './core/touch.js';
import { SkidMarks, LightBars } from './game/effects.js';
import { GameAudio } from './game/audio.js';
import { Commentary } from './game/commentary.js';
import { Phrasebook } from './game/phrases.js';
import { vertexColorMaterial, shinyVertexMaterial } from './util/meshbuild.js';
import { makeRng, clamp, clamp01, dist2, lerp } from './util/math.js';

const FIXED = 1 / 120;         // physics substep
const MAX_SUBSTEPS = 5;
const MAX_VEHICLES = 18;

/** Seconds between any two routine radio lines -- commentary, units en route. */
const ROUTINE_GAP = 12;

/**
 * Which kind of car answers a call, by wanted level.
 *
 * Patrol cars all the way up; interceptors from three stars, and unmarked
 * cars at the top. The SUV joins from two stars. The armoured van only comes
 * out at five, and only one at a time: it is slow, and a pursuit made of vans
 * is a traffic jam.
 */
function policeKindFor(tier, roll, vehicles) {
  if (tier >= 5) {
    const vanOut = vehicles.some((v) => v.specKey === 'van');
    if (!vanOut && roll < 0.14) return 'van';
    return roll < 0.36 ? 'unmarked' : roll < 0.68 ? 'interceptor' : roll < 0.88 ? 'suv' : 'patrol';
  }
  if (tier === 4) return roll < 0.1 ? 'unmarked' : roll < 0.5 ? 'interceptor' : roll < 0.78 ? 'suv' : 'patrol';
  if (tier === 3) return roll < 0.35 ? 'interceptor' : roll < 0.6 ? 'suv' : 'patrol';
  if (tier === 2) return roll < 0.25 ? 'suv' : 'patrol';
  return 'patrol';
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _qC = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _scale = new THREE.Vector3(1, 1, 1);
const _frustum = new THREE.Frustum();
const _viewMat = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _eyeV = new THREE.Vector3();
const _atV = new THREE.Vector3();

const boot = {
  bar: document.getElementById('bootfill'),
  text: document.getElementById('boottext'),
  root: document.getElementById('boot'),
  show() { if (this.root) this.root.classList.add('on'); },
  set(p, msg) {
    if (this.bar) this.bar.style.width = (p * 100).toFixed(0) + '%';
    if (this.text && msg) this.text.textContent = msg;
  },
  hide() { if (this.root) this.root.classList.remove('on'); },
};

class Game {
  constructor() {
    this.rng = makeRng(0xC0FFEE);
    this.vehicles = [];
    this.paused = false;
    this.debug = false;
    this.accumulator = 0;
    this.frames = 0;
    this.fps = 60;
    this.fpsAccum = 0;
    this.fpsTimer = 0;
    this.quality = 2;          // 2 = shadows on, 1 = no shadows, 0 = reduced resolution
    this.geometryCache = new Map();
    this.outcome = null;
    this.clock = 0;            // game seconds, for anything timed on the radio
    this.phrases = new Phrasebook();
  }

  // =================================================================== setup

  async init() {
    boot.set(0.05, 'starting physics…');
    await initPhysics();

    boot.set(0.18, 'creating world…');
    this.world = createWorld();
    this.sim = { world: this.world, surfaceAt: () => 1, heightAt: null };

    this._initRenderer();

    boot.set(0.32, `laying out ${this.mapDef.name}…`);
    // Yield so the loading bar actually paints before the long build.
    await frame();
    const built = this.mapDef.build(this.sim, this.scene, this.mapDef.seed || 20260822);
    this.graph = built.graph;
    this.sim.surfaceAt = built.surfaceAt;
    this.sim.heightAt = built.heightAt;
    this.world.__map = built;

    boot.set(0.72, 'building vehicles…');
    await frame();
    this._initEffects();
    this._initPlayer();

    boot.set(0.88, 'briefing units…');
    this.heat = new Heat(this);
    this.dispatcher = new Dispatcher(this);
    this.roadblocks = new RoadblockManager(this);
    this.score = new Score(this);
    this.helicopter = new Helicopter(this);
    // The garage before the props, so nothing is stood across its entrance.
    this.garage = new Garage(this);
    // Props first: the signals hand their posts to it to be knocked over.
    this.props = new StreetProps(this);
    this.signals = new TrafficLights(this);
    // The police talking about what is going on. Reads everything above; decides nothing.
    this.commentary = new Commentary(this);
    this.hud = new Hud(this);
    this.input = new Input();
    this.touch = new TouchControls(this);
    this.camera3 = new ChaseCamera(this.camera);
    this.camera3.snapTo(this.player);

    // Audio cannot start until the user has interacted with the page, so the
    // context is only built and resumed on the first key press or click.
    // A finger going down does not count as that interaction in the spec --
    // only lifting it does -- so phones need pointerup and touchend too.
    this.audio = new GameAudio();
    const wake = () => this.audio.resume();
    window.addEventListener('keydown', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('pointerup', wake);
    window.addEventListener('touchend', wake);

    this._initDebug();
    window.addEventListener('resize', () => this._resize());

    boot.set(1, 'ready');
    await frame();
    boot.hide();

    this.say('routine', [
      'Control, all units, routine patrol.',
      'Control, all quiet. Routine patrol.',
      'Control, nothing outstanding.',
    ]);
    this.last = performance.now();
    requestAnimationFrame(this._loop);
  }

  _initRenderer() {
    const canvas = document.getElementById('view');
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
      // Keeps the frame readable after compositing, so the canvas can be
      // captured. With antialias on and this off, toDataURL comes back empty:
      // the multisampled buffer is resolved and discarded before it can be read.
      preserveDrawingBuffer: true,
    });
    // Multisampling rather than supersampling: the whole world is flat-shaded
    // faceted geometry, so nearly all the aliasing is on polygon edges, which
    // is exactly what MSAA fixes -- and it costs far less than rendering at a
    // higher pixel ratio would. The device ratio stays capped at 1 for the
    // same reason.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    const sky = new THREE.Color(0x8ea6bf);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 200, 880);

    this.camera = new THREE.PerspectiveCamera(
      62, window.innerWidth / window.innerHeight, 0.4, 1400,
    );

    this.scene.add(new THREE.HemisphereLight(0xcfe0f2, 0x4a5240, 1.25));

    const sun = new THREE.DirectionalLight(0xfff4e2, 1.75);
    sun.position.set(120, 190, 90);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const c = sun.shadow.camera;
    c.left = -85; c.right = 85; c.top = 85; c.bottom = -85;
    c.near = 20; c.far = 460;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  _initEffects() {
    this.skids = new SkidMarks(this.scene, 2600);
    this.lights = new LightBars(this.scene, MAX_VEHICLES);
    this.wheelMesh = new THREE.InstancedMesh(
      buildWheelGeometry(0.34, 0.26),
      vertexColorMaterial(),
      MAX_VEHICLES * 4,
    );
    this.wheelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheelMesh.castShadow = true;
    this.wheelMesh.frustumCulled = false;
    this.scene.add(this.wheelMesh);
  }

  _initPlayer() {
    let place = null;
    for (let i = 0; i < 40 && !place; i++) {
      const node = i === 0
        ? this.graph.nearestNode(0, -240)
        : this.graph.randomNode(this.rng, 'street');
      place = this._placeOnRoad(node);
    }
    // Whichever car was picked on the menu. Remembered in localStorage, so a
    // refresh or a trip back through M keeps it.
    const car = SPECS[chosenCar()] ? chosenCar() : 'runner';
    this.player = this.createVehicle(car, car, place.position, place.heading, {});
    this.startPlace = place;
  }

  _initDebug() {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;top:220px;left:14px;font:11px ui-monospace,Consolas,monospace;
      color:#9fb4c8;background:rgba(8,11,16,.75);padding:8px 10px;border-radius:5px;
      white-space:pre;display:none;pointer-events:none;line-height:1.5;z-index:20;`;
    document.body.appendChild(d);
    this.debugEl = d;
  }

  // ================================================================ vehicles

  _geometryFor(specKey, liveryKey, police, unmarked) {
    const key = `${specKey}|${liveryKey}|${police ? 1 : 0}|${unmarked ? 1 : 0}`;
    let g = this.geometryCache.get(key);
    if (!g) {
      g = buildCarGeometry(SPECS[specKey], LIVERIES[liveryKey], { police, unmarked });
      this.geometryCache.set(key, g);
    }
    return g;
  }

  createVehicle(specKey, liveryKey, position, heading, opts = {}) {
    const spec = SPECS[specKey];
    const v = new Vehicle(this.sim, spec, {
      position, heading, id: this.vehicles.length + 1,
    });
    v.specKey = specKey;
    v.isPolice = !!opts.police;
    v.unmarked = !!opts.unmarked;

    const geo = this._geometryFor(specKey, liveryKey, opts.police, opts.unmarked);
    const mesh = new THREE.Mesh(geo, carMaterials(geo, shinyVertexMaterial()));
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    v.view = mesh;

    for (const w of v.wheels) {
      w.lastSkid = new THREE.Vector3();
      w.skidding = false;
    }

    this.vehicles.push(v);
    return v;
  }

  removeVehicle(v) {
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    this.scene.remove(v.view);
    v.destroy();
  }

  /**
   * A spawn pose on the road leaving a junction.
   *
   * Walks the edge's actual polyline rather than the straight line between its
   * endpoints -- on a curved country road the chord leaves the tarmac -- then
   * verifies the result is on a road surface and clear of other cars. Returns
   * null if no edge at this node works, so the caller can try elsewhere.
   */
  _placeOnRoad(node) {
    const g = this.graph;
    for (const eid of node.edges) {
      const e = g.edges[eid];
      const pts = e.a === node.id ? e.points : e.points.slice().reverse();

      let remaining = Math.min(14, e.length * 0.45);
      let px = pts[0].x, pz = pts[0].z, dx = 0, dz = 1;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        if (seg < 1e-4) continue;
        dx = (b.x - a.x) / seg; dz = (b.z - a.z) / seg;
        if (remaining <= seg) { px = a.x + dx * remaining; pz = a.z + dz * remaining; break; }
        remaining -= seg; px = b.x; pz = b.z;
      }

      const lane = Math.min(3.0, e.width * 0.25);
      const x = px + -dz * lane * DRIVE_SIDE;
      const z = pz + dx * lane * DRIVE_SIDE;

      if (this.sim.surfaceAt(x, z) !== 1) continue;
      let blocked = false;
      for (const v of this.vehicles) {
        if (dist2(v.position.x, v.position.z, x, z) < 7) { blocked = true; break; }
      }
      if (blocked) continue;

      return { position: { x, y: 0.95, z }, heading: Math.atan2(dx, dz) };
    }
    return null;
  }

  // ---------------------------------------------------------------- police

  /**
   * Could the player see something appear at this spot right now?
   *
   * Used by every path that creates a police car, because nothing used to
   * check: a rolling block went in about 150 m up the road, a roadblock at
   * about 155 m, and on a straight street both are in plain view -- the fog
   * does not even start until 200 m. Measured over two minutes of a chase,
   * seven of twenty police cars appeared on screen.
   *
   * "Seen" means inside the camera's view, not hidden behind a building, and
   * within 700 m (past that the fog has it). The view test is deliberately
   * generous at the edges -- a car sliding into shot as you turn is still a
   * car you watched appear -- by testing a sphere that grows with distance.
   */
  inView(pos) {
    const cam = this.camera;
    if (!cam) return false;
    cam.updateMatrixWorld(true);
    _atV.set(pos.x, 1.2, pos.z);
    const d = cam.position.distanceTo(_atV);
    if (d > 700) return false;
    _viewMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewMat);
    _sphere.center.copy(_atV);
    _sphere.radius = 4 + d * 0.2;
    if (!_frustum.intersectsSphere(_sphere)) return false;
    _eyeV.copy(cam.position);
    return hasLineOfSight(this.world, _eyeV, _atV, 0.3);
  }

  spawnPoliceNear(target, tier) {
    if (this.vehicles.length >= MAX_VEHICLES) return null;
    const g = this.graph;
    const minD = tier === 0 ? 130 : 210;
    const maxD = tier === 0 ? 360 : 520;

    let place = null;
    for (let i = 0; i < 80; i++) {
      const n = g.randomNode(this.rng);
      const d = dist2(n.x, n.z, target.x, target.z);
      if (d < minD || d > maxD) continue;
      // Prefer somewhere with room to get moving.
      if (n.edges.length < 2 && i < 50) continue;
      place = this._placeOnRoad(n);
      // Never where you are looking: a car that has to drive in from out of
      // sight is a car arriving, not one appearing.
      if (place && this.inView(place.position)) place = null;
      if (place) break;
    }
    if (!place) return null;

    const kind = policeKindFor(tier, this.rng(), this.vehicles);

    const skill = kind === 'unmarked' ? SKILL.pursuit
      : kind === 'interceptor' || kind === 'suv' ? (this.rng() < 0.35 ? SKILL.pursuit : SKILL.advanced)
        : kind === 'van' ? SKILL.advanced
          : (this.rng() < 0.15 ? SKILL.rookie : SKILL.regular);

    const v = this.createVehicle(kind, kind, place.position, place.heading, {
      police: true, unmarked: kind === 'unmarked',
    });
    v.lampPhase = this.rng();

    return new Officer(this, v, { skill, kind });
  }

  /**
   * Put a unit at an exact position and heading, for callers that have already
   * chosen the spot -- roadblocks, which need cars in a specific arrangement
   * across a specific carriageway rather than anywhere convenient.
   */
  spawnPoliceAt(position, heading, tier) {
    if (this.vehicles.length >= MAX_VEHICLES) return null;
    for (const other of this.vehicles) {
      if (dist2(other.position.x, other.position.z, position.x, position.z) < 4.2) return null;
    }
    const r = this.rng();
    // SUVs make a good wall: the widest, heaviest thing the fleet has short of the van.
    const kind = tier >= 4 ? (r < 0.4 ? 'interceptor' : r < 0.75 ? 'suv' : 'patrol')
      : tier >= 3 && r < 0.4 ? 'suv' : 'patrol';
    const v = this.createVehicle(kind, kind, position, heading, { police: true });
    v.lampPhase = this.rng();
    // Parked, not arriving: no roll-on velocity, and the lights are already
    // going before you come round the corner.
    v.setVelocity({ x: 0, y: 0, z: 0 });
    return new Officer(this, v, { skill: SKILL.advanced, kind });
  }

  /**
   * Put a unit on the road *in front of* the target, pointing the same way.
   *
   * Spawned rather than reassigned: getting a car that is already behind you
   * round to the front takes longer than a chase lasts, and the point of a
   * rolling block is that it is there when you arrive.
   */
  spawnPoliceAhead(target, tier) {
    if (this.vehicles.length >= MAX_VEHICLES) return null;
    const g = this.graph;

    let dx = target.linvel.x, dz = target.linvel.z;
    if (Math.hypot(dx, dz) < 4) { dx = target.forward.x; dz = target.forward.z; }
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;

    // Somewhere the target is heading. Around 150 m is the sweet spot: beyond
    // the far clip of a city street, so the car is never seen to appear, but
    // close enough that they run up on it within a few seconds rather than
    // spending half the chase reeling it in.
    const reach = g.reachable(target.position.x, target.position.z, dx, dz, 26, 0.9);
    const candidates = [];
    for (const [id, rec] of reach) {
      const n = g.nodes[id];
      const d = dist2(n.x, n.z, target.position.x, target.position.z);
      // Out to 340 m, not 240: the nearest sites ahead are usually in plain
      // view down the street, and the hidden ones -- round a corner, behind a
      // block -- are further on.
      if (d < 90 || d > 340) continue;
      // Reachable-going-forwards is not the same as in front: a loop back
      // round the block reaches nodes behind the target quite legitimately,
      // and a car put down there is not a block, it is a tail. Insist the site
      // is genuinely up the road, within about a 50 degree cone.
      if (((n.x - target.position.x) * dx + (n.z - target.position.z) * dz) < d * 0.64) continue;
      // Not on top of a roadblock. Both this and the roadblock siting draw
      // from the same forward expansion and both want the soonest road ahead,
      // so left alone they pick the same stretch and you meet a rolling block
      // and a roadblock together, which reads as one overlong obstacle rather
      // than two separate problems.
      let nearBlock = false;
      for (const b of this.roadblocks.blocks) {
        if (dist2(n.x, n.z, b.x, b.z) < 140) { nearBlock = true; break; }
      }
      if (nearBlock) continue;
      candidates.push({ node: n, via: rec.viaNode, score: Math.abs(d - 150) });
    }
    if (!candidates.length) return null;
    // Best-fitting site first, but keep going down the list: a site can fail
    // late (verge, occupied, no usable edge) and one bad node should not cost
    // us the block.
    candidates.sort((a, b) => a.score - b.score);

    for (const best of candidates.slice(0, 12)) {
      // Face the way the target will be travelling when they reach us.
      let edge = best.via >= 0 ? g.edgeBetween(best.via, best.node.id) : null;
      if (!edge) { const eid = best.node.edges[0]; edge = eid === undefined ? null : g.edges[eid]; }
      if (!edge) continue;

      const towardNode = edge.a === best.node.id;
      const along = towardNode ? 22 : Math.max(0, edge.length - 22);
      const p = g.pointAt(edge, along);
      const sign = towardNode ? -1 : 1;
      const heading = Math.atan2(p.tx * sign, p.tz * sign);

      const lane = Math.min(3.0, edge.width * 0.25);
      const pos = {
        x: p.x + -p.tz * sign * lane * DRIVE_SIDE,
        y: 0.95,
        z: p.z + p.tx * sign * lane * DRIVE_SIDE,
      };
      if (this.sim.surfaceAt(pos.x, pos.z) !== 1) continue;
      // In view means no block this time. A car materialising a hundred and
      // fifty metres up the road is worse than no rolling block; the
      // dispatcher tries again after its cooldown, by which time the road
      // ahead has usually turned a corner.
      if (this.inView(pos)) continue;
      let occupied = false;
      for (const v of this.vehicles) {
        if (dist2(v.position.x, v.position.z, pos.x, pos.z) < 8) { occupied = true; break; }
      }
      if (occupied) continue;

      const kind = tier >= 4 ? 'interceptor' : 'patrol';
      const v = this.createVehicle(kind, kind, pos, heading, { police: true });
      v.lampPhase = this.rng();
      // Already rolling, so it does not have to accelerate from a standstill in
      // front of a car doing 120.
      v.setVelocity({ x: Math.sin(heading) * 18, y: 0, z: Math.cos(heading) * 18 });

      return new Officer(this, v, { skill: SKILL.advanced, kind });
    }
    return null;
  }

  despawnPolice(officer) {
    this.removeVehicle(officer.vehicle);
  }

  coneMaterial() {
    if (!this._coneMat) {
      this._coneMat = new THREE.MeshLambertMaterial({ color: 0xe2561d });
    }
    return this._coneMat;
  }

  // =================================================================== events

  radio(text, hot = false, opts = {}) {
    // Once the run has ended in an arrest the chase is over, but the units are
    // still thinking -- and without this they kept announcing intercepts after
    // Control had stood everybody down. Only the lines that close the run out
    // get through.
    if (this.outcome && !opts.final) return;
    // Word for word the same line again within 45 seconds of game time is
    // dropped. The phrasebook stops a *kind* of line repeating; this stops the
    // exact sentence, which a callsign and a road name can still produce.
    if (!text.startsWith('[') && !opts.final) {
      const now = this.clock || 0;
      if (!this.recentLines) this.recentLines = new Map();
      const last = this.recentLines.get(text);
      if (last !== undefined && now - last < 45) return;
      this.recentLines.set(text, now);
      if (this.recentLines.size > 80) {
        for (const [t, at] of this.recentLines) if (now - at > 45) this.recentLines.delete(t);
      }
    }
    if (this.hud) this.hud.addMessage(text, hot);
    // Every line that reaches the HUD is also heard on the net. One choke
    // point for both, so the two can never drift apart. `opts.low` marks
    // running commentary, which the audio side may skip when the net is busy.
    if (this.audio) this.audio.radio(text, hot, opts);
  }

  /**
   * A line from a set of wordings, avoiding the ones used lately for the same
   * key. See game/phrases.js. Returns the text that went out.
   */
  say(key, variants, vars = {}, hot = false, opts = {}) {
    // `every`: at most one line of this kind that often, whoever says it. Five
    // cars coming on duty in a minute is one "on duty" worth hearing.
    if (!this.lastSaid) this.lastSaid = {};
    if (opts.every && this.clock - (this.lastSaid[key] ?? -1e9) < opts.every) return null;
    // A routine line with no room for it is not picked at all, so it neither
    // uses up a wording nor blocks the same sentence for later. Routine lines
    // also share one gap between them, whoever says them: four units each
    // announcing their own intercept ten seconds apart was, to the player, the
    // net never shutting up.
    if (opts.low) {
      if (this.audio && !this.audio.roomForRoutine) return null;
      if (this.clock - (this.lastRoutineAt ?? -1e9) < ROUTINE_GAP) return null;
      this.lastRoutineAt = this.clock;
    }
    const text = this.phrases.pick(key, variants, vars);
    this.lastSaid[key] = this.clock;
    this.radio(text, hot, { key, ...opts });
    return text;
  }

  roadName(pos) {
    const snap = this.graph.nearestEdge(pos.x, pos.z);
    return snap && snap.edge.name ? 'on ' + snap.edge.name : 'in the city';
  }

  nodeName(id) {
    const n = this.graph.nodes[id];
    return n && n.name ? n.name : 'the junction';
  }

  onBoxClosed() {
    if (this.outcome) return;
    // Fires every frame the box holds, so only announce it once per box.
    const now = performance.now();
    if (this._lastBoxCall && now - this._lastBoxCall < 12000) return;
    this._lastBoxCall = now;
    this.say('boxed', [
      'Control, they\'re boxed. Move in.',
      'Control, target boxed, close in.',
      'Control, contained, move in now.',
    ], {}, true);
  }

  onBusted() {
    if (this.outcome) return;
    this.outcome = 'busted';
    const run = this.score.finish();
    this.hud.showOverlay('BUSTED', [
      `Score <b>${run.score.toLocaleString()}</b>${run.newBest ? ' &nbsp;<b class="best">NEW BEST</b>' : ` &nbsp;(best ${run.best.toLocaleString()})`}`,
      `Survived <b>${this.heat.elapsed.toFixed(1)}s</b>`,
      `Peak heat <b>${this.heat.peak.toFixed(1)}</b>`,
      `Damage <b>${(this.player.damage * 100).toFixed(0)}%</b>`,
    ].join(' &nbsp;·&nbsp; '));
    this.commentary.onBusted();
    this.radio('Control, received. All units, stand down.', true, { final: true });
  }

  /**
   * You got away. Which is not the end of anything.
   *
   * This used to drop the same full-screen curtain as being arrested, with
   * "press R to run again" on it -- so the reward for a good escape was having
   * the game taken away from you. Getting away means the heat is clear and you
   * are still sitting in a car in the middle of a town: the run carries on,
   * the banner says so for a few seconds, and the force goes back to what it
   * was doing before you turned up. Being arrested is still an ending, because
   * that one genuinely is.
   */
  onEscaped() {
    if (this.outcome) return;
    // heat.elapsed reads zero the moment the value hits zero, which is exactly
    // when this is called, so take the time from the start of the chase.
    const held = (performance.now() - this.heat.chaseStarted) / 1000;
    this.hud.flash('ESCAPED', [
      `Evaded for <b>${held.toFixed(1)}s</b>`,
      `Peak heat <b>${this.heat.peak.toFixed(1)}</b>`,
      'They have lost you',
    ].join(' &nbsp;·&nbsp; '));
    this.say('escaped', [
      'Control, no further contact. Resume patrol.',
      'Control, we\'ve lost them. Units stand down.',
      'Control, nothing further. Back to patrol.',
    ], {}, true);
    this.score.onEscaped(this.heat.peak);
    this.dispatcher.standDown();
    this.heat.reset();
  }

  restart() {
    this.outcome = null;
    this.score.reset();
    this.hud.hideOverlay();
    this.heat.reset();
    this.dispatcher.reset();
    this.roadblocks.reset();
    this.helicopter.reset();
    this.props.reset();
    this.signals.reset();
    this.commentary.reset();
    this.player.repair();
    this.player.teleport(this.startPlace.position, this.startPlace.heading);
    this.skids.clear();
    this.hud.clearMessages();
    this.camera3.snapTo(this.player);
    this.say('routine', [
      'Control, all units, routine patrol.',
      'Control, all quiet. Routine patrol.',
      'Control, nothing outstanding.',
    ]);
  }

  // =================================================================== loop

  _loop = (now) => {
    requestAnimationFrame(this._loop);

    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.25) dt = 0.25;      // after a tab switch, do not simulate the gap

    this._trackPerformance(dt);
    this._handleKeys();
    this.touch.frame();

    if (!this.paused) {
      this._update(dt);
    }

    this._render(dt);
    this.input.endFrame();
  };

  /**
   * Run the simulation without waiting on the render loop. Used by the
   * handling tests; `controls` is applied to the player for the whole run.
   */
  stepHeadless(seconds, controls = null, dt = 1 / 60) {
    const prev = this.forceControls;
    if (controls) this.forceControls = controls;
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) this._update(dt);
    this.forceControls = prev;
    return this.telemetry();
  }

  telemetry() {
    const p = this.player;
    return {
      kmh: +(p.speed * 3.6).toFixed(1),
      fwd: +p.forwardSpeed.toFixed(2),
      y: +p.position.y.toFixed(3),
      grounded: p.grounded,
      gear: p.gear,
      rpm: Math.round(p.rpm),
      bodySlipDeg: +(p.slipAngleBody * 57.2958).toFixed(1),
      yawRate: +p.yawRate.toFixed(3),
      loads: p.wheels.map((w) => Math.round(w.load)),
      slip: p.wheels.map((w) => +w.slip.toFixed(2)),
      damage: +p.damage.toFixed(3),
      heat: +this.heat.value.toFixed(2),
      units: this.dispatcher.units.length,
    };
  }

  _handleKeys() {
    const i = this.input;
    if (i.tapped('KeyM')) {
      // Back to map select. Rebuilding a whole world in place means tearing
      // down the physics world, the scene and every cached geometry; a reload
      // does the same job and cannot leak.
      sessionStorage.removeItem('pc.map');
      window.location.reload();
      return;
    }
    if (i.tapped('KeyP')) this.paused = !this.paused;
    if (i.tapped('KeyH')) this.hud.toggleHelp();
    if (i.tapped('KeyC')) this.camera3.cycle();
    if ((i.tapped('KeyM') || i.tapped('Mute')) && this.audio) {
      this.radio(this.audio.toggleMute() ? '[sound] muted' : '[sound] on');
    }
    if (i.tapped('F3')) {
      this.debug = !this.debug;
      this.debugEl.style.display = this.debug ? 'block' : 'none';
    }
    if (i.tapped('KeyR')) {
      if (this.outcome) this.restart();
      else if (this.player.flippedFor > 0.3 || this.player.speed < 2) {
        // Flip upright in place rather than teleporting across the map.
        _v.copy(this.player.position); _v.y += 1.4;
        this.player.teleport(_v, Math.atan2(this.player.forward.x, this.player.forward.z));
      }
    }
  }

  _update(dt) {
    this.clock += dt;
    const player = this.player;

    // ---- player input ----
    if (this.outcome) {
      player.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
    } else if (this.forceControls) {
      // Scripted input, used for tuning and automated handling tests.
      player.setControls(this.forceControls);
    } else {
      player.setControls(this.input.sample(dt));
    }

    // ---- AI, then heat ----
    this.dispatcher.update(dt, player);
    this.roadblocks.update(dt, player);
    this.helicopter.update(dt, player);
    this.props.update(dt);
    this.garage.update(dt);
    this.score.update(dt);
    this.signals.update(dt);
    this.heat.update(dt, player, this.dispatcher);
    this.commentary.update(dt);
    this._checkProvocation(dt);
    this._checkRedLight();

    // ---- physics ----
    this.accumulator += dt;
    let steps = 0;
    this.world.timestep = FIXED;
    this.world.integrationParameters.dt = FIXED;
    while (this.accumulator >= FIXED && steps < MAX_SUBSTEPS) {
      for (const v of this.vehicles) v.prepare(FIXED);
      this.world.step();
      for (const v of this.vehicles) v.postStep(FIXED);
      this.accumulator -= FIXED;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;   // give up on the backlog

    this._updateSkids(dt);
    this.camera3.update(dt, player);

    // Camera shake and a thud on a real hit.
    if (player.lastImpactAt && performance.now() - player.lastImpactAt < 40) {
      const strength = clamp01((player.lastImpact - 1.4) * 0.16);
      this.camera3.impulse(strength);
      if (this.audio && player.lastImpactAt !== this._lastAudioImpact) {
        this._lastAudioImpact = player.lastImpactAt;
        this.audio.impact(strength);
      }
    }

    if (this.audio) this.audio.update(dt, player, this.dispatcher, this.heat);
    this.hud.update(dt, player, this.heat, this.dispatcher);
  }

  /**
   * What actually starts a chase: being seen driving badly, or hitting a
   * police car. Both need a witness -- speeding down an empty lane is free.
   */
  /**
   * Running a red light.
   *
   * Detected here rather than in the commentary because it is not only
   * something to talk about: running one in front of a patrol car is a reason
   * to be pulled over, and so it can start a chase on its own. The car counts
   * as having run it when it is within nine metres of a signalised junction,
   * still doing more than 30 km/h, with its own approach showing red.
   */
  _checkRedLight() {
    const p = this.player;
    if (!this.signals || !this.commentary || this.outcome) return;
    if (Math.abs(p.forwardSpeed) < 8.3) return;
    const ahead = this.commentary.junctionAhead(p);
    if (!ahead || ahead.dist > 9) return;
    // One call per junction per pass.
    if (this._lastRed && this._lastRed.id === ahead.node.id && this.clock - this._lastRed.at < 8) return;
    const state = this.signals.stateFor(ahead.edge, ahead.node);
    if (state !== SIGNAL.RED && state !== SIGNAL.RED_AMBER) return;
    this._lastRed = { id: ahead.node.id, at: this.clock };

    // Who saw it: the nearest working police car within 120 m that has an
    // actual line of sight to the car. Not the dispatcher's shared knowledge,
    // which at zero heat only reaches about 70 m -- a patrol car sitting at a
    // junction can see a red light across the whole of it.
    let witness = null, best = 120;
    for (const u of this.dispatcher.units) {
      if (u.vehicle.disabled) continue;
      const d = u.distanceTo(p.position);
      if (d >= best) continue;
      _v.copy(u.vehicle.position); _v.y += 1.1;
      _v2.copy(p.position); _v2.y += 0.8;
      if (!hasLineOfSight(this.world, _v, _v2, 1.5)) continue;
      witness = u; best = d;
    }

    if (this.heat.value <= 0) {
      if (!witness) return;
      this.commentary.onRanRed(ahead.name, witness, true);
      this.heat.bump(1, 'running a red light');
    } else {
      this.commentary.onRanRed(ahead.name, witness, false);
    }
  }

  _checkProvocation(dt) {
    const k = this.dispatcher.knowledge;
    const p = this.player;

    if (this.heat.value <= 0 && k.seen && k.spotter) {
      // Being seen is already gated on range and line of sight; all that is
      // left is whether you were doing anything worth stopping you for.
      const d = k.spotter.distanceTo(p.position);
      if (d < 120 && (Math.abs(p.forwardSpeed) > 25 || p.isDrifting)) {
        this.heat.bump(1, 'driving dangerously');
      }
    }

    // Contact with a police car is always worth a look -- once. The impact
    // stays inside the 60 ms window for several frames (and for hundreds of
    // headless steps, where performance.now() barely moves), so remember which
    // one was handled rather than counting it again on every frame.
    if (p.lastImpactAt && p.lastImpactAt !== this._lastRamImpact
        && performance.now() - p.lastImpactAt < 60) {
      this._lastRamImpact = p.lastImpactAt;
      for (const u of this.dispatcher.units) {
        if (u.distanceTo(p.position) < 6.5) {
          if (this.heat.value <= 0) this.heat.bump(1, 'ramming a patrol car');
          else this.heat.bump(0.28, 'contact');
          this.dispatcher.onRammed(u);
          break;
        }
      }
    }
  }

  _updateSkids(dt) {
    const px = this.player.position.x, pz = this.player.position.z;
    for (const v of this.vehicles) {
      // Only lay marks for cars close enough to be seen.
      if (v !== this.player && dist2(v.position.x, v.position.z, px, pz) > 130) continue;
      for (const w of v.wheels) {
        const sliding = w.grounded && w.slip > 0.42 && v.speed > 4;
        if (sliding) {
          if (w.skidding) this.skids.add(w.lastSkid, w.contact, 0.26, (w.slip - 0.42) * 2.2);
          w.lastSkid.copy(w.contact);
          w.skidding = true;
        } else {
          w.skidding = false;
        }
      }
    }
    this.skids.update(dt);
  }

  // ================================================================= render

  _render(dt) {
    // Cones are dynamic bodies, so their meshes have to follow them.
    this.roadblocks.syncVisuals();

    // ---- car transforms ----
    let wi = 0;
    this.lights.begin(dt);

    for (const v of this.vehicles) {
      v.view.position.copy(v.position);
      v.view.quaternion.copy(v.quaternion);

      // Every wheel is one instance of the same 0.34 m by 0.26 m tyre, scaled
      // to whatever this car actually runs on -- wider still at the rear if
      // the spec asks for it, which is purely visual.
      const s = v.spec;
      const rs = s.wheelRadius / 0.34;
      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i];
        v.wheelCentre(i, _v);
        _qA.setFromAxisAngle(AXIS_Y, w.steer);
        _qB.setFromAxisAngle(AXIS_X, -w.spin);
        _qC.copy(v.quaternion).multiply(_qA).multiply(_qB);
        const width = !w.front && s.wheelWidthRear ? s.wheelWidthRear : s.wheelWidth;
        _scale.set(width / 0.26, rs, rs);
        _m.compose(_v, _qC, _scale);
        this.wheelMesh.setMatrixAt(wi++, _m);
      }

      if (v.isPolice && !v.unmarked && this.heat.tier > 0) {
        // Each body puts its bar somewhere different; the geometry says where.
        this.lights.place(v, v.view.geometry.userData.lamps || LAMP_OFFSETS, v.lampPhase || 0);
      }
    }

    this.wheelMesh.count = wi;
    this.wheelMesh.instanceMatrix.needsUpdate = true;
    this.lights.end();

    // ---- keep the shadow frustum on the player ----
    const p = this.player.position;
    this.sun.target.position.copy(p);
    this.sun.position.set(p.x + 110, p.y + 175, p.z + 80);

    this.renderer.render(this.scene, this.camera);

    if (this.debug) this._drawDebug();
  }

  _resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  /** Drop quality automatically rather than letting the frame rate collapse. */
  _trackPerformance(dt) {
    this.fpsAccum += dt;
    this.frames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.frames / this.fpsAccum;
      this.frames = 0;
      this.fpsAccum = 0;
      this.fpsTimer += 0.5;

      if (this.fpsTimer > 3) {
        if (this.fps < 40 && this.quality === 2) {
          this.quality = 1;
          this.renderer.shadowMap.enabled = false;
          this.scene.traverse((o) => { if (o.isMesh) o.castShadow = false; });
          this.radio('[graphics] shadows off to hold frame rate');
          this.fpsTimer = 0;
        } else if (this.fps < 28 && this.quality === 1) {
          this.quality = 0;
          this.renderer.setPixelRatio(0.75);
          this._resize();
          this.radio('[graphics] reduced resolution to hold frame rate');
          this.fpsTimer = 0;
        }
      }
    }
  }

  _drawDebug() {
    const p = this.player;
    const d = this.dispatcher;
    const w = p.wheels;
    const roles = {};
    for (const u of d.units) roles[u.role] = (roles[u.role] || 0) + 1;

    this.debugEl.textContent = [
      `fps ${this.fps.toFixed(0)}   cars ${this.vehicles.length}   quality ${this.quality}`,
      `speed ${(p.speed * 3.6).toFixed(0)} km/h   rpm ${p.rpm.toFixed(0)}   gear ${p.gear}`,
      `body slip ${(p.slipAngleBody * 57.3).toFixed(1)}°   yaw ${p.yawRate.toFixed(2)} rad/s`,
      `grounded ${p.grounded}/4   damage ${(p.damage * 100).toFixed(0)}%`,
      `loads  FL ${w[0].load.toFixed(0)}  FR ${w[1].load.toFixed(0)}`,
      `       RL ${w[2].load.toFixed(0)}  RR ${w[3].load.toFixed(0)}`,
      `slip   FL ${w[0].slip.toFixed(2)}  FR ${w[1].slip.toFixed(2)}`,
      `       RL ${w[2].slip.toFixed(2)}  RR ${w[3].slip.toFixed(2)}`,
      `heat ${this.heat.value.toFixed(2)} (tier ${this.heat.tier})  seen ${d.knowledge.seen}`,
      `roles ${JSON.stringify(roles)}`,
      `pit ${d.activePit ? d.activePit.callsign : '-'}  box ${d.boxAssignment ? d.boxAssignment.size : 0}`,
    ].join('\n');
  }
}

/**
 * Yield to the browser so the loading bar repaints between build phases.
 * Deliberately not requestAnimationFrame: a tab that is not compositing never
 * fires one, and the whole boot would hang.
 */
function frame() {
  return new Promise((r) => setTimeout(r, 16));
}

const game = new Game();
window.__game = game;

/**
 * Start at the menu unless a map was already chosen this session -- so pressing
 * M reloads back to the menu, but an accidental refresh drops you straight back
 * into the map you were playing.
 */
function launch(mapDef) {
  sessionStorage.setItem('pc.map', mapDef.id);
  game.mapDef = mapDef;
  // The menu is in the page from the start and only hid itself when a map card
  // was clicked, so a refresh straight back into a map left its headings drawn
  // over the game.
  hideMenu();
  boot.show();
  game.init().catch((e) => {
    const el = document.getElementById('booterr');
    if (el) el.textContent += 'INIT FAILED: ' + (e.stack || e) + '\n';
    throw e;
  });
}

const chosen = sessionStorage.getItem('pc.map');
if (chosen && MAPS.some((m) => m.id === chosen)) launch(mapById(chosen));
else showMenu(launch);
// Exposed so the behaviour tests can drive the player with the same controller
// the police use, and inspect roles by name.
window.__modules = { Driver, SKILL, Officer, ROLE, SPECS, THREE, GameAudio };
