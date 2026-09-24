// Wanted level.
//
// Heat is a continuous value from 0 to 5. Its integer part is the tier, which
// is what the dispatcher reads to decide how many units to field and which
// tactics they may attempt. It climbs while the police have eyes on you and
// falls only once they have genuinely lost you -- breaking line of sight
// starts a clock, and being seen again resets it.

import { clamp, clamp01, lerp } from '../util/math.js';
import { SEARCH_SECONDS } from '../ai/dispatcher.js';

const MAX = 5;
/** How long you have to be pinned before the arrest lands. */
const BUST_SECONDS = 5;

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

export class Heat {
  constructor(game) {
    this.game = game;
    this.value = 0;
    this.evadeTimer = 0;
    this.bustTimer = 0;
    this.chaseStarted = 0;
    this.peak = 0;
    this.escapes = 0;
    this.pitsSurvived = 0;
    this.lastEvent = '';
  }

  get tier() { return clamp(Math.floor(this.value), 0, MAX); }
  get fraction() { return clamp01((this.value - this.tier) || (this.value > 0 ? 0 : 0)); }
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
      if (this.game.dispatcher) this.game.dispatcher.beginChase(this.game.player && this.game.player.position);
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
  }

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
  }
}
