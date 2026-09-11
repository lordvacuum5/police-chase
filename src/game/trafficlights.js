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
// junctions there are. The posts are a fourth instanced mesh, which is what
// lets one be flattened: they are handed to StreetProps, so a signal knocked
// over topples and goes dark like any other piece of street furniture.

import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';
import { GROUP, addStaticBox } from '../physics/world.js';
import { alongApproach } from '../world/junctions.js';

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

/**
 * What a signal post is, as a knockable prop.
 *
 * Much heavier than a lamp post -- a signal head is a substantial thing on a
 * substantial pole, and flattening one should be felt. At 150 kg it takes
 * about 3 m/s off a car at 25, against the lamp post's 1.2.
 */
const POST = { mass: 150, radius: 0.16, height: 3.2, bite: 0.35 };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
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
        const head = this._makeHead(j.node, a, phase);
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

    this._buildHeads();
    this._buildLamps();
    this.update(0);
  }

  /**
   * The posts themselves, as one instanced mesh in local space.
   *
   * They used to be merged into a single static mesh, which is cheaper still
   * but means a head can never move. Instancing them costs one more draw call
   * and lets a signal be flattened like any other piece of street furniture --
   * so they are handed straight to StreetProps, which already knows how to
   * topple something and charge the car for it.
   */
  _buildHeads() {
    const mesh = new THREE.InstancedMesh(
      headGeometry(), vertexColorMaterial(), Math.max(1, this.heads.length),
    );
    mesh.name = 'signals';
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.heads.forEach((h, i) => {
      // Signals stand on the footway too.
      h.base = this.game.sim.heightAt ? this.game.sim.heightAt(h.x, h.z) : 0;
      _q.setFromAxisAngle(_up, h.rot);
      _pos.set(h.x, h.base, h.z);
      _m.compose(_pos, _q, _one);
      mesh.setMatrixAt(i, _m);
      // In its own group, so the AI's obstacle sweeps and the wheel rays both
      // ignore it: a police car that brakes for a signal post, or a wheel that
      // climbs one, is worse than a post you can drive through.
      h.collider = addStaticBox(
        this.game.world, h.x, h.base + POST.height * 0.5, h.z,
        POST.radius, POST.height * 0.5, POST.radius, GROUP.STREET, h.rot,
      );
      // A flattened signal goes dark, and stops being a signal.
      h.onDown = () => { h.down = true; this.dirty = true; };
      h.onUp = () => { h.down = false; this.dirty = true; };
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.game.scene.add(mesh);
    this.mesh = mesh;
    this.game.props.adopt('signal', POST, mesh, this.heads);
  }

  /**
   * One signal head, on the nearside kerb at the stop line.
   *
   * Approaching traffic runs against the approach direction and keeps left,
   * which works out as the +perp kerb -- the same side the stop line is on.
   * The head's lamps face back up the approach, at the driver.
   */
  _makeHead(node, app, phase) {
    if (!app.setback) return null;

    // Follow the road's own curve out to the stop line rather than shooting
    // off along the tangent at the node -- with bends smoothed, the two are
    // not the same, and the difference was enough to leave heads standing in
    // the carriageway.
    const q = alongApproach(node, app, app.setback + 0.4);
    let x = q.x + q.nx * (app.half + 1.5);
    let z = q.z + q.nz * (app.half + 1.5);

    // Belt and braces: if it still lands on tarmac -- a wide crossing road, a
    // junction whose setback got capped -- walk it out onto the footway, and
    // give up on this approach rather than plant a pole in the road.
    const g = this.game.graph;
    let tries = 0;
    while (g.overlapsRoad(x, z, 0.5, 0.5, 0, 0.7) && tries < 7) {
      x += q.nx; z += q.nz; tries++;
    }
    if (tries >= 7) return null;

    // Lamps on the +Z face, pointing back the way the traffic is coming from.
    const rot = Math.atan2(q.dx, q.dz);

    const head = {
      phase,
      node,
      edge: app.edge,
      end: app.end,
      dir: { x: app.dir.x, z: app.dir.z },
      setback: app.setback,
      x, z, rot,
      state: SIGNAL.RED,
      down: false,
    };
    this.byApproach.set(app.edge.id * 2 + (app.end === 'b' ? 1 : 0), head);
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
    // A signal lying in the gutter shows nothing at all.
    const s = h.down ? -1 : h.state;
    // Lamps sit slightly proud of the housing, toward the driver.
    const fx = Math.sin(h.rot) * 0.15, fz = Math.cos(h.rot) * 0.15;
    _q.setFromAxisAngle(_up, h.rot);
    const put = (mesh, dy, lit) => {
      _scale.setScalar(lit ? 1 : 0.0001);
      _pos.set(h.x + fx, (h.base || 0) + HEAD_Y + dy, h.z + fz);
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
    if (!head || head.down) return Infinity;
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
    return head && !head.down ? head.state : SIGNAL.GREEN;
  }

  reset() {
    this.time = 0;
    this.dirty = true;
    this.update(0);
  }
}

/**
 * One signal head in local space: base at the origin, lamps facing +Z, so the
 * instance matrix is just "stand here, look that way" -- and so a toppled one
 * can be posed straight from its rigid body.
 */
function headGeometry() {
  const b = new MeshBuilder();
  b.addBox(0.13, POLE_H, 0.13, 0, POLE_H * 0.5, 0, 0x2b2f34);
  // Backboard, then the housing in front of it.
  b.addBox(0.52, 1.16, 0.05, 0, HEAD_Y, 0, 0x14181d);
  b.addTaperedBox(0.40, 1.04, 0.24, 0, HEAD_Y, 0, 0x22272d, 0.95, 1);
  // Hoods over each lamp, which is what makes a signal head readable.
  for (let k = -1; k <= 1; k++) {
    b.addBox(0.30, 0.045, 0.16, 0, HEAD_Y + 0.34 * -k + 0.15, 0.17, 0x171b20);
  }
  return b.build();
}
