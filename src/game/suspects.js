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
import { Runner } from '../ai/runner.js';
import { ROLE } from '../ai/officer.js';
import { dist2 } from '../util/math.js';

/** Cars on a suspect by its wanted level, 0-5. */
const SUSPECT_UNITS = [0, 2, 3, 4, 5, 6];
/** At most this many suspects at once. */
const MAX_SUSPECTS = 2;
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
/** How often a unit is taken off the suspect for the player's chase, s. */
const PEEL_EVERY = 4;
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
    const runner = new Runner(g, v);
    // Running from the start: it has already shown its hand.
    runner.running = true;
    runner.breakIn = 0;
    const s = { v, runner, why, heat: 1, units: [], seen: true, unseenFor: 0, pinFor: 0,
      state: 'run', want: 0, acquireFor: 0, pullFor: 0, goneFor: 0 };
    runner.threats = () => this._threats(s);
    this.list.push(s);
    if (witness) this._take(s, witness);
    const cs = witness ? witness.callsign : 'Control';
    const what = why === 'hit' ? 'failed to stop after a collision with a police vehicle'
      : why === 'red' ? 'through a red light'
        : why === 'bolt' ? 'making off at speed' : 'obstructing a police vehicle';
    g.say('suspect', [
      (x) => `${x.cs}, in pursuit of a civilian vehicle, ${x.what}.`,
      (x) => `${x.cs}, vehicle ${x.what}, attempting to stop it.`,
      (x) => `${x.cs}, I've got one ${x.what}, following.`,
    ], { cs, what }, true, { every: 6 });
    return s;
  }

  /** The cars this suspect is running from: its own, and anyone else's. */
  _threats(s) {
    const out = [];
    const p = this.game.player;
    if (p && !p.isAircraft && p.isPolice) out.push(p);
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
      if (s.state === 'run') this._run(s, dt);
      else if (s.state === 'pull') this._pull(s, dt);
      else if (s.state === 'parked') s.v.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 1 });
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
      if (gap <= BUST_GAP + 2 && v.speed < BUST_SPEED * 3) {
        u.vehicle.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      }
      if (!seen && r < SIGHT && d._visibleTo(u, v)) seen = true;
    }
    s.runner.hunted = seen;
    s.runner.update(dt);

    // Its wanted level, its own.
    s.unseenFor = seen ? 0 : s.unseenFor + dt;
    if (seen) s.heat = Math.min(MAX_HEAT, s.heat + HEAT_RISE * dt);
    else if (s.unseenFor > UNSEEN_GRACE) s.heat -= HEAT_FALL * dt;
    if (s.heat <= 0 || !s.units.length && s.unseenFor > UNSEEN_GRACE) {
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
    s.pinFor = near <= BUST_GAP && v.speed < BUST_SPEED ? s.pinFor + dt : Math.max(0, s.pinFor - dt * 0.5);
    if (s.pinFor >= BUST_SECONDS) {
      s.state = 'pull';
      s.pullFor = 0;
      const cs = s.units.length ? s.units[0].callsign : 'Control';
      this._release(s);
      g.say('suspectBusted', [
        (x) => `${x.cs}, vehicle stopped, one detained.`,
        (x) => `${x.cs}, driver detained, vehicle off the road.`,
      ], { cs }, false, { every: 6 });
      return;
    }

    // As many units as its level calls for, from the patrols if there are
    // any to spare and the player is not wanted, otherwise new.
    const tier = Math.max(1, Math.min(5, Math.floor(s.heat)));
    s.acquireFor -= dt;
    if (s.units.length < SUSPECT_UNITS[tier] && s.acquireFor <= 0) {
      s.acquireFor = 3;
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

export { SUSPECT_UNITS };
