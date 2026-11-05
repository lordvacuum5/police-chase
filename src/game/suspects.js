// Traffic that gets itself chased.
//
// "If they hit a police car, or if a traffic runs a red light, or if they
// block a police car's way ... I want then ... a proper wanted level to start
// on that car ... the same properties ... of the first runaway car we've ever
// made ... it still looks like a civilian car, but it wants to start running
// away and use the same routing system and everything as that burglar car.
// And have independent heat levels that you can slowly go up."
//
// A traffic car that offends where a patrol car can see it stops being
// traffic: the getaway driver (ai/runner.js) takes it over, running from the
// start, and the patrol car that saw it goes after it. It has a wanted level
// of its own -- climbing slowly while it is in sight, falling once it is not --
// and the police cars on it are its own, SUSPECT_UNITS by that level, taken
// off the dispatcher's board while they are, so the player's chase neither
// counts them nor steers them.
//
// "If you get into pursuit whilst the police are in pursuit of another car
// ... I'd only want like two police cars to break off pursuit and actually
// follow, chase me ... pull police cars slowly away from the other car." The
// player's chase is built out of the suspect's cars first, one every
// PEEL_EVERY seconds, nearest to the player first, never the last one on it,
// and the dispatcher waits for that rather than sending new ones.
//
// "Have a full busted thing. But nothing needs to appear on the screen ...
// I want that car to then kind of not move for the rest of the map ... off
// the road ... stay there for the rest of the game." Stopped with a unit on
// it for BUST_SECONDS, it pulls onto the verge and is left there, handbrake
// on, for good. Lost for long enough it has got away, and once nobody can see
// it, it goes.
//
// And now and then a car does something stupid in front of a patrol car of
// its own accord: game/traffic.js runs a red light, very rarely, when there is
// one to see it.
//
// "If I'm the police car, okay, in a single player world, if a normal traffic
// car hits me, the pursuit starts." The player's own police car counts as a
// witness to a hit on itself, and is one of the cars that can see a suspect
// and make the arrest. "If two civilian cars hit each other, I would like one
// to stay where they are, or come off the road a bit ... and I want the other
// one to speed off, and then the police to begin pursuit of that vehicle. But
// only if the police car is in ... relatively close visual range." Two traffic
// cars that collide within CRASH_SIGHT of a police car that can see them: one
// pulls onto the verge and stops, the other runs.
import { Runner } from '../ai/runner.js';
import { ROLE } from '../ai/officer.js';
import { dist2 } from '../util/math.js';
import { groups, GROUP } from '../physics/world.js';
import { fleeingSpec } from './vehicles.js';
import { session, AI_ID } from '../net/session.js';

/** Cars on a suspect by its wanted level, 0-5. */
const SUSPECT_UNITS = [0, 2, 3, 4, 5, 6];
/**
 * The same when the police side is the player's: nobody else needs the cars.
 * "It's like wanted level 5, and there were like 4 cops ... it's weird."
 * Closer to what those stars mean in the player's own chase (dispatcher TIER).
 */
const OPEN_WORLD_UNITS = [0, 2, 4, 7, 10, 14];
/** A patrol this near a suspect with a clear line to it joins the chase, m; never more than JOIN_MAX on one. */
const JOIN_NEAR = 90;
const JOIN_MAX = 16;
/** At most this many suspects at once. */
const MAX_SUSPECTS = 2;
/** At most this many caught ones left where they stopped. */
const MAX_PARKED = 4;
/** Its wanted level: up this much a second while seen, down this much once unseen for UNSEEN_GRACE s. */
const HEAT_RISE = 1 / 45;
const HEAT_FALL = 1 / 18;
const UNSEEN_GRACE = 8;
/** What a hit on a police car adds, and the most it can be. */
const HIT_HEAT = 0.4;
const MAX_HEAT = 5;
/** How far a unit can see a suspect, m (with a clear line). */
const SIGHT = 170;
/** The arrest: under this speed, m/s, with a unit's bodywork within BUST_GAP m, for BUST_SECONDS. */
const BUST_SPEED = 1.5;
const BUST_GAP = 3.2;
const BUST_SECONDS = 5;
/** How fast the arrest runs back once nobody is on it, per second: the same as the player's own (game/heat.js). */
const BUST_DRAIN = 2.2;
/**
 * A driver's nerve, out of 1: what being tailed within NERVE_NEAR m takes a
 * second, what a knock from a police car takes, and the damage at which they
 * have had enough regardless. "A police cars can't bust normal cars. Like I have
 * to be there for them to bust it." A unit can only arrest a stopped car, and a
 * fleeing one never stopped: 100 s with units on it and 0.63 damage and it was
 * still going. With a player in the way it stopped against them.
 */
const NERVE_NEAR = 25;
const NERVE_TAILED = 1 / 40;
const NERVE_KNOCK = 0.15;
const NERVE_DAMAGE = 0.6;
/** With a unit this near, m, it drives as if seen. */
const HUNTED_NEAR = 250;
/** A suspect that has not moved for this long, s, can be arrested from this far, m: wherever it has ended up, a unit can walk to it. */
const STILL_SECONDS = 10;
const STILL_REACH = 22;
/** Further under the ground than this, m, a car has gone through it. */
const UNDER = 1.2;
/** How often a unit is taken off the suspect for the player's chase, s. */
const PEEL_EVERY = 4;
/** Nearer the wanted player than this, m, with a clear view, a unit does not wait its turn. */
const PEEL_NEAR = 170;
/** A patrol held behind a traffic car this long, both stopped and no red light, s: obstruction. */
const BLOCK_SECONDS = 12;
/** How far a patrol car notices a traffic car hit it or run a light, m. */
const WITNESS = 80;
/** Bolting in front of a patrol car: how near, the chance a second, and how long before the same car is asked again, s. */
const BOLT_NEAR = 45;
const BOLT_CHANCE = 0.03;
const BOLT_AGAIN = 40;
/** Out of sight of everyone and this far away, a suspect that got away is taken off the map, m. */
const GONE = 320;
/** Pulling over once caught: aim this far up the road and this far past its edge, m; at most this long, s. */
const PULL_AHEAD = 8;
const PULL_VERGE = 2.5;
const PULL_FOR = 9;
/** A crash between two traffic cars is seen by a police car this near with a clear line, m. */
const CRASH_SIGHT = 60;
/** How hard a knock counts as a crash, m/s of velocity change (as Vehicle.takeImpact). */
const CRASH_HIT = 2.6;
/** A traffic car whose bodywork is within this of the police player's at a knock is the one that hit it, m. */
const HIT_GAP = 1.2;
/**
 * The share of traffic cars that run after a knock with the police player; the
 * rest pull over and stop with their hazards on. "When you have a collision
 * with a traffic vehicle, I don't want every single traffic vehicle to run
 * away. I want it to be maybe like 25% of them ... [the rest] kind of stop
 * where they are, pull over to the road ... I don't want them to like run."
 */
const HIT_RUN_CHANCE = 0.25;

export class Suspects {
  constructor(game) {
    this.game = game;
    this.list = [];
    this._peelFor = 0;
    this._hitCheck = 0;
  }

  reset() {
    for (const s of this.list) {
      this._release(s);
      if (s.v && !s.v.removed) this.game.removeVehicle(s.v);
    }
    this.list = [];
  }

  /** Is this vehicle a suspect being chased (not one caught or got away)? */
  chasing(v) {
    return this.list.some((s) => s.v === v && s.state === 'run');
  }

  /**
   * The HUD's status line in the police side's open world, for the suspect
   * nearest being chased, or null with none: the dispatcher's own line
   * ("NO ACTIVE PURSUIT") then stands.
   */
  statusLine() {
    const run = this.list.filter((s) => s.state === 'run');
    if (!run.length) return null;
    const seen = run.find((s) => s.seen);
    const s = seen || run[0];
    const n = s.units.filter((u) => u.vehicle && !u.vehicle.disabled).length;
    if (seen) return { text: `PURSUIT — ${n} UNIT${n === 1 ? '' : 'S'} ON IT`, cls: 'spotted' };
    return { text: 'SEARCHING FOR THE VEHICLE', cls: 'searching' };
  }

  /**
   * The wanted level the HUD shows in the police side's open world: the
   * hottest suspect being chased, as the stars and bar read a Heat ({tier,
   * progress}). Nothing running, nothing.
   */
  wanted() {
    let h = 0;
    for (const s of this.list) if (s.state === 'run') h = Math.max(h, s.heat);
    const tier = Math.max(0, Math.min(MAX_HEAT, Math.floor(h)));
    return { tier, progress: h <= 0 ? 0 : h >= MAX_HEAT ? 1 : h - Math.floor(h) };
  }

  /**
   * The arrest closest to done, as the busted meter reads it: seconds in, and
   * whether a unit is on it right now. "When you're the police, it doesn't
   * show a busting symbol when anyone's busting, either the police cars or
   * you." Any suspect, whoever is making the arrest.
   */
  bust() {
    let best = null;
    for (const s of this.list) {
      if (s.state !== 'run' || !(s.pinFor > 0.01)) continue;
      if (!best || s.pinFor > best.pinFor) best = s;
    }
    return best ? { timer: best.pinFor, pinned: !!best.pinned } : { timer: 0, pinned: false };
  }

  /** The police cars on suspects, for anything that needs every unit. */
  units() {
    const out = [];
    for (const s of this.list) out.push(...s.units);
    return out;
  }

  /**
   * A traffic car has done something a police officer saw. `c` is its
   * record in game.traffic.cars; `witness` the unit that saw it, or null.
   */
  offence(c, why, witness = null) {
    const g = this.game;
    if (!c || !c.v || c.v.removed || c.v.isSuspect) return null;
    if (this.list.filter((s) => s.state === 'run').length >= MAX_SUSPECTS) return null;
    if (g.outcome) return null;
    g.traffic.release(c);
    const v = c.v;
    v.isSuspect = true;
    v.fleeing = true;
    v.trafficId = c.id;
    const runner = new Runner(g, v);
    // Running from the start: it has already shown its hand.
    runner.running = true;
    runner.breakIn = 0;
    // Keeps trying, however close the police are. Stopping is decided here, by
    // its nerve, or by not being able to move.
    runner.neverPinned = true;
    runner.usePlanners = true;
    v.spec = fleeingSpec(v.spec);
    const s = { v, runner, why, heat: 1, units: [], seen: true, unseenFor: 0, pinFor: 0,
      state: 'run', want: 0, acquireFor: 0, pullFor: 0, goneFor: 0 };
    s.lastSeen = v.position.clone();
    runner.threats = () => this._threats(s);
    this.list.push(s);
    this._groundIt(v);
    if (witness) this._take(s, witness);
    const cs = witness ? witness.callsign : 'Control, all units';
    const what = why === 'hit' ? 'failed to stop after a collision with a police vehicle'
      : why === 'crash' ? 'failed to stop after a collision'
        : why === 'red' ? 'through a red light'
          : why === 'bolt' ? 'making off at speed' : 'obstructing a police vehicle';
    g.say('suspect', [
      (x) => `${x.cs}, in pursuit of a civilian vehicle, ${x.what}.`,
      (x) => `${x.cs}, vehicle ${x.what}, attempting to stop it.`,
      (x) => `${x.cs}, I've got one ${x.what}, following.`,
    ], { cs, what }, true, { every: 6 });
    // In the open world it is the whole game, so it says so: "then it will
    // like pop up as a pursuit."
    if (g.openWorld && g.hud) g.hud.notice('PURSUIT', `Vehicle ${what}.`);
    if (session.active && session.isHost) session.sendEvent('notice', { title: 'PURSUIT', text: `Vehicle ${what}.` });
    return s;
  }

  /**
   * A car out of traffic meets the hills again. Traffic's bodywork ignores them,
   * being many and on the roads (Vehicle); off the road, or shoved over on its
   * side, nothing then held it up: "sometimes to the quarry ... it goes through
   * the floor and you can't bust it."
   */
  _groundIt(v) {
    if (this.game.sim.terrainAt) v.collider.setCollisionGroups(groups(GROUP.VEHICLE, 0xFFFF));
  }

  /** Under the ground regardless: back up on the nearest road. */
  _rescue(v) {
    const g = this.game;
    if (v.position.y > g.sim.heightAt(v.position.x, v.position.z) - UNDER) return;
    const snap = g.graph.nearestEdge(v.position.x, v.position.z, 400);
    const x = snap ? snap.x : v.position.x, z = snap ? snap.z : v.position.z;
    v.teleport({ x, y: g.sim.heightAt(x, z) + 1, z }, Math.atan2(v.forward.x, v.forward.z));
  }

  /** The cars this suspect is running from: its own, and anyone else's. */
  _threats(s) {
    const out = [];
    for (const p of this._policePlayers()) out.push(p);
    for (const u of s.units) if (u.vehicle && !u.vehicle.disabled) out.push(u.vehicle);
    for (const u of this.game.dispatcher.units) if (u.vehicle && !u.vehicle.disabled) out.push(u.vehicle);
    return out;
  }

  /** Move a unit off the dispatcher's board onto suspect `s`. */
  _take(s, u) {
    const d = this.game.dispatcher;
    const i = d.units.indexOf(u);
    if (i >= 0) d.units.splice(i, 1);
    if (d.blockUnit === u) d.blockUnit = null;
    if (d.rhinoUnit === u) d.rhinoUnit = null;
    if (d.activePit === u) d.activePit = null;
    for (const o of this.list) { const k = o.units.indexOf(u); if (k >= 0) o.units.splice(k, 1); }
    u.setRole(ROLE.PURSUE);
    u.vehicle.onCall = true;
    s.units.push(u);
  }

  /** Every unit on `s` back to the dispatcher, on its beat. */
  _release(s) {
    for (const u of s.units) {
      if (!u.vehicle || u.vehicle.removed) continue;
      u.vehicle.onCall = false;
      u.setRole(ROLE.PATROL);
      this.game.dispatcher.adopt(u);
    }
    s.units = [];
  }

  update(dt) {
    const g = this.game;
    if (!g.traffic || !g.dispatcher) return;
    this._spotOffences(dt);
    for (const s of this.list) {
      if (s.v.removed) { s.state = 'gone'; this._release(s); continue; }
      this._rescue(s.v);
      // What the map on a police player's screen goes by: caught or lost is off it.
      s.v.fleeing = s.state === 'run';
      if (s.state === 'run') this._run(s, dt);
      else if (s.state === 'pull') this._pull(s, dt);
      else if (s.state === 'parked') this._parked(s, dt);
      else if (s.state === 'free') this._free(s, dt);
    }
    this.list = this.list.filter((s) => s.state !== 'gone');
    this._peel(dt);
  }

  _run(s, dt) {
    const g = this.game, v = s.v, d = g.dispatcher;
    // Its own units, driven here: they are not on the dispatcher's board.
    s.units = s.units.filter((u) => u.vehicle && !u.vehicle.removed);
    let seen = false, near = Infinity;
    for (const u of s.units) {
      u.update(dt, v);
      const r = dist2(u.vehicle.position.x, u.vehicle.position.z, v.position.x, v.position.z);
      const gap = r - (u.vehicle.spec.dims.l + v.spec.dims.l) * 0.5;
      near = Math.min(near, gap);
      // Making the arrest: sit on it rather than pushing it away again. A
      // unit still driving into a car that is all but stopped shoved it along
      // at 3-20 km/h and the arrest never came.
      // Inside the arrest gap: stopped short of it, it never starts.
      if (gap <= BUST_GAP - 0.4 && v.speed < BUST_SPEED * 3) {
        u.vehicle.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      }
      if (!seen && r < SIGHT && d._visibleTo(u, v)) seen = true;
    }
    // The player's helicopter, when it has eyes on this one (Game._airSpotting).
    if (s.airSeenAt !== undefined && g.clock - s.airSeenAt < 0.6) seen = true;
    // The player, when the player is the police.
    for (const p of this._policePlayers()) {
      const r = dist2(p.position.x, p.position.z, v.position.x, v.position.z);
      near = Math.min(near, r - (p.spec.dims.l + v.spec.dims.l) * 0.5);
      if (!seen && r < SIGHT && d._visibleTo(p, v)) seen = true;
    }
    // Still running flat out with them just out of sight, not back to the limit.
    s.runner.hunted = seen || near < HUNTED_NEAR;
    s.seen = seen;
    // For the open world's map marker (Game._openWorldMarker).
    if (seen) { s.lastSeen = s.lastSeen || v.position.clone(); s.lastSeen.copy(v.position); }
    // Lost its nerve: stops where it is, for the units to come and arrest it.
    if (near < NERVE_NEAR) s.nerve = (s.nerve === undefined ? 1 : s.nerve) - NERVE_TAILED * dt;
    if (v.lastImpactAt && v.lastImpactAt !== s.knockAt && v.lastImpact > CRASH_HIT && near < BUST_GAP) {
      s.knockAt = v.lastImpactAt;
      s.nerve = (s.nerve === undefined ? 1 : s.nerve) - NERVE_KNOCK;
    }
    if (!s.gaveUp && (s.nerve <= 0 || v.damage >= NERVE_DAMAGE)) {
      s.gaveUp = true;
      g.say('suspectStop', [
        () => 'Control, vehicle is slowing, driver giving up.',
        () => 'Control, vehicle stopping, moving in.',
      ], {}, false, { every: 10 });
    }
    if (s.gaveUp) v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: v.speed < 3 ? 1 : 0 });
    else s.runner.update(dt);

    // Its wanted level, its own.
    s.unseenFor = seen ? 0 : s.unseenFor + dt;
    if (seen) s.heat = Math.min(MAX_HEAT, s.heat + HEAT_RISE * dt);
    else if (s.unseenFor > UNSEEN_GRACE) s.heat -= HEAT_FALL * dt;
    // Given up, it waits to be arrested: a stopped car does not get away.
    if (s.gaveUp) s.heat = Math.max(s.heat, 1);
    else if (s.heat <= 0 || !s.units.length && s.unseenFor > UNSEEN_GRACE) {
      s.state = 'free';
      this._release(s);
      g.say('suspectLost', [
        () => 'Control, all units, lost the vehicle. Resume patrol.',
        () => 'Control, no trace of the vehicle. Back to patrol.',
      ], {}, false, { every: 10 });
      return;
    }

    // The arrest.
    // Run down slowly rather than reset by one bad moment of a shove.
    // Back at the rate the player's own does: "it just seems to go down really
    // slowly." It was a quarter of that, to forgive a shove.
    s.stillFor = v.speed < BUST_SPEED ? (s.stillFor || 0) + dt : 0;
    s.pinned = near <= (s.stillFor > STILL_SECONDS ? STILL_REACH : BUST_GAP) && v.speed < BUST_SPEED;
    s.pinFor = s.pinned ? s.pinFor + dt : Math.max(0, s.pinFor - dt * BUST_DRAIN);
    if (s.pinFor >= BUST_SECONDS) {
      s.state = 'pull';
      s.pullFor = 0;
      // Off any long-range line it was on: its own driving, from here.
      Object.assign(s.runner.driver, { planned: false, trustRoute: false, freeLined: false });
      const cs = s.units.length ? s.units[0].callsign : 'Control';
      this._release(s);
      g.say('suspectBusted', [
        (x) => `${x.cs}, vehicle stopped, one detained.`,
        (x) => `${x.cs}, driver detained, vehicle off the road.`,
      ], { cs }, false, { every: 6 });
      return;
    }

    // A patrol car going about its beat that comes past the chase joins it:
    // "if a normal other patrolling car that isn't in a pursuit goes past the
    // pursuit, it joins in." Once a second, any patrol within JOIN_NEAR with a
    // clear line to the car, over and above what its level calls for, up to
    // JOIN_MAX on it in all -- and only while the player is not wanted, when
    // every car on the board is needed for that.
    s.joinFor = (s.joinFor || 0) - dt;
    if (s.joinFor <= 0 && g.heat.tier === 0) {
      s.joinFor = 1;
      for (const u of d.units.slice()) {
        if (s.units.length >= JOIN_MAX) break;
        if (u.human || u.role !== ROLE.PATROL || !u.vehicle || u.vehicle.disabled) continue;
        const r = dist2(u.vehicle.position.x, u.vehicle.position.z, v.position.x, v.position.z);
        if (r > JOIN_NEAR || !d._visibleTo(u, v)) continue;
        this._take(s, u);
        s.joined = (s.joined || 0) + 1;
        g.say('suspectJoin', [
          (x) => `${x.cs}, I've got eyes on it, joining.`,
          (x) => `${x.cs}, it's just gone past me, joining the pursuit.`,
        ], { cs: u.callsign }, false, { every: 8 });
      }
    }

    // As many units as its level calls for, from the patrols if there are
    // any to spare and the player is not wanted, otherwise new.
    const tier = Math.max(1, Math.min(5, Math.floor(s.heat)));
    s.acquireFor -= dt;
    const wanted = (g.openWorld ? OPEN_WORLD_UNITS : SUSPECT_UNITS)[tier];
    if (s.units.length < wanted && s.acquireFor <= 0) {
      s.acquireFor = g.openWorld ? 1.5 : 3;
      let pick = null, best = 650;
      if (g.heat.tier === 0) {
        for (const u of d.units) {
          if (u.human || u.role !== ROLE.PATROL || u.vehicle.disabled) continue;
          const r = dist2(u.vehicle.position.x, u.vehicle.position.z, v.position.x, v.position.z);
          if (r < best) { best = r; pick = u; }
        }
      }
      if (pick) this._take(s, pick);
      else {
        const u = g.spawnPoliceNear(v.position, tier);
        if (u) { s.units.push(u); u.setRole(ROLE.PURSUE); u.vehicle.onCall = true; }
      }
    }
  }

  /** Caught: onto the verge, then left there. */
  _pull(s, dt) {
    const g = this.game, v = s.v;
    s.pullFor += dt;
    const here = g.graph.nearestEdge(v.position.x, v.position.z, 40);
    const off = !here || here.dist > here.edge.width * 0.5 + 0.8;
    if (off || s.pullFor > PULL_FOR) {
      s.state = 'parked';
      v.parkedForGood = true;
      v.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 1 });
      return;
    }
    const ax = v.position.x + v.forward.x * PULL_AHEAD, az = v.position.z + v.forward.z * PULL_AHEAD;
    const snap = g.graph.nearestEdge(ax, az, 40);
    if (!snap) { s.state = 'parked'; return; }
    const t = g.graph.edgeDirection(snap.edge, snap.along, { x: 0, z: 1 });
    const sg = t.x * v.forward.x + t.z * v.forward.z >= 0 ? 1 : -1;
    // The near side: left, in Britain.
    const w = snap.edge.width * 0.5 + PULL_VERGE;
    const aim = { x: snap.x - t.z * sg * w, z: snap.z + t.x * sg * w };
    const out = s.runner.driver.driveTo(aim, 4, dt, {});
    if (v.forwardSpeed > 5.5) { out.throttle = 0; out.brake = 0.5; }
    v.setControls(out);
  }

  /**
   * Stopped for good. A caught suspect stays for the rest of the game; the
   * other car in a crash goes once nobody can see it.
   */
  _parked(s, dt) {
    const g = this.game, v = s.v;
    v.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 1 });
    // A caught one stays, "for the rest of the map", but they all count against the
    // police cars the board can hold (Game.carCount), so over a long game they stopped
    // any more being sent. The oldest beyond MAX_PARKED goes, once nobody can see it.
    if (!s.victim && !(this.list.filter((o) => o.state === 'parked' && !o.victim).length > MAX_PARKED
      && this.list.find((o) => o.state === 'parked' && !o.victim) === s)) return;
    const far = g.watcherDistance(v.position) > GONE;
    s.goneFor = far && !g.seenByAnyone(v.position) ? s.goneFor + dt : 0;
    if (s.goneFor > 2) { g.removeVehicle(v); s.state = 'gone'; }
  }

  /**
   * The police cars people are driving: the player's on their own, and in a
   * multiplayer game the other players' (this runs on the host, who is the one
   * being chased). Each can see a suspect, make the arrest, and set one off.
   */
  _policePlayers() {
    const g = this.game, out = [], p = g.player;
    if (g.soloPolice && p && p.isPolice && !p.isAircraft && !p.removed) out.push(p);
    if (g.netCars) {
      for (const [id, v] of g.netCars) {
        if (v.isPolice && !v.removed && !String(id).startsWith(AI_ID)) out.push(v);
      }
    }
    return out;
  }

  /** Got away: drives on, and goes once nobody can see it. */
  _free(s, dt) {
    const g = this.game, v = s.v;
    s.runner.hunted = false;
    s.runner.update(dt);
    const far = g.watcherDistance(v.position) > GONE;
    s.goneFor = far && !g.seenByAnyone(v.position) ? s.goneFor + dt : 0;
    if (s.goneFor > 2) { g.removeVehicle(v); s.state = 'gone'; }
  }

  /**
   * The player's chase out of the suspects' cars: one at a time, nearest to
   * the player first, never a suspect's last.
   */
  _peel(dt) {
    const g = this.game, d = g.dispatcher;
    this._peelFor -= dt;
    if (!(g.heat.tier > 0)) return;
    const live = d.units.filter((u) => !u.human && !u.vehicle.disabled && u.role !== ROLE.HOLD);
    const want = d.rules ? d.rules.units : 0;
    // One right there with the player in view comes at once, the last on a civilian
    // or not: it is not going to carry on past the car it is now wanted for.
    if (live.length < want) {
      for (const s of this.list) {
        if (s.state !== 'run') continue;
        const u = s.units.find((o) => !o.vehicle.disabled && o.distanceTo(g.quarry.position) < PEEL_NEAR && d._visibleTo(o, g.quarry));
        if (!u) continue;
        s.units.splice(s.units.indexOf(u), 1);
        u.vehicle.onCall = false;
        d.adopt(u);
        return;
      }
    }
    const spare = this.list.some((s) => s.state === 'run' && s.units.length > 1);
    if (!spare || live.length >= want) return;
    // The dispatcher waits for these rather than sending new cars.
    d.spawnTimer = Math.max(d.spawnTimer, 1);
    if (this._peelFor > 0) return;
    this._peelFor = PEEL_EVERY;
    const p = g.quarry;
    let pick = null, from = null, best = Infinity;
    for (const s of this.list) {
      if (s.state !== 'run' || s.units.length < 2) continue;
      for (const u of s.units) {
        const r = dist2(u.vehicle.position.x, u.vehicle.position.z, p.position.x, p.position.z);
        if (r < best) { best = r; pick = u; from = s; }
      }
    }
    if (!pick) return;
    from.units.splice(from.units.indexOf(pick), 1);
    pick.vehicle.onCall = false;
    d.adopt(pick);
  }

  /** Watching for traffic offences: a hit on a police car, or one sat in its way. */
  _spotOffences(dt) {
    const g = this.game, d = g.dispatcher;
    const now = performance.now();
    // And now and then one that just goes for it in front of a patrol car --
    // the country's version of a red light, since Haldon Vale has none: "very,
    // very, very occasionally a traffic car will say run a red light in front
    // of a police officer. I don't know, that sort of thing." Once a second,
    // each traffic car a patrol car can see within BOLT_NEAR has a BOLT_CHANCE
    // of flooring it, and is not asked again for BOLT_AGAIN seconds.
    this._boltFor = (this._boltFor || 0) - dt;
    if (this._boltFor <= 0) {
      this._boltFor = 1;
      for (const c of g.traffic.cars) {
        if (c.v.dormant || (c.boltAt && g.clock - c.boltAt < BOLT_AGAIN)) continue;
        const w = this.witnessAt(c.v.position.x, c.v.position.z, BOLT_NEAR);
        if (!w || !d._visibleTo(w, c.v)) continue;
        c.boltAt = g.clock;
        if (g.rng() < BOLT_CHANCE && this.offence(c, 'bolt', w)) break;
      }
    }
    // A traffic car into the player's own police car.
    for (const p of this._policePlayers()) if (this._hitPlayer(p, now)) return;
    // Two traffic cars into each other, in front of the police.
    for (const c of g.traffic.cars) {
      const v = c.v;
      if (v.dormant || !v.lastImpactAt || now - v.lastImpactAt > 300 || !(v.lastImpact > CRASH_HIT)) continue;
      if (v._crashAt === v.lastImpactAt) continue;
      v._crashAt = v.lastImpactAt;
      const o = this._trafficTouching(v);
      if (!o) continue;
      o._crashAt = o.lastImpactAt;
      if (this._crash(c, g.traffic.recordOf(o))) return;
    }
    for (const u of d.units) {
      if (u.human || !u.vehicle || u.vehicle.disabled) continue;
      // Only a patrol car notices: one already chasing has other things on.
      if (u.role !== ROLE.PATROL) { u._blockedFor = 0; continue; }
      const v = u.vehicle;
      // Hit by a traffic car, just now.
      if (v.lastImpactAt && now - v.lastImpactAt < 300 && v.lastImpact > 2.6 && v._suspectHitAt !== v.lastImpactAt) {
        v._suspectHitAt = v.lastImpactAt;
        let other = null;
        g.world.contactPairsWith(v.collider, (o) => { if (o.__vehicle && o.__vehicle.isTraffic) other = o.__vehicle; });
        if (other) {
          const c = g.traffic.recordOf(other);
          const s = this.offence(c, 'hit', u);
          if (s) s.heat = Math.min(MAX_HEAT, s.heat + HIT_HEAT);
          return;
        }
      }
      // Sat behind a traffic car that is stopped for no reason it can see.
      const ob = u._obstacle;
      if (ob && ob.isTraffic && u.driver.heldBy && v.speed < 0.5 && ob.speed < 0.5) {
        const red = g.signals && Number.isFinite(g.signals.stopDistanceAt(ob.position.x, ob.position.z, ob.forward.x, ob.forward.z, 0));
        u._blockedFor = red ? 0 : (u._blockedFor || 0) + dt;
        if (u._blockedFor > BLOCK_SECONDS) {
          u._blockedFor = 0;
          this.offence(g.traffic.recordOf(ob), 'block', u);
          return;
        }
      } else {
        u._blockedFor = 0;
      }
    }
  }

  /**
   * A traffic car and the police player, into each other.
   *
   * "If a civilian car hits me, it still doesn't work." The first version
   * looked once, the frame after the knock, for a traffic car still touching
   * -- and by then the two had usually bounced apart, so it found none and
   * the hit was gone for good. Now: a fresh knock over CRASH_HIT on either car
   * -- the heavy police car can take one under it that the traffic car does
   * not -- with the traffic car's bodywork within HIT_GAP of yours.
   *
   * Whoever drove into whom. Both earlier versions blamed only the traffic
   * car -- nose-first, then by who was closing faster -- and the player, asked
   * what happened when it "didn't work", was not sure and may have hit it
   * themselves: from the driver's seat a crash is a crash, and a civilian car
   * that has had one with a police car makes off.
   */
  _hitPlayer(p, now) {
    const g = this.game;
    const fresh = (v) => v.lastImpactAt && now - v.lastImpactAt < 300 && v.lastImpact > CRASH_HIT;
    const hitMe = fresh(p) && p._suspectHitAt !== p.lastImpactAt;
    let other = null, best = Infinity;
    for (const c of g.traffic.cars) {
      const v = c.v;
      if (v.dormant) continue;
      const r = dist2(v.position.x, v.position.z, p.position.x, p.position.z);
      if (r - (v.spec.dims.l + p.spec.dims.l) * 0.5 > HIT_GAP) continue;
      if (!hitMe && !(fresh(v) && v._playerHitAt !== v.lastImpactAt)) continue;
      if (r < best) { best = r; other = v; }
    }
    if (!other) return false;
    p._suspectHitAt = p.lastImpactAt;
    other._playerHitAt = other.lastImpactAt;
    const c = g.traffic.recordOf(other);
    const s = g.rng() < HIT_RUN_CHANCE ? this.offence(c, 'hit', null) : null;
    // Most of them, and any past the two that can run at once: onto the verge
    // and stopped, hazards on, the way a driver who has just hit a police car
    // actually behaves.
    if (!s) return this._pullOver(c);
    s.heat = Math.min(MAX_HEAT, s.heat + HIT_HEAT);
    return true;
  }

  /**
   * Out of traffic, onto the verge and stopped with its hazards on; it goes
   * once nobody can see it (_parked). The other car in a crash, or a driver
   * who has hit the police player and is not running.
   */
  _pullOver(c) {
    if (!c || !c.v || c.v.removed || c.v.isSuspect) return false;
    const g = this.game;
    g.traffic.release(c);
    const v = c.v;
    this._groundIt(v);
    v.trafficId = c.id;
    v.hazards = true;
    this.list.push({ v, runner: new Runner(g, v), why: 'crash', victim: true, heat: 0, units: [],
      state: 'pull', pullFor: 0, goneFor: 0 });
    return true;
  }

  /** The traffic car touching vehicle `v` right now, if any. */
  _trafficTouching(v) {
    let other = null;
    this.game.world.contactPairsWith(v.collider, (o) => {
      if (o.__vehicle && o.__vehicle !== v && o.__vehicle.isTraffic) other = o.__vehicle;
    });
    return other;
  }

  /**
   * Traffic cars `a` and `b` have collided. With a police car near enough to
   * see it -- the player's, or a patrol's -- one of them runs and the other
   * pulls over and stops. Either may be the one that runs. Unseen, nothing:
   * they carry on as traffic.
   */
  _crash(a, b) {
    const g = this.game, d = g.dispatcher;
    if (!a || !b) return false;
    const x = (a.v.position.x + b.v.position.x) * 0.5, z = (a.v.position.z + b.v.position.z) * 0.5;
    const at = { position: { x, y: (a.v.position.y + b.v.position.y) * 0.5, z } };
    let witness = null, seen = false;
    for (const p of this._policePlayers()) {
      if (dist2(p.position.x, p.position.z, x, z) < CRASH_SIGHT && d._visibleTo(p, at)) seen = true;
    }
    for (const u of d.units) {
      if (seen && witness) break;
      if (u.human || !u.vehicle || u.vehicle.disabled) continue;
      if (dist2(u.vehicle.position.x, u.vehicle.position.z, x, z) > CRASH_SIGHT || !d._visibleTo(u, at)) continue;
      seen = true;
      // Only a patrol goes after it; a unit already on a chase just saw it.
      if (u.role === ROLE.PATROL) witness = u;
    }
    if (!seen) return false;
    const [run, stop] = g.rng() < 0.5 ? [a, b] : [b, a];
    if (!this.offence(run, 'crash', witness)) return false;
    return this._pullOver(stop);
  }

  /** A patrol car that can see (x, z), within WITNESS: for game/traffic.js before it runs a light. */
  witnessAt(x, z, range = WITNESS) {
    const g = this.game;
    for (const u of g.dispatcher.units) {
      if (u.human || u.role !== ROLE.PATROL || !u.vehicle || u.vehicle.disabled) continue;
      if (dist2(u.vehicle.position.x, u.vehicle.position.z, x, z) > range) continue;
      return u;
    }
    return null;
  }
}

export { SUSPECT_UNITS, SIGHT as SUSPECT_SIGHT };
