// One police unit.
//
// The officer owns a vehicle and a Driver, and translates whatever role the
// dispatcher has given it into a point to aim at and a speed to hold. It does
// not decide strategy -- that is the dispatcher's job -- but it does decide
// how to execute, which is where an individual unit's skill shows up.

import * as THREE from 'three';
import { Driver, SKILL } from './driver.js';
import { pitUpdate, relativeTo, boxAim, boxSpeed } from './tactics.js';
import { hasLineOfSight, sweepBox, raycast, groups, GROUP, RAY_SOLID } from '../physics/world.js';
import { WORLD_HALF } from '../world/common.js';
import { clamp, clamp01, lerp, dist2, sign } from '../util/math.js';

const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _aim2 = new THREE.Vector3();
const _dirTmp = new THREE.Vector3();
const _origin2 = new THREE.Vector3();

/** Longest a searching unit keeps trying to reach one spot, seconds. */
const SPOT_PATIENCE = 28;
/** Top speed on the road between search spots, m/s: about 80 km/h. */
const SEARCH_PACE = 22;
/** Top speed off it, m/s: about 36 km/h. A garden is not a place to be quick. */
const SEARCH_OFF_ROAD = 10;
/**
 * A patrol car stuck behind the player's car sitting in the road (see
 * _warnIfBlocked): seconds before the first blip of lights and siren, seconds
 * between blips, how long each lasts, how many warnings it gives, and seconds
 * after the last one before it starts a chase.
 */
const BLOCK_WARN_AFTER = 5;
const BLOCK_WARN_EVERY = 10;
const BLIP_SECONDS = 1.0;
const BLOCK_WARNINGS = 2;
const BLOCK_PURSUE_AFTER = 3;
/** What a search spot has to be clear of, tested straight down at its middle and a car's length round it. */
const SPOT_SOLID = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP);
const SPOT_PROBES = [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]];
const DOWN = { x: 0, y: -1, z: 0 };

export const ROLE = {
  PATROL: 'patrol',
  RESPOND: 'respond',
  PURSUE: 'pursue',
  INTERCEPT: 'intercept',
  PIT: 'pit',
  BOX: 'box',
  BLOCK: 'block',
  RHINO: 'rhino',
  HOLD: 'hold',
  SEARCH: 'search',
  DISABLED: 'disabled',
};

/**
 * Callsigns are a pool, not a counter.
 *
 * A force of nine cars that has been running for ten minutes had got to U50 and
 * beyond, because every car that came on and went off again took its number
 * with it: "it will start saying, unit fifty-one, going for a PIT". Numbers now
 * come back when a car is retired, so the board reads U5 to U16 all night and a
 * callsign means "one of the cars out there" rather than "how many have ever
 * been out there".
 */
const takenCallsigns = new Set();

/**
 * Numbers kept back for police players, who are given U1 upward in the order
 * they joined (see RemoteUnit in main.js), so there are never two units
 * answering to U1. None are held back in a single-player game, where the AI
 * should still start at U1 as it always has.
 */
export const HUMAN_CALLSIGNS = 4;
let reserved = 0;
export function reserveCallsigns(n) { reserved = Math.max(0, Math.floor(n) || 0); }

function claimCallsign() {
  for (let i = reserved + 1; i < 200; i++) {
    if (takenCallsigns.has(i)) continue;
    takenCallsigns.add(i);
    return { id: i, text: 'U' + i };
  }
  return { id: 0, text: 'U0' };
}

export function releaseCallsign(id) {
  if (id) takenCallsigns.delete(id);
}

export class Officer {
  constructor(game, vehicle, opts = {}) {
    this.game = game;
    this.vehicle = vehicle;
    this.skill = opts.skill || SKILL.regular;
    this.driver = new Driver(vehicle, this.skill);
    this.kind = opts.kind || 'patrol';
    if (opts.callsign) {
      this.callsign = opts.callsign;
    } else {
      const cs = claimCallsign();
      this.callsign = cs.text;
      this.callsignId = cs.id;
    }

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

  /**
   * How willing this unit is to make contact rather than merely follow.
   * Nothing at one star, everything at five. Drives the close-quarters aim,
   * the closing speed and the rubber-band boost.
   */
  get aggression() {
    return clamp01((this.game.heat.tier - 1) / 4);
  }

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
      Infinity, v.speed,
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
      this._ramBack = 0;
      this._searchSpot = null;
      this._wayIn = null;
      this._wentIn = false;
    }
    this.orders = orders;
  }

  // ------------------------------------------------------------------ update

  update(dt, target) {
    const v = this.vehicle;
    // A "move along" blip of lights and siren runs down whatever else happens
    // (see _warnIfBlocked).
    if (v.blipFor > 0) v.blipFor = Math.max(0, v.blipFor - dt);

    // A unit running a manoeuvre has right of way over the rest of the pack.
    // The flag lives on the vehicle because that is all the Driver can see of
    // the other cars, and giving way is the Driver's job. Set before the
    // recovery check below, so a car that ends up on its roof mid-PIT stops
    // having everyone else defer to it.
    v.priority = !v.disabled
      && (this.role === ROLE.PIT || this.role === ROLE.BOX || this.role === ROLE.BLOCK
        || this.role === ROLE.RHINO);

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

    // It is over: everybody stops. The screen says you have been arrested, and
    // behind it the chase used to carry on -- cars still driving at a car that
    // is not going anywhere, boxes still forming, the radio still working.
    if (this.game.outcome === 'busted') {
      v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      return;
    }

    // Making the arrest: stay put. A unit that has the suspect stopped against
    // it used to carry on doing whatever its role said -- reversing out of the
    // contact, going round for another push -- which opened the gap and
    // cancelled the arrest it had just started. Anyone this close to a stopped
    // suspect, or to one the arrest clock is already running on, sits on the
    // brakes until the suspect moves off.
    if (this._holdingArrest(target)) {
      v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      return;
    }

    // A unit driving at the player does not steer round the player: that is
    // the car it is trying to reach, or to hit.
    const atTarget = this.role === ROLE.PURSUE || this.role === ROLE.RHINO;
    this.driver.avoid(this.game.vehicles, dt, atTarget && target ? target : null);
    // A car on its beat waits behind the player's car if it is in the way,
    // rather than driving into it -- and after a while, tells them to move.
    // Only on patrol: a unit that is after you has no reason to wait politely.
    const patrolling = this.role === ROLE.PATROL;
    this.driver.holdBehind(patrolling ? this.game.player : null, dt);
    this._warnIfBlocked(dt, patrolling);
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
    //
    // A searching unit is not in a hurry either. It leaves the road on purpose,
    // to check somewhere (see _search), and otherwise keeps to it: cutting
    // corners on the way between spots was most of what it hit, at speed,
    // through back gardens.
    const searchingRoad = this.role === ROLE.SEARCH && !this._wentIn
      && !(this._searchSpot && this._searchSpot.direct);
    this.driver.allowOffRoad = this.role !== ROLE.PATROL && !searchingRoad;

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
      case ROLE.RHINO:     controls = this._rhino(dt, target); break;
      case ROLE.HOLD:      controls = this._hold(dt, target); break;
      case ROLE.RESPOND:   controls = this._goTo(dt, this.orders.point, 1.0); break;
      case ROLE.SEARCH:    controls = this._search(dt); break;
      default:             controls = this._patrol(dt); break;
    }

    v.setControls(controls);
  }

  /**
   * Is this unit one of the cars pinning a stopped suspect? Measured between
   * the cars rather than their centres, the way the arrest rule measures it
   * (see Heat._checkBust), with a little more reach once the clock is running
   * so a car that has rocked back half a metre does not drive off.
   */
  _holdingArrest(target) {
    const heat = this.game.heat;
    if (!target || heat.value <= 0 || this.game.outcome) return false;
    const gap = this.distanceTo(target.position)
      - target.spec.dims.l * 0.5 - this.vehicle.spec.dims.l * 0.5;
    const clockRunning = heat.bustTimer > 0.05;
    if (clockRunning) return gap <= 5 && target.speed < 3;
    return gap <= 3.2 && target.speed < 1.2;
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
    // They obey the signals too, and only they do: a unit running to a shout
    // or already in a pursuit has blue lights on and goes through.
    return this.driver.followPath(dt, Math.min(22, this._signalCap()));
  }

  /**
   * Sitting behind the player's car, stopped in the road in front of it: after
   * a few seconds, a blip of the lights and the siren -- "move along" -- and a
   * word on the radio. "After, say, five seconds... they flash their lights
   * for a second and turn on their sirens for a second." Ten seconds later a
   * second, last warning; still there three seconds after that, it is
   * obstruction, and this car starts a one-star chase.
   *
   * `vehicle.blipFor` is the seconds of blip left; the lamps (Game._render)
   * and the siren (Audio) both read it, without anybody being wanted.
   */
  _warnIfBlocked(dt, patrolling) {
    const v = this.vehicle, p = this.game.player;
    if (!p) return;

    const held = patrolling && this.driver.heldBy && !this._queueingAtLights(p);
    if (held) {
      this._blockedFor = (this._blockedFor || 0) + dt;
      this._unblockedFor = 0;
    } else {
      // Not the moment it creeps forward a metre: properly moving again.
      this._unblockedFor = (this._unblockedFor || 0) + dt;
      if (this._unblockedFor > 2 && this._blockedFor) {
        if (this._warnings && p.speed > 3 && this.distanceTo(p.position) < 60) {
          this.game.say('unblocked', [
            (x) => `${x.cs}, they've moved. Resuming patrol.`,
            (x) => `${x.cs}, vehicle's moved on. Back on patrol.`,
            (x) => `${x.cs}, road's clear, carrying on.`,
            (x) => `${x.cs}, that's got them moving.`,
          ], { cs: this.callsign }, false, { low: true, every: 20 });
        }
        this._blockedFor = 0;
        this._warnings = 0;
      }
      return;
    }

    const vars = { cs: this.callsign, road: this.game.roadName(p.position) };
    // `road` reads "on Cold Harbour" or "in the city", so nothing may end with
    // a preposition of its own before it.

    // Warned twice and still sitting there: that is obstruction, and three
    // seconds after the second warning the car that gave them starts a chase
    // over it -- "after the police say two things... wait three seconds...
    // then just begin a one star pursuit." It says why first, the way the
    // unit that sees you run a red does; the heat's own "all units" call
    // follows.
    const warnings = this._warnings || 0;
    if (warnings >= BLOCK_WARNINGS) {
      const last = BLOCK_WARN_AFTER + (BLOCK_WARNINGS - 1) * BLOCK_WARN_EVERY;
      if (this._blockedFor < last + BLOCK_PURSUE_AFTER || this.game.heat.value > 0) return;
      this.game.say('blocked-chase', [
        (x) => `${x.cs}, two warnings and they still won't move. Lights on, I'm stopping them.`,
        (x) => `${x.cs}, driver's refusing to move ${x.road}. Initiating a stop.`,
        (x) => `${x.cs}, they've been told twice. Pulling them over ${x.road}.`,
        (x) => `${x.cs}, vehicle still obstructing after two warnings. Going for a stop.`,
      ], vars, true);
      this.game.heat.bump(1, 'obstructing a police officer');
      this._blockedFor = 0;
      this._warnings = 0;
      return;
    }

    const due = BLOCK_WARN_AFTER + warnings * BLOCK_WARN_EVERY;
    if (this._blockedFor < due) return;
    this._warnings = warnings + 1;
    v.blipFor = BLIP_SECONDS;

    if (this._warnings === 1) {
      this.game.say('blocked', [
        (x) => `${x.cs}, vehicle stopped in the road ${x.road}, blocking me. Giving them a blip.`,
        (x) => `${x.cs}, got a motorist sat in the carriageway ${x.road}. Letting them know I'm here.`,
        (x) => `${x.cs}, obstruction ${x.road}. Stationary vehicle, won't shift. Quick blast on the twos.`,
        (x) => `${x.cs}, road user parked across my lane ${x.road}. Just a warning for now.`,
        (x) => `${x.cs}, car stopped dead in front of me ${x.road}. Moving them on.`,
      ], vars, false, { every: 8 });
    } else {
      // The last warning: a chase follows three seconds after it.
      this.game.say('blocked-again', [
        (x) => `${x.cs}, they're still not moving. If they don't shift, I'll have to pull them over.`,
        (x) => `${x.cs}, driver's ignoring me ${x.road}. Last warning.`,
        (x) => `${x.cs}, still blocking the road. Last chance, then I'm stopping them.`,
        (x) => `${x.cs}, vehicle still obstructing ${x.road}. Control, may need to pull this one over.`,
        (x) => `${x.cs}, not budging. Final warning.`,
      ], vars, false, { every: 12 });
    }
  }

  /**
   * Waiting behind the player at a red light is not being blocked by them: the
   * signal ahead is against this car, and its stop line is just past theirs.
   */
  _queueingAtLights(p) {
    const lights = this.game.signals;
    if (!lights) return false;
    const v = this.vehicle;
    const d = lights.stopDistanceAt(v.position.x, v.position.z, v.forward.x, v.forward.z, v.speed);
    return isFinite(d) && d < this.distanceTo(p.position) + 12;
  }

  /**
   * Speed cap that brings the car to a stand at the stop line if the signal
   * ahead is against it, and does nothing at all otherwise.
   */
  _signalCap() {
    const lights = this.game.signals;
    if (!lights) return Infinity;
    const v = this.vehicle;
    const d = lights.stopDistanceAt(
      v.position.x, v.position.z, v.forward.x, v.forward.z, v.speed,
    );
    if (!isFinite(d)) return Infinity;
    // v = sqrt(2 a s), at a gentle 3.4 m/s^2 -- a patrol car easing to a halt,
    // not one standing on the brakes.
    return Math.sqrt(2 * 3.4 * Math.max(0, d - 1.0));
  }

  /**
   * Hunt for a car the force has lost.
   *
   * This used to be a wander between road junctions round the last place you
   * were seen, so every search stayed on the tarmac. A car parked in a field,
   * a car park or behind an estate sixty metres from the road was simply never
   * looked for: a stopped car is only picked out from about sixty metres, and
   * measured with `tests/search.js` the searching units spent 0-6% of their
   * time off the road. "Make sure the police search off-road."
   *
   * Now each unit picks a spot to check -- most of them off the road, spread
   * out from the other searchers, widening the longer you have been gone and
   * leaning the way you were heading -- goes along the road to a straight,
   * clear lane that reaches it, down the lane, and back out the way it came.
   */
  _search(dt) {
    const centre = this.orders.point || this.position;
    let spot = this._searchSpot;
    if (spot) {
      spot.age += dt;
      const d = this.distanceTo(spot);
      if (d < spot.best - 4) { spot.best = d; spot.progressAt = spot.age; }
      // Looked at is as good as driven onto, once driving on stops working:
      // a car tucked behind a fence is seen from thirty metres off, not after
      // ten seconds nosing at the fence. While the unit is still getting
      // closer it carries on in -- driving into the field is the search.
      let arrived = d < (spot.offRoad ? 9 : 16);
      if (!arrived && (d < 16 || (d < 30 && spot.age - spot.progressAt > 2.5))) {
        this._spotLookTimer = (this._spotLookTimer || 0) - dt;
        if (this._spotLookTimer <= 0) {
          this._spotLookTimer = 0.3;
          const v = this.vehicle;
          _eye.set(v.position.x, v.position.y + 1.1, v.position.z);
          _aim2.set(spot.x, v.position.y + 0.8, spot.z);
          arrived = hasLineOfSight(this.game.world, _eye, _aim2, 1.5);
        }
      }
      // Not getting any closer: a yard with no way in, a hedge all the way
      // round a field. Remembered, so the next pick is somewhere else.
      const stalled = !arrived && (spot.age - spot.progressAt > 7 || spot.age > SPOT_PATIENCE);
      if (stalled) {
        const failed = this._failedSpots || (this._failedSpots = []);
        failed.push({ x: spot.x, z: spot.z });
        if (failed.length > 8) failed.shift();
      }
      if (arrived || stalled || spot.forX !== centre.x || spot.forZ !== centre.z) spot = null;
    }
    if (!spot) spot = this._searchSpot = this._pickSearchSpot(centre);

    if (!spot) {
      // Nowhere suitable at all: the old wander round the roads.
      const g = this.game.graph;
      if (!this.driver.hasPath || this.driver.remaining() < 30) {
        const a = this.game.rng() * Math.PI * 2;
        const r = 60 + this.game.rng() * 180;
        const to = g.nearestNode(centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r);
        this._routeTo(to.id, 2.0);
      }
      return this.driver.followPath(dt, 30);
    }

    const v = this.vehicle;
    const road = this.game.graph.nearestEdge(v.position.x, v.position.z);
    const out = road ? road.dist - road.edge.width * 0.5 : 0;
    // In at the top of the lane -- or anywhere nearer with a straight, clear
    // run to it from right here, which also covers a unit already out on
    // open ground heading for the next spot across the same field. Committed
    // once started, so a unit that has left the road does not turn back for it
    // the moment a hedge gets in the way.
    if (spot.offRoad && !spot.direct) {
      if (this.distanceTo(spot.entry) < 15) spot.direct = true;
      else if (this.distanceTo(spot) < 90) {
        this._runTimer = (this._runTimer || 0) - dt;
        if (this._runTimer <= 0) {
          this._runTimer = 0.3;
          if (this._runClear(v.position.x, v.position.z, spot.x, spot.z)) spot.direct = true;
        }
      }
    }
    // Only for a unit that went in on purpose. One that ran wide on a corner on
    // its way somewhere is cutting the corner, and the road route has it.
    if (spot.direct) this._wentIn = true;
    const leaving = !spot.direct && out > 6 && this._wentIn;
    this._recordWayIn(road, out, leaving);
    this._mode = spot.direct ? 'field' : leaving ? 'leaving' : 'road';
    if (spot.direct) return this._driveDirect(dt, spot, SEARCH_OFF_ROAD);

    // Leaving a field for somewhere further off: out the way it came in. The
    // nearest bit of road is very often on the far side of a house -- on
    // Wexbury, behind a row of back gardens -- and heading straight for it had
    // units scraping along house walls; the router's own way out is a straight
    // line through whatever is in the field, which is a tree. The way in was
    // clear, because the car just drove it.
    if (leaving) {
      // Whatever route it had is gone once it is driving this; plan afresh
      // back on the road.
      this.goalNode = null;
      const way = this._wayIn;
      if (way && way.length >= 2) {
        const pts = this._wayOutPts || (this._wayOutPts = []);
        pts.length = 0;
        for (let i = way.length - 1; i >= 0; i--) pts.push(way[i]);
        this.driver.setPath(pts);
        return this.driver.followPath(dt, SEARCH_OFF_ROAD * 0.9, { lane: false });
      }
      // Retraced as far as it goes: the last stretch is to where it left the
      // road, not to whichever road happens to be nearest.
      return this._driveDirect(dt, way ? way[0] : road, SEARCH_OFF_ROAD * 0.8);
    }

    // Along the road to it at a searching pace, on a route that runs past it
    // (to the far end of its stretch of road) so there is no last straight
    // dash at a point: that dash is how units at 80 km/h ran wide off a bend.
    // Slowing for the turn off as well: the road planner brakes for bends,
    // not for a gateway half way along a straight.
    const toTurn = this.distanceTo(spot.entry);
    const pace = spot.offRoad ? clamp(12 + (toTurn - 20) * 0.25, 12, SEARCH_PACE) : SEARCH_PACE;
    // Already on that stretch: straight on to its far end.
    if (!spot.along && road && road.edge === spot.edge) spot.along = true;
    const goal = spot.along ? spot.far : spot.near;
    if (!this.driver.hasPath || this.goalNode !== goal) {
      if (!this._routeTo(goal, 2.4)) return this._goTo(dt, spot.entry, 0.5);
    }
    if (this.driver.remaining() < 8) {
      if (!spot.along) {
        // At the near end: now along it.
        spot.along = true;
        this.driver.setPath([]);
      } else {
        // The far end, without passing close enough: it was on the wrong side
        // of something. Somewhere else.
        this._searchSpot = null;
        this.driver.setPath([]);
      }
    }
    return this.driver.followPath(dt, pace);
  }

  /**
   * Keep `_wayIn`: the line this car has driven since it last left the road,
   * starting from the road. Grows while the unit is heading into open ground,
   * shrinks behind it as it drives back out, and loops are cut out as they
   * close so the way back is never longer than it needs to be.
   */
  _recordWayIn(road, out, leaving) {
    const v = this.vehicle;
    if (out < 3 || !road) { this._wayIn = null; this._wentIn = false; return; }
    let way = this._wayIn;
    if (!way) way = this._wayIn = [{ x: road.x, z: road.z }];
    const px = v.position.x, pz = v.position.z;
    if (leaving) {
      while (way.length > 1) {
        const last = way[way.length - 1];
        if (dist2(last.x, last.z, px, pz) > 5) break;
        way.pop();
      }
      return;
    }
    const last = way[way.length - 1];
    if (dist2(last.x, last.z, px, pz) < 3) return;
    for (let i = 0; i < way.length - 2; i++) {
      if (dist2(way[i].x, way[i].z, px, pz) < 4) { way.length = i + 1; return; }
    }
    // A very long way in is rare, and the gap-picking drive is fine for it.
    if (way.length < 240) way.push({ x: px, z: pz });
    else this._wayIn = null;
  }

  /**
   * Choose somewhere to look. Returns null only when nothing nearby will do.
   */
  _pickSearchSpot(centre) {
    const game = this.game, graph = game.graph, rng = game.rng, v = this.vehicle;
    const k = game.dispatcher.knowledge;
    // Near where you vanished at first, then further out as the minutes go by:
    // you have had time to drive somewhere.
    const reach = clamp(80 + (k.timeSinceSeen || 0) * 4, 90, 320);
    const hs = Math.hypot(k.velocity.x, k.velocity.z);
    const hx = hs > 4 ? k.velocity.x / hs : 0, hz = hs > 4 ? k.velocity.z / hs : 0;
    const wantOff = rng() < 0.75;

    for (const offWanted of [wantOff, !wantOff]) {
      const picks = [];
      for (let i = 0; i < 28; i++) {
        const a = rng() * Math.PI * 2;
        const r = Math.max(20, reach * Math.sqrt(rng()));
        const x = centre.x + Math.cos(a) * r, z = centre.z + Math.sin(a) * r;
        if (Math.abs(x) > WORLD_HALF - 50 || Math.abs(z) > WORLD_HALF - 50) continue;
        const e = graph.nearestEdge(x, z);
        if (!e) continue;
        const out = e.dist - e.edge.width * 0.5;
        const offRoad = out > 8 && (!game.sim || game.sim.surfaceAt(x, z) !== 1);
        if (offRoad !== offWanted) continue;
        if (offRoad && (out > 150 || this._spotBlocked(x, z))) continue;
        if ((this._failedSpots || []).some((f) => dist2(f.x, f.z, x, z) < 30)) continue;

        const px = offRoad ? x : e.x, pz = offRoad ? z : e.z;
        let score = 0;
        // The way you were going when they lost you.
        if (hs > 4) score += 45 * ((px - centre.x) * hx + (pz - centre.z) * hz) / (dist2(px, pz, centre.x, centre.z) || 1);
        // The further from a road, the less likely anyone has looked there.
        if (offRoad) score += Math.min(out, 70) * 0.5;
        // Somewhere another searcher is not already going.
        for (const u of game.dispatcher.units) {
          const o = u._searchSpot;
          if (u !== this && o && u.role === ROLE.SEARCH && dist2(o.x, o.z, px, pz) < 70) score -= 80;
        }
        // And not the far side of the search from this car.
        score -= dist2(px, pz, v.position.x, v.position.z) * 0.25;
        picks.push({ x: px, z: pz, offRoad, entry: { x: e.x, z: e.z }, edge: e.edge, score });
      }
      picks.sort((a, b) => b.score - a.score);
      // Off the road, only somewhere with a straight way in. The best few are
      // tried; each costs a handful of sweeps.
      let best = null;
      for (let i = 0; i < picks.length && i < 6 && !best; i++) {
        const p = picks[i];
        if (!p.offRoad) { best = p; break; }
        const lane = this._laneTo(p.x, p.z);
        if (lane) {
          const at = graph.nearestEdge(lane.x, lane.z);
          if (at) { p.entry = lane; p.edge = at.edge; best = p; }
        }
      }
      if (best) {
        // The way there: to the nearer end of that stretch of road, then along
        // it to the other, which runs past the spot.
        const na = graph.nodes[best.edge.a], nb = graph.nodes[best.edge.b];
        const aFirst = dist2(na.x, na.z, v.position.x, v.position.z) < dist2(nb.x, nb.z, v.position.x, v.position.z);
        best.near = aFirst ? na.id : nb.id;
        best.far = aFirst ? nb.id : na.id;
        best.along = false;
        return Object.assign(best, {
          forX: centre.x, forZ: centre.z, age: 0, progressAt: 0,
          best: this.distanceTo(best), direct: false,
        });
      }
    }
    return null;
  }

  /**
   * A straight, clear run from a road to an off-road spot, wide enough for
   * this car: the road end of the shortest one, or null if there is none.
   *
   * Without it a unit reached a spot however the gap-picking drive could
   * manage, and on Wexbury -- houses with back gardens behind them -- that was
   * scraping along the side of a house at 20 km/h on the way in, and again on
   * the way out. A spot with a lane to it is driven in along the lane and
   * out the same way. One without is left alone, and still gets looked at by
   * whoever checks the spots either side of it.
   */
  _laneTo(x, z) {
    const sim = this.game.sim;
    if (!sim || !sim.surfaceAt) return null;
    let best = null, bestLen = Infinity;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const dx = Math.sin(a), dz = Math.cos(a);
      // How far this way the road is, if it is within reach at all.
      let len = 0;
      for (let s = 6; s <= 120 && s < bestLen; s += 3) {
        if (sim.surfaceAt(x + dx * s, z + dz * s) === 1) { len = s; break; }
      }
      if (!len) continue;
      if (!this._runClear(x, z, x + dx * len, z + dz * len)) continue;
      best = { x: x + dx * (len + 2), z: z + dz * (len + 2) };
      bestLen = len;
    }
    return best;
  }

  /**
   * Is the straight run between two ground points clear for this car? Three
   * thin sweeps a car's width apart: the sweep box is not turned to face its
   * direction, so one wide box is only wide going one way.
   */
  _runClear(x0, z0, x1, z1) {
    const len = dist2(x0, z0, x1, z1);
    if (len < 1) return true;
    const dx = (x1 - x0) / len, dz = (z1 - z0) / len;
    const side = this.driver.halfWidth + 0.5;
    const sim = this.game.sim;
    const y = (sim && sim.heightAt ? sim.heightAt(x0, z0) || 0 : 0) + 0.7;
    _dirTmp.set(dx, 0, dz);
    for (const off of [-side, 0, side]) {
      _origin2.set(x0 - dz * off, y, z0 + dx * off);
      if (sweepBox(this.game.world, _origin2, _dirTmp, len, SPOT_SOLID, this.vehicle.body, 0.4) < len - 0.5) return false;
    }
    return true;
  }

  /** Is there a building or a tree where a car would have to stand? */
  _spotBlocked(x, z) {
    for (const [ox, oz] of SPOT_PROBES) {
      _eye.set(x + ox, 40, z + oz);
      if (raycast(this.game.world, _eye, DOWN, 39.5, SPOT_SOLID)) return true;
    }
    return false;
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
      // Close enough to drive at it directly -- no faster than the caller
      // asked for the rest of the way.
      return this.driver.driveTo(point, this._chaseSpeed() * Math.min(0.8, speedFactor), dt);
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
      // A unit checking a field is meant to be in the field, going slowly
      // through a gateway or round a hedge. Only one that has actually stopped
      // there needs pulling out.
      const hunting = this.role === ROLE.SEARCH
        && ((this._searchSpot && this._searchSpot.direct) || this._wentIn);
      if (hunting && (v.speed > 1.5 || this.offRoadFor < 4)) return null;
      if (!hunting && (v.speed > 7 || this.offRoadFor < 1.5)) return null;
    } else if (this.offRoadFor < 0.35) {
      // A wheel clipping a verge is not worth abandoning a patrol for.
      return null;
    }

    const g = this.game.graph;
    const snap = g.nearestEdge(v.position.x, v.position.z);
    if (!snap) return null;

    // A searching unit is often deep in somewhere when this fires -- it was
    // chasing across the back of an estate when contact went -- and the
    // straight line to the nearest road from there runs through a house.
    // It finds its way out the way it would find its way in, and slowly.
    if (this.role === ROLE.SEARCH) return this._driveDirect(dt, snap, SEARCH_OFF_ROAD * 0.7);

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

  /**
   * Head for a point with no route: steer for whatever gap actually leads
   * there, and keep re-asking as the geometry opens up.
   *
   * This is what reaches places the road network cannot -- a courtyard, an
   * alley, a patch of grass behind a terrace. The router is kept only as the
   * escape hatch for a car that is genuinely wedged, since a unit pinned in a
   * dead end will otherwise sit there steering hopefully at a wall.
   */
  _driveDirect(dt, point, speed) {
    const v = this.vehicle;
    const d = this.driver;

    if (this._roadFallback > 0) {
      this._roadFallback -= dt;
      return this._goTo(dt, point, 1.0);
    }

    // Boxed in: not merely blocked ahead, but no usable gap in any direction
    // *and* not moving. Either alone is normal -- threading a tight gap is
    // slow, and a blocked line is the case this whole method exists for.
    if (v.speed < 3.5 && d.gapClear !== undefined && d.gapClear < 9) {
      this._boxedIn = (this._boxedIn || 0) + dt;
      if (this._boxedIn > 1.6) { this._roadFallback = 5; this._boxedIn = 0; }
    } else {
      this._boxedIn = Math.max(0, (this._boxedIn || 0) - dt * 0.6);
    }

    // Two steps, not one. A greedy fan can only answer "which way is best
    // right now", and that is not enough to get through a doorway: threading a
    // three-metre entrance means first driving to a spot in front of it and
    // only then turning in. So when the direct line is blocked, look for a
    // staging point -- somewhere that *can* see the target and that this car
    // can get to -- and head for that instead. The gap fan then handles the
    // approach, and the last leg is a clear straight run.
    const goal = this._stagingPoint(dt, point) || point;

    const reach = clamp(16 + v.speed * 1.9, 20, 75);
    const aim = d.pickGap(goal.x, goal.z, reach);
    _aim.set(aim.x, 0, aim.z);
    d.setPath([]);
    return d.driveTo(_aim, speed, dt, { allowHandbrake: false });
  }

  /**
   * A place to aim for when the target itself cannot be seen from here: a
   * point near it with a clear line to it, ideally one this car can reach.
   * Re-solved a couple of times a second and held in between, so the unit
   * commits to an approach rather than dithering between two doorways.
   */
  _stagingPoint(dt, point) {
    this._stageTimer = (this._stageTimer || 0) - dt;
    if (this._stageTimer > 0 && this._stage) {
      // Drop it once we are there, or once the target has moved on.
      const moved = dist2(this._stage.forX, this._stage.forZ, point.x, point.z);
      if (moved < 25 && this.distanceTo(this._stage) > 6) return this._stage;
    }
    this._stageTimer = 0.5;
    this._stage = null;

    const v = this.vehicle;
    let best = null, bestScore = -Infinity;
    for (const radius of [16, 30]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const sx = point.x + Math.cos(a) * radius;
        const sz = point.z + Math.sin(a) * radius;

        // It has to be able to see the target, or it is not a way in.
        _eye.set(sx, point.y !== undefined ? point.y + 1.0 : 1.0, sz);
        _aim2.set(point.x, (point.y || 0) + 0.8, point.z);
        if (!hasLineOfSight(this.game.world, _eye, _aim2, 1.0)) continue;

        // Prefer somewhere close to us -- and heavily prefer somewhere we can
        // actually get to. A point that sees the target through a doorway is
        // useless if the wall is between us and it, and picking one of those
        // sends the car off in the wrong direction entirely.
        const toMe = dist2(sx, sz, v.position.x, v.position.z);
        _dirTmp.set(sx - v.position.x, 0, sz - v.position.z);
        const len = _dirTmp.length() || 1;
        _dirTmp.multiplyScalar(1 / len);
        _origin2.copy(v.position); _origin2.y += 0.6;
        const clear = sweepBox(this.game.world, _origin2, _dirTmp, len,
          RAY_SOLID, v.body, this.driver.halfWidth);
        const reachable = clear >= len - 1.5;

        const score = (reachable ? 400 : 0) - toMe;
        if (score > bestScore) { bestScore = score; best = { x: sx, z: sz }; }
      }
      if (best) break;
    }
    if (!best) return null;
    best.forX = point.x; best.forZ = point.z;
    this._stage = best;
    return best;
  }

  /**
   * How badly this unit wants to hit the car it is chasing, 0..1.
   *
   * Separate from `aggression`, which is nothing at one star and drives the
   * rubber band and the tactics. Ramming starts at one star -- a unit on your
   * bumper at one star still gives you a shove -- and rises to everything at
   * five: "they seem reluctant to ram me -- make them ram me more, and
   * increase the closing speed and aggression as the wanted level increases."
   */
  get ramAggression() {
    return clamp01(0.3 + 0.7 * (this.game.heat.tier - 1) / 4);
  }

  /**
   * Keep a gap to the police car in front.
   *
   * A pursuit converging on one car converges on one line, with every unit on
   * it closing on the car ahead as if it were the target: measured, twenty
   * police-on-police shunts a minute, where before there were a handful. So a
   * unit with another police car ahead of it on its line holds a following
   * distance -- seven metres plus about half a second -- and only the one at the
   * front closes for the hit. The target itself is not counted: that is the car
   * this is all for.
   */
  _gapCap(target) {
    const v = this.vehicle;
    let cap = Infinity;
    // Only a car between this one and the target is in the way. One level
    // with the target, or past it -- a unit running a PIT alongside -- is not
    // a reason to hang back.
    const targetAhead = target
      ? (target.position.x - v.position.x) * v.forward.x + (target.position.z - v.position.z) * v.forward.z
      : Infinity;
    for (const o of this.game.vehicles) {
      // A stopped car is something to steer round (Driver.avoid), not to queue
      // behind for the rest of the chase.
      if (o === v || o === target || o.disabled || o.speed < 3) continue;
      const dx = o.position.x - v.position.x, dz = o.position.z - v.position.z;
      const ahead = dx * v.forward.x + dz * v.forward.z;
      if (ahead < 0 || ahead > 45 || ahead > targetAhead - 3) continue;
      const side = Math.abs(dx * v.left.x + dz * v.left.z);
      if (side > (v.spec.dims.w + o.spec.dims.w) * 0.5 + 0.8) continue;
      const want = 7 + v.speed * 0.55;
      if (ahead >= want) continue;
      const theirs = o.linvel.x * v.forward.x + o.linvel.z * v.forward.z;
      cap = Math.min(cap, Math.max(0, theirs + (ahead - want) * 0.9));
    }
    return cap;
  }

  _pursue(dt, target) {
    if (!target) return this._patrol(dt);
    const v = this.vehicle;
    const d = this.distanceTo(target.position);
    const ram = this.ramAggression;

    const ramRange = lerp(10, 26, ram);

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
      // Corridor the width of *this* car, not a fixed 4.4 m. The old figure
      // demanded more than twice the room a police car actually needs, so any
      // gap between buildings narrower than that was declared blocked and the
      // unit went round by road -- refusing openings it would have driven
      // straight through.
      const hw = this.driver.halfWidth;
      let open = true;
      for (const off of [-hw, 0, hw]) {
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
      // Something solid in the way -- which is a reason to look for the way
      // through, not a reason to give up and drive round by road. Falling
      // straight back to the network was why a target sitting in a courtyard,
      // or up an alley between two buildings, was effectively unreachable:
      // there is no road to the place, so the router had nothing to offer and
      // units simply stopped short.
      //
      // The road network is still the answer when a unit is genuinely boxed
      // in, and `_driveDirect` keeps that as its own fallback.
      this._mode = 'noLos';
      return this._driveDirect(dt, target.position, this._chaseSpeed());
    }

    const r = relativeTo(target, v);
    // Lead the target by roughly the time it takes to cover the gap.
    const closing = Math.max(4, v.speed);
    const lead = clamp(d / closing, 0, 1.15);
    _aim.copy(target.position).addScaledVector(target.linvel, lead);

    // Hang slightly off to one side once close, so a following unit is already
    // positioned for a PIT rather than square behind the boot -- but only the
    // calmest ones. From about two stars a unit lines its nose straight up at
    // the car instead.
    if (d < 26 && ram < 0.5) {
      const side = Math.abs(r.lat) > 0.5 ? sign(r.lat) : (this.vehicle.id % 2 ? 1 : -1);
      const off = lerp(2.2, 0.4, clamp01(d / 26)) * lerp(1, 0.2, ram * 2);
      _aim.addScaledVector(target.left, side * off);
    }

    // Aim *through* them, not at them. A driver aiming at a car tends to arrive
    // alongside it; one aiming a couple of metres beyond its middle carries on
    // into it, which is the difference between being followed and being rammed.
    // The aim point used to be *behind* the car's middle -- at its boot -- which
    // is exactly the place a following car stops.
    if (d < ramRange + 8) {
      _aim.addScaledVector(target.forward, lerp(0.6, 2.6, ram) * clamp01(1 - d / (ramRange + 8)));
    }

    this.driver.setPath([]);
    const runUp = lerp(7.5, 17, ram);
    if (this._ramBackOff(dt, target, d, runUp)) {
      // Just hit them: drop back for a run-up before the next one. Braked
      // for firmly, and eased off near the gap it wants so it does not fall
      // twenty metres behind. Aimed at the car itself, not through it, so the
      // unit stays on its tail.
      this._mode = 'reset';
      const drop = clamp((runUp - d) * 1.5, 1.5, lerp(4, 10, ram));
      return this.driver.driveTo(target.position,
        Math.min(Math.max(0, target.forwardSpeed - drop), this._gapCap(target)), dt);
    }
    // Closing speed for the hit. It was mostly proportional to the gap -- 35%
    // of it -- so at ten metres a unit was closing at three or four metres a
    // second and every contact was a nudge. Now a floor that rises with the
    // wanted level: about 20 km/h faster than you at one star, 58 at five.
    this._mode = d < ramRange + 8 ? 'ram' : 'direct';
    const closeBy = Math.max(lerp(5.5, 16, ram), Math.min(d * 0.35, 16 + 11 * ram));
    const speed = Math.abs(target.forwardSpeed) + closeBy;
    return this.driver.driveTo(_aim, Math.min(speed, this._chaseSpeed() * lerp(1, 1.15, ram), this._gapCap(target)), dt);
  }

  /**
   * Hit, drop back, come again.
   *
   * Measured on its own -- one unit, a target doing 70 km/h -- a pursuer
   * arrived, hit once, and then sat on the bumper for the rest of the run at
   * exactly the target's speed with its foot flat down. That is a push, not a
   * ram: nothing registers as an impact and from the driver's seat it is
   * barely there. So contact, or half a second of leaning on the car, sends
   * the unit back for a run-up, and when it has one it comes again at full
   * closing speed.
   *
   * How hard a ram lands is mostly how much road the unit had to build up
   * speed on -- a car starting four metres back reaches the bumper at five or
   * six metres a second whatever it asks for. So the run-up is what scales
   * with the wanted level: a shove from seven and a half metres at one star,
   * a proper hit from seventeen at five.
   *
   * Only against a car that is moving. One that has stopped is being arrested,
   * and the job then is to stay against it (see _holdingArrest).
   */
  _ramBackOff(dt, target, d, runUp) {
    const v = this.vehicle;
    const dx = target.position.x - v.position.x, dz = target.position.z - v.position.z;
    const ahead = dx * v.forward.x + dz * v.forward.z;
    const side = Math.abs(dx * v.left.x + dz * v.left.z);
    const touching = ahead > 0
      && ahead < (v.spec.dims.l + target.spec.dims.l) * 0.5 + 0.8
      && side < (v.spec.dims.w + target.spec.dims.w) * 0.5 + 0.4;
    const hit = touching && v.lastImpactAt && v.lastImpactAt !== this._ramHitAt;
    this._ramHitAt = v.lastImpactAt;
    this._leanFor = touching ? (this._leanFor || 0) + dt : 0;

    if (target.speed > 5 && (hit || this._leanFor > 0.5)) {
      // A time limit as well as a distance, so a unit that cannot open the gap
      // -- the target braking as hard as it is -- does not sit out the chase.
      this._ramBack = 3;
      this._leanFor = 0;
    }
    if (!(this._ramBack > 0)) return false;
    this._ramBack -= dt;
    // Run-up made -- the knock itself often opens most of it -- or the target
    // has slowed right down, which is the moment to be on them.
    if (d >= runUp || target.speed < 5) this._ramBack = 0;
    return this._ramBack > 0;
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
      // The strike is the one piece of driving that is *meant* to end in a
      // collision, and the ordinary speed limiter will not allow it.
      //
      // It aims through the target's far rear corner -- a point three or four
      // metres away and forty degrees off the nose -- and the pure-pursuit
      // grip limit reads that as a four-metre-radius corner, so it clamped a
      // 29 m/s strike to about 9 and braked. Measured: the unit arriving at
      // the rear quarter on the money, then shedding half its speed and
      // dropping sixteen metres back, every single time. `commit` is only set
      // for the strike itself, which lasts under two seconds; the last-resort
      // clamp on anything solid straight ahead still applies, and the ray it
      // uses cannot see cars anyway.
      ignoreSurroundings: res.commit === true,
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
  /**
   * The head-on van.
   *
   * Put on the road a long way in front of the car and pointed back down it,
   * an armoured van has one job: drive at the car, hard, and let three and a
   * half tonnes settle the argument. It does not brake for the target, it does
   * not steer round it, and it does not care what the contact does to the van.
   *
   * It is deliberately a blunt instrument and a rare one -- four stars and up,
   * one at a time, only on a road the driver has committed to (see
   * Dispatcher._trackCourse). Everything about it is meant to be visible
   * coming: headlights, the wrong way up the road, and a radio call.
   *
   * The run ends when the car is past it, or when they touch. Then it is an
   * ordinary pursuit unit again -- a very heavy one, facing the wrong way.
   */
  _rhino(dt, target) {
    if (!target) return this._patrol(dt);
    const v = this.vehicle;
    const d = this.distanceTo(target.position);
    const r = relativeTo(target, v);

    // Contact, or they are past: either way the run is over. `r.long` is how
    // far ahead of us they are along our own nose, so it goes negative the
    // moment they are behind the van.
    const touched = v.lastImpactAt && v.lastImpactAt !== this._rhinoHitAt && d < 9;
    this._rhinoHitAt = v.lastImpactAt;
    this._rhinoFor = (this._rhinoFor || 0) + dt;
    if (touched || r.long < -4 || this._rhinoFor > 22) {
      this._rhinoFor = 0;
      this.game.dispatcher.onRhinoEnded(this, !!touched);
      this.setRole(ROLE.PURSUE);
      return this._pursue(dt, target);
    }

    // Down the road, not across the country. Driving the straight line at a
    // car 250 m away means leaving the carriageway the moment the road bends:
    // measured, the van ran onto a paved forecourt, found a wall, and stopped
    // dead 136 m short of the meeting. So while the car is still a long way
    // off it follows the road toward them -- on their side of it, which is
    // what makes it a head-on rather than a car coming the other way.
    if (d > 70) {
      const g = this.game.graph;
      // Aimed at a junction well beyond the car, not at the car's own: a path
      // that ends where the meeting happens is a path the driver slows down to
      // arrive at, and the van was coasting into the contact at 20 km/h.
      const sp = Math.max(1, target.speed);
      const goal = g.nearestNode(
        target.position.x + (target.linvel.x / sp) * 160,
        target.position.z + (target.linvel.z / sp) * 160,
      );
      if (this.repathTimer <= 0 || !this.driver.hasPath || this.goalNode !== goal.id) {
        this._routeTo(goal.id, -2.4);
        this.repathTimer = 1.0;
      }
      if (this.driver.hasPath) return this.driver.followPath(dt, this._chaseSpeed(), { lane: false });
    }

    // Close enough to aim: straight at where they will be by the time we get
    // there. Both cars are closing, so the lead is over the combined speed.
    const closing = Math.max(14, v.speed + Math.abs(target.forwardSpeed));
    _aim.copy(target.position).addScaledVector(target.linvel, clamp(d / closing, 0, 0.9));
    this.driver.setPath([]);
    return this.driver.driveTo(_aim, this._chaseSpeed(), dt, { lane: false });
  }

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
    const slot = this.orders.slot;
    boxAim(target, slot, t, _aim);
    // While the car is still a long way from its slot, aiming at the slot
    // itself is a point a few metres to one side of a car it is thirty metres
    // behind -- a hard turn away from the only direction that closes the gap.
    // Approach the target, take up the slot at the end.
    const r = relativeTo(target, this.vehicle);
    const gap = Math.hypot(r.lat - slot.x, r.long - slot.z);

    // A long way from the slot, this is not a manoeuvre yet -- it is a chase,
    // and the chase already knows how to get to a car: it checks whether the
    // line is actually open and takes to the roads when it is not. Driving
    // straight at a slot forty metres away is how boxing units ended up
    // crossing gardens to reach a point beside a car they could not see.
    if (gap > 18) return this._pursue(dt, target);

    if (gap > 9) {
      // Closer in, aim between the target and the slot: pure pursuit onto a
      // point a couple of metres off the side of a car twenty metres away is a
      // hard turn away from the direction that closes the gap.
      const blend = clamp01((gap - 9) / 9);
      _aim.lerp(target.position, blend * 0.6);
    }
    const speed = boxSpeed(target, slot, t, this.vehicle);
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
    // The rubber band tightens with the wanted level too. Giving a first-star
    // patrol the same catch-up help as a five-star pursuit is what let a single
    // car hang on to a flat-out runner it had no business staying with. At the
    // top of the range this is the full 0.75 it always was.
    a.boost = 1 + (0.25 + 0.50 * this.aggression) * far * engaged;
    a.grip = 1 + 0.35 * engaged;
    a.stability = engaged;
    // Still on the way: a crash costs this unit time, not its whole chase.
    a.shielded = true;
  }

  /** Top speed this unit is willing to run at, given its car and its nerve. */
  _chaseSpeed() {
    return this.vehicle.spec.topSpeedHint
      * clamp(lerp(0.86, 1.06, this.skill.aggression - 0.6), 0.8, 1.06)
      * this.pace
      * this.vehicle.assist.boost;
  }

  /**
   * How hard this unit is allowed to press, as a fraction of what its car can
   * do. A single patrol car answering a first-star call should be shakeable by
   * simply driving quickly; at five stars they are flat out and the number is
   * 1, so the top of the range is exactly what it always was.
   */
  get pace() {
    // Floor raised from 0.74: even at one star the police were too easy to
    // leave behind by simply driving quickly.
    return lerp(0.84, 1.0, this.aggression);
  }
}
