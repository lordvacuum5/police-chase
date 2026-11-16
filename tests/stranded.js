// Does ordinary driving ever set off the "you can't be up there" countdown (Heat._checkStranded)?
//
// "Make sure obviously it doesn't actually affect if someone's doing something actually legit." The game's own
// driver takes your car down long routes between random places on the map, three stars after it, and every
// moment it counts as stranded is written down:
//
//   await import('/tests/stranded.js');  __runStranded(90);   // then window.__strDone, window.__res
//
//   flagged   quarter-seconds counted as stranded
//   longest   the longest run of them, s (the countdown starts at 2)
//   where     the first few places it happened
window.__runStranded = async function (secs = 90) {
  window.__strDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player && window.__game.hud); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game, p = g.player, gr = g.graph;
    const { Driver, SKILL } = window.__modules;
    g.onBusted = () => { g.outcome = null; };
    g.heat._checkBust = () => {};
    g.heat.bump(1, 'a probe');
    g.heat.value = 3;
    const rng = (() => { let s = 12345; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; }; })();
    let drv = null, flagged = 0, run = 0, longest = 0, t = 0, routes = 0;
    const where = [];
    const newRoute = () => {
      for (let k = 0; k < 30; k++) {
        const a = gr.nearestNode(p.position.x, p.position.z);
        const b = gr.randomNode(rng);
        const path = a && b && gr.route(a.id, b.id);
        if (path && path.length > 4) {
          drv = new Driver(p, SKILL.pursuit);
          drv.setPath(gr.pathToPoints(path, 2.5, true));
          routes++;
          return;
        }
      }
    };
    newRoute();
    while (t < secs) {
      for (let j = 0; j < 15; j++) {
        if (!drv || drv.remaining() < 15) newRoute();
        g.stepHeadless(1 / 60, drv.followPath(1 / 60));
      }
      t += 0.25;
      if (g.heat._stranded) {
        flagged++;
        run += 0.25;
        longest = Math.max(longest, run);
        if (where.length < 5) where.push({ t, x: Math.round(p.position.x), z: Math.round(p.position.z) });
      } else run = 0;
      if (Math.floor(t * 4) % 40 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    window.__res = { map: g.mapDef.id, secs, routes, flagged, longest, where };
  } catch (e) {
    window.__res = 'ERR ' + (e.stack || e);
  }
  window.__strDone = true;
  return window.__res;
};
