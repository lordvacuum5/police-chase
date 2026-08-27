// Pursuit command and control.
//
// This is what separates a police chase from a queue of cars behind you. The
// dispatcher holds the only shared model of where the target is, decides what
// each unit is for, and hands out permission to attempt the risky manoeuvres.
//
// The important idea is the *intercept*: rather than every unit driving at the
// target's current position, the dispatcher expands the road graph forward from
// the target to find every junction they could plausibly reach in the next
// twenty seconds, then asks each free unit whether it can be at one of those
// junctions first. A unit that can gets sent there and told to ignore the
// target completely until it arrives. That is why the police appear in front
// of you rather than behind you.

import * as THREE from 'three';
import { Officer, ROLE } from './officer.js';
import { pitViable, assignBoxSlots, boxClosed, relativeTo } from './tactics.js';
import { hasLineOfSight } from '../physics/world.js';
import { clamp, clamp01, lerp, dist2, damp } from '../util/math.js';

const _eye = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** How long the police keep hunting after losing contact, in seconds. */
export const SEARCH_SECONDS = 60;

/**
 * How long the force keeps a hard fix on you after losing sight. Inside this
 * window they still know exactly where you are; outside it, they only know
 * where you were, and it becomes a search. Regaining sight resets it.
 */
export const TRACK_SECONDS = 3;

/**
 * How long they keep driving at your last known position before admitting they
 * have lost you and starting to search properly. Much shorter than the search
 * itself -- otherwise every unit converges on a spot you left half a minute ago
 * and mills about there.
 */
const LOST_CONTACT_SECONDS = 5;

/** How many units of each role a given heat tier is allowed to run. */
const TIER = [
  // Tier 0 still fields ambient patrols -- somebody has to notice you.
  { units: 3, pursue: 0, intercept: 0, pit: false, box: false },
  { units: 2, pursue: 2, intercept: 0, pit: false, box: false },
  { units: 3, pursue: 2, intercept: 1, pit: false, box: false },
  { units: 5, pursue: 2, intercept: 2, pit: true,  box: false },
  { units: 7, pursue: 3, intercept: 3, pit: true,  box: true },
  { units: 9, pursue: 3, intercept: 4, pit: true,  box: true },
];

export class Dispatcher {
  constructor(game) {
    this.game = game;
    this.units = [];

    this.knowledge = {
      seen: false,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      confidence: 0,
      timeSinceSeen: 999,
      spotter: null,
    };

    this.roleTimer = 0;
    this.interceptTimer = 0;
    this.spawnTimer = 0;
    this.pitCooldown = 0;
    this.blockCooldown = 0;
    this.blockUnit = null;
    this.activePit = null;
    this.boxAssignment = null;
    this.boxTightness = 0;
    this.claimedNodes = new Set();
    this.lastReport = '';
  }

  get tier() { return this.game.heat.tier; }
  get rules() { return TIER[clamp(this.tier, 0, 5)]; }

  // =================================================================== update

  update(dt, target) {
    this.pitCooldown -= dt;
    this.blockCooldown -= dt;
    this._updateKnowledge(dt, target);
    this._manageRoster(dt, target);

    this.roleTimer -= dt;
    this.interceptTimer -= dt;
    if (this.roleTimer <= 0) {
      this.roleTimer = 0.25;
      this._assignRoles(target);
    }
    this._updateBox(dt, target);

    for (const u of this.units) u.update(dt, target);
  }

  // ------------------------------------------------------------- perception

  _updateKnowledge(dt, target) {
    const k = this.knowledge;

    // Holding a car you are already following is easy; picking a specific car
    // out of a city you have lost it in is not. The reacquire range is much
    // shorter than the tracking range, and shorter again if the target has
    // slowed right down and is keeping its head down.
    const hasContact = k.timeSinceSeen < 1.5;
    // Searching units get 20% more range than a plain reacquire, and look all
    // the way round rather than through a forward cone -- a crew hunting for a
    // car is scanning every direction, not staring out of the windscreen.
    let sightRange = hasContact ? 120 + this.tier * 22 : (55 + this.tier * 10) * 1.2;
    if (!hasContact && target.speed < 5) sightRange *= 0.6;

    let spotter = null;
    let best = Infinity;

    for (const u of this.units) {
      if (u.disabled) continue;
      const d = u.distanceTo(target.position);
      if (d > sightRange || d > best) continue;

      // Generous field of view while in contact -- mirrors and a partner in
      // the passenger seat mean a police car is not blind to its flanks. While
      // searching there is no cone at all; they are looking everywhere.
      if (hasContact) {
        _dir.copy(target.position).sub(u.vehicle.position).normalize();
        if (_dir.dot(u.vehicle.forward) < -0.55) continue;
      }

      _eye.copy(u.vehicle.position); _eye.y += 1.1;
      _tgt.copy(target.position); _tgt.y += 0.8;
      if (!hasLineOfSight(this.game.world, _eye, _tgt, 1.5)) continue;

      spotter = u;
      best = d;
    }

    if (spotter) {
      k.seen = true;
      k.spotter = spotter;
      k.position.copy(target.position);
      k.velocity.copy(target.linvel);
      k.timeSinceSeen = 0;
      k.confidence = 1;
    } else {
      k.seen = false;
      k.timeSinceSeen += dt;
      // Breaking line of sight does not lose you instantly. For TRACK_SECONDS
      // they still know exactly where you are -- radio, other units, a good
      // guess at where that road goes -- and only then does it become a
      // search. Ducking behind one building is not an escape; staying out of
      // sight is.
      if (k.timeSinceSeen < TRACK_SECONDS) k.position.copy(target.position);
      k.confidence = clamp01(1 - k.timeSinceSeen / SEARCH_SECONDS);
    }
  }

  // ------------------------------------------------------------- unit roster

  _manageRoster(dt, target) {
    this.spawnTimer -= dt;
    const want = this.rules.units;
    // Cars manning a roadblock do not count against the pursuit's budget, and
    // are not the roster's to retire. They are standing in a road on purpose;
    // counting them as active pursuers would quietly starve the chase of the
    // cars that are actually chasing.
    const alive = this.units.filter((u) => !u.vehicle.disabled && u.role !== ROLE.HOLD);

    if (alive.length < want && this.spawnTimer <= 0) {
      this.spawnTimer = 1.6;
      const u = this.game.spawnPoliceNear(target.position, this.tier);
      if (u) {
        this.units.push(u);
        this.game.radio(`${u.callsign} responding, ${this._bearingWord(u.position, target.position)}bound`);
      }
    }

    // Retire units that are hopelessly out of it, so the roster stays useful.
    // A wreck blocking a side street is fine for a while -- it is a hazard the
    // chase has to deal with -- but a permanently dead unit that the roster
    // still counts as active would quietly starve the pursuit of cars.
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.role === ROLE.HOLD) continue;   // the roadblock owns its own cars
      const d = u.distanceTo(target.position);
      const far = d > 900;

      if (u.vehicle.speed < 1.0 && !(u.role === ROLE.INTERCEPT && u.driver.remaining() < 30)) {
        u.strandedFor = (u.strandedFor || 0) + dt;
      } else {
        u.strandedFor = 0;
      }

      // Damaged units are pulled off the board once they are far enough away
      // that you will not see them vanish.
      const wrecked = u.vehicle.damage >= 0.55 && d > 200;
      const stranded = u.strandedFor > 14 && d > 200;

      if (far || wrecked || stranded) {
        this.game.despawnPolice(u);
        this.units.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------ role assignment

  _assignRoles(target) {
    const k = this.knowledge;
    const rules = this.rules;

    if (this.tier === 0 || k.timeSinceSeen > LOST_CONTACT_SECONDS) {
      for (const u of this.units) {
        if (u.role === ROLE.HOLD) continue;
        if (u.role !== ROLE.PATROL && this.tier === 0) u.setRole(ROLE.PATROL);
        else if (this.tier > 0 && u.role !== ROLE.SEARCH) u.setRole(ROLE.SEARCH, { point: k.position.clone() });
      }
      this.activePit = null;
      this.boxAssignment = null;
      // No contact means nothing to get in front of.
      this.blockUnit = null;
      return;
    }

    // Cars manning a roadblock are not available for anything: they are where
    // they are meant to be, and they decide for themselves when to leave.
    const available = this.units.filter((u) => !u.vehicle.disabled && u.role !== ROLE.HOLD);
    available.sort((a, b) => a.distanceTo(k.position) - b.distanceTo(k.position));

    const assigned = new Set();

    // ---- 1. the box, if one is running, keeps its units ----
    if (this.boxAssignment) {
      for (const [unit] of this.boxAssignment) {
        if (available.includes(unit)) assigned.add(unit);
      }
    }

    // ---- 2. an authorised PIT keeps its unit ----
    if (this.activePit && available.includes(this.activePit) && !this.activePit.vehicle.disabled) {
      assigned.add(this.activePit);
    } else if (this.activePit) {
      this.activePit = null;
    }

    // An existing blocker is spoken for. This has to happen before pursuit is
    // handed out: a car sitting on the road in front of the target is one of
    // the closest units there is, so the pursuit loop would otherwise draft it
    // straight back into the pack on the very next role tick.
    if (this.blockUnit) {
      if (this.blockUnit.vehicle.disabled || !available.includes(this.blockUnit)) {
        this.blockUnit = null;
      } else {
        assigned.add(this.blockUnit);
      }
    }

    // ---- 3. direct pursuit ----
    const pursuers = [];
    for (const u of available) {
      if (assigned.has(u)) continue;
      if (pursuers.length >= rules.pursue) break;
      const d = u.distanceTo(k.position);
      if (d > 420) continue;
      pursuers.push(u);
      assigned.add(u);
      if (u.role !== ROLE.PURSUE) {
        u.setRole(ROLE.PURSUE);
        if (d < 120) this.game.radio(`${u.callsign} has visual, in pursuit ${this.game.roadName(k.position)}`);
      }
    }

    // ---- 4. PIT authorisation ----
    // One tactic at a time across the whole pursuit. A PIT run through a
    // forming box wrecks both: the boxing units are holding station relative
    // to the target and the PIT car arrives across their line.
    if (rules.pit && !this.activePit && !this.boxAssignment && this.pitCooldown <= 0 && k.seen) {
      for (const u of pursuers) {
        if (pitViable(u.vehicle, target)) {
          this.activePit = u;
          u.setRole(ROLE.PIT);
          this.game.radio(`${u.callsign} — PIT authorised`, true);
          break;
        }
      }
    }

    // ---- 5. box-in ----
    if (rules.box && !this.boxAssignment && k.seen) {
      const close = available.filter((u) => !u.vehicle.disabled && u.distanceTo(target.position) < 42);
      const slow = Math.abs(target.forwardSpeed) < 24;
      if (close.length >= 3 && slow && !this.activePit) {
        this.boxAssignment = assignBoxSlots(target, close.slice(0, 4));
        this.boxTightness = 0;
        for (const [unit, slot] of this.boxAssignment) {
          unit.setRole(ROLE.BOX, { slot, tightness: 0 });
          assigned.add(unit);
        }
        this.game.radio('All units — box formation, close it up', true);
      }
    }

    // ---- 5b. rolling block ----
    // A unit put on the road in front of the target, going the same way but
    // slower. Distinct from an intercept, which races to a junction and waits.
    if (this.tier >= 2 && k.seen && !this.blockUnit && this.blockCooldown <= 0
        && Math.abs(target.forwardSpeed) > 12) {
      this.blockCooldown = 14;
      const u = this.game.spawnPoliceAhead(target, this.tier);
      if (u) {
        this.units.push(u);
        // Also into `available`, which was snapshotted before this unit
        // existed -- otherwise the validation immediately below decides it is
        // not a real unit and drops the block on the frame it was created.
        available.push(u);
        u.setRole(ROLE.BLOCK);
        this.blockUnit = u;
        assigned.add(u);
        this.game.radio(`${u.callsign} ahead of them — slow them down`, true);
      }
    }
    // ---- 6. intercepts ----
    const free = available.filter((u) => !assigned.has(u));
    if (this.interceptTimer <= 0) {
      this.interceptTimer = 1.0;
      this._assignIntercepts(free, target, rules.intercept);
    } else {
      // Between reassignments, anyone without a job keeps driving at the last
      // known position rather than idling.
      for (const u of free) {
        if (u.role !== ROLE.INTERCEPT && u.role !== ROLE.RESPOND) {
          u.setRole(ROLE.RESPOND, { point: k.position.clone() });
        }
      }
    }
  }

  /**
   * The intercept solver.
   *
   * Expand the graph forward from the target to get { junction -> earliest the
   * target could arrive }. For each free unit, route to the most promising of
   * those junctions and compare travel times. A junction is only worth taking
   * if the unit beats the target there by a sensible margin -- too small and
   * they arrive mid-corner with no time to set up, too large and the target
   * will simply have turned off before they matter.
   */
  _assignIntercepts(free, target, limit) {
    const k = this.knowledge;
    const g = this.game.graph;
    this.claimedNodes.clear();

    if (!free.length || limit <= 0) {
      for (const u of free) u.setRole(ROLE.RESPOND, { point: k.position.clone() });
      return;
    }

    // Direction of travel: velocity if they are moving, nose if not.
    _dir.copy(k.velocity);
    _dir.y = 0;
    if (_dir.lengthSq() < 4) _dir.copy(target.forward);
    _dir.normalize();

    const reach = g.reachable(k.position.x, k.position.z, _dir.x, _dir.z, 26, 0.88);

    // Keep the most useful candidates: far enough ahead to be worth driving to,
    // near enough that the prediction is still meaningful. Chokepoints first.
    const candidates = [];
    for (const [id, rec] of reach) {
      if (rec.eta < 4.5 || rec.eta > 24) continue;
      const node = g.nodes[id];
      const score = rec.eta + (node.chokepoint ? -4 : 0) + (node.edges.length >= 4 ? -1.2 : 0);
      candidates.push({ id, eta: rec.eta, score, x: node.x, z: node.z });
    }
    candidates.sort((a, b) => a.score - b.score);
    const shortlist = candidates.slice(0, 12);

    if (!shortlist.length) {
      for (const u of free) u.setRole(ROLE.RESPOND, { point: k.position.clone() });
      return;
    }

    let placed = 0;
    for (const u of free) {
      if (placed >= limit) {
        u.setRole(ROLE.RESPOND, { point: k.position.clone() });
        continue;
      }

      const from = g.nodeAhead(
        u.position.x, u.position.z, u.vehicle.forward.x, u.vehicle.forward.z,
      );
      const cruise = u.vehicle.spec.topSpeedHint * 0.55;

      // Pre-filter by straight-line distance so we only pay for a handful of
      // A* runs per unit per second.
      const near = shortlist
        .filter((c) => !this.claimedNodes.has(c.id))
        .map((c) => Object.assign({ raw: dist2(u.position.x, u.position.z, c.x, c.z) }, c))
        .sort((a, b) => a.raw - b.raw)
        .slice(0, 4);

      let best = null;
      for (const c of near) {
        const path = g.route(from.id, c.id, cruise);
        if (!path) continue;
        const t = g.routeTime(path, 0.82);
        const margin = c.eta - t;
        if (margin < 1.2 || margin > 15) continue;
        // Prefer arriving with a small but real cushion.
        const quality = Math.abs(margin - 4.0);
        if (!best || quality < best.quality) best = { c, path, quality, margin };
      }

      if (best) {
        this.claimedNodes.add(best.c.id);
        const changed = u.role !== ROLE.INTERCEPT || u.orders.node !== best.c.id;
        u.setRole(ROLE.INTERCEPT, { node: best.c.id });
        // Start the path at the car, not at the junction behind it.
        u._routeTo(best.c.id, 2.4);
        placed++;
        if (changed) {
          this.game.radio(
            `${u.callsign} — cut them off at ${this.game.nodeName(best.c.id)}, ${best.margin.toFixed(0)}s`,
          );
        }
      } else {
        u.setRole(ROLE.RESPOND, { point: k.position.clone() });
      }
    }
  }

  // --------------------------------------------------------------- box logic

  _updateBox(dt, target) {
    if (!this.boxAssignment) return;

    // Drop the box if it has fallen apart or the target has got away.
    let live = 0;
    for (const [unit] of this.boxAssignment) {
      if (!unit.vehicle.disabled && unit.distanceTo(target.position) < 55) live++;
    }
    if (live < 3 || Math.abs(target.forwardSpeed) > 33) {
      for (const [unit] of this.boxAssignment) {
        if (unit.role === ROLE.BOX) unit.setRole(ROLE.PURSUE);
      }
      this.boxAssignment = null;
      this.game.radio('Box broken — resume pursuit');
      return;
    }

    this.boxTightness = clamp01(this.boxTightness + dt * 0.32);
    for (const [unit, slot] of this.boxAssignment) {
      unit.orders.tightness = this.boxTightness;
      unit.orders.slot = slot;
    }

    if (boxClosed(target, this.boxAssignment)) {
      this.game.onBoxClosed();
    }
  }

  // ------------------------------------------------------------------ events

  /**
   * Take on a unit somebody else created -- currently the roadblock manager.
   * It goes on the board and on the minimap immediately, but keeps whatever
   * role its owner gave it until it gives that role up itself.
   */
  adopt(unit) {
    if (!this.units.includes(unit)) this.units.push(unit);
  }

  /** Remove a unit from the board and from the world. */
  retire(unit) {
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
    if (this.blockUnit === unit) this.blockUnit = null;
    if (this.activePit === unit) this.activePit = null;
    this.game.despawnPolice(unit);
  }

  /** A blocker that has been passed, or has lost the target, goes back in the pack. */
  onBlockEnded(unit) {
    if (this.blockUnit === unit) this.blockUnit = null;
    this.blockCooldown = Math.max(this.blockCooldown, 8);
  }

  onPitFinished(unit, result) {
    if (this.activePit === unit) this.activePit = null;
    this.pitCooldown = result.reason === 'spun' ? 5.0 : 3.0;
    if (result.reason === 'spun') this.game.radio(`${unit.callsign} — contact, target spun`, true);
  }

  /** Called by the game when the player rams a unit. */
  onRammed(unit) {
    this.pitCooldown = Math.min(this.pitCooldown, 1.0);
  }

  reset() {
    for (const u of this.units) this.game.despawnPolice(u);
    this.units.length = 0;
    this.activePit = null;
    this.boxAssignment = null;
    this.knowledge.confidence = 0;
    this.knowledge.timeSinceSeen = 999;
  }

  _bearingWord(from, to) {
    const dx = to.x - from.x, dz = to.z - from.z;
    if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
    return dz > 0 ? 'north' : 'south';
  }

  /** Compact status for the HUD. */
  statusLine() {
    const k = this.knowledge;
    if (this.tier === 0) return { text: 'NO ACTIVE PURSUIT', cls: 'clear' };
    if (k.seen) {
      const n = this.units.filter((u) => !u.vehicle.disabled).length;
      return { text: `PURSUED — ${n} UNIT${n === 1 ? '' : 'S'} ENGAGED`, cls: 'spotted' };
    }
    if (k.timeSinceSeen < SEARCH_SECONDS) {
      return {
        text: `SEARCHING — ${(SEARCH_SECONDS - k.timeSinceSeen).toFixed(1)}s`,
        cls: 'searching',
      };
    }
    return { text: 'COOLING DOWN', cls: 'clear' };
  }
}
