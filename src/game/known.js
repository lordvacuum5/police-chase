// The car the police know.
//
// "When you're getting a pursuit ... the police see your car, they recognise your car ... even after they've
// fully lost you ... and they go back to patrol ... if a police car then sees you ... and you're still in the
// same car ... they kind of flash their lights and honk ... try to make you pull over. If you ... zoom away
// ... then they would get you in pursuit. But if they do recognise you, then I want it that it regains the
// earlier wanted level ... if you spray paint your car a different colour, they won't recognise you ... I
// don't want any bar on screen, but ... if they get relatively close to me to almost have a good look at my
// car, then it bumps up to the earlier wanted level that I was at. Obviously, don't bump it down ever."
//
// A chase that reaches KNOWN_FROM stars puts your car on file: its kind and its paint, and the highest level
// it reached. While you are in that car, in that colour (the car icon by the stars says so):
//  - Not wanted, a patrol car that sees you within STOP_SPOT comes after you to have a look: off the force's
//    board, driven here, blipping its lights and siren. A good look (LOOK_TIME seconds within LOOK_CLOSE, in
//    sight) and the old level is back. Get STOP_LOSE away from it with it still watching and it is a pursuit
//    for failing to stop, at the old level too; out of its sight STOP_UNSEEN seconds and it has lost you.
//  - Wanted, a unit's good look at you puts the level up to the old one if it is lower. Never down.
// A respray to another colour and they do not know it; back to the colour on file and they do again. Arrested, the run ends, and R
// starts it clean.
// Single player only: in a multiplayer game the heat is one machine's and the other players' cars are not.

import { ROLE } from '../ai/officer.js';
import { dist2 } from '../util/math.js';

/** Stars a chase needs before the car is on file. */
export const KNOWN_FROM = 2;
/**
 * Not wanted: a patrol car this close that can see you comes to look, m. 70 at first, with LOOK_CLOSE 22 and
 * STOP_LOSE counted whether or not it could still see you: "I went behind a hedge and I was quite far away
 * from it, and then it regained pursuit of me. Like you need to be much closer to the police car, and also
 * within line of sight of it because I was behind a hedge."
 */
const STOP_SPOT = 40;
/** The good look: within this gap, m, in sight (hedges count), for this long in all, s. */
const LOOK_CLOSE = 10;
const LOOK_TIME = 2.5;
/** What a look is worth when they drop back: it drains this much slower than it fills. */
const LOOK_DRAIN = 0.4;
/** Pulling away from the car looking at you, while it can still see you: this far from it, m, is failing to stop. */
const STOP_LOSE = 60;
/** Out of its sight this long, s, and it has lost you: no pursuit, it goes back to its beat. */
const STOP_UNSEEN = 4;
/** A look that goes nowhere -- it cannot get to you -- is given up after this long, s. */
const STOP_GIVE_UP = 45;
/** A unit that has looked and lost you does not try again for this long, s. */
const STOP_AGAIN = 20;
/** The blips while it follows: one this often, s, this long, s. */
const BLIP_EVERY = 1.6;
const BLIP_FOR = 0.7;

export class KnownCar {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  /** The start of a run: nothing on file. */
  reset() {
    if (this.stop) this._release();
    this.file = null;          // { kind, paint, tier }
    this.stop = null;          // { unit, look, t, blipIn }
    this.look = 0;
    this.again = 0;
  }

  /** Is the car you are in the one on file? */
  get recognisable() {
    const f = this.file, p = this.game.player;
    return !!(f && p && p.specKey === f.kind && (p.paint || 0) === f.paint);
  }

  /**
   * Resprayed: the file is kept, and the car is only known while it is the colour on file (recognisable). It was taken off file
   * altogether: "if I resprayed it back to the original colour, they still didn't recognise me, and the car symbol didn't come back."
   */
  resprayed() {
    if (this.stop) this._release();
    this.look = 0;
  }

  update(dt) {
    const g = this.game, p = g.player, h = g.heat, d = g.dispatcher;
    if (!p || g.outcome || g.daily || g.runner || p.isPolice || p.isAircraft || !d) {
      if (this.stop) this._release();
      return;
    }
    // On file, or the level on file raised, as the chase climbs.
    if (h.tier >= KNOWN_FROM) {
      if (!this.recognisable || !this.file) this.file = { kind: p.specKey, paint: p.paint || 0, tier: h.tier };
      else this.file.tier = Math.max(this.file.tier, h.tier);
    }
    this.again = Math.max(0, this.again - dt);
    if (!this.recognisable) { if (this.stop) this._release(); return; }

    if (h.value > 0) {
      if (this.stop) this._release();
      if (h.tier >= this.file.tier) { this.look = 0; return; }
      // Wanted at a lower level than on file: any unit's good look puts it back up.
      const close = d.units.some((u) => !u.human && !u.vehicle.disabled && this._gap(u) < LOOK_CLOSE && d._visibleTo(u, p));
      this.look = close ? this.look + dt : Math.max(0, this.look - dt * LOOK_DRAIN);
      if (this.look >= LOOK_TIME) this._recognised(this._nearest(d.units));
      return;
    }
    if (this.stop) { this._follow(dt); return; }
    // Not wanted: a patrol car that sees you comes for a look.
    if (this.again > 0) return;
    const k = d.knowledge;
    const u = k.seen && k.spotter;
    if (!u || !u.vehicle || u.human || u.vehicle.disabled || !d.units.includes(u)) return;
    if (u.distanceTo(p.position) > STOP_SPOT || !d._visibleTo(u, p)) return;
    this._start(u);
  }

  /** The gap between a unit's car and yours, m. */
  _gap(u) {
    const p = this.game.player, v = u.vehicle;
    return dist2(v.position.x, v.position.z, p.position.x, p.position.z) - (v.spec.dims.l + p.spec.dims.l) * 0.5;
  }

  _nearest(units) {
    let best = null, bd = Infinity;
    for (const u of units) {
      if (u.human || !u.vehicle || u.vehicle.disabled) continue;
      const g = this._gap(u);
      if (g < bd) { bd = g; best = u; }
    }
    return best;
  }

  _start(u) {
    const g = this.game, d = g.dispatcher;
    const i = d.units.indexOf(u);
    if (i >= 0) d.units.splice(i, 1);
    u.setRole(ROLE.PURSUE);
    this.stop = { unit: u, look: 0, t: 0, blipIn: 0, unseen: 0 };
    g.say('knownStop', [
      (x) => `Control, ${x.cs}. Vehicle that matches one from earlier. Going to have a look.`,
      (x) => `Control, ${x.cs}. Think I've got the car from before. Pulling it over.`,
      (x) => `Control, ${x.cs}. Same make and colour as earlier's suspect. Checking it out.`,
    ], { cs: u.callsign }, true, { every: 6 });
  }

  /** The unit after you, not wanted yet: lights, a look, or you get away from it. */
  _follow(dt) {
    const g = this.game, s = this.stop, u = s.unit, p = g.player, d = g.dispatcher;
    if (!u.vehicle || u.vehicle.removed || u.vehicle.disabled) { this._release(); return; }
    s.t += dt;
    u.update(dt, p);
    s.blipIn -= dt;
    if (s.blipIn <= 0) { s.blipIn = BLIP_EVERY; u.vehicle.blipFor = BLIP_FOR; }
    const gap = this._gap(u);
    const sees = d._visibleTo(u, p);
    const close = gap < LOOK_CLOSE && sees;
    s.look = close ? s.look + dt : Math.max(0, s.look - dt * LOOK_DRAIN);
    if (s.look >= LOOK_TIME) { this._recognised(u); return; }
    // Out of its sight long enough, it has lost you: no pursuit.
    s.unseen = sees ? 0 : s.unseen + dt;
    if (s.unseen > STOP_UNSEEN) {
      this._release();
      this.again = STOP_AGAIN;
      g.say('knownLost', [
        () => 'Control, lost sight of that vehicle. Resuming patrol.',
        () => 'Control, no sign of it now. Back on patrol.',
      ], {}, false, { every: 10 });
      return;
    }
    if (gap > STOP_LOSE && sees) {
      // Away from it: that is a pursuit, for not stopping. Close enough later, they will know you.
      const word = d._bearingWord(u.vehicle.position, p.position);
      // Straight back to the level on file: running from the car that came to look is as good as the look. It was one star for
      // failing to stop and a second look to put it back: "it doesn't need to be where like they ... give me wanted level 1 and
      // then they go, 'Oh, I think it is actually them' ... Just bump up straight to the wanted level".
      this._release();
      const h = g.heat, tier = this.file.tier;
      h.bump(1, 'failing to stop');
      if (h.value < tier) h.value = tier;
      h.peak = Math.max(h.peak, h.value);
      this.look = 0;
      g.say('knownFled', [
        () => `Control, vehicle failed to stop, heading ${word}bound. It's the suspect from earlier.`,
        () => `Control, in pursuit ${word}bound, vehicle not stopping. That's our suspect from before.`,
      ], {}, true);
      return;
    }
    if (s.t > STOP_GIVE_UP) { this._release(); this.again = STOP_AGAIN; }
  }

  /** A good look: it is them. Back up to the level on file, never down. */
  _recognised(u) {
    const g = this.game, h = g.heat, tier = this.file.tier;
    if (this.stop) this._release();
    this.look = 0;
    if (h.value <= 0) h.bump(1, 'matching an earlier suspect');
    if (h.value < tier) h.value = tier;
    h.peak = Math.max(h.peak, h.value);
    g.say('knownSeen', [
      (x) => `Control, ${x.cs}. Confirmed, it's the vehicle from earlier. All units.`,
      (x) => `Control, ${x.cs}. That's our suspect from before. Same car.`,
      (x) => `Control, ${x.cs}. Positive match on the earlier vehicle. Requesting backup.`,
    ], { cs: u ? u.callsign : 'unit' }, true);
  }

  /** The looking unit back on the force's board, on its beat or into the chase. */
  _release() {
    const u = this.stop && this.stop.unit;
    this.stop = null;
    if (!u || !u.vehicle || u.vehicle.removed) return;
    u.vehicle.blipFor = 0;
    u.setRole(ROLE.PATROL);
    this.game.dispatcher.adopt(u);
  }
}
