// Is the siren a siren?
//
// It cannot be listened to from here, so this drives GameAudio.update with a
// fake unit at a given distance and records what the oscillators are *asked*
// for -- the requested value, not the node's current one. Reading the node
// back does not work: setTargetAtTime is an exponential approach on the audio
// clock, which does not advance between synchronous calls, so every sample
// comes out near where the sweep started.
window.__runSiren = async function () {
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, a = g.audio;
    if (!a || !a.ready) { window.__res = 'AUDIO NOT READY (click the page first)'; return; }
    const rows = [];

    const fake = (dist) => ({
      units: [{
        vehicle: { disabled: false, unmarked: false },
        distanceTo: () => dist,
      }],
    });
    const heat = { tier: 4 };

    // Record what the fundamental is told to do over a stretch of simulated
    // time, at the rate the game would call it.
    const sweep = (dist, seconds) => {
      const asked = [];
      const p = a.sirenOsc.frequency;
      const orig = p.setTargetAtTime.bind(p);
      p.setTargetAtTime = (v, t, c) => { asked.push(v); return orig(v, t, c); };
      a.sirenPhase = 0;
      const step = 1 / 60;
      for (let t = 0; t < seconds; t += step) a.update(step, g.player, fake(dist), heat);
      p.setTargetAtTime = orig;
      return asked;
    };

    const span = (s) => `${Math.min(...s).toFixed(0)}-${Math.max(...s).toFixed(0)} Hz`;
    // One peak per cycle: the wail turns round at the top, the yelp snaps back
    // from it. Counting every descending step instead counts the whole of a
    // wail's downward half and reports a cycle of a few hundredths of a second.
    const cycles = (s) => {
      let n = 0;
      for (let i = 2; i < s.length; i++) {
        if (s[i - 1] > s[i - 2] && s[i] < s[i - 1]) n++;
      }
      return n;
    };

    const wail = sweep(120, 9);
    rows.push(['wail, 120 m out', span(wail)]);
    rows.push(['wail cycle', `${(9 / Math.max(1, cycles(wail))).toFixed(2)} s`]);

    const yelp = sweep(30, 3);
    rows.push(['yelp, 30 m out', span(yelp)]);
    rows.push(['yelp cycle', `${(3 / Math.max(1, cycles(yelp))).toFixed(2)} s`]);

    rows.push(['second voice, on the fifth',
      (a.sirenOsc2.frequency.value / Math.max(1, a.sirenOsc.frequency.value)).toFixed(3)]);
    rows.push(['horn above the note',
      (a.sirenHorn.frequency.value / Math.max(1, a.sirenOsc.frequency.value)).toFixed(2)]);

    // Level with distance. The gain is a target too, so record the request.
    const levels = {};
    const pg = a.sirenGain.gain;
    const og = pg.setTargetAtTime.bind(pg);
    for (const d of [20, 60, 120, 180, 250]) {
      let last = null;
      pg.setTargetAtTime = (v, t, c) => { last = v; return og(v, t, c); };
      a.update(1 / 60, g.player, fake(d), heat);
      levels[d] = last;
    }
    pg.setTargetAtTime = og;
    rows.push(['level by distance', Object.entries(levels)
      .map(([d, v]) => `${d}m ${v === null ? '-' : v.toFixed(4)}`).join('  ')]);

    window.__res = rows.map((r) => `${r[0].padEnd(28)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 400);
  }
};
