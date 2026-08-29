// Traffic signals at the junctions worth signalising.
//
// planJunctions has already worked out, for every node, which roads arrive on
// it, from what bearing, and how far back the stop line sits. That is all a
// set of lights needs, so this only has to do three things: split the
// approaches into two phases, run a clock, and put a signal head on the kerb
// where a driver would actually look for one.
//
// Every head's three lamps live in three instanced meshes -- one per colour --
// so the whole town's signals cost three draw calls no matter how many
// junctions there are. The poles and housings never change, so they merge into
// a single static mesh alongside.

import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';
import { GROUP, addStaticBox } from '../physics/world.js';

// UK sequence, per phase: green, amber, then all-red while the junction
// clears, then red-and-amber on the other phase just before it goes.
const GREEN = 13.0;
const AMBER = 3.0;
const ALL_RED = 1.7;
const RED_AMBER = 1.6;
const CYCLE = (GREEN + AMBER + ALL_RED + RED_AMBER) * 2;

/** Lamp states, in the order a driver reads them off the head. */
export const SIGNAL = { RED: 0, RED_AMBER: 1, GREEN: 2, AMBER: 3 };

const LAMP_R = 0.135;
const HEAD_Y = 2.62;          // centre of the three-lamp housing
const POLE_H = 2.20;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = { x: 0, z: 1 };

export class TrafficLights {
  constructor(game) {
    this.game = game;
    this.time = 0;
    this.dirty = true;
    this.junctions = [];
    this.heads = [];
    // edgeId * 2 + (node is the edge's b end ? 1 : 0)  ->  head
    this.byApproach = new Map();

    const plan = (game.graph.junctionPlan || []).filter((j) => j.signal);
    const build = new MeshBuilder();

    for (const j of plan) {
      const heads = [];
      // Two phases: whichever approaches run roughly along the first one's
      // axis go together, and everything else opposes them. On a crossroads
      // that is exactly the two carriageways; on a five-way it is the best
      // split available without solving anything harder.
      const ref = j.app[0].ang;
      for (const a of j.app) {
        let d = Math.abs(((a.ang - ref + Math.PI * 2.5) % Math.PI) - Math.PI * 0.5);
        const phase = d > Math.PI * 0.25 ? 0 : 1;
        const head = this._makeHead(build, j.node, a, phase);
        if (!head) continue;
        // Fixed instance slot for life, in all three colour meshes. A lamp
        // that is off is scaled to nothing rather than being packed out of the
        // list, so a signal changing touches three matrices instead of two
        // thousand.
        head.index = this.heads.length;
        heads.push(head);
        this.heads.push(head);
      }
      if (heads.length < 2) continue;
      // Stagger the towns' junctions so they do not all change together, which
      // looks synchronised in a way real signals never are.
      const offset = ((j.node.x * 7.31 + j.node.z * 3.17) % CYCLE + CYCLE) % CYCLE;
      this.junctions.push({ node: j.node, heads, offset });
    }

    this.mesh = new THREE.Mesh(build.build(), vertexColorMaterial());
    this.mesh.name = 'signals';
    this.mesh.castShadow = true;
    game.scene.add(this.mesh);

    this._buildLamps();
    this.update(0);
  }

  /**
   * One signal head, on the nearside kerb at the stop line.
   *
   * Approaching traffic runs against the approach direction and keeps left,
   * which works out as the +perp kerb -- the same side the stop line is on.
   * The head's lamps face back up the approach, at the driver.
   */
  _makeHead(build, node, app, phase) {
    if (!app.setback) return null;
    const px = -app.dir.z, pz = app.dir.x;
    const out = app.half + 1.5;
    const along = app.setback + 0.4;
    const x = node.x + app.dir.x * along + px * out;
    const z = node.z + app.dir.z * along + pz * out;
    // Lamps on the +Z face, pointing back the way the traffic is coming from.
    const rot = Math.atan2(app.dir.x, app.dir.z);

    build.addBox(0.13, POLE_H, 0.13, x, POLE_H * 0.5, z, 0x2b2f34, rot);
    // Backboard, then the housing in front of it.
    build.addBox(0.52, 1.16, 0.05, x, HEAD_Y, z, 0x14181d, rot);
    build.addTaperedBox(0.40, 1.04, 0.24, x, HEAD_Y, z + 0.0, 0x22272d, 0.95, 1, rot);
    // Hoods over each lamp, which is what makes a signal head readable.
    for (let k = -1; k <= 1; k++) {
      const hy = HEAD_Y + 0.34 * -k;
      const hz = 0.17;
      build.addBox(0.30, 0.045, 0.16,
        x + Math.sin(rot) * hz, hy + 0.15, z + Math.cos(rot) * hz, 0x171b20, rot);
    }

    const head = {
      phase,
      node,
      edge: app.edge,
      end: app.end,
      dir: { x: app.dir.x, z: app.dir.z },
      setback: app.setback,
      x, z, rot,
      state: SIGNAL.RED,
    };
    this.byApproach.set(app.edge.id * 2 + (app.end === 'b' ? 1 : 0), head);

    // Thin and in its own group, so the AI's obstacle sweeps and the wheel
    // rays both ignore it. A police car that brakes for a signal post, or a
    // wheel that climbs one, is worse than a post you can drive through.
    addStaticBox(this.game.world, x, POLE_H * 0.5, z, 0.11, POLE_H * 0.5, 0.11,
      GROUP.STREET, rot);
    return head;
  }

  _buildLamps() {
    const geo = new THREE.SphereGeometry(LAMP_R, 8, 6);
    const n = Math.max(1, this.heads.length);
    const mk = (colour) => {
      const m = new THREE.InstancedMesh(
        geo, new THREE.MeshBasicMaterial({ color: colour, toneMapped: false }), n,
      );
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.game.scene.add(m);
      return m;
    };
    this.lampRed = mk(0xff2a1c);
    this.lampAmber = mk(0xffa514);
    this.lampGreen = mk(0x27d95a);
  }

  /** Where a phase is in its cycle at time t. */
  static phaseState(t, phase) {
    const half = CYCLE * 0.5;
    // Phase 1 runs exactly half a cycle behind phase 0.
    let u = (t - (phase === 1 ? half : 0)) % CYCLE;
    if (u < 0) u += CYCLE;
    if (u < GREEN) return SIGNAL.GREEN;
    if (u < GREEN + AMBER) return SIGNAL.AMBER;
    if (u < half - RED_AMBER) return SIGNAL.RED;
    if (u < half) return SIGNAL.RED_AMBER;
    return SIGNAL.RED;
  }

  update(dt) {
    this.time += dt;
    const force = this.dirty;
    let changed = force;
    for (const j of this.junctions) {
      const t = this.time + j.offset;
      for (const h of j.heads) {
        const s = TrafficLights.phaseState(t, h.phase);
        if (s !== h.state || force) {
          h.state = s;
          this._writeHead(h);
          changed = true;
        }
      }
    }
    if (!changed) return;
    this.dirty = false;
    this.lampRed.instanceMatrix.needsUpdate = true;
    this.lampAmber.instanceMatrix.needsUpdate = true;
    this.lampGreen.instanceMatrix.needsUpdate = true;
  }

  /** Write one head's three lamps: the lit one full size, the others at nothing. */
  _writeHead(h) {
    const s = h.state;
    // Lamps sit slightly proud of the housing, toward the driver.
    const fx = Math.sin(h.rot) * 0.15, fz = Math.cos(h.rot) * 0.15;
    _q.setFromAxisAngle(_up, h.rot);
    const put = (mesh, dy, lit) => {
      _scale.setScalar(lit ? 1 : 0.0001);
      _pos.set(h.x + fx, HEAD_Y + dy, h.z + fz);
      _m.compose(_pos, _q, _scale);
      mesh.setMatrixAt(h.index, _m);
    };
    put(this.lampRed, 0.34, s === SIGNAL.RED || s === SIGNAL.RED_AMBER);
    put(this.lampAmber, 0, s === SIGNAL.AMBER || s === SIGNAL.RED_AMBER);
    put(this.lampGreen, -0.34, s === SIGNAL.GREEN);
  }

  /**
   * How far a car at (x, z) travelling toward `node` along `edge` must stop
   * short, or Infinity if it may carry on.
   *
   * Amber counts as stop only if there is room to do it comfortably, which is
   * what stops a car standing on the brakes the instant a light changes.
   */
  stopDistance(edge, node, x, z, speed) {
    if (!edge || !node) return Infinity;
    const head = this.byApproach.get(edge.id * 2 + (edge.b === node.id ? 1 : 0));
    if (!head) return Infinity;
    if (head.state === SIGNAL.GREEN || head.state === SIGNAL.RED_AMBER) return Infinity;

    // Distance to the stop line, measured along the approach.
    const dx = x - node.x, dz = z - node.z;
    const d = dx * head.dir.x + dz * head.dir.z - head.setback - 0.6;
    if (d < -2) return Infinity;                 // already past it; keep going
    if (head.state === SIGNAL.AMBER && d < speed * speed / 9.0) return Infinity;
    return Math.max(0, d);
  }

  /**
   * The same, for a car that only knows where it is and which way it is
   * pointing -- which is all a patrolling unit has to hand.
   */
  stopDistanceAt(x, z, dirX, dirZ, speed) {
    const g = this.game.graph;
    const snap = g.nearestEdge(x, z, 40);
    if (!snap) return Infinity;
    const d = g.edgeDirection(snap.edge, snap.along, _dir);
    const node = g.nodes[(d.x * dirX + d.z * dirZ) >= 0 ? snap.edge.b : snap.edge.a];
    return this.stopDistance(snap.edge, node, x, z, speed);
  }

  /** The colour a driver on this approach is looking at. */
  stateFor(edge, node) {
    if (!edge || !node) return SIGNAL.GREEN;
    const head = this.byApproach.get(edge.id * 2 + (edge.b === node.id ? 1 : 0));
    return head ? head.state : SIGNAL.GREEN;
  }

  reset() {
    this.time = 0;
    this.dirty = true;
    this.update(0);
  }
}
