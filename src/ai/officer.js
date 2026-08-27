// One police unit.
//
// The officer owns a vehicle and a Driver, and translates whatever role the
// dispatcher has given it into a point to aim at and a speed to hold. It does
// not decide strategy -- that is the dispatcher's job -- but it does decide
// how to execute, which is where an individual unit's skill shows up.

import * as THREE from 'three';
import { Driver, SKILL } from './driver.js';
import { pitUpdate, relativeTo, boxAim, boxSpeed } from './tactics.js';
import { hasLineOfSight } from '../physics/world.js';
import { clamp, clamp01, lerp, dist2, sign } from '../util/math.js';

const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _aim2 = new THREE.Vector3();

export const ROLE = {
  PATROL: 'patrol',
  RESPOND: 'respond',
  PURSUE: 'pursue',
  INTERCEPT: 'intercept',
  PIT: 'pit',
  BOX: 'box',
  BLOCK: 'block',
  HOLD: 'hold',
  SEARCH: 'search',
  DISABLED: 'disabled',
};

let nextCallsign = 1;

export class Officer {
  constructor(game, vehicle, opts = {}) {
    this.game = game;
    this.vehicle = vehicle;
    this.skill = opts.skill || SKILL.regular;
    this.driver = new Driver(vehicle, this.skill);
    this.kind = opts.kind || 'patrol';
    this.callsign = opts.callsign || ('U' + (nextCallsign++));

    this.role = ROLE.PATROL;
    this.orders = {};
    this.goalNode = null;
    this.repathTimer = Math.random() * 0.6;
    this.pitState = {};
    this.recoverTimer = 0;
    this.lastRole = null;
    this.stuckOnPath = 0;
  }

  get position() { return this.vehicle.position; }
  get disabled() { return this.vehicle.disabled; }

  /** Distance to a world point, on the ground plane. */
  distanceTo(p) { return dist2(this.vehicle.position.x, this.vehicle.position.z, p.x, p.z); }

  /**
   * Route to a node, starting from where this car actually is rather than from
   * the junction behind it. Returns false if no route exists.
   */
  _routeTo(goalId, laneOffset = 2.4) {
    const v = this.vehicle;
    const pts = this.game.graph.pathFromPosition(
      v.position.x, v.position.z, v.forward.x, v.forward.z, goalId, laneOffset,
    );
    if (pts.length < 2) return false;
    this.driver.setPath(pts);
    this.goalNode = goalId;
    return true;
  }

  setRole(role, orders = {}) {
    if (role !== this.role) {
      this.role = role;
      this.goalNode = null;
      this.driver.setPath([]);
      this.repathTimer = 0;
      if (role !== ROLE.PIT) this.pitState = {};
    }
    this.orders = orders;
  }

  // ------------------------------------------------------------------ update

  update(dt, target) {
    const v = this.vehicle;

    // A car on its roof, or wrecked, is out of the pursuit until it recovers.
    if (v.disabled || v.flippedFor > 2.2) {
      this.recoverTimer += dt;
      v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      if (v.flippedFor > 2.2 && this.recoverTimer > 3.0) {
        // Right the car where it lies rather than despawning it; a wreck in
        // the road is a hazard the pursuit has to deal with.
        _tmp.copy(v.position); _tmp.y += 1.2;
        v.teleport(_tmp, Math.atan2(v.forward.x, v.forward.z));
        v.damage = Math.min(v.damage, 0.55);
        v.disabled = false;
        this.recoverTimer = 0;
      }
      return;
    }
    this.recoverTimer = 0;

    this.driver.avoid(this.game.vehicles, dt);
    this.repathTimer -= dt;
    this._updateAssist(target);

    // A unit that has just backed out of something needs a new line, or it
    // drives straight back into whatever it reversed away from.
    if (this.driver.needsRepath) {
      this.driver.needsRepath = false;
      this.driver.setPath([]);
      this.repathTimer = 0;
      this.goalNode = null;
    }

    // A patrol car obeys the limit; a unit responding to a shout does not.
    // Without this the pursuit can never close a gap on a speeding target,
    // because every unit politely sticks to the posted speed.
    this.driver.limitScale = this.role === ROLE.PATROL ? 1.0
      : this.role === ROLE.SEARCH ? 1.5
        : 3.0;

    // Anything that is not pottering about on its beat may cut a corner, put
    // two wheels on the verge, or take a line straight across open ground. A
    // patrol car keeps to the carriageway, and that difference in how they
    // move is part of how you tell one from the other before the lights come
    // on.
    this.driver.allowOffRoad = this.role !== ROLE.PATROL;

    // Off the hard surface: getting back onto it is the only job.
    //
    // Nothing used to say this, and following a road you are not on is not the
    // same as rejoining it -- a unit that ended up on a verge kept aiming at
    // its lookahead point on the carriageway and ground along the grass beside
    // it at walking pace, sometimes for the rest of the chase. On the town map
    // that was a fifth of the pursuit's time. Aim at the road itself, not at
    // where the road was taking us.
    const regain = this._regainRoad(dt);
    if (regain) { v.setControls(regain); return; }

    let controls;
    switch (this.role) {
      case ROLE.PURSUE:    controls = this._pursue(dt, target); break;
      case ROLE.INTERCEPT: controls = this._intercept(dt, target); break;
      case ROLE.PIT:       controls = this._pit(dt, target); break;
      case ROLE.BOX:       controls = this._box(dt, target); break;
      case ROLE.BLOCK:     controls = this._block(dt, target); break;
      case ROLE.HOLD:      controls = this._hold(dt, target); break;
      case ROLE.RESPOND:   controls = this._goTo(dt, this.orders.point, 1.0); break;
      case ROLE.SEARCH:    controls = this._search(dt); break;
      default:             controls = this._patrol(dt); break;
    }

    v.setControls(controls);
  }

  // ------------------------------------------------------------------ roles

  _patrol(dt) {
    const g = this.game.graph;
    if (!this.driver.hasPath || this.driver.remaining() < 40) {
      // Patrol the player's part of town rather than the whole map. Three cars
      // wandering four square kilometres at random means you can drive for a
      // minute and a half without meeting one, and the game never starts.
      const anchor = this.game.player ? this.game.player.position : this.position;
      let to = null;
      for (let i = 0; i < 14; i++) {
        const n = g.randomNode(this.game.rng);
        if (dist2(n.x, n.z, anchor.x, anchor.z) < 650) { to = n; break; }
      }
      if (!to) to = g.randomNode(this.game.rng);
      this._routeTo(to.id, 3.0);
    }
    // Patrols obey the limit; that difference in pace is how you spot them.
    return this.driver.followPath(dt, 22);
  }

  _search(dt) {
    const g = this.game.graph;
    const centre = this.orders.point || this.position;
    if (!this.driver.hasPath || this.driver.remaining() < 30) {
      // Wander around the last known position rather than parking on it.
      const a = this.game.rng() * Math.PI * 2;
      const r = 60 + this.game.rng() * 180;
      const to = g.nearestNode(centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r);
      this._routeTo(to.id, 2.0);
    }
    return this.driver.followPath(dt, 30);
  }

  /** Head for a fixed world point by road, flat out. */
  _goTo(dt, point, speedFactor = 1) {
    if (!point) return this._patrol(dt);
    const g = this.game.graph;
    const goal = g.nearestNode(point.x, point.z);

    if (this.repathTimer <= 0 || !this.driver.hasPath || this.goalNode !== goal.id) {
      this._routeTo(goal.id, 2.4);
      this.repathTimer = 1.1;
    }

    if (this.driver.remaining() < 22) {
      // Close enough to drive at it directly.
      return this.driver.driveTo(point, this._chaseSpeed() * 0.8, dt);
    }
    return this.driver.followPath(dt, this._chaseSpeed() * speedFactor);
  }

  /**
   * Direct pursuit. Close in, then aim at where the target will be rather than
   * where it is -- tailing the exact position is what produces the classic
   * conga line of police cars.
   */
  /**
   * If this car is off the carriageway, controls that drive it back on.
   * Returns null when it is where it should be.
   *
   * The aim point is deliberately a little way *along* the road rather than
   * the closest point on it: aiming at the nearest point means driving at the
   * kerb square on, which is how a car ends up sitting against it with the
   * wheels turned.
   */
  _regainRoad(dt) {
    const v = this.vehicle;
    const sim = this.game.sim;
    if (this.role === ROLE.HOLD) return null;
    if (!sim || !sim.surfaceAt || sim.surfaceAt(v.position.x, v.position.z) !== 0) {
      this.offRoadFor = 0;
      return null;
    }

    this.offRoadFor = (this.offRoadFor || 0) + dt;

    // A unit that is allowed off the carriageway is not lost, it is taking a
    // line -- so this stops being "get back on the road" and becomes purely a
    // rescue for one that has genuinely bogged down. Without the distinction
    // the corner cutting would be dragged straight back onto the tarmac the
    // moment it began.
    if (this.driver.allowOffRoad) {
      if (v.speed > 7 || this.offRoadFor < 1.5) return null;
    } else if (this.offRoadFor < 0.35) {
      // A wheel clipping a verge is not worth abandoning a patrol for.
      return null;
    }

    const g = this.game.graph;
    const snap = g.nearestEdge(v.position.x, v.position.z);
    if (!snap) return null;

    const dir = g.edgeDirection(snap.edge, snap.along, { x: 0, z: 1 });
    if (dir.x * v.forward.x + dir.z * v.forward.z < 0) { dir.x = -dir.x; dir.z = -dir.z; }
    _aim.set(snap.x + dir.x * 10, 0, snap.z + dir.z * 10);

    this.driver.setPath([]);
    // Not ignoreSurroundings any more. It was set because the clearance probe
    // reads the kerb and the hedge beside the road as reasons to stop -- but a
    // car crawling back onto the carriageway with every check switched off
    // will happily drive through a house to get there, and did. The
    // last-resort wall clamp inside driveTo now covers the genuinely solid
    // case while leaving the kerb alone.
    return this.driver.driveTo(_aim, 13, dt, { allowHandbrake: false, lane: false });
  }

  /**
   * Is the straight line between two points actually road?
   *
   * A clear line of sight is not the same as a road, and treating the two as
   * equivalent is what put a quarter of the pursuit on the grass. On a grid a
   * clear view of the car ahead usually does mean you are both on the same
   * street; on a town map of curving roads it means the line cuts the bend,
   * straight over whatever is inside it. Nothing then pulled the unit back --
   * it was driving at a point, not following a road -- so it crossed the field
   * and rejoined wherever it happened to arrive.
   */
  _surfaceClear(from, to) {
    const sim = this.game.sim;
    if (!sim || !sim.surfaceAt) return true;
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) return true;
    const steps = clamp(Math.round(len / 7), 2, 14);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (sim.surfaceAt(from.x + dx * t, from.z + dz * t) === 0) return false;
    }
    return true;
  }

  _pursue(dt, target) {
    if (!target) return this._patrol(dt);
    const v = this.vehicle;
    const d = this.distanceTo(target.position);

    // Only chase the target's position directly when there is actually a clear
    // line to it. Driving at a car you cannot see means driving at whatever is
    // between you and it, which in a city of eighty-metre blocks is a building.
    // Straight at them, as the crow flies, at any range. Distance is not a
    // reason to take the roads and neither is the surface: grass, verges,
    // playing fields and car parks are all just ground, and a unit crosses
    // them. The only thing that sends a car back to the road network is
    // something solid actually in the way.
    //
    // The check is a corridor, not a ray. A single centre line threading the
    // gap between two buildings reads as clear for something with no width;
    // the car is two metres across and closing at whatever the target is
    // doing, and it takes the corner of the building.
    this._losTimer = (this._losTimer || 0) - dt;
    if (this._losTimer <= 0) {
      this._losTimer = 0.2;
      const dx = target.position.x - v.position.x, dz = target.position.z - v.position.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;

      // Only the near stretch has to be clear, not the whole line. Requiring a
      // clean corridor all the way to a target three hundred metres off means
      // it is essentially never clear in a town, and the unit takes the roads
      // every time -- which is exactly the "they still use roads when I'm far
      // away" complaint. Steering is continuous: a car only needs to know the
      // next few seconds are open, and it re-asks four times a second.
      const look = Math.min(len, 70);
      const ux = dx / len, uz = dz / len;
      let open = true;
      for (const off of [-2.2, 0, 2.2]) {
        _eye.set(v.position.x + nx * off, v.position.y + 1.0, v.position.z + nz * off);
        _aim2.set(
          v.position.x + nx * off + ux * look,
          target.position.y + 0.8,
          v.position.z + nz * off + uz * look,
        );
        if (!hasLineOfSight(this.game.world, _eye, _aim2, 1.5)) { open = false; break; }
      }
      this._hasLos = open;
    }

    if (!this._hasLos) {
      // Something solid in the way. The road network is the way round it.
      return this._goTo(dt, target.position, 1.0);
    }

    const r = relativeTo(target, v);
    // Lead the target by roughly the time it takes to cover the gap.
    const closing = Math.max(4, v.speed);
    const lead = clamp(d / closing, 0, 1.15);
    _aim.copy(target.position).addScaledVector(target.linvel, lead);

    // Hang slightly off to one side once close, so a following unit is already
    // positioned for a PIT rather than square behind the boot.
    if (d < 26) {
      const side = Math.abs(r.lat) > 0.5 ? sign(r.lat) : (this.vehicle.id % 2 ? 1 : -1);
      _aim.addScaledVector(target.left, side * lerp(2.2, 0.4, clamp01(d / 26)));
    }

    this.driver.setPath([]);
    const speed = Math.abs(target.forwardSpeed) + clamp(d * 0.35, 2, 14);
    return this.driver.driveTo(_aim, Math.min(speed, this._chaseSpeed()), dt);
  }

  /**
   * Race to a junction the target has not reached yet. The whole point is that
   * the unit ignores the target's current position entirely and drives its own
   * route at maximum pace.
   */
  _intercept(dt, target) {
    const g = this.game.graph;
    const node = this.orders.node;
    if (node === undefined || node === null) return this._pursue(dt, target);

    if (this.repathTimer <= 0 || !this.driver.hasPath || this.goalNode !== node) {
      this._routeTo(node, 2.4);
      this.repathTimer = 1.4;
    }

    const arrived = this.driver.remaining() < 26;
    if (arrived && target) {
      // Sitting on the junction now: turn to face the incoming target and hold
      // position so the target arrives into a car, not an empty box.
      const d = this.distanceTo(target.position);
      if (d < 70) return this._pursue(dt, target);
      _aim.copy(target.position);
      return this.driver.driveTo(_aim, 4, dt, { holdStill: true });
    }
    return this.driver.followPath(dt, this._chaseSpeed());
  }

  _pit(dt, target) {
    if (!target) return this._patrol(dt);
    const res = pitUpdate(this.pitState, this.vehicle, target, dt);
    if (res.done) {
      this.pitState = {};
      this.game.dispatcher.onPitFinished(this, res);
      return this._pursue(dt, target);
    }
    this.driver.setPath([]);
    return this.driver.driveTo(res.aim, res.speed, dt, {
      allowHandbrake: res.allowHandbrake !== false,
    });
  }

  /**
   * Manning a roadblock.
   *
   * These are ordinary police cars, not scenery: they are parked across the
   * carriageway with the handbrake on, and they stay there. What they are
   * waiting for is a reason to stop waiting -- either you get past them, or
   * you give up and go back the way you came. Either way the block has done
   * its job and there is no sense in three cars sitting in a road you are no
   * longer on, so they come off the handbrake and join the chase.
   *
   * `orders.site` is the centre of the block and `orders.approach` is a unit
   * vector pointing back up the road you arrive along, so `s` below is how far
   * short of the block you still are. It starts positive, and goes negative
   * the moment you are through.
   */
  _hold(dt, target) {
    const out = this._parked();
    if (!target) return out;

    const o = this.orders;
    const site = o.site, ap = o.approach;
    if (!site || !ap) return out;

    const rx = target.position.x - site.x, rz = target.position.z - site.z;
    const s = rx * ap.x + rz * ap.z;
    const range = Math.hypot(rx, rz);

    // Through the block. Everyone here goes after them.
    if (s < -14) return this._release('past');

    // Turned back. Not simply "far away" -- a target that has not reached the
    // block yet is far away by definition, and a block that abandoned its post
    // on that basis would never be there when you arrived. This is about a
    // target who was closing and has stopped closing: they got near enough to
    // see it, and are now well beyond that again.
    if (range < (o.sawItFrom || 130)) o.committed = true;
    if (o.committed && s > 0 && range > 150) {
      o.turnedAway = (o.turnedAway || 0) + dt;
      if (o.turnedAway > 2.0) return this._release('turned back');
    } else {
      o.turnedAway = 0;
    }

    return out;
  }

  /** Stationary, brakes on. Used by anyone whose job is to be an obstacle. */
  _parked() {
    const out = this.driver.out;
    out.throttle = 0;
    out.brake = 1;
    out.steer = 0;
    out.handbrake = 1;
    out.clutchKick = false;
    return out;
  }

  /** Leave a roadblock and join the pursuit. */
  _release(why) {
    if (this.game.roadblocks) this.game.roadblocks.onUnitReleased(this, why);
    this.setRole(ROLE.PURSUE);
    return this._parked();
  }

  /**
   * The rolling block: sit on the road in front of the target, travelling the
   * same way but deliberately slower, and slide across to stay in their way.
   *
   * It is not a wall -- you can go round it, and it will try to move with you.
   * What it does is scrub speed off a runner who would otherwise be gone, and
   * hand the units behind a chance to close.
   */
  _block(dt, target) {
    if (!target) return this._patrol(dt);
    const v = this.vehicle;
    const g = this.game.graph;
    const r = relativeTo(target, v);

    const snap = g.nearestEdge(v.position.x, v.position.z);
    if (!snap) return this._pursue(dt, target);

    // Once they are past us the block has failed; fall back into the chase.
    // The sideways test only applies once they are actually on us: a blocker
    // two hundred metres up a curving road is legitimately well off to one
    // side in the target's frame, and giving up on that would end every block
    // on the frame it began.
    //
    // How far sideways counts as "gone round us" depends on the road. A fixed
    // fourteen metres is narrower than a dual carriageway, so on the widest
    // roads the block was giving up on a target that had merely moved into the
    // far lane -- exactly where it should have been following them across.
    const engaged = r.long < 45;
    const sidestep = Math.max(14, snap.edge.width * 0.75);
    if (r.long < -7 || (engaged && Math.abs(r.lat) > sidestep)) {
      // Change role, not just behaviour. Returning pursuit controls while
      // still holding the BLOCK role means we come straight back in here next
      // frame and report the block ended all over again, which holds the
      // dispatcher's cooldown open and stops any further block being called.
      this.game.dispatcher.onBlockEnded(this);
      this.setRole(ROLE.PURSUE);
      return this._pursue(dt, target);
    }

    // Road direction, oriented the way we are travelling.
    const dir = g.edgeDirection(snap.edge, snap.along, { x: 0, z: 1 });
    if (dir.x * v.forward.x + dir.z * v.forward.z < 0) { dir.x = -dir.x; dir.z = -dir.z; }

    // Where the target sits across the carriageway, measured from our own
    // point on the centreline. Matching it is what keeps us in front of them
    // rather than politely alongside.
    const rx = target.position.x - snap.x, rz = target.position.z - snap.z;
    // Two metres of margin left the blocker's flank within touching distance
    // of the kerb -- and its contacts are lateral, not frontal: it slides
    // toward the edge to match the target while every forward check reports
    // twenty-odd metres of clear road. Sitting a car's width in from the edge
    // costs almost nothing in coverage and is most of the difference.
    const margin = Math.min(3.4, snap.edge.width * 0.28);
    const lat = clamp(rx * dir.z - rz * dir.x,
      -(snap.edge.width * 0.5 - margin), snap.edge.width * 0.5 - margin);

    // Follow the carriageway forward rather than extrapolating a straight line
    // down the current tangent. Straight-line lead is fine on a straight and
    // wrong on every bend -- it puts the aim point outside the curve, and on a
    // road that turns even moderately that is inside a building. Every scenery
    // impact left in the pursuit was a blocker doing exactly this, at 58 to
    // 64 km/h with something solid at just about its own lead distance.
    const lead = 16 + v.speed * 0.35;
    // nearestEdge gives a point and a distance along, but no tangent -- take
    // that from pointAt so we know which way along the polyline we are going.
    const here = g.pointAt(snap.edge, snap.along);
    const alongSign = (dir.x * here.tx + dir.z * here.tz) >= 0 ? 1 : -1;
    const at = clamp(snap.along + alongSign * lead, 0, snap.edge.length);
    const p = g.pointAt(snap.edge, at);
    const tx = p.tx * alongSign, tz = p.tz * alongSign;
    _aim.set(p.x + tz * lat, 0, p.z - tx * lat);

    // Slower than them, so they run up on us -- but the margin depends on the
    // gap. From a long way ahead we give away a lot of speed so the gap closes
    // in seconds rather than half a minute; once they are on us we ease back to
    // just under their pace, which holds the block instead of simply being
    // rammed off the road.
    const factor = lerp(0.88, 0.66, clamp01((r.long - 20) / 90));
    let speed = clamp(Math.abs(target.forwardSpeed) * factor, 7, this._chaseSpeed());

    // A blocker is the one unit that deliberately moves sideways across the
    // carriageway at speed, and that is what puts its flank into things. It
    // gets the stricter rule the rest do not: be slow enough to *turn* within
    // whatever is in the way, not merely to stop before it. Applied to every
    // unit this made the city worse -- there is a building thirty metres ahead
    // at every junction and they all became timid -- but the blocker was, and
    // remained, the single largest source of scenery contact on both maps.
    const near = this.driver.wallNear;
    if (near < 45) {
      speed = Math.min(speed, Math.sqrt(1.25 * 9.81 * Math.max(8, near)));
    }

    this.driver.setPath([]);
    return this.driver.driveTo(_aim, speed, dt, { allowHandbrake: false });
  }

  _box(dt, target) {
    if (!target || !this.orders.slot) return this._pursue(dt, target);
    const t = this.orders.tightness || 0;
    boxAim(target, this.orders.slot, t, _aim);
    const speed = boxSpeed(target, this.orders.slot, t);
    this.driver.setPath([]);
    return this.driver.driveTo(_aim, speed, dt, { allowHandbrake: false });
  }

  /**
   * Rubber-banding.
   *
   * A unit closing from a distance gets grip, stability and up to 50% more
   * speed, scaled by how far behind it is. All of it is gone by 30 m: the part
   * of the chase you can actually see is fought on the same physics you are.
   * The taper between 30 and 50 m exists so a unit does not have the floor
   * pulled out from under it mid-corner and spin on the spot.
   */
  _updateAssist(target) {
    const a = this.vehicle.assist;
    const chasing = target && this.game.heat.tier > 0 && this.role !== ROLE.PATROL;
    if (!chasing) { a.boost = 1; a.grip = 1; a.stability = 0; a.shielded = false; return; }

    const d = this.distanceTo(target.position);
    const engaged = clamp01((d - 30) / 20);            // 0 at 30 m, 1 at 50 m
    if (engaged <= 0) { a.boost = 1; a.grip = 1; a.stability = 0; a.shielded = false; return; }

    const far = clamp01((d - 30) / 220);               // 0 at 30 m, 1 at 250 m
    a.boost = 1 + 0.75 * far * engaged;
    a.grip = 1 + 0.35 * engaged;
    a.stability = engaged;
    // Still on the way: a crash costs this unit time, not its whole chase.
    a.shielded = true;
  }

  /** Top speed this unit is willing to run at, given its car and its nerve. */
  _chaseSpeed() {
    return this.vehicle.spec.topSpeedHint
      * clamp(lerp(0.86, 1.06, this.skill.aggression - 0.6), 0.8, 1.06)
      * this.vehicle.assist.boost;
  }
}
