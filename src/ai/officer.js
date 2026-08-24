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

    let controls;
    switch (this.role) {
      case ROLE.PURSUE:    controls = this._pursue(dt, target); break;
      case ROLE.INTERCEPT: controls = this._intercept(dt, target); break;
      case ROLE.PIT:       controls = this._pit(dt, target); break;
      case ROLE.BOX:       controls = this._box(dt, target); break;
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
  _pursue(dt, target) {
    if (!target) return this._patrol(dt);
    const v = this.vehicle;
    const d = this.distanceTo(target.position);

    // Only chase the target's position directly when there is actually a clear
    // line to it. Driving at a car you cannot see means driving at whatever is
    // between you and it, which in a city of eighty-metre blocks is a building.
    this._losTimer = (this._losTimer || 0) - dt;
    if (this._losTimer <= 0) {
      this._losTimer = 0.2;
      _eye.copy(v.position); _eye.y += 1.0;
      _aim2.copy(target.position); _aim2.y += 0.8;
      this._hasLos = hasLineOfSight(this.game.world, _eye, _aim2, 1.5);
    }

    if (d > 85 || !this._hasLos) {
      // Far away, or no clear line: the road network matters more.
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
