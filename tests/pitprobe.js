// Does a PIT actually arrive?
//
// The authorisation only needs a unit within about thirty metres of the
// target's rear quarter; getting from there into the strike window -- a metre
// or two off the back corner, closing, for long enough to turn the rear axle
// -- is the setup phase's job, and that is the part that was too timid to
// finish. This holds the player at a steady speed on a long straight, forces
// contact the way the harness does, and logs where the striking unit is.
window.__runPitProbe = async function (hold = 22) {
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph, p = g.player;

    // The longest straight-ish road on the map, for a clean run.
    let road = null;
    for (const e of gr.edges) {
      if (e.dead || e.turningHead || e.width < 12) continue;
      if (!road || e.length > road.length) road = e;
    }
    g.outcome = null; g.hud.hideOverlay();
    g.heat.reset(); g.dispatcher.reset(); p.repair();
    const s = gr.pointAt(road, 20);
    const h = Math.atan2(s.tx, s.tz);
    p.teleport({ x: s.x, y: 0.9, z: s.z }, h);
    p.setVelocity({ x: Math.sin(h) * hold, y: 0, z: Math.cos(h) * hold });
    g.heat.bump(1, 'a probe'); g.heat.value = 3.8; g.heat.peak = 3.8;

    // They can always see us, so the question is only whether they can reach
    // us -- the same thing the behaviour harness does.
    const k = g.dispatcher.knowledge;
    const oK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    g.dispatcher._updateKnowledge = (dt, tg) => {
      oK(dt, tg);
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(tg.position); k.velocity.copy(tg.linvel);
    };

    const log = [];
    let pits = 0, strikes = 0, spun = 0, last = null;
    const seen = new Set();
    for (let i = 0; i < 480; i++) {
      // Hold the speed, and keep the car on the road rather than driving it.
      const snap = gr.nearestEdge(p.position.x, p.position.z);
      let steer = 0;
      if (snap) {
        const at = gr.pointAt(snap.edge, Math.min(snap.edge.length, snap.along + 18));
        const dx = at.x - p.position.x, dz = at.z - p.position.z;
        const la = dx * p.left.x + dz * p.left.z;
        steer = Math.max(-0.5, Math.min(0.5, la * 0.06));
      }
      const throttle = p.speed < hold ? 0.7 : 0;
      g.stepHeadless(0.25, { throttle, brake: 0, steer, handbrake: 0 });

      const u = g.dispatcher.activePit;
      if (u && u !== last) { last = u; pits++; }
      if (!u) last = null;
      if (u) {
        const v = u.vehicle;
        const dx = v.position.x - p.position.x, dz = v.position.z - p.position.z;
        const lng = dx * p.forward.x + dz * p.forward.z;
        const lat = dx * p.left.x + dz * p.left.z;
        const ph = (u.pitState && u.pitState.phase) || '-';
        if (ph === 'strike' && !seen.has(u)) { seen.add(u); strikes++; }
        if (log.length < 90) {
          log.push(`${(i * 0.25).toFixed(1)}s ${ph} long${lng.toFixed(1)}`
            + ` lat${lat.toFixed(1)} u${v.speed.toFixed(1)} p${p.speed.toFixed(1)}`);
        }
      }
      if (Math.abs(p.yawRate) > 1.7) spun++;
    }

    window.__res = JSON.stringify({
      pitsAuthorised: pits, reachedStrike: strikes, quarterSecondsSpun: spun,
      playerKmh: +(p.speed * 3.6).toFixed(0), trace: log,
    });
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
