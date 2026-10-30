// How often the force boxes you in and arrests you. Whole game.
//
// Asked after the bodywork's friction came down (0.35 to 0.2, so a car pinned
// by a police nose can drive out): does the force still get its arrests? The
// player's car is driven by the getaway AI (ai/runner.js) -- which tries to
// get away and drives out of a box like a player would -- the wanted level
// held at `heat`, and the whole game stepped headless for `seconds`, `runs`
// times. `friction` sets every car's bodywork as it appears (null: as built).
//
//   arrests   times the arrest landed (the chase starts again after each)
//   pinned    seconds the arrest meter was running (stopped, a unit within 3 m)
//   near      share of the run a unit was within 30 m
window.__runArrests = async function (seconds = 60, runs = 3, heat = 4, friction = null, label = '') {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { Runner } = await import('/src/ai/runner.js');
    const out = [];
    let all = 0, allPinned = 0;
    for (let run = 0; run < runs; run++) {
      const p = g.player;
      // A fresh chase each run, and after each arrest: kept going, the car
      // sat pinned for the rest of the run and was arrested every five seconds.
      g.restart();
      let ai = new Runner(g, p), busted = false;
      let arrests = 0, pinned = 0, near = 0, n = 0;
      g.onBusted = () => { arrests++; busted = true; g.outcome = null; g.heat.bustTimer = 0; };
      g.onEscaped = () => { g.outcome = null; };
      g.heat.value = heat;
      const origU = g._update.bind(g);
      // What the AI asks for goes in as scripted input; otherwise the
      // keyboard's nothing overwrites it every frame.
      const real = p.setControls.bind(p);
      g._update = (dt) => {
        let ctl = null;
        p.setControls = (c) => { ctl = c; real(c); };
        try { ai.update(dt); } catch (e) { /* keep going */ }
        p.setControls = real;
        g.forceControls = ctl;
        origU(dt);
      };
      for (let i = 0; i < seconds * 30; i++) {
        g.heat.value = Math.max(g.heat.value, heat);
        if (friction !== null) for (const v of g.vehicles) if (v.collider && !v._fr) { v.collider.setFriction(friction); v._fr = 1; }
        g._update(1 / 30);
        if (busted) { busted = false; g.restart(); ai = new Runner(g, p); g.heat.value = heat; continue; }
        if (g.heat.bustPinned) pinned += 1 / 30;
        let d = Infinity;
        for (const v of g.vehicles) if (v.isPolice && !v.removed && v !== p) d = Math.min(d, Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z));
        if (d < 30) near++;
        n++;
        if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      g._update = origU;
      g.forceControls = null;
      all += arrests; allPinned += pinned;
      out.push(`run ${run}: arrests ${arrests}, pinned ${pinned.toFixed(1)} s, near ${Math.round((100 * near) / n)}%`);
    }
    out.push(`${label} total: arrests ${all}, pinned ${allPinned.toFixed(1)} s`);
    window.__res = out.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
