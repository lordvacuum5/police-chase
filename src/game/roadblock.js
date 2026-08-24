// Roadblocks.
//
// Not scattered at random: a block is only worth putting down somewhere the
// target is actually going, so sites are drawn from the same forward expansion
// of the road graph the dispatcher uses to solve intercepts. That means they
// appear on the road ahead of you rather than behind, and moving unpredictably
// is a real defence against them.
//
// Two exist at a time. They are put down at about 200 m ahead -- far enough
// that you never see one appear, close enough that you have little time to
// re-plan -- and taken away once you are 200 m past.

import * as THREE from 'three';
import { GROUP, addStaticBox } from '../physics/world.js';
import { dist2, clamp } from '../util/math.js';

const MAX_BLOCKS = 2;
const SPAWN_MIN = 170, SPAWN_MAX = 260;   // metres ahead to look for a site
const DESPAWN = 200;                      // metres behind before it is removed
const MIN_APART = 150;
const RESPAWN_DELAY = 6;

export class RoadblockManager {
  constructor(game) {
    this.game = game;
    this.blocks = [];
    this.timer = 0;
    this.coneGeo = null;
  }

  /** Minimum heat before the force starts putting cars across roads. */
  get allowed() { return this.game.heat.tier >= 3; }

  update(dt, target) {
    this.timer -= dt;

    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      const d = dist2(b.x, b.z, target.position.x, target.position.z);
      // Only remove it once it is well behind -- never while it is on screen.
      if (d > DESPAWN || !this.allowed) {
        this._dispose(b);
        this.blocks.splice(i, 1);
      }
    }

    if (this.allowed && this.blocks.length < MAX_BLOCKS && this.timer <= 0) {
      this.timer = RESPAWN_DELAY;
      const site = this._findSite(target);
      if (site) {
        this.blocks.push(this._build(site));
        this.game.radio(`Roadblock going in on ${site.name}`, true);
      }
    }
  }

  /**
   * A point on a road the target is heading for, roughly 200 m out. Uses the
   * dispatcher's forward expansion, so it inherits its sense of "ahead".
   */
  _findSite(target) {
    const g = this.game.graph;
    const k = this.game.dispatcher.knowledge;

    let dx = k.velocity.x, dz = k.velocity.z;
    if (Math.hypot(dx, dz) < 4) { dx = target.forward.x; dz = target.forward.z; }
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;

    const reach = g.reachable(target.position.x, target.position.z, dx, dz, 30, 0.9);
    const candidates = [];
    for (const [id, rec] of reach) {
      const n = g.nodes[id];
      const d = dist2(n.x, n.z, target.position.x, target.position.z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;

      let clash = false;
      for (const b of this.blocks) {
        if (dist2(n.x, n.z, b.x, b.z) < MIN_APART) { clash = true; break; }
      }
      if (clash) continue;
      candidates.push({ id, rec, node: n, eta: rec.eta });
    }
    if (!candidates.length) return null;

    // Soonest first: the block the target reaches next is the one worth having.
    candidates.sort((a, b) => a.eta - b.eta);
    const pick = candidates[0];

    // Put it on the road the target will arrive along, set back from the
    // junction so it blocks the approach rather than sitting in the middle of
    // a crossroads where it can be driven round.
    let edge = null;
    if (pick.rec.viaNode >= 0) edge = g.edgeBetween(pick.rec.viaNode, pick.id);
    if (!edge) {
      const eid = pick.node.edges[0];
      edge = eid === undefined ? null : g.edges[eid];
    }
    if (!edge || edge.width < 7) return null;

    // 28 m back from the junction along that edge.
    const towardNode = edge.a === pick.id;
    const along = towardNode ? 28 : Math.max(0, edge.length - 28);
    const p = g.pointAt(edge, along);

    return {
      x: p.x, z: p.z, tx: p.tx, tz: p.tz,
      width: edge.width, name: edge.name || 'the road ahead',
    };
  }

  _build(site) {
    const game = this.game;
    const { x, z, tx, tz, width } = site;
    const heading = Math.atan2(tx, tz);
    const nx = -tz, nz = tx;                 // across the carriageway

    const block = { x, z, meshes: [], bodies: [] };

    // Cars angled across the road, as they are parked in reality -- side on to
    // the traffic so they present the longest possible obstacle.
    const count = width > 18 ? 3 : 2;
    const geo = game._geometryFor('patrol', 'patrol', true, false);
    const spread = width * 0.5 - 2.4;

    for (let i = 0; i < count; i++) {
      const f = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;   // -1 .. 1
      const px = x + nx * f * spread;
      const pz = z + nz * f * spread;
      const ang = heading + Math.PI * 0.42 * (i % 2 ? 1 : -1);

      const mesh = new THREE.Mesh(geo, game.carMaterialsFor(geo));
      mesh.position.set(px, 0.47, pz);
      mesh.rotation.y = ang;
      mesh.castShadow = true;
      game.scene.add(mesh);
      block.meshes.push(mesh);

      block.bodies.push(addStaticBox(
        game.world, px, 0.62, pz, 1.05, 0.62, 2.4, GROUP.PROP, ang,
      ));
    }

    // A line of cones on the approach, so the block reads before you are in it.
    if (!this.coneGeo) {
      this.coneGeo = new THREE.ConeGeometry(0.28, 0.75, 6);
      this.coneGeo.translate(0, 0.375, 0);
    }
    const coneMat = game.coneMaterial();
    for (let i = -3; i <= 3; i++) {
      const t = i / 3;
      const cx = x + nx * t * (width * 0.5 - 0.8) + tx * 11;
      const cz = z + nz * t * (width * 0.5 - 0.8) + tz * 11;
      const cone = new THREE.Mesh(this.coneGeo, coneMat);
      cone.position.set(cx, 0, cz);
      game.scene.add(cone);
      block.meshes.push(cone);
    }

    return block;
  }

  _dispose(b) {
    for (const m of b.meshes) this.game.scene.remove(m);
    for (const body of b.bodies) this.game.world.removeRigidBody(body);
    b.meshes.length = 0;
    b.bodies.length = 0;
  }

  reset() {
    for (const b of this.blocks) this._dispose(b);
    this.blocks.length = 0;
    this.timer = 0;
  }
}
