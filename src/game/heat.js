// Wanted level.
//
// Heat is a continuous value from 0 to 5. Its integer part is the tier, which
// is what the dispatcher reads to decide how many units to field and which
// tactics they may attempt. It climbs while the police have eyes on you and
// falls only once they have genuinely lost you -- breaking line of sight
// starts a clock, and being seen again resets it.

import { clamp, clamp01, lerp } from '../util/math.js';
import { SEARCH_SECONDS } from '../ai/dispatcher.js';
import { raycast, groups, GROUP } from '../physics/world.js';

const MAX = 5;
/** How long you have to be pinned before the arrest lands. */
const BUST_SECONDS = 5;
/** On the quarry's ledges: seconds before the warning, the countdown after it, and off them all to start again. See Heat._checkLedges. */
const LEDGE_GRACE = 10;
const LEDGE_COUNT = 10;
const LEDGE_RESET = 60;
/** Slack round the ledges' radii, m, for the way they wander; height over the floor, m; metres either side of the cutting's line that are track, not ledge. */
const LEDGE_EDGE = 1.5;
const LEDGE_ABOVE = 2;
const LEDGE_CUT = 18;
/**
 * Boxed in where a police car cannot reach (Heat._checkBoxedIn): how long, s, before the warning, and how
 * long it counts; staying within this of one spot, m; a police car at most this far off, m (they give up
 * trying to reach a wedged car at 40-200 m, tests/wedge.js, so not very close); something solid this near,
 * m, on two sides at least this far round from each other, radians. How often it looks, s.
 */
const BOX_GRACE = 20;
const BOX_COUNT = 10;
const BOX_STAY = 10;
const BOX_POLICE = 300;
const BOX_SOLID = 4;
const BOX_ACROSS = 2.3;
const BOX_LOOK = 0.25;
const BOX_RAYS = 12;
const BOX_MASK = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP);
const _boxO = { x: 0, y: 0, z: 0 };
const _boxD = { x: 0, y: 0, z: 0 };

/**
 * Seconds of being watched to climb one tier, indexed by the tier you are on.
 *
 * It used to be one rate for the whole range -- about seventy seconds a tier,
 * whichever tier it was -- so the top of the range arrived at the same pace as
 * the bottom of it, and five stars turned up while you were still working out
 * what three meant. The climb now gets slower the higher it goes: the first
 * step is quick, and the last one takes over twice as long as it did. Ten
 * minutes of unbroken contact, end to end, and half that if you drive the
 * whole way like the reason they are chasing you.
 *
 * Index 0 is never used: a chase starts at one star, from an offence, not by
 * creeping up from nothing.
 */
const TIER_SECONDS = [80, 80, 105, 135, 170];

/**
 * How much faster the wanted level climbs on an Apple device.
 *
 * Everything that makes the pursuit harder follows the wanted level -- the
 * number of cars, the kinds of car, which tactics are unlocked, and how hard
 * each unit presses (Officer.aggression is read straight off the tier) -- so
 * this one number is most of what hard mode is. Three minutes to five stars
 * rather than ten.
 */
const APPLE_HEAT = 3;

export class Heat {
  constructor(game) {
    this.game = game;
    this.value = 0;
    this.evadeTimer = 0;
    this.bustTimer = 0;
    // Time on the quarry's ledges, and off them since (see _checkLedges).
    this.ledgeTime = 0;
    this.offLedges = 0;
    this.chaseStarted = 0;
    this.peak = 0;
    this.escapes = 0;
    this.pitsSurvived = 0;
    this.lastEvent = '';
  }

  get tier() { return clamp(Math.floor(this.value), 0, MAX); }
  /**
   * Seconds of no contact before the heat starts falling. Matches the police
   * search window, so the countdown on the HUD is telling you exactly how long
   * you have to stay hidden.
   */
  get evadeRequired() { return SEARCH_SECONDS; }

  bump(amount, reason) {
    if (this.value <= 0 && amount > 0) {
      this.value = 1.0;
      this.chaseStarted = performance.now();
      // Whoever called it in knows where you were when they did (see
      // Dispatcher.beginChase). Otherwise the chase inherits the last thing
      // the force knew, which may be nothing for several minutes.
      // The car being chased, which is not always the player's: see
      // Game.quarry.
      const hunted = this.game.quarry || this.game.player;
      if (this.game.dispatcher) this.game.dispatcher.beginChase(hunted && hunted.position);
      this.game.say('chase-start', [
        (v) => `Control, all units, vehicle ${v.reason}. Respond.`,
        (v) => `Control, any units, a vehicle ${v.reason}.`,
        (v) => `Control, all units, report of a vehicle ${v.reason}.`,
      ], { reason }, true);
    } else {
      this.value = clamp(this.value + amount, 0, MAX);
    }
    this.peak = Math.max(this.peak, this.value);
    this.lastEvent = reason;
  }

  update(dt, player, dispatcher) {
    const k = dispatcher.knowledge;

    if (this.value > 0) {
      if (k.seen) {
        this.evadeTimer = 0;
        // Being watched is itself incriminating: the longer they hold contact,
        // the more resources get committed. A tier is a real escalation -- new
        // car types, new tactics unlocked -- so it is deliberately slow, and
        // slower the further up you are (TIER_SECONDS).
        //
        // Driving like the reason they are chasing you is worth more of it,
        // but as a multiplier rather than a flat addition, so it speeds up the
        // top of the range in the same proportion as the bottom: half again
        // for over 137 km/h, a quarter again for a drift, and both together
        // halve the climb.
        let rate = 1 / TIER_SECONDS[Math.min(this.tier, TIER_SECONDS.length - 1)];
        if (Math.abs(player.forwardSpeed) > 38) rate *= 1.6;
        if (player.isDrifting) rate *= 1.25;
        // Ten minutes of unbroken contact to the top of the range, unless the
        // control room has taken a personal dislike to your telephone.
        if (this.game.appleHarder) rate *= APPLE_HEAT;
        this.value = clamp(this.value + rate * dt, 0, MAX);
        this.peak = Math.max(this.peak, this.value);
      } else {
        this.evadeTimer += dt;
        if (this.evadeTimer > this.evadeRequired) {
          // Decay is slower at high tiers -- shaking five stars takes commitment.
          const decay = lerp(0.55, 0.22, this.tier / MAX);
          this.value = clamp(this.value - decay * dt, 0, MAX);
          if (this.value <= 0) {
            this.escapes++;
            this.game.onEscaped();
          }
        }
      }
    }

    this._checkBust(dt, player, dispatcher);
    this._checkLedges(dt, player);
    this._checkBoxedIn(dt, player, dispatcher);
  }

  /**
   * Wedged where they cannot come near enough to arrest you. "You can wedge yourself in between two houses
   * in certain spots ... and obviously then the police actually can't bust you ... you can kind of fit in
   * between ... the petrol pumps and stuff, and the police can't actually get to you ... it's only when
   * they're in between two houses." A helicopter calling an airstrike was the player's first thought, and
   * not one they liked: so the officers get out and walk. In one small spot, with something solid close on
   * two opposite sides and a police car near, BOX_GRACE seconds and then a BOX_COUNT countdown to an arrest.
   * Drive out and it starts again. Out in the open none of this applies: the ordinary arrest does.
   */
  _checkBoxedIn(dt, player, dispatcher) {
    const g = this.game;
    if (this.value <= 0 || player !== g.player || g.outcome || player.isAircraft) {
      this.boxTime = 0; this._boxAt = null;
      return;
    }
    const p = player.position;
    if (!this._boxAt || Math.hypot(p.x - this._boxAt.x, p.z - this._boxAt.z) > BOX_STAY) {
      this._boxAt = { x: p.x, z: p.z };
      this.boxTime = 0;
      this._boxLook = 0;
    }
    this._boxLook = (this._boxLook || 0) - dt;
    if (this._boxLook <= 0) {
      this._boxLook = BOX_LOOK;
      this._boxed = this._boxedIn(player, dispatcher);
    }
    this.boxTime = this._boxed ? (this.boxTime || 0) + dt : Math.max(0, (this.boxTime || 0) - dt);
    const t = this.boxTime;
    if (t < BOX_GRACE) { this._boxSaid = null; return; }
    const left = Math.ceil(BOX_GRACE + BOX_COUNT - t);
    if (left <= 0) { this.boxArrest = true; g.onBusted(); return; }
    if (g.hud && left !== this._boxSaid) {
      this._boxSaid = left;
      g.hud.centreLine(`Officers on foot. Drive out or you're arrested: ${left}`);
    }
  }

  /** Solid on two sides that face each other, and a police car close by. */
  _boxedIn(player, dispatcher) {
    const p = player.position;
    let near = false;
    for (const u of dispatcher.units) {
      if (u.vehicle.disabled) continue;
      if (u.distanceTo(p) < BOX_POLICE) { near = true; break; }
    }
    if (!near) {
      for (const v of this.game.vehicles) {
        if (v === player || !v.isPolice || v.disabled || v.removed) continue;
        if (Math.hypot(v.position.x - p.x, v.position.z - p.z) < BOX_POLICE) { near = true; break; }
      }
    }
    if (!near) return false;
    _boxO.x = p.x; _boxO.y = p.y + 0.3; _boxO.z = p.z;
    let boxed = false;
    const seen = [];
    for (let k = 0; k < BOX_RAYS && !boxed; k++) {
      const a = (k / BOX_RAYS) * Math.PI * 2;
      _boxD.x = Math.sin(a); _boxD.y = 0; _boxD.z = Math.cos(a);
      if (!raycast(player.world, _boxO, _boxD, BOX_SOLID, BOX_MASK, player.body)) continue;
      for (const o of seen) {
        const d = Math.abs(Math.atan2(Math.sin(a - o), Math.cos(a - o)));
        if (d >= BOX_ACROSS) { boxed = true; break; }
      }
      seen.push(a);
    }
    return boxed;
  }

  /** Seconds left on the boxed-in countdown, or null when it is not running. */
  get wedgeRemaining() {
    const t = this.boxTime || 0;
    return t < BOX_GRACE ? null : Math.max(0, BOX_GRACE + BOX_COUNT - t);
  }
  get wedgeArrest() { return !!this.boxArrest; }
  set wedgeArrest(v) { this.boxArrest = v; }

  /**
   * Arrest condition: stopped, with a police car right on top of you, for five
   * seconds. "Within 3 m" is measured between the cars rather than between
   * their centres -- centre to centre, 3 m would mean the two were already
   * overlapping.
   *
   * The countdown decays about twice as fast as it fills, so nudging free for
   * a moment buys real time back rather than just pausing the clock.
   */
  _checkBust(dt, player, dispatcher) {
    if (this.value <= 0) { this.bustTimer = 0; this.bustPinned = false; return; }

    const myHalf = player.spec.dims.l * 0.5;
    let closest = Infinity;
    for (const u of dispatcher.units) {
      if (u.vehicle.disabled) continue;
      const gap = u.distanceTo(player.position) - myHalf - u.vehicle.spec.dims.l * 0.5;
      if (gap < closest) closest = gap;
    }

    // 3 km/h is 0.833 m/s.
    const pinned = Math.abs(player.forwardSpeed) < (3 / 3.6) && closest <= 3.0;
    this.bustPinned = pinned;

    if (pinned) {
      this.bustTimer += dt;
      if (this.bustTimer >= BUST_SECONDS) this.game.onBusted();
    } else {
      this.bustTimer = Math.max(0, this.bustTimer - dt * 2.2);
    }
  }

  /** Seconds left before arrest, and how far the bar has filled. */
  get bustRemaining() { return Math.max(0, BUST_SECONDS - this.bustTimer); }
  get bustProgress() { return clamp01(this.bustTimer / BUST_SECONDS); }

  /** Fraction of the way to the next tier, for the HUD bar. */
  get progress() {
    if (this.value <= 0) return 0;
    if (this.value >= MAX) return 1;
    return this.value - Math.floor(this.value);
  }

  /** Seconds survived in the current chase. */
  get elapsed() {
    return this.value > 0 ? (performance.now() - this.chaseStarted) / 1000 : 0;
  }

  reset() {
    this.value = 0;
    this.evadeTimer = 0;
    this.bustTimer = 0;
    this.peak = 0;
    this.ledgeTime = 0;
    this.offLedges = 0;
    this.boxTime = 0;
    this.boxArrest = false;
    this._boxAt = null;
  }

  /**
   * Hiding on the quarry's ledges, where a police car cannot follow, is an
   * arrest on a timer. "If you stay on any of those ledges for like 10
   * seconds, then a warning starts appearing. And even if you're on any other
   * ledge ... the countdown will still be going, and it'll be 10, 9, until you
   * just get busted ... I want that to reset, so if the person ... goes ...
   * off all the ledges resets every ... one minute. Just otherwise, police cars
   * actually can't get onto the ledges, really."
   *
   * Time on any ledge adds up (the haul road that ran up them is gone, so a
   * car only gets onto one by falling); the floor, the rim and the cutting are not ledges, since a
   * unit can drive to all three. LEDGE_GRACE seconds of it, then a warning and
   * a LEDGE_COUNT countdown, then busted. Off every ledge it holds, and after
   * LEDGE_RESET seconds off them it starts again from nothing. Only while
   * wanted, and only for the player's own car.
   */
  _checkLedges(dt, player) {
    const g = this.game;
    const map = g.world && g.world.__map;
    const q = map && map.quarry;
    if (!q || q.inner === undefined || this.value <= 0 || player !== g.player || g.outcome) {
      this.ledgeTime = 0; this.offLedges = 0;
      return;
    }
    const p = player.position;
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    const a = Math.atan2(p.z - q.z, p.x - q.x);
    const fromCut = Math.abs(Math.atan2(Math.sin(a - q.open), Math.cos(a - q.open)));
    const on = d > q.inner - LEDGE_EDGE && d < q.rimIn + LEDGE_EDGE
      && p.y > q.floor + LEDGE_ABOVE
      && fromCut > LEDGE_CUT / Math.max(1, d);
    if (on) {
      this.offLedges = 0;
      this.ledgeTime = (this.ledgeTime || 0) + dt;
    } else if ((this.ledgeTime || 0) > 0) {
      this.offLedges = (this.offLedges || 0) + dt;
      if (this.offLedges > LEDGE_RESET) { this.ledgeTime = 0; this.offLedges = 0; }
    }
    const t = this.ledgeTime || 0;
    if (t < LEDGE_GRACE) return;
    const left = Math.ceil(LEDGE_GRACE + LEDGE_COUNT - t);
    if (left <= 0) { g.onBusted(); return; }
    if (g.hud && left !== this._ledgeSaid) {
      this._ledgeSaid = left;
      g.hud.centreLine(`Off the ledges or you're arrested: ${left}`);
    }
  }

  /** Seconds left on the ledge countdown, or null when it is not running. */
  get ledgeRemaining() {
    const t = this.ledgeTime || 0;
    return t < LEDGE_GRACE ? null : Math.max(0, LEDGE_GRACE + LEDGE_COUNT - t);
  }
}
