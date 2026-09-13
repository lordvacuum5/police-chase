// Roadblocks.
//
// Not scattered at random: a block is only worth putting down somewhere the
// target is actually going, so sites are drawn from the same forward expansion
// of the road graph the dispatcher uses to solve intercepts. That means they
// appear on the road ahead of you rather than behind, and moving unpredictably
// is a real defence against them.
//
// The cars are ordinary police units, not scenery. They are parked across the
// carriageway with the handbrake on and they stay there until you are through
// the block or have turned back, at which point they come off the handbrake
// and join the chase. A roadblock you have beaten therefore costs you three
// more cars behind you, which is the point of going round rather than through.
//
// Two exist at a time at most, and they are deliberately occasional. A block
// every few seconds stops being a set piece and becomes weather.

import * as THREE from 'three';
import { ROLE } from '../ai/officer.js';
import { addCone } from '../physics/world.js';
import { SPECS } from './vehicles.js';
import { dist2, clamp } from '../util/math.js';

const MAX_BLOCKS = 2;
const SPAWN_MIN = 170, SPAWN_MAX = 260;   // metres ahead to look for a site
const DESPAWN = 200;                      // metres behind before it is removed
const MIN_APART = 220;

/**
 * Minimum seconds between blocks, and the extra wait after one has actually
 * been used. Set low these stop reading as a set piece: you round a corner,
 * there is a block, you go round it, and there is another one. The force does
 * not have infinite cars and should not feel as though it does.
 */
const RESPAWN_DELAY = 34;
const AFTER_BEATEN = 26;

/** How far you must travel between blocks, so they cannot chase you down a street. */
const MIN_TRAVEL = 320;

export class RoadblockManager {
  constructor(game) {
    this.game = game;
    this.blocks = [];
    this.timer = RESPAWN_DELAY * 0.5;
    this.coneGeo = null;
    this.lastSite = null;
  }

  /** Minimum heat for roadblocks to be part of the response at all. */
  get allowed() { return this.game.heat.tier >= 3; }

  /**
   * Whether a *new* block may go in. They have to know where you are: siting
   * one needs a direction of travel to put it ahead of, and a force that has
   * lost you has no business setting up in front of a car it cannot see.
   *
   * Deliberately separate from `allowed`, which also governs teardown -- a
   * block already standing should not dissolve the moment you break line of
   * sight for a second.
   */
  get canPlace() {
    return this.allowed && this.game.dispatcher.knowledge.seen;
  }

  update(dt, target) {
    this.timer -= dt;

    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];

      // Units that have left to join the chase are the dispatcher's problem
      // now; the block only owns the ones still standing on it.
      for (let j = b.units.length - 1; j >= 0; j--) {
        if (b.units[j].role !== ROLE.HOLD) b.units.splice(j, 1);
      }

      const d = dist2(b.x, b.z, target.position.x, target.position.z);
      // Only remove it once it is well behind -- never while it is on screen.
      if (d > DESPAWN || !this.allowed) {
        this._dispose(b);
        this.blocks.splice(i, 1);
      }
    }

    if (!this.canPlace || this.blocks.length >= MAX_BLOCKS || this.timer > 0) return;
    if (this.lastSite && dist2(this.lastSite.x, this.lastSite.z,
      target.position.x, target.position.z) < MIN_TRAVEL) return;

    this.timer = RESPAWN_DELAY;
    const site = this._findSite(target);
    if (!site) return;

    const block = this._build(site);
    if (!block) return;
    this.blocks.push(block);
    this.lastSite = { x: site.x, z: site.z };
    this.game.say('roadblock', [
      (v) => `Control, roadblock going in on ${v.site}.`,
      (v) => `Control, units setting up a block on ${v.site}.`,
      (v) => `Control, all units, road closed at ${v.site}.`,
    ], { site: site.name }, true);
  }

  /** A unit has left its post. Slow the next block down a little. */
  onUnitReleased(unit, why) {
    this.timer = Math.max(this.timer, AFTER_BEATEN);
    if (why === 'past' && !this._reported) {
      this._reported = true;
      this.game.say('block-beaten', [
        (v) => `${v.cs}, they're through the block, all units!`,
        (v) => `${v.cs}, they've gone round the roadblock!`,
        (v) => `${v.cs}, block's failed, they're past us!`,
      ], { cs: unit.callsign }, true);
      setTimeout(() => { this._reported = false; }, 4000);
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

    // The tangent points along increasing `along`, which runs from the edge's
    // a end to its b end. A target arriving *at* the a end is therefore
    // travelling against it. Getting this backwards points the cars the wrong
    // way down the road and makes the block read every approaching car as one
    // that has already gone through.
    const sgn = towardNode ? -1 : 1;

    return {
      x: p.x, z: p.z, tx: p.tx * sgn, tz: p.tz * sgn,
      width: edge.width, name: edge.name || 'the road ahead',
    };
  }

  _build(site) {
    const game = this.game;
    const { x, z, tx, tz, width } = site;
    const heading = Math.atan2(tx, tz);
    const nx = -tz, nz = tx;                 // across the carriageway

    const block = { x, z, meshes: [], units: [], cones: [] };

    // Cars angled across the road, as they are parked in reality -- side on to
    // the traffic so they present the longest possible obstacle.
    //
    // How many depends on how much road there is to cover. Two cars on a
    // fifteen-metre street leave a five-metre gap straight up the middle,
    // which is not a roadblock, it is a chicane: work out what one angled car
    // actually spans and put down enough of them to close the carriageway.
    const ANG = Math.PI * 0.42;
    const tier = game.heat.tier;
    // From the spec of the car actually being placed, not literals -- a wider
    // vehicle would otherwise leave a gap in a block it believed it had closed.
    const dims = SPECS[tier >= 4 ? 'interceptor' : 'patrol'].dims;
    const cover = Math.abs(dims.l * Math.sin(ANG)) + Math.abs(dims.w * Math.cos(ANG));
    const spread = Math.max(0, width * 0.5 - cover * 0.5);
    // Capped: a block is not allowed to eat the whole vehicle budget and
    // leave nothing to actually chase you with.
    const count = clamp(Math.ceil((spread * 2) / cover) + 1, 2, 4);
    // Points back up the road the target arrives along.
    const approach = { x: -tx, z: -tz };

    for (let i = 0; i < count; i++) {
      const f = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;   // -1 .. 1
      // Staggered into two rows rather than one line. Packed tightly enough
      // across the road to leave no gap, the cars would be sitting inside each
      // other; offsetting alternate ones a few metres up the road keeps their
      // lateral coverage overlapping while their bodies stay well clear.
      const back = (i % 2 ? 1 : -1) * 3.0;
      const px = x + nx * f * spread + tx * back;
      const pz = z + nz * f * spread + tz * back;
      const ang = heading + ANG * (i % 2 ? 1 : -1);

      const unit = game.spawnPoliceAt({ x: px, y: 0.95, z: pz }, ang, tier);
      if (!unit) continue;
      unit.setRole(ROLE.HOLD, {
        site: { x, z },
        approach,
        sawItFrom: 130,
      });
      game.dispatcher.adopt(unit);
      block.units.push(unit);
    }

    // If not one car could be placed there is no block; do not leave a line of
    // cones across an open road.
    if (!block.units.length) return null;

    // A line of cones on the approach, so the block reads before you are in it.
    // They are real dynamic bodies: drive through them and they go over the
    // bonnet rather than standing there like bollards.
    if (!this.coneGeo) {
      // Centred on the body origin, since the physics body's transform is
      // about the cone's middle rather than its base.
      this.coneGeo = new THREE.ConeGeometry(0.30, 0.75, 7);
    }
    const coneMat = game.coneMaterial();
    for (let i = -3; i <= 3; i++) {
      const t = i / 3;
      const cx = x + nx * t * (width * 0.5 - 0.8) - tx * 11;
      const cz = z + nz * t * (width * 0.5 - 0.8) - tz * 11;
      const cone = new THREE.Mesh(this.coneGeo, coneMat);
      cone.castShadow = true;
      game.scene.add(cone);
      const body = addCone(game.world, cx, 0.02, cz, 0.30, 0.75);
      block.cones.push({ mesh: cone, body });
    }

    return block;
  }

  /**
   * Follow the cones with their meshes. Called from the render step, since
   * they are dynamic bodies now and go wherever being hit sends them.
   */
  syncVisuals() {
    for (const b of this.blocks) {
      for (const c of b.cones) {
        const t = c.body.translation();
        const r = c.body.rotation();
        c.mesh.position.set(t.x, t.y, t.z);
        c.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
    }
  }

  _dispose(b) {
    for (const m of b.meshes) this.game.scene.remove(m);
    b.meshes.length = 0;
    for (const c of b.cones) {
      this.game.scene.remove(c.mesh);
      this.game.world.removeRigidBody(c.body);
    }
    b.cones.length = 0;
    // Only the cars still standing on the block. Anything that has joined the
    // chase has already been removed from this list and belongs to the
    // dispatcher.
    for (const u of b.units) this.game.dispatcher.retire(u);
    b.units.length = 0;
  }

  reset() {
    for (const b of this.blocks) this._dispose(b);
    this.blocks.length = 0;
    this.timer = RESPAWN_DELAY * 0.5;
    this.lastSite = null;
  }
}
