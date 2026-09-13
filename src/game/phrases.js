// Radio phrasing that does not repeat itself.
//
// Real radio traffic is formulaic, but the same person does not say the same
// sentence word for word three times in a minute -- and once the calls were
// spoken aloud, the ones that did stood out immediately: "Control, still no
// further sighting, keep looking", three times over during a search.
//
// Every line on the net comes from a set of variants. A key remembers which of
// its variants went out recently and will not pick those again until the rest
// have had a turn. Game.radio then drops any line whose exact text went out in
// the last 45 seconds, which catches the repeats no variant set can -- the same
// callsign saying the same short thing about the same road.

export class Phrasebook {
  /**
   * @param rng  Math.random by default. Deliberately not the game's seeded
   *             generator: that one decides spawns and routes, and drawing
   *             phrases from it would make the chase play out differently
   *             depending on what happened to be said.
   */
  constructor(rng = Math.random) {
    this.rng = rng;
    this.recent = new Map();
  }

  /**
   * One of `variants` for `key`. Variants are strings, or functions of `vars`
   * returning strings. Of n variants, the last ceil(n * 0.6) picked for this
   * key (but always leaving at least one) are skipped.
   */
  pick(key, variants, vars = {}) {
    if (!variants.length) return '';
    const used = this.recent.get(key) || [];
    const memory = Math.min(variants.length - 1, Math.ceil(variants.length * 0.6));
    let pool = [];
    for (let i = 0; i < variants.length; i++) if (!used.includes(i)) pool.push(i);
    if (!pool.length) pool = variants.map((_, i) => i);
    const i = pool[Math.floor(this.rng() * pool.length) % pool.length];
    used.push(i);
    while (used.length > memory) used.shift();
    this.recent.set(key, used);
    const v = variants[i];
    return typeof v === 'function' ? v(vars) : v;
  }

  reset() {
    this.recent.clear();
  }
}
