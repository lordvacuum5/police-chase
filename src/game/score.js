// Score, and the best runs.
//
// A run lasts until you are arrested. Getting away does not end it -- the town
// carries on and so does the score -- so the way to a big number is to keep
// getting chased and keep getting away.
//
// Points come from two places:
//
//   time      every second with the police after you, more the higher the
//             wanted level: surviving at five stars is worth twelve times
//             surviving at one
//   moments   getting away, going round a roadblock, writing off a police car,
//             and a near miss -- a police car past you at speed, close enough
//             to touch, without touching
//
// The best ten runs are kept in the browser, with the car, the map and how
// long the run lasted, and shown on the menu.

const PER_SECOND = [0, 5, 10, 20, 35, 60];

const KEY = 'pc.scores';
const KEEP = 10;

export function bestScores() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((r) => r && Number.isFinite(r.score)) : [];
  } catch (e) {
    return [];
  }
}

function saveScores(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, KEEP))); } catch (e) { /* storage blocked */ }
}

export class Score {
  constructor(game) {
    this.game = game;
    this.popups = [];          // { text, points, t } for the HUD
    this.reset();
  }

  reset() {
    this.points = 0;
    this.runTime = 0;
    this.peakTier = 0;
    this.chasePeak = 0;
    this.escapes = 0;
    this.blocks = 0;
    this.wrecks = 0;
    this.nearMisses = 0;
    this._wrecked = new WeakSet();
    this._near = new WeakMap();   // unit -> { at, lastAward }
    this.popups.length = 0;
    this.final = null;
  }

  get value() { return Math.floor(this.points); }

  _bonus(points, text) {
    this.points += points;
    this.popups.push({ text, points, t: 0 });
    if (this.popups.length > 4) this.popups.shift();
  }

  update(dt) {
    const g = this.game;
    for (const p of this.popups) p.t += dt;
    while (this.popups.length && this.popups[0].t > 2.6) this.popups.shift();
    if (g.outcome) return;

    this.runTime += dt;
    const tier = g.heat.tier;
    if (tier > 0) {
      this.points += PER_SECOND[Math.min(5, tier)] * dt;
      this.peakTier = Math.max(this.peakTier, tier);
      this.chasePeak = Math.max(this.chasePeak || 0, tier);
    }

    const p = g.player;
    const now = g.clock;
    for (const u of g.dispatcher.units) {
      const v = u.vehicle;
      // A police car you put out of the chase. Credited if you were close by
      // when it went, so a unit that drives itself into a wall on the other
      // side of town does not count.
      if (v.disabled && !this._wrecked.has(u)) {
        this._wrecked.add(u);
        if (tier > 0 && u.distanceTo(p.position) < 25) {
          this.wrecks++;
          this._bonus(250, 'POLICE CAR WRECKED');
        }
      }
      // Near miss: past each other fast, a hand's width apart, no contact.
      if (tier > 0 && !v.disabled) {
        const gap = u.distanceTo(p.position) - p.spec.dims.w * 0.5 - v.spec.dims.w * 0.5;
        const rel = Math.hypot(v.linvel.x - p.linvel.x, v.linvel.z - p.linvel.z);
        const rec = this._near.get(u) || { at: -1, lastAward: -99 };
        if (gap < 1.4 && rel > 14 && now - rec.lastAward > 4) rec.at = now;
        if (rec.at > 0 && now - rec.at > 0.4) {
          const touched = p.lastImpactAt && performance.now() - p.lastImpactAt < 700;
          if (!touched && gap > 0.3) {
            this.nearMisses++;
            this._bonus(100, 'NEAR MISS');
            rec.lastAward = now;
          }
          rec.at = -1;
        }
        this._near.set(u, rec);
      }
    }
  }

  /** Got away: worth more the hotter it was. Call before the heat is cleared. */
  onEscaped(peak) {
    peak = Math.max(peak, this.chasePeak || 0);
    this.chasePeak = 0;
    const tier = Math.max(1, Math.min(5, Math.floor(peak)));
    this.escapes++;
    this._bonus(400 * tier, `ESCAPED ${'★'.repeat(tier)}`);
  }

  onBlockBeaten() {
    this.blocks++;
    this._bonus(300, 'ROADBLOCK BEATEN');
  }

  /** The run is over. Records it and says where it came. */
  finish() {
    if (this.final) return this.final;
    const g = this.game;
    const entry = {
      score: this.value,
      car: g.player.spec.name,
      map: g.mapDef ? g.mapDef.name : '',
      seconds: Math.round(this.runTime),
      peak: this.peakTier,
      escapes: this.escapes,
      date: new Date().toISOString().slice(0, 10),
    };
    const list = bestScores();
    const prevBest = list.length ? list[0].score : 0;
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    const rank = list.indexOf(entry) + 1;
    if (entry.score > 0) saveScores(list);
    this.final = { ...entry, rank: rank <= KEEP && entry.score > 0 ? rank : null, best: Math.max(prevBest, entry.score), newBest: entry.score > prevBest && entry.score > 0 };
    return this.final;
  }
}
