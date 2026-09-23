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

/**
 * How many cars the pursuit may have on the board at once, however they got
 * there.
 *
 * The tier budget below says how many are *sent*; a chase collects cars beyond
 * it, because every roadblock the player beats releases its crews into the
 * pursuit. Trimming those straight back down to the tier budget left the chase
 * looking thin -- "there's almost too few units now" -- so the pack is allowed
 * to build up to this, and only past it does the car furthest away drop off.
 * Eighteen is what the board used to hold, and it read well.
 */
export const PACK_CAP = 18;

/** How many units of each role a given heat tier is allowed to run. */
const TIER = [
  // Tier 0 still fields ambient patrols -- somebody has to notice you.
  { units: 3, pursue: 0, intercept: 0, pit: false, box: false },
  { units: 2, pursue: 2, intercept: 0, pit: false, box: false },
  { units: 4, pursue: 2, intercept: 1, pit: false, box: false },
  { units: 7, pursue: 3, intercept: 3, pit: true,  box: false },
  { units: 11, pursue: 4, intercept: 4, pit: true, box: true },
  { units: 15, pursue: 5, intercept: 6, pit: true, box: true },
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

    this.clock = 0;            // seconds of game time, for rate-limiting radio calls
    this.roleTimer = 0;
    this.interceptTimer = 0;
    this.spawnTimer = 0;
    this.trimTimer = 0;
    this.pitCooldown = 0;
    this.blockCooldown = 0;
    this.blockUnit = null;
    this.rhinoCooldown = 25;
    this.rhinoUnit = null;
    // How long the car has been going the same way, for the head-on van: it
    // only works on a road the driver is committed to.
    this.straightFor = 0;
    this._courseX = 0;
    this._courseZ = 0;
    this.activePit = null;
    this.boxAssignment = null;
    this.boxTightness = 0;
    this.boxTimer = 0;
    this.boxCooldown = 0;
    this.claimedNodes = new Set();
    this.lastReport = '';

    // How often this driver goes straight on at a junction, learned from what
    // the police have watched them do (see _learnHabits). Starts at a typical
    // fleeing driver's and feeds RoadGraph.predict.
    this.straightShare = 0.65;
    // Junctions less likely than this are not worth sending a car to. Measured
    // with tests/intercept.js: 0.08 made the intercepts right a third of the
    // time but sent so few that no more of them came off; 0.03 is right a
    // fifth of the time -- twice the old solver -- and sends enough to meet the
    // car at more junctions.
    this.interceptMinProb = 0.03;
    this._junction = null;
  }

  get tier() { return this.game.heat.tier; }
  get rules() { return TIER[clamp(this.tier, 0, 5)]; }

  // =================================================================== update

  update(dt, target) {
    this.clock += dt;
    this.pitCooldown -= dt;
    this.blockCooldown -= dt;
    this.rhinoCooldown -= dt;
    this._trackCourse(dt, target);
    this._updateKnowledge(dt, target);
    this._learnHabits(target);
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
    //
    // The line between the two is the tracking window itself, and nothing
    // else: while the bar on the screen is still draining they have a hard fix
    // on the car and everything behaves that way. It used to break at 1.5 s
    // with the bar running for 3, so the force quietly downgraded itself to a
    // search halfway through -- "it shows that they're searching, but they
    // still need to be in full pursuit of me... not searching until that timer
    // runs out."
    const hasContact = k.timeSinceSeen < TRACK_SECONDS;
    // Searching units get 20% more range than a plain reacquire, and look all
    // the way round rather than through a forward cone -- a crew hunting for a
    // car is scanning every direction, not staring out of the windscreen.
    // Steeper with the wanted level than it used to be. The old 120 + 22/tier
    // gave a single first-star patrol car 142 m of vision, which is most of a
    // city block in every direction and far too much for one car that has just
    // been told to look out for you. Same 230 m at five stars, so the top of
    // the range is unchanged.
    let sightRange = hasContact ? 70 + this.tier * 32 : (55 + this.tier * 10) * 1.2;
    if (!hasContact && target.speed < 5) sightRange *= 0.6;

    // Published for the HUD, which draws it as the detection ring. Taken from
    // the same variable the perception test uses rather than recomputed, so the
    // circle can never drift away from the rule it is drawing.
    this.sightRange = sightRange;
    this.inContact = hasContact;

    let spotter = null;
    let best = Infinity;

    for (const u of this.units) {
      if (u.disabled) continue;
      const d = u.distanceTo(target.position);
      if (d > sightRange || d > best) continue;

      // No field-of-view cone at all. There used to be one that blanked
      // anything more than about 124 degrees off the nose, which meant a car
      // sitting directly behind a police unit was completely invisible to it --
      // and dropping in behind them is the most natural thing in the world to
      // do in a chase. A crew has mirrors, a passenger, and a radio; the thing
      // that actually stops them seeing you is a building, and that is the line
      // of sight test below.

      _eye.copy(u.vehicle.position); _eye.y += 1.1;
      _tgt.copy(target.position); _tgt.y += 0.8;
      if (!hasLineOfSight(this.game.world, _eye, _tgt, 1.5)) continue;

      spotter = u;
      best = d;
    }

    // Air support sees over the rooftops. It is a spotter like any other, but
    // exempt from the line-of-sight test above -- looking down is the whole
    // reason it is up there. Ducking behind a building stops working while it
    // is overhead; outrunning it still does, because it has a range like
    // everything else.
    const heli = this.game.helicopter;
    if (!spotter && heli && heli.canSee(target)) spotter = heli;

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

  /**
   * Learn how this driver takes junctions.
   *
   * Only from what the police can see: the heading going into a junction
   * against the heading coming out, straight on or not, folded into a running
   * share that weighs the last five or so junctions most. Somebody who throws
   * the car down every side road gets intercepts spread across the side
   * roads; somebody who stays on the main road finds cars waiting on it.
   */
  _learnHabits(target) {
    const k = this.knowledge;
    const sp = target.speed;
    if (!k.seen || sp < 5) return;
    const g = this.game.graph;
    const x = target.position.x, z = target.position.z;
    const vx = target.linvel.x / sp, vz = target.linvel.z / sp;
    const j = this._junction;
    if (j) {
      if (Math.hypot(j.x - x, j.z - z) > 20) {
        const straight = j.hx * vx + j.hz * vz > 0.82 ? 1 : 0;
        this.straightShare = this.straightShare * 0.8 + straight * 0.2;
        this._junction = null;
      }
      return;
    }
    const snap = g.nearestEdge(x, z, 30);
    if (!snap) return;
    for (const id of [snap.edge.a, snap.edge.b]) {
      const n = g.nodes[id];
      if (n.edges.length >= 3 && Math.hypot(n.x - x, n.z - z) < 12) {
        this._junction = { x: n.x, z: n.z, hx: vx, hz: vz };
        return;
      }
    }
  }

  // ------------------------------------------------------------- unit roster

  _manageRoster(dt, target) {
    this.spawnTimer -= dt;
    this.trimTimer -= dt;
    const want = this.rules.units;
    // Cars manning a roadblock do not count against the pursuit's budget, and
    // are not the roster's to retire. They are standing in a road on purpose;
    // counting them as active pursuers would quietly starve the chase of the
    // cars that are actually chasing.
    // Human-driven police cars in a multiplayer game are units for counting,
    // sirens and the arrest, but they take no orders: see RemoteUnit in main.js.
    const alive = this.units.filter((u) => !u.human && !u.vehicle.disabled && u.role !== ROLE.HOLD);

    if (alive.length < want && this.spawnTimer <= 0) {
      this.spawnTimer = 1.6;
      const u = this.game.spawnPoliceNear(target.position, this.tier);
      if (u) {
        this.units.push(u);
        // A car joining the ambient patrol is not responding to anything --
        // there is nothing to respond to -- so it just comes on duty. Only once
        // there is a chase does a new car say it is on its way.
        const vars = { cs: u.callsign, dir: this._bearingWord(u.position, target.position) };
        if (this.tier === 0) {
          this.game.say('onduty', [
            (v) => `${v.cs}, show me on duty.`,
            (v) => `${v.cs}, on patrol.`,
            (v) => `${v.cs}, starting patrol.`,
            (v) => `${v.cs}, on duty, available.`,
            (v) => `${v.cs}, back on patrol.`,
          ], vars, false, { low: true, every: 40 });
        } else {
          this.game.say('responding', [
            (v) => `${v.cs}, responding.`,
            (v) => `${v.cs}, on my way.`,
            (v) => `${v.cs}, show me attending.`,
            (v) => `${v.cs}, en route.`,
            (v) => `${v.cs}, making my way, ${v.dir}bound.`,
          ], vars, false, { low: true, every: 20 });
        }
      }
    }

    // Retire units that are hopelessly out of it, so the roster stays useful.
    // A wreck blocking a side street is fine for a while -- it is a hazard the
    // chase has to deal with -- but a permanently dead unit that the roster
    // still counts as active would quietly starve the pursuit of cars.
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.human) continue;                // somebody else is driving it
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

      // Through retire(), not by splicing the array here: a unit can also be
      // the one the dispatcher is holding as its blocker or its authorised
      // PIT, and dropping it from the roster without clearing those leaves the
      // dispatcher steering a car that no longer exists.
      if (far || wrecked || stranded) this.retire(u);
    }

    // Over budget, which is what a chase *ending* looks like: nine cars on the
    // board and an ambient patrol of three. Nothing used to bring that number
    // back down except the 900 m rule, so the town stayed full of police long
    // after they had stopped looking for you.
    //
    // They are not deleted where you can see them. One at a time, furthest
    // first, and only once it is far enough away or out of sight -- so the
    // force thins out over the next half minute instead of blinking out.
    // The further over budget, the harder this bites. A chase that has been
    // going a while collects cars: every roadblock the player beats releases
    // its crews into the pursuit, and they are not counted when deciding
    // whether to spawn more. Left gentle, the board reached the game's hard
    // limit of eighteen vehicles, and then nothing else could be built --
    // including the next roadblock, which simply did not appear: "I couldn't
    // see half the roadblocks because there were too many police cars."
    //
    // They are still never deleted in front of the player: furthest first, and
    // only once far enough away or out of sight. What changes with the excess
    // is how often, and how close is close enough to count as gone.
    const live = this.units.filter((u) => !u.human && !u.vehicle.disabled && u.role !== ROLE.HOLD);
    // Two different ceilings. While a chase is on, the pack may keep whatever
    // it has collected up to PACK_CAP and only sheds cars past that. Once the
    // heat is off, the tier budget is the ceiling again and the force thins
    // back to an ambient patrol -- otherwise eighteen cars would follow you
    // around the town for the rest of the session.
    // Never more than the board can hold, either: on a machine that has cut
    // the vehicle limit to hold its frame rate, the pack comes down with it.
    // Room for the cars the chase has collected on top of the ones it was
    // sent -- a beaten roadblock's crews, mostly -- but still tied to the
    // wanted level, so dropping from five stars to three thins the pursuit
    // instead of keeping eighteen cars on a two-car call. Five stars reaches
    // PACK_CAP; nothing below it does.
    const room = Math.max(want, this.game.vehicleLimit - 6);
    const ceiling = this.tier > 0 ? Math.min(want + 3, PACK_CAP, room) : want;
    const over = live.length - ceiling;
    if (over > 0 && this.trimTimer <= 0) {
      let pick = null, pickD = 0;
      for (const u of live) {
        const d = u.distanceTo(target.position);
        if (d <= pickD) continue;
        pick = u; pickD = d;
      }
      // One spare car is a straggler; five is a crowd nobody can see anyway.
      const nearLimit = this.game.vehicles.length >= this.game.vehicleLimit - 4;
      const gap = over >= 3 || nearLimit ? 160 : 260;
      const hidden = over >= 3 || nearLimit ? 70 : 110;
      if (pick && (pickD > gap || (pickD > hidden && !this._visibleTo(pick, target)))) {
        this.trimTimer = clamp(2.2 / over, 0.5, 2.2);
        this.retire(pick);
      }
    }

    // At four stars and up the fleet is interceptors and SUVs, but the patrol
    // cars that were already out when the heat went up would otherwise stay
    // for the rest of the chase. So they are stood down one at a time --
    // furthest first, never where you can see it happen, never mid-manoeuvre
    // -- and the spawner above fills each gap with a car from the higher tiers.
    if (this.tier >= 4 && this.trimTimer <= 0) {
      let pick = null, pickD = 0;
      for (const u of live) {
        if (u.vehicle.specKey !== 'patrol') continue;
        if (u.role === ROLE.BOX || u.role === ROLE.PIT || u.role === ROLE.BLOCK) continue;
        const d = u.distanceTo(target.position);
        if (d > pickD) { pick = u; pickD = d; }
      }
      if (pick && (pickD > 160 || (pickD > 70 && !this._visibleTo(pick, target)))) {
        this.trimTimer = 3;
        this.retire(pick);
      }
    }
  }

  /**
   * How long the car has been going the same way.
   *
   * Not "on a straight road" -- a long curve is fine, and a road that bends
   * gently is still a road the driver is committed to. What disqualifies a
   * stretch is the driver actually changing direction: a turn at a junction, a
   * U-turn, a swerve into a side street. Anything over about thirty degrees
   * from the heading a moment ago starts the count again.
   */
  _trackCourse(dt, target) {
    const sp = target.speed;
    if (sp < 8) { this.straightFor = 0; return; }
    const hx = target.linvel.x / sp, hz = target.linvel.z / sp;
    if (this._courseX || this._courseZ) {
      const dot = hx * this._courseX + hz * this._courseZ;
      if (dot < 0.86) this.straightFor = 0; else this.straightFor += dt;
    }
    // The reference heading follows slowly, so a steady curve counts as
    // committed while a flick into a side road does not.
    this._courseX = lerp(this._courseX, hx, 1 - Math.exp(-1.1 * dt));
    this._courseZ = lerp(this._courseZ, hz, 1 - Math.exp(-1.1 * dt));
    const l = Math.hypot(this._courseX, this._courseZ) || 1;
    this._courseX /= l; this._courseZ /= l;
  }

  /** Rough "could the player see this car" test, for tidying up off screen. */
  _visibleTo(unit, target) {
    _eye.copy(target.position); _eye.y += 1.1;
    _tgt.copy(unit.position); _tgt.y += 0.8;
    return hasLineOfSight(this.game.world, _eye, _tgt, 1.2);
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
    const available = this.units.filter((u) => !u.human && !u.vehicle.disabled && u.role !== ROLE.HOLD);
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
    //
    // A box needs three cars in the same place, and the pursuit budget alone
    // never put them there: two units would sit on a crawling target while
    // everybody else was away claiming junctions, and the box was simply never
    // called. So when the target is slow enough to be boxed and the force is
    // allowed to try, the pack takes two extra cars off intercept duty. There
    // is nothing to get in front of at walking pace anyway.
    // Only when a box is genuinely on, though: two units already in touch, a
    // target down to walking-to-jogging pace, and the tier that allows it. A
    // looser test turns the whole pursuit into a pack every time you slow for
    // a junction, and a pack drives across gardens -- measured, the units well
    // off the carriageway in the town went from 5% of the chase to 15%.
    const boxable = rules.box && !this.boxAssignment && this.boxCooldown <= 0
      && Math.abs(target.forwardSpeed) < 13
      && available.filter((u) => u.distanceTo(target.position) < 70).length >= 2;
    const pursueWant = rules.pursue + (boxable ? 2 : 0);

    const pursuers = [];
    for (const u of available) {
      if (assigned.has(u)) continue;
      if (pursuers.length >= pursueWant) break;
      const d = u.distanceTo(k.position);
      if (d > 420) continue;
      pursuers.push(u);
      assigned.add(u);
      if (u.role !== ROLE.PURSUE) {
        u.setRole(ROLE.PURSUE);
        if (d < 120) {
          this.game.say('visual', [
            (v) => `${v.cs}, visual, joining.`,
            (v) => `${v.cs}, visual ${v.road}.`,
            (v) => `${v.cs}, I've got them ${v.road}.`,
            (v) => `${v.cs}, visual on the vehicle.`,
          ], { cs: u.callsign, road: this.game.roadName(k.position) }, false, { low: true, every: 25 });
        }
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
          this.game.say('pit', [
            (v) => `${v.cs}, PIT authorised.`,
            (v) => `${v.cs}, clear to PIT.`,
            (v) => `${v.cs}, PIT when ready.`,
            (v) => `${v.cs}, go for the PIT.`,
          ], { cs: u.callsign }, true, { every: 20 });
          break;
        }
      }
    }

    // ---- 5. box-in ----
    if (rules.box && !this.boxAssignment && k.seen && this.boxCooldown <= 0) {
      // 55 m, not 42. A box takes a few seconds to form up and the units have
      // to be allowed to arrive: measured on a crawling target, the third car
      // was typically 45 to 55 m back at the moment the decision was made, so
      // the old radius turned down nearly every box that was on.
      const close = available.filter((u) => !u.vehicle.disabled
        && u.distanceTo(target.position) < 55);
      const slow = Math.abs(target.forwardSpeed) < 24;
      if (close.length >= 3 && slow && !this.activePit) {
        this.boxAssignment = assignBoxSlots(target, close.slice(0, 4));
        this.boxTightness = 0;
        this.boxTimer = 0;
        for (const [unit, slot] of this.boxAssignment) {
          unit.setRole(ROLE.BOX, { slot, tightness: 0 });
          assigned.add(unit);
        }
        this.game.say('box', [
          'All units, box them in.',
          'Control, all units, box formation.',
          'All units, form the box.',
          'Control, close them down. Box.',
        ], {}, true, { every: 40 });
      }
    }

    // ---- 5b. rolling block ----
    // A unit put on the road in front of the target, going the same way but
    // slower. Distinct from an intercept, which races to a junction and waits.
    if (this.tier >= 2 && k.seen && !this.blockUnit && this.blockCooldown <= 0
        && Math.abs(target.forwardSpeed) > 12) {
      this.blockCooldown = 14;
      const u = this.game.spawnPoliceAhead(target, this.tier);
      // No hidden spot ahead right now -- a straight road in open view. Look
      // again in a few seconds rather than waiting out the whole cooldown; the
      // next corner usually has one.
      if (!u) this.blockCooldown = 3;
      if (u) {
        this.units.push(u);
        // Also into `available`, which was snapshotted before this unit
        // existed -- otherwise the validation immediately below decides it is
        // not a real unit and drops the block on the frame it was created.
        available.push(u);
        u.setRole(ROLE.BLOCK);
        this.blockUnit = u;
        assigned.add(u);
        this.game.say('block', [
          (v) => `${v.cs}, I'm ahead, slowing them.`,
          (v) => `${v.cs}, getting in front.`,
          (v) => `${v.cs}, up front, bringing them down.`,
          (v) => `${v.cs}, in front of them.`,
        ], { cs: u.callsign }, true, { every: 30 });
      }
    }

    // ---- 5c. the head-on van ----
    //
    // An armoured van put on the road well ahead, pointing the wrong way up
    // it, which then drives at the car as hard as it will go. It only works on
    // a road the driver has committed to -- there is no point aiming a van
    // down a street somebody is about to turn out of -- so it wants a straight
    // run and speed, and it is the top of the force's response: four stars up,
    // one at a time, with a long cooldown between attempts.
    if (this.tier >= 4 && k.seen && !this.rhinoUnit && this.rhinoCooldown <= 0
        && this.straightFor > 3.2 && Math.abs(target.forwardSpeed) > 22) {
      this.rhinoCooldown = 30;
      const u = this.game.spawnRhino(target, this.tier);
      // Nowhere to put it on this stretch: look again shortly rather than
      // waiting out the whole cooldown.
      if (!u) this.rhinoCooldown = 4;
      if (u) {
        this.units.push(u);
        available.push(u);
        u.setRole(ROLE.RHINO);
        this.rhinoUnit = u;
        assigned.add(u);
        // `roadName` already reads "on Cold Harbour", so nothing here may end
        // with a preposition of its own.
        this.game.say('rhino', [
          (v) => `${v.cs}, van's coming at them ${v.road}. Brace.`,
          (v) => `All units, van the wrong way ${v.road}. Stand clear.`,
          (v) => `${v.cs}, coming the other way ${v.road}. Stand clear.`,
          (v) => `Control, ${v.cs} going head-on. All units, hold back.`,
        ], { cs: u.callsign, road: this.game.roadName(u.position) }, true, { every: 25 });
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
    const speed = _dir.length();
    if (_dir.lengthSq() < 4) _dir.copy(target.forward);
    _dir.normalize();

    // Where they are likely to go, not merely where they could: see
    // RoadGraph.predict. Candidates are ranked by how likely the target is to
    // come through, and by whether the time is right -- far enough ahead to be
    // worth driving to, near enough that the prediction still means something.
    // Chokepoints still count for extra: there is no way round them.
    const likely = g.predict(k.position.x, k.position.z, _dir.x, _dir.z, speed, this.straightShare, 24);
    const candidates = [];
    for (const [id, rec] of likely) {
      if (rec.eta < 4.5 || rec.eta > 24 || rec.prob < this.interceptMinProb) continue;
      const node = g.nodes[id];
      if (node.edges.length < 3 && !node.chokepoint) continue;
      const timing = rec.eta < 6 ? 0.6 + (rec.eta - 4.5) * 0.27 : rec.eta > 16 ? 1 - (rec.eta - 16) * 0.07 : 1;
      const value = rec.prob * timing * (node.chokepoint ? 1.3 : 1);
      candidates.push({ id, eta: rec.eta, prob: rec.prob, value, x: node.x, z: node.z });
    }
    candidates.sort((a, b) => b.value - a.value);
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
      const open = shortlist.filter((c) => !this.claimedNodes.has(c.id));
      const near = open
        .map((c) => Object.assign({ raw: dist2(u.position.x, u.position.z, c.x, c.z) }, c))
        .sort((a, b) => a.raw - b.raw)
        .slice(0, 4);
      // And always the likeliest junction still unclaimed, near or not.
      if (open.length && !near.some((c) => c.id === open[0].id)) near.push(open[0]);

      let best = null;
      for (const c of near) {
        const path = g.route(from.id, c.id, cruise);
        if (!path) continue;
        const t = g.routeTime(path, 0.82);
        const margin = c.eta - t;
        if (margin < 1.2 || margin > 15) continue;
        // Prefer arriving with a small but real cushion, somewhere they are
        // actually likely to come through: a certain junction reached with
        // eight seconds to spare beats a coin-toss one reached with four.
        const cushion = margin < 2.5 ? 0.6 : margin <= 6 ? 1 : 1 - (margin - 6) * 0.07;
        const quality = c.prob * cushion;
        if (!best || quality > best.quality) best = { c, path, quality, margin };
      }

      if (best) {
        this.claimedNodes.add(best.c.id);
        const changed = u.role !== ROLE.INTERCEPT || u.orders.node !== best.c.id;
        u.setRole(ROLE.INTERCEPT, { node: best.c.id });
        // Start the path at the car, not at the junction behind it.
        u._routeTo(best.c.id, 2.4);
        placed++;
        // The intercept is re-solved every second and the best junction moves
        // with the target, so "changed" is true for most units most of the
        // time. Announcing every change put about sixty "cut them off at the
        // roundabout, 4s" calls a minute on the net once the radio actually
        // spoke -- more than half of everything said. A unit says it is going
        // to cut them off when it first takes the job, and again only if it is
        // still at it forty-five seconds later.
        const quietFor = this.clock - (u.lastInterceptCall || -1e9);
        if (changed && quietFor > 45) {
          const said = this.game.say('intercept', [
            (v) => `${v.cs}, cutting them off at ${v.node}.`,
            (v) => `${v.cs}, heading for ${v.node}.`,
            (v) => `${v.cs}, I'll head them off at ${v.node}.`,
            (v) => `${v.cs}, going round to ${v.node}.`,
          ], { cs: u.callsign, node: this.game.nodeName(best.c.id) }, false, { low: true, every: 45 });
          if (said) u.lastInterceptCall = this.clock;
        }
      } else {
        u.setRole(ROLE.RESPOND, { point: k.position.clone() });
      }
    }
  }

  // --------------------------------------------------------------- box logic

  _updateBox(dt, target) {
    this.boxCooldown -= dt;
    if (!this.boxAssignment) return;
    this.boxTimer += dt;

    // A box that is not going to form should be given up on. One unit wedged
    // against a wall forty metres away counts as live, holds three slots open
    // and never arrives, so without this the pursuit can spend the rest of the
    // chase in a formation of two.
    if (this.boxTimer > 15 && !boxClosed(target, this.boxAssignment)) {
      for (const [unit] of this.boxAssignment) {
        if (unit.role === ROLE.BOX) unit.setRole(ROLE.PURSUE);
      }
      this.boxAssignment = null;
      this.boxCooldown = 7;
      this.game.say('boxfail', [
        'Control, box isn\'t forming. Stay with them.',
        'Control, forget the box.',
        'Control, abandon the box, stay on them.',
      ], {}, false, { every: 40 });
      return;
    }

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
      this.game.say('boxbroken', [
        'Control, box broken. Resume pursuit.',
        'Control, they\'re out of the box.',
        'Control, box failed, stay with them.',
      ], {}, false, { every: 40 });
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
    // Off the board first. Without this the officer stays on the roster with
    // its car destroyed underneath it: it still counts against the budget, so
    // no replacement is sent; it still shows on the minimap and still talks on
    // the radio. "There were like 50 supposedly chasing me. I couldn't
    // actually see them."
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
    if (this.blockUnit === unit) this.blockUnit = null;
    if (this.rhinoUnit === unit) this.rhinoUnit = null;
    if (this.activePit === unit) this.activePit = null;
    // A boxing unit is held by the assignment as well. Leaving it there means
    // _updateBox keeps reading the position of a car that has been removed
    // from the world, and a box of three that has lost one of its three can
    // never close either -- so the whole box goes.
    if (this.boxAssignment && this.boxAssignment.has(unit)) {
      for (const [u] of this.boxAssignment) {
        if (u !== unit && u.role === ROLE.BOX) u.setRole(ROLE.PURSUE);
      }
      this.boxAssignment = null;
    }
    this.game.despawnPolice(unit);
  }

  /**
   * The chase is over and nobody is in custody: put everything away.
   *
   * Every tactic is cancelled, every unit goes back on its beat, and the
   * shared model of where you are is thrown out -- so a car that happens to
   * drive past you thirty seconds later has to notice you again from scratch,
   * the same as it would have before any of this started. The roster trims
   * itself back to the ambient patrol from here; see _manageRoster.
   */
  standDown() {
    this.activePit = null;
    this.boxAssignment = null;
    this.blockUnit = null;
    this.rhinoUnit = null;
    this.claimedNodes.clear();
    this.pitCooldown = 0;
    this.blockCooldown = 0;
    this.rhinoCooldown = 25;
    this.knowledge.seen = false;
    this.knowledge.spotter = null;
    this.knowledge.confidence = 0;
    this.knowledge.timeSinceSeen = 999;
    for (const u of this.units) {
      if (u.role === ROLE.HOLD) continue;
      u.setRole(ROLE.PATROL);
    }
    // Let the first car go without the usual wait, so the thinning out starts
    // while you are still driving away from it.
    this.trimTimer = 1.0;
  }

  /** A blocker that has been passed, or has lost the target, goes back in the pack. */
  onBlockEnded(unit) {
    if (this.blockUnit === unit) this.blockUnit = null;
    this.blockCooldown = Math.max(this.blockCooldown, 8);
  }

  /**
   * The van's run is over -- it has been past, or it has been stopped. It goes
   * back to being an ordinary, very heavy pursuit car.
   */
  onRhinoEnded(unit, hit) {
    if (this.rhinoUnit === unit) this.rhinoUnit = null;
    this.rhinoCooldown = Math.max(this.rhinoCooldown, hit ? 26 : 18);
    if (unit.role === ROLE.RHINO) unit.setRole(ROLE.PURSUE);
    if (hit) {
      this.game.say('rhino-hit', [
        (v) => `${v.cs}, contact! Straight through them.`,
        (v) => `${v.cs}, hard contact, head-on.`,
        'Control, the van\'s made contact.',
      ], { cs: unit.callsign }, true, { every: 12 });
    } else {
      this.game.say('rhino-miss', [
        (v) => `${v.cs}, missed them, turning round.`,
        (v) => `${v.cs}, they're past me. Coming about.`,
        (v) => `${v.cs}, no contact, they went by.`,
      ], { cs: unit.callsign }, true, { every: 12 });
    }
  }

  onPitFinished(unit, result) {
    if (this.activePit === unit) this.activePit = null;
    this.pitCooldown = result.reason === 'spun' ? 5.0 : 3.0;
    // Out of the PIT role now, not at the next role tick. Left in it, the unit
    // started a fresh attempt on the very next frame, found the target still
    // spinning from the first one, and reported a second successful PIT a
    // tenth of a second after the first.
    if (unit.role === ROLE.PIT) unit.setRole(ROLE.PURSUE);
    if (result.reason === 'spun') {
      this.game.say('spun', [
        (v) => `${v.cs}, contact, they've spun!`,
        (v) => `${v.cs}, PIT successful!`,
        (v) => `${v.cs}, got them, they've gone round!`,
        (v) => `${v.cs}, target's spun out.`,
      ], { cs: unit.callsign }, true);
    }
  }

  /** Called by the game when the player rams a unit. */
  onRammed(unit) {
    this.pitCooldown = Math.min(this.pitCooldown, 1.0);
  }

  reset() {
    for (const u of this.units) { if (!u.human) this.game.despawnPolice(u); }
    this.units = this.units.filter((u) => u.human);
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
  /**
   * A chase has just started: somebody reported this car, here, now.
   *
   * Without this the force carried whatever it last knew into the new chase,
   * which after a quiet spell is "nobody has seen that car for eight
   * minutes". Blow past a patrol car and run the red before it can take a
   * proper look and the screen went straight to COOLING DOWN while units were
   * being sent and the radio was calling a pursuit -- the status line and the
   * chase describing two different situations. A fresh report is what has
   * actually happened, so the search starts from where the offence was.
   */
  beginChase(position) {
    const k = this.knowledge;
    k.timeSinceSeen = 0;
    k.confidence = 1;
    if (position) {
      k.position.copy(position);
      k.velocity.set(0, 0, 0);
    }
  }

  statusLine() {
    const k = this.knowledge;
    if (this.tier === 0) return { text: 'NO ACTIVE PURSUIT', cls: 'clear' };
    // Out of sight but still tracked is still being chased: the force knows
    // exactly where the car is until the tracking bar empties, and the screen
    // says so rather than announcing a search that has not started.
    if (k.seen || k.timeSinceSeen < TRACK_SECONDS) {
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
