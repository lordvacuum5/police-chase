// Who hits what, during a chase.
//
// Wraps the harness (tests/harness.js) and watches every impact the game
// detects. An impact on a police car with the player more than seven metres
// away is a unit hitting scenery -- a crash. An impact on the player with a
// police car within seven metres is a ram. Reported per minute, with how hard
// the rams land (the change in velocity, m/s).
window.__runContact = async function (seconds = 50, seed = 101, heat = 4.2) {
  const g = window.__game;
  const W = await import('/src/physics/world.js').catch(() => null);
  const stats = { rams: 0, ramDv: 0, hardRams: 0, crashes: 0, crashDv: 0, bumps: 0, wrecked: 0 };
  const seen = new WeakMap();
  let playerAt = 0, primed = false;
  const watch = () => {
    const p = g.player;
    // The first look only notes what is already there. Every car keeps the
    // time of its last impact, from earlier in the chase or an earlier run,
    // and counting those on the first frame reported a burst of simultaneous
    // "crashes" by cars hundreds of metres apart with nothing near them.
    if (!primed) {
      primed = true;
      playerAt = p.lastImpactAt || 0;
      for (const v of g.vehicles) seen.set(v, v.lastImpactAt || 0);
      return;
    }
    if (p.lastImpactAt && p.lastImpactAt !== playerAt) {
      playerAt = p.lastImpactAt;
      const near = g.dispatcher.units.some((u) => u.distanceTo(p.position) < 7);
      if (near) { stats.rams++; stats.ramDv += p.lastImpact; if (p.lastImpact > 5) stats.hardRams++; }
    }
    for (const u of g.dispatcher.units) {
      const v = u.vehicle;
      const last = seen.get(v) || 0;
      if (v.lastImpactAt && v.lastImpactAt !== last) {
        seen.set(v, v.lastImpactAt);
        if (u.distanceTo(p.position) > 7) {
          // Another police car right there: a bump in the pack, not scenery.
          const other = g.vehicles.some((o) => o !== v && o !== p
            && Math.hypot(o.position.x - v.position.x, o.position.z - v.position.z) < 6.5);
          if (other) stats.bumps++;
          else {
            stats.crashes++; stats.crashDv += v.lastImpact;
            const why = u.role === 'pursue' ? 'pursue:' + (u._mode || '?') : u.role;
            stats.byMode = stats.byMode || {};
            stats.byMode[why] = (stats.byMode[why] || 0) + 1;
            // Where and how, for looking into a particular crash afterwards.
            let trail = Infinity;
            for (const q of g.playerTrail || []) trail = Math.min(trail, Math.hypot(q.x - v.position.x, q.z - v.position.z));
            // What is right beside the car, by kind: the nearest of each within
            // four metres, all the way round.
            const near = {};
            if (W) {
              for (const [name, bit] of Object.entries(W.GROUP)) {
                if (name === 'VEHICLE' || name === 'TERRAIN') continue;
                let best = Infinity;
                for (let a = 0; a < 16; a++) {
                  const h = W.raycast(g.world, { x: v.position.x, y: v.position.y + 0.1, z: v.position.z },
                    { x: Math.sin(a * Math.PI / 8), y: 0, z: Math.cos(a * Math.PI / 8) }, 4,
                    W.groups(0xFFFF, bit), v.body);
                  if (h) best = Math.min(best, h.toi);
                }
                if (best < 4) near[name.toLowerCase()] = +best.toFixed(1);
              }
            }
            (stats.detail = stats.detail || []).push({ near,
              why, kind: u.kind, kph: +(v.speed * 3.6).toFixed(0), dv: +v.lastImpact.toFixed(1),
              player: +u.distanceTo(p.position).toFixed(0), trail: +trail.toFixed(1),
              x: +v.position.x.toFixed(1), z: +v.position.z.toFixed(1), t: +g.clock.toFixed(1),
            });
          }
        }
      }
    }
  };
  window.__res = null;
  const run = window.__runHarness(seconds, seed);
  await new Promise((r) => setTimeout(r, 250));
  const inner = g._update;
  g._update = (dt) => { if (g.heat.value < heat) g.heat.value = heat; inner(dt); watch(); };
  await run;
  for (let i = 0; i < 400 && !window.__res; i++) await new Promise((r) => setTimeout(r, 50));
  const r = JSON.parse(window.__res);
  const mins = seconds / 60;
  return {
    seed,
    ramsPerMin: +(stats.rams / mins).toFixed(1),
    hardRamsPerMin: +(stats.hardRams / mins).toFixed(1),
    ramDv: stats.rams ? +(stats.ramDv / stats.rams).toFixed(1) : 0,
    crashesPerMin: +(stats.crashes / mins).toFixed(1),
    policeBumpsPerMin: +(stats.bumps / mins).toFixed(1),
    crashesBy: stats.byMode || {},
    crashDetail: stats.detail || [],
    nearest: r.nearestUnitMedianM,
    within40: r.within40mPct,
    playerKph: r.playerKphMedian,
    exceptions: r.exceptions,
  };
};
