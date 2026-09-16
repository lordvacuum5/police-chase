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
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';
import { SPECS } from './vehicles.js';
import { dist2, clamp } from '../util/math.js';

const MAX_BLOCKS = 2;
/** Closest and furthest a site may be, in metres; the window itself scales with speed (see _findSite). */
const SPAWN_MIN = 170, SPAWN_MAX = 260;
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
    this._checkSpikes(target, dt);

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
      (v) => `Control, roadblock and stinger going in on ${v.site}.`,
      (v) => `Control, block going in on ${v.site}, stinger out.`,
      (v) => `Control, road closed, ${v.site}. Stinger deployed.`,
    ], { site: site.name }, true);
  }

  /** A unit has left its post. Slow the next block down a little. */
  onUnitReleased(unit, why) {
    this.timer = Math.max(this.timer, AFTER_BEATEN);
    if (why === 'past' && !this._reported) {
      this._reported = true;
      if (this.game.score) this.game.score.onBlockBeaten();
      this.game.say('block-beaten', [
        (v) => `${v.cs}, they're through the block!`,
        (v) => `${v.cs}, they've gone round the block!`,
        (v) => `${v.cs}, block failed, they're past!`,
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

    // How far ahead to look, in seconds of the target's own driving rather
    // than in metres. At 240 km/h a fixed 170-260 m window is under four
    // seconds away -- by the time the block exists the car is past it, which
    // is exactly the "roadblock keeps appearing behind me because I was going
    // really fast" case. At a crawl the same seconds would put it half a mile
    // off, so the old metres are the floor.
    const sp = Math.max(target.speed, 8);
    const near = clamp(sp * 3.4, SPAWN_MIN, 520);
    const far = clamp(sp * 6.0, SPAWN_MAX, 760);

    // And how straight ahead it has to be. A site is only useful on the road
    // the car is actually going to be on, and the faster it is going the less
    // likely it is to turn off: at 30 km/h any road off this junction is fair
    // game, at 200 there is only one road it is going to be on.
    // Not too tight: a real road bends, so a junction 300 m up it is rarely
    // dead ahead of where the nose is pointing this instant. Tight enough to
    // rule out the side roads and the way back.
    const cone = clamp(0.5 + sp * 0.006, 0.5, 0.8);

    const reach = g.reachable(target.position.x, target.position.z, dx, dz, 30, 0.9);
    const candidates = [];
    for (const [id, rec] of reach) {
      const n = g.nodes[id];
      const d = dist2(n.x, n.z, target.position.x, target.position.z);
      if (d < near || d > far) continue;
      // Reachable going forwards is not the same as in front: a loop round the
      // block reaches nodes behind the car quite legitimately, and a block put
      // down there is one the player has already driven past.
      if (((n.x - target.position.x) * dx + (n.z - target.position.z) * dz) < d * cone) continue;

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

    // But never one the player can see going in. Four cars and a line of cones
    // appearing a hundred and fifty metres up a straight road was the most
    // visible spawn in the game. The soonest hidden site wins; if every site
    // is in view, there is no block this time and the timer tries again.
    for (const pick of candidates) {
      // Put it on the road the target will arrive along, set back from the
      // junction so it blocks the approach rather than sitting in the middle
      // of a crossroads where it can be driven round.
      let edge = null;
      if (pick.rec.viaNode >= 0) edge = g.edgeBetween(pick.rec.viaNode, pick.id);
      if (!edge) {
        const eid = pick.node.edges[0];
        edge = eid === undefined ? null : g.edges[eid];
      }
      if (!edge || edge.width < 7) continue;

      // 28 m back from the junction along that edge.
      const towardNode = edge.a === pick.id;
      const along = towardNode ? 28 : Math.max(0, edge.length - 28);
      const p = g.pointAt(edge, along);

      // The block spans the carriageway, so check both ends of it as well as
      // the middle: a block half in shot is a block you watched appear.
      const nx = -p.tz * edge.width * 0.45, nz = p.tx * edge.width * 0.45;
      if (this.game.inView({ x: p.x, z: p.z })
        || this.game.inView({ x: p.x + nx, z: p.z + nz })
        || this.game.inView({ x: p.x - nx, z: p.z - nz })) continue;

      // The tangent points along increasing `along`, which runs from the edge's
      // a end to its b end. A target arriving *at* the a end is therefore
      // travelling against it. Getting this backwards points the cars the
      // wrong way down the road and makes the block read every approaching car
      // as one that has already gone through.
      const sgn = towardNode ? -1 : 1;

      return {
        x: p.x, z: p.z, tx: p.tx * sgn, tz: p.tz * sgn,
        width: edge.width, name: edge.name || 'the road ahead',
      };
    }
    return null;
  }

  _build(site) {
    const game = this.game;
    const { x, z, tx, tz, width } = site;
    const heading = Math.atan2(tx, tz);
    const nx = -tz, nz = tx;                 // across the carriageway

    const block = { x, z, meshes: [], units: [], cones: [], spikes: null };

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

    // A stinger across the whole road, further up the approach than the cones,
    // so a car that sees the block late and threads a gap between the cars
    // still goes over it. Kerb to kerb: going round the block on the pavement
    // is the one way past it.
    const SPIKE_BACK = 19;
    const len = width - 0.4;
    const sx = x - tx * SPIKE_BACK, sz = z - tz * SPIKE_BACK;
    const mesh = new THREE.Mesh(spikeStripGeometry(len), game.stingerMaterial
      || (game.stingerMaterial = vertexColorMaterial()));
    mesh.position.set(sx, 0.012, sz);
    mesh.rotation.y = heading;
    mesh.receiveShadow = true;
    game.scene.add(mesh);
    block.meshes.push(mesh);
    block.spikes = { x: sx, z: sz, tx, tz, halfLen: len * 0.5, halfDepth: 0.45 };

    return block;
  }

  /**
   * Has the player's car gone over a stinger since last frame?
   *
   * Each wheel's path over the frame is tested against the strip, not just
   * where the wheel is now: at 200 km/h on a slow frame a wheel travels two
   * metres, and a strip 70 cm deep is easily stepped over between two checks.
   * A punctured tyre goes down over a couple of seconds (Vehicle.postStep)
   * rather than instantly, so the car is still just about drivable -- and the
   * garage mends it.
   */
  _checkSpikes(target, dt) {
    if (!this._wheelPrev) this._wheelPrev = target.wheels.map(() => null);
    let hit = 0;
    for (let i = 0; i < target.wheels.length; i++) {
      const w = target.wheels[i];
      const cur = { x: w.contact.x, z: w.contact.z };
      const prev = this._wheelPrev[i];
      this._wheelPrev[i] = cur;
      if (!prev || !w.grounded || w.punctured) continue;
      // Further than the car could have driven: it was put somewhere -- flipped
      // upright, restarted -- and the line between is not a path it took.
      if (Math.hypot(cur.x - prev.x, cur.z - prev.z) > target.speed * dt * 2 + 1.5) continue;
      for (const b of this.blocks) {
        const s = b.spikes;
        if (!s) continue;
        if (dist2(cur.x, cur.z, s.x, s.z) > s.halfLen + 30) continue;
        // Into the strip's frame: along the road, and across it.
        const along = (p) => (p.x - s.x) * s.tx + (p.z - s.z) * s.tz;
        const across = (p) => (p.x - s.x) * -s.tz + (p.z - s.z) * s.tx;
        const a0 = along(prev), a1 = along(cur);
        const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
        if (hi < -s.halfDepth || lo > s.halfDepth) continue;
        // Where the path crosses the middle of the strip, or where it is now.
        const t = Math.abs(a1 - a0) > 1e-6 ? Math.min(1, Math.max(0, -a0 / (a1 - a0))) : 1;
        const c = across({ x: prev.x + (cur.x - prev.x) * t, z: prev.z + (cur.z - prev.z) * t });
        if (Math.abs(c) > s.halfLen + 0.15) continue;
        w.punctured = true;
        hit++;
        break;
      }
    }
    if (hit) {
      this.game.camera3.impulse(0.25);
      if (this.game.audio) this.game.audio.impact(0.3);
      if (!this._stungAt || this.game.clock - this._stungAt > 6) {
        this._stungAt = this.game.clock;
        this.game.say('stinger', [
          'Control, stinger\'s got them. Tyres are going.',
          'Control, they\'ve hit the stinger!',
          'Control, stinger successful, they\'re on the rims.',
        ], {}, true);
      }
    }
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
    this._wheelPrev = null;
  }
}

/**
 * A stinger: a long hinged strip of spiked links, laid across the road. Built
 * lying along X, centred, for the mesh to be turned to face the traffic.
 */
function spikeStripGeometry(len) {
  const b = new MeshBuilder();
  const n = Math.max(6, Math.round(len / 0.36));
  const step = len / n;
  for (let i = 0; i < n; i++) {
    const x = -len * 0.5 + step * (i + 0.5);
    // Links alternate a little in height and angle, as a folded-out stinger does.
    b.addBox(step * 0.92, 0.05, 0.50, x, 0.025, 0, i % 2 ? 0x34383d : 0x202327, (i % 2 ? 1 : -1) * 0.06);
    // A reflective stripe down each link, so it can be seen coming.
    b.addBox(step * 0.7, 0.052, 0.07, x, 0.027, 0, 0xe8c21a, (i % 2 ? 1 : -1) * 0.06);
    for (const dz of [-0.18, -0.08, 0.08, 0.18]) {
      for (const dx of [-0.25, 0.25]) {
        b.addTaperedBox(0.05, 0.13, 0.05, x + dx * step, 0.11, dz, 0xeef1f4, 0.1, 0.1);
      }
    }
  }
  // Yellow and black ends, and the lanyard back to the kerb.
  for (const s of [1, -1]) {
    b.addBox(0.30, 0.08, 0.56, s * (len * 0.5 + 0.11), 0.025, 0, 0xf2c20f);
    b.addBox(0.10, 0.082, 0.56, s * (len * 0.5 + 0.11), 0.026, 0, 0x121212);
  }
  return b.build();
}
